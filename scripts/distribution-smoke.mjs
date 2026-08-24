#!/usr/bin/env node

// Proves the white-label distribution surface end to end: a packed tarball, a
// consumer that installs the reference distribution from disk, and the branded
// bin resolving @mnstry/atelier/cli through an ordinary dependency edge. The
// consumer root holds the wrapper copy so Node's ancestor resolution reaches
// the installed root package from the wrapper's real path.
//
// Mirrors scripts/consumer-smoke.mjs: mkdtemp, npm pack, offline install,
// assert, clean up in finally.

import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execNpmSync } from './npm-cli.mjs'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const packageName = packageJson.name
const expectedVersion = packageJson.version
const examplePath = join(packageRoot, 'examples', 'loomworks-studio')
const exampleVersion = JSON.parse(readFileSync(join(examplePath, 'package.json'), 'utf8')).version
const ATTRIBUTION = 'powered by MNSTRY Atelier'

const tempRoot = mkdtempSync(join(tmpdir(), 'mnstry-atelier-distribution-'))
const wrapperRoot = join(tempRoot, 'loomworks-studio')
let tarballPath

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

// Non-zero exits are a smoke failure, so surface the child's own output rather
// than execFileSync's generic message.
function runChecked(command, args, options = {}) {
  try {
    return run(command, args, options)
  } catch (error) {
    const detail = [error.stdout, error.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${command} ${args.join(' ')} failed (status ${error.status})\n${detail}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

try {
  const pack = JSON.parse(runNpm(['pack', '--json']))[0]
  tarballPath = join(packageRoot, pack.filename)

  cpSync(examplePath, wrapperRoot, {
    recursive: true,
    filter: (source) => !source.split(sep).includes('node_modules'),
  })

  // The published form of this wrapper depends on a released version; the
  // smoke rewrites the file: dev edge to the tarball actually under test.
  const wrapperManifestPath = join(wrapperRoot, 'package.json')
  const wrapperManifest = JSON.parse(readFileSync(wrapperManifestPath, 'utf8'))
  assert(
    wrapperManifest.dependencies?.[packageName],
    `${examplePath}/package.json must depend on ${packageName}`,
  )
  wrapperManifest.dependencies[packageName] = tarballPath
  writeFileSync(wrapperManifestPath, `${JSON.stringify(wrapperManifest, null, 2)}\n`)

  writeFileSync(join(tempRoot, 'package.json'), `${JSON.stringify({
    name: 'loomworks-consumer',
    private: true,
    type: 'module',
    dependencies: { 'loomworks-studio': 'file:./loomworks-studio' },
  }, null, 2)}\n`)

  runNpm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], {
    cwd: tempRoot,
  })

  const loomworks = join(tempRoot, 'node_modules', 'loomworks-studio', 'bin', 'loomworks.mjs')
  const atelier = join(tempRoot, 'node_modules', '@mnstry', 'atelier', 'bin', 'atelier.mjs')

  const versionOutput = runChecked(process.execPath, [loomworks, '--version'], { cwd: tempRoot }).trim()
  assert(
    versionOutput.startsWith(`Loomworks Studio ${exampleVersion}`),
    `loomworks --version must lead with the wrapper name and version, got: ${versionOutput}`,
  )
  assert(
    versionOutput.includes(`${ATTRIBUTION} ${expectedVersion}`),
    `loomworks --version must carry "${ATTRIBUTION} ${expectedVersion}", got: ${versionOutput}`,
  )

  const helpLines = runChecked(process.execPath, [loomworks, '--help'], { cwd: tempRoot }).split('\n')
  assert(helpLines[0] === 'Loomworks Studio', `branded help must open with the display name, got: ${helpLines[0]}`)
  assert(helpLines[1] === `${ATTRIBUTION} ${expectedVersion}`, `branded help line 2 must be the attribution, got: ${helpLines[1]}`)
  assert(helpLines.includes('  loomworks <command> [args]'), 'branded help must show the wrapper usage line')
  assert(!helpLines.some((line) => line.includes('mnstry-atelier <command>')), 'branded help must drop the root alias lines')

  // The wrapper dispatches root subcommands unchanged: same loader, same
  // fail-closed rules, no distribution-specific path.
  const wrapperValidate = runChecked(process.execPath, [loomworks, 'extension-pack', 'validate', '--project', join(wrapperRoot, 'atelier.project.json')], { cwd: tempRoot })
  assert(
    /loomworks\.readiness ok \(v1, 2 protocols, [a-z]+\)/.test(wrapperValidate),
    `loomworks extension-pack validate must load the branded pack, got: ${wrapperValidate.trim()}`,
  )

  const rootValidate = runChecked(process.execPath, [atelier, 'extension-pack', 'validate', '--json', '--project', join(wrapperRoot, 'atelier.project.json')], { cwd: tempRoot })
  const report = JSON.parse(rootValidate)
  assert(report.ok === true, 'atelier extension-pack validate must report ok for the example workspace')
  assert(report.packs[0]?.id === 'loomworks.readiness', 'the example workspace must declare the loomworks.readiness pack')
  assert(report.packs[0]?.protocolCount === 2, 'the branded pack must contribute two protocols')

  const check = runChecked(process.execPath, [loomworks, 'distribution', 'check', '--target', wrapperRoot], { cwd: tempRoot })
  assert(check.includes('required README.md attribution present'), 'distribution check must confirm the README attribution')
  assert(
    check.includes('declares ext["mnstry.atelier/attribution"] — satisfied'),
    'distribution check must report the advisory pack-manifest marker as satisfied',
  )

  console.log('[distribution:smoke] the reference distribution installs, brands, loads its pack, and passes attribution checks')
} finally {
  if (tarballPath) rmSync(tarballPath, { force: true })
  rmSync(tempRoot, { recursive: true, force: true })
}
