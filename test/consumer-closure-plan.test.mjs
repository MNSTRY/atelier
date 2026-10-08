import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import * as viaScripts from '../scripts/consumer-closure-diagnostics.mjs'
import * as viaSource from '../src/upgrade/closure-diagnostics.mjs'
import {
  CLOSURE_PLAN_EXIT,
  CLOSURE_REFUSAL_EXIT,
  closureRefusalError,
  lockSourceFindings,
  lockTreeDifferences,
  planConsumerClosure,
} from '../src/upgrade/closure.mjs'
import * as upgradeExports from '../src/upgrade/upgrade.mjs'
import { AtelierDiagnosticError } from '../src/project/config.mjs'

// Every lockfile here is invented; see test/fixtures/consumer-closure/README.md.
const FIXTURES = new URL('./fixtures/consumer-closure/', import.meta.url)
const fixtureText = (name) => fs.readFileSync(new URL(name, FIXTURES), 'utf8')
const fixture = (name) => JSON.parse(fixtureText(name))
const CLI = fileURLToPath(new URL('../bin/atelier.mjs', import.meta.url))
const SELECTED = '@example/publisher'
const APPLE = { os: 'darwin', cpu: 'arm64', libc: null }

// A staged candidate in its own temporary directory: the consumer manifest,
// one lockfile fixture, and the selected package's installed manifest.
function candidate(t, lockName, { manifest = fixture('consumer-package.json'), installSelected = true, lock = true } = {}) {
  const holder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-closure-plan-')))
  t.after(() => fs.rmSync(holder, { recursive: true, force: true }))
  const npmRoot = path.join(holder, 'candidate')
  fs.mkdirSync(npmRoot)
  fs.writeFileSync(path.join(npmRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  if (lock) fs.writeFileSync(path.join(npmRoot, 'package-lock.json'), fixtureText(lockName))
  if (installSelected) {
    const installed = path.join(npmRoot, 'node_modules', '@example', 'publisher')
    fs.mkdirSync(installed, { recursive: true })
    fs.writeFileSync(path.join(installed, 'package.json'), fixtureText('publisher-package.json'))
  }
  return { holder, npmRoot }
}

const plan = (npmRoot, options = {}) => planConsumerClosure({ npmRoot, selectedPackage: SELECTED, host: APPLE, ...options })
const reasons = (result) => result.refusals.map((refusal) => `${refusal.code}/${refusal.reason}`)

// Every file and directory under a root with its bytes, to show nothing moved.
function snapshot(root) {
  const seen = []
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name)
      const relative = path.relative(root, absolute).split(path.sep).join('/')
      if (entry.isDirectory()) {
        seen.push(`${relative}/`)
        walk(absolute)
      } else {
        seen.push(`${relative} ${createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')}`)
      }
    }
  }
  walk(root)
  return seen
}

test('the classifiers moved to the packed source and the scripts path re-exports the same functions', () => {
  const names = ['CONSUMER_CLOSURE_INCOMPLETE', 'OVERRIDE_NOT_INHERITED', 'capturedClosure', 'classifyNpmFailure', 'npmTreeLines', 'overrideFindings']
  assert.deepEqual(Object.keys(viaSource).sort(), names)
  assert.deepEqual(Object.keys(viaScripts).sort(), names)
  for (const name of names) assert.equal(viaScripts[name], viaSource[name], name)
})

