/**
 * The two model-facing tools: `wiztree_scan` builds an index with WizTree, and
 * `wiztree_query` answers questions about a retained index by streaming its CSV.
 *
 * Everything is computed on the Host and returned as compact text: a full-drive
 * export can be millions of rows and must never reach the model whole.
 *
 * @module dsh-wiztree/tools
 */

import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { readCsvEntries } from './csv.js'
import {
  comparisonKey,
  compileGlob,
  extensionOf,
  formatBytes,
  formatCount,
  isDirectChild,
  isInside,
  normalizeRoot,
  parseSize,
} from './format.js'
import { WizTreeRunner } from './runner.js'

/** Largest `limit` a query may request. */
const MAX_LIMIT = 500

/** How many rows a large folder/file list accumulates before only counting. */
const MAX_COLLECTED = 50_000

/** Longest glob a query may pass; bounds the per-entry regex work. */
const MAX_PATTERN_LENGTH = 512

/** Longest path/filter value accepted; keeps the Windows command line under its limit. */
const MAX_ARGUMENT_LENGTH = 4096

/** How many entries each scan report section shows. */
const REPORT_DIRS = 10
const REPORT_FILES = 15
const REPORT_TYPES = 10

/** The value every tool returns; `render` turns it into the text block. */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string' },
  },
  required: ['text'],
  additionalProperties: false,
}

/** Accepted query actions. */
const ACTIONS = ['list', 'find', 'top', 'types', 'info']

/**
 * Reject argument keys the published schema does not declare, matching the
 * strictness of the surrounding tool surface.
 * @param {Record<string, unknown>} args - the model arguments.
 * @param {string[]} known - declared property names.
 * @returns {void}
 */
function rejectUnknownArguments(args, known) {
  const unknown = Object.keys(args).filter((key) => !known.includes(key))
  if (unknown.length > 0) {
    throw new Error(`invalid arguments: unknown key(s) ${unknown.join(', ')}; accepts ${known.join(', ')}`)
  }
}

/**
 * Normalise the raw argument object.
 * @param {unknown} args - the model arguments.
 * @returns {Record<string, unknown>} the arguments.
 */
function argumentObject(args) {
  if (args === undefined || args === null) return {}
  if (typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments must be an object')
  return /** @type {Record<string, unknown>} */ (args)
}

/**
 * Read a required string argument.
 * @param {Record<string, unknown>} args - the arguments.
 * @param {string} key - the key.
 * @returns {string} the value.
 */
function requiredString(args, key) {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`invalid arguments: "${key}" must be a non-empty string`)
  }
  return value
}

/**
 * Read an optional string argument.
 * @param {Record<string, unknown>} args - the arguments.
 * @param {string} key - the key.
 * @returns {string|undefined} the value.
 */
function optionalString(args, key) {
  const value = args[key]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error(`invalid arguments: "${key}" must be a string`)
  return value
}

/**
 * Read an optional boolean argument.
 * @param {Record<string, unknown>} args - the arguments.
 * @param {string} key - the key.
 * @returns {boolean|undefined} the value.
 */
function optionalBoolean(args, key) {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new Error(`invalid arguments: "${key}" must be a boolean`)
  return value
}

/**
 * Read an optional integer argument.
 * @param {Record<string, unknown>} args - the arguments.
 * @param {string} key - the key.
 * @param {number|undefined} fallback - the value when absent.
 * @param {number} min - inclusive lower bound.
 * @param {number} max - inclusive upper bound.
 * @returns {number|undefined} the value.
 */
function optionalInteger(args, key, fallback, min, max) {
  const value = args[key]
  if (value === undefined || value === null) return fallback
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`invalid arguments: "${key}" must be an integer between ${min} and ${max}`)
  }
  return value
}

/**
 * Insert an item into a bounded, size-descending list.
 * @param {{ size: number }[]} list - the accumulator.
 * @param {{ size: number }} item - the candidate.
 * @param {number} limit - maximum list length.
 * @returns {void}
 */
function pushTop(list, item, limit) {
  if (list.length >= limit && item.size <= list[list.length - 1].size) return
  let index = list.length
  while (index > 0 && list[index - 1].size < item.size) index -= 1
  list.splice(index, 0, item)
  if (list.length > limit) list.pop()
}

/**
 * The last path segment, without a trailing separator.
 * @param {string} path - a file or folder path.
 * @returns {string} the leaf name.
 */
