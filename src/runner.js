/**
 * Runs WizTree in its command-line export mode and waits until the CSV is
 * complete.
 *
 * WizTree writes the export only after the scan finishes, then exits. The
 * 32-bit `WizTree.exe` relaunches `WizTree64.exe` and returns immediately, so
 * "the process exited" is not a completion signal: the CSV appearing and its
 * size settling are. Every scan is bounded by `timeoutMs` and by the caller's
 * AbortSignal.
 *
 * WizTree is commonly marked with the Windows compatibility layer
 * `RUNASADMIN`, which makes CreateProcess fail with EACCES for a
 * non-elevated caller. When that happens (or when `elevation: 'uac'` asks for
 * it) the scan is relaunched through `Start-Process -Verb RunAs`, which shows
 * the usual UAC prompt once per scan. A DSH process that already runs elevated
 * skips the prompt and can also use WizTree's fast MFT scan.
 *
 * @module dsh-wiztree/runner
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdir, stat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

/** How often the CSV path is polled while WizTree scans. */
const POLL_INTERVAL_MS = 200

/** How long the CSV size must stay unchanged before it counts as complete. */
const STABLE_WINDOW_MS = 700

/** Grace after a failed WizTree exit, in case the export is still flushed. */
const EXIT_GRACE_MS = 5000

/** How much captured stderr is kept for diagnostics. */
const STDERR_LIMIT = 4096

/** Where the elevated relaunch gets its PowerShell from. */
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

/** Error codes that mean "this executable cannot be launched without elevation". */
const ELEVATION_ERROR_CODES = new Set(['EACCES', 'EPERM'])

/** A failure while producing a WizTree export. */
export class WizTreeError extends Error {
  /**
   * @param {string} message - what failed.
   * @param {{ cause?: unknown }} [options] - the underlying error.
   */
  constructor(message, options = {}) {
    super(message, options)
    this.name = 'WizTreeError'
  }
}

/**
 * Sleep for a while.
 * @param {number} ms - milliseconds.
 * @returns {Promise<void>} resolves after the delay.
 */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * Read a file's size, or undefined when it does not exist.
 * @param {string} path - the file.
 * @returns {Promise<number|undefined>} the size.
 */
async function sizeOrUndefined(path) {
  try {
    const info = await stat(path)
    return info.size
  } catch {
    return undefined
  }
}

/**
 * Whether a spawn failure means the executable needs elevation.
 * @param {NodeJS.ErrnoException} error - the spawn error.
 * @returns {boolean} true for EACCES/EPERM.
 */
function isElevationError(error) {
  return ELEVATION_ERROR_CODES.has(String(error?.code ?? ''))
}

/**
 * Quote one value for a PowerShell single-quoted string literal.
 * @param {string} value - the raw value.
 * @returns {string} the quoted literal.
 */
function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * Quote one argument for a Windows command line using the exact
 * `CommandLineToArgvW` algorithm: a run of `n` backslashes before a `"` becomes
 * `2n + 1` backslashes (a literal backslash plus the quote toggle), and a
 * trailing run of `n` backslashes becomes `2n`. Getting this wrong lets a value
 * such as `x\" /treemapimagefile=...` end its argument early and inject extra
 * WizTree switches into the elevated launch.
 * @param {string} value - the raw argument.
 * @returns {string} the argument, quoted only when needed.
 */
