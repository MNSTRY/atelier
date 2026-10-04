#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyInstalledReview } from './review-consumer-smoke.mjs'
import { verifyInstalledCoauthor } from './coauthor-consumer-smoke.mjs'
import { verifyInstalledUpgrade } from './upgrade-consumer-smoke.mjs'
import { verifyInstalledCapabilities } from './capability-consumer-smoke.mjs'
import { verifyInstalledInquiry } from './inquiry-consumer-smoke.mjs'
import { verifyInstalledKnowledgeIngestion } from './knowledge-ingestion-consumer-smoke.mjs'
import { verifyInstalledResponsibilities } from './responsibility-consumer-smoke.mjs'
import { verifyInstalledLearning } from './learning-consumer-smoke.mjs'
import { verifyInstalledTemplates } from './template-consumer-smoke.mjs'
import { execNpmSync } from './npm-cli.mjs'
import {
  CONSUMER_CLOSURE_INCOMPLETE,
  OVERRIDE_NOT_INHERITED,
  capturedClosure,
  classifyNpmFailure,
  npmTreeLines,
  overrideFindings,
} from './consumer-closure-diagnostics.mjs'
import { AtelierDiagnosticError } from '../src/project/config.mjs'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const packageName = packageJson.name
const expectedVersion = packageJson.version
const expectedTarballName = `${packageName.replace(/^@/, '').replace('/', '-')}-${expectedVersion}.tgz`
const tempRoot = mkdtempSync(join(tmpdir(), 'mnstry-atelier-consumer-'))
const capturedClosureRequested = process.argv.includes('--captured-closure') || process.env.ATELIER_CONSUMER_CLOSURE === '1'
const bareConsumerPackage = `${JSON.stringify({ name: 'atelier-bare-consumer', private: true, type: 'module' }, null, 2)}\n`
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
    ...(options.env ? { env: options.env } : {}),
  })
}

// npm's ENOTCACHED becomes a typed consumer-closure-incomplete diagnostic; any
// other npm failure is rethrown unchanged.
function runOfflineNpm(args, options, { phase, hint }) {
  try {
    return runNpm(args, options)
  } catch (error) {
    const finding = classifyNpmFailure(error?.stderr)
    if (finding === null) throw error
    const missing = finding.package ? `${finding.package}${finding.version ? `@${finding.version}` : ''}` : 'a package'
    throw new AtelierDiagnosticError(CONSUMER_CLOSURE_INCOMPLETE,
      `${phase}: the warmed npm cache does not hold ${missing}${finding.url ? ` (${finding.url})` : ''}`,
      { hint, exitCode: 1, cause: error })
  }
}

// Only this script's two closure diagnostics are printed as `[code] message`;
// any other error, including a typed one from a verifier, keeps its crash.
const CLOSURE_CODES = new Set([CONSUMER_CLOSURE_INCOMPLETE, OVERRIDE_NOT_INHERITED])
const closureDiagnostic = (error) => error instanceof AtelierDiagnosticError && CLOSURE_CODES.has(error.code)

function printDiagnostic(error) {
  console.error(`[${error.code}] ${error.message}`)
  if (error.hint) console.error(`Next: ${error.hint}`)
}

// A bare consumer's npm: no inherited npm_config_* settings, an empty user
// config and HOME, and its own cache directory. The global npmrc and proxy
// variables such as HTTPS_PROXY still apply.
function bareNpmEnvironment(home, cache) {
  const inherited = Object.entries(process.env).filter(([name]) => !/^npm_config_/i.test(name))
  return { ...Object.fromEntries(inherited), HOME: home, USERPROFILE: home, npm_config_cache: cache, npm_config_userconfig: join(home, '.npmrc') }
}