function leafName(path) {
  const trimmed = path.endsWith('\\') ? path.slice(0, -1) : path
  const index = trimmed.lastIndexOf('\\')
  return index >= 0 ? trimmed.slice(index + 1) : trimmed
}

/**
 * Parse an extension filter such as `mp4`, `.mp4`, `mp4|mkv`, `mp4,mkv`.
 * @param {string} value - the filter.
 * @returns {Set<string>|undefined} lower-case extensions including the dot.
 */
function parseExtensions(value) {
  const extensions = new Set()
  for (const part of value.split(/[|,;\s]+/)) {
    const trimmed = part.trim().toLowerCase()
    if (trimmed === '') continue
    extensions.add(trimmed.startsWith('.') ? trimmed : `.${trimmed}`)
  }
  return extensions.size > 0 ? extensions : undefined
}

/**
 * Validate a query folder and return its comparison key.
 * @param {string} path - the absolute folder argument.
 * @param {{ root: string }} record - the scan being queried.
 * @returns {string} lower-case folder key ending with `\`.
 */
function scopeKey(path, record) {
  const folder = comparisonKey(normalizeRoot(path))
  const root = comparisonKey(normalizeRoot(record.root))
  if (!isInside(folder, root)) {
    throw new Error(`"${path}" is outside the scanned root ${record.root}; query a path below it`)
  }
  return folder
}

/**
 * Walk one CSV export and collect the overview a scan report needs.
 * @param {string} csvPath - the export.
 * @param {string} root - the normalised scan root.
 * @param {AbortSignal} [signal] - cancels the read.
 * @returns {Promise<{ entries: number, totalBytes: number, totalFiles: number, totalFolders: number, topDirs: { path: string, size: number }[], topFiles: { path: string, size: number }[], topTypes: { extension: string, bytes: number, files: number }[] }>} the overview.
 */
async function summarize(csvPath, root, signal) {
  const rootKey = comparisonKey(root)
  const topDirs = []
  const topFiles = []
  const types = new Map()
  let entries = 0
  let rootBytes
  let rootFiles
  let rootFolders
  let summedBytes = 0
  let summedFiles = 0
  let summedFolders = 0

  for await (const entry of readCsvEntries(csvPath, signal)) {
    entries += 1
    const key = comparisonKey(entry.path)
    if (entry.isDirectory) {
      if (key === rootKey) {
        rootBytes = entry.size
        rootFiles = entry.files
        rootFolders = entry.folders
      } else {
        summedFolders += 1
        if (isDirectChild(key, rootKey)) {
          pushTop(topDirs, { path: entry.path, size: entry.size }, REPORT_DIRS)
        }
      }
      continue
    }
    summedBytes += entry.size
    summedFiles += 1
    pushTop(topFiles, { path: entry.path, size: entry.size }, REPORT_FILES)
    const extension = extensionOf(entry.path)
    const bucket = types.get(extension) ?? { extension, bytes: 0, files: 0 }
    bucket.bytes += entry.size
    bucket.files += 1
    types.set(extension, bucket)
  }

  const topTypes = [...types.values()].sort((left, right) => right.bytes - left.bytes).slice(0, REPORT_TYPES)
  return {
    entries,
    totalBytes: rootBytes ?? summedBytes,
    totalFiles: rootFiles ?? summedFiles,
    totalFolders: rootFolders ?? summedFolders,
    topDirs,
    topFiles,
    topTypes,
  }
}

/**
 * Render a scan report.
 * @param {import('./store.js').ScanRecord & { warning?: string }} record - the scan.
 * @returns {string} the report text.
 */
function renderScanReport(record) {
  const lines = []
  const seconds = (record.elapsedMs / 1000).toFixed(1)
  const mode = [
    record.admin ? 'MFT scan' : 'standard walk',
    record.launchStyle === 'uac' ? 'UAC-elevated launch' : 'direct launch',
  ].join(', ')
  lines.push(`WizTree index ${record.id} ready in ${seconds}s — ${record.root} (${mode})`)
  lines.push(`${formatBytes(record.totalBytes)} · ${formatCount(record.totalFolders)} folders · ${formatCount(record.totalFiles)} files · ${formatCount(record.entries)} CSV rows · CSV ${formatBytes(record.csvBytes)}`)
  if (record.warning !== undefined) lines.push(`Note: ${record.warning}`)
  if (record.topDirs.length > 0) {
    lines.push('', `Largest folders directly under ${record.root}`)
    for (const item of record.topDirs) lines.push(`  ${formatBytes(item.size).padStart(10)}  ${item.path}`)
  }
  if (record.topFiles.length > 0) {
    lines.push('', 'Largest files')
    for (const item of record.topFiles) lines.push(`  ${formatBytes(item.size).padStart(10)}  ${item.path}`)
  }
  if (record.topTypes.length > 0) {
    lines.push('', 'File types by total size')
    for (const item of record.topTypes) {
      lines.push(`  ${formatBytes(item.bytes).padStart(10)}  ${formatCount(item.files).padStart(10)} files  ${item.extension}`)
    }
  }
  lines.push('', `Drill in with wiztree_query { scanId: "${record.id}", action: "list" | "find" | "top" | "types" | "info" }.`)
  return lines.join('\n')
}

