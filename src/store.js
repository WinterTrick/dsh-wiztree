/**
 * In-memory index of completed WizTree scans, and the CSV files they own.
 *
 * A scan id is the handle the agent uses for follow-up queries. Only the most
 * recent `maxScans` indexes stay available; evicting one deletes its CSV so the
 * cache directory cannot grow without bound. CSV files left behind by a
 * previous Host process are removed when they are older than a day.
 *
 * @module dsh-wiztree/store
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

/** Age after which an orphaned CSV from a previous process is removed. */
const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Only files this plugin itself names may ever be deleted from `cacheDir`.
 * `cacheDir` is user-configurable, so a broad `*.csv` sweep there could destroy
 * unrelated documents when the directory is pointed somewhere unexpected.
 */
const OWN_CSV_PATTERN = /^wiz-\d{8}-\d{6}-[0-9a-f]{4}\.csv$/i

/**
 * @typedef {object} ScanRecord
 * @property {string} id - the scan id.
 * @property {string} root - normalised scan root.
 * @property {string} csvPath - the exported CSV.
 * @property {number} createdAt - epoch milliseconds.
 * @property {number} elapsedMs - how long WizTree took.
 * @property {string} executable - the WizTree executable that ran.
 * @property {boolean} admin - whether WizTree actually ran in MFT mode.
 * @property {'direct'|'uac'} launchStyle - how WizTree was launched.
 * @property {string} [warning] - a non-fatal note shown in the scan report.
 * @property {string} [filter] - include filter.
 * @property {string} [exclude] - exclude filter.
 * @property {number} maxExportDepth - export depth limit.
 * @property {number} csvBytes - size of the CSV in bytes.
 * @property {number} entries - number of exported rows.
 * @property {number} totalBytes - root size.
 * @property {number} totalFiles - root file count.
 * @property {number} totalFolders - root folder count.
 * @property {{ path: string, isDirectory: boolean, size: number }[]} topDirs - largest direct children that are folders.
 * @property {{ path: string, size: number }[]} topFiles - largest files anywhere below the root.
 * @property {{ extension: string, bytes: number, files: number }[]} topTypes - largest extensions.
 */

/**
 * Build a readable, unique scan id.
 * @returns {string} e.g. `wiz-20261019-190500-a1b2`.
 */
function makeScanId() {
  const now = new Date()
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `wiz-${stamp}-${randomBytes(2).toString('hex')}`
}

export class ScanStore {
  /**
   * @param {{ maxScans: number, cacheDir: string, log?: (message: string, level?: string) => void }} options - store options.
   */
  constructor({ maxScans, cacheDir, log = () => {} }) {
    this.maxScans = maxScans
    this.cacheDir = cacheDir
    this.log = log
    /** @type {Map<string, ScanRecord>} */
    this.scans = new Map()
  }

  /**
   * Create the cache directory and drop CSVs orphaned by an earlier process.
   * @returns {Promise<void>} resolves when the directory is usable.
   */
  async init() {
    try {
      await mkdir(this.cacheDir, { recursive: true })
      const entries = await readdir(this.cacheDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile() || !OWN_CSV_PATTERN.test(entry.name)) continue
        const path = join(this.cacheDir, entry.name)
        const info = await stat(path).catch(() => undefined)
        if (info === undefined || Date.now() - info.mtimeMs > ORPHAN_AGE_MS) {
          await unlink(path).catch(() => {})
        }
      }
    } catch (error) {
      this.log(`dsh-wiztree: cache directory ${this.cacheDir} is unusable: ${error.message}`, 'warn')
    }
  }

  /**
   * Reserve a scan id and CSV path before the scan runs.
   * @returns {{ id: string, csvPath: string }} the reservation.
   */
  reserve() {
    const id = makeScanId()
    return { id, csvPath: join(this.cacheDir, `${id}.csv`) }
  }

  /**
   * Publish a completed scan.
   * @param {ScanRecord} record - the scan record.
   * @returns {ScanRecord} the stored record.
   */
  add(record) {
    this.scans.set(record.id, record)
    void this.evict()
    return record
  }

  /**
   * Drop the oldest scans until `maxScans` remain, deleting their CSVs.
   * @returns {Promise<void>} resolves when eviction finished.
   */
  async evict() {
    while (this.scans.size > this.maxScans) {
      const oldest = this.scans.keys().next()
      if (oldest.done === true) return
      const record = this.scans.get(oldest.value)
      this.scans.delete(oldest.value)
      if (record !== undefined) await unlink(record.csvPath).catch(() => {})
    }
  }

  /**
   * Look a scan up by id.
   * @param {string} id - the scan id.
   * @returns {ScanRecord|undefined} the record.
   */
  get(id) {
    return this.scans.get(id)
  }

  /**
   * The most recent scan.
   * @returns {ScanRecord|undefined} the record.
   */
  latest() {
    let last
    for (const record of this.scans.values()) last = record
    return last
  }

  /**
   * All retained scans, oldest first.
   * @returns {ScanRecord[]} the records.
   */
  list() {
    return [...this.scans.values()]
  }

  /**
   * Resolve an explicit scan id or fall back to the newest scan.
   * @param {string|undefined} id - the requested id.
   * @returns {ScanRecord} the record.
   * @throws {Error} when no scan matches.
   */
  resolve(id) {
    if (id !== undefined && id !== '') {
      const record = this.scans.get(id)
      if (record === undefined) {
        throw new Error(`Unknown scan id ${JSON.stringify(id)}. Call wiztree_scan first, or action "info" without scanId to list retained scans.`)
      }
      return record
    }
    const latest = this.latest()
    if (latest === undefined) {
      throw new Error('No WizTree scan is cached in this session. Call wiztree_scan first.')
    }
    return latest
  }

  /**
   * Delete every cached CSV.
   * @returns {Promise<void>} resolves when cleanup finished.
   */
  async dispose() {
    for (const record of this.scans.values()) {
      await unlink(record.csvPath).catch(() => {})
    }
    this.scans.clear()
  }
}