test('the planner source imports nothing that could run npm or reach the network', () => {
  const source = fs.readFileSync(new URL('../src/upgrade/closure.mjs', import.meta.url), 'utf8')
  const imported = [...source.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)].map((match) => match[1]).sort()
  assert.deepEqual(imported, ['../project/config.mjs', './closure-diagnostics.mjs', 'node:crypto', 'node:fs', 'node:path'])
  assert.doesNotMatch(source, /child_process|\bfetch\(|node:https?|node:net|node:dns|\bimport\(/)
  assert.doesNotMatch(source, /writeFileSync|appendFileSync|mkdirSync|rmSync|renameSync|unlinkSync|copyFileSync|symlinkSync/)
})

test('a clean candidate is a completed plan that is not a proof', (t) => {
  const { npmRoot } = candidate(t, 'clean-lock.json')
  const result = plan(npmRoot)
  assert.equal(result.proof, 'not-run')
  assert.equal(result.status, 'planned')
  assert.deepEqual(result.refusals, [])
  assert.equal(result.npmRoot, npmRoot)
  assert.equal(result.prefixVerified, false)
  assert.equal(result.approvedRegistryVerified, false)
  assert.deepEqual(result.lock, {
    file: 'package-lock.json',
    sha256: createHash('sha256').update(fixtureText('clean-lock.json')).digest('hex'),
    lockfileVersion: 3,
    entries: 3,
  })
  assert.deepEqual(result.host, APPLE)
  assert.deepEqual(result.sources, {
    counts: { npm: 3, git: 0, local_path: 0, link: 0, bundled: 0, unclassified: 0 },
    registryHosts: { 'registry.example.test': 3 },
    registrySchemes: { https: 3 },
  })
  assert.deepEqual(result.capture, { registryTarballs: 3 })
  assert.deepEqual(result.otherPlatform, [])
  assert.deepEqual(result.selectedPackage, {
    name: SELECTED,
    copies: [{ path: 'node_modules/@example/publisher', version: '1.0.0' }],
    manifests: [{
      path: 'node_modules/@example/publisher/package.json',
      name: SELECTED,
      version: '1.0.0',
      sha256: createHash('sha256').update(fixtureText('publisher-package.json')).digest('hex'),
    }],
  })
  assert.equal(closureRefusalError(result), null)
  assert.equal(Object.hasOwn(result, 'ok'), false, 'a plan carries no field that reads as a pass')
})

test('exact overrides are checked, absent ones are named, and selector, nested and non-exact ones are unchecked', (t) => {
  const { npmRoot } = candidate(t, 'clean-lock.json')
  assert.deepEqual(plan(npmRoot).overrides, {
    checked: ['pinned-dep'],
    notInstalled: ['absent-dep'],
    unchecked: [
      { name: 'ranged-dep', reason: 'non-exact' },
      { name: 'selector-dep@^1', reason: 'selector-key' },
      { name: 'nested-parent', reason: 'nested' },
    ],
    multipleCopiesAtPin: [],
  })
})

// One fixture per refusal. Each differs from clean-lock.json in the one way its
// name says, and the clean plan above refuses nothing, so a refusal that
// stopped firing, or fired for the clean lockfile, fails here.
const LOCK_REFUSALS = [
  ['git-source-lock.json', {}, 'consumer-closure-incomplete/git-source', { path: 'node_modules/git-dep' }],
  ['other-host-lock.json', { approvedRegistryHosts: ['registry.example.test'] }, 'consumer-closure-incomplete/other-host', { path: 'node_modules/plain-dep', host: 'other.example.test' }],
  ['missing-integrity-lock.json', {}, 'consumer-closure-incomplete/missing-integrity', { path: 'node_modules/plain-dep' }],
  ['outside-project-file-lock.json', {}, 'consumer-closure-incomplete/outside-project', { path: 'node_modules/local-dep' }],
  ['outside-project-link-lock.json', {}, 'consumer-closure-incomplete/outside-project', { path: 'node_modules/linked-dep' }],
  ['override-off-pin-lock.json', {}, 'override-not-inherited/copy-off-pin', { package: 'pinned-dep', pinned: '1.2.3' }],
  ['multiple-copies-off-pin-lock.json', {}, 'override-not-inherited/copy-off-pin', { package: 'pinned-dep', pinned: '1.2.3' }],
  ['zero-copies-dependency-lock.json', {}, 'consumer-closure-incomplete/zero-copies', { package: 'pinned-dep' }],
  ['zero-copies-selected-lock.json', {}, 'consumer-closure-incomplete/zero-copies', { package: SELECTED }],
  ['workspaces-lock.json', {}, 'usage/workspaces', {}],
  ['lockfile-v1.json', {}, 'usage/lockfile-version', {}],
]

for (const [lockName, options, expected, detail] of LOCK_REFUSALS) {
  test(`${lockName} is refused as ${expected} and nothing else`, (t) => {
    const { npmRoot } = candidate(t, lockName)
    const result = plan(npmRoot, options)
    assert.deepEqual(reasons(result), [expected])
    assert.equal(result.status, 'refused')
    assert.equal(result.proof, 'not-run')
    const [refusal] = result.refusals
    for (const [key, value] of Object.entries(detail)) assert.deepEqual(refusal[key], value, key)
    assert.equal(typeof refusal.message, 'string')
    assert.ok(refusal.hint.length > 0, 'every refusal names a next step')

    const error = closureRefusalError(result)
    assert.ok(error instanceof AtelierDiagnosticError)
    assert.equal(error.code, expected.split('/')[0])
    assert.equal(error.exitCode, CLOSURE_REFUSAL_EXIT)
    assert.equal(error.message, refusal.message)
    assert.equal(error.hint, refusal.hint)
  })
}

test('a copy off the pin names every installed copy, and the override is not listed as checked', (t) => {
  const { npmRoot } = candidate(t, 'multiple-copies-off-pin-lock.json')
  const result = plan(npmRoot)
  assert.deepEqual(result.refusals[0].found, [
    { path: 'node_modules/pinned-dep', version: '1.2.3' },
    { path: 'node_modules/plain-dep/node_modules/pinned-dep', version: '1.0.0' },
  ])
  assert.deepEqual(result.overrides.checked, [])
})

test('more than one copy, all at the pin, is reported and not refused', (t) => {
  const { npmRoot } = candidate(t, 'multiple-copies-at-pin-lock.json')
  const result = plan(npmRoot)
  assert.deepEqual(result.refusals, [])
  assert.deepEqual(result.overrides.checked, ['pinned-dep'])
  assert.deepEqual(result.overrides.multipleCopiesAtPin, [{
    package: 'pinned-dep',
    pinned: '1.2.3',
    found: [
      { path: 'node_modules/pinned-dep', version: '1.2.3' },
      { path: 'node_modules/plain-dep/node_modules/pinned-dep', version: '1.2.3' },
    ],
  }])
})

test('zero copies of a package the selected package depends on is a failed listing, never a pass', (t) => {
  const { npmRoot } = candidate(t, 'zero-copies-dependency-lock.json')
  const result = plan(npmRoot)
  assert.deepEqual(result.overrides.checked, [])
  assert.deepEqual(result.overrides.notInstalled, ['absent-dep'], 'only an override nothing depends on may be merely absent')
  assert.match(result.refusals[0].message, /depends on pinned-dep, but the lockfile lists no copy/)
})

test('without --package the selected package is this package, and its absence is refused', (t) => {
  const { npmRoot } = candidate(t, 'clean-lock.json')
  const result = planConsumerClosure({ npmRoot, host: APPLE })
  const own = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name
  assert.equal(result.selectedPackage.name, own)
  assert.deepEqual(reasons(result), ['consumer-closure-incomplete/zero-copies'])
})

test('a selected package the lockfile lists but the candidate has not installed is refused', (t) => {
  const { npmRoot } = candidate(t, 'clean-lock.json', { installSelected: false })
  const result = plan(npmRoot)
  assert.deepEqual(reasons(result), ['consumer-closure-incomplete/selected-package-unreadable'])
  assert.equal(result.refusals[0].path, 'node_modules/@example/publisher')
})

test('another registry host is reported, and refused only when approved hosts are named', (t) => {
  const { npmRoot } = candidate(t, 'other-host-lock.json')
  const unverified = plan(npmRoot)
  assert.deepEqual(unverified.refusals, [])
  assert.equal(unverified.approvedRegistryVerified, false)
  assert.deepEqual(unverified.sources.registryHosts, { 'other.example.test': 1, 'registry.example.test': 2 })

  const both = plan(npmRoot, { approvedRegistryHosts: ['registry.example.test', 'other.example.test'] })
  assert.deepEqual(both.refusals, [])
  assert.equal(both.approvedRegistryVerified, true)
})

test('links, folders and local files inside the project, and bundled entries, are counted and not refused', (t) => {
  const { npmRoot } = candidate(t, 'inside-link-and-bundled-lock.json')
  const result = plan(npmRoot)
  assert.deepEqual(result.refusals, [])
  assert.deepEqual(result.sources.counts, { npm: 3, git: 0, local_path: 2, link: 1, bundled: 1, unclassified: 0 })
  assert.deepEqual(result.capture, { registryTarballs: 3 })
})

test('lockSourceFindings refuses a source with a scheme it does not know', () => {
  const lock = { packages: { 'node_modules/odd-dep': { version: '1.0.0', resolved: 'ssh://host.example.test/odd-dep.tgz' } } }
  const { counts, findings } = lockSourceFindings(lock, { npmRoot: path.resolve('candidate') })
  assert.deepEqual(findings, [{ reason: 'outside-project', path: 'node_modules/odd-dep' }])
  assert.equal(counts.npm, 0)
})

test('an entry is another platform only when its os, cpu or libc excludes the host', (t) => {
  const { npmRoot } = candidate(t, 'other-platform-lock.json')
  const excluded = (host) => plan(npmRoot, { host }).otherPlatform.map((item) => `${item.path.split('/').pop()}:${item.excludedBy}`)

  assert.deepEqual(excluded(APPLE), ['native-linux-x64:os', 'native-linux-x64-musl:os'])
  assert.deepEqual(excluded({ os: 'linux', cpu: 'x64', libc: 'glibc' }), ['native-darwin-arm64:os', 'native-linux-x64-musl:libc'])
  // An unknown libc is not evidence, so the musl build is not called another platform.
  assert.deepEqual(excluded({ os: 'linux', cpu: 'x64', libc: null }), ['native-darwin-arm64:os'])
  assert.deepEqual(excluded({ os: 'linux', cpu: 'arm64', libc: 'glibc' }), ['native-darwin-arm64:os', 'native-linux-x64:cpu', 'native-linux-x64-musl:cpu'])
  assert.deepEqual(excluded({ os: 'win32', cpu: 'x64', libc: null }), ['native-darwin-arm64:os', 'native-linux-x64:os', 'native-linux-x64-musl:os', 'not-windows:os'])

  const result = plan(npmRoot)
  assert.deepEqual(result.refusals, [], 'platform exclusions are evidence for the proof, not refusals of the plan')
  assert.ok(result.otherPlatform.every((item) => item.optional === true))
})

test('input that is not supported is refused as usage with one reason', (t) => {
  const { holder, npmRoot } = candidate(t, 'clean-lock.json')
  assert.deepEqual(reasons(planConsumerClosure({})), ['usage/npm-root-required'])
  assert.deepEqual(reasons(planConsumerClosure({ npmRoot: '  ' })), ['usage/npm-root-required'])
  assert.deepEqual(reasons(planConsumerClosure({ npmRoot: 'candidate' })), ['usage/npm-root-not-absolute'])
  assert.deepEqual(reasons(plan(path.join(holder, 'absent'))), ['usage/npm-root-not-directory'])
  assert.deepEqual(reasons(plan(path.join(npmRoot, 'package.json'))), ['usage/npm-root-not-directory'])

  const bare = path.join(holder, 'bare')
  fs.mkdirSync(bare)
  assert.deepEqual(reasons(plan(bare)), ['usage/manifest-missing'])

  const unlocked = candidate(t, 'clean-lock.json', { lock: false })
  assert.deepEqual(reasons(plan(unlocked.npmRoot)), ['usage/lockfile-missing'])

  fs.writeFileSync(path.join(npmRoot, 'package-lock.json'), '[]\n')
  assert.deepEqual(reasons(plan(npmRoot)), ['usage/lockfile-invalid'])
  fs.writeFileSync(path.join(npmRoot, 'package-lock.json'), '{ not json\n')
  assert.deepEqual(reasons(plan(npmRoot)), ['usage/lockfile-invalid'])
})

test('npm workspaces are refused, in the candidate and in any parent directory', (t) => {
  const declared = candidate(t, 'clean-lock.json', { manifest: { ...fixture('consumer-package.json'), workspaces: ['packages/*'] } })
  assert.deepEqual(reasons(plan(declared.npmRoot)), ['usage/workspaces'])

  const nested = candidate(t, 'clean-lock.json')
  fs.writeFileSync(path.join(nested.holder, 'package.json'), `${JSON.stringify({ name: 'holder', private: true, workspaces: { packages: ['candidate'] } })}\n`)
  assert.deepEqual(reasons(plan(nested.npmRoot)), ['usage/prefix-mismatch'])

  // Control: a parent manifest with no workspaces does not refuse.
  fs.writeFileSync(path.join(nested.holder, 'package.json'), `${JSON.stringify({ name: 'holder', private: true })}\n`)
  assert.deepEqual(plan(nested.npmRoot).refusals, [])
})

test('a linked node_modules is refused', (t) => {
  const { holder, npmRoot } = candidate(t, 'clean-lock.json', { installSelected: false })
  const elsewhere = path.join(holder, 'elsewhere', 'node_modules')
  fs.mkdirSync(elsewhere, { recursive: true })
  // A junction needs no privilege on Windows; the type is ignored elsewhere.
  fs.symlinkSync(elsewhere, path.join(npmRoot, 'node_modules'), 'junction')
  assert.deepEqual(reasons(plan(npmRoot)), ['usage/linked-node-modules'])
})

test('planning writes nothing: the candidate, its node_modules and the directory above are unchanged', (t) => {
  for (const lockName of ['clean-lock.json', 'git-source-lock.json', 'workspaces-lock.json']) {
    const { holder, npmRoot } = candidate(t, lockName)
    const before = snapshot(holder)
    plan(npmRoot)
    planConsumerClosure({ npmRoot })
    assert.deepEqual(snapshot(holder), before, lockName)
  }
})

test('the upgrade module exports the planner', () => {
  assert.equal(upgradeExports.planConsumerClosure, planConsumerClosure)
})

// The real CLI, from a directory that is not an Atelier workspace. The command
// must answer before any project is resolved, and must leave no state behind.
function cli(t, args) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-closure-cli-')))
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }))
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:ATELIER_|MNSTRY_ATELIER_)/i.test(name)))
  const result = spawnSync(process.execPath, [CLI, 'upgrade', 'closure', ...args], { cwd, env: environment, encoding: 'utf8', timeout: 60000 })
  return { ...result, leftovers: fs.readdirSync(cwd) }
}

