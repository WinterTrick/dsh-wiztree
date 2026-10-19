/**
 * Plugin configuration: one plain object read from the `wiztree` row in
 * `cordis.patch.yml` / the user's patch layer, validated here.
 *
 * The plugin exports no Schemastery `Config` on purpose: the Host half must
 * load with no `@deepseek-ai/*` value import of its own, so validation is
 * explicit and fails loud, naming the offending key.
 *
 * @module dsh-wiztree/config
 */

import { isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'

/** Default WizTree executable. The 64-bit build is preferred: the 32-bit
 * `WizTree.exe` only relaunches `WizTree64.exe` and returns immediately. */
export const DEFAULT_EXECUTABLE = 'G:\\Wiztree\\WizTree64.exe'

/** Every key this plugin accepts. */
const KNOWN_KEYS = [
  'executable',
  'timeoutMs',
  'admin',
  'elevation',
  'maxScans',
  'cacheDir',
  'defaultLimit',
  'maxExportDepth',
  'extraArgs',
]

/** Configuration error raised for a value the plugin cannot honour. */
export class ConfigError extends Error {
  /** @param {string} message - what is wrong and what is accepted. */
  constructor(message) {
    super(`dsh-wiztree config: ${message}`)
    this.name = 'ConfigError'
  }
}

/**
 * Read an optional string.
 * @param {Record<string, unknown>} raw - the whole row config.
 * @param {string} key - the key to read.
 * @param {string} fallback - the value when the key is absent.
 * @returns {string} the value.
 */
function optionalString(raw, key, fallback) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`${key} must be a non-empty string, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Read an optional boolean.
 * @param {Record<string, unknown>} raw - the whole row config.
 * @param {string} key - the key to read.
 * @param {boolean} fallback - the value when the key is absent.
 * @returns {boolean} the value.
 */
function optionalBoolean(raw, key, fallback) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') {
    throw new ConfigError(`${key} must be a boolean, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Read an optional integer inside an inclusive range.
 * @param {Record<string, unknown>} raw - the whole row config.
 * @param {string} key - the key to read.
 * @param {number} fallback - the value when the key is absent.
 * @param {number} min - inclusive lower bound.
 * @param {number} max - inclusive upper bound.
 * @returns {number} the value.
 */
function optionalInteger(raw, key, fallback, min, max) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigError(`${key} must be an integer between ${min} and ${max}, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Read an optional value from a fixed set of strings.
 * @param {Record<string, unknown>} raw - the whole row config.
 * @param {string} key - the key to read.
 * @param {string} fallback - the value when the key is absent.
 * @param {string[]} allowed - the accepted values.
 * @returns {string} the value.
 */
function optionalEnum(raw, key, fallback, allowed) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new ConfigError(`${key} must be one of ${allowed.map((entry) => JSON.stringify(entry)).join(', ')}, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Read an optional list of non-empty strings.
 * @param {Record<string, unknown>} raw - the whole row config.
 * @param {string} key - the key to read.
 * @returns {string[]} the value, empty when absent.
 */
function optionalStringList(raw, key) {
  const value = raw[key]
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    throw new ConfigError(`${key} must be an array of non-empty strings, got ${JSON.stringify(value)}`)
  }
  return [...value]
}

/**
 * The resolved configuration, with every default applied.
 * @typedef {object} ResolvedConfig
 * @property {string} executable - absolute path of the WizTree executable.
 * @property {number} timeoutMs - per-scan deadline for WizTree to finish and write the CSV.
 * @property {boolean} admin - request WizTree's fast MFT scan when the launch is elevated.
 * @property {'auto'|'uac'|'never'} elevation - how to react when Windows refuses a direct launch.
 * @property {number} maxScans - how many scan indexes stay cached at once.
 * @property {string} cacheDir - where scan CSVs are kept.
 * @property {number} defaultLimit - default result count for queries.
 * @property {number} maxExportDepth - `/exportmaxdepth` value; 0 keeps everything.
 * @property {string[]} extraArgs - extra raw command-line arguments appended to every scan.
 */

/**
 * Validate one plugin row's config.
 * @param {unknown} rawConfig - the `config` value from the loader row.
 * @returns {ResolvedConfig} the resolved configuration.
 */
export function resolveConfig(rawConfig) {
  if (rawConfig === undefined || rawConfig === null) rawConfig = {}
  if (typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    throw new ConfigError(`config must be an object, got ${JSON.stringify(rawConfig)}`)
  }
  const raw = /** @type {Record<string, unknown>} */ (rawConfig)
  const unknown = Object.keys(raw).filter((key) => !KNOWN_KEYS.includes(key))
  if (unknown.length > 0) {
    throw new ConfigError(
      `unknown key(s) ${unknown.map((key) => JSON.stringify(key)).join(', ')}; `
      + `accepted keys are ${KNOWN_KEYS.map((key) => JSON.stringify(key)).join(', ')}`,
    )
  }

  const cacheDir = optionalString(raw, 'cacheDir', join(tmpdir(), 'dsh-wiztree'))
  if (!isAbsolute(cacheDir)) {
    throw new ConfigError(`cacheDir must be an absolute path, got ${JSON.stringify(cacheDir)}`)
  }

  return {
    executable: optionalString(raw, 'executable', DEFAULT_EXECUTABLE),
    timeoutMs: optionalInteger(raw, 'timeoutMs', 300_000, 10_000, 3_600_000),
    admin: optionalBoolean(raw, 'admin', true),
    elevation: optionalEnum(raw, 'elevation', 'auto', ['auto', 'uac', 'never']),
    maxScans: optionalInteger(raw, 'maxScans', 8, 1, 64),
    cacheDir,
    defaultLimit: optionalInteger(raw, 'defaultLimit', 50, 1, 500),
    maxExportDepth: optionalInteger(raw, 'maxExportDepth', 0, 0, 64),
    extraArgs: optionalStringList(raw, 'extraArgs'),
  }
}
