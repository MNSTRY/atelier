import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { acquirePrivateLock } from '../src/project/durable-state.mjs'
import { resolveProjectConfig, validateProjectConfigDoc, writeJson } from '../src/project/config.mjs'
import { createEditorAdapter, publishView, resolveExchange } from '../src/projection/obsidian/publication/index.mjs'
import { CRASH_INJECTION_TEST_SEAM } from '../src/projection/obsidian/publication/test-seam.mjs'
import { ENGINE_PRIMITIVES, createMaintenanceEngineForOracleTests } from '../src/runtime/obsidian/engine.mjs'
import { DEFAULT_ELIGIBILITY, assetEligibilityFor, captureSnapshot, createProductionSeams } from '../src/runtime/obsidian/pipeline.mjs'
import { withEligibility } from '../src/projection/obsidian/materialize/index.mjs'
import {
  FRESHNESS_STATES, ObsidianMaintenanceRefusal, UNAVAILABLE_APPLY_OPERATION, authorizeAutomaticApply, createFsWatcherFactory, createMaintenanceEngine,
  createMaintenanceExtensions, createMaintenanceStateStore, defaultDataRoot, ensureWorkspaceIdentity, installApplyPolicy, localPointerPath, protectedRoots,
  readLocalPointer, readMachineSettings, readObsidianEnablement, resolveDataRoot, validateFreshness, validatePendingEdits, workspaceStateRoot, writeLocalPointer,
  writeMachineSettings,
} from '../src/runtime/obsidian/index.mjs'

// Continuous maintenance, on a real filesystem in temporary directories, with
// no app: the editor adapter always reports that no Obsidian runs, so the
// publisher takes its own path. Invented, synthetic content only. No test
// reads or writes a person's data directory: every engine gets a temporary
// data root, and the resolver refuses the platform default under the runner.

// The publisher refuses outright where no atomic exchange exists (Windows
// today), so every case that needs a publication is skipped there.
const EXCHANGE_HERE = (() => { try { resolveExchange({}); return true } catch { return false } })()
const needsExchange = EXCHANGE_HERE ? {} : { skip: 'no atomic exchange on this platform: the publisher refuses, which the recovery suite asserts' }

const TMP = fs.realpathSync(os.tmpdir())
const EXT = 'mnstry.atelier.obsidian'
const START = Date.parse('2026-01-05T10:00:00.000Z')
const FULL_INTERVAL = 5 * 60 * 1000
const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`
const fixedRandom = (size) => Buffer.alloc(size, 7)
const WORKSPACE_ID = `ws-${'07'.repeat(12)}`

const note = ({ id, title, body, relations = '' }) => `---\ntitle: "${title}"\nkg:\n  id: "${id}"\n  type: "document"\n  status: "active"\n  audience: "team"\n${relations}---\n\n# ${title}\n\n${body}\n`
const SIDECAR = {
  schema: 'mnstry.source-sidecar@v1', asset: 'sounding.pdf', title: 'Sounding sheet', summary: 'Invented depths.', tags: ['chart'],
  kg: { id: 'east-wing:sounding', type: 'evidence', domain: 'sample', lifecycle: 'source', status: 'active', audience: 'team', relations: { evidences: ['east-wing:lantern'] } },
}
const FILES = {
  'east-wing/notes/lantern.md': note({ id: 'east-wing:lantern', title: 'Lantern room', body: 'The lamp turns once a minute. See the [compass](compass.md).', relations: '  relations:\n    supports:\n      - "west-wing:tide"\n' }),
  'east-wing/notes/compass.md': note({ id: 'east-wing:compass', title: 'Compass rose', body: 'North is painted red.' }),
  'east-wing/charts/sounding.pdf': Buffer.from('255044462d312e340a73796e7468657469630a', 'hex'),
  'east-wing/charts/sounding.pdf.kg.json': `${JSON.stringify(SIDECAR, null, 2)}\n`,
  'west-wing/logs/tide.md': note({ id: 'west-wing:tide', title: 'Tide log', body: 'High water at noon.' }),
}
const REPOSITORIES = ['east-wing', 'west-wing']

const FULL_SCOPE = { scopeId: 'scope-whole', mode: 'full', selector: { all: true } }
const EAST_SCOPE = { scopeId: 'scope-east', mode: 'scoped', selector: { repo: 'east-wing' } }
const settingsOf = (scopes = [FULL_SCOPE], extra = {}) => ({ schema: 'atelier-obsidian-ext-settings/v1', enabled: true, scopes, ...extra })

function projectDocument(ext) {
  return {
    schema: 'mnstry.atelier-project-config@v1',
    name: 'maintenance-fixture',
    roots: { workspace: '.', repoOps: '.' },
    graph: { repoAccessPath: 'repo-access.v1.json', outputPath: 'atelier-output/knowledge.graph.json' },
    projection: { outputRoot: 'atelier-output', readinessPath: 'atelier-output/atelier-readiness.json' },
    repos: REPOSITORIES.map((name) => ({ name, path: name, readBoundary: 'team' })),
    ...(ext === undefined ? {} : { ext: { [EXT]: ext } }),
  }
}

const absentAdapter = () => createEditorAdapter({ call: async () => { throw new Error('no app') }, processProbe: () => 'absent', kind: 'absent' })

function listing(directory) {
  const found = {}
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : 1))) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) { found[`${path.relative(directory, absolute)}/`] = 'directory'; walk(absolute) } else found[path.relative(directory, absolute)] = digest(fs.readFileSync(absolute))
    }
  }
  if (fs.existsSync(directory)) walk(directory)
  return found
}

