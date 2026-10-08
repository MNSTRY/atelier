import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  CONSUMER_CLOSURE_INCOMPLETE,
  OVERRIDE_NOT_INHERITED,
  capturedClosure,
  classifyNpmFailure,
  npmTreeLines,
  overrideFindings,
} from '../scripts/consumer-closure-diagnostics.mjs'

// Recorded: the stderr of the offline `npm install <tarball>` in
// consumer-smoke on PR #89 (Dependabot, fast-uri 3.1.7 -> 4.2.1), identical in
// all five failed CI jobs and in a local cold-cache reproduction.
const PR89_STDERR = [
  'npm error code ENOTCACHED',
  "npm error request to https://registry.npmjs.org/fast-uri/-/fast-uri-3.1.8.tgz failed: cache mode is 'only-if-cached' but no cached response is available.",
  '',
].join('\n')

// Reduced from a recorded lockfile: the package-lock.json that a fresh bare
// consumer (named bare-consumer in that run) wrote when it installed the
// fast-uri 3.1.8 candidate tarball online. Each entry keeps only its version,
// resolved URL and integrity as recorded; other fields npm writes are dropped,
// and the candidate's own local `file:` path is shortened.
const registry = (name, version, integrity) => ({
  version,
  resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`,
  integrity,
})
const CANDIDATE_LOCK = {
  name: 'bare-consumer',
  version: '1.0.0',
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': { name: 'bare-consumer', version: '1.0.0', dependencies: { '@mnstry/atelier': 'file:mnstry-atelier-0.2.0-alpha.12.tgz' } },
    'node_modules/@mnstry/atelier': {
      version: '0.2.0-alpha.12',
      resolved: 'file:mnstry-atelier-0.2.0-alpha.12.tgz',
      integrity: 'sha512-pa/lKVFEfLUHs0JhcWOa9E8rtU2mjLjcOkrT+8ij/NGq0FszEKXWw4p8EoEBr/tfa5M7ahQFav9A4tDL7QnqKg==',
    },
    'node_modules/ajv': registry('ajv', '8.20.0', 'sha512-Thbli+OlOj+iMPYFBVBfJ3OmCAnaSyNn4M1vz9T6Gka5Jt9ba/HIR56joy65tY6kx/FCF5VXNB819Y7/GUrBGA=='),
    'node_modules/ajv-formats': registry('ajv-formats', '3.0.1', 'sha512-8iUql50EUR+uUcdRQ3HDqa6EVyo3docL8g5WJ3FNcWmu62IbkGUue/pEyLBW8VGKKucTPgqeks4fIU1DA4yowQ=='),
    'node_modules/fast-deep-equal': registry('fast-deep-equal', '3.1.3', 'sha512-f3qQ9oQy9j2AhBe/H9VC91wLmKBCCU/gDOnKNAYG5hswO7BLKj09Hc5HYNz9cGI++xlpDCIgDaitVs03ATR84Q=='),
    'node_modules/fast-uri': registry('fast-uri', '3.1.8', 'sha512-GZMtZUTNRpOVIECoXwLNZS5xUGE+mVNbTB8h/7Rwh2TFWcBQiPzTgyZi05BF9UMZKkLJv8XBRJTlU7zg8+ZfMg=='),
    'node_modules/json-schema-traverse': registry('json-schema-traverse', '1.0.0', 'sha512-NM8/P9n3XjXhIZn1lLhkFaACTOURQXjWhV4BA/RnOv8xvgqtqpAX9IO4mRQxSx1Rlo4tqzeqb0sOlruaOy3dug=='),
    'node_modules/require-from-string': registry('require-from-string', '2.0.2', 'sha512-Xf0nWe6RseziFMu+Ap9biiUbmplq6S9/p+7w7YXP/JBHhrUDDUhwa+vANyubuqfZWTveU//DYVGsDG7RKL/vEw=='),
  },
}

// Synthetic, shaped by PR #89: the publisher pins fast-uri 4.2.1 directly and
// by override, but a consumer's ajv 8.20.0 still needs fast-uri ^3.0.1, so the
// consumer gets a second, nested 3.x copy the publisher never tested.
function pr89ShapedLock() {
  const lock = structuredClone(CANDIDATE_LOCK)
  lock.packages['node_modules/fast-uri'] = registry('fast-uri', '4.2.1', 'sha512-synthetic-top-level')
  lock.packages['node_modules/ajv/node_modules/fast-uri'] = registry('fast-uri', '3.1.8', 'sha512-synthetic-nested')
  return lock
}

test('the recorded PR #89 ENOTCACHED stderr is a typed incomplete closure naming fast-uri 3.1.8', () => {
  assert.deepEqual(classifyNpmFailure(PR89_STDERR), {
    code: CONSUMER_CLOSURE_INCOMPLETE,
    package: 'fast-uri',
    version: '3.1.8',
    url: 'https://registry.npmjs.org/fast-uri/-/fast-uri-3.1.8.tgz',
  })
  assert.equal(CONSUMER_CLOSURE_INCOMPLETE, 'consumer-closure-incomplete')
})

test('only ENOTCACHED is classified; other npm failures keep their own error', () => {
  for (const stderr of [
    '',
    undefined,
    'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/fast-uri/-/fast-uri-9.9.9.tgz\n',
    'npm error code ETARGET\nnpm error notarget No matching version found for fast-uri@^9.0.0.\n',
    // The phrase alone, outside npm's code line, is not a classification.
    "request to https://registry.npmjs.org/fast-uri/-/fast-uri-3.1.8.tgz failed: cache mode is 'only-if-cached'\n",
  ]) {
    assert.equal(classifyNpmFailure(stderr), null, String(stderr))
  }
})

test('the requested package is read from scoped tarball and packument URLs (synthetic)', () => {
  const scoped = classifyNpmFailure('npm error code ENOTCACHED\nnpm error request to https://registry.npmjs.org/@scope/name/-/name-1.2.3-rc.1.tgz failed: cache mode\n')
  assert.equal(scoped.package, '@scope/name')
  assert.equal(scoped.version, '1.2.3-rc.1')
  const packument = classifyNpmFailure('npm error code ENOTCACHED\nnpm error request to https://registry.npmjs.org/@scope%2fname failed: cache mode\n')
  assert.equal(packument.package, '@scope/name')
  assert.equal(packument.version, null)
  const older = classifyNpmFailure('npm ERR! code ENOTCACHED\nnpm ERR! request to https://registry.npmjs.org/ajv failed: cache mode\n')
  assert.deepEqual([older.package, older.version], ['ajv', null])
  // npm colours its prefix on a terminal, and Windows output ends lines with CRLF.
  const coloured = classifyNpmFailure(PR89_STDERR.replaceAll('npm error', '\u001b[31mnpm error\u001b[39m').replaceAll('\n', '\r\n'))
  assert.deepEqual([coloured.package, coloured.version], ['fast-uri', '3.1.8'])
  const bare = classifyNpmFailure('npm error code ENOTCACHED\n')
  assert.deepEqual({ ...bare }, { code: CONSUMER_CLOSURE_INCOMPLETE, package: null, version: null, url: null })
})

test('the recorded candidate consumer lock honours the fast-uri 3.1.8 override with one copy', () => {
  assert.deepEqual(overrideFindings({ publisherOverrides: { 'fast-uri': '3.1.8' }, consumerLock: CANDIDATE_LOCK }), { findings: [], compared: ['fast-uri'] })
})

test('a PR #89-shaped consumer lock is a typed override-not-inherited finding naming both copies', () => {
  assert.deepEqual(overrideFindings({ publisherOverrides: { 'fast-uri': '4.2.1' }, consumerLock: pr89ShapedLock() }).findings, [{
    code: OVERRIDE_NOT_INHERITED,
    package: 'fast-uri',
    pinned: '4.2.1',
    found: [
      { path: 'node_modules/ajv/node_modules/fast-uri', version: '3.1.8' },
      { path: 'node_modules/fast-uri', version: '4.2.1' },
    ],
  }])
  assert.equal(OVERRIDE_NOT_INHERITED, 'override-not-inherited')
})

test('one copy at a version other than the pin is also not inherited', () => {
  const lock = structuredClone(CANDIDATE_LOCK)
  lock.packages['node_modules/fast-uri'].version = '3.1.7'
  const [finding] = overrideFindings({ publisherOverrides: { 'fast-uri': '3.1.8' }, consumerLock: lock }).findings
  assert.deepEqual(finding.found, [{ path: 'node_modules/fast-uri', version: '3.1.7' }])
})

test('two copies at the pinned version are still a finding', () => {
  const lock = structuredClone(CANDIDATE_LOCK)
  lock.packages['node_modules/ajv/node_modules/fast-uri'] = registry('fast-uri', '3.1.8', 'sha512-synthetic-nested')
  const [finding] = overrideFindings({ publisherOverrides: { 'fast-uri': '3.1.8' }, consumerLock: lock }).findings
  assert.deepEqual(finding.found.map((copy) => copy.path), ['node_modules/ajv/node_modules/fast-uri', 'node_modules/fast-uri'])
})

test('a copy is named by npm, not by the last path segment (synthetic)', () => {
  // A scoped package with the same basename is not a copy of fast-uri.
  const scoped = structuredClone(CANDIDATE_LOCK)
  scoped.packages['node_modules/@other/fast-uri'] = registry('@other/fast-uri', '1.0.0', 'sha512-synthetic-scoped')
  assert.deepEqual(overrideFindings({ publisherOverrides: { 'fast-uri': '3.1.8' }, consumerLock: scoped }).findings, [])
  // An npm: alias installs fast-uri under another path; the entry's name says so.
  const aliased = structuredClone(CANDIDATE_LOCK)
  aliased.packages['node_modules/fast-uri-v4'] = { name: 'fast-uri', ...registry('fast-uri', '4.2.1', 'sha512-synthetic-alias') }
  const [finding] = overrideFindings({ publisherOverrides: { 'fast-uri': '3.1.8' }, consumerLock: aliased }).findings
  assert.deepEqual(finding.found, [
    { path: 'node_modules/fast-uri', version: '3.1.8' },
    { path: 'node_modules/fast-uri-v4', version: '4.2.1' },
  ])
  // A workspace link is not an installed copy.
  const linked = structuredClone(CANDIDATE_LOCK)
  linked.packages['node_modules/ajv/node_modules/fast-uri'] = { resolved: 'packages/fast-uri', link: true }
  assert.deepEqual(overrideFindings({ publisherOverrides: { 'fast-uri': '3.1.8' }, consumerLock: linked }).findings, [])
})

test('an override the consumer does not install has nothing to inherit and is not counted as compared', () => {
  assert.deepEqual(overrideFindings({ publisherOverrides: { 'left-pad': '1.3.0' }, consumerLock: CANDIDATE_LOCK }), { findings: [], compared: [] })
  assert.deepEqual(overrideFindings({ publisherOverrides: { 'left-pad': '1.3.0', 'fast-uri': '3.1.8' }, consumerLock: CANDIDATE_LOCK }).compared, ['fast-uri'])
  assert.deepEqual(overrideFindings({ publisherOverrides: undefined, consumerLock: CANDIDATE_LOCK }), { findings: [], compared: [] })
})

test('overrides that are not exact versions, and lockfiles without a packages map, are refused', () => {
  for (const spec of ['^3.1.8', '>=3.1.8', '$fast-uri', { '.': '3.1.8' }, '']) {
    assert.throws(() => overrideFindings({ publisherOverrides: { 'fast-uri': spec }, consumerLock: CANDIDATE_LOCK }), /exact version/)
  }
  // A version-selector key applies only to some versions, so it is not an unconditional pin.
  for (const key of ['fast-uri@^3', 'fast-uri@3.1.8', '@scope/name@1']) {
    assert.throws(() => overrideFindings({ publisherOverrides: { [key]: '3.1.8' }, consumerLock: CANDIDATE_LOCK }), /selects versions/)
  }
  assert.deepEqual(overrideFindings({ publisherOverrides: { '@scope/name': '1.0.0' }, consumerLock: CANDIDATE_LOCK }).findings, [])
  for (const consumerLock of [undefined, { lockfileVersion: 1, dependencies: {} }, { packages: null }]) {
    assert.throws(() => overrideFindings({ publisherOverrides: { 'fast-uri': '3.1.8' }, consumerLock }), /packages map/)
  }
})

test('the recorded candidate lock gives six registry tarballs and leaves the local candidate out', () => {
  const closure = capturedClosure(CANDIDATE_LOCK)
  assert.deepEqual(closure.missing, [])
  assert.deepEqual(closure.tarballs.map((tarball) => tarball.path), [
    'node_modules/ajv',
    'node_modules/ajv-formats',
    'node_modules/fast-deep-equal',
    'node_modules/fast-uri',
    'node_modules/json-schema-traverse',
    'node_modules/require-from-string',
  ])
  assert.equal(closure.tarballs[3].resolved, 'https://registry.npmjs.org/fast-uri/-/fast-uri-3.1.8.tgz')
  assert.match(closure.tarballs[3].integrity, /^sha512-GZMtZU/)
})

test('a registry entry without resolved or integrity cannot be reinstalled offline; links and bundles are skipped', () => {
  const lock = structuredClone(CANDIDATE_LOCK)
  delete lock.packages['node_modules/fast-uri'].integrity
  delete lock.packages['node_modules/ajv'].resolved
  lock.packages['node_modules/linked'] = { resolved: 'packages/linked', link: true }
  lock.packages['node_modules/ajv/node_modules/bundled'] = { version: '1.0.0', inBundle: true }
  const closure = capturedClosure(lock)
  assert.deepEqual(closure.missing, ['node_modules/ajv', 'node_modules/fast-uri'])
  assert.equal(closure.tarballs.length, 4)
})

test('installed trees compare by ancestry and version', () => {
  // Synthetic `npm ls --all --json`, shaped by the recorded candidate tree:
  // ajv's fast-uri dedupes to the one top-level copy.
  const candidate = {
    name: 'atelier-bare-consumer',
    dependencies: {
      '@mnstry/atelier': {
        version: '0.2.0-alpha.12',
        dependencies: {
          ajv: { version: '8.20.0', dependencies: { 'fast-uri': { version: '3.1.8' } } },
          'fast-uri': { version: '3.1.8' },
        },
      },
    },
  }
  assert.deepEqual(npmTreeLines(candidate), [
    '@mnstry/atelier@0.2.0-alpha.12',
    '@mnstry/atelier@0.2.0-alpha.12 > ajv@8.20.0',
    '@mnstry/atelier@0.2.0-alpha.12 > ajv@8.20.0 > fast-uri@3.1.8',
    '@mnstry/atelier@0.2.0-alpha.12 > fast-uri@3.1.8',
  ])
  assert.deepEqual(npmTreeLines(structuredClone(candidate)), npmTreeLines(candidate))
  const drifted = structuredClone(candidate)
  drifted.dependencies['@mnstry/atelier'].dependencies.ajv.dependencies['fast-uri'].version = '3.1.7'
  assert.notDeepEqual(npmTreeLines(drifted), npmTreeLines(candidate))
  assert.deepEqual(npmTreeLines({}), [])
})

test('consumer-smoke keeps the default publisher-lock install and gates the captured closure behind opt-in', () => {
  const source = readFileSync(new URL('../scripts/consumer-smoke.mjs', import.meta.url), 'utf8')
  assert.ok(source.includes("['install', tarballPath, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false']"))
  assert.ok(source.includes("runNpm(['cache', 'add', ...closure])"))
  assert.match(source, /process\.argv\.includes\('--captured-closure'\) \|\| process\.env\.ATELIER_CONSUMER_CLOSURE === '1'/)
  // Source-only: the opt-in phase after a successful default phase needs a real
  // install to reach, so no synthetic test executes this call.
  assert.ok(source.includes('if (capturedClosureRequested) verifyCapturedClosure()'))
})

// consumer-smoke resolves npm from npm_execpath. A synthetic npm drives the real
// script with no registry and no real install. It follows a scenario: the
// publisher-lock offline install fails with recorded stderr, the captured
// phase's online install writes the scenario's consumer lockfile, `ls` returns
// the scenario's tree, and `cache add` succeeds. Every call is logged with the
// environment it saw. The phase is read from the cache directory the script
// set. TMPDIR is the test's own, so leftover temporary directories are visible.
const SYNTHETIC_NPM = `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const scenario = JSON.parse(readFileSync(process.env.SYNTHETIC_NPM_SCENARIO, 'utf8'))
const cache = process.env.npm_config_cache ?? null
const phase = cache?.endsWith('offline-cache') ? 'offline' : cache?.endsWith('online-cache') ? 'online' : 'publisher'
appendFileSync(process.env.SYNTHETIC_NPM_LOG, JSON.stringify({ args, phase, cwd: process.cwd(), home: process.env.HOME ?? null, cache,
  userconfig: process.env.npm_config_userconfig ?? null, registry: process.env.npm_config_registry ?? null, nodeModules: existsSync('node_modules') }) + '\\n')
const fail = (step) => { process.stderr.write(step.stderr); process.exit(1) }
const [command] = args
if (command === 'cache') process.exit(0)
if (command === 'install' && phase === 'publisher') fail(scenario.publisherInstall)
if (command === 'install' && phase === 'online') { writeFileSync('package-lock.json', JSON.stringify(scenario.consumerLock)); mkdirSync('node_modules'); process.exit(0) }
if (command === 'ls') { process.stdout.write(JSON.stringify(scenario.trees[phase])); process.exit(0) }
if (command === 'ci' && phase === 'offline') { if (scenario.ci) fail(scenario.ci); mkdirSync('node_modules'); process.exit(0) }
process.stderr.write('unexpected synthetic npm call ' + args.join(' ') + '\\n')
process.exit(1)
`
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

// `combined` sends stdout and stderr to one file, so their order is observable.
function runSmoke(t, scenario, { capturedClosure = false, combined = false, env = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'atelier-closure-diagnostic-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const temporary = join(root, 'tmp')
  mkdirSync(temporary)
  const tarball = join(root, `${packageJson.name.replace(/^@/, '').replace('/', '-')}-${packageJson.version}.tgz`)
  writeFileSync(tarball, 'synthetic tarball, never installed\n')
  writeFileSync(join(root, 'npm-cli.mjs'), SYNTHETIC_NPM)
  writeFileSync(join(root, 'scenario.json'), JSON.stringify(scenario))
  writeFileSync(join(root, 'calls.jsonl'), '')
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(npm_|ATELIER_)/i.test(name)))
  const output = combined ? openSync(join(root, 'combined.txt'), 'w') : null
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/consumer-smoke.mjs', import.meta.url)), ...(capturedClosure ? ['--captured-closure'] : [])], {
    ...(combined ? { stdio: ['ignore', output, output] } : {}),
    env: {
      ...environment,
      npm_execpath: join(root, 'npm-cli.mjs'),
      // An inherited npm setting the bare consumer must not see.
      npm_config_registry: 'https://registry.invalid/',
      ATELIER_CANDIDATE_TARBALL: tarball,
      SYNTHETIC_NPM_SCENARIO: join(root, 'scenario.json'),
      SYNTHETIC_NPM_LOG: join(root, 'calls.jsonl'),
      // os.tmpdir() reads TMPDIR on POSIX and TEMP/TMP on Windows.
      TMPDIR: temporary,
      TEMP: temporary,
      TMP: temporary,
      ...env,
    },
    encoding: 'utf8',
  })
  if (combined) closeSync(output)
  const calls = readFileSync(join(root, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  return { ...result, tarball, calls, leftovers: readdirSync(temporary), combined: combined ? readFileSync(join(root, 'combined.txt'), 'utf8') : null }
}

const PUBLISHER_DIAGNOSTIC = '[consumer-closure-incomplete] offline install from the publisher lockfile closure: the warmed npm cache does not hold fast-uri@3.1.8 (https://registry.npmjs.org/fast-uri/-/fast-uri-3.1.8.tgz)'
// Without the flag the hint offers it; with the flag it explains what follows.
function assertPublisherDiagnostic(lines, { captured = true } = {}) {
  assert.equal(lines[0], PUBLISHER_DIAGNOSTIC)
  if (captured) {
    assert.match(lines[1], /^Next: The captured-closure phase follows and checks the consumer's own tree\. If it passes, a bare consumer resolves correctly/)
    assert.doesNotMatch(lines[1], /Rerun with --captured-closure/)
  } else assert.match(lines[1], /^Next: npm overrides do not reach consumers.*Rerun with --captured-closure and network access/)
}

// The captured-phase scenarios use the publisher's actual override.
const [[OVERRIDDEN, PIN] = []] = Object.entries(packageJson.overrides ?? {})
const noOverride = OVERRIDDEN === undefined && 'the publisher has no override to check'
function consumerLockWith(copies) {
  const lock = structuredClone(CANDIDATE_LOCK)
  for (const path of Object.keys(lock.packages)) if (path.endsWith(`node_modules/${OVERRIDDEN}`)) delete lock.packages[path]
  for (const [path, version] of Object.entries(copies)) lock.packages[path] = registry(OVERRIDDEN, version, `sha512-synthetic-${version}`)
  return lock
}
const tree = (version) => ({
  name: 'atelier-bare-consumer',
  dependencies: { [packageJson.name]: { version: packageJson.version, dependencies: { ajv: { version: '8.20.0' }, [OVERRIDDEN]: { version } } } },
})
const capturedScenario = (overrides = {}) => ({
  publisherInstall: { stderr: PR89_STDERR },
  consumerLock: consumerLockWith({ [`node_modules/${OVERRIDDEN}`]: PIN }),
  trees: { online: tree(PIN), offline: tree(PIN) },
  ...overrides,
})

test('the default publisher-lock install reports the recorded #89 failure as a typed diagnostic and attempts nothing else', (t) => {
  const result = runSmoke(t, { publisherInstall: { stderr: PR89_STDERR } })
  assert.equal(result.status, 1)
  const lines = result.stderr.trim().split('\n')
  assertPublisherDiagnostic(lines, { captured: false })
  assert.equal(lines.length, 2)
  assert.deepEqual(result.calls.map((call) => [call.phase, call.args[0]]), [['publisher', 'cache'], ['publisher', 'install']])
  assert.deepEqual(result.leftovers, [])
})

test('any other install failure keeps its original error', (t) => {
  const result = runSmoke(t, { publisherInstall: { stderr: 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/fast-uri\n' } }, { capturedClosure: true })
  assert.notEqual(result.status, 0)
  assert.doesNotMatch(result.stderr, /\[consumer-closure-incomplete\]/)
  assert.match(result.stderr, /npm error code E404/)
  // Only a closure failure lets the captured phase run after the default one.
  assert.equal(result.calls.some((call) => call.phase !== 'publisher'), false)
  assert.deepEqual(result.leftovers, [])
})

test('with --captured-closure, a #89-shaped consumer tree after the publisher failure is override-not-inherited', { skip: noOverride }, (t) => {
  const result = runSmoke(t, capturedScenario({
    consumerLock: consumerLockWith({ [`node_modules/${OVERRIDDEN}`]: '0.0.0-synthetic-other', [`node_modules/ajv/node_modules/${OVERRIDDEN}`]: PIN }),
  }), { capturedClosure: true })
  assert.equal(result.status, 1)
  const lines = result.stderr.trim().split('\n')
  assertPublisherDiagnostic(lines)
  assert.equal(lines[2], `[override-not-inherited] ${OVERRIDDEN} is pinned to ${PIN} by override, but a bare consumer installs node_modules/ajv/node_modules/${OVERRIDDEN}@${PIN}, node_modules/${OVERRIDDEN}@0.0.0-synthetic-other`)
  assert.match(lines[3], /^Next: npm applies overrides only in the root project/)
  assert.equal(lines.length, 4)
  const online = result.calls.filter((call) => call.phase === 'online')
  // Online, with no --offline, from the same candidate tarball.
  assert.deepEqual(online.map((call) => call.args), [['install', result.tarball, '--ignore-scripts', '--no-audit', '--no-fund']])
  assert.equal(online[0].registry, null)
  assert.equal(online[0].userconfig, join(online[0].home, '.npmrc'))
  assert.equal(result.calls.some((call) => call.phase === 'offline'), false)
  assert.deepEqual(result.leftovers, [])
})

test('with --captured-closure, a consumer closure that reinstalls offline is reported and the smoke still fails', { skip: noOverride }, (t) => {
  const result = runSmoke(t, capturedScenario(), { capturedClosure: true })
  assert.equal(result.status, 1)
  assert.equal(result.stdout.trim(), `[consumer:closure] a bare consumer resolved the tarball online, honoured 1 installed publisher override(s) without inheriting them, and reinstalled the same 3-package tree offline from its own lockfile (6 registry tarballs)`)
  const lines = result.stderr.trim().split('\n')
  assertPublisherDiagnostic(lines)
  assert.equal(lines.length, 2)
  const captured = result.calls.filter((call) => call.phase !== 'publisher')
  assert.deepEqual(captured.map((call) => [call.phase, call.args[0]]), [['online', 'install'], ['online', 'ls'], ['offline', 'cache'], ['offline', 'ci'], ['offline', 'ls']])
  const [install, , cache, ci] = captured
  // One bare HOME and user config; separate online and offline caches; no inherited registry.
  assert.ok(captured.every((call) => call.home === install.home && call.userconfig === join(install.home, '.npmrc') && call.registry === null))
  assert.notEqual(install.cache, cache.cache)
  assert.equal(cache.cache, ci.cache)
  assert.deepEqual(cache.args.slice(1), ['add', ...capturedClosure(consumerLockWith({ [`node_modules/${OVERRIDDEN}`]: PIN })).tarballs.map((tarball) => tarball.resolved)])
  assert.equal(cache.args.length, 2 + 6)
  assert.deepEqual(ci.args, ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'])
  // node_modules from the online install is removed before the offline reinstall.
  assert.equal(ci.nodeModules, false)
  assert.deepEqual(result.leftovers, [])
})

test('with --captured-closure, the publisher diagnostic prints once and before the captured outcome', { skip: noOverride }, (t) => {
  const passed = runSmoke(t, capturedScenario(), { capturedClosure: true, combined: true })
  assert.equal(passed.status, 1)
  const lines = passed.combined.trim().split('\n')
  assertPublisherDiagnostic(lines)
  assert.match(lines[2], /^\[consumer:closure\] a bare consumer resolved the tarball online/)
  assert.equal(lines.length, 3)
  const failed = runSmoke(t, capturedScenario({ ci: { stderr: PR89_STDERR } }), { capturedClosure: true, combined: true })
  const failedLines = failed.combined.trim().split('\n')
  assertPublisherDiagnostic(failedLines)
  assert.match(failedLines[2], /^\[consumer-closure-incomplete\] offline reinstall from the consumer's own lockfile/)
  assert.equal(failedLines.filter((line) => line === PUBLISHER_DIAGNOSTIC).length, 1)
})

test('with ATELIER_DEBUG=1, the publisher diagnostic prints with npm\'s own stderr as its cause', { skip: noOverride }, (t) => {
  const result = runSmoke(t, capturedScenario(), { capturedClosure: true, combined: true, env: { ATELIER_DEBUG: '1' } })
  assert.equal(result.status, 1)
  assert.match(result.combined, /AtelierDiagnosticError: offline install from the publisher lockfile closure/)
  assert.match(result.combined, /cache mode is 'only-if-cached'/)
  assert.equal(result.combined.split('AtelierDiagnosticError: offline install').length - 1, 1)
  assert.match(result.combined, /\[consumer:closure\]/)
  assert.deepEqual(result.leftovers, [])
})

test('with --captured-closure, an override the consumer does not install is not reported as honoured', { skip: noOverride }, (t) => {
  const result = runSmoke(t, capturedScenario({ consumerLock: consumerLockWith({}), trees: { online: tree(PIN), offline: tree(PIN) } }), { capturedClosure: true })
  assert.equal(result.status, 1)
  assert.match(result.stdout, /honoured 0 installed publisher override\(s\)/)
  assert.deepEqual(result.leftovers, [])
})

test('with --captured-closure, an offline reinstall that misses the cache is a typed incomplete closure', { skip: noOverride }, (t) => {
  const result = runSmoke(t, capturedScenario({ ci: { stderr: PR89_STDERR } }), { capturedClosure: true })
  assert.equal(result.status, 1)
  const lines = result.stderr.trim().split('\n')
  assertPublisherDiagnostic(lines)
  assert.equal(lines[2], "[consumer-closure-incomplete] offline reinstall from the consumer's own lockfile: the warmed npm cache does not hold fast-uri@3.1.8 (https://registry.npmjs.org/fast-uri/-/fast-uri-3.1.8.tgz)")
  assert.match(lines[3], /^Next: The cache was warmed only from the captured lockfile/)
  assert.deepEqual(result.leftovers, [])
})

test('with --captured-closure, a captured lockfile entry without integrity is a typed incomplete closure before any reinstall', { skip: noOverride }, (t) => {
  const consumerLock = consumerLockWith({ [`node_modules/${OVERRIDDEN}`]: PIN })
  delete consumerLock.packages['node_modules/ajv'].integrity
  const result = runSmoke(t, capturedScenario({ consumerLock }), { capturedClosure: true })
  assert.equal(result.status, 1)
  const lines = result.stderr.trim().split('\n')
  assertPublisherDiagnostic(lines)
  assert.equal(lines[2], "[consumer-closure-incomplete] the consumer's own lockfile records node_modules/ajv without a registry resolved URL or integrity")
  assert.equal(result.calls.some((call) => call.phase === 'offline'), false)
  assert.deepEqual(result.leftovers, [])
})

test('with --captured-closure, a different offline tree fails with both differences named', { skip: noOverride }, (t) => {
  const result = runSmoke(t, capturedScenario({ trees: { online: tree(PIN), offline: tree('0.0.0-synthetic-other') } }), { capturedClosure: true })
  assert.notEqual(result.status, 0)
  assertPublisherDiagnostic(result.stderr.trim().split('\n'))
  assert.match(result.stderr, new RegExp(`offline reinstall tree differs from the online install: only online \\[[^\\]]*${OVERRIDDEN}@${PIN.replaceAll('.', '\\.')}\\], only offline \\[[^\\]]*${OVERRIDDEN}@0\\.0\\.0-synthetic-other\\]`))
  assert.deepEqual(result.leftovers, [])
})

// Corrections after the r10 review of the closure planner, which shares these
// classifiers. All lockfile content below is invented.
test('a project folder entry is never an installed copy, and no name is derived from its path (synthetic)', () => {
  const lock = {
    packages: {
      '': { name: 'invented-consumer' },
      // A link target with no name: its path must not be read as a package name.
      'packages/inner-dep': { version: '2.0.0' },
      // A link target that carries a name is still a folder, not a copy.
      'packages/named-dep': { name: 'named-dep', version: '2.0.0' },
      'node_modules/inner-dep': { resolved: 'packages/inner-dep', link: true },
    },
  }
  for (const name of ['er-dep', 'inner-dep', 'named-dep', 'packages/inner-dep']) {
    assert.deepEqual(overrideFindings({ publisherOverrides: { [name]: '1.0.0' }, consumerLock: lock }), { findings: [], compared: [] }, name)
  }
  // A registry copy beside the link is still compared, and still off the pin.
  lock.packages['node_modules/host-dep/node_modules/inner-dep'] = { version: '0.9.0' }
  const mixed = overrideFindings({ publisherOverrides: { 'inner-dep': '1.0.0' }, consumerLock: lock })
  assert.deepEqual(mixed.compared, ['inner-dep'])
  assert.deepEqual(mixed.findings, [{
    code: OVERRIDE_NOT_INHERITED,
    package: 'inner-dep',
    pinned: '1.0.0',
    found: [{ path: 'node_modules/host-dep/node_modules/inner-dep', version: '0.9.0' }],
  }])
})

test('a lockfile entry that is not an object is never a copy and never a captured tarball (synthetic)', () => {
  const lock = {
    packages: {
      '': { name: 'invented-consumer' },
      'node_modules/null-dep': null,
      'node_modules/text-dep': 'text',
      'node_modules/list-dep': ['list'],
      'node_modules/real-dep': { version: '1.0.0', resolved: 'https://registry.example.test/real-dep/-/real-dep-1.0.0.tgz', integrity: 'sha512-invented' },
    },
  }
  assert.deepEqual(overrideFindings({ publisherOverrides: { 'null-dep': '1.0.0', 'real-dep': '1.0.0' }, consumerLock: lock }), { findings: [], compared: ['real-dep'] })
  const { tarballs, missing } = capturedClosure(lock)
  assert.deepEqual(tarballs.map((tarball) => tarball.path), ['node_modules/real-dep'])
  assert.deepEqual(missing, ['node_modules/list-dep', 'node_modules/null-dep', 'node_modules/text-dep'])
})
