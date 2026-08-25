#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execNpmSync } from './npm-cli.mjs'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const packageName = packageJson.name
const expectedVersion = packageJson.version
const expectedTarballName = `${packageName.replace(/^@/, '').replace('/', '-')}-${expectedVersion}.tgz`
const tempRoot = mkdtempSync(join(tmpdir(), 'mnstry-atelier-consumer-'))
let tarballPath
let ownsTarball = false

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? packageRoot,
    encoding: 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  })
}

function runNpm(args, options = {}) {
  return execNpmSync(args, {
    cwd: options.cwd ?? packageRoot,
    encoding: 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  })
}

try {
  const suppliedTarball = process.env.ATELIER_CANDIDATE_TARBALL
  const pack = suppliedTarball
    ? { name: packageName, filename: basename(suppliedTarball) }
    : JSON.parse(runNpm(['pack', '--json']))[0]
  if (pack.name !== packageName) throw new Error(`expected npm pack name ${packageName}, got ${pack.name}`)
  if (pack.filename !== expectedTarballName) {
    throw new Error(`expected npm pack filename ${expectedTarballName}, got ${pack.filename}`)
  }
  tarballPath = suppliedTarball ? resolve(suppliedTarball) : join(packageRoot, pack.filename)
  ownsTarball = !suppliedTarball
  const tarballSha256 = createHash('sha256').update(readFileSync(tarballPath)).digest('hex')
  if (process.env.ATELIER_EXPECTED_TARBALL_SHA256 && process.env.ATELIER_EXPECTED_TARBALL_SHA256 !== tarballSha256) {
    throw new Error(`candidate tarball SHA-256 mismatch: expected ${process.env.ATELIER_EXPECTED_TARBALL_SHA256}, got ${tarballSha256}`)
  }

  writeFileSync(
    join(tempRoot, 'package.json'),
    `${JSON.stringify({ name: 'atelier-bare-consumer', private: true, type: 'module' }, null, 2)}\n`,
  )

  // The install below is deliberately --offline: a consumer must be able to
  // install the tarball from a warm cache with no registry. But `npm ci` in the
  // package root caches dependency *tarballs* by their locked resolved URL and
  // does not necessarily cache the *packuments* npm needs to resolve the
  // tarball's own dependency ranges — so on a cold runner the offline install
  // failed with ENOTCACHED even though `npm ci` had just run.
  //
  // Warm the whole non-dev closure from the lockfile, not just the direct
  // dependencies: resolving `ajv` also requires `fast-deep-equal` and the rest
  // of its tree, and warming one level deep only moved the error down a layer.
  // The lockfile is the right source because it already carries the exact
  // resolved versions. The consumer itself intentionally has no publisher
  // overrides: the packed package must resolve correctly on its own.
  const lockfile = JSON.parse(readFileSync(join(packageRoot, 'package-lock.json'), 'utf8'))
  const closure = Object.entries(lockfile.packages ?? {})
    .filter(([path, entry]) => path.startsWith('node_modules/') && !entry.dev && entry.version)
    .map(([path, entry]) => `${path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)}@${entry.version}`)
  if (closure.length > 0) runNpm(['cache', 'add', ...closure])

  runNpm(['install', tarballPath, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], {
    cwd: tempRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const consumerPackage = JSON.parse(readFileSync(join(tempRoot, 'package.json'), 'utf8'))
  if ('overrides' in consumerPackage) throw new Error('bare consumer must not inherit publisher overrides')
  const installedTree = JSON.parse(runNpm(['ls', '--all', '--json'], { cwd: tempRoot }))
  if (installedTree.problems?.length) {
    throw new Error(`bare consumer dependency closure is invalid: ${installedTree.problems.join('; ')}`)
  }

  writeFileSync(join(tempRoot, 'smoke.mjs'), `
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  bundledReadinessProtocols,
  scanDisclosureContent,
  validateAtelierExportDryRun,
} from '@mnstry/atelier'

const fixturePath = fileURLToPath(import.meta.resolve('@mnstry/atelier/fixtures/atelier-export/sample-studio-offer.v1.json'))
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
const report = validateAtelierExportDryRun(fixture)
assert.equal(report.accepted, true)
assert.equal(report.importable, false)
assert.equal(report.errors.length, 0)

const invalid = JSON.parse(JSON.stringify(fixture))
invalid.provenance.sourceNodes[0].visibility = 'public'
const invalidReport = validateAtelierExportDryRun(invalid)
assert.equal(invalidReport.accepted, false)
assert.match(invalidReport.errors.join('\\n'), /must use audience, not visibility/)
assert.equal(bundledReadinessProtocols.length, 12)
assert.equal(bundledReadinessProtocols[0].safety.runtimeMutation, false)
assert.equal(typeof scanDisclosureContent, 'function')

const declaredExports = ${JSON.stringify(packageJson.exports, null, 2)}
for (const [subpath, target] of Object.entries(declaredExports)) {
  const specifier = subpath === '.' ? '${packageName}' : '${packageName}/' + subpath.slice(2)
  if (target.endsWith('.json')) {
    const resolved = fileURLToPath(import.meta.resolve(specifier))
    JSON.parse(readFileSync(resolved, 'utf8'))
  } else {
    const loaded = await import(specifier)
    assert.equal(typeof loaded, 'object', 'expected ' + specifier + ' to import as a module namespace')
  }
}
`)

  run(process.execPath, ['smoke.mjs'], { cwd: tempRoot, stdio: 'inherit' })
  const atelierCli = join('node_modules', '@mnstry', 'atelier', 'bin', 'atelier.mjs')
  const legacyCli = join('node_modules', '@mnstry', 'atelier', 'bin', 'mnstry-atelier.mjs')
  const cliOutput = run(process.execPath, [
    atelierCli,
    'dry-run',
    join('node_modules', '@mnstry', 'atelier', 'fixtures', 'atelier-export', 'sample-studio-offer.v1.json'),
  ], { cwd: tempRoot })
  const cliReport = JSON.parse(cliOutput)
  if (cliReport.accepted !== true) throw new Error('atelier dry-run did not accept the sample fixture')

  for (const command of ['mnstry', 'mnstry.cmd', 'mnstry.ps1']) {
    if (existsSync(join(tempRoot, 'node_modules', '.bin', command))) {
      throw new Error(`install must not create a bare ${command} command`)
    }
  }

  const directCliOutput = run(process.execPath, [atelierCli, '--version'], { cwd: tempRoot })
  if (directCliOutput.trim() !== expectedVersion) {
    throw new Error(`atelier --version returned ${directCliOutput.trim()}`)
  }

  const legacyCliOutput = run(process.execPath, [legacyCli, '--version'], { cwd: tempRoot })
  if (legacyCliOutput.trim() !== expectedVersion) {
    throw new Error(`mnstry-atelier --version returned ${legacyCliOutput.trim()}`)
  }

  run('git', ['init', '--quiet'], { cwd: tempRoot })
  writeFileSync(join(tempRoot, 'public-note.md'), 'invented public fixture\n')
  run('git', ['add', 'public-note.md'], { cwd: tempRoot })
  const disclosureOutput = run(process.execPath, [
    'node_modules/.bin/atelier',
    'disclosure',
    'check',
    '--root',
    '.',
    '--staged',
    '--structural-only',
  ], { cwd: tempRoot })
  if (!disclosureOutput.includes('[disclosure:check] clean')) {
    throw new Error('packed disclosure command did not scan the staged consumer fixture')
  }

  console.log(`[consumer:smoke] SHA-256 ${tarballSha256}; packed tarball installs without publisher overrides and imports ${Object.keys(packageJson.exports).length} declared exports`)
} finally {
  if (tarballPath && ownsTarball) rmSync(tarballPath, { force: true })
  rmSync(tempRoot, { recursive: true, force: true })
}
