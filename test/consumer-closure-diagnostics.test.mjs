import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

// Recorded: the package-lock.json a fresh bare consumer wrote when it installed
// the fast-uri 3.1.8 candidate tarball online. Only the candidate's own local
// `file:` path is shortened.
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
  const bare = classifyNpmFailure('npm error code ENOTCACHED\n')
  assert.deepEqual({ ...bare }, { code: CONSUMER_CLOSURE_INCOMPLETE, package: null, version: null, url: null })
})

test('the recorded candidate consumer lock honours the fast-uri 3.1.8 override with one copy', () => {
  assert.deepEqual(overrideFindings({ publisherOverrides: { 'fast-uri': '3.1.8' }, consumerLock: CANDIDATE_LOCK }), [])
})

test('a PR #89-shaped consumer lock is a typed override-not-inherited finding naming both copies', () => {
  assert.deepEqual(overrideFindings({ publisherOverrides: { 'fast-uri': '4.2.1' }, consumerLock: pr89ShapedLock() }), [{
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
  const [finding] = overrideFindings({ publisherOverrides: { 'fast-uri': '3.1.8' }, consumerLock: lock })
  assert.deepEqual(finding.found, [{ path: 'node_modules/fast-uri', version: '3.1.7' }])
})

test('two copies at the pinned version are still a finding', () => {
  const lock = structuredClone(CANDIDATE_LOCK)
  lock.packages['node_modules/ajv/node_modules/fast-uri'] = registry('fast-uri', '3.1.8', 'sha512-synthetic-nested')
  const [finding] = overrideFindings({ publisherOverrides: { 'fast-uri': '3.1.8' }, consumerLock: lock })
  assert.deepEqual(finding.found.map((copy) => copy.path), ['node_modules/ajv/node_modules/fast-uri', 'node_modules/fast-uri'])
})

test('a copy is named by npm, not by the last path segment (synthetic)', () => {
  // A scoped package with the same basename is not a copy of fast-uri.
  const scoped = structuredClone(CANDIDATE_LOCK)
  scoped.packages['node_modules/@other/fast-uri'] = registry('@other/fast-uri', '1.0.0', 'sha512-synthetic-scoped')
  assert.deepEqual(overrideFindings({ publisherOverrides: { 'fast-uri': '3.1.8' }, consumerLock: scoped }), [])
  // An npm: alias installs fast-uri under another path; the entry's name says so.
  const aliased = structuredClone(CANDIDATE_LOCK)
  aliased.packages['node_modules/fast-uri-v4'] = { name: 'fast-uri', ...registry('fast-uri', '4.2.1', 'sha512-synthetic-alias') }
  const [finding] = overrideFindings({ publisherOverrides: { 'fast-uri': '3.1.8' }, consumerLock: aliased })
  assert.deepEqual(finding.found, [
    { path: 'node_modules/fast-uri', version: '3.1.8' },
    { path: 'node_modules/fast-uri-v4', version: '4.2.1' },
  ])
  // A workspace link is not an installed copy.
  const linked = structuredClone(CANDIDATE_LOCK)
  linked.packages['node_modules/ajv/node_modules/fast-uri'] = { resolved: 'packages/fast-uri', link: true }
  assert.deepEqual(overrideFindings({ publisherOverrides: { 'fast-uri': '3.1.8' }, consumerLock: linked }), [])
})

test('an override the consumer does not install has nothing to inherit', () => {
  assert.deepEqual(overrideFindings({ publisherOverrides: { 'left-pad': '1.3.0' }, consumerLock: CANDIDATE_LOCK }), [])
  assert.deepEqual(overrideFindings({ publisherOverrides: undefined, consumerLock: CANDIDATE_LOCK }), [])
})

test('overrides that are not exact versions, and lockfiles without a packages map, are refused', () => {
  for (const spec of ['^3.1.8', '>=3.1.8', '$fast-uri', { '.': '3.1.8' }, '']) {
    assert.throws(() => overrideFindings({ publisherOverrides: { 'fast-uri': spec }, consumerLock: CANDIDATE_LOCK }), /exact version/)
  }
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
})

// consumer-smoke resolves npm from npm_execpath. A synthetic npm that replays a
// recorded install failure drives the real default path with no registry and
// no real install: `cache add` succeeds, the offline install fails.
function runSmokeWithInstallFailure(t, installStderr) {
  const root = mkdtempSync(join(tmpdir(), 'atelier-closure-diagnostic-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const tarball = join(root, `${packageJson.name.replace(/^@/, '').replace('/', '-')}-${packageJson.version}.tgz`)
  writeFileSync(tarball, 'synthetic tarball, never installed\n')
  const npm = join(root, 'npm-cli.mjs')
  writeFileSync(npm, [
    'const [command] = process.argv.slice(2)',
    "if (command === 'cache') process.exit(0)",
    `if (command === 'install') { process.stderr.write(${JSON.stringify(installStderr)}); process.exit(1) }`,
    "process.stderr.write(`unexpected synthetic npm command ${command}\\n`)",
    'process.exit(1)',
  ].join('\n'))
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(npm_|ATELIER_)/i.test(name)))
  return spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/consumer-smoke.mjs', import.meta.url))], {
    env: { ...environment, npm_execpath: npm, ATELIER_CANDIDATE_TARBALL: tarball },
    encoding: 'utf8',
  })
}

test('the default publisher-lock install reports the recorded #89 failure as a typed diagnostic', (t) => {
  const result = runSmokeWithInstallFailure(t, PR89_STDERR)
  assert.equal(result.status, 1)
  const lines = result.stderr.trim().split('\n')
  assert.equal(lines[0], '[consumer-closure-incomplete] offline install from the publisher lockfile closure: the warmed npm cache does not hold fast-uri@3.1.8 (https://registry.npmjs.org/fast-uri/-/fast-uri-3.1.8.tgz)')
  assert.match(lines[1], /^Next: npm overrides do not reach consumers.*--captured-closure/)
  assert.equal(lines.length, 2)
})

test('any other install failure keeps its original error', (t) => {
  const result = runSmokeWithInstallFailure(t, 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/fast-uri\n')
  assert.notEqual(result.status, 0)
  assert.doesNotMatch(result.stderr, /\[consumer-closure-incomplete\]/)
  assert.match(result.stderr, /npm error code E404/)
})