test('the CLI prints the plan and exits 3 for a completed plan, without resolving a project or writing', (t) => {
  const { holder, npmRoot } = candidate(t, 'clean-lock.json')
  const before = snapshot(holder)
  const result = cli(t, ['--npm-root', npmRoot, '--package', SELECTED])
  assert.equal(result.status, CLOSURE_PLAN_EXIT, result.stderr)
  assert.equal(CLOSURE_PLAN_EXIT, 3)
  assert.equal(result.stderr, '')
  const printed = JSON.parse(result.stdout)
  assert.equal(printed.proof, 'not-run')
  assert.equal(printed.status, 'planned')
  assert.equal(printed.npmRoot, npmRoot)
  assert.deepEqual(printed.overrides.checked, ['pinned-dep'])
  assert.deepEqual(result.leftovers, [], 'no workspace state appears where the command ran')
  assert.deepEqual(snapshot(holder), before)
})

test('the CLI prints the plan, then the typed refusal with its next step, and exits 2', (t) => {
  const { npmRoot } = candidate(t, 'git-source-lock.json')
  const result = cli(t, ['--npm-root', npmRoot, '--package', SELECTED])
  assert.equal(result.status, CLOSURE_REFUSAL_EXIT)
  assert.equal(CLOSURE_REFUSAL_EXIT, 2)
  const printed = JSON.parse(result.stdout)
  assert.equal(printed.proof, 'not-run')
  assert.equal(printed.status, 'refused')
  const lines = result.stderr.trimEnd().split(/\r?\n/)
  assert.equal(lines.length, 2)
  assert.equal(lines[0], '[consumer-closure-incomplete] the lockfile records node_modules/git-dep from a git source, which an offline reinstall from the registry cannot capture')
  assert.match(lines[1], /^Next: A git dependency cannot be captured from the registry\./)
  assert.deepEqual(result.leftovers, [])
})