/**
 * Render a list of directory entries or matches.
 * @param {string} header - the section header.
 * @param {{ path: string, size: number, isDirectory: boolean }[]} items - the shown items.
 * @param {number} total - how many matched in full.
 * @returns {string} the table text.
 */
function renderItems(header, items, total) {
  const lines = [header]
  for (const item of items) {
    const kind = item.isDirectory ? 'DIR ' : 'FILE'
    lines.push(`  ${kind} ${formatBytes(item.size).padStart(10)}  ${item.path}`)
  }
  if (total > items.length) {
    lines.push(`  … ${formatCount(total - items.length)} more; raise "limit" or narrow "path"/"pattern"`)
  }
  return lines.join('\n')
}

/**
 * Sort collected entries in place.
 * @param {{ size: number, path: string, modified?: string }[]} items - the entries.
 * @param {'size'|'name'|'modified'} sortBy - the ordering.
 * @returns {void}
 */
function sortEntries(items, sortBy) {
  if (sortBy === 'name') items.sort((left, right) => left.path.localeCompare(right.path))
  else if (sortBy === 'modified') items.sort((left, right) => (right.modified ?? '').localeCompare(left.modified ?? ''))
  else items.sort((left, right) => right.size - left.size)
}

/**
 * Build the path shown in a result header.
 * @param {string} requested - the user-supplied path, or undefined.
 * @param {string} fallback - the scan root.
 * @returns {string} the display path.
 */
function displayPath(requested, fallback) {
  return requested ?? fallback
}

/**
 * Build both tool definitions.
 * @param {object} options - the tool dependencies.
 * @param {import('./config.js').ResolvedConfig} options.config - resolved config.
 * @param {import('./store.js').ScanStore} options.store - scan index.
 * @param {WizTreeRunner} options.runner - the WizTree runner.
 * @param {(message: string, level?: string) => void} options.log - plugin logger.
 * @returns {object[]} tool definitions for `ctx.tools.register`.
 */