function quoteWindowsArgument(value) {
  if (value === '') return '""'
  if (!/[\s"]/.test(value)) return value
  let quoted = '"'
  let backslashes = 0
  for (const character of value) {
    if (character === '\\') {
      backslashes += 1
      continue
    }
    if (character === '"') {
      quoted += `${'\\'.repeat(backslashes * 2 + 1)}"`
      backslashes = 0
      continue
    }
    quoted += `${'\\'.repeat(backslashes)}${character}`
    backslashes = 0
  }
  quoted += `${'\\'.repeat(backslashes * 2)}"`
  return quoted
}

/**
 * The scan target as WizTree's command line wants it: a drive letter without
 * its trailing separator (`C:`), or a folder without its trailing separator.
 * A quoted path ending in `\` would have that backslash escape the quote.
 * @param {string} root - the normalised scan root.
 * @returns {string} the argument to pass to WizTree.
 */
function scanTarget(root) {
  if (/^[A-Za-z]:\\$/.test(root)) return root.slice(0, 2)
  return root.replace(/\\+$/, '')
}

/** Cached result of the one-time elevation probe. */
let elevationProbe

/**
 * Whether the current process holds an elevated Administrator token. The
 * answer is cached: it cannot change while the Host process runs.
 * @returns {Promise<boolean|undefined>} true/false, or undefined when unknown.
 */
export function detectElevation() {
  if (elevationProbe !== undefined) return elevationProbe
  elevationProbe = new Promise((resolve) => {
    const script = '[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'
    let child
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      resolve(undefined)
      return
    }
    let output = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      resolve(undefined)
    }, 8000)
    timer.unref?.()
    child.stdout?.on('data', (chunk) => { output += String(chunk) })
    child.on('error', () => {
      clearTimeout(timer)
      resolve(undefined)
    })
    child.on('close', () => {
      clearTimeout(timer)
      const text = output.trim().toLowerCase()
      resolve(text === 'true' ? true : text === 'false' ? false : undefined)
    })
  })
  return elevationProbe
}

export class WizTreeRunner {
  /**
   * @param {import('./config.js').ResolvedConfig} config - resolved plugin config.
   * @param {(message: string, level?: 'info'|'warn'|'error') => void} [log] - plugin logger.
   */
  constructor(config, log = () => {}) {
    this.config = config
    this.log = log
  }

  /**
   * Fail early with an actionable message when the executable is missing.
   * @returns {void}
   * @throws {WizTreeError} when the configured path is not a file.
   */
  assertExecutable() {
    if (!existsSync(this.config.executable)) {
      throw new WizTreeError(
        `WizTree executable not found at ${this.config.executable}. `
        + 'Set `executable` in the plugin config (the `wiztree` row) to the installed WizTree64.exe path.',
      )
    }
  }

  /**
   * Whether the executable is the 32-bit launcher, which hands off to
   * WizTree64.exe and exits before the scan finishes.
   * @returns {boolean} true for `WizTree.exe`.
   */
  get launcherRelay() {
    return /[\\/]wiztree\.exe$/i.test(this.config.executable)
  }

