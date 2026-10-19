/**
 * Streaming reader for the CSV WizTree writes with `/export=`.
 *
 * The format is documented by WizTree and stable since 3.18:
 * `File Name, Size, Allocated, Modified, Attributes, Files, Folders`.
 * Folders end their name with `\`; the size of a folder is the recursive total.
 * Files can be millions of lines, so entries are streamed and never stored as
 * one array.
 *
 * @module dsh-wiztree/csv
 */

import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'

/** How many leading bytes decide the text encoding. */
const ENCODING_SAMPLE_BYTES = 64 * 1024

/**
 * @typedef {object} CsvEntry
 * @property {string} path - exported path; folders end with `\`.
 * @property {boolean} isDirectory - whether the row is a folder.
 * @property {number} size - file size, or the recursive size for a folder.
 * @property {number} allocated - allocated size on disk.
 * @property {string} modified - `yyyy/mm/dd HH:mm:ss`, possibly empty.
 * @property {number} attributes - WizTree attribute bit mask.
 * @property {number} files - total file count below a folder (0 for files).
 * @property {number} folders - total folder count below a folder (0 for files).
 */

/**
 * Detect whether the export is UTF-8 or the system ANSI code page (GBK on a
 * Chinese Windows). WizTree itself writes ANSI when the system locale asks for
 * it, so both must be readable.
 * @param {string} csvPath - the CSV file.
 * @returns {Promise<string>} a `TextDecoder` encoding label.
 */
export async function detectEncoding(csvPath) {
  const handle = await open(csvPath, 'r')
  try {
    const buffer = Buffer.alloc(ENCODING_SAMPLE_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const head = buffer.subarray(0, bytesRead)
    if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return 'utf-8'
    // A sample cut inside a multi-byte character would look invalid, so drop
    // the tail before deciding.
    const sample = head.length > 8 ? head.subarray(0, head.length - 8) : head
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(sample)
      return 'utf-8'
    } catch {
      return 'gbk'
    }
  } finally {
    await handle.close()
  }
}

/**
 * Build a decoder for an encoding label, falling back to UTF-8 when the
 * runtime lacks that decoder.
 * @param {string} encoding - the label from {@link detectEncoding}.
 * @returns {TextDecoder} the decoder.
 */
function createDecoder(encoding) {
  try {
    return new TextDecoder(encoding)
  } catch {
    return new TextDecoder('utf-8')
  }
}

/**
 * Split one CSV line into fields, honouring quoted values and doubled quotes.
 * @param {string} line - one CSV line without the newline.
 * @returns {string[]} the fields.
 */
export function splitCsvLine(line) {
  const fields = []
  let current = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          current += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        current += character
      }
    } else if (character === '"') {
      quoted = true
    } else if (character === ',') {
      fields.push(current)
      current = ''
    } else {
      current += character
    }
  }
  fields.push(current)
  return fields
}

/**
 * Read one numeric CSV cell tolerantly.
 * @param {string} value - the raw cell.
 * @returns {number} the number, or 0.
 */
function toCount(value) {
  if (value === undefined) return 0
  const parsed = Number.parseInt(String(value).replace(/[^\d-]/g, ''), 10)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Turn decoded CSV fields into an entry.
 * @param {string[]} fields - the split fields.
 * @returns {CsvEntry|undefined} the entry, or undefined for a malformed row.
 */
function entryFromFields(fields) {
  if (fields.length < 2) return undefined
  const path = fields[0]
  if (path === '' || path === undefined) return undefined
  return {
    path,
    isDirectory: path.endsWith('\\'),
    size: toCount(fields[1]),
    allocated: toCount(fields[2]),
    modified: fields[3] ?? '',
    attributes: toCount(fields[4]),
    files: toCount(fields[5]),
    folders: toCount(fields[6]),
  }
}

/**
 * Turn one CSV line into an entry.
 * @param {string} line - one CSV line without the newline.
 * @returns {CsvEntry|undefined} the entry, or undefined for a malformed row.
 */
export function parseCsvLine(line) {
  return entryFromFields(splitCsvLine(line))
}

/**
 * Whether the first row is a header rather than data. WizTree localises the
 * header (`File Name,Size,...` or `文件名称,大小,...`), so the reliable signal
 * is that its size column is not numeric.
 * @param {string[]} fields - the split first row.
 * @returns {boolean} true for a header row.
 */
function looksLikeHeader(fields) {
  const size = (fields[1] ?? '').trim()
  return !/^\d+$/.test(size)
}

/**
 * Stream every data row of a WizTree CSV export.
 * @param {string} csvPath - the CSV file.
 * @param {AbortSignal} [signal] - cancels the read.
 * @returns {AsyncGenerator<CsvEntry>} the entries in file order.
 */
export async function* readCsvEntries(csvPath, signal) {
  const decoder = createDecoder(await detectEncoding(csvPath))
  let pending = ''
  let sawFirstRow = false
  /**
   * Yield the entries of one completed line.
   * @param {string} line - the line text.
   * @returns {CsvEntry|undefined} the entry, if any.
   */
  const consume = (line) => {
    if (line === '') return undefined
    const fields = splitCsvLine(line)
    if (!sawFirstRow) {
      sawFirstRow = true
      if (looksLikeHeader(fields)) return undefined
    }
    return entryFromFields(fields)
  }
  for await (const chunk of createReadStream(csvPath)) {
    if (signal?.aborted) throw new Error('cancelled')
    pending += decoder.decode(chunk, { stream: true })
    let newline = pending.indexOf('\n')
    while (newline >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/, '')
      pending = pending.slice(newline + 1)
      const entry = consume(line)
      if (entry !== undefined) yield entry
      newline = pending.indexOf('\n')
    }
  }
  pending += decoder.decode()
  const entry = consume(pending.replace(/\r$/, ''))
  if (entry !== undefined) yield entry
}