// Opt-in (--captured-closure or ATELIER_CONSUMER_CLOSURE=1), because step (a)
// and (c) use the registry. It proves what the publisher-lock phase cannot: (a)
// a bare consumer with an empty cache resolves the tarball online by itself;
// (b) its own lockfile honours every publisher override without inheriting
// them; (c) a second empty cache is warmed only from that lockfile's registry
// tarballs; (d) `npm ci --offline` from it reproduces the same tree.
function verifyCapturedClosure() {
  const closureRoot = mkdtempSync(join(tmpdir(), 'mnstry-atelier-closure-'))
  try {
    const home = join(closureRoot, 'home')
    const consumerRoot = join(closureRoot, 'consumer')
    mkdirSync(home)
    mkdirSync(consumerRoot)
    writeFileSync(join(consumerRoot, 'package.json'), bareConsumerPackage)

    const online = bareNpmEnvironment(home, join(closureRoot, 'online-cache'))
    runNpm(['install', tarballPath, '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: consumerRoot, env: online })
    const consumerLock = JSON.parse(readFileSync(join(consumerRoot, 'package-lock.json'), 'utf8'))
    const { findings, compared } = overrideFindings({ publisherOverrides: packageJson.overrides, consumerLock })
    if (findings.length > 0) {
      const described = findings.map((finding) => `${finding.package} is pinned to ${finding.pinned} by override, but a bare consumer installs ${finding.found.map((copy) => `${copy.path}@${copy.version}`).join(', ')}`)
      throw new AtelierDiagnosticError(OVERRIDE_NOT_INHERITED, described.join('; '), {
        hint: 'npm applies overrides only in the root project, so consumers never receive them. Choose a direct dependency version that every dependent range in the closure accepts, so a consumer resolves one copy at the pinned version.',
        exitCode: 1,
      })
    }
    const { tarballs, missing } = capturedClosure(consumerLock)
    if (missing.length > 0) {
      throw new AtelierDiagnosticError(CONSUMER_CLOSURE_INCOMPLETE,
        `the consumer's own lockfile records ${missing.join(', ')} without a registry tarball and integrity`,
        { hint: 'An offline reinstall needs every registry entry locked with resolved and integrity; inspect how the consumer resolved these entries.', exitCode: 1 })
    }
    const onlineTree = JSON.parse(runNpm(['ls', '--all', '--json'], { cwd: consumerRoot, env: online }))
    if (onlineTree.problems?.length) throw new Error(`online bare consumer dependency closure is invalid: ${onlineTree.problems.join('; ')}`)

    const offline = bareNpmEnvironment(home, join(closureRoot, 'offline-cache'))
    if (tarballs.length > 0) runNpm(['cache', 'add', ...tarballs.map((tarball) => tarball.resolved)], { cwd: consumerRoot, env: offline })
    rmSync(join(consumerRoot, 'node_modules'), { recursive: true, force: true })
    runOfflineNpm(['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: consumerRoot, env: offline }, {
      phase: 'offline reinstall from the consumer\'s own lockfile',
      hint: 'The cache was warmed only from the captured lockfile, so it omits a package npm still requested; compare the captured package-lock.json with npm ls --all in the consumer.',
    })
    const offlineTree = JSON.parse(runNpm(['ls', '--all', '--json'], { cwd: consumerRoot, env: offline }))
    if (offlineTree.problems?.length) throw new Error(`offline reinstall dependency closure is invalid: ${offlineTree.problems.join('; ')}`)
    const expected = npmTreeLines(onlineTree)
    const actual = npmTreeLines(offlineTree)
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      const onlyOnline = expected.filter((line) => !actual.includes(line))
      const onlyOffline = actual.filter((line) => !expected.includes(line))
      throw new Error(`offline reinstall tree differs from the online install: only online [${onlyOnline.join(', ')}], only offline [${onlyOffline.join(', ')}]`)
    }
    console.log(`[consumer:closure] a bare consumer resolved the tarball online, honoured ${compared.length} installed publisher override(s) without inheriting them, and reinstalled the same ${actual.length}-package tree offline from its own lockfile (${tarballs.length} registry tarballs)`)
  } finally {
    rmSync(closureRoot, { recursive: true, force: true })
  }
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

  writeFileSync(join(tempRoot, 'package.json'), bareConsumerPackage)

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

  try {
    runOfflineNpm(['install', tarballPath, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], {
      cwd: tempRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    }, {
      phase: 'offline install from the publisher lockfile closure',
      hint: 'npm overrides do not reach consumers, so a bare consumer can resolve a version the publisher lockfile never recorded. Rerun with --captured-closure and network access: that phase still runs after this failure and checks the consumer\'s own tree.',
    })
  } catch (error) {
    // The captured-closure phase is what can explain this failure, so when it
    // was requested it still runs; the smoke fails either way.
    if (!capturedClosureRequested || !closureDiagnostic(error) || error.code !== CONSUMER_CLOSURE_INCOMPLETE) throw error
    try {
      verifyCapturedClosure()
    } catch (capturedError) {
      printDiagnostic(error)
      throw capturedError
    }
    throw error
  }

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
import {
  enrollRepository,
  planUserConfirmedCommit,
  runtimeStatus,
} from '@mnstry/atelier/runtime'
import {
  observeRepository,
  validateRepositoryObservation,
} from '@mnstry/atelier/runtime/observation'

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
assert.equal(typeof enrollRepository, 'function')
assert.equal(typeof planUserConfirmedCommit, 'function')
assert.equal(typeof runtimeStatus, 'function')
assert.equal(typeof observeRepository, 'function')
assert.equal(typeof validateRepositoryObservation, 'function')
`)

  run(process.execPath, ['smoke.mjs'], { cwd: tempRoot, stdio: 'inherit' })
  // A bare consumer resolves the declarations beside the exported .mjs.
  // Unsupported question kinds must fail compilation; a missing declaration
  // cannot turn the API into any and silently pass this check.
  writeFileSync(join(tempRoot, 'decisions-consumer.mts'), `
import { decisionRequestDigest, validateDecisionRequest, validateDecisionResult, validateDecisionAnswers } from '@mnstry/atelier/decisions'
import type { DecisionRequest, DecisionResult, DecisionQuestion } from '@mnstry/atelier/decisions'
const request: DecisionRequest = {
  schema: 'atelier-decision-request@v1', id: 'sample-decision', task: 'sample-priority',
  rubricVersion: '1', scope: { workspaceId: 'sample-workspace', authorizationRef: 'sample-scope' },
  state: 'The invented workshop note contains a materials list.',
  evidence: [{ id: 'note', sourceRef: 'sample-note:1' }],
  questions: { useful: { type: 'boolean', instructions: 'Does the note list materials?',
    criteria: { true: 'Materials are listed.', false: 'Materials are absent.' }, evidenceIds: ['note'] } },
}
const result: DecisionResult = {
  schema: 'atelier-decision-result@v1', requestId: request.id, requestDigest: decisionRequestDigest(request),
  task: request.task, rubricVersion: request.rubricVersion, scope: request.scope,
  provider: { id: 'synthetic', model: 'fixture-v1' }, authority: 'proposal-only', mode: 'shadow',
  status: 'assessed', answers: { useful: { type: 'boolean', probability: 0.8 } }, usage: null, elapsedMs: 0,
}
const unsupported: DecisionQuestion = {
  // @ts-expect-error free-form generation is outside this decision contract
  type: 'prose', instructions: 'Write a paragraph.', criteria: { true: 'Yes', false: 'No' }, evidenceIds: ['note'],
}
void unsupported
if (!validateDecisionRequest(request).ok || !validateDecisionResult(request, result).ok) throw new Error('decision consumer refused')
if (!validateDecisionAnswers(request.questions, result.answers).ok) throw new Error('transient answer consumer refused')
`)
  run(process.execPath, [join(packageRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    '--outDir', 'compiled', 'decisions-consumer.mts'], { cwd: tempRoot, stdio: 'inherit' })
  run(process.execPath, [join('compiled', 'decisions-consumer.mjs')], { cwd: tempRoot, stdio: 'inherit' })
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
    atelierCli,
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

  await verifyInstalledReview({installedRoot:join(tempRoot,'node_modules/@mnstry/atelier'),consumerRoot:tempRoot})
  await verifyInstalledCoauthor({installedRoot:join(tempRoot,'node_modules/@mnstry/atelier'),consumerRoot:tempRoot})
  verifyInstalledUpgrade({ installedRoot: join(tempRoot, 'node_modules', '@mnstry', 'atelier'), consumerRoot: tempRoot })
  await verifyInstalledCapabilities({ installedRoot: join(tempRoot, 'node_modules', '@mnstry', 'atelier'), consumerRoot: tempRoot })
  await verifyInstalledInquiry({ installedRoot: join(tempRoot, 'node_modules', '@mnstry', 'atelier'), consumerRoot: tempRoot })
  await verifyInstalledLearning({ installedRoot: join(tempRoot, 'node_modules', '@mnstry', 'atelier'), consumerRoot: tempRoot })
  await verifyInstalledResponsibilities({ installedRoot: join(tempRoot, 'node_modules', '@mnstry', 'atelier'), consumerRoot: tempRoot })
  await verifyInstalledKnowledgeIngestion({ installedRoot: join(tempRoot, 'node_modules', '@mnstry', 'atelier'), consumerRoot: tempRoot })
  verifyInstalledTemplates({ installedRoot: join(tempRoot, 'node_modules', '@mnstry', 'atelier'), consumerRoot: tempRoot })

  // Exercise the actual launch config with root and parent-hoisted installs.
  for (const target of [join(tempRoot, 'nested', 'workspace'), tempRoot]) {
    run(process.execPath, [join(tempRoot, atelierCli), 'init', '--template', 'sample-workspace', '--target', target], { cwd: tempRoot })
    for (const command of ['graph', 'project']) {
      run(process.execPath, [join(tempRoot, atelierCli), command], { cwd: target })
    }
    const launch = JSON.parse(readFileSync(join(target, '.claude', 'launch.json'), 'utf8')).configurations[0]
    if (launch.runtimeExecutable !== 'node') throw new Error('preview must use Node package resolution')
    const smoke = run(process.execPath, [...launch.runtimeArgs, '--', '--smoke'], { cwd: target })
    if (!smoke.includes('[atelier:browser:smoke]')) throw new Error('installed preview health/projection smoke failed')
  }
  console.log('[consumer:preview] root and nested workspace launch configs served health and projection')

  console.log(`[consumer:smoke] SHA-256 ${tarballSha256}; packed tarball installs without publisher overrides and imports ${Object.keys(packageJson.exports).length} declared exports`)

  if (capturedClosureRequested) verifyCapturedClosure()
} catch (error) {
  if (!closureDiagnostic(error) || process.env.ATELIER_DEBUG === '1') throw error
  printDiagnostic(error)
  process.exitCode = error.exitCode
} finally {
  if (tarballPath && ownsTarball) rmSync(tarballPath, { force: true })
  rmSync(tempRoot, { recursive: true, force: true })
}
