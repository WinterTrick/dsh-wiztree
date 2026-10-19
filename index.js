/**
 * dsh-wiztree — a Host-only bundle that lets the agent index a Windows drive or
 * folder with WizTree and inspect the result without any further recursion.
 *
 * `wiztree_scan` asks WizTree's command-line exporter for a CSV, keeps it in the
 * plugin's cache directory, and reports the overview. `wiztree_query` streams
 * that CSV to answer follow-up questions. Everything registered here is owned
 * by this plugin's effect, so unloading or HMR removes the tools and their CSVs.
 *
 * @module dsh-wiztree
 */

import { resolveConfig } from './src/config.js'
import { WizTreeRunner } from './src/runner.js'
import { ScanStore } from './src/store.js'
import { createTools } from './src/tools.js'

export const name = 'dsh-wiztree'

/** The tool registry must exist before the tools can be published. */
export const inject = ['tools']

/**
 * Activate the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {unknown} rawConfig - the `config` object from the loader row.
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)

  /**
   * Report through the Host logger when it is available.
   * @param {string} message - the line to log.
   * @param {'info'|'warn'|'error'} [level] - the severity.
   * @returns {void}
   */
  const log = (message, level = 'info') => {
    const logger = ctx.logger
    if (logger !== undefined && typeof logger[level] === 'function') logger[level](message)
    else if (level === 'error') console.error(message)
    else if (level === 'warn') console.warn(message)
    else console.log(message)
  }

  const store = new ScanStore({ maxScans: config.maxScans, cacheDir: config.cacheDir, log })
  const runner = new WizTreeRunner(config, log)
  const tools = createTools({ config, store, runner, log })

  // Cache-directory housekeeping must not delay activation.
  void store.init()

  ctx.effect(() => {
    const disposers = tools.map((tool) => ctx.tools.register(tool))
    return () => {
      for (const dispose of disposers) dispose()
      void store.dispose()
    }
  }, 'dsh-wiztree: tools')

  log(`dsh-wiztree: ready; WizTree export mode via ${config.executable}`, 'info')
}