  /**
   * Spawn a command and report either the running child or the spawn error.
   * @param {string} command - the executable.
   * @param {string[]} args - its arguments.
   * @returns {Promise<{ child?: import('node:child_process').ChildProcess, error?: NodeJS.ErrnoException }>} the launch result.
   */
  #spawnDetect(command, args) {
    return new Promise((resolve) => {
      let child
      try {
        child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        resolve({ error: /** @type {NodeJS.ErrnoException} */ (error) })
        return
      }
      let settled = false
      child.once('spawn', () => {
        if (settled) return
        settled = true
        resolve({ child })
      })
      child.once('error', (error) => {
        if (settled) return
        settled = true
        resolve({ error })
      })
    })
  }

  /**
   * Launch WizTree directly, inheriting the Host token.
   * @param {string[]} args - WizTree command line.
   * @returns {Promise<{ child?: import('node:child_process').ChildProcess, error?: NodeJS.ErrnoException }>} the launch result.
   */
  #launchDirect(args) {
    return this.#spawnDetect(this.config.executable, args)
  }

  /**
   * Launch WizTree through a UAC-elevated `Start-Process`. The generated script
   * passes the exact argument array and forwards WizTree's exit code.
   * @param {string[]} args - WizTree command line.
   * @returns {Promise<{ child?: import('node:child_process').ChildProcess, error?: NodeJS.ErrnoException }>} the launch result.
   */
  #launchElevated(args) {
    // `-ArgumentList` with a single string is forwarded as the whole command
    // line, so each argument is quoted here once; an array would be joined
    // with plain spaces and split folder names that contain spaces.
    const commandLine = args.map(quoteWindowsArgument).join(' ')
    const script = [
      '$ErrorActionPreference = "Stop"',
      'try {',
      `  $process = Start-Process -FilePath ${quotePowerShell(this.config.executable)} `
        + `-ArgumentList ${quotePowerShell(commandLine)} -Verb RunAs -Wait -PassThru`,
      '  exit $process.ExitCode',
      '} catch {',
      '  [Console]::Error.WriteLine("__DSH_WIZTREE_UAC__ " + $_.Exception.Message)',
      '  exit 1',
      '}',
    ].join('\n')
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const powershell = existsSync(POWERSHELL) ? POWERSHELL : 'powershell.exe'
    return this.#spawnDetect(powershell, [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encoded,
    ])
  }

  /**
   * Build the WizTree argument list for one scan.
   * @param {string} root - normalised scan root.
   * @param {string} csvPath - export path.
   * @param {boolean} admin - whether MFT mode may be requested.
   * @param {number} maxExportDepth - export depth limit; 0 is unlimited.
   * @param {string|undefined} filter - include filter.
   * @param {string|undefined} exclude - exclude filter.
   * @returns {string[]} the arguments.
   */
  #buildArguments(root, csvPath, admin, maxExportDepth, filter, exclude) {
    const args = [
      scanTarget(root),
      `/export=${csvPath}`,
      `/admin=${admin ? 1 : 0}`,
      '/exportfolders=1',
      '/exportfiles=1',
      '/sortby=1',
    ]
    if (maxExportDepth > 0) args.push(`/exportmaxdepth=${maxExportDepth}`)
    if (filter !== undefined && filter !== '') args.push(`/filter=${filter}`)
    if (exclude !== undefined && exclude !== '') args.push(`/filterexclude=${exclude}`)
    args.push(...this.config.extraArgs)
    return args
  }

  /**
   * Run one scan and resolve when WizTree's CSV export is complete.
   * @param {object} request - the scan request.
   * @param {string} request.root - normalised scan root.
   * @param {string} request.csvPath - absolute export path.
   * @param {string} [request.filter] - WizTree include filter.
   * @param {string} [request.exclude] - WizTree exclude filter.
   * @param {boolean} request.admin - request MFT scanning.
   * @param {'auto'|'uac'|'never'} request.elevation - how hard to try running elevated.
   * @param {number} request.maxExportDepth - `/exportmaxdepth`; 0 means unlimited.
   * @param {number} request.timeoutMs - whole-scan deadline.
   * @param {AbortSignal} [request.signal] - cancellation.
   * @returns {Promise<{ csvPath: string, elapsedMs: number, exitCode: number|null|undefined, stderr: string, admin: boolean, launchStyle: 'direct'|'uac', warning: string|undefined }>} the completed export.
   */
  async scan(request) {
    this.assertExecutable()
    // The CSV is written by an elevated WizTree, so a symlinked or junctioned
    // cache directory would redirect an administrator write outside the temp
    // tree. Refuse instead of following it.
    const cacheInfo = await lstat(this.config.cacheDir).catch(() => undefined)
    if (cacheInfo !== undefined && cacheInfo.isSymbolicLink()) {
      throw new WizTreeError(
        `Cache directory ${this.config.cacheDir} is a symbolic link or junction; `
        + 'refusing to let an elevated WizTree write through it. Point `cacheDir` at a real directory.',
      )
    }
    await mkdir(dirname(request.csvPath), { recursive: true })
    await unlink(request.csvPath).catch(() => {})

    const elevated = await detectElevation()
    const canElevate = request.elevation !== 'never'
    let style = 'direct'
    if (elevated !== true && request.elevation === 'uac') style = 'uac'

    /** @type {import('node:child_process').ChildProcess|undefined} */
    let child
    let launchedArgs
    for (;;) {
      const adminFlag = style === 'uac' ? request.admin : (request.admin && elevated === true)
      const args = this.#buildArguments(
        request.root,
        request.csvPath,
        adminFlag,
        request.maxExportDepth,
        request.filter,
        request.exclude,
      )
      this.log(`dsh-wiztree: ${style === 'uac' ? '[UAC] ' : ''}${this.config.executable} ${args.join(' ')}`, 'info')
      const launch = style === 'uac' ? await this.#launchElevated(args) : await this.#launchDirect(args)
      if (launch.child !== undefined) {
        child = launch.child
        launchedArgs = args
        break
      }
      if (style === 'direct' && canElevate && isElevationError(launch.error)) {
        this.log(
          'dsh-wiztree: WizTree refused a direct launch (RUNASADMIN compatibility setting); retrying through UAC',
          'warn',
        )
        style = 'uac'
        continue
      }
      throw new WizTreeError(
        `Could not start WizTree at ${this.config.executable}: ${launch.error?.message ?? 'unknown error'}`
        + (style === 'direct' && request.elevation === 'never'
          ? ' Start DSH as administrator, or set `elevation` to "auto" or "uac".'
          : ''),
      )
    }

    const sendArgs = launchedArgs ?? []
    const effectiveAdmin = sendArgs.some((argument) => argument === '/admin=1')

    /** @type {{ code: number|null, signal: string|null, at: number }|undefined} */
    let exitInfo
    let stderr = ''
    let spawnError
    const startedAt = Date.now()

    child.stdout?.on('data', () => {})
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < STDERR_LIMIT) stderr += chunk.toString()
    })
    child.on('error', (error) => {
      spawnError = error
    })
    child.on('close', (code, signal) => {
      exitInfo = { code, signal, at: Date.now() }
    })

    const deadline = startedAt + request.timeoutMs
    let lastSize
    let stableSince
    let abortListener
    if (request.signal !== undefined) {
      abortListener = () => {
        try { child.kill() } catch {}
      }
      if (request.signal.aborted) abortListener()
      else request.signal.addEventListener('abort', abortListener, { once: true })
    }

    let warnings = []
    if (style === 'uac') {
      warnings.push(
        'WizTree was launched through a UAC prompt because Windows is configured to always elevate it '
        + '(RUNASADMIN). Confirm the prompt on each scan, or start DSH as administrator to make scans '
        + 'silent and enable the fast MFT mode.',
      )
    } else if (elevated === false && request.admin) {
      warnings.push(
        'MFT scanning needs administrator rights, so this scan used WizTree\'s standard file walk. '
        + 'Start DSH as administrator (or set `elevation: "uac"`) for fast full-drive scans.',
      )
    }

    try {
      for (;;) {
        if (request.signal?.aborted) throw new WizTreeError('WizTree scan cancelled')
        if (spawnError !== undefined) {
          throw new WizTreeError(`WizTree process failed: ${spawnError.message}`)
        }
        const now = Date.now()
        const size = await sizeOrUndefined(request.csvPath)
        if (size !== undefined && size > 0) {
          if (size === lastSize) {
            stableSince ??= now
            if (now - stableSince >= STABLE_WINDOW_MS) {
              return {
                csvPath: request.csvPath,
                elapsedMs: Date.now() - startedAt,
                exitCode: exitInfo?.code,
                stderr,
                admin: effectiveAdmin,
                launchStyle: style,
                warning: warnings.length === 0 ? undefined : warnings.join(' '),
              }
            }
          } else {
            lastSize = size
            stableSince = undefined
          }
        } else if (exitInfo !== undefined && !this.launcherRelay) {
          const grace = style === 'uac' ? 1500 : EXIT_GRACE_MS
          if (now - exitInfo.at >= grace) {
            const cancelled = /__DSH_WIZTREE_UAC__/.test(stderr) || /cancel|取消/i.test(stderr)
            throw new WizTreeError(
              (cancelled
                ? 'The UAC prompt was dismissed, so WizTree did not run. Approve the prompt, or start DSH as administrator.\n'
                : `WizTree exited with code ${exitInfo.code} before writing ${request.csvPath}.\n`)
              + (stderr.trim() === '' ? '' : `stderr: ${stderr.trim().slice(0, 700)}`),
            )
          }
        }
        if (now >= deadline) {
          try { child.kill() } catch {}
          throw new WizTreeError(
            `WizTree did not finish within ${Math.round(request.timeoutMs / 1000)}s (scan root ${request.root}). `
            + 'Approve the UAC prompt if it is still waiting, scan a smaller folder, or raise `timeoutMs`.',
          )
        }
        await sleep(POLL_INTERVAL_MS)
      }
    } finally {
      if (request.signal !== undefined && abortListener !== undefined) {
        request.signal.removeEventListener('abort', abortListener)
      }
      if (exitInfo === undefined && request.signal?.aborted) {
        try { child.kill() } catch {}
      }
    }
  }
}