export function createTools({ config, store, runner, log }) {
  const scanTool = {
    name: 'wiztree_scan',
    description:
      'Index a Windows drive or folder with WizTree and return the largest folders, files, and file types. '
      + 'Far faster than walking the tree with glob/bash, and the practical way to see whole-drive disk usage. '
      + 'The index stays cached for wiztree_query, so scan once and then query. '
      + 'WizTree is configured to always run elevated on this machine, so a scan may show a UAC confirmation prompt: '
      + 'tell the user to approve it. After approval WizTree uses its fast MFT scan and even a full drive takes seconds; '
      + 'if the prompt is dismissed the scan fails. Starting DSH as administrator removes the prompt entirely.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Drive or absolute folder to index, e.g. "C:", "C:\\\\Users", "D:\\\\Projects".',
        },
        filter: {
          type: 'string',
          description: 'Optional WizTree include filter (filespec), e.g. "*.mp4|*.mkv". Folders are always kept.',
        },
        exclude: {
          type: 'string',
          description: 'Optional WizTree exclude filter, e.g. "C:\\\\Windows\\\\|C:\\\\Program Files\\\\".',
        },
        maxDepth: {
          type: 'integer',
          description: 'Optional export depth limit; 0 (default) exports everything.',
          minimum: 0,
          maximum: 64,
        },
        admin: {
          type: 'boolean',
          description: 'Request WizTree MFT mode (default true; only effective when the launch is elevated).',
        },
        timeoutMs: {
          type: 'integer',
          description: 'Optional scan deadline in milliseconds; defaults to the plugin config value.',
          minimum: 10000,
          maximum: 3600000,
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: String(value.text) }],
    },
    timeoutMs: config.timeoutMs + 60_000,
    /**
     * @param {unknown} rawArgs - model arguments.
     * @param {{ signal: AbortSignal }} exec - execution context.
     * @returns {Promise<{ text: string }>} the report.
     */
    async execute(rawArgs, exec) {
      const args = argumentObject(rawArgs)
      rejectUnknownArguments(args, ['path', 'filter', 'exclude', 'maxDepth', 'admin', 'timeoutMs'])
      const requestedPath = requiredString(args, 'path')
      if (requestedPath.length > MAX_ARGUMENT_LENGTH) {
        throw new Error(`path is too long; the limit is ${MAX_ARGUMENT_LENGTH} characters`)
      }
      const root = normalizeRoot(requestedPath)
      const existenceProbe = /^[A-Za-z]:\\$/.test(root) ? root : root.replace(/\\+$/, '')
      if (!existsSync(existenceProbe)) {
        throw new Error(`Path not found: ${requestedPath}`)
      }

      const timeoutMs = optionalInteger(args, 'timeoutMs', config.timeoutMs, 10_000, 3_600_000) ?? config.timeoutMs
      const maxDepth = optionalInteger(args, 'maxDepth', config.maxExportDepth, 0, 64) ?? config.maxExportDepth
      const requestedAdmin = optionalBoolean(args, 'admin') ?? config.admin
      const filter = optionalString(args, 'filter')
      const exclude = optionalString(args, 'exclude')
      for (const [key, value] of [['filter', filter], ['exclude', exclude]]) {
        if (value !== undefined && value.length > MAX_ARGUMENT_LENGTH) {
          throw new Error(`${key} is too long; the limit is ${MAX_ARGUMENT_LENGTH} characters`)
        }
      }
      const reservation = store.reserve()
      const outcome = await runner.scan({
        root,
        csvPath: reservation.csvPath,
        filter,
        exclude,
        admin: requestedAdmin,
        elevation: config.elevation,
        maxExportDepth: maxDepth,
        timeoutMs,
        signal: exec?.signal,
      })
      const summary = await summarize(reservation.csvPath, root, exec?.signal)
      const csvInfo = await stat(reservation.csvPath).catch(() => ({ size: 0 }))
      const record = store.add({
        id: reservation.id,
        root,
        csvPath: reservation.csvPath,
        createdAt: Date.now(),
        elapsedMs: outcome.elapsedMs,
        executable: config.executable,
        admin: outcome.admin,
        launchStyle: outcome.launchStyle,
        filter,
        exclude,
        maxExportDepth: maxDepth,
        csvBytes: csvInfo.size,
        ...summary,
        warning: outcome.warning,
      })
      log(`dsh-wiztree: indexed ${root} as ${record.id} (${formatCount(summary.entries)} rows)`, 'info')
      return { text: renderScanReport(record) }
    },
  }

  const queryTool = {
    name: 'wiztree_query',
    description:
      'Query a cached WizTree index: list a folder\'s direct children with recursive sizes, find files by glob/size/extension, '
      + 'show the largest files, or aggregate size by file type. Always call wiztree_scan first; the newest scan is used when scanId is omitted.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description: 'list = direct children of path; find = filter files/folders; top = largest files; types = size by extension; info = scan metadata and retained scans.',
        },
        scanId: {
          type: 'string',
          description: 'Scan id returned by wiztree_scan. Defaults to the newest scan.',
        },
        path: {
          type: 'string',
          description: 'Absolute folder to scope list/find/top/types, e.g. "C:\\\\Users". Defaults to the scan root.',
        },
        pattern: {
          type: 'string',
          description: 'Glob for names (find), e.g. "*.mp4|*.mkv", "report?.xlsx".',
        },
        extension: {
          type: 'string',
          description: 'Extension filter (find), e.g. "mp4", ".mp4", "mp4|mkv".',
        },
        minSize: {
          anyOf: [{ type: 'string' }, { type: 'number' }],
          description: 'Minimum size (find), e.g. "100mb", "1.5gb", or bytes.',
        },
        maxSize: {
          anyOf: [{ type: 'string' }, { type: 'number' }],
          description: 'Maximum size (find), e.g. "10mb".',
        },
        type: {
          type: 'string',
          enum: ['file', 'folder', 'any'],
          description: 'Entry kind for find; defaults to "file".',
        },
        sortBy: {
          type: 'string',
          enum: ['size', 'name', 'modified'],
          description: 'Ordering for list/find; defaults to "size".',
        },
        limit: {
          type: 'integer',
          description: 'Maximum entries to return (1-500); defaults to the plugin config value.',
          minimum: 1,
          maximum: 500,
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: String(value.text) }],
    },
    isConcurrencySafe: () => true,
    /**
     * @param {unknown} rawArgs - model arguments.
     * @param {{ signal: AbortSignal }} exec - execution context.
     * @returns {Promise<{ text: string }>} the answer.
     */
    async execute(rawArgs, exec) {
      const args = argumentObject(rawArgs)
      rejectUnknownArguments(args, [
        'action', 'scanId', 'path', 'pattern', 'extension', 'minSize', 'maxSize', 'type', 'sortBy', 'limit',
      ])
      const action = requiredString(args, 'action')
      if (!ACTIONS.includes(action)) {
        throw new Error(`invalid action ${JSON.stringify(action)}; use ${ACTIONS.join(', ')}`)
      }
      if (action === 'info') {
        return { text: renderInfo(args, store) }
      }

      const limit = optionalInteger(args, 'limit', config.defaultLimit, 1, MAX_LIMIT) ?? config.defaultLimit
      const sortBy = optionalString(args, 'sortBy') ?? 'size'
      if (!['size', 'name', 'modified'].includes(sortBy)) throw new Error('sortBy must be size, name, or modified')
      const signal = exec?.signal
      const record = store.resolve(optionalString(args, 'scanId'))
      const requestedPath = optionalString(args, 'path')
      const scope = requestedPath === undefined
        ? comparisonKey(normalizeRoot(record.root))
        : scopeKey(requestedPath, record)
      const scopeLabel = displayPath(requestedPath, record.root)

      if (action === 'list') {
        /** @type {{ path: string, size: number, isDirectory: boolean }[]} */
        const children = []
        let total = 0
        for await (const entry of readCsvEntries(record.csvPath, signal)) {
          if (!isDirectChild(comparisonKey(entry.path), scope)) continue
          total += 1
          if (children.length >= MAX_COLLECTED) continue
          children.push({ path: entry.path, size: entry.size, isDirectory: entry.isDirectory })
        }
        const overflowed = total > MAX_COLLECTED
        sortEntries(children, sortBy)
        const shown = children.slice(0, limit)
        const header = `${scopeLabel} — ${formatCount(total)} direct children`
          + (total > shown.length ? `, showing ${shown.length} by ${sortBy}` : '')
        const table = renderItems(header, shown, total)
        return {
          text: overflowed
            ? `${table}\n  (only the first ${formatCount(MAX_COLLECTED)} direct children were ranked; narrow the path)`
            : table,
        }
      }

      if (action === 'find' || action === 'top') {
        const patternText = action === 'top' ? undefined : optionalString(args, 'pattern')
        if (patternText !== undefined && patternText.length > MAX_PATTERN_LENGTH) {
          throw new Error(`pattern is too long; the limit is ${MAX_PATTERN_LENGTH} characters`)
        }
        const matcher = patternText === undefined ? undefined : compileGlob(patternText)
        const extensionText = action === 'top' ? undefined : optionalString(args, 'extension')
        const extensions = extensionText === undefined ? undefined : parseExtensions(extensionText)
        const minSize = parseSize(args.minSize)
        const maxSize = parseSize(args.maxSize)
        const kind = action === 'top' ? 'file' : (optionalString(args, 'type') ?? 'file')
        if (!['file', 'folder', 'any'].includes(kind)) throw new Error('type must be file, folder, or any')

        /** @type {{ path: string, size: number, isDirectory: boolean, modified: string }[]} */
        const matches = []
        let total = 0
        let overflowed = false
        for await (const entry of readCsvEntries(record.csvPath, signal)) {
          if (!isInside(comparisonKey(entry.path), scope)) continue
          if (kind === 'file' && entry.isDirectory) continue
          if (kind === 'folder' && !entry.isDirectory) continue
          if (matcher !== undefined) {
            const name = leafName(entry.path)
            if (!matcher.test(name) && !matcher.test(entry.path)) continue
          }
          if (extensions !== undefined && !extensions.has(extensionOf(entry.path))) continue
          if (minSize !== undefined && entry.size < minSize) continue
          if (maxSize !== undefined && entry.size > maxSize) continue
          total += 1
          if (matches.length >= MAX_COLLECTED) {
            overflowed = true
            continue
          }
          matches.push({ path: entry.path, size: entry.size, isDirectory: entry.isDirectory, modified: entry.modified })
        }
        sortEntries(matches, sortBy)
        const shown = matches.slice(0, limit)
        const condition = [
          patternText === undefined ? undefined : `name ~ ${JSON.stringify(patternText)}`,
          extensions === undefined ? undefined : `extension ${[...extensions].join('|')}`,
          minSize === undefined ? undefined : `>= ${formatBytes(minSize)}`,
          maxSize === undefined ? undefined : `<= ${formatBytes(maxSize)}`,
        ].filter((part) => part !== undefined).join(', ')
        const noun = kind === 'any' ? 'entries' : `${kind}s`
        const header = `${action === 'top' ? 'Largest files' : 'Matches'} under ${scopeLabel}`
          + ` (${formatCount(total)} ${noun}${condition === '' ? '' : `, ${condition}`}`
          + `${total > shown.length ? `; showing ${shown.length} by ${sortBy}` : ''}` + ')'
        const table = renderItems(header, shown, total)
        return {
          text: overflowed
            ? `${table}\n  (only the first ${formatCount(MAX_COLLECTED)} matches were ranked; narrow the filter for exact ordering)`
            : table,
        }
      }

      // action === 'types'
      /** @type {Map<string, { extension: string, bytes: number, files: number }>} */
      const buckets = new Map()
      let files = 0
      for await (const entry of readCsvEntries(record.csvPath, signal)) {
        if (entry.isDirectory) continue
        if (!isInside(comparisonKey(entry.path), scope)) continue
        files += 1
        const extension = extensionOf(entry.path)
        const bucket = buckets.get(extension) ?? { extension, bytes: 0, files: 0 }
        bucket.bytes += entry.size
        bucket.files += 1
        buckets.set(extension, bucket)
      }
      const rows = [...buckets.values()].sort((left, right) => right.bytes - left.bytes)
      const shown = rows.slice(0, limit)
      const totalBytes = rows.reduce((sum, row) => sum + row.bytes, 0)
      const lines = [
        `File types under ${scopeLabel} — ${formatBytes(totalBytes)} in ${formatCount(files)} files, ${formatCount(rows.length)} extensions`
        + (rows.length > shown.length ? `; showing ${shown.length}` : ''),
      ]
      for (const row of shown) {
        const share = totalBytes > 0 ? ((row.bytes / totalBytes) * 100).toFixed(1) : '0.0'
        lines.push(`  ${formatBytes(row.bytes).padStart(10)} ${share.padStart(5)}%  ${formatCount(row.files).padStart(10)} files  ${row.extension}`)
      }
      if (rows.length > shown.length) {
        lines.push(`  … ${formatCount(rows.length - shown.length)} more extensions; raise "limit"`)
      }
      return { text: lines.join('\n') }
    },
  }

  return [scanTool, queryTool]
}

