/**
 * Small value helpers shared by the scan runner, the CSV reader, and the tools:
 * human-readable sizes, path normalisation, compact result tables, and the
 * glob/size filters the query tool accepts.
 *
 * @module dsh-wiztree/format
 */

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

/**
 * Format a byte count for humans.
 * @param {number} bytes - the size in bytes.
 * @param {number} [digits] - decimals for units above bytes.
 * @returns {string} e.g. `1.25 GB`, `834 B`.
 */
export function formatBytes(bytes, digits = 2) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '?'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), SIZE_UNITS.length - 1)
  const value = bytes / 1024 ** exponent
  return `${value.toFixed(digits)} ${SIZE_UNITS[exponent]}`
}

/**
 * Format an integer with thousands separators.
 * @param {number} value - the count.
 * @returns {string} e.g. `1,234,567`.
 */
export function formatCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '?'
  return Math.round(value).toLocaleString('en-US')
}

/**
 * Normalise a Windows drive or folder to the form WizTree exports: an absolute
 * path ending in a single backslash, with `C:` expanded to `C:\`.
 * @param {string} input - user-supplied path.
 * @returns {string} the normalised root.
 */
export function normalizeRoot(input) {
  let path = String(input ?? '').trim().replace(/\//g, '\\')
  if (path === '') throw new Error('path must not be empty')
  if (/^[a-zA-Z]:$/.test(path)) return `${path}\\`
  if (/^[a-zA-Z]:\\(.*)$/.test(path)) {
    path = `${path[0].toUpperCase()}:\\${path.slice(3)}`.replace(/\\+/g, '\\')
    return path.endsWith('\\') ? path : `${path}\\`
  }
  // UNC share, e.g. \\server\share or \\server\share\folder
  if (path.startsWith('\\\\')) {
    path = path.replace(/\\+/g, '\\')
    return path.endsWith('\\') ? path : `${path}\\`
  }
  throw new Error(`path must be a drive or an absolute folder (got ${JSON.stringify(input)})`)
}

/**
 * Normalise a path for case-insensitive comparison. NTFS is case-insensitive,
 * so a query for `c:\users` must find entries exported as `C:\Users\`.
 * @param {string} path - the path.
 * @returns {string} lower-case comparison key.
 */
export function comparisonKey(path) {
  return String(path).toLowerCase()
}

/**
 * Whether `candidate` is `root` itself or sits below it.
 * @param {string} candidate - normalised comparison key of the entry.
 * @param {string} root - normalised comparison key of the root.
 * @returns {boolean} true when inside the subtree.
 */
export function isInside(candidate, root) {
  return candidate === root || candidate.startsWith(root)
}

/**
 * Whether a normalised entry path is a direct child of a normalised folder.
 * Both arguments are comparison keys (lower-case, trailing `\` for folders).
 * @param {string} entryPath - entry path from WizTree, e.g. `c:\users\bob\file.txt` or `c:\users\bob\`.
 * @param {string} folder - folder path ending with `\`.
 * @returns {boolean} true for a direct child.
 */
export function isDirectChild(entryPath, folder) {
  if (entryPath === folder) return false
  if (!entryPath.startsWith(folder)) return false
  const rest = entryPath.slice(folder.length)
  if (rest === '') return false
  const trimmed = rest.endsWith('\\') ? rest.slice(0, -1) : rest
  return trimmed !== '' && !trimmed.includes('\\')
}

/**
 * Parse a size filter such as `100mb`, `1.5g`, or a plain byte count.
 * @param {unknown} value - the raw argument.
 * @returns {number|undefined} the size in bytes, or undefined when absent.
 */
export function parseSize(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new Error(`invalid size: ${value}`)
    return Math.floor(value)
  }
  const match = /^\s*(\d+(?:\.\d+)?)\s*(b|k|kb|m|mb|g|gb|t|tb|p|pb)?\s*$/i.exec(String(value))
  if (match === null) throw new Error(`invalid size ${JSON.stringify(value)}; use e.g. 100, 50mb, 1.5gb`)
  const amount = Number.parseFloat(match[1])
  const unit = (match[2] ?? 'b').toLowerCase()
  const factor = { b: 1, k: 1024, kb: 1024, m: 1024 ** 2, mb: 1024 ** 2, g: 1024 ** 3, gb: 1024 ** 3, t: 1024 ** 4, tb: 1024 ** 4, p: 1024 ** 5, pb: 1024 ** 5 }[unit]
  return Math.floor(amount * factor)
}

/**
 * Compile a glob list (`*.mp4|*.mkv`, `report?.txt`) into one case-insensitive
 * regular expression. `*` never crosses a path separator.
 * @param {string} globs - pipe-separated glob patterns.
 * @returns {RegExp} the compiled matcher.
 */
export function compileGlob(globs) {
  const sources = String(globs)
    .split('|')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      let source = ''
      for (const character of part) {
        if (character === '*') source += `[^\\\\/]*`
        else if (character === '?') source += `[^\\\\/]`
        else if ('\\^$.+()[]{}|'.includes(character)) source += `\\${character}`
        else source += character
      }
      return source
    })
  if (sources.length === 0) return /^$/i
  return new RegExp(`^(?:${sources.join('|')})$`, 'i')
}

/**
 * The lower-case extension of a file name, including the dot; `'<none>'` when
 * the name has no extension.
 * @param {string} path - file path.
 * @returns {string} e.g. `.mp4`, `.<none>`.
 */
export function extensionOf(path) {
  const name = String(path).slice(String(path).lastIndexOf('\\') + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return '.<none>'
  return name.slice(dot).toLowerCase()
}

