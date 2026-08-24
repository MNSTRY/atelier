#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const packageName = packageJson.name
const expectedVersion = packageJson.version
const expectedTarballName = `${packageName.replace(/^@/, '').replace('/', '-')}-${expectedVersion}.tgz`
const tempRoot = mkdtempSync(join(tmpdir(), 'mnstry-atelier-consumer-'))
let tarballPath

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? packageRoot,
    encoding: 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  })
}

try {
  const pack = JSON.parse(run('npm', ['pack', '--json']))[0]
  if (pack.name !== packageName) throw new Error(`expected npm pack name ${packageName}, got ${pack.name}`)
  if (pack.filename !== expectedTarballName) {
    throw new Error(`expected npm pack filename ${expectedTarballName}, got ${pack.filename}`)
  }
  tarballPath = join(packageRoot, pack.filename)

  writeFileSync(
    join(tempRoot, 'package.json'),
    `${JSON.stringify({ type: 'module', overrides: packageJson.overrides ?? {} }, null, 2)}\n`,
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
  // The lockfile is the right source because it already carries exact resolved
  // versions, including anything pinned by `overrides`.
  const lockfile = JSON.parse(readFileSync(join(packageRoot, 'package-lock.json'), 'utf8'))
  const closure = Object.entries(lockfile.packages ?? {})
    .filter(([path, entry]) => path.startsWith('node_modules/') && !entry.dev && entry.version)
    .map(([path, entry]) => `${path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)}@${entry.version}`)
  if (closure.length > 0) run('npm', ['cache', 'add', ...closure])

  run('npm', ['install', tarballPath, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], {
    cwd: tempRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  writeFileSync(join(tempRoot, 'smoke.mjs'), `
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  bundledReadinessProtocols,
  scanDisclosureContent,
  validateAtelierExportDryRun,
  validateAuthoringProviderDescriptor,
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
assert.equal(validateAuthoringProviderDescriptor({
  schema: 'atelier-authoring-provider@v1',
  providerId: 'synthetic-provider',
  peerId: 'peer:synthetic:publication',
  operations: ['getContext', 'submitDraft'],
  sourceRepositoryRequired: false,
  directWrite: false,
  applyEndpoint: null,
}).ok, true)
assert.equal(typeof scanDisclosureContent, 'function')
`)

  run(process.execPath, ['smoke.mjs'], { cwd: tempRoot, stdio: 'inherit' })
  const cliOutput = run(process.execPath, [
    'node_modules/.bin/atelier',
    'dry-run',
    'node_modules/@mnstry/atelier/fixtures/atelier-export/sample-studio-offer.v1.json',
  ], { cwd: tempRoot })
  const cliReport = JSON.parse(cliOutput)
  if (cliReport.accepted !== true) throw new Error('atelier dry-run did not accept the sample fixture')

  if (existsSync(join(tempRoot, 'node_modules', '.bin', 'mnstry'))) {
    throw new Error('install must not create a bare mnstry command')
  }

  const directCliOutput = run(process.execPath, ['node_modules/.bin/atelier', '--version'], { cwd: tempRoot })
  if (directCliOutput.trim() !== expectedVersion) {
    throw new Error(`atelier --version returned ${directCliOutput.trim()}`)
  }

  const legacyCliOutput = run(process.execPath, ['node_modules/.bin/mnstry-atelier', '--version'], { cwd: tempRoot })
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

  console.log('[consumer:smoke] packed tarball installs and validates in a clean temp project')
} finally {
  if (tarballPath) rmSync(tarballPath, { force: true })
  rmSync(tempRoot, { recursive: true, force: true })
}
