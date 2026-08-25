import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveNpmCli } from '../scripts/npm-cli.mjs'
import { nativePathFromFileUrl, packageRootFrom } from '../src/project/package-root.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function modulesUnder(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) modulesUnder(absolute, files)
    else if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(absolute)
  }
  return files
}

test('native file URL conversion preserves spaces, percent signs, hashes, and Unicode', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-url-portability-'))
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))
  const modulePath = path.join(tempRoot, 'Atelier path # 100% café', 'module.mjs')
  fs.mkdirSync(path.dirname(modulePath), { recursive: true })
  fs.writeFileSync(modulePath, 'export {}\n')

  assert.equal(nativePathFromFileUrl(pathToFileURL(modulePath)), modulePath)
})

test('package root resolution is native for every runtime caller depth', () => {
  for (const relative of [
    'src/commands/init.mjs',
    'src/egress/check.mjs',
    'src/upgrade/upgrade.mjs',
  ]) {
    assert.equal(packageRootFrom(pathToFileURL(path.join(ROOT, relative))), path.resolve(ROOT), relative)
  }
})

test('runtime modules do not derive filesystem paths from URL pathname', () => {
  const offenders = modulesUnder(path.join(ROOT, 'src'))
    .filter((file) => /import\.meta\.url\)\.pathname/.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(ROOT, file))

  assert.deepEqual(offenders, [])
})

test('npm smoke helpers resolve npm-cli.js as a real file without a shell shim', () => {
  const npmCli = resolveNpmCli()
  assert.equal(path.basename(npmCli), 'npm-cli.js')
  assert.equal(fs.statSync(npmCli).isFile(), true)
})

test('programmatic npm invocations use the cross-platform npm CLI helper', () => {
  const directInvocation = /\b(?:execFileSync|spawnSync|execSync|run|output)\(\s*['"]npm['"]/
  const offenders = [path.join(ROOT, 'scripts'), path.join(ROOT, 'test')]
    .flatMap((directory) => modulesUnder(directory))
    .filter((file) => path.relative(ROOT, file) !== 'scripts/npm-cli.mjs')
    .filter((file) => directInvocation.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(ROOT, file))

  assert.deepEqual(offenders, [])
})

test('Node entrypoints do not target platform-specific node_modules bin shims', () => {
  const binShimEntrypoint = /\b(?:execFileSync|spawnSync|run)\(\s*process\.execPath\s*,\s*\[\s*['"][^'"]*node_modules[/\\]\.bin[/\\]/
  const offenders = [path.join(ROOT, 'scripts'), path.join(ROOT, 'test')]
    .flatMap((directory) => modulesUnder(directory))
    .filter((file) => binShimEntrypoint.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(ROOT, file))

  assert.deepEqual(offenders, [])
})