/**
 * Render the `info` action: one scan's details plus the retained scan list.
 * @param {Record<string, unknown>} args - the query arguments.
 * @param {import('./store.js').ScanStore} store - the scan index.
 * @returns {string} the info text.
 */
function renderInfo(args, store) {
  const scans = store.list()
  if (scans.length === 0) {
    return 'No WizTree scan is cached in this session yet. Call wiztree_scan first.'
  }
  const lines = []
  const requested = optionalString(args, 'scanId')
  if (requested !== undefined) {
    const record = store.resolve(requested)
    lines.push(`Scan ${record.id}`)
    lines.push(`  root: ${record.root}`)
    lines.push(`  created: ${new Date(record.createdAt).toLocaleString()}`)
    lines.push(`  total: ${formatBytes(record.totalBytes)} · ${formatCount(record.totalFolders)} folders · ${formatCount(record.totalFiles)} files`)
    lines.push(`  mode: ${record.admin ? 'MFT' : 'standard walk'} · launch: ${record.launchStyle ?? 'direct'}`)
    lines.push(`  wiztree: ${record.executable} · took ${(record.elapsedMs / 1000).toFixed(1)}s`)
    lines.push(`  csv: ${record.csvPath} (${formatBytes(record.csvBytes)}, ${formatCount(record.entries)} rows)`)
    if (record.filter !== undefined) lines.push(`  filter: ${record.filter}`)
    if (record.exclude !== undefined) lines.push(`  exclude: ${record.exclude}`)
    lines.push('')
  }
  lines.push('Retained scans (newest last):')
  for (const record of scans) {
    lines.push(`  ${record.id}  ${formatBytes(record.totalBytes).padStart(10)}  ${formatCount(record.entries).padStart(10)} rows  ${record.root}`)
  }
  return lines.join('\n')
}
