#!/usr/bin/env node
/**
 * Pre-publish validation for the dsh-wiztree bundle.
 *
 * Checks everything a published package needs and everything a loaded Host
 * plugin silently needs: valid JavaScript, a manifest with a `dsh.bundle.patch`,
 * the patch/locale/icon display resources, and a `files` list that actually
 * matches what ships. Run with `npm run check`; `prepack` runs it before a
 * tarball is created, so a broken release cannot be packed.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const failures = []

/**
 * Record one failed check.
 * @param {string} message - what failed.
 * @returns {void}
 */
function fail(message) {
  failures.push(message)
}

/**
 * Pass a check silently.
 * @param {string} message - what passed.
 * @returns {void}
 */
function pass(message) {
  console.log(`ok   ${message}`)
}

/**
 * Read and parse a JSON file relative to the package root.
 * @param {string} path - relative path.
 * @returns {unknown} the parsed value.
 */
function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), 'utf8'))
}

const manifest = readJson('package.json')

// --- manifest -------------------------------------------------------------
for (const key of ['name', 'version', 'description', 'license']) {
  if (typeof manifest[key] !== 'string' || manifest[key] === '') fail(`package.json: missing "${key}"`)
}
if (manifest.private === true) fail('package.json: "private" must be false/absent to publish')
if (manifest.type !== 'module') fail('package.json: "type" must be "module"')
if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(manifest.version ?? '')) fail(`package.json: version ${manifest.version} is not semver`)
if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') fail('package.json: dsh.bundle.patch must be "./cordis.patch.yml"')
if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail('package.json: "files" must list the shipped files')
if (manifest.scripts?.prepack !== 'npm run check') fail('package.json: prepack should run "npm run check"')
if (manifest.exports?.['./locale/*.json'] === undefined) fail('package.json: export "./locale/*.json" is required for display metadata')
if (manifest.exports?.['./icon'] === undefined) fail('package.json: export "./icon" is required for the icon')
if (failures.length === 0) pass('package.json manifest')

// --- patch ----------------------------------------------------------------
const patchPath = join(root, 'cordis.patch.yml')
if (!existsSync(patchPath)) {
  fail('cordis.patch.yml is missing')
} else {
  const patch = readFileSync(patchPath, 'utf8')
  if (!/-\s*insert:/.test(patch)) fail('cordis.patch.yml: expected an `- insert:` block')
  if (!patch.includes(`name: ${manifest.name}`)) fail(`cordis.patch.yml: no row loads "${manifest.name}"`)
  if (!/^\s*-\s*id:\s*\S+/m.test(patch)) fail('cordis.patch.yml: row is missing its id')
  if (failures.length === 0) pass('cordis.patch.yml')
}

// --- javascript -----------------------------------------------------------
const sources = ['index.js', ...readdirSync(join(root, 'src')).filter((name) => name.endsWith('.js')).map((name) => `src/${name}`)]
for (const file of sources) {
  try {
    execFileSync(process.execPath, ['--check', join(root, file)], { stdio: 'pipe' })
  } catch (error) {
    fail(`${file}: ${String(error.stderr ?? error.message).trim().split('\n')[0]}`)
  }
}
if (failures.length === 0) pass(`${sources.length} JavaScript files`)

// --- display resources ----------------------------------------------------
for (const locale of ['en', 'zh']) {
  const file = `locale/${locale}.json`
  if (!existsSync(join(root, file))) {
    fail(`${file} is missing`)
    continue
  }
  const parsed = readJson(file)
  if (typeof parsed.meta?.title !== 'string' || parsed.meta.title === '') fail(`${file}: meta.title is required`)
  if (typeof parsed.meta?.description !== 'string' || parsed.meta.description === '') fail(`${file}: meta.description is required`)
}
const iconPath = join(root, 'icon.svg')
if (!existsSync(iconPath)) {
  fail('icon.svg is missing')
} else {
  const icon = statSync(iconPath)
  if (icon.size > 256 * 1024) fail(`icon.svg is ${icon.size} bytes; the limit is 256 KiB`)
  if (!readFileSync(iconPath, 'utf8').includes('<svg')) fail('icon.svg is not an SVG document')
}
if (failures.length === 0) pass('locale and icon resources')

// --- files list -----------------------------------------------------------
const walk = (path) => readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
  const child = join(path, entry.name)
  return entry.isDirectory() ? walk(child) : [child]
})
const present = new Set(walk(root).map((file) => relative(root, file).replaceAll('\\', '/')))
for (const pattern of manifest.files ?? []) {
  if (pattern.includes('*')) {
    const prefix = pattern.slice(0, pattern.indexOf('*'))
    if (![...present].some((file) => file.startsWith(prefix))) fail(`files: pattern "${pattern}" matches nothing`)
  } else if (!present.has(pattern)) {
    fail(`files: "${pattern}" is missing on disk`)
  }
}
if (failures.length === 0) pass('files list')

// --- report ---------------------------------------------------------------
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`\nall checks passed for ${manifest.name}@${manifest.version}`)
