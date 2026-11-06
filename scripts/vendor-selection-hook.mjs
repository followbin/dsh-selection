#!/usr/bin/env node
// Refreshes vendor/selection-hook from the npm release.
//
// The upstream package runs `node-gyp-build` as an install script. DSH installs plugins
// with pnpm 11, which refuses unapproved dependency scripts, so users would be asked to
// trust a build step on every install. The package already ships N-API prebuilds; we copy
// the ones DSH Desktop targets and load them directly, which needs no install step.
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = process.argv[2] ?? '2.1.2'
const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64']
const root = fileURLToPath(new URL('..', import.meta.url))
const target = join(root, 'vendor', 'selection-hook')
const work = mkdtempSync(join(tmpdir(), 'selection-hook-'))

try {
  const tarball = execFileSync('npm', ['pack', `selection-hook@${VERSION}`, '--silent'], { cwd: work, encoding: 'utf8' }).trim()
  execFileSync('tar', ['-xzf', tarball], { cwd: work })
  const source = join(work, 'package')

  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  for (const file of ['LICENSE', 'index.d.ts']) cpSync(join(source, file), join(target, file))
  for (const platform of PLATFORMS) cpSync(join(source, 'prebuilds', platform), join(target, 'prebuilds', platform), { recursive: true })

  const loader = readFileSync(join(source, 'index.js'), 'utf8')
  const patched = loader
    .replace('const gypBuild = require("node-gyp-build");\n', '')
    .replace(
      'nativeModule = gypBuild(path.resolve(__dirname));',
      'nativeModule = require(path.join(__dirname, "prebuilds", `${process.platform}-${process.arch}`, "selection-hook.node"));',
    )
  if (patched === loader || patched.includes('gypBuild')) throw new Error('upstream loader changed; update the patch in scripts/vendor-selection-hook.mjs')
  writeFileSync(join(target, 'index.js'), patched)
  writeFileSync(join(target, 'package.json'), `${JSON.stringify({
    name: 'selection-hook',
    version: VERSION,
    private: true,
    type: 'commonjs',
    main: 'index.js',
    types: 'index.d.ts',
    license: 'MIT',
    description: `Vendored from selection-hook@${VERSION} (https://github.com/0xfullex/selection-hook) with prebuilds for ${PLATFORMS.join(', ')}.`,
  }, null, 2)}\n`)
  console.log(`vendored selection-hook@${VERSION} (${PLATFORMS.join(', ')}) into ${target}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