// One temporary project, one temporary data root, one controllable clock.
function makeWorld(t, { ext = settingsOf(), machine = { maintenanceMode: 'manual', audienceAllow: ['team'] } } = {}) {
  const dir = fs.mkdtempSync(path.join(TMP, 'atelier-maintenance-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const projectDir = path.join(dir, 'project')
  const dataRoot = path.join(dir, 'data')
  for (const [relative, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(projectDir, relative)), { recursive: true })
    fs.writeFileSync(path.join(projectDir, relative), content)
  }
  for (const name of REPOSITORIES) fs.mkdirSync(path.join(projectDir, name, '.git'), { recursive: true })
  const configPath = path.join(projectDir, 'atelier.project.json')
  // `ext: null` writes a project with no ext member at all.
  writeJson(configPath, projectDocument(ext === null ? undefined : ext))
  writeJson(path.join(projectDir, 'repo-access.v1.json'), { schema: 'mnstry.atelier-repo-access@v1', defaultReadBoundary: 'team', repos: Object.fromEntries(REPOSITORIES.map((name) => [name, { readBoundary: 'team' }])) })

  const { MNSTRY_ATELIER_PROJECT_CONFIG: _config, MNSTRY_ATELIER_LOCAL_CONFIG: _overlay, ...env } = process.env
  const loadProject = () => resolveProjectConfig({ argv: [`--project=${configPath}`], cwd: projectDir, env, writeLocalState: false })
  let nowMs = START
  const world = {
    dir, projectDir, dataRoot, configPath, loadProject,
    clock: () => new Date(nowMs),
    advance: (ms) => { nowMs += ms },
    calls: { buildGraph: 0, prepareView: 0, publishView: [] },
    snapshots: [],
    watchers: [],
    source: (relative) => path.join(projectDir, relative),
    writeExt: (next) => writeJson(configPath, projectDocument(next)),
    workspaceRoot: () => fs.realpathSync(workspaceStateRoot(dataRoot, WORKSPACE_ID)),
    stateFile: (name) => path.join(world.workspaceRoot(), 'state', 'maintenance', name),
    state: (name) => JSON.parse(fs.readFileSync(world.stateFile(name), 'utf8')),
    vault: (scopeId = FULL_SCOPE.scopeId) => path.join(world.workspaceRoot(), 'vaults', scopeId),
    manifest: (scopeId = FULL_SCOPE.scopeId) => {
      const directory = path.join(world.workspaceRoot(), 'state', 'manifests', scopeId)
      const pointer = JSON.parse(fs.readFileSync(path.join(directory, 'current.json'), 'utf8'))
      return JSON.parse(fs.readFileSync(path.join(directory, pointer.manifestFile), 'utf8'))
    },
    notePath: (nodeId, scopeId) => world.manifest(scopeId).notes.find((item) => item.nodeId === nodeId).path,
    noteFile: (nodeId, scopeId) => path.join(world.vault(scopeId), world.notePath(nodeId, scopeId)),
    scope: (report, scopeId = FULL_SCOPE.scopeId) => report.scopes.find((entry) => entry.scopeId === scopeId),
    configureMachine(settings) {
      const project = loadProject()
      const pointer = ensureWorkspaceIdentity({ project, randomBytes: fixedRandom })
      const root = workspaceStateRoot(dataRoot, pointer.workspaceId)
      const current = fs.existsSync(root) ? readMachineSettings({ workspaceRoot: root, workspaceId: pointer.workspaceId }) : null
      return writeMachineSettings({ workspaceRoot: root, workspaceId: pointer.workspaceId, repositoryRoots: protectedRoots(project), settings: { schema: 'atelier-obsidian-machine-settings/v1', workspaceId: pointer.workspaceId, applyPolicy: null, ...(current ?? {}), ...settings, updatedAt: world.clock().toISOString() } })
    },
    installPolicy(overrides = {}) {
      const project = loadProject()
      const policy = {
        schema: 'atelier-obsidian-apply-policy/v1', policyId: 'policy-synthetic', workspaceId: WORKSPACE_ID, mode: 'automatic', status: 'active', actor: { kind: 'agent', id: 'agent-synthetic' },
        version: 1, digest: digest('policy-synthetic-1'), allowedEditClasses: ['body-replacement'], selector: { all: true }, maxBatchSize: 10, retryBudget: 2, conflictDisposition: 'hold', ...overrides,
      }
      installApplyPolicy({ workspaceRoot: workspaceStateRoot(dataRoot, WORKSPACE_ID), workspaceId: WORKSPACE_ID, policy, repositoryRoots: protectedRoots(project), updatedAt: world.clock().toISOString() })
      return policy
    },
    // Counting wrappers over the production seams; `seams` replaces single members.
    engine({ primitives = ENGINE_PRIMITIVES, seams = {}, ...options } = {}) {
      const counted = {
        ...seams,
        buildGraph: (input) => { world.calls.buildGraph += 1; return (seams.buildGraph ?? DEFAULT.buildGraph)(input) },
        prepareView: (input) => { world.calls.prepareView += 1; return (seams.prepareView ?? DEFAULT.prepareView)(input) },
        publishView: async (input) => { world.calls.publishView.push(input.recoveryStore.scopeId); return (seams.publishView ?? DEFAULT.publishView)(input) },
        captureSnapshot: (input) => { const snapshot = (seams.captureSnapshot ?? DEFAULT.captureSnapshot)(input); world.snapshots.push(snapshot.document); return snapshot },
      }
      const engine = createMaintenanceEngineForOracleTests({
        loadProject, dataRoot, adapterFactory: absentAdapter, clock: world.clock, randomBytes: fixedRandom, quietPeriodMs: 0, seams: counted,
        watcherFactory: ({ roots, onEvent }) => { const watcher = { roots, onEvent, closed: false, close() { watcher.closed = true } }; world.watchers.push(watcher); return watcher },
        ...options,
      }, primitives)
      t.after(() => engine.stop())
      return engine
    },
    emit(rootId, relative) { for (const watcher of world.watchers.filter((item) => !item.closed)) watcher.onEvent({ rootId, relative }) },
  }
  if (machine) world.configureMachine(machine)
  return world
}

const DEFAULT = createProductionSeams()

// An lstat that keeps answering with what it saw when `freeze` was called: a
// change the stat layer cannot see.
function lyingStat() {
  const frozen = new Map()
  const lstat = (file, ...rest) => frozen.get(file) ?? fs.lstatSync(file, ...rest)
  lstat.freeze = (file) => { if (!frozen.has(file)) frozen.set(file, fs.lstatSync(file)) }
  return lstat
}

// ---------------------------------------------------------------------------
// 1. Typed enablement
// ---------------------------------------------------------------------------

function assertUnknownSettingsRefuse(read) {
  const cases = [
    { ...settingsOf(), surprise: true },
    { ...settingsOf(), enabled: 'yes' },
    settingsOf([{ ...FULL_SCOPE, mode: 'everything' }]),
    settingsOf([{ ...FULL_SCOPE, selector: { all: true, alsoThis: 1 } }]),
    settingsOf([FULL_SCOPE, FULL_SCOPE]),
    { schema: 'atelier-obsidian-ext-settings/v2', enabled: true, scopes: [] },
  ]
  for (const member of cases) {
    assert.throws(() => read({ config: projectDocument(member) }), (error) => error instanceof ObsidianMaintenanceRefusal && error.code === 'invalid-ext-settings', JSON.stringify(member))
  }
}

test('a project without the ext member is valid and disabled; a declared member is typed', () => {
  const old = projectDocument(undefined)
  assert.deepEqual(validateProjectConfigDoc(old), [], 'the unchanged project v1 validator accepts an old configuration')
  assert.deepEqual(readObsidianEnablement({ config: old }), { state: 'disabled', reason: 'not-configured', settings: null, scopes: [], defaultScopeId: null })
  assert.equal(readObsidianEnablement({ config: { ...old, ext: { 'other.extension': { anything: 1 } } } }).state, 'disabled')

  const off = readObsidianEnablement({ config: projectDocument({ ...settingsOf([FULL_SCOPE, EAST_SCOPE]), enabled: false }) })
  assert.equal(off.state, 'disabled')
  assert.equal(off.reason, 'disabled-in-settings')
  assert.deepEqual(off.scopes.map((scope) => scope.scopeId), ['scope-whole', 'scope-east'], 'scopes stay nameable while disabled')

  const on = readObsidianEnablement({ config: projectDocument(settingsOf([FULL_SCOPE, EAST_SCOPE], { defaultScopeId: 'scope-east' })) })
  assert.equal(on.state, 'enabled')
  assert.equal(on.defaultScopeId, 'scope-east')
  assert.deepEqual(on.scopes[1], { schema: 'atelier-obsidian-scope/v1', ...EAST_SCOPE })
  // The project validator is unchanged: it does not look inside a member, so the refusal has to come from the adapter.
  assert.deepEqual(validateProjectConfigDoc(projectDocument({ ...settingsOf(), surprise: true })), [])
})

test('an unknown extension key or value refuses with a typed error; it is never ignored and never permission', () => {
  assertUnknownSettingsRefuse(readObsidianEnablement)
  for (const container of [[], 'text', 7]) {
    assert.throws(() => readObsidianEnablement({ config: { ...projectDocument(undefined), ext: container } }), (error) => error.code === 'invalid-ext-settings')
  }
  for (const member of [null, true, 'enabled', []]) {
    assert.throws(() => readObsidianEnablement({ config: { ...projectDocument(undefined), ext: { [EXT]: member } } }), (error) => error.code === 'invalid-ext-settings')
  }
})

test('mutation control: a reader that ignores what it does not know fails the refusal oracle', () => {
  const lenient = (project) => ({ state: project.config.ext[EXT].enabled ? 'enabled' : 'disabled' })
  assert.throws(() => assertUnknownSettingsRefuse(lenient), assert.AssertionError)
})

// ---------------------------------------------------------------------------
// 2. Private machine settings
// ---------------------------------------------------------------------------

test('the default data root is computed per platform and creates nothing', (t) => {
  const home = fs.mkdtempSync(path.join(TMP, 'atelier-maintenance-home-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  assert.equal(defaultDataRoot({ platform: 'darwin', env: {}, homedir: '/Volumes/synthetic-home' }), '/Volumes/synthetic-home/Library/Application Support/Atelier')
  assert.equal(defaultDataRoot({ platform: 'linux', env: {}, homedir: '/home/synthetic' }), '/home/synthetic/.local/share/atelier')
  assert.equal(defaultDataRoot({ platform: 'linux', env: { XDG_DATA_HOME: '/srv/data' }, homedir: '/home/synthetic' }), '/srv/data/atelier')
  assert.equal(defaultDataRoot({ platform: 'linux', env: { XDG_DATA_HOME: 'relative/data' }, homedir: '/home/synthetic' }), '/home/synthetic/.local/share/atelier', 'a relative XDG_DATA_HOME is ignored')
  assert.equal(defaultDataRoot({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\synthetic\\AppData\\Local' }, homedir: 'C:\\Users\\synthetic' }), 'C:\\Users\\synthetic\\AppData\\Local\\Atelier')
  assert.throws(() => defaultDataRoot({ platform: 'win32', env: {}, homedir: 'C:\\Users\\synthetic' }), (error) => error.code === 'data-root-unresolvable')

  // Purity guard: resolving against a real, empty home directory leaves it empty.
  for (const platform of ['darwin', 'linux']) {
    const resolved = defaultDataRoot({ platform, env: {}, homedir: home })
    assert.ok(resolved.startsWith(home))
    assert.equal(fs.existsSync(resolved), false)
  }
  assert.deepEqual(fs.readdirSync(home), [], 'the resolver created nothing')

  // Under the test runner the platform default is refused outright, so a test that forgets to inject a root cannot reach a real one.
  assert.notEqual(process.env.NODE_TEST_CONTEXT, undefined, 'this suite runs under the Node test runner')
  assert.throws(() => resolveDataRoot({}), (error) => error.code === 'real-data-root-under-test')
  assert.equal(resolveDataRoot({ dataRoot: home }), home)
  assert.equal(resolveDataRoot({ pointer: { dataRoot: home } }), home)
  assert.equal(resolveDataRoot({ project: { localOverlay: { overlay: { preferences: { [EXT]: { dataRoot: home } } } } } }), home)
  assert.throws(() => resolveDataRoot({ dataRoot: 'relative/root' }), (error) => error.code === 'data-root-not-absolute')
  assert.equal(resolveDataRoot({ env: {}, platform: 'linux', homedir: '/home/synthetic' }), '/home/synthetic/.local/share/atelier', 'outside the runner the default is the platform directory')
})

test('machine settings live outside every repository, owner-only, strictly validated, with a persisted random workspace identity', (t) => {
  const world = makeWorld(t, { machine: null })
  const project = world.loadProject()
  assert.equal(readLocalPointer(project), null)
  const pointer = ensureWorkspaceIdentity({ project, randomBytes: fixedRandom })
  assert.deepEqual(pointer, { schema: 'atelier-obsidian-local-pointer/v1', workspaceId: WORKSPACE_ID })
  assert.deepEqual(ensureWorkspaceIdentity({ project, randomBytes: () => Buffer.alloc(12, 9) }), pointer, 'the identity is persisted, not derived again')

  const root = workspaceStateRoot(world.dataRoot, WORKSPACE_ID)
  assert.equal(readMachineSettings({ workspaceRoot: root, workspaceId: WORKSPACE_ID }), null)
  const written = world.configureMachine({ maintenanceMode: 'automatic', audienceAllow: ['team'] })
  assert.deepEqual(readMachineSettings({ workspaceRoot: root, workspaceId: WORKSPACE_ID }), written)
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(root, 'state', 'settings', 'machine.json')).mode & 0o777, 0o600)
    assert.equal(fs.statSync(path.join(root, 'state', 'settings')).mode & 0o777, 0o700)
    assert.equal(fs.statSync(localPointerPath(project)).mode & 0o777, 0o600)
  }
  // Nothing machine-specific reaches the project configuration.
  assert.equal(fs.readFileSync(world.configPath, 'utf8').includes(world.dataRoot), false)

  const file = path.join(root, 'state', 'settings', 'machine.json')
  for (const broken of [{ ...written, surprise: 1 }, { ...written, maintenanceMode: 'always' }, { ...written, workspaceId: 'ws-another' }, { ...written, audienceAllow: ['team', 'team'] }, { ...written, applyPolicy: { policyId: 'p' } }]) {
    fs.writeFileSync(file, JSON.stringify(broken))
    assert.throws(() => readMachineSettings({ workspaceRoot: root, workspaceId: WORKSPACE_ID }), (error) => error.code === 'invalid-machine-settings', JSON.stringify(broken))
    assert.deepEqual(authorizeAutomaticApply({ workspaceRoot: root, workspaceId: WORKSPACE_ID }), { authorized: false, reason: 'machine-settings-invalid', policy: null }, 'unreadable settings never authorize')
  }
  assert.throws(() => writeMachineSettings({ workspaceRoot: root, workspaceId: WORKSPACE_ID, repositoryRoots: [], settings: { ...written, maintenanceMode: 'always' } }), (error) => error.code === 'invalid-machine-settings')

  // A data root inside an enrolled repository refuses before anything is created there.
  const inside = workspaceStateRoot(path.join(world.projectDir, 'east-wing', 'data'), WORKSPACE_ID)
  assert.throws(() => writeMachineSettings({ workspaceRoot: inside, workspaceId: WORKSPACE_ID, repositoryRoots: protectedRoots(project), settings: written }), (error) => error.code === 'managed-root-inside-repository')
  assert.equal(fs.existsSync(path.join(world.projectDir, 'east-wing', 'data')), false)

  // The pointer is written only where local state is proven ignored.
  assert.throws(() => writeLocalPointer({ ...project, localState: { ...project.localState, ignored: false } }, pointer), (error) => error.code === 'local-state-not-ignored')
  fs.writeFileSync(localPointerPath(project), JSON.stringify({ ...pointer, port: 4100 }))
  assert.throws(() => readLocalPointer(project), (error) => error.code === 'invalid-local-pointer')
})

// ---------------------------------------------------------------------------
// 3. Disabled does nothing
// ---------------------------------------------------------------------------

async function assertDisabledDoesNothing(world, tick) {
  const before = listing(world.dir)
  for (let round = 0; round < 3; round += 1) {
    const report = await tick()
    assert.equal(report.state, 'disabled')
    world.advance(FULL_INTERVAL)
  }
  assert.deepEqual(listing(world.dir), before, 'a disabled engine creates, changes and removes nothing')
  assert.deepEqual(world.calls, { buildGraph: 0, prepareView: 0, publishView: [] })
  assert.equal(world.watchers.length, 0, 'no watcher is opened')
}

for (const [label, ext, reason] of [['absent settings', null, 'not-configured'], ['enabled: false', { ...settingsOf(), enabled: false }, 'disabled-in-settings']]) {
  test(`disabled (${label}): ticks create no state, no vault, no watcher and call no seam`, async (t) => {
    const world = makeWorld(t, { ext, machine: null })
    const engine = world.engine()
    assert.equal((await engine.tick()).reason, reason)
    await assertDisabledDoesNothing(world, () => engine.tick())
  })
}

test('mutation control: a tick that leaves a file behind fails the disabled oracle', async (t) => {
  const world = makeWorld(t, { ext: null, machine: null })
  const engine = world.engine()
  await assert.rejects(assertDisabledDoesNothing(world, async () => { const report = await engine.tick(); fs.writeFileSync(path.join(world.dir, 'left-behind'), 'x'); return report }), assert.AssertionError)
})

test('an invalid ext member refuses the tick, typed, and publishes nothing', async (t) => {
  const world = makeWorld(t, { ext: { ...settingsOf(), surprise: true } })
  const engine = world.engine()
  const report = await engine.tick()
  assert.equal(report.state, 'refused')
  assert.equal(report.refusal.code, 'invalid-ext-settings')
  assert.deepEqual(world.calls, { buildGraph: 0, prepareView: 0, publishView: [] })
  assert.equal(fs.existsSync(path.join(world.dataRoot, 'obsidian', WORKSPACE_ID, 'vaults')), false)
})

test('disabling a view that was enabled keeps its vault and recovery state and reports it disabled', needsExchange, async (t) => {
  const world = makeWorld(t)
  const engine = world.engine()
  assert.equal(world.scope(await engine.tick()).state, 'current')
  const vaultBefore = listing(world.vault())
  world.writeExt({ ...settingsOf(), enabled: false })
  assert.equal((await engine.tick()).state, 'disabled')
  assert.deepEqual(listing(world.vault()), vaultBefore)
  const freshness = world.state('freshness.json')
  assert.equal(freshness.enablement, 'disabled')
  assert.deepEqual(freshness.scopes.map((entry) => [entry.scopeId, entry.state, entry.reason]), [['scope-whole', 'disabled', 'disabled-in-settings']])
  world.writeExt(settingsOf())
  assert.equal(world.scope(await engine.tick()).state, 'current')
})

// ---------------------------------------------------------------------------
// 4. Every change class invalidates and republishes
// ---------------------------------------------------------------------------

const CHANGE_CASES = [
  { changeClass: 'source-body', changesBytes: true, apply: (world) => fs.appendFileSync(world.source('east-wing/notes/compass.md'), '\nSouth is painted white.\n'), expect: (world) => assert.match(fs.readFileSync(world.noteFile('east-wing:compass'), 'utf8'), /South is painted white/) },
  { changeClass: 'sidecar', changesBytes: true, apply: (world) => fs.writeFileSync(world.source('east-wing/charts/sounding.pdf.kg.json'), `${JSON.stringify({ ...SIDECAR, summary: 'Depths taken at slack water.' }, null, 2)}\n`), expect: (world) => assert.match(fs.readFileSync(world.noteFile('east-wing:sounding'), 'utf8'), /slack water/) },
  { changeClass: 'asset', changesBytes: true, apply: (world) => fs.appendFileSync(world.source('east-wing/charts/sounding.pdf'), 'more'), expect: (world) => assert.equal(world.manifest().attachments[0].byteLength, FILES['east-wing/charts/sounding.pdf'].length + 4) },
  { changeClass: 'config', changesBytes: false, apply: (world) => writeJson(world.configPath, { ...projectDocument(settingsOf()), name: 'maintenance-fixture-renamed' }) },
  { changeClass: 'ext-settings', changesBytes: false, apply: (world) => world.writeExt(settingsOf([FULL_SCOPE], { defaultScopeId: 'scope-whole' })) },
  { changeClass: 'scope', changesBytes: true, apply: (world) => world.writeExt(settingsOf([{ ...FULL_SCOPE, mode: 'scoped', selector: { repo: 'east-wing' } }])), expect: (world) => assert.deepEqual(world.manifest().notes.map((item) => item.repoId).filter((repo) => repo !== 'east-wing'), []) },
  { changeClass: 'eligibility', changesBytes: true, apply: (world) => world.configureMachine({ audienceAllow: [] }), expect: (world) => assert.deepEqual(world.manifest().notes, []) },
]

async function assertChangeRepublishes(world, engine, item) {
  const first = world.scope(await engine.tick())
  assert.equal(first.state, 'current', JSON.stringify(first))
  const quiet = await engine.tick()
  assert.deepEqual(quiet.changes, [])
  const published = world.calls.publishView.length
  item.apply(world)
  world.advance(1000)
  const report = await engine.tick()
  assert.equal(report.full, false, 'found on an ordinary tick, not by waiting for a full reconciliation')
  assert.ok(report.changes.some((change) => change.changeClass === item.changeClass), `${item.changeClass} in ${JSON.stringify(report.changes)}`)
  const entry = world.scope(report)
  assert.ok(entry.changeClasses.includes(item.changeClass))
  assert.equal(world.calls.publishView.length, published + 1, 'the view went through publishView once')
  assert.equal(entry.state, 'current', JSON.stringify(entry))
  assert.equal(entry.generationId, entry.preparedGenerationId)
  assert.equal(entry.generationId, world.manifest().generationId, 'current names the exact trusted generation')
  assert.equal(entry.generationId !== first.generationId, item.changesBytes)
  item.expect?.(world)
}

for (const item of CHANGE_CASES) {
  test(`change class ${item.changeClass}: the view is invalidated, rebuilt and published through publishView`, needsExchange, async (t) => {
    const world = makeWorld(t)
    await assertChangeRepublishes(world, world.engine(), item)
  })
}

test('mutation control: an engine that cannot see a change fails the change oracle', needsExchange, async (t) => {
  const world = makeWorld(t)
  const lstat = lyingStat()
  lstat.freeze(world.source('east-wing/notes/compass.md'))
  const blind = world.engine({ lstat, primitives: { isFullReconciliationDue: ({ lastFullMs }) => lastFullMs === null } })
  await assert.rejects(assertChangeRepublishes(world, blind, CHANGE_CASES[0]), /source-body in \[\]/)
})

test('a scope change republishes that view only; a source change republishes every view', needsExchange, async (t) => {
  const world = makeWorld(t, { ext: settingsOf([FULL_SCOPE, EAST_SCOPE]) })
  const engine = world.engine()
  assert.deepEqual((await engine.tick()).scopes.map((entry) => entry.state), ['current', 'current'])
  world.calls.publishView.length = 0
  world.writeExt(settingsOf([FULL_SCOPE, { ...EAST_SCOPE, selector: { ids: ['east-wing:lantern'] } }]))
  let report = await engine.tick()
  assert.deepEqual(world.calls.publishView, ['scope-east'])
  assert.deepEqual(world.manifest('scope-east').notes.map((item) => item.nodeId), ['east-wing:lantern'])
  world.calls.publishView.length = 0
  fs.appendFileSync(world.source('east-wing/notes/lantern.md'), '\nThe glass is cleaned weekly.\n')
  report = await engine.tick()
  assert.deepEqual(world.calls.publishView, ['scope-whole', 'scope-east'])
  assert.deepEqual(report.scopes.map((entry) => entry.state), ['current', 'current'])
  for (const scopeId of ['scope-whole', 'scope-east']) assert.match(fs.readFileSync(world.noteFile('east-wing:lantern', scopeId), 'utf8'), /cleaned weekly/)
})

// ---------------------------------------------------------------------------
// 4b. Eligibility fails closed; embedded assets
// ---------------------------------------------------------------------------

const IMAGE = Buffer.from('89504e470d0a1a0a73796e746865746963', 'hex')
const embeddedAttachment = (world, scopeId) => world.manifest(scopeId).attachments.find((item) => item.ext?.[EXT]?.kind === 'embedded-asset')

// Writes an invented image and embeds it in a note, before the first tick.
function embedImage(world, { image = 'east-wing/media/beacon.png', from = 'east-wing/notes/lantern.md', href = '../media/beacon.png' } = {}) {
  fs.mkdirSync(path.dirname(world.source(image)), { recursive: true })
  fs.writeFileSync(world.source(image), IMAGE)
  fs.appendFileSync(world.source(from), `\n![beacon](${href})\n`)
  return world.source(image)
}

function assertOnlyClassifiedIsEligible(eligibility) {
  const nodes = [{ id: 'a:classified', classification: 'classified' }, { id: 'a:unclassified', classification: 'unclassified' }, { id: 'a:no-field' }, { id: 'a:odd', classification: true }]
  assert.deepEqual(nodes.map((node) => eligibility.isEligible(node) === true), [true, false, false, false], 'a node with no classification is not eligible')
  const asset = (name) => ({ id: `a:asset:${name}`, repo: 'a', path: name, extension: 'png' })
  const graph = { nodes, edges: [], links: [], assets: ['seen.png', 'unseen.png', 'orphan.png'].map(asset), embeds: [
    { source: 'a:classified', asset: asset('seen.png') }, { source: 'a:unclassified', asset: asset('seen.png') },
    { source: 'a:unclassified', asset: asset('unseen.png') }, { source: 'a:no-field', asset: asset('unseen.png') },
  ] }
  const decided = withEligibility(graph, eligibility.isEligible, assetEligibilityFor({ graph, eligibility }))
  assert.deepEqual(decided.assets.map((item) => [item.path, item.eligible]), [['seen.png', true], ['unseen.png', false], ['orphan.png', false]], 'an asset is eligible only through an eligible note that embeds it')
}

test('default eligibility fails closed: only a classified node, and only an asset an eligible note embeds', () => {
  assertOnlyClassifiedIsEligible(DEFAULT_ELIGIBILITY)
  assert.match(DEFAULT_ELIGIBILITY.revision(), /v2.*assets/)
  // An override replaces the asset rule, and anything but exactly true withholds.
  const graph = { nodes: [{ id: 'a:n', classification: 'classified' }], embeds: [], assets: [] }
  for (const [answer, expected] of [[true, true], ['yes', false], [1, false], [undefined, false]]) {
    assert.equal(assetEligibilityFor({ graph, eligibility: { ...DEFAULT_ELIGIBILITY, isAssetEligible: () => answer } })({ id: 'a:asset:x.png' }), expected)
  }
})

test('mutation control: a rule that only excludes the word unclassified fails the eligibility oracle', () => {
  assert.throws(() => assertOnlyClassifiedIsEligible({ ...DEFAULT_ELIGIBILITY, isEligible: (node) => node.classification !== 'unclassified' }), /a node with no classification is not eligible/)
})

async function assertImageChangeRepublishes(world, engine, image) {
  assert.equal(world.scope(await engine.tick()).state, 'current')
  const before = embeddedAttachment(world)
  assert.deepEqual([before.digest, before.ext[EXT].assetPath], [digest(IMAGE), path.relative(world.source('east-wing'), image).split(path.sep).join('/')])
  assert.deepEqual(fs.readFileSync(path.join(world.vault(), before.path)), IMAGE)
  assert.deepEqual((await engine.tick()).changes, [])
  const next = Buffer.concat([IMAGE, Buffer.from('repainted')])
  fs.writeFileSync(image, next)
  world.advance(1000)
  const report = await engine.tick()
  assert.ok(report.changes.some((change) => change.changeClass === 'asset'), `an embedded image is observed: ${JSON.stringify(report.changes)}`)
  assert.equal(world.scope(report).state, 'current')
  const after = embeddedAttachment(world)
  assert.equal(after.digest, digest(next), 'the attachment carries the new digest')
  assert.deepEqual(fs.readFileSync(path.join(world.vault(), after.path)), next)
}

for (const [label, options] of [['in an ordinary directory', {}], ['in a dot-directory the walk skips', { image: 'east-wing/.media/beacon.png', href: '../.media/beacon.png' }]]) {
  test(`an embedded image ${label}: a change to its bytes republishes the view with the new attachment digest`, needsExchange, async (t) => {
    const world = makeWorld(t)
    await assertImageChangeRepublishes(world, world.engine(), embedImage(world, options))
  })

  test(`mutation control: an engine that observes only what the walk finds fails the image oracle (${label})`, needsExchange, async (t) => {
    const world = makeWorld(t)
    const image = embedImage(world, options)
    await assert.rejects(assertImageChangeRepublishes(world, world.engine({ primitives: { observedAssetsOf: () => [] } }), image), /an embedded image is observed/)
  })
}

// A file embedded only by a note the census could not classify. Its name and
// its digest must be in no snapshot and in nothing the engine persists.
async function assertWithheldAssetLeavesNoTrace(world, engine) {
  const sentinel = 'zqw-sealed-sketch'
  const image = world.source(`east-wing/media/${sentinel}.png`)
  fs.mkdirSync(path.dirname(image), { recursive: true })
  fs.writeFileSync(image, IMAGE)
  fs.mkdirSync(world.source('east-wing/drafts'), { recursive: true })
  fs.writeFileSync(world.source('east-wing/drafts/scratch.md'), `# Scratch\n\nNo front matter, so unclassified.\n\n![sketch](../media/${sentinel}.png)\n`)
  assert.equal(world.scope(await engine.tick()).state, 'current')
  fs.appendFileSync(image, 'redrawn')
  world.advance(FULL_INTERVAL)
  const report = await engine.tick()
  assert.equal(world.scope(report).state, 'current')
  assert.ok(world.snapshots.length >= 1)
  const needles = [sentinel, digest(IMAGE).slice(7), digest(fs.readFileSync(image)).slice(7)]
  const haystacks = [JSON.stringify(world.snapshots), JSON.stringify(report), fs.readFileSync(localPointerPath(world.loadProject()), 'utf8')]
  const walk = (directory) => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const absolute = path.join(directory, entry.name); if (entry.isDirectory()) walk(absolute); else haystacks.push(`${absolute}\n${fs.readFileSync(absolute, 'latin1')}`) } }
  walk(world.dataRoot)
  for (const needle of needles) assert.equal(haystacks.some((text) => text.includes(needle)), false, 'a withheld asset leaves no trace in a snapshot, a report, a vault or a state document')
  assert.equal(embeddedAttachment(world), undefined)
}

test('an asset embedded only by an unclassified note is withheld: absent from every snapshot and every persisted document', needsExchange, async (t) => {
  const world = makeWorld(t)
  await assertWithheldAssetLeavesNoTrace(world, world.engine())
})

test('mutation control: an asset rule that admits everything fails the withheld-asset oracle', needsExchange, async (t) => {
  const world = makeWorld(t)
  const open = world.engine({ eligibility: { ...DEFAULT_ELIGIBILITY, isAssetEligible: () => true } })
  await assert.rejects(assertWithheldAssetLeavesNoTrace(world, open), /a withheld asset leaves no trace/)
})

async function assertAssetDeletionConverges(world, engine, image) {
  assert.equal(world.scope(await engine.tick()).state, 'current')
  assert.ok(embeddedAttachment(world))
  fs.rmSync(image)
  world.advance(1000)
  let report = await engine.tick()
  assert.ok(report.changes.some((change) => change.changeClass === 'asset'))
  assert.deepEqual([report.state, world.scope(report).state], ['ticked', 'current'], 'no refusal: the embed is simply unresolved now')
  assert.equal(embeddedAttachment(world), undefined, 'the attachment is no longer prepared')
  assert.match(fs.readFileSync(world.noteFile('east-wing:lantern'), 'utf8'), /!\[beacon\]\(\.\.\/media\/beacon\.png\)/, 'the embed is left as authored')
  const published = world.calls.publishView.length
  for (let round = 0; round < 3; round += 1) {
    world.advance(round === 2 ? FULL_INTERVAL : 1000)
    report = await engine.tick()
    assert.deepEqual([report.changes, world.scope(report).state], [[], 'current'], 'and it stays settled')
  }
  assert.equal(world.calls.publishView.length, published, 'no rebuild loop')
}

test('an embedded asset deleted from disk converges without a refusal loop', needsExchange, async (t) => {
  const world = makeWorld(t)
  await assertAssetDeletionConverges(world, world.engine(), embedImage(world))
})

test('mutation control: a pipeline that keeps preparing from a graph that still names the deleted asset fails the deletion oracle', needsExchange, async (t) => {
  const world = makeWorld(t)
  const image = embedImage(world)
  let first = null
  const stale = world.engine({ seams: { buildGraph: (input) => (first ??= DEFAULT.buildGraph(input)) } })
  await assert.rejects(assertAssetDeletionConverges(world, stale, image), /no refusal: the embed is simply unresolved now/)
  assert.equal(world.state('freshness.json').scopes[0].reason, 'mixed-read')
})

function assertEmbedAloneChangesSnapshot(capture) {
  const node = { id: 'a:n', repo: 'a', path: 'n.md', classification: 'classified', eligible: true }
  const asset = { id: 'a:asset:x.png', repo: 'a', path: 'x.png', extension: 'png', eligible: true }
  const facts = (text) => ({ digest: digest(text), byteLength: text.length })
  const input = (embeds) => ({
    project: { repos: [{ name: 'a', path: path.join(TMP, 'atelier-maintenance-absent') }] }, workspaceId: WORKSPACE_ID, configDigest: digest('config'), capturedAt: '2026-01-05T10:00:00.000Z',
    index: new Map([['source\u0000a\u0000n.md', facts('note')], ['source\u0000a\u0000x.png', facts('image')]]), graph: { nodes: [node], edges: [], links: [], assets: [asset], embeds },
  })
  const embed = (byteStart) => ({ type: 'embeds_asset', source: 'a:n', asset, range: { byteStart, byteEnd: byteStart + 12 } })
  const [one, again, moved] = [capture(input([embed(10)])), capture(input([embed(10)])), capture(input([embed(40)]))]
  assert.equal(one.document.snapshotId, again.document.snapshotId, 'the same reading is the same snapshot')
  assert.notEqual(one.document.snapshotId, moved.document.snapshotId, 'an embed that changes alone is another snapshot')
  assert.deepEqual(one.document.repositories[0].files.map((file) => file.path), ['n.md', 'x.png'], 'an eligible asset is pinned beside the notes')
  const withheld = capture({ ...input([embed(10)]), graph: { ...input([embed(10)]).graph, assets: [{ ...asset, eligible: false }] } })
  assert.deepEqual(withheld.document.repositories[0].files.map((file) => file.path), ['n.md'], 'a withheld asset is never pinned')
}

test('the snapshot identity covers embeds and assets, pins eligible assets and never a withheld one', () => {
  assertEmbedAloneChangesSnapshot(captureSnapshot)
})

test('mutation control: a snapshot that pins the graph without its embeds fails the snapshot oracle', () => {
  const blindToEmbeds = (input) => captureSnapshot({ ...input, graph: { ...input.graph, embeds: [] } })
  assert.throws(() => assertEmbedAloneChangesSnapshot(blindToEmbeds), /an embed that changes alone is another snapshot/)
})

// ---------------------------------------------------------------------------
// 5. Events are hints; digests decide
// ---------------------------------------------------------------------------

async function assertMissedChangesConverge(world, engine, lstat) {
  const compass = world.source('east-wing/notes/compass.md')
  const edit = (text) => { lstat.freeze(compass); fs.appendFileSync(compass, text) }
  assert.equal(world.scope(await engine.tick()).state, 'current')

  // The stat layer sees nothing, the event arrives: the named file is hashed on the next tick.
  edit('\nFirst addition.\n')
  world.emit('repo:east-wing', 'notes/compass.md')
  world.advance(1000)
  let report = await engine.tick()
  assert.equal(report.full, false)
  assert.ok(report.changes.some((change) => change.changeClass === 'source-body'), 'an event makes the engine hash the file it names')

  // The event is dropped and the stat layer sees nothing: an ordinary tick cannot know.
  edit('\nSecond addition.\n')
  world.advance(1000)
  report = await engine.tick()
  assert.equal(report.full, false)
  assert.deepEqual(report.changes, [], 'nothing reported from a hint that never came')
  assert.doesNotMatch(fs.readFileSync(world.noteFile('east-wing:compass'), 'utf8'), /Second addition/)

  // The next full reconciliation hashes everything and converges.
  world.advance(FULL_INTERVAL)
  report = await engine.tick()
  assert.equal(report.full, true)
  assert.ok(report.changes.some((change) => change.changeClass === 'source-body'))
  assert.equal(world.scope(report).state, 'current')
  assert.match(fs.readFileSync(world.noteFile('east-wing:compass'), 'utf8'), /Second addition/)
}

test('a dropped event and an unchanged stat still converge at the next full reconciliation; the cadence is explicit', needsExchange, async (t) => {
  const world = makeWorld(t)
  const lstat = lyingStat()
  await assertMissedChangesConverge(world, world.engine({ lstat, fullReconciliationIntervalMs: FULL_INTERVAL }), lstat)
})

test('a dropped event alone is caught by the stat scan of the next tick', needsExchange, async (t) => {
  const world = makeWorld(t)
  const engine = world.engine()
  await engine.tick()
  fs.appendFileSync(world.source('west-wing/logs/tide.md'), '\nLow water at six.\n')
  world.advance(1000)
  const report = await engine.tick()
  assert.equal(report.full, false)
  assert.ok(report.changes.some((change) => change.changeClass === 'source-body'))
  assert.match(fs.readFileSync(world.noteFile('west-wing:tide'), 'utf8'), /Low water at six/)
})

test('mutation control: without full reconciliation a missed change never converges', needsExchange, async (t) => {
  const world = makeWorld(t)
  const lstat = lyingStat()
  const never = world.engine({ lstat, primitives: { isFullReconciliationDue: ({ lastFullMs }) => lastFullMs === null } })
  await assert.rejects(assertMissedChangesConverge(world, never, lstat), (error) => error instanceof assert.AssertionError && !/Second addition/.test(fs.readFileSync(world.noteFile('east-wing:compass'), 'utf8')))
})

test('the engine watches repositories, vaults and configuration directories, and the fs.watch factory opens and closes', async (t) => {
  const world = makeWorld(t)
  const engine = world.engine({ seams: { publishView: async () => ({ state: 'refused', refusal: { code: 'exchange-unsupported-platform', message: 'stub' }, notes: [], retainedEdits: [], lateWriters: [] }) } })
  await engine.tick()
  assert.deepEqual(world.watchers.at(-1).roots.map((root) => root.id).map((id) => id.split(':')[0]).sort(), ['config', 'config', 'repo', 'repo', 'vault'])
  engine.stop()
  assert.equal(world.watchers.at(-1).closed, true)

  const events = []
  const handle = createFsWatcherFactory()({ roots: [{ id: 'repo:east-wing', path: path.join(world.projectDir, 'east-wing'), recursive: true }, { id: 'gone', path: path.join(world.dir, 'absent') }], onEvent: (event) => events.push(event) })
  handle.close()
  handle.close()
})

// ---------------------------------------------------------------------------
// 6. No network, no git network operation
// ---------------------------------------------------------------------------

const LOCAL_GIT = new Set(['rev-parse', 'check-ignore', 'ls-files'])
function classifyCommand(command, args = []) {
  const name = path.basename(String(command)).replace(/\.exe$/i, '')
  if (name === 'git') {
    const subcommand = args.filter((arg, position) => !(arg === '-C' || args[position - 1] === '-C'))[0]
    return LOCAL_GIT.has(subcommand) ? 'local-git' : `forbidden:git ${subcommand}`
  }
  // The publisher reaches its atomic exchange through the system perl; nothing else is started.
  return name === 'perl' ? 'exchange' : `forbidden:${name}`
}

// Replaces every process-starting function of node:child_process for the duration of `run`.
async function withProcessRecorder(run) {
  const names = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']
  const original = Object.fromEntries(names.map((name) => [name, childProcess[name]]))
  const seen = []
  for (const name of names) {
    childProcess[name] = (command, args, ...rest) => {
      const kind = classifyCommand(command, Array.isArray(args) ? args : [])
      seen.push(kind)
      if (kind.startsWith('forbidden:')) throw Object.assign(new Error(`${kind} is not available here`), { code: 'ENETDOWN' })
      return original[name](command, args, ...rest)
    }
  }
  syncBuiltinESMExports()
  try { await run() } finally {
    Object.assign(childProcess, original)
    syncBuiltinESMExports()
  }
  return seen
}

async function assertNoNetworkProcess(world, engine) {
  const seen = await withProcessRecorder(async () => {
    assert.equal(world.scope(await engine.tick()).state, 'current')
    fs.appendFileSync(world.source('east-wing/notes/compass.md'), '\nOffline addition.\n')
    fs.appendFileSync(world.noteFile('west-wing:tide'), '\nEdited offline.\n')
    world.advance(FULL_INTERVAL)
    const report = await engine.tick()
    assert.equal(world.scope(report).state, 'held-for-your-edit')
    assert.match(fs.readFileSync(world.noteFile('east-wing:compass'), 'utf8'), /Offline addition/)
  })
  assert.deepEqual(seen.filter((kind) => kind.startsWith('forbidden:')), [], 'only local git queries and the exchange helper are started')
  assert.ok(seen.includes('local-git') && seen.includes('exchange'), 'the recorder saw the real pipeline')
}

test('maintenance works with no network: no git network operation and no other process is started', needsExchange, async (t) => {
  const world = makeWorld(t)
  await assertNoNetworkProcess(world, world.engine())
})

test('mutation control: a pipeline that fetches fails the no-network oracle', needsExchange, async (t) => {
  const world = makeWorld(t)
  const fetching = world.engine({ seams: { buildGraph: (input) => { try { childProcess.spawnSync('git', ['-C', world.projectDir, 'fetch', '--all']) } catch { /* unavailable */ } return DEFAULT.buildGraph(input) } } })
  await assert.rejects(assertNoNetworkProcess(world, fetching), /only local git queries and the exchange helper are started/)
})

// ---------------------------------------------------------------------------
// 7. Vault edits: preserved, queued, never overwritten
// ---------------------------------------------------------------------------

const EDITED_TAIL = '\nA line somebody typed in the vault.\n'

// A source-writing apply operation. Whether it is ever called is the point.
function recordingOperation(world, { status = 'applied', onApply = () => {} } = {}) {
  const operation = {
    id: 'test.recording-apply',
    calls: [],
    async apply(request) {
      operation.calls.push(request.edit.path)
      fs.appendFileSync(world.source('west-wing/logs/tide.md'), '\nWRITTEN BY AN APPLY OPERATION\n')
      await onApply(request)
      return { status, code: status }
    },
  }
  return operation
}

async function assertEditIsPreservedAndHeld(world, engine) {
  assert.equal(world.scope(await engine.tick()).state, 'current')
  const generationId = world.manifest().generationId
  const file = world.noteFile('west-wing:tide')
  const base = fs.readFileSync(file)
  const edited = Buffer.concat([base, Buffer.from(EDITED_TAIL)])
  fs.writeFileSync(file, edited)
  // The source moves too, so the next prepared view would replace the edited note.
  fs.appendFileSync(world.source('west-wing/logs/tide.md'), '\nA line added at the source.\n')
  world.calls.publishView.length = 0
  world.advance(1000)
  const report = await engine.tick()

  const [edit] = world.state('pending-edits.json').edits
  assert.deepEqual(
    { identity: edit.identity, scopeId: edit.scopeId, generationId: edit.generationId, path: edit.path, baseNoteDigest: edit.baseNoteDigest, observedDigest: edit.observedDigest, observedAt: edit.observedAt, state: edit.state },
    { identity: { workspaceId: WORKSPACE_ID, repoId: 'west-wing', nodeId: 'west-wing:tide' }, scopeId: 'scope-whole', generationId, path: world.notePath('west-wing:tide'), baseNoteDigest: digest(base), observedDigest: digest(edited), observedAt: world.clock().toISOString(), state: 'queued' },
  )
  validatePendingEdits(world.state('pending-edits.json'), WORKSPACE_ID)
  assert.deepEqual(fs.readFileSync(path.join(world.workspaceRoot(), edit.objectRef)), edited, 'the edited bytes are in the recovery object store')

  const entry = world.scope(report)
  assert.equal(entry.state, 'held-for-your-edit')
  assert.equal(entry.reason, 'publication-withheld-for-your-edit')
  assert.deepEqual(entry.heldNotes, [edit.path])
  assert.equal(entry.generationId, generationId, 'the trusted generation is unchanged')
  assert.notEqual(entry.preparedGenerationId, generationId)
  assert.deepEqual(world.calls.publishView, [], 'no publication is even attempted over a held note')
  assert.deepEqual(fs.readFileSync(file), edited, 'the edited note is untouched')

  // More ticks, more source changes: still held, still untouched, one record.
  for (let round = 0; round < 3; round += 1) {
    fs.appendFileSync(world.source('west-wing/logs/tide.md'), `\nRound ${round}.\n`)
    world.advance(FULL_INTERVAL)
    assert.equal(world.scope(await engine.tick()).state, 'held-for-your-edit')
  }
  assert.deepEqual(fs.readFileSync(file), edited)
  assert.deepEqual(world.calls.publishView, [])
  assert.equal(world.state('pending-edits.json').edits.length, 1)
  return { file, base, edited, edit }
}

test('a vault edit is copied to the recovery object store, then queued, and the note is never overwritten', needsExchange, async (t) => {
  const world = makeWorld(t)
  const engine = world.engine()
  const { file, base, edited, edit } = await assertEditIsPreservedAndHeld(world, engine)

  // Edited again: the newer bytes are preserved too, and the older record is superseded, not dropped.
  const again = Buffer.concat([edited, Buffer.from('And one more.\n')])
  fs.writeFileSync(file, again)
  world.advance(1000)
  await engine.tick()
  let edits = world.state('pending-edits.json').edits
  assert.deepEqual(edits.map((item) => item.state).sort(), ['queued', 'superseded'])
  for (const item of edits) assert.equal(digest(fs.readFileSync(path.join(world.workspaceRoot(), item.objectRef))), item.observedDigest)

  // Back at the generated bytes: withdrawn, and the withheld publication goes through.
  fs.writeFileSync(file, base)
  world.advance(1000)
  const report = await engine.tick()
  edits = world.state('pending-edits.json').edits
  assert.deepEqual(edits.map((item) => item.state).sort(), ['superseded', 'withdrawn'])
  assert.equal(world.scope(report).state, 'current')
  assert.match(fs.readFileSync(world.noteFile('west-wing:tide'), 'utf8'), /A line added at the source/)
  assert.deepEqual(fs.readFileSync(path.join(world.workspaceRoot(), edit.objectRef)), edited, 'a closed edit keeps its preserved bytes')
})

test('preservation comes first: when the object cannot be retained nothing is queued, and at retention time no record exists yet', needsExchange, async (t) => {
  const world = makeWorld(t)
  let failing = true
  const seenAtPreserve = []
  const engine = world.engine({ primitives: { preserve(store, bytes) {
    seenAtPreserve.push(fs.existsSync(world.stateFile('pending-edits.json')) ? world.state('pending-edits.json').edits.length : 0)
    if (failing) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
    return ENGINE_PRIMITIVES.preserve(store, bytes)
  } } })
  await engine.tick()
  fs.appendFileSync(world.noteFile('west-wing:tide'), EDITED_TAIL)
  world.advance(1000)
  await assert.rejects(engine.tick(), (error) => error.code === 'ENOSPC')
  assert.deepEqual(world.state('pending-edits.json').edits, [], 'no record without preserved bytes')
  failing = false
  world.advance(1000)
  await engine.tick()
  assert.equal(world.state('pending-edits.json').edits.length, 1)
  assert.deepEqual(seenAtPreserve, [0, 0], 'the record did not exist when the bytes were being preserved')
})

test('mutation control: queueing without preserving fails the preservation oracle', needsExchange, async (t) => {
  const world = makeWorld(t)
  const careless = world.engine({ primitives: { preserve: (_store, bytes) => ({ digest: digest(bytes), ref: `recovery/objects/${digest(bytes).slice(7)}.bin` }) } })
  await assert.rejects(assertEditIsPreservedAndHeld(world, careless), (error) => error.code === 'ENOENT')
})

test('mutation control: an engine that publishes over a held note fails the hold oracle, and the publisher still keeps the bytes', needsExchange, async (t) => {
  const world = makeWorld(t)
  const pushy = world.engine({ primitives: { publicationConflicts: () => [] } })
  await assert.rejects(assertEditIsPreservedAndHeld(world, pushy), (error) => error instanceof assert.AssertionError && world.calls.publishView.length > 0)
  assert.match(fs.readFileSync(world.noteFile('west-wing:tide'), 'utf8'), /somebody typed in the vault/, 'defence in depth: the publisher refused the replacement')
})

test('an edit to a note the next view does not change still publishes the rest, and the view stays held', needsExchange, async (t) => {
  const world = makeWorld(t)
  const engine = world.engine()
  await engine.tick()
  const file = world.noteFile('west-wing:tide')
  fs.appendFileSync(file, EDITED_TAIL)
  fs.appendFileSync(world.source('east-wing/notes/compass.md'), '\nEast is painted green.\n')
  world.advance(1000)
  const entry = world.scope(await engine.tick())
  assert.equal(entry.state, 'held-for-your-edit')
  assert.equal(entry.reason, 'edit-pending')
  assert.equal(entry.generationId, entry.preparedGenerationId, 'the other notes moved to the new generation')
  assert.match(fs.readFileSync(world.noteFile('east-wing:compass'), 'utf8'), /East is painted green/)
  assert.match(fs.readFileSync(file, 'utf8'), /somebody typed in the vault/)
})

// ---------------------------------------------------------------------------
// 8. Manual mode never writes a source
// ---------------------------------------------------------------------------

async function assertTicksNeverWriteSource(world, engine, operation) {
  await engine.tick()
  fs.appendFileSync(world.noteFile('west-wing:tide'), EDITED_TAIL)
  fs.appendFileSync(world.noteFile('east-wing:compass'), EDITED_TAIL)
  const sources = () => Object.fromEntries(REPOSITORIES.map((name) => [name, listing(path.join(world.projectDir, name))]))
  const before = sources()
  for (let round = 0; round < 8; round += 1) {
    world.advance(round % 2 === 0 ? 1000 : FULL_INTERVAL)
    const report = await engine.tick()
    assert.equal(report.pendingEdits.length, 2)
    assert.deepEqual(report.dispatched, [])
  }
  assert.deepEqual(sources(), before, 'no source byte changed across ticks with pending edits')
  assert.deepEqual(operation.calls, [], 'the apply operation was never reached')
  assert.deepEqual(world.state('pending-edits.json').edits.map((edit) => [edit.state, edit.attempts]), [['queued', 0], ['queued', 0]])
}

test('manual mode: ticks queue edits and never reach the apply operation or any source file, even with an active policy installed', needsExchange, async (t) => {
  const world = makeWorld(t)
  world.installPolicy()
  const operation = recordingOperation(world)
  const extensions = createMaintenanceExtensions()
  extensions.register('apply-operation', operation)
  await assertTicksNeverWriteSource(world, world.engine({ extensions }), operation)
})

test('mutation control: an engine that dispatches in manual mode fails the source oracle', needsExchange, async (t) => {
  const world = makeWorld(t)
  const policy = world.installPolicy()
  const operation = recordingOperation(world)
  const extensions = createMaintenanceExtensions()
  extensions.register('apply-operation', operation)
  const eager = world.engine({ extensions, primitives: { dispatchAllowed: () => true, authorize: () => ({ authorized: true, reason: 'forced', policy }) } })
  await assert.rejects(assertTicksNeverWriteSource(world, eager, operation), (error) => error instanceof assert.AssertionError && operation.calls.length > 0)
})

// ---------------------------------------------------------------------------
// 9. Automatic mode: typed apply-unavailable, bounded; revocation re-read
// ---------------------------------------------------------------------------

async function assertUnavailableIsTypedAndBounded(world, engine) {
  await engine.tick()
  fs.appendFileSync(world.noteFile('west-wing:tide'), EDITED_TAIL)
  const history = []
  for (let round = 0; round < 8; round += 1) {
    // A tick that may dispatch, a tick inside the retry interval, then the interval passes.
    world.advance(round === 0 || round % 2 === 1 ? 1000 : 60 * 1000)
    const report = await engine.tick()
    const [edit] = world.state('pending-edits.json').edits
    validatePendingEdits(world.state('pending-edits.json'), WORKSPACE_ID)
    history.push([edit.state, edit.attempts, report.dispatched.length])
    assert.notEqual(edit.state, 'applied', 'an operation that does not exist never reports success')
    assert.equal(edit.closedAt, null, 'the edit is pending, not dropped')
    assert.equal(world.scope(report).state, 'held-for-your-edit')
  }
  assert.deepEqual(history, [
    ['apply-unavailable', 1, 1], ['apply-unavailable', 1, 0], ['apply-unavailable', 2, 1], ['apply-unavailable', 2, 0],
    ['retry-exhausted', 3, 1], ['retry-exhausted', 3, 0], ['retry-exhausted', 3, 0], ['retry-exhausted', 3, 0],
  ], 'one attempt per retry interval, and no more than the retry budget allows')
  const [edit] = world.state('pending-edits.json').edits
  assert.equal(edit.retryBudget, 2, 'the budget that bounded it is recorded')
  assert.deepEqual(edit.lastResult, { status: 'apply-unavailable', code: 'no-apply-operation-registered', operationId: UNAVAILABLE_APPLY_OPERATION.id, policyDigest: digest('policy-synthetic-1') })
}

test('automatic mode before an apply operation exists: a typed apply-unavailable pending state, persisted, with a bounded retry budget', needsExchange, async (t) => {
  const world = makeWorld(t, { machine: { maintenanceMode: 'automatic', audienceAllow: ['team'] } })
  world.installPolicy({ retryBudget: 2 })
  await assertUnavailableIsTypedAndBounded(world, world.engine())
})

test('mutation control: an operation that pretends success fails the apply-unavailable oracle', needsExchange, async (t) => {
  const world = makeWorld(t, { machine: { maintenanceMode: 'automatic', audienceAllow: ['team'] } })
  world.installPolicy({ retryBudget: 2 })
  const extensions = createMaintenanceExtensions()
  extensions.register('apply-operation', { id: 'test.pretender', apply: async () => ({ status: 'applied', code: 'pretended' }) })
  await assert.rejects(assertUnavailableIsTypedAndBounded(world, world.engine({ extensions })), /never reports success/)
})

test('an unknown answer from an apply operation is a failure, never success', needsExchange, async (t) => {
  const world = makeWorld(t, { machine: { maintenanceMode: 'automatic', audienceAllow: ['team'] } })
  world.installPolicy({ retryBudget: 0 })
  const extensions = createMaintenanceExtensions()
  extensions.register('apply-operation', { id: 'test.vague', apply: async () => ({ status: 'done', ok: true }) })
  const engine = world.engine({ extensions })
  await engine.tick()
  fs.appendFileSync(world.noteFile('west-wing:tide'), EDITED_TAIL)
  world.advance(1000)
  await engine.tick()
  const [edit] = world.state('pending-edits.json').edits
  assert.equal(edit.state, 'retry-exhausted')
  assert.deepEqual([edit.lastResult.status, edit.lastResult.code], ['failed', 'invalid-apply-result'])
})

// Two edits are queued under manual mode. Automatic mode is then switched on
// with an active policy, and the operation revokes the policy while it handles
// the first edit: the second must not be dispatched.
async function assertRevocationIsReread(world, engine, operation, { revokeBeforeTick }) {
  await engine.tick()
  fs.appendFileSync(world.noteFile('west-wing:tide'), EDITED_TAIL)
  fs.appendFileSync(world.noteFile('east-wing:compass'), EDITED_TAIL)
  world.advance(1000)
  assert.equal((await engine.tick()).pendingEdits.length, 2)
  world.configureMachine({ maintenanceMode: 'automatic' })
  if (revokeBeforeTick) world.installPolicy({ status: 'revoked' })
  world.advance(1000)
  const report = await engine.tick()
  assert.equal(operation.calls.length, revokeBeforeTick ? 0 : 1, 'nothing is dispatched once the policy is revoked')
  assert.equal(report.dispatched.length, operation.calls.length)
  world.advance(FULL_INTERVAL)
  await engine.tick()
  assert.equal(operation.calls.length, revokeBeforeTick ? 0 : 1, 'and nothing on later ticks')
  assert.equal(world.state('pending-edits.json').edits.filter((edit) => edit.state === 'queued').length, revokeBeforeTick ? 2 : 1)
}

for (const revokeBeforeTick of [true, false]) {
  test(`revocation is read again immediately before every dispatch (${revokeBeforeTick ? 'revoked between queue and tick' : 'revoked while the first edit is handled'})`, needsExchange, async (t) => {
    const world = makeWorld(t)
    world.installPolicy()
    const operation = recordingOperation(world, { status: 'conflict', onApply: () => { world.installPolicy({ status: 'revoked' }) } })
    const extensions = createMaintenanceExtensions()
    extensions.register('apply-operation', operation)
    await assertRevocationIsReread(world, world.engine({ extensions }), operation, { revokeBeforeTick })
  })
}

test('mutation control: an engine that authorizes once per tick fails the revocation oracle', needsExchange, async (t) => {
  const world = makeWorld(t)
  world.installPolicy()
  const operation = recordingOperation(world, { status: 'conflict', onApply: () => { world.installPolicy({ status: 'revoked' }) } })
  const extensions = createMaintenanceExtensions()
  extensions.register('apply-operation', operation)
  let remembered = null
  const engine = world.engine({ extensions, primitives: { authorize: (input) => { const fresh = authorizeAutomaticApply(input); if (fresh.authorized) remembered = fresh; return remembered ?? fresh } } })
  await assert.rejects(assertRevocationIsReread(world, engine, operation, { revokeBeforeTick: false }), /nothing is dispatched once the policy is revoked/)
})

test('automatic dispatch needs the mode, an installed reference and an active matching policy', (t) => {
  const world = makeWorld(t, { machine: { maintenanceMode: 'automatic', audienceAllow: ['team'] } })
  const input = { workspaceRoot: workspaceStateRoot(world.dataRoot, WORKSPACE_ID), workspaceId: WORKSPACE_ID }
  assert.equal(authorizeAutomaticApply(input).reason, 'no-apply-policy-installed')
  const policy = world.installPolicy()
  assert.deepEqual(authorizeAutomaticApply(input), { authorized: true, reason: 'apply-policy-active', policy })
  const file = path.join(input.workspaceRoot, 'state', 'settings', 'apply-policy.json')
  fs.writeFileSync(file, JSON.stringify({ ...policy, version: 2 }))
  assert.equal(authorizeAutomaticApply(input).reason, 'apply-policy-reference-mismatch', 'a policy file swapped under the installed reference authorizes nothing')
  fs.writeFileSync(file, JSON.stringify({ ...policy, allowedEditClasses: ['structure-move'] }))
  assert.equal(authorizeAutomaticApply(input).reason, 'apply-policy-invalid')
  fs.rmSync(file)
  assert.equal(authorizeAutomaticApply(input).reason, 'apply-policy-absent')
  for (const status of ['paused', 'revoked']) { world.installPolicy({ status }); assert.equal(authorizeAutomaticApply(input).reason, `apply-policy-${status}`) }
  world.installPolicy({ mode: 'manual' })
  assert.equal(authorizeAutomaticApply(input).reason, 'apply-policy-manual')
  world.installPolicy()
  world.configureMachine({ maintenanceMode: 'manual' })
  assert.equal(authorizeAutomaticApply(input).reason, 'maintenance-mode-manual')
  assert.throws(() => world.installPolicy({ workspaceId: 'ws-another' }), (error) => error.code === 'invalid-apply-policy')
})

// ---------------------------------------------------------------------------
// 10. Late writers
// ---------------------------------------------------------------------------

async function assertLateWriterIsFound(world, engine) {
  await engine.tick()
  fs.appendFileSync(world.source('west-wing/logs/tide.md'), '\nA replacement is published.\n')
  world.advance(1000)
  assert.equal(world.scope(await engine.tick()).state, 'current')
  // The replaced file now sits in recovery. A program that still holds it writes into it, after the publication ended.
  const recovery = path.join(world.workspaceRoot(), 'recovery')
  const [displaced] = Object.keys(listing(recovery)).filter((name) => name.endsWith('displaced.bin'))
  assert.ok(displaced, 'the publication displaced a file')
  const late = 'WRITTEN LATE BY A HOLDER\n'
  fs.writeFileSync(path.join(recovery, displaced), late)
  world.advance(1000)
  const report = await engine.tick()
  assert.equal(report.lateWriters.length, 1)
  const [finding] = world.state('late-writers.json').findings
  assert.equal(finding.notePath, world.notePath('west-wing:tide'))
  assert.equal(finding.observedDigest, digest(late))
  assert.equal(fs.readFileSync(path.join(world.workspaceRoot(), finding.objectRef), 'utf8'), late, 'the late bytes are kept as an immutable object')
  // Reported once, looked at again on every tick.
  world.advance(1000)
  assert.deepEqual((await engine.tick()).lateWriters, [])
  assert.equal(world.state('late-writers.json').findings.length, 1)
}

test('the late-writer check is repeated on ticks: a displaced file written to after publication is detected and recorded', needsExchange, async (t) => {
  const world = makeWorld(t)
  await assertLateWriterIsFound(world, world.engine())
})

test('mutation control: an engine that never looks again fails the late-writer oracle', needsExchange, async (t) => {
  const world = makeWorld(t)
  await assert.rejects(assertLateWriterIsFound(world, world.engine({ seams: { recheckDisplacedFiles: () => [] } })), assert.AssertionError)
})

// ---------------------------------------------------------------------------
// 11. Staging and recovery of an unfinished journal are never touched
// ---------------------------------------------------------------------------

// A publication is killed after staging, which leaves an unfinished journal
// with candidates in staging and in its recovery directory. Ticks that do not
// publish must leave every one of those entries exactly as it is; only new
// immutable objects may appear.
async function assertUnfinishedJournalIsLeftAlone(world, makeEngine, tickOf) {
  let halt = false
  const engine = makeEngine({ seams: { publishView: (input) => DEFAULT.publishView(halt ? { ...input, [CRASH_INJECTION_TEST_SEAM]: { at: 'after-staging', halt: () => { throw new Error('halted after staging') } } } : input) } })
  const tick = tickOf(engine)
  await engine.tick()
  fs.appendFileSync(world.source('west-wing/logs/tide.md'), '\nNever fully published.\n')
  world.advance(1000)
  halt = true
  await assert.rejects(engine.tick(), /halted after staging/)
  halt = false
  assert.equal(world.state('freshness.json').scopes[0].state, 'stale', 'an interrupted publication is not current')

  const areas = () => ({ staging: listing(path.join(world.workspaceRoot(), 'staging')), recovery: listing(path.join(world.workspaceRoot(), 'recovery')) })
  const before = areas()
  assert.ok(Object.keys(before.staging).some((name) => name.endsWith('.candidate')) || Object.keys(before.recovery).some((name) => name.endsWith('.candidate')), 'the unfinished journal left candidates behind')
  world.calls.publishView.length = 0
  // Somebody edits the very note the unfinished publication was going to replace: preserved, and nothing is published over it.
  fs.appendFileSync(world.noteFile('west-wing:tide'), EDITED_TAIL)
  for (let round = 0; round < 4; round += 1) { world.advance(1000); await tick() }
  assert.deepEqual(world.calls.publishView, [], 'these ticks did not publish, so everything seen below is the engine alone')
  const after = areas()
  assert.deepEqual(after.staging, before.staging, 'staging is exactly as the unfinished journal left it')
  for (const [name, value] of Object.entries(before.recovery)) assert.equal(after.recovery[name], value, `recovery entry ${name} is unchanged`)
  const added = Object.keys(after.recovery).filter((name) => !(name in before.recovery))
  assert.ok(added.length > 0 && added.every((name) => /^objects\/[0-9a-f]{64}\.bin$/.test(name)), `only immutable objects were added: ${added}`)
  return engine
}

test('ticks never delete or sweep anything under staging or recovery of an unfinished journal; the publisher later settles it', needsExchange, async (t) => {
  const world = makeWorld(t)
  const engine = await assertUnfinishedJournalIsLeftAlone(world, (options) => world.engine(options), (instance) => () => instance.tick())
  // The edited note goes back, the cadence passes, and the publisher's own restart recovery converges the view.
  const tide = world.noteFile('west-wing:tide')
  fs.writeFileSync(tide, fs.readFileSync(tide, 'utf8').replace(EDITED_TAIL, ''))
  world.advance(FULL_INTERVAL)
  assert.equal(world.scope(await engine.tick()).state, 'current')
  assert.match(fs.readFileSync(world.noteFile('west-wing:tide'), 'utf8'), /Never fully published/)
})

test('mutation control: a tick that sweeps staging fails the staging oracle', needsExchange, async (t) => {
  const world = makeWorld(t)
  const sweeping = (engine) => async () => {
    const report = await engine.tick()
    fs.rmSync(path.join(world.workspaceRoot(), 'staging'), { recursive: true, force: true })
    return report
  }
  await assert.rejects(assertUnfinishedJournalIsLeftAlone(world, (options) => world.engine(options), sweeping), /staging is exactly as the unfinished journal left it/)
})

// ---------------------------------------------------------------------------
// 12. Freshness
// ---------------------------------------------------------------------------

test('freshness: a publisher conflict is reported as such and retried at the full reconciliation cadence, not on every tick', needsExchange, async (t) => {
  const world = makeWorld(t)
  const engine = world.engine()
  await engine.tick()
  const release = acquirePrivateLock(path.join(world.workspaceRoot(), 'state', 'locks', 'scope-whole.lock'))
  fs.appendFileSync(world.source('east-wing/notes/compass.md'), '\nWritten while another publisher holds the view.\n')
  world.advance(1000)
  let entry = world.scope(await engine.tick())
  assert.deepEqual([entry.state, entry.reason, entry.verified], ['publisher-conflict', 'publication-in-progress', false])
  assert.notEqual(entry.generationId, entry.preparedGenerationId)
  release()
  world.calls.publishView.length = 0
  world.advance(1000)
  assert.equal(world.scope(await engine.tick()).state, 'publisher-conflict', 'an ordinary tick with no change does not retry')
  assert.deepEqual(world.calls.publishView, [])
  world.advance(FULL_INTERVAL)
  entry = world.scope(await engine.tick())
  assert.deepEqual([entry.state, entry.reason, entry.verified], ['current', 'published-and-verified', true])
})

test('freshness: a refusal that is not a conflict is stale with its reason; an unfinished view is never current', async (t) => {
  const world = makeWorld(t)
  const refused = { state: 'refused', refusal: { code: 'exchange-unsupported-platform', message: 'stub' }, notes: [], retainedEdits: [], lateWriters: [] }
  const engine = world.engine({ seams: { publishView: async () => refused } })
  const entry = world.scope(await engine.tick())
  assert.deepEqual([entry.state, entry.reason, entry.generationId, entry.verified], ['stale', 'exchange-unsupported-platform', null, false])
  assert.match(entry.preparedGenerationId, /^gen-[0-9a-f]{32}$/)
  const document = world.state('freshness.json')
  validateFreshness(document, WORKSPACE_ID)
  assert.deepEqual(FRESHNESS_STATES, ['current', 'updating', 'held-for-your-edit', 'stale', 'publisher-conflict', 'disabled'])

  // The document itself refuses a `current` that is not an exact, verified generation, and anything unknown.
  const claim = (overrides) => ({ ...document, scopes: [{ ...document.scopes[0], state: 'current', reason: 'claimed', generationId: 'gen-a', preparedGenerationId: 'gen-a', verified: true, heldNotes: [], ...overrides }] })
  validateFreshness(claim({}), WORKSPACE_ID)
  for (const overrides of [{ preparedGenerationId: 'gen-b' }, { verified: false }, { generationId: null, preparedGenerationId: null }, { heldNotes: ['notes/x.md'] }, { state: 'fresh' }, { surprise: 1 }]) {
    assert.throws(() => validateFreshness(claim(overrides), WORKSPACE_ID), (error) => error.code === 'invalid-freshness-state', JSON.stringify(overrides))
  }
  assert.throws(() => validateFreshness(document, 'ws-another'), (error) => error.code === 'invalid-freshness-state')
})

test('mutation control: a publisher stub that claims a commit it did not make is not reported current', async (t) => {
  const world = makeWorld(t)
  const engine = world.engine({ seams: { publishView: async ({ preparedView }) => ({ state: 'committed', generationId: preparedView.manifest.generationId, notes: [], retainedEdits: [], lateWriters: [] }) } })
  const entry = world.scope(await engine.tick())
  assert.notEqual(entry.state, 'current', 'current is read from the trusted manifest and the vault bytes, not from a reply')
  assert.equal(entry.reason, 'committed-generation-differs')
})

test('a pending edit document that does not validate stops the tick; it is preserved, not rebuilt', needsExchange, async (t) => {
  const world = makeWorld(t)
  const engine = world.engine()
  await engine.tick()
  fs.appendFileSync(world.noteFile('west-wing:tide'), EDITED_TAIL)
  world.advance(1000)
  await engine.tick()
  const document = world.state('pending-edits.json')
  const tampered = JSON.stringify({ ...document, edits: [{ ...document.edits[0], state: 'applied' }] })
  fs.writeFileSync(world.stateFile('pending-edits.json'), tampered)
  world.advance(1000)
  const report = await engine.tick()
  assert.deepEqual([report.state, report.refusal.code], ['refused', 'invalid-pending-edits'])
  assert.equal(fs.readFileSync(world.stateFile('pending-edits.json'), 'utf8'), tampered)
  assert.equal(world.state('freshness.json').scopes[0].state, 'stale')
})

// ---------------------------------------------------------------------------
// 13. Determinism
// ---------------------------------------------------------------------------

const STATE_DOCUMENTS = ['freshness.json', 'pending-edits.json', 'path-registry.json']

async function runScript(world) {
  const engine = world.engine()
  await engine.tick()
  fs.appendFileSync(world.noteFile('west-wing:tide'), EDITED_TAIL)
  fs.appendFileSync(world.source('east-wing/notes/compass.md'), '\nDeterministic addition.\n')
  world.advance(1000)
  await engine.tick()
  world.advance(FULL_INTERVAL)
  await engine.tick()
  const documents = Object.fromEntries(STATE_DOCUMENTS.map((name) => [name, fs.readFileSync(world.stateFile(name), 'utf8')]))
  documents['machine.json'] = fs.readFileSync(path.join(world.workspaceRoot(), 'state', 'settings', 'machine.json'), 'utf8')
  return documents
}

function assertSameDocuments(left, right) {
  for (const name of Object.keys(left)) assert.equal(left[name], right[name], `${name} is byte-identical for identical inputs`)
}

test('state documents are deterministic: identical inputs and clock give identical bytes, with no machine path in them', needsExchange, async (t) => {
  const [first, second] = [makeWorld(t), makeWorld(t)]
  const [left, right] = [await runScript(first), await runScript(second)]
  assertSameDocuments(left, right)
  for (const [name, text] of Object.entries(left)) {
    assert.equal(text.includes(first.dir) || text.includes(TMP), false, `${name} carries no absolute path`)
    assert.equal(text, `${JSON.stringify(JSON.parse(text), null, 2)}\n`.replace(/\n$/, '\n'), `${name} is canonical JSON`)
  }
})

test('mutation control: a different clock fails the determinism oracle', needsExchange, async (t) => {
  const [first, second] = [makeWorld(t), makeWorld(t)]
  second.advance(17)
  const [left, right] = [await runScript(first), await runScript(second)]
  assert.throws(() => assertSameDocuments(left, right), assert.AssertionError)
})

// ---------------------------------------------------------------------------
// 14. Extension point and construction
// ---------------------------------------------------------------------------

test('extensions are registered on a value handed to the engine: no shared state, no duplicates, no unknown kinds', async () => {
  const [first, second] = [createMaintenanceExtensions(), createMaintenanceExtensions()]
  assert.equal(first.applyOperation(), UNAVAILABLE_APPLY_OPERATION)
  assert.deepEqual(await UNAVAILABLE_APPLY_OPERATION.apply(), { status: 'apply-unavailable', code: 'no-apply-operation-registered' })
  const operation = { id: 'test.apply', apply: async () => ({ status: 'applied' }) }
  const adapter = { id: 'test.proposals', propose: async () => ({}) }
  assert.equal(first.register('apply-operation', operation), 'test.apply')
  first.register('proposal-adapter', adapter)
  assert.equal(first.applyOperation(), operation)
  assert.equal(first.get('proposal-adapter'), adapter)
  assert.deepEqual(first.describe(), [{ kind: 'apply-operation', id: 'test.apply' }, { kind: 'proposal-adapter', id: 'test.proposals' }])
  assert.equal(second.applyOperation(), UNAVAILABLE_APPLY_OPERATION, 'another registry sees nothing of the first')
  assert.deepEqual(second.describe(), [{ kind: 'apply-operation', id: null }, { kind: 'proposal-adapter', id: null }])
  assert.throws(() => first.register('apply-operation', operation), (error) => error.code === 'extension-already-registered')
  assert.throws(() => second.register('shell-command', operation), (error) => error.code === 'unknown-extension-kind')
  for (const invalid of [null, {}, { id: 'x' }, { id: '', apply() {} }, { apply() {} }]) assert.throws(() => second.register('apply-operation', invalid), (error) => error.code === 'invalid-extension')
})

test('the engine refuses to be built without its seams, and ticks do not overlap', async (t) => {
  const world = makeWorld(t, { ext: null, machine: null })
  assert.throws(() => createMaintenanceEngine({ clock: world.clock, adapterFactory: absentAdapter }), /loadProject/)
  assert.throws(() => createMaintenanceEngine({ loadProject: world.loadProject, adapterFactory: absentAdapter }), /clock/)
  assert.throws(() => createMaintenanceEngine({ loadProject: world.loadProject, clock: world.clock }), /adapterFactory/, 'no default adapter: only the owner of the lifecycle may point the engine at a running app')
  const engine = createMaintenanceEngine({ loadProject: world.loadProject, clock: world.clock, adapterFactory: absentAdapter, dataRoot: world.dataRoot })
  const [one, two] = await Promise.all([engine.tick(), engine.tick()])
  assert.deepEqual([one.state, two.state].sort(), ['busy', 'disabled'])
  const store = createMaintenanceStateStore({ workspaceRoot: world.dataRoot, workspaceId: WORKSPACE_ID })
  assert.equal(store.exists(), false)
})