test('the CLI names how many further refusals the JSON result holds', (t) => {
  const { npmRoot } = candidate(t, 'git-source-lock.json')
  const result = cli(t, ['--npm-root', npmRoot])
  assert.equal(result.status, CLOSURE_REFUSAL_EXIT)
  assert.equal(JSON.parse(result.stdout).refusals.length, 2)
  assert.match(result.stderr, /^\[consumer-closure-incomplete\] .* \(and 1 more; see the JSON result\)\r?\nNext: /)
})

test('the CLI registry-host option names the approved hosts', (t) => {
  const { npmRoot } = candidate(t, 'other-host-lock.json')
  const refused = cli(t, ['--npm-root', npmRoot, '--package', SELECTED, '--registry-host', 'registry.example.test'])
  assert.equal(refused.status, CLOSURE_REFUSAL_EXIT)
  assert.match(refused.stderr, /^\[consumer-closure-incomplete\] the lockfile records node_modules\/plain-dep from other\.example\.test, which is not an approved registry host/)
  const allowed = cli(t, ['--npm-root', npmRoot, '--package', SELECTED, '--registry-host', 'registry.example.test, other.example.test'])
  assert.equal(allowed.status, CLOSURE_PLAN_EXIT, allowed.stderr)
  assert.equal(JSON.parse(allowed.stdout).approvedRegistryVerified, true)
})

test('the CLI has no default root, no proof flag and no success exit', (t) => {
  const { npmRoot } = candidate(t, 'clean-lock.json')
  const cases = [
    [[], /^\[usage\] --npm-root is required/],
    [['--npm-root'], /^\[usage\] --npm-root needs a value/],
    [['--npm-root', 'candidate'], /^\[usage\] --npm-root must be an absolute path/],
    [['--npm-root', npmRoot, '--prove'], /^\[usage\] upgrade closure does not accept --prove/],
    [['--npm-root', npmRoot, '--fetch'], /^\[usage\] upgrade closure does not accept --fetch/],
    [['--npm-root', npmRoot, 'extra'], /^\[usage\] upgrade closure does not accept extra/],
  ]
  for (const [args, expected] of cases) {
    const result = cli(t, args)
    assert.equal(result.status, CLOSURE_REFUSAL_EXIT, args.join(' '))
    assert.match(result.stderr, expected)
    assert.match(result.stderr, /\r?\nNext: /)
    assert.deepEqual(result.leftovers, [])
  }
})

// lockTreeDifferences compares two `npm ls --all --json` documents that a
// caller supplies. Nothing in this file, or in the planner, runs npm.
const TREE_LOCK = fixture('other-platform-lock.json')
const node = (version, dependencies) => ({ ...(version ? { version } : {}), ...(dependencies ? { dependencies } : {}) })
const lockTree = (overrides = {}) => ({
  dependencies: {
    '@example/publisher': node('1.0.0', {
      'pinned-dep': node('1.2.3'),
      'plain-dep': node('2.0.0'),
      '@example/native-linux-x64': node('1.0.0'),
      '@example/native-darwin-arm64': node('1.0.0'),
      ...overrides,
    }),
  },
})

test('identical trees agree', () => {
  const result = lockTreeDifferences({ lock: TREE_LOCK, lockTree: lockTree(), installedTree: lockTree(), host: APPLE })
  assert.deepEqual(result, { agrees: true, problems: [], stale: [], otherPlatform: [], missing: [], extraneous: [] })
})

test('two versions at one dependency path are stale', () => {
  const result = lockTreeDifferences({ lock: TREE_LOCK, lockTree: lockTree(), installedTree: lockTree({ 'pinned-dep': node('1.2.2') }), host: APPLE })
  assert.equal(result.agrees, false)
  assert.deepEqual(result.stale, [{ dependencyPath: '@example/publisher > pinned-dep', locked: '1.2.3', installed: '1.2.2' }])
})

test('a package with no installed version is another platform only on lockfile evidence, otherwise missing', () => {
  const installed = lockTree({ '@example/native-linux-x64': node(null), '@example/native-darwin-arm64': node(null), 'plain-dep': node(null) })
  const result = lockTreeDifferences({ lock: TREE_LOCK, lockTree: lockTree(), installedTree: installed, host: APPLE })
  assert.deepEqual(result.otherPlatform, [
    { dependencyPath: '@example/publisher > @example/native-linux-x64', lockPath: 'node_modules/@example/native-linux-x64', excludedBy: 'os' },
  ])
  // The host's own optional build and an ordinary dependency are missing: no
  // lockfile field excludes this host for either.
  assert.deepEqual(result.missing, [
    { dependencyPath: '@example/publisher > @example/native-darwin-arm64', lockPath: 'node_modules/@example/native-darwin-arm64' },
    { dependencyPath: '@example/publisher > plain-dep', lockPath: 'node_modules/plain-dep' },
  ])
  assert.equal(result.agrees, false)

  const onlyOtherPlatform = lockTreeDifferences({
    lock: TREE_LOCK,
    lockTree: lockTree(),
    installedTree: lockTree({ '@example/native-linux-x64': node(null) }),
    host: APPLE,
  })
  assert.equal(onlyOtherPlatform.agrees, true, 'a tree whose only difference is another platform agrees with its lockfile')
  assert.equal(onlyOtherPlatform.otherPlatform.length, 1)
})

test('a package absent from the installed tree, with no lockfile entry to consult, is missing', () => {
  const locked = lockTree({ 'unlocked-dep': node('1.0.0') })
  const installed = lockTree()
  const result = lockTreeDifferences({ lock: TREE_LOCK, lockTree: locked, installedTree: installed, host: APPLE })
  assert.deepEqual(result.missing, [{ dependencyPath: '@example/publisher > unlocked-dep', lockPath: null }])
})

test('an installed package the lockfile tree does not hold is extraneous, and reported problems prevent agreement', () => {
  const extraneous = lockTreeDifferences({ lock: TREE_LOCK, lockTree: lockTree(), installedTree: lockTree({ 'stray-dep': node('0.1.0') }), host: APPLE })
  assert.deepEqual(extraneous.extraneous, [{ dependencyPath: '@example/publisher > stray-dep', installed: '0.1.0' }])
  assert.equal(extraneous.agrees, false)

  const problems = lockTreeDifferences({ lock: TREE_LOCK, lockTree: lockTree(), installedTree: { ...lockTree(), problems: ['invalid: pinned-dep@1.2.3'] }, host: APPLE })
  assert.deepEqual(problems.problems, ['invalid: pinned-dep@1.2.3'])
  assert.equal(problems.agrees, false)
})

test('a nested copy is found at its own lockfile path before the hoisted one', () => {
  const lock = fixture('multiple-copies-off-pin-lock.json')
  lock.packages['node_modules/plain-dep/node_modules/pinned-dep'].os = ['linux']
  const tree = (nested) => ({ dependencies: { 'plain-dep': node('2.0.0', { 'pinned-dep': nested }), 'pinned-dep': node('1.2.3') } })
  const result = lockTreeDifferences({ lock, lockTree: tree(node('1.0.0')), installedTree: tree(node(null)), host: APPLE })
  assert.deepEqual(result.otherPlatform, [
    { dependencyPath: 'plain-dep > pinned-dep', lockPath: 'node_modules/plain-dep/node_modules/pinned-dep', excludedBy: 'os' },
  ])
  assert.deepEqual(result.missing, [])
})

// Corrections after the r10 review. Each case is a fixture changed in memory in
// the one way its name says; no fixture file is edited and none is added.
const PUBLISHER_PATH = 'node_modules/@example/publisher'
const NESTED_PUBLISHER_PATH = 'node_modules/plain-dep/node_modules/@example/publisher'
const PUBLISHER_MANIFEST_SHA256 = createHash('sha256').update(fixtureText('publisher-package.json')).digest('hex')

function candidateWith(t, lockName, mutate, options) {
  const made = candidate(t, lockName, options)
  const lock = fixture(lockName)
  mutate(lock, made)
  fs.writeFileSync(path.join(made.npmRoot, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`)
  return made
}

function installManifest(npmRoot, lockPath, manifest) {
  const directory = path.join(npmRoot, ...lockPath.split('/'))
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

const NO_OVERRIDES_USED = { checked: [], notInstalled: [], unchecked: [], multipleCopiesAtPin: [] }

test('a selected manifest that declares another name is refused, and its overrides are not used', (t) => {
  const { npmRoot } = candidate(t, 'clean-lock.json')
  installManifest(npmRoot, PUBLISHER_PATH, { ...fixture('publisher-package.json'), name: '@example/other' })
  const result = plan(npmRoot)
  assert.deepEqual(reasons(result), ['consumer-closure-incomplete/selected-package-mismatch'])
  assert.equal(result.refusals[0].path, PUBLISHER_PATH)
  assert.deepEqual(result.refusals[0].locked, { name: SELECTED, version: '1.0.0' })
  assert.deepEqual(result.refusals[0].manifest, { name: '@example/other', version: '1.0.0' })
  assert.deepEqual(result.overrides, NO_OVERRIDES_USED)
  assert.equal(result.status, 'refused')
})

test('a selected manifest at another version than its lockfile copy is refused, and its overrides are not used', (t) => {
  const { npmRoot } = candidate(t, 'clean-lock.json')
  // A stale node_modules: the lockfile says 1.0.0, the installed manifest 0.9.0.
  installManifest(npmRoot, PUBLISHER_PATH, { ...fixture('publisher-package.json'), version: '0.9.0' })
  const result = plan(npmRoot)
  assert.deepEqual(reasons(result), ['consumer-closure-incomplete/selected-package-mismatch'])
  assert.deepEqual(result.refusals[0].locked, { name: SELECTED, version: '1.0.0' })
  assert.deepEqual(result.refusals[0].manifest, { name: SELECTED, version: '0.9.0' })
  assert.deepEqual(result.selectedPackage.copies, [{ path: PUBLISHER_PATH, version: '1.0.0' }])
  assert.deepEqual(result.selectedPackage.manifests.map(({ path: read, name, version }) => ({ path: read, name, version })),
    [{ path: `${PUBLISHER_PATH}/package.json`, name: SELECTED, version: '0.9.0' }])
  assert.deepEqual(result.overrides, NO_OVERRIDES_USED, 'pinned-dep is not reported as checked from a manifest the lockfile does not describe')
})

test('two lockfile copies of the selected package at different versions are refused even when each manifest matches its copy', (t) => {
  const { npmRoot } = candidateWith(t, 'clean-lock.json', (lock) => {
    lock.packages[NESTED_PUBLISHER_PATH] = { ...lock.packages[PUBLISHER_PATH], version: '2.0.0' }
  })
  installManifest(npmRoot, NESTED_PUBLISHER_PATH, { ...fixture('publisher-package.json'), version: '2.0.0', overrides: { 'pinned-dep': '9.9.9' } })
  const result = plan(npmRoot)
  assert.deepEqual(reasons(result), ['consumer-closure-incomplete/selected-copies-differ'])
  assert.deepEqual(result.refusals[0].copies, [{ path: PUBLISHER_PATH, version: '1.0.0' }, { path: NESTED_PUBLISHER_PATH, version: '2.0.0' }])
  assert.deepEqual(result.selectedPackage.manifests.map((read) => read.path), [`${PUBLISHER_PATH}/package.json`, `${NESTED_PUBLISHER_PATH}/package.json`])
  assert.deepEqual(result.overrides, NO_OVERRIDES_USED)
})

test('a second selected manifest that does not match its own lockfile copy is refused', (t) => {
  const { npmRoot } = candidateWith(t, 'clean-lock.json', (lock) => {
    lock.packages[NESTED_PUBLISHER_PATH] = { ...lock.packages[PUBLISHER_PATH] }
  })
  installManifest(npmRoot, NESTED_PUBLISHER_PATH, { ...fixture('publisher-package.json'), version: '1.0.1' })
  const result = plan(npmRoot)
  assert.deepEqual(reasons(result), ['consumer-closure-incomplete/selected-package-mismatch'])
  assert.equal(result.refusals[0].path, NESTED_PUBLISHER_PATH)
  assert.deepEqual(result.refusals[0].manifest, { name: SELECTED, version: '1.0.1' })
  assert.deepEqual(result.overrides, NO_OVERRIDES_USED, 'the first copy matched, but one refused copy stops the override check')

  // The same second copy with no installed manifest is unreadable, not skipped.
  fs.rmSync(path.join(npmRoot, ...NESTED_PUBLISHER_PATH.split('/')), { recursive: true })
  const unreadable = plan(npmRoot)
  assert.deepEqual(reasons(unreadable), ['consumer-closure-incomplete/selected-package-unreadable'])
  assert.equal(unreadable.refusals[0].path, NESTED_PUBLISHER_PATH)
  assert.deepEqual(unreadable.overrides, NO_OVERRIDES_USED)
})

test('two copies of the selected package at one version, with matching manifests, are accepted and both read paths are recorded', (t) => {
  const { npmRoot } = candidateWith(t, 'clean-lock.json', (lock) => {
    lock.packages[NESTED_PUBLISHER_PATH] = { ...lock.packages[PUBLISHER_PATH] }
  })
  installManifest(npmRoot, NESTED_PUBLISHER_PATH, fixture('publisher-package.json'))
  const result = plan(npmRoot)
  assert.deepEqual(result.refusals, [])
  assert.equal(result.status, 'planned')
  assert.deepEqual(result.selectedPackage.manifests.map(({ path: read, name, version }) => ({ path: read, name, version })), [
    { path: `${PUBLISHER_PATH}/package.json`, name: SELECTED, version: '1.0.0' },
    { path: `${NESTED_PUBLISHER_PATH}/package.json`, name: SELECTED, version: '1.0.0' },
  ])
  assert.deepEqual(result.overrides.checked, ['pinned-dep'])

  // Same version, different overrides: the copies do not agree.
  installManifest(npmRoot, NESTED_PUBLISHER_PATH, { ...fixture('publisher-package.json'), overrides: { 'pinned-dep': '9.9.9' } })
  const disagreeing = plan(npmRoot)
  assert.deepEqual(reasons(disagreeing), ['consumer-closure-incomplete/selected-copies-differ'])
  assert.deepEqual(disagreeing.overrides, NO_OVERRIDES_USED)
})

const withLinkedOverride = (npmRoot) => {
  const publisher = fixture('publisher-package.json')
  installManifest(npmRoot, PUBLISHER_PATH, { ...publisher, overrides: { ...publisher.overrides, 'inner-dep': '1.0.0' } })
}

test('an overridden package that only a link provides is unchecked as link-only, never checked and never not installed', (t) => {
  // The fixture's link target, packages/inner-dep, carries no name.
  const { npmRoot } = candidate(t, 'inside-link-and-bundled-lock.json')
  assert.equal(Object.hasOwn(fixture('inside-link-and-bundled-lock.json').packages['packages/inner-dep'], 'name'), false)
  withLinkedOverride(npmRoot)
  const result = plan(npmRoot)
  assert.deepEqual(result.refusals, [])
  assert.deepEqual(result.overrides.unchecked.filter((item) => item.name === 'inner-dep'), [{ name: 'inner-dep', reason: 'link-only' }])
  assert.equal(result.overrides.checked.includes('inner-dep'), false)
  assert.equal(result.overrides.notInstalled.includes('inner-dep'), false)
  assert.deepEqual(result.overrides.checked, ['pinned-dep'])
  assert.deepEqual(result.overrides.notInstalled, ['absent-dep'])

  // The selected package depending on it directly does not turn the link into
  // a missing copy either.
  const direct = candidateWith(t, 'inside-link-and-bundled-lock.json', (lock) => {
    lock.packages[PUBLISHER_PATH].dependencies['inner-dep'] = '^1.0.0'
  })
  withLinkedOverride(direct.npmRoot)
  const required = plan(direct.npmRoot)
  assert.deepEqual(required.refusals, [])
  assert.deepEqual(required.overrides.unchecked.filter((item) => item.name === 'inner-dep'), [{ name: 'inner-dep', reason: 'link-only' }])
})

test('a project folder entry is never an installed copy, whatever name it carries', (t) => {
  const { npmRoot } = candidateWith(t, 'clean-lock.json', (lock) => {
    lock.packages['packages/pinned-dep'] = { name: 'pinned-dep', version: '0.0.1' }
    lock.packages['packages/absent-dep'] = { version: '0.0.1' }
  })
  const result = plan(npmRoot)
  assert.deepEqual(result.refusals, [], 'a folder at another version is not an off-pin copy')
  assert.deepEqual(result.overrides.checked, ['pinned-dep'])
  assert.deepEqual(result.overrides.notInstalled, ['absent-dep'])
  assert.deepEqual(result.overrides.multipleCopiesAtPin, [])
})

test('a linked copy beside a registry copy off the pin keeps the off-pin refusal', (t) => {
  const { npmRoot } = candidateWith(t, 'inside-link-and-bundled-lock.json', (lock) => {
    lock.packages['node_modules/plain-dep/node_modules/inner-dep'] = { ...lock.packages['node_modules/plain-dep'], version: '0.9.0' }
  })
  withLinkedOverride(npmRoot)
  const result = plan(npmRoot)
  assert.deepEqual(reasons(result), ['override-not-inherited/copy-off-pin'])
  assert.equal(result.refusals[0].package, 'inner-dep')
  assert.deepEqual(result.refusals[0].found, [{ path: 'node_modules/plain-dep/node_modules/inner-dep', version: '0.9.0' }])
  assert.deepEqual(result.overrides.unchecked.filter((item) => item.name === 'inner-dep'), [{ name: 'inner-dep', reason: 'linked-copy' }])
  assert.equal(result.overrides.checked.includes('inner-dep'), false)
  assert.equal(result.overrides.notInstalled.includes('inner-dep'), false)
})

test('an npm root given through a link is refused, and the real path of the same candidate is planned', (t) => {
  const { holder, npmRoot } = candidate(t, 'clean-lock.json')
  const linked = path.join(holder, 'linked-candidate')
  fs.symlinkSync(npmRoot, linked, 'junction')
  const result = plan(linked)
  assert.deepEqual(reasons(result), ['usage/npm-root-linked'])
  assert.equal(result.npmRoot, linked)
  assert.equal(Object.hasOwn(result, 'lock'), false, 'nothing behind the link is classified')
  assert.deepEqual(plan(npmRoot).refusals, [])
  assert.deepEqual(plan(`${npmRoot}${path.sep}`).refusals, [], 'a trailing separator is normalized, not refused')
})

test('a link from outside into a member of a parent-declared workspace is refused', (t) => {
  const { holder, npmRoot } = candidate(t, 'clean-lock.json')
  fs.writeFileSync(path.join(holder, 'package.json'), `${JSON.stringify({ name: 'holder', private: true, workspaces: ['candidate'] })}\n`)
  const away = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-closure-away-')))
  t.after(() => fs.rmSync(away, { recursive: true, force: true }))
  const linked = path.join(away, 'member')
  fs.symlinkSync(npmRoot, linked, 'junction')
  // The typed path has no workspace above it; the directory npm would work in does.
  assert.deepEqual(reasons(plan(linked)), ['usage/npm-root-linked'])
  assert.deepEqual(reasons(plan(npmRoot)), ['usage/prefix-mismatch'])
})

test('a real node_modules directory that resolves elsewhere is refused', (t) => {
  const { holder, npmRoot } = candidate(t, 'clean-lock.json')
  const own = path.join(npmRoot, 'node_modules')
  assert.equal(fs.lstatSync(own).isSymbolicLink(), false)
  const original = fs.realpathSync
  // Injected for this one path only, and restored below: a mount or a
  // hard-linked directory cannot be built portably in a test.
  fs.realpathSync = (target, ...rest) => (target === own ? path.join(holder, 'elsewhere', 'node_modules') : original(target, ...rest))
  try {
    assert.deepEqual(reasons(plan(npmRoot)), ['usage/linked-node-modules'])
  } finally {
    fs.realpathSync = original
  }
  assert.equal(fs.realpathSync, original)
  assert.deepEqual(plan(npmRoot).refusals, [])
})

test('a packages entry that is not an object is refused as an invalid lockfile, naming the entry', (t) => {
  for (const bad of [null, 'text', ['list'], 7, true]) {
    const { npmRoot } = candidateWith(t, 'clean-lock.json', (lock) => {
      lock.packages['node_modules/plain-dep'] = bad
    })
    const result = plan(npmRoot)
    assert.deepEqual(reasons(result), ['usage/lockfile-invalid'], JSON.stringify(bad))
    assert.equal(result.refusals[0].path, 'node_modules/plain-dep')
    assert.equal(Object.hasOwn(result, 'sources'), false, 'no classifier ran over the malformed map')
  }
  const rootEntry = candidateWith(t, 'clean-lock.json', (lock) => {
    lock.packages[''] = null
  })
  assert.deepEqual(reasons(plan(rootEntry.npmRoot)), ['usage/lockfile-invalid'])
  assert.equal(plan(rootEntry.npmRoot).refusals[0].path, '')

  const noMap = candidateWith(t, 'clean-lock.json', (lock) => {
    delete lock.packages
  })
  assert.deepEqual(reasons(plan(noMap.npmRoot)), ['usage/lockfile-version'])
})

test('a link must name the folder it resolves to, and a folder entry outside the root is refused', (t) => {
  for (const resolved of [undefined, '', '   ', 7]) {
    const { npmRoot } = candidateWith(t, 'inside-link-and-bundled-lock.json', (lock) => {
      if (resolved === undefined) delete lock.packages['node_modules/inner-dep'].resolved
      else lock.packages['node_modules/inner-dep'].resolved = resolved
    })
    const result = plan(npmRoot)
    assert.deepEqual(reasons(result), ['consumer-closure-incomplete/link-target-missing'], JSON.stringify(resolved))
    assert.equal(result.refusals[0].path, 'node_modules/inner-dep')
    assert.equal(result.sources.counts.link, 1)
  }
  const outside = candidateWith(t, 'clean-lock.json', (lock) => {
    lock.packages['../outside/folder-dep'] = { version: '1.0.0' }
  })
  const result = plan(outside.npmRoot)
  assert.deepEqual(reasons(result), ['consumer-closure-incomplete/outside-project'])
  assert.equal(result.refusals[0].path, '../outside/folder-dep')
})

test('a registry URL with no readable host is never approved, and schemes are reported apart from hosts', () => {
  const lock = {
    packages: {
      'node_modules/odd-dep': { version: '1.0.0', resolved: 'https://[not-a-host/odd-dep-1.0.0.tgz', integrity: 'sha512-invented' },
      'node_modules/plain-http-dep': { version: '1.0.0', resolved: 'http://registry.example.test/plain-http-dep-1.0.0.tgz', integrity: 'sha512-invented' },
    },
  }
  const npmRoot = path.resolve('candidate')
  const unverified = lockSourceFindings(lock, { npmRoot })
  assert.deepEqual(unverified.findings, [])
  assert.deepEqual(unverified.registryHosts, { unparseable: 1, 'registry.example.test': 1 })
  assert.deepEqual(unverified.registrySchemes, { https: 1, http: 1 })

  // Naming the sentinel as an approved host approves nothing.
  const approved = lockSourceFindings(lock, { npmRoot, approvedRegistryHosts: ['unparseable', 'registry.example.test'] })
  assert.deepEqual(approved.findings, [{ reason: 'other-host', path: 'node_modules/odd-dep', host: null }])
})

test('every lockfile entry is counted once: known sources plus unclassified equal the entry count', (t) => {
  for (const lockName of ['clean-lock.json', 'inside-link-and-bundled-lock.json', 'missing-integrity-lock.json', 'git-source-lock.json', 'other-platform-lock.json']) {
    const { npmRoot } = candidate(t, lockName)
    const result = plan(npmRoot)
    const counted = Object.values(result.sources.counts).reduce((sum, count) => sum + count, 0)
    assert.equal(counted, result.lock.entries, lockName)
  }
  const { npmRoot } = candidateWith(t, 'clean-lock.json', (lock) => {
    delete lock.packages['node_modules/plain-dep'].resolved
  })
  const result = plan(npmRoot)
  assert.deepEqual(result.sources.counts, { npm: 2, git: 0, local_path: 0, link: 0, bundled: 0, unclassified: 1 })
  assert.deepEqual(reasons(result), ['consumer-closure-incomplete/missing-integrity'])
})

test('an empty package name or an empty approved host list is refused, and omitting either keeps the default', (t) => {
  const { npmRoot } = candidate(t, 'clean-lock.json')
  for (const options of [{ selectedPackage: '' }, { selectedPackage: '   ' }, { selectedPackage: 7 }, { approvedRegistryHosts: [] }, { approvedRegistryHosts: [' '] }, { approvedRegistryHosts: 'registry.example.test' }]) {
    const result = plan(npmRoot, options)
    assert.deepEqual(reasons(result), ['usage/argument-unsupported'], JSON.stringify(options))
    assert.equal(result.proof, 'not-run')
    assert.equal(Object.hasOwn(result, 'lock'), false)
  }
  assert.deepEqual(plan(npmRoot, { approvedRegistryHosts: null }).refusals, [])
  assert.equal(plan(npmRoot, { approvedRegistryHosts: undefined }).approvedRegistryVerified, false)
})

test('every argument the CLI does not accept prints exactly one refused plan, then the typed refusal, and exits 2', (t) => {
  const { holder, npmRoot } = candidate(t, 'clean-lock.json')
  const before = snapshot(holder)
  const rooted = ['--npm-root', npmRoot]
  const cases = [
    [[...rooted, '--prove'], ['--prove']],
    [[...rooted, '--fetch'], ['--fetch']],
    [[...rooted, '--json'], ['--json']],
    [[...rooted, 'extra'], ['extra']],
    [['--npm-root'], ['--npm-root']],
    [[...rooted, '--package'], ['--package']],
    [[...rooted, '--registry-host'], ['--registry-host']],
    [[...rooted, '--package='], ['--package']],
    // The shared parser reads an empty separate value as a valueless flag
    // followed by an empty positional argument; both are refused.
    [[...rooted, '--package', ''], ['(empty argument)']],
    [[...rooted, '--package=   '], ['--package']],
    [[...rooted, '--registry-host='], ['--registry-host']],
    [[...rooted, '--registry-host', ' , ,'], ['--registry-host']],
    [[...rooted, '--registry-host=   '], ['--registry-host']],
    [[...rooted, ...rooted], ['--npm-root']],
    [[...rooted, `--npm-root=${npmRoot}`], ['--npm-root']],
    [[...rooted, '--package', SELECTED, `--package=${SELECTED}`], ['--package']],
    [[...rooted, '--registry-host', 'registry.example.test', '--registry-host=registry.example.test'], ['--registry-host']],
  ]
  for (const [args, named] of cases) {
    const label = JSON.stringify(args.slice(args[0] === '--npm-root' && args.length > 1 ? 2 : 0))
    const result = cli(t, args)
    assert.equal(result.status, CLOSURE_REFUSAL_EXIT, label)
    // JSON.parse accepts one document only, so this also shows nothing else
    // was printed to stdout.
    const printed = JSON.parse(result.stdout)
    assert.equal(printed.command, 'upgrade closure', label)
    assert.equal(printed.proof, 'not-run', label)
    assert.equal(printed.status, 'refused', label)
    assert.deepEqual(reasons(printed), ['usage/argument-unsupported'], label)
    assert.deepEqual(printed.refusals[0].arguments, named, label)
    assert.equal(Object.hasOwn(printed, 'lock'), false, label)
    const lines = result.stderr.trimEnd().split(/\r?\n/)
    assert.equal(lines.length, 2, label)
    assert.equal(lines[0], `[usage] ${printed.refusals[0].message}`, label)
    assert.match(lines[1], /^Next: This command plans only/, label)
    assert.deepEqual(result.leftovers, [], label)
  }
  assert.deepEqual(snapshot(holder), before)
})

test('a completed plan through the CLI names the manifests it read and never exits 0', (t) => {
  const { npmRoot } = candidate(t, 'clean-lock.json')
  const result = cli(t, [`--npm-root=${npmRoot}`, `--package=${SELECTED}`, '--registry-host=registry.example.test'])
  assert.equal(result.status, CLOSURE_PLAN_EXIT, result.stderr)
  assert.notEqual(result.status, 0)
  const printed = JSON.parse(result.stdout)
  assert.equal(printed.approvedRegistryVerified, true)
  assert.deepEqual(printed.selectedPackage.manifests, [
    { path: `${PUBLISHER_PATH}/package.json`, name: SELECTED, version: '1.0.0', sha256: PUBLISHER_MANIFEST_SHA256 },
  ])
})
