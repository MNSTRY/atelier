import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { acquirePrivateLock } from '../src/project/durable-state.mjs'
import { resolveProjectConfig, validateProjectConfigDoc, writeJson } from '../src/project/config.mjs'
import { createEditorAdapter, publishView, resolveExchange } from '../src/projection/obsidian/publication/index.mjs'
import { CRASH_INJECTION_TEST_SEAM } from '../src/projection/obsidian/publication/test-seam.mjs'
import { ENGINE_PRIMITIVES, createMaintenanceEngineForOracleTests } from '../src/runtime/obsidian/engine.mjs'
import { DEFAULT_ELIGIBILITY, assetEligibilityFor, captureSnapshot, createProductionSeams } from '../src/runtime/obsidian/pipeline.mjs'
import { withEligibility } from '../src/projection/obsidian/materialize/index.mjs'
import { LIFECYCLE_PRIMITIVES, serviceStatus, startService, stopService } from '../src/runtime/obsidian/lifecycle.mjs'
import { ENGINE_LOCK_DIRECTORY, LOCK_TICKET_SCHEMA, acquirePrivateGenerationLock, createAbandonmentProof, inspectPrivateGenerationLock, isProcessAlive, machineDigest } from '../src/runtime/obsidian/private-lock.mjs'
import { HEALTH_SCHEMA, authorityOf, probeHealth, requestLoopback } from '../src/runtime/obsidian/service-client.mjs'
import { SERVICE_ENTRY_PATH } from '../src/runtime/obsidian/service-main.mjs'
import { readLastServiceError, readServiceRecord, readServiceSettings, serviceNameFor, servicePaths, writeServiceRecord, writeServiceSettings } from '../src/runtime/obsidian/service-record.mjs'
import { MAX_REQUEST_BYTES, SERVER_PRIMITIVES, createServiceServerForOracleTests } from '../src/runtime/obsidian/service-server.mjs'
import { runMaintenanceService } from '../src/runtime/obsidian/service.mjs'
import { buildStartupAdapter } from '../src/runtime/obsidian/startup-adapters.mjs'
import { TICK_LOOP_PRIMITIVES, createTickLoopForOracleTests } from '../src/runtime/obsidian/tick-loop.mjs'
import {
  DECISIONS, FRESHNESS_STATES, MACHINE_SETTINGS_SCHEMA, ONLY_YOU_AUDIENCES, ObsidianMaintenanceRefusal, UNAVAILABLE_APPLY_OPERATION, authorizeAutomaticApply,
  createFsWatcherFactory, createMaintenanceEngine, createMaintenanceExtensions, createMaintenanceStateStore, defaultDataRoot, defaultMachineSettings, ensureWorkspaceIdentity,
  installApplyPolicy, localPointerPath, protectedRoots, readLocalPointer, readMachineSettings, readObsidianEnablement, resolveDataRoot, validateFreshness, validatePendingEdits,
  withDecision, workspaceStateRoot, writeLocalPointer, writeMachineSettings,
} from '../src/runtime/obsidian/index.mjs'

// Continuous maintenance, on a real filesystem in temporary directories, with
// no app: the editor adapter always reports that no Obsidian runs, so the
// publisher takes its own path. Invented, synthetic content only. No test
// reads or writes a person's data directory: every engine gets a temporary
// data root, and the resolver refuses the platform default under the runner.
//
// The service lifecycle (sections 15 onward) starts real child processes and
// binds real sockets, on 127.0.0.1 and an ephemeral port only. Every child is
// the test entry under test/support/obsidian-maintenance/, whose editor adapter
// reports that no app runs; the production entry is only ever started without
// an adapter, which it refuses. Every PID a test causes is recorded and killed
// in teardown, and the last test of the file asserts that none is left.

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
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
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
    dir, projectDir, dataRoot, configPath, loadProject, env,
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
      return writeMachineSettings({ workspaceRoot: root, workspaceId: pointer.workspaceId, repositoryRoots: protectedRoots(project), settings: { ...(current ?? defaultMachineSettings({ workspaceId: pointer.workspaceId, updatedAt: world.clock().toISOString() })), ...settings, updatedAt: world.clock().toISOString() } })
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
  // With the host's own platform: a real temporary directory is an absolute path only in the host's path flavor.
  const resolved = defaultDataRoot({ platform: process.platform, env: process.platform === 'win32' ? { LOCALAPPDATA: home } : {}, homedir: home })
  assert.ok(resolved.startsWith(home))
  assert.equal(fs.existsSync(resolved), false)
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

// What releases up to 0.2.0-alpha.11 wrote, byte for byte in shape: no remembered decision.
const v1Settings = (fields = {}) => ({ schema: 'atelier-obsidian-machine-settings/v1', workspaceId: WORKSPACE_ID, maintenanceMode: 'manual', audienceAllow: [], applyPolicy: null, updatedAt: '2026-01-05T10:00:00.000Z', ...fields })
const STAMP = Object.freeze({ decidedAt: '2026-01-05T11:00:00.000Z', decidedBy: 'someone', via: 'command' })

test('a v1 machine settings document is read as v2, stays v1 on disk until the next write, and is never written again', (t) => {
  const world = makeWorld(t, { machine: null })
  const root = workspaceStateRoot(world.dataRoot, WORKSPACE_ID)
  const file = path.join(root, 'state', 'settings', 'machine.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const nothingDecided = { audience: null, location: null, loginItem: null, adapter: null }

  // An empty audience list was nobody's decision; a list somebody set is theirs, carried over as one, by nobody known.
  fs.writeFileSync(file, JSON.stringify(v1Settings()))
  assert.deepEqual(readMachineSettings({ workspaceRoot: root, workspaceId: WORKSPACE_ID }), { ...v1Settings(), schema: MACHINE_SETTINGS_SCHEMA, decisions: nothingDecided })
  const v1 = JSON.stringify(v1Settings({ maintenanceMode: 'automatic', audienceAllow: ['team'], applyPolicy: { policyId: 'policy-synthetic', version: 2, digest: digest('p') } }))
  fs.writeFileSync(file, v1)
  const read = readMachineSettings({ workspaceRoot: root, workspaceId: WORKSPACE_ID })
  assert.equal(read.schema, 'atelier-obsidian-machine-settings/v2')
  assert.deepEqual(read.decisions, { ...nothingDecided, audience: { choice: 'custom', unclassified: 'withheld', decidedAt: '2026-01-05T10:00:00.000Z', decidedBy: null, via: 'v1' } }, 'withheld, as they were')
  assert.deepEqual({ mode: read.maintenanceMode, audiences: read.audienceAllow, policy: read.applyPolicy }, { mode: 'automatic', audiences: ['team'], policy: { policyId: 'policy-synthetic', version: 2, digest: digest('p') } })
  assert.equal(fs.readFileSync(file, 'utf8'), v1, 'reading changes nothing on disk')
  assert.deepEqual(authorizeAutomaticApply({ workspaceRoot: root, workspaceId: WORKSPACE_ID }).reason, 'apply-policy-absent', 'a v1 document still authorizes exactly what it did')

  // The next write writes v2, whatever it was handed; a v1 document handed to the writer is carried over the same way.
  const written = writeMachineSettings({ workspaceRoot: root, workspaceId: WORKSPACE_ID, repositoryRoots: [], settings: JSON.parse(v1) })
  assert.deepEqual(written, read)
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(onDisk, read)
  // What a release that knows only v1 checks: its closed shape and its schema name. The v2 document fails both, so such a
  // release refuses it rather than reading settings it does not understand.
  const v1Keys = ['schema', 'workspaceId', 'maintenanceMode', 'audienceAllow', 'applyPolicy', 'updatedAt']
  assert.deepEqual(Object.keys(onDisk).filter((key) => !v1Keys.includes(key)), ['decisions'])
  assert.notEqual(onDisk.schema, 'atelier-obsidian-machine-settings/v1')
  assert.deepEqual(defaultMachineSettings({ workspaceId: WORKSPACE_ID, updatedAt: '2026-01-05T10:00:00.000Z' }), { ...v1Settings(), schema: MACHINE_SETTINGS_SCHEMA, decisions: nothingDecided })

  // A v1 document is as strictly validated as ever: nothing it could not carry before is carried over.
  for (const broken of [v1Settings({ decisions: nothingDecided }), v1Settings({ maintenanceMode: 'always' }), v1Settings({ workspaceId: 'ws-another' })]) {
    fs.writeFileSync(file, JSON.stringify(broken))
    assert.throws(() => readMachineSettings({ workspaceRoot: root, workspaceId: WORKSPACE_ID }), (error) => error.code === 'invalid-machine-settings', JSON.stringify(broken))
  }
})

test('remembered decisions are closed documents: each says what was decided, when, by whom when known, and how', (t) => {
  const world = makeWorld(t, { machine: null })
  const root = workspaceStateRoot(world.dataRoot, WORKSPACE_ID)
  const base = defaultMachineSettings({ workspaceId: WORKSPACE_ID, updatedAt: '2026-01-05T10:00:00.000Z' })
  const decided = withDecision(withDecision(withDecision(withDecision({ ...base, audienceAllow: [...ONLY_YOU_AUDIENCES] }, 'audience', { choice: 'only-you', unclassified: 'shown' }, STAMP),
    'location', { parent: path.join(TMP, 'Atelier') }, { ...STAMP, via: 'question' }), 'loginItem', { choice: 'on' }, { ...STAMP, via: 'defaults', decidedBy: null }), 'adapter', { choice: 'obsidian-cli' }, STAMP)
  assert.deepEqual(DECISIONS, ['audience', 'location', 'loginItem', 'adapter'])
  assert.deepEqual(decided.decisions.location, { parent: path.join(TMP, 'Atelier'), ...STAMP, via: 'question' })
  assert.deepEqual(base.decisions, { audience: null, location: null, loginItem: null, adapter: null }, 'withDecision changes nothing it is handed')
  const written = writeMachineSettings({ workspaceRoot: root, workspaceId: WORKSPACE_ID, repositoryRoots: [], settings: decided })
  assert.deepEqual(readMachineSettings({ workspaceRoot: root, workspaceId: WORKSPACE_ID }), written)

  const decision = (name, change) => ({ ...decided, decisions: { ...decided.decisions, [name]: change(decided.decisions[name]) } })
  const refusals = [
    ['an unknown decision', { ...decided, decisions: { ...decided.decisions, colour: null } }],
    ['a missing decision', { ...decided, decisions: { audience: null, location: null, loginItem: null } }],
    ['an unknown member', decision('adapter', (item) => ({ ...item, surprise: true }))],
    ['a missing member', decision('adapter', ({ choice: _choice, ...rest }) => rest)],
    ['an unknown adapter', decision('adapter', (item) => ({ ...item, choice: 'obsidian-plugin' }))],
    ['an unknown login item answer', decision('loginItem', (item) => ({ ...item, choice: 'yes' }))],
    ['a relative location', decision('location', (item) => ({ ...item, parent: 'Atelier' }))],
    ['a location that is not written plainly', decision('location', (item) => ({ ...item, parent: `${path.join(TMP, 'Atelier')}${path.sep}..${path.sep}Atelier` }))],
    ['a location with a control character', decision('location', (item) => ({ ...item, parent: path.join(TMP, 'At\u0007elier') }))],
    ['an unknown audience answer', decision('audience', (item) => ({ ...item, choice: 'everyone' }))],
    ['"only you" beside another list of audiences', { ...decided, audienceAllow: ['team'] }],
    ['"only you" with sensitive added', { ...decided, audienceAllow: [...ONLY_YOU_AUDIENCES, 'sensitive'] }],
    ['an audience decision that does not say whether unclassified notes are shown', decision('audience', ({ unclassified: _unclassified, ...rest }) => rest)],
    ['an unknown answer about unclassified notes', decision('audience', (item) => ({ ...item, unclassified: 'sometimes' }))],
    ['unclassified notes shown to a list of audiences', { ...decision('audience', (item) => ({ ...item, choice: 'custom' })), audienceAllow: ['private', 'team'] }],
    ['unclassified notes shown to a list that holds every audience of "only you"', decision('audience', (item) => ({ ...item, choice: 'custom' }))],
    ['a time that is not UTC', decision('adapter', (item) => ({ ...item, decidedAt: '2026-01-05 11:00' }))],
    ['a decider that is not an identifier', decision('adapter', (item) => ({ ...item, decidedBy: 'some one' }))],
    ['an unknown source', decision('adapter', (item) => ({ ...item, via: 'guess' }))],
  ]
  for (const [label, settings] of refusals) {
    assert.throws(() => writeMachineSettings({ workspaceRoot: root, workspaceId: WORKSPACE_ID, repositoryRoots: [], settings }), (error) => error.code === 'invalid-machine-settings', label)
  }
  assert.throws(() => withDecision(base, 'colour', { choice: 'red' }, STAMP), TypeError)
  assert.throws(() => withDecision(base, 'audience', { choice: 'only-you', unclassified: 'shown' }, STAMP), (error) => error.code === 'invalid-machine-settings', 'only you needs its audiences')
  // Unclassified notes are shown only to "only you", which may also withhold them; any other list always withholds them.
  assert.equal(withDecision({ ...base, audienceAllow: [...ONLY_YOU_AUDIENCES] }, 'audience', { choice: 'only-you', unclassified: 'withheld' }, STAMP).decisions.audience.unclassified, 'withheld')
  assert.equal(withDecision({ ...base, audienceAllow: ['team'] }, 'audience', { choice: 'custom', unclassified: 'withheld' }, STAMP).decisions.audience.choice, 'custom')
  // "Only you" is every audience of a note but sensitive, which a vault takes only by name.
  assert.deepEqual(ONLY_YOU_AUDIENCES, ['operator', 'private', 'public', 'staff', 'team'])
  assert.equal(ONLY_YOU_AUDIENCES.includes('sensitive'), false)
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

test('a one-note source change prepares one note; the rest of the view is reused through the engine\'s preparation cache', needsExchange, async (t) => {
  const preparations = []
  const builds = []
  const recording = (input) => { const prepared = DEFAULT.prepareView(input); preparations.push({ scopeId: input.scope.scopeId, ...prepared.preparation }); return prepared }
  const recordingBuild = (input) => { const graph = DEFAULT.buildGraph(input); builds.push(graph.fileCensus); return graph }
  const world = makeWorld(t, { ext: settingsOf([FULL_SCOPE, EAST_SCOPE]) })
  const engine = world.engine({ seams: { prepareView: recording, buildGraph: recordingBuild } })
  assert.deepEqual((await engine.tick()).scopes.map((entry) => entry.state), ['current', 'current'])
  assert.deepEqual(builds.splice(0), [{ reused: 0, derived: 3, read: 3 }], 'the engine\'s first build parses every Markdown source')
  assert.deepEqual(preparations.splice(0), [{ scopeId: 'scope-whole', emitted: 4, reused: 0 }, { scopeId: 'scope-east', emitted: 3, reused: 0 }], 'the engine\'s first preparation of a view emits every note')
  fs.appendFileSync(world.source('east-wing/notes/compass.md'), '\nSouth is painted white.\n')
  world.advance(1000)
  const report = await engine.tick()
  assert.deepEqual(report.scopes.map((entry) => entry.state), ['current', 'current'])
  assert.deepEqual(builds.splice(0), [{ reused: 2, derived: 1, read: 1 }], 'one source is opened and parsed again; every other source is known unchanged from the observation index and is not opened')
  assert.deepEqual(preparations.splice(0), [{ scopeId: 'scope-whole', emitted: 1, reused: 3 }, { scopeId: 'scope-east', emitted: 1, reused: 2 }], 'one note is emitted per view; every other note is reused')
  for (const scopeId of ['scope-whole', 'scope-east']) assert.match(fs.readFileSync(world.noteFile('east-wing:compass', scopeId), 'utf8'), /South is painted white/)
  // A retitled note keeps its path; the notes whose relation rows name it are emitted again, and nothing else is.
  fs.writeFileSync(world.source('west-wing/logs/tide.md'), FILES['west-wing/logs/tide.md'].replace('title: "Tide log"', 'title: "Tide ledger"'))
  world.advance(1000)
  await engine.tick()
  assert.deepEqual(builds.splice(0), [{ reused: 2, derived: 1, read: 1 }])
  assert.deepEqual(preparations.splice(0), [{ scopeId: 'scope-whole', emitted: 2, reused: 2 }, { scopeId: 'scope-east', emitted: 0, reused: 3 }], 'the retitled note and the note that supports it, in the view that holds both; the east view only counts that relation as leading outside, so nothing in it changed')
  // Control: an engine whose cache seam yields nothing prepares every view in full, and publishes the same bytes.
  const control = makeWorld(t)
  const uncached = control.engine({ seams: { createGraphCache: () => null, createPreparationCache: () => null, prepareView: recording, buildGraph: recordingBuild } })
  assert.equal(control.scope(await uncached.tick()).state, 'current')
  fs.appendFileSync(control.source('east-wing/notes/compass.md'), '\nSouth is painted white.\n')
  control.advance(1000)
  assert.equal(control.scope(await uncached.tick()).state, 'current')
  assert.deepEqual(builds.splice(0), [{ reused: 0, derived: 3, read: 3 }, { reused: 0, derived: 3, read: 3 }])
  assert.deepEqual(preparations.splice(0), [{ scopeId: 'scope-whole', emitted: 4, reused: 0 }, { scopeId: 'scope-whole', emitted: 4, reused: 0 }])
  assert.equal(fs.readFileSync(control.noteFile('east-wing:compass'), 'utf8'), fs.readFileSync(world.noteFile('east-wing:compass'), 'utf8'))
})

test('a source that changes under an unchanged stat hint is served from the graph cache until the next full reconciliation opens it', needsExchange, async (t) => {
  const builds = []
  const recordingBuild = (input) => { const graph = DEFAULT.buildGraph(input); builds.push(graph.fileCensus); return graph }
  const world = makeWorld(t)
  const lstat = lyingStat()
  const engine = world.engine({ lstat, fullReconciliationIntervalMs: FULL_INTERVAL, seams: { buildGraph: recordingBuild } })
  assert.equal(world.scope(await engine.tick()).state, 'current')
  assert.deepEqual(builds.splice(0), [{ reused: 0, derived: 3, read: 3 }])
  // The compass changes while its stat hint stays frozen; the tide log changes visibly, so the view is rebuilt.
  const compass = world.source('east-wing/notes/compass.md')
  lstat.freeze(compass)
  fs.appendFileSync(compass, '\nSouth is painted white.\n')
  fs.appendFileSync(world.source('west-wing/logs/tide.md'), '\nLow water at six.\n')
  world.advance(1000)
  let report = await engine.tick()
  assert.equal(report.full, false)
  assert.equal(world.scope(report).state, 'current')
  // The trust boundary, stated: the index reports the compass unchanged, the build takes that as the digest of
  // its bytes and does not open it, and the compass note stays one change behind. That is observation's own
  // stat-hint bound, not a new one.
  assert.deepEqual(builds.splice(0), [{ reused: 2, derived: 1, read: 1 }], 'the tide log is opened; the compass, reported unchanged, is served from the cache')
  assert.match(fs.readFileSync(world.noteFile('west-wing:tide'), 'utf8'), /Low water at six/)
  assert.doesNotMatch(fs.readFileSync(world.noteFile('east-wing:compass'), 'utf8'), /South is painted white/)
  // The full reconciliation hashes every file whatever its stat says: the digest that moved opens exactly that source, and the note converges.
  world.advance(FULL_INTERVAL)
  report = await engine.tick()
  assert.equal(report.full, true)
  assert.equal(world.scope(report).state, 'current')
  assert.deepEqual(builds.splice(0), [{ reused: 2, derived: 1, read: 1 }], 'exactly the compass is opened and parsed again')
  assert.match(fs.readFileSync(world.noteFile('east-wing:compass'), 'utf8'), /South is painted white/)
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

// A source apply writes the person's edit into the source. The next prepared note is then byte for byte the note the
// person already has, and a hold against it would never lift.
async function assertAppliedEditLiftsTheHold(world, engine) {
  await engine.tick()
  const file = world.noteFile('west-wing:tide')
  const edited = Buffer.from(fs.readFileSync(file, 'utf8').replace('High water at noon.', 'High water at one.'))
  fs.writeFileSync(file, edited)
  world.advance(1000)
  assert.equal(world.scope(await engine.tick()).state, 'held-for-your-edit')
  // What an apply does to the source, without one: the same replacement in the authored body.
  fs.writeFileSync(world.source('west-wing/logs/tide.md'), fs.readFileSync(world.source('west-wing/logs/tide.md'), 'utf8').replace('High water at noon.', 'High water at one.'))
  world.advance(1000)
  const published = world.scope(await engine.tick())
  assert.equal(published.generationId, published.preparedGenerationId, 'the view that holds the applied edit is published')
  world.advance(1000)
  const settled = world.scope(await engine.tick())
  assert.deepEqual([settled.state, settled.heldNotes], ['current', []])
  assert.deepEqual(fs.readFileSync(file), edited, 'the note the person edited was never rewritten')
  const [edit] = world.state('pending-edits.json').edits
  assert.deepEqual([edit.state, edit.closedAt !== null], ['withdrawn', true], 'the note is at the bytes it was generated with, so the record closes')
  assert.deepEqual(fs.readFileSync(path.join(world.workspaceRoot(), edit.objectRef)), edited, 'the preserved bytes stay')
}

test('an edited note that already holds what the next view would publish is not held against it: the hold lifts and the record closes', needsExchange, async (t) => {
  const world = makeWorld(t)
  await assertAppliedEditLiftsTheHold(world, world.engine())
})

test('mutation control: an engine that ignores what the held note holds now never lifts the hold after the edit reached the source', needsExchange, async (t) => {
  const world = makeWorld(t)
  const blind = world.engine({ primitives: { publicationConflicts: ({ prepared, held, bases }) => ENGINE_PRIMITIVES.publicationConflicts({ prepared, held, bases }) } })
  await assert.rejects(assertAppliedEditLiftsTheHold(world, blind), assert.AssertionError)
})

// The hold is lifted on what the note holds at the moment of the decision. The person types again after the tick
// looked at the vault and before it decides, in a way no stat can show: same size, same time.
async function assertLateEditKeepsTheHold(world, primitives) {
  let editAgain = null
  const engine = world.engine({ primitives, seams: { prepareView: (input) => { const prepared = createProductionSeams().prepareView(input); editAgain?.(); return prepared } } })
  await engine.tick()
  const file = world.noteFile('west-wing:tide')
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('High water at noon.', 'High water at one.'))
  world.advance(1000)
  assert.equal(world.scope(await engine.tick()).state, 'held-for-your-edit')
  fs.writeFileSync(world.source('west-wing/logs/tide.md'), fs.readFileSync(world.source('west-wing/logs/tide.md'), 'utf8').replace('High water at noon.', 'High water at one.'))
  world.advance(1000)
  const again = Buffer.from(fs.readFileSync(file, 'utf8').replace('High water at one.', 'High water at two.'))
  let typedAgain = false
  editAgain = () => {
    if (typedAgain) return
    typedAgain = true
    const { atime, mtime, size } = fs.statSync(file)
    assert.equal(again.length, size)
    fs.writeFileSync(file, again)
    fs.utimesSync(file, atime, mtime)
  }
  world.calls.publishView.length = 0
  const entry = world.scope(await engine.tick())
  assert.equal(typedAgain, true, 'the person typed between the look at the vault and the decision')
  assert.deepEqual([entry.state, entry.reason], ['held-for-your-edit', 'publication-withheld-for-your-edit'])
  assert.deepEqual(world.calls.publishView.filter((scopeId) => scopeId === entry.scopeId), [], 'the publisher is not called for a view whose held note changed again')
  assert.deepEqual(fs.readFileSync(file), again, 'what the person typed last is what the note holds')
}

test('the hold is decided on what the held note holds at that moment: a second edit made after the tick looked at the vault, with the same size and time, keeps the hold and the publisher is not called', needsExchange, async (t) => {
  await assertLateEditKeepsTheHold(makeWorld(t), ENGINE_PRIMITIVES)
})

test('mutation control: an engine that lifts the hold on the digest of its observation index publishes over the second edit', needsExchange, async (t) => {
  await assert.rejects(assertLateEditKeepsTheHold(makeWorld(t), { heldNoteDigest: ({ indexed }) => indexed }), assert.AssertionError)
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

// ---------------------------------------------------------------------------
// 15. The tick loop: no overlap, errors survived, bounded backoff
// ---------------------------------------------------------------------------

const turn = () => new Promise((resolve) => { setImmediate(resolve) })

function handTimers() {
  const pending = []
  return {
    pending,
    setTimer: (fn, delay) => { const handle = { fn, delay }; pending.push(handle); return handle },
    clearTimer: (handle) => { const at = pending.indexOf(handle); if (at >= 0) pending.splice(at, 1) },
    fire() { const handle = pending.shift(); handle.fn(); return handle.delay },
  }
}

async function assertLoopSurvivesAnError(makeLoop) {
  const timers = handTimers()
  const outcomes = []
  let calls = 0
  const loop = makeLoop({
    intervalMs: 1000, maxBackoffMs: 4000, setTimer: timers.setTimer, clearTimer: timers.clearTimer, onOutcome: (outcome) => { outcomes.push(outcome) },
    tick: async () => { calls += 1; if (calls === 2) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }); return { state: 'ticked', call: calls } },
  })
  loop.start()
  await turn()
  assert.deepEqual([calls, timers.pending.map((handle) => handle.delay)], [1, [1000]], 'one tick, then one timer at the interval')
  timers.fire()
  await turn()
  assert.deepEqual([outcomes[1].ok, outcomes[1].error.code, outcomes[1].consecutiveFailures], [false, 'ENOSPC', 1], 'the error is handed over, not thrown away')
  assert.deepEqual(timers.pending.map((handle) => handle.delay), [2000], 'the loop goes on, later')
  timers.fire()
  await turn()
  assert.deepEqual([calls, outcomes[2].ok, outcomes[2].report.call, outcomes[2].consecutiveFailures], [3, true, 3, 0], 'the next tick proceeds')
  assert.deepEqual(timers.pending.map((handle) => handle.delay), [1000], 'one success returns the loop to its interval')
  await loop.stop()
  assert.deepEqual(timers.pending, [], 'a stopped loop leaves no timer')
}

test('the tick loop survives a tick that throws: the error is recorded, the next tick proceeds, and the backoff is bounded', async () => {
  await assertLoopSurvivesAnError((options) => createTickLoopForOracleTests(options))
  const timers = handTimers()
  const loop = createTickLoopForOracleTests({ intervalMs: 1000, maxBackoffMs: 4000, setTimer: timers.setTimer, clearTimer: timers.clearTimer, tick: async () => { throw new Error('always') } })
  loop.start()
  const delays = []
  for (let round = 0; round < 6; round += 1) { await turn(); delays.push(timers.fire()) }
  assert.deepEqual(delays, [2000, 4000, 4000, 4000, 4000, 4000], 'a failure that stays is retried slowly, never in a tight loop and never past the ceiling')
  await loop.stop()
  assert.throws(() => createTickLoopForOracleTests({ tick: async () => {}, intervalMs: 1000, maxBackoffMs: 10 }), TypeError)
})

test('mutation control: a loop that ends on the first error fails the survival oracle', async () => {
  await assert.rejects(assertLoopSurvivesAnError((options) => createTickLoopForOracleTests(options, { ...TICK_LOOP_PRIMITIVES, continuesAfterError: () => false })), assert.AssertionError)
})

async function assertTicksNeverOverlap(makeLoop) {
  const timers = handTimers()
  let inside = 0
  let most = 0
  let calls = 0
  const gates = []
  const loop = makeLoop({
    intervalMs: 1000, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    tick: async () => { calls += 1; const call = calls; inside += 1; most = Math.max(most, inside); await new Promise((resolve) => { gates.push(resolve) }); inside -= 1; return { call } },
  })
  loop.start()
  await turn()
  assert.deepEqual([calls, timers.pending.length], [1, 0], 'no timer runs while a tick is in flight')
  const [first, second] = [loop.tickNow(), loop.tickNow()]
  await turn()
  assert.equal(calls, 1, 'a request during a tick does not start another')
  gates.shift()()
  await turn()
  assert.equal(calls, 2, 'one follow-up tick answers everyone who asked meanwhile')
  gates.shift()()
  assert.deepEqual([(await first).report.call, (await second).report.call], [2, 2], 'and it started after they asked')
  assert.equal(most, 1, 'never two ticks at once')
  const stopping = loop.tickNow()
  await turn()
  const stopped = loop.stop()
  gates.shift()()
  await stopped
  assert.equal((await stopping).report.call, 3, 'stop lets the tick in flight finish')
  assert.deepEqual([(await loop.tickNow()).stopped, timers.pending.length, inside], [true, 0, 0])
}

test('ticks never overlap: the interval, tick-now and stop all wait for the tick in flight', async () => {
  await assertTicksNeverOverlap((options) => createTickLoopForOracleTests(options))
})

test('mutation control: a scheduler that starts a tick on every request fails the overlap oracle', async () => {
  const eager = (options) => { const loop = createTickLoopForOracleTests(options); return { ...loop, tickNow: async () => ({ ok: true, report: await options.tick() }) } }
  await assert.rejects(assertTicksNeverOverlap(eager), assert.AssertionError)
})

// ---------------------------------------------------------------------------
// 16. The private engine lock
// ---------------------------------------------------------------------------

// Every process this suite causes, registered the moment it exists, with the test that caused it and how. A child is
// followed through its handle, never through its PID alone: a PID is reused (quickly, on Windows) once its process is
// gone, so asking at the end of the file whether "that PID" still lives can see somebody else's process. A process is
// declared gone when its own test's teardown saw it gone, and that is remembered.
const SPAWNED = []

// `stillOurs` is for a process known by PID only (a detached service): it says whether that PID is provably still the
// process that was registered. Without that proof a bare PID is never signalled: it may be somebody else's by now.
function registerProcess(t, target, how, stillOurs = () => false) {
  const child = typeof target === 'number' ? null : target
  const pid = child ? child.pid : target
  const known = SPAWNED.find((entry) => entry.pid === pid && !entry.gone)
  if (known) return known
  const entry = { pid, child, how, stillOurs, test: t.name, gone: pid === undefined }
  if (child) child.once('exit', () => { entry.gone = true })
  SPAWNED.push(entry)
  return entry
}

const describeProcess = (entry) => `pid ${entry.pid} (${entry.how}; ${entry.child ? 'followed by its handle' : 'known by PID only'}) started by "${entry.test}"`
const processLives = (entry) => !entry.gone && (entry.child ? entry.child.exitCode === null && entry.child.signalCode === null : isAlive(entry.pid) && entry.stillOurs())

// Ends one process and waits, bounded, for it to be gone: by its handle and the exit event where there is one, by PID otherwise.
async function endProcess(entry, boundMs = 10000) {
  if (!processLives(entry)) { entry.gone = true; return true }
  const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })
  if (entry.child) {
    const exited = new Promise((resolve) => { entry.child.once('exit', resolve) })
    entry.child.kill('SIGKILL')
    await Promise.race([exited, pause(boundMs)])
    if (processLives(entry)) { hardKill(entry.pid); await Promise.race([exited, pause(boundMs)]) }
  } else {
    hardKill(entry.pid)
    const until = Date.now() + boundMs
    while (isAlive(entry.pid) && Date.now() < until) await pause(25)
  }
  entry.gone = !processLives(entry)
  return entry.gone
}
const isAlive = (pid) => { try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' } }
// Never this process: some tests plant a record that names the test process itself as a live, unrelated PID.
const hardKill = (pid) => { if (pid === process.pid) return; try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
const iso = (ms) => new Date(ms).toISOString()

async function waitFor(check, { timeoutMs = 20000, everyMs = 25, label = 'condition' } = {}) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => { setTimeout(resolve, everyMs) })
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => { const { port } = server.address(); server.close(() => resolve(port)) })
  })
}

// A process that does nothing, stands for "some unrelated program" and is killed in teardown.
function sleeper(t) {
  const child = childProcess.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
  const entry = registerProcess(t, child, 'an idle node process standing for an unrelated program')
  t.after(() => endProcess(entry))
  return child
}

const exitedPid = () => childProcess.spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid

async function listenOn(t, port, handler) {
  const server = http.createServer(handler)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port }, resolve) })
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections() }))
  return server
}

const healthOf = (body) => (request, response) => { response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' }); response.end(JSON.stringify(typeof body === 'function' ? body(request) : body)) }

function lockWorld(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(TMP, 'atelier-maintenance-lock-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const directory = path.join(root, ENGINE_LOCK_DIRECTORY)
  const ticket = (overrides = {}) => ({ schema: LOCK_TICKET_SCHEMA, workspaceId: 'ws-lock', purpose: 'maintenance-engine', pid: process.pid, machine: machineDigest(), nonce: randomBytes(16).toString('hex'), acquiredAt: iso(START), service: null, ...overrides })
  return {
    root, directory, ticket,
    plant(generation, document) { fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, `${String(generation).padStart(12, '0')}.json`), typeof document === 'string' ? document : JSON.stringify(document)) },
    // The deadline is short only where a test wants a listener that never answers; a closed port may take seconds to refuse on some platforms.
    acquire: (proveAbandoned = createAbandonmentProof({ probe: (address) => probeHealth({ ...address, timeoutMs: address.port === lockWorld.silentPort ? 400 : 5000 }) })) => acquirePrivateGenerationLock({ workspaceRoot: root, directory, workspaceId: 'ws-lock', purpose: 'maintenance-engine', clock: () => new Date(START), proveAbandoned }),
  }
}

test('the engine lock: one holder, released and pruned, and taken from a dead holder only', async (t) => {
  const lock = lockWorld(t)
  const first = await lock.acquire()
  assert.deepEqual([first.acquired, first.generation], [true, 1])
  const contender = await lock.acquire()
  assert.deepEqual([contender.acquired, contender.reason, contender.holder.pid], [false, 'held-by-this-process', process.pid])
  assert.equal(first.release(), true)
  assert.equal(first.release(), false, 'a release happens once')
  for (let round = 0; round < 5; round += 1) { const held = await lock.acquire(); assert.equal(held.acquired, true); held.release() }
  assert.deepEqual(fs.readdirSync(lock.directory).sort(), ['000000000006.json', '000000000006.released'], 'a lock taken on every tick does not grow')
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(lock.directory, '000000000006.json')).mode & 0o777, 0o600)

  // A holder that never released and whose process is gone. That this one PID is not alive is injected: the PID of a
  // real child that exited can be another live process a moment later, and the lock is then, correctly, kept.
  const gonePid = 2 ** 31 - 2
  const proveAbandoned = createAbandonmentProof({ alive: (pid) => pid !== gonePid && isProcessAlive(pid) })
  lock.plant(9, lock.ticket({ pid: gonePid }))
  const inspected = await inspectPrivateGenerationLock({ directory: lock.directory, workspaceId: 'ws-lock', proveAbandoned })
  assert.deepEqual([inspected.available, inspected.reason], [true, 'holder-process-gone'])
  const taken = await lock.acquire(proveAbandoned)
  assert.deepEqual([taken.acquired, taken.generation], [true, 10])
  taken.release()
})

test('the engine lock left by a real process that exited is taken under the production proof; a PID that is already somebody else keeps it', async (t) => {
  // The one lock test that asks the operating system about a real exited child, and expects PID reuse.
  const reasons = []
  for (let round = 0; round < 8 && !reasons.includes('holder-process-gone'); round += 1) {
    const lock = lockWorld(t)
    lock.plant(1, lock.ticket({ pid: exitedPid() }))
    const inspected = await inspectPrivateGenerationLock({ directory: lock.directory, workspaceId: 'ws-lock' })
    assert.ok(['holder-process-gone', 'live-process-unproven'].includes(inspected.reason), inspected.reason)
    assert.equal(inspected.available, inspected.reason === 'holder-process-gone')
    reasons.push(inspected.reason)
  }
  assert.ok(reasons.includes('holder-process-gone'), `eight PIDs of exited children were all live again: ${reasons.join(', ')}`)
})

async function assertLiveHoldersKeepTheLock(t, acquireWith) {
  const unrelated = sleeper(t)
  const closedPort = await freePort()
  const answering = await freePort()
  const silent = await freePort()
  await listenOn(t, answering, healthOf({ schema: HEALTH_SCHEMA, serviceName: 'atelier-obsidian-ws-lock', workspaceId: 'ws-lock', runtimeId: 'rt-holder', pid: unrelated.pid, host: '127.0.0.1', port: answering, executableDigest: digest('entry') }))
  await listenOn(t, silent, () => { /* accepts, never answers */ })
  lockWorld.silentPort = silent
  const service = (port, runtimeId = 'rt-holder') => ({ host: '127.0.0.1', port, runtimeId })
  const cases = [
    ['a live process that recorded no health address', { pid: unrelated.pid }, false, 'live-process-unproven'],
    ['a service that answers health as itself', { pid: unrelated.pid, service: service(answering) }, false, 'holder-answers-health'],
    ['a service whose address accepts and does not answer in time', { pid: unrelated.pid, service: service(silent) }, false, 'live-process-unproven'],
    ['a holder on another machine', { pid: exitedPid(), machine: 'f'.repeat(64) }, false, 'held-on-another-machine'],
    ['a service whose address is closed: the PID is somebody else now', { pid: unrelated.pid, service: service(closedPort) }, true, null],
    ['a service whose address answers as another runtime', { pid: unrelated.pid, service: service(answering, 'rt-earlier') }, true, null],
  ]
  for (const [label, overrides, acquired, reason] of cases) {
    const lock = lockWorld(t)
    lock.plant(3, lock.ticket(overrides))
    const result = await acquireWith(lock)
    assert.deepEqual([result.acquired, result.reason ?? null], [acquired, reason], label)
    if (result.acquired) result.release()
  }
  for (const [label, plant, reason] of [['an unknown file', (lock) => { lock.plant(1, lock.ticket()); fs.writeFileSync(path.join(lock.directory, 'notes.txt'), 'x') }, 'unknown-lock-file'], ['a malformed ticket', (lock) => lock.plant(2, '{"pid":1}'), 'unreadable-lock-ticket'], ['a ticket of another workspace', (lock) => lock.plant(2, lock.ticket({ workspaceId: 'ws-another', pid: exitedPid() })), 'unreadable-lock-ticket']]) {
    const lock = lockWorld(t)
    plant(lock)
    const before = listing(lock.directory)
    const result = await acquireWith(lock)
    assert.deepEqual([result.acquired, result.reason], [false, reason], label)
    assert.deepEqual(listing(lock.directory), before, `${label} is left for a person, untouched`)
  }
  assert.equal(isAlive(unrelated.pid), true, 'no holder was ever signalled')
}

test('the engine lock is taken from a live holder only with proof: a closed or differently answering service address; everything else needs a person', async (t) => {
  await assertLiveHoldersKeepTheLock(t, (lock) => lock.acquire())
})

test('mutation control: a takeover rule that trusts a PID number alone fails the lock oracle', async (t) => {
  await assert.rejects(assertLiveHoldersKeepTheLock(t, (lock) => lock.acquire(async () => ({ abandoned: true, reason: 'assumed' }))), assert.AssertionError)
})

const REFUSED_PUBLICATION = { state: 'refused', refusal: { code: 'exchange-unsupported-platform', message: 'stub' }, notes: [], retainedEdits: [], lateWriters: [] }

async function assertSecondEngineIsExcluded(world, primitives) {
  let open
  const gate = new Promise((resolve) => { open = resolve })
  let entered
  const inside = new Promise((resolve) => { entered = resolve })
  const first = world.engine({ primitives, seams: { publishView: async () => { entered(); await gate; return REFUSED_PUBLICATION } } })
  const second = world.engine({ primitives, seams: { publishView: async () => REFUSED_PUBLICATION } })
  const running = first.tick()
  await inside
  const stateBefore = listing(path.join(world.workspaceRoot(), 'state', 'maintenance'))
  const report = await second.tick()
  const stateAfter = listing(path.join(world.workspaceRoot(), 'state', 'maintenance'))
  open()
  await running
  assert.deepEqual([report.state, report.reason, report.lock?.reason], ['busy', 'engine-lock-held', 'held-by-this-process'])
  assert.deepEqual(world.calls.publishView.length, 1, 'the excluded engine reached no seam')
  assert.deepEqual(stateAfter, stateBefore, 'and wrote no state while the other engine was ticking')
  assert.equal((await second.tick()).state, 'ticked', 'once the first tick ends the second engine ticks')
}

test('two engines cannot tick one workspace together: the second reports busy and writes nothing', async (t) => {
  await assertSecondEngineIsExcluded(makeWorld(t), ENGINE_PRIMITIVES)
})

test('mutation control: an engine without the lock fails the exclusion oracle', async (t) => {
  await assert.rejects(assertSecondEngineIsExcluded(makeWorld(t), { ...ENGINE_PRIMITIVES, acquireEngineLock: async () => ({ acquired: true, release() {} }) }), assert.AssertionError)
})

// ---------------------------------------------------------------------------
// 17. The listener: four fixed operations, loopback only, credentialed mutation
// ---------------------------------------------------------------------------

function raw({ port, method = 'GET', route = '/health', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path: route, setHost: false, agent: false, headers: { Connection: 'close', ...(body === null ? {} : { 'Content-Length': Buffer.byteLength(body) }), ...headers } }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let parsed = null; try { parsed = JSON.parse(text) } catch { parsed = null } resolve({ statusCode: response.statusCode, text, body: parsed }) })
    })
    request.on('error', reject)
    request.end(body ?? undefined)
  })
}

async function assertOnlyAuthorisedRequestsAct(t, primitives) {
  const port = await freePort()
  const bearer = randomBytes(32).toString('base64url')
  const calls = { status: 0, tick: 0, stop: 0 }
  const identity = { serviceName: 'atelier-obsidian-ws-listener', workspaceId: 'ws-listener', runtimeId: 'rt-listener', pid: process.pid, host: '127.0.0.1', port, executableDigest: digest('entry'), startedAt: iso(START) }
  const listener = createServiceServerForOracleTests({ identity, bearer, operations: { healthStatus: () => 'healthy', status: () => { calls.status += 1; return { ok: true } }, tick: async () => { calls.tick += 1; return { ok: true } }, stop: async () => { calls.stop += 1 } } }, primitives)
  await listener.listen()
  t.after(() => listener.close())
  const Host = authorityOf('127.0.0.1', port)
  const authorised = { Host, Authorization: `Bearer ${bearer}` }
  const named = JSON.stringify({ runtimeId: 'rt-listener' })
  const refused = [
    ['no bearer', { method: 'POST', route: '/stop', headers: { Host }, body: named }, 401],
    ['a wrong bearer', { method: 'POST', route: '/tick', headers: { Host, Authorization: `Bearer ${randomBytes(32).toString('base64url')}` }, body: named }, 401],
    ['the bearer under another scheme', { method: 'POST', route: '/stop', headers: { Host, Authorization: `Basic ${bearer}` }, body: named }, 401],
    ['status without a bearer', { route: '/status', headers: { Host } }, 401],
    ['GET on stop', { route: '/stop', headers: authorised }, 405],
    ['POST on status', { method: 'POST', route: '/status', headers: authorised, body: named }, 405],
    ['DELETE on tick', { method: 'DELETE', route: '/tick', headers: authorised }, 405],
    ['an oversized payload', { method: 'POST', route: '/stop', headers: authorised, body: JSON.stringify({ runtimeId: 'rt-listener', padding: 'x'.repeat(MAX_REQUEST_BYTES) }) }, 413],
    ['a payload that is not JSON', { method: 'POST', route: '/stop', headers: authorised, body: 'stop' }, 400],
    ['a payload naming another runtime', { method: 'POST', route: '/stop', headers: authorised, body: JSON.stringify({ runtimeId: 'rt-earlier' }) }, 409],
    ['a payload with anything else in it', { method: 'POST', route: '/tick', headers: authorised, body: JSON.stringify({ runtimeId: 'rt-listener', command: 'anything' }) }, 400],
    ['a view named on a stop', { method: 'POST', route: '/stop', headers: authorised, body: JSON.stringify({ runtimeId: 'rt-listener', scopeId: 'scope-whole' }) }, 400],
    ['anything else, for another runtime', { method: 'POST', route: '/tick', headers: authorised, body: JSON.stringify({ runtimeId: 'rt-earlier', command: 'anything' }) }, 409],
    ['a hostname in Host', { method: 'POST', route: '/stop', headers: { ...authorised, Host: `localhost:${port}` }, body: named }, 403],
    ['a foreign Host', { method: 'POST', route: '/stop', headers: { ...authorised, Host: `maintenance.invalid:${port}` }, body: named }, 403],
    ['Host without the port', { method: 'POST', route: '/stop', headers: { ...authorised, Host: '127.0.0.1' }, body: named }, 403],
    ['a cross-site Origin', { method: 'POST', route: '/stop', headers: { ...authorised, Origin: 'http://maintenance.invalid' }, body: named }, 403],
    ['Sec-Fetch-Site: cross-site', { method: 'POST', route: '/tick', headers: { ...authorised, 'Sec-Fetch-Site': 'cross-site' }, body: named }, 403],
    ['Sec-Fetch-Site: same-site', { method: 'POST', route: '/tick', headers: { ...authorised, 'Sec-Fetch-Site': 'same-site' }, body: named }, 403],
    ['a cross-site read of health', { route: '/health', headers: { Host, Origin: 'http://maintenance.invalid' } }, 403],
    ['an unknown path', { route: '/files/notes', headers: authorised }, 404],
    ['a query on a known path', { method: 'POST', route: '/stop?force=1', headers: authorised, body: named }, 404],
    ['a path that climbs', { method: 'POST', route: '/../stop', headers: authorised, body: named }, 404],
    ['an evaluation path', { method: 'POST', route: '/eval', headers: authorised, body: named }, 404],
  ]
  for (const [label, request, statusCode] of refused) assert.equal((await raw({ port, ...request })).statusCode, statusCode, label)
  assert.deepEqual(calls, { status: 0, tick: 0, stop: 0 }, 'no refused request reached an operation')

  const health = await raw({ port, headers: { Host } })
  assert.deepEqual([health.statusCode, Object.keys(health.body).sort()], [200, ['executableDigest', 'host', 'pid', 'port', 'runtimeId', 'schema', 'serviceName', 'startedAt', 'status', 'workspaceId']])
  assert.equal(health.text.includes(bearer), false)
  assert.equal((await raw({ port, route: '/status', headers: authorised })).statusCode, 200)
  assert.equal((await raw({ port, method: 'POST', route: '/tick', headers: { ...authorised, Origin: `http://${Host}`, 'Sec-Fetch-Site': 'same-origin' }, body: named })).statusCode, 200)
  assert.deepEqual((await raw({ port, method: 'POST', route: '/stop', headers: authorised, body: named })).body, { stopping: true, runtimeId: 'rt-listener', pid: process.pid })
  await waitFor(() => calls.stop === 1, { label: 'the stop operation' })
  assert.deepEqual(calls, { status: 1, tick: 1, stop: 1 })
}

test('the listener refuses everything but its four operations: credential, method, payload size, Host, Origin and path', async (t) => {
  await assertOnlyAuthorisedRequestsAct(t, SERVER_PRIMITIVES)
  assert.throws(() => createServiceServerForOracleTests({ identity: { host: '0.0.0.0', port: 4000 }, bearer: 'x'.repeat(43), operations: {} }), /literal loopback/)
  assert.throws(() => createServiceServerForOracleTests({ identity: { host: 'localhost', port: 4000 }, bearer: 'x'.repeat(43), operations: {} }), /literal loopback/)
  await assert.rejects(async () => requestLoopback({ host: 'localhost', port: 4000 }), (error) => error.code === 'service-address-not-loopback')
  await assert.rejects(async () => probeHealth({ host: '0.0.0.0', port: 4000 }), (error) => error.code === 'service-address-not-loopback')
  assert.equal(authorityOf('::1', 4000), '[::1]:4000')
})

for (const [label, broken] of [['accepts any bearer', { bearerMatches: () => true }], ['accepts any Host', { hostMatches: () => true }], ['accepts any origin', { originAllowed: () => true }], ['reads payloads of any size', { maxRequestBytes: 1024 * 1024 }]]) {
  test(`mutation control: a listener that ${label} fails the request oracle`, async (t) => {
    await assert.rejects(assertOnlyAuthorisedRequestsAct(t, { ...SERVER_PRIMITIVES, ...broken }), assert.AssertionError)
  })
}

// ---------------------------------------------------------------------------
// 18. The service, in this process: health, status, tick errors, consent
// ---------------------------------------------------------------------------

const REPOSITORY_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const TEST_SERVICE_ENTRY = path.join(REPOSITORY_ROOT, 'test', 'support', 'obsidian-maintenance', 'service-entry.mjs')
const TEST_LAUNCHER = path.join(REPOSITORY_ROOT, 'test', 'support', 'obsidian-maintenance', 'launcher.mjs')
const CONSENT = { actor: 'test-suite', coverage: 'service' }
const IDLE_INTERVAL = 60 * 60 * 1000

function writeSettings(world, port, coverage = 'service') {
  return writeServiceSettings({ workspaceRoot: world.workspaceRoot(), workspaceId: WORKSPACE_ID, settings: { schema: 'atelier-obsidian-service-settings/v1', workspaceId: WORKSPACE_ID, host: '127.0.0.1', port, consent: { grantedAt: iso(START), actor: CONSENT.actor, coverage }, updatedAt: iso(START) } })
}

const recordOf = (world) => readServiceRecord({ workspaceRoot: world.workspaceRoot(), workspaceId: WORKSPACE_ID })
const callService = (record, method, route, payload = null) => requestLoopback({ host: record.host, port: record.port, method, path: route, bearer: record.ext.bearer, payload, timeoutMs: 30000 })
const tickService = (record) => callService(record, 'POST', '/tick', { runtimeId: record.runtimeId })

async function inProcessService(t, world, options = {}) {
  const port = await freePort()
  writeSettings(world, port, options.coverage)
  const { coverage: _coverage, engineOptions = {}, ...rest } = options
  const service = await runMaintenanceService({
    loadProject: world.loadProject, dataRoot: world.dataRoot, env: world.env, adapterFactory: absentAdapter, entryPath: TEST_SERVICE_ENTRY, intervalMs: IDLE_INTERVAL, clock: world.clock,
    engineOptions: { quietPeriodMs: 0, watcherFactory: () => ({ close() {} }), ...engineOptions }, ...rest,
  })
  t.after(() => service.shutdown('test-teardown'))
  return { service, port, record: recordOf(world) }
}

function assertNothingSensitive(world, texts, bearer) {
  const forbidden = [world.dir, TMP, os.homedir(), process.execPath, REPOSITORY_ROOT, 'Lantern', 'Compass', 'Tide', 'notes/', 'logs/', '.md', 'east-wing', 'west-wing', 'sounding']
  // A path inside JSON text has its backslashes doubled, so the raw form alone would miss a Windows path. Each word is
  // looked for raw, as JSON writes it and with forward slashes, in the text and in every key and string value it parses to.
  const forms = (word) => [...new Set([word, JSON.stringify(word).slice(1, -1), word.replaceAll('\\', '/')])]
  const strings = (value) => (typeof value === 'string' ? [value] : value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...strings(item)]) : [])
  for (const [label, text] of Object.entries(texts)) {
    let parsed = null
    try { parsed = JSON.parse(text) } catch { parsed = null }
    const haystacks = [text, ...strings(parsed), ...strings(parsed).map((item) => item.replaceAll('\\', '/'))]
    for (const word of forbidden) assert.equal(haystacks.some((haystack) => forms(word).some((form) => haystack.includes(form))), false, `${label} carries "${word}"`)
  }
  assert.equal(texts.health.includes(bearer), false, 'health never carries the bearer')
}

test('health echoes service name, workspace, runtime identifier and PID and nothing sensitive; status summarises without a path or a title', async (t) => {
  const world = makeWorld(t)
  const { service, port, record } = await inProcessService(t, world, EXCHANGE_HERE ? {} : { engineOptions: { seams: { publishView: async () => REFUSED_PUBLICATION } } })
  await service.tickNow()
  if (EXCHANGE_HERE) {
    // A held note, so that status has a held path it must not show.
    fs.appendFileSync(world.noteFile('west-wing:tide'), EDITED_TAIL)
    fs.appendFileSync(world.source('west-wing/logs/tide.md'), '\nA line added at the source.\n')
    world.advance(1000)
    assert.equal((await tickService(record)).body.scopes[0].state, 'held-for-your-edit')
  }
  const health = await raw({ port, headers: { Host: authorityOf('127.0.0.1', port) } })
  assert.deepEqual(
    { ...health.body, startedAt: null },
    { schema: HEALTH_SCHEMA, serviceName: serviceNameFor(WORKSPACE_ID), workspaceId: WORKSPACE_ID, runtimeId: record.runtimeId, pid: process.pid, host: '127.0.0.1', port, executableDigest: digest(fs.readFileSync(TEST_SERVICE_ENTRY)), startedAt: null, status: 'healthy' },
  )
  const status = await callService(record, 'GET', '/status')
  assert.deepEqual([status.statusCode, status.body.service.runtimeId, status.body.freshness.scopes.map((scope) => scope.scopeId)], [200, record.runtimeId, ['scope-whole']])
  if (EXCHANGE_HERE) assert.deepEqual([status.body.freshness.scopes[0].heldNoteCount, 'heldNotes' in status.body.freshness.scopes[0]], [1, false], 'held notes are counted, not named')
  const ticked = await tickService(record)
  assertNothingSensitive(world, { health: health.text, status: JSON.stringify(status.body), tick: JSON.stringify(ticked.body) }, record.ext.bearer)
  assert.equal(JSON.stringify(status.body).includes(record.ext.bearer), false)

  // The record: the contract's shape, owner-only, in private state, outside the project and every vault.
  const file = servicePaths(world.workspaceRoot()).record
  assert.deepEqual([record.schema, record.host, record.serviceName, record.stateLocation, record.consent.actor, record.executable.path], ['atelier-obsidian-service-state/v1', '127.0.0.1', serviceNameFor(WORKSPACE_ID), path.join(world.workspaceRoot(), 'state'), CONSENT.actor, fs.realpathSync(TEST_SERVICE_ENTRY)])
  assert.match(record.ext.bearer, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(file.startsWith(world.projectDir) || file.startsWith(path.join(world.workspaceRoot(), 'vaults')), false)
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700)
  }
})

test('mutation control: a health answer that names a path fails the disclosure oracle', (t) => {
  const world = makeWorld(t)
  // A Windows path, on every platform: JSON doubles its backslashes, and a leak may also arrive with forward slashes.
  const windows = { dir: 'C:\\synthetic\\world' }
  for (const leaked of ['C:\\synthetic\\world\\state', 'C:/synthetic/world/state']) {
    assert.throws(() => assertNothingSensitive(windows, { health: JSON.stringify({ stateLocation: leaked }) }, 'unused'), assert.AssertionError, leaked)
    assert.throws(() => assertNothingSensitive(windows, { health: '{}', status: JSON.stringify({ [leaked]: 1 }) }, 'unused'), assert.AssertionError, leaked)
  }
  assert.throws(() => assertNothingSensitive(world, { health: JSON.stringify({ stateLocation: world.workspaceRoot() }) }, 'unused'), assert.AssertionError)
  assert.throws(() => assertNothingSensitive(world, { health: '{}', status: JSON.stringify({ heldNotes: ['notes/Tide log--0123456789ab.md'] }) }, 'unused'), assert.AssertionError)
})

test('unauthorised requests to the running service change nothing: no tick, no stop, no file', async (t) => {
  const world = makeWorld(t)
  const { service, port, record } = await inProcessService(t, world, { engineOptions: { seams: { publishView: async () => REFUSED_PUBLICATION } } })
  await service.tickNow()
  const Host = authorityOf('127.0.0.1', port)
  const named = JSON.stringify({ runtimeId: record.runtimeId })
  const before = { files: listing(world.dir), ticks: (await callService(record, 'GET', '/status')).body.loop.ticks }
  const attempts = [
    { method: 'POST', route: '/stop', headers: { Host }, body: named },
    { method: 'POST', route: '/tick', headers: { Host, Authorization: `Bearer ${randomBytes(32).toString('base64url')}` }, body: named },
    { method: 'GET', route: '/stop', headers: { Host, Authorization: `Bearer ${record.ext.bearer}` } },
    { method: 'POST', route: '/stop', headers: { Host, Authorization: `Bearer ${record.ext.bearer}` }, body: JSON.stringify({ runtimeId: record.runtimeId, padding: 'x'.repeat(MAX_REQUEST_BYTES) }) },
    { method: 'POST', route: '/stop', headers: { Host: `maintenance.invalid:${port}`, Authorization: `Bearer ${record.ext.bearer}` }, body: named },
    { method: 'POST', route: '/tick', headers: { Host, Authorization: `Bearer ${record.ext.bearer}`, Origin: 'http://maintenance.invalid' }, body: named },
  ]
  for (const attempt of attempts) assert.ok((await raw({ port, ...attempt })).statusCode >= 400, JSON.stringify(attempt.route))
  const status = await callService(record, 'GET', '/status')
  assert.deepEqual([status.body.service.status, status.body.loop.ticks, status.body.loop.stopped], ['healthy', before.ticks, false])
  assert.deepEqual(listing(world.dir), before.files, 'nothing was created, changed or removed')
})

async function assertTickErrorIsSurvived(t, world, createEngine) {
  const failing = { on: true }
  const seams = { buildGraph: (input) => { if (failing.on) throw Object.assign(new Error(`ENOSPC: no space left on device, write '${path.join(world.dir, 'somewhere')}'`), { code: 'ENOSPC' }); return DEFAULT.buildGraph(input) }, publishView: async () => REFUSED_PUBLICATION }
  const lines = []
  const { service, record } = await inProcessService(t, world, { engineOptions: { seams }, log: (entry) => lines.push(entry), ...(createEngine ? { createEngine } : {}) })
  const failed = await waitFor(async () => { const { body } = await callService(record, 'GET', '/status'); return body.lastTick?.state === 'failed' ? body : null }, { label: 'the failed tick' })
  assert.deepEqual([failed.service.status, failed.lastError.code, failed.lastError.consecutiveFailures, failed.lastError.resolvedAt, failed.loop.stopped], ['degraded', 'ENOSPC', 1, null, false])
  const persisted = readLastServiceError({ workspaceRoot: world.workspaceRoot(), workspaceId: WORKSPACE_ID })
  assert.deepEqual([persisted.code, persisted.name, persisted.runtimeId, persisted.totalFailures], ['ENOSPC', 'Error', record.runtimeId, 1], 'the last error is persisted in private state')
  if (process.platform !== 'win32') assert.equal(fs.statSync(servicePaths(world.workspaceRoot()).lastError).mode & 0o777, 0o600)
  assert.equal(JSON.stringify([failed, persisted]).includes(world.dir), false, 'the message, which carries a path, goes to the private log only')
  assert.ok(lines.some((line) => line.event === 'tick-failed' && line.message.includes('ENOSPC')))

  failing.on = false
  world.advance(1000)
  const next = await tickService(record)
  assert.deepEqual([next.statusCode, next.body.ok, next.body.state], [200, true, 'ticked'], 'the next tick proceeds')
  const after = (await callService(record, 'GET', '/status')).body
  assert.deepEqual([after.service.status, after.lastError.code, after.lastError.consecutiveFailures, after.lastError.resolvedAt !== null], ['healthy', 'ENOSPC', 0, true])
  return service
}

test('a tick error nobody typed (ENOSPC inside a seam) is recorded in private state and the next tick proceeds', async (t) => {
  await assertTickErrorIsSurvived(t, makeWorld(t))
})

test('mutation control: an engine that a thrown error poisons fails the tick-error oracle', async (t) => {
  const poisonable = (options) => {
    const engine = createMaintenanceEngine(options)
    let poisoned = false
    return { stop: () => engine.stop(), tick: async () => { if (poisoned) throw new Error('still broken'); try { return await engine.tick() } catch (error) { poisoned = true; throw error } } }
  }
  await assert.rejects(assertTickErrorIsSurvived(t, makeWorld(t), poisonable), assert.AssertionError)
})

test('the service refuses without its adapter, without settings, under a startup it has no consent for, and beside a running runtime', async (t) => {
  const world = makeWorld(t)
  const base = { loadProject: world.loadProject, dataRoot: world.dataRoot, env: world.env, entryPath: TEST_SERVICE_ENTRY, intervalMs: IDLE_INTERVAL }
  await assert.rejects(runMaintenanceService(base), /adapterFactory/, 'no default adapter: only whoever starts the service may point it at a running app')
  await assert.rejects(runMaintenanceService({ ...base, adapterFactory: absentAdapter }), (error) => error.code === 'service-settings-absent')
  const port = await freePort()
  writeSettings(world, port, 'service')
  await assert.rejects(runMaintenanceService({ ...base, adapterFactory: absentAdapter, startup: true }), (error) => error.code === 'startup-consent-absent')
  assert.equal((await probeHealth({ host: '127.0.0.1', port })).kind, 'refused', 'a refused service never listened')
  assert.equal(recordOf(world), null)

  const running = await inProcessService(t, world, { engineOptions: { seams: { publishView: async () => REFUSED_PUBLICATION } } })
  await assert.rejects(runMaintenanceService({ ...base, adapterFactory: absentAdapter }), (error) => error.code === 'service-already-running')
  assert.equal(recordOf(world).runtimeId, running.record.runtimeId, 'the running runtime keeps its record')

  // The production entry, started the only way a test ever starts it: without an adapter. It refuses before it listens or ticks.
  const other = makeWorld(t)
  const before = listing(other.dir)
  for (const extra of [[], ['--adapter=anything-else']]) {
    const result = childProcess.spawnSync(process.execPath, [SERVICE_ENTRY_PATH, `--project=${other.configPath}`, `--data-root=${other.dataRoot}`, ...extra], { env: other.env, encoding: 'utf8', windowsHide: true })
    assert.deepEqual([result.status, /service-adapter-not-selected/.test(result.stdout)], [2, true])
  }
  assert.deepEqual(listing(other.dir), before)
})

// ---------------------------------------------------------------------------
// 19. Lifecycle: start / status / stop with real processes
// ---------------------------------------------------------------------------

// A world whose services are real children. Every PID is recorded the moment it exists and killed in teardown, pass or fail.
function serviceWorld(t, options) {
  const mine = []
  let world = null
  // Teardown, pass or fail: a service the record still names is asked to stop as its owner would; then every process of
  // this test is ended by its handle (or by PID where only a PID is known) and awaited. Registered before the world, so
  // it does not matter in which order the runner calls the hooks: the directory removal retries.
  t.after(async () => {
    if (world === null) return
    try { const record = recordOf(world); if (record && record.pid !== process.pid && isAlive(record.pid)) mine.push(registerProcess(t, record.pid, 'the service named by the record at teardown', namedByRecord(record.pid))) } catch { /* no usable record */ }
    if (mine.some(processLives)) try { await stopService({ loadProject: world.loadProject, dataRoot: world.dataRoot, env: world.env, stopTimeoutMs: 5000 }) } catch { /* ended below */ }
    for (const entry of mine) await endProcess(entry)
  })
  // A service removes its record on its way out, so a record that still names the PID is the proof that the PID is still that service.
  const namedByRecord = (pid) => () => { try { return recordOf(world)?.pid === pid } catch { return false } }
  world = makeWorld(t, options)
  const spawned = []
  const spawn = (...args) => { const child = childProcess.spawn(...args); mine.push(registerProcess(t, child, `spawned by startService: ${path.basename(String(args[1]?.[0]))}${args[2]?.detached ? ', detached' : ''}`)); spawned.push(child.pid); return child }
  const base = { loadProject: world.loadProject, dataRoot: world.dataRoot, env: world.env, entryPath: TEST_SERVICE_ENTRY, intervalMs: IDLE_INTERVAL, spawn }
  const kills = []
  return Object.assign(world, {
    spawned, kills,
    track(target, how) { const entry = registerProcess(t, target, how, typeof target === 'number' ? namedByRecord(target) : undefined); mine.push(entry); return entry },
    start: (extra = {}, rules) => startService({ ...base, consent: CONSENT, ...extra }, rules),
    status: (extra = {}, rules) => serviceStatus({ ...base, ...extra }, rules),
    stop: (extra = {}, rules) => stopService({ ...base, stopTimeoutMs: 20000, kill: (...args) => { kills.push(args) }, ...extra }, rules),
    areas: () => ({ staging: listing(path.join(world.workspaceRoot(), 'staging')), recovery: listing(path.join(world.workspaceRoot(), 'recovery')) }),
    async settled(record) { return waitFor(async () => { const { body } = await callService(record, 'GET', '/status'); return body && body.loop.ticks >= 1 && !body.loop.ticking ? body : null }, { label: 'the first tick of the service' }) },
    // A record nobody's service wrote, for a PID and a port the test chooses.
    plantRecord({ port, pid, runtimeId = 'rt-planted' }) {
      writeSettings(world, port)
      return writeServiceRecord({
        workspaceRoot: world.workspaceRoot(), workspaceId: WORKSPACE_ID,
        record: {
          schema: 'atelier-obsidian-service-state/v1', contractVersion: '1.0.0', workspaceId: WORKSPACE_ID, serviceName: serviceNameFor(WORKSPACE_ID), host: '127.0.0.1', port, runtimeId, pid,
          executable: { path: fs.realpathSync(TEST_SERVICE_ENTRY), digest: digest(fs.readFileSync(TEST_SERVICE_ENTRY)) }, stateLocation: path.join(world.workspaceRoot(), 'state'),
          health: { status: 'healthy', checkedAt: iso(START) }, consent: { grantedAt: iso(START), ...CONSENT }, ext: { bearer: randomBytes(32).toString('base64url') },
        },
      })
    },
  })
}

const healthFor = (record, overrides = {}) => ({ schema: HEALTH_SCHEMA, serviceName: record.serviceName, workspaceId: record.workspaceId, runtimeId: record.runtimeId, pid: record.pid, host: record.host, port: record.port, executableDigest: record.executable.digest, startedAt: iso(START), status: 'healthy', ...overrides })

async function assertStartIsIdempotent(t, rules) {
  const world = serviceWorld(t)
  const [first, concurrent] = await Promise.all([world.start({}, rules), world.start({}, rules)])
  assert.deepEqual([first.state, concurrent.state, [first.started, concurrent.started].sort(), world.spawned.length], ['healthy', 'healthy', [false, true], 1], 'two starts at once create one service')
  assert.equal(first.record.runtimeId, concurrent.record.runtimeId)
  const again = await world.start({}, rules)
  assert.deepEqual([again.started, again.alreadyRunning, again.record.runtimeId, again.record.pid, world.spawned.length], [false, true, first.record.runtimeId, first.record.pid, 1], 'a later start reports the running service and creates nothing')
  assert.equal((await world.stop()).stopped, true)
}

test('start is idempotent: two starts at once and a later start all end with one service', async (t) => {
  await assertStartIsIdempotent(t, LIFECYCLE_PRIMITIVES)
})

test('mutation control: a start that does not recognise its own running service fails the idempotence oracle', async (t) => {
  await assert.rejects(assertStartIsIdempotent(t, { ...LIFECYCLE_PRIMITIVES, isOurs: () => false }), assert.AssertionError)
})

test('start needs consent and a literal loopback address, the record is owner-only, a second service process refuses, and stop removes only the generated record', async (t) => {
  const world = serviceWorld(t)
  await assert.rejects(world.start({ consent: undefined }), (error) => error.code === 'startup-consent-required', 'the first start needs an explicit consent')
  await assert.rejects(world.start({ host: 'localhost' }), (error) => error.code === 'service-address-not-loopback')
  await assert.rejects(world.start({ host: '0.0.0.0' }), (error) => error.code === 'service-address-not-loopback')
  assert.deepEqual([(await world.status()).state, world.spawned.length], ['stopped', 0])

  const first = await world.start()
  const again = await world.status()
  assert.equal(JSON.stringify([first, again]).includes(recordOf(world).ext.bearer), false, 'what start and status return never carries the bearer')

  const record = recordOf(world)
  const settings = readServiceSettings({ workspaceRoot: world.workspaceRoot(), workspaceId: WORKSPACE_ID })
  assert.deepEqual([record.host, record.port, record.pid, settings.consent.actor], ['127.0.0.1', settings.port, world.spawned[0], CONSENT.actor])
  assert.deepEqual([(await world.status()).state, (await world.status()).health.runtimeId], ['healthy', record.runtimeId])
  if (process.platform !== 'win32') for (const file of [servicePaths(world.workspaceRoot()).record, servicePaths(world.workspaceRoot()).settings, servicePaths(world.workspaceRoot()).log]) assert.equal(fs.statSync(file).mode & 0o777, 0o600, file)

  // A second service process for the same workspace, started by hand, refuses; the running one keeps its record.
  const intruder = childProcess.spawnSync(process.execPath, [TEST_SERVICE_ENTRY, `--project=${world.configPath}`, `--data-root=${world.dataRoot}`, '--runtime-id=rt-intruder'], { env: world.env, encoding: 'utf8', windowsHide: true })
  assert.deepEqual([intruder.status, /service-already-running/.test(intruder.stdout), recordOf(world).runtimeId], [2, true, record.runtimeId])

  await world.settled(record)
  if (EXCHANGE_HERE) {
    fs.appendFileSync(world.noteFile('west-wing:tide'), EDITED_TAIL)
    assert.equal((await tickService(record)).body.ok, true)
    assert.equal(world.state('pending-edits.json').edits.length, 1, 'a draft is pending when the service stops')
  }
  const kept = () => ({ ...world.areas(), vaults: listing(path.join(world.workspaceRoot(), 'vaults')), maintenance: listing(path.join(world.workspaceRoot(), 'state', 'maintenance')), service: listing(servicePaths(world.workspaceRoot()).directory) })
  const before = kept()
  const stopped = await world.stop()
  assert.deepEqual([stopped.state, stopped.stopped, stopped.refused, stopped.pid], ['stopped', true, false, record.pid])
  await waitFor(() => !isAlive(record.pid), { label: 'the stopped service to be gone' })
  const after = kept()
  const { 'runtime.json': _record, ...serviceWithoutRecord } = before.service
  // The log gains the two lines of the shutdown; everything else is byte-identical.
  assert.deepEqual({ ...after, service: { ...after.service, 'service.log': null } }, { ...before, service: { ...serviceWithoutRecord, 'service.log': null } }, 'stop removed the generated record and nothing else: drafts, pending edits, recovery and staging are intact')
  assert.deepEqual(world.kills, [], 'a clean stop signals nothing')
  assert.deepEqual([(await world.status()).state, (await world.stop()).stopped, (await world.stop()).refused], ['stopped', false, false])

  const restarted = await world.start({ consent: undefined })
  assert.deepEqual([restarted.started, restarted.record.port, restarted.record.runtimeId !== record.runtimeId], [true, record.port, true], 'the recorded port and consent are reused')
  assert.equal((await world.stop()).stopped, true)
})

async function assertServiceOutlivesItsLauncher(t, launcherArgs = []) {
  const world = serviceWorld(t)
  const launcher = childProcess.spawn(process.execPath, [TEST_LAUNCHER, `--project=${world.configPath}`, `--data-root=${world.dataRoot}`, ...launcherArgs], { env: world.env, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true })
  world.track(launcher, 'the launching command')
  let output = ''
  launcher.stdout.on('data', (chunk) => { output += chunk })
  // `close`, not `exit`: the launcher's output is complete only once its pipe has closed.
  const code = await new Promise((resolve) => { launcher.once('close', resolve) })
  const reported = JSON.parse(output)
  if (reported.pid) world.track(reported.pid, 'the detached service the launching command reported')
  assert.deepEqual([code, reported.state, reported.started], [0, 'healthy', true])
  assert.equal(isAlive(launcher.pid), false, 'the launching command is gone')
  const status = await world.status()
  assert.equal(status.state, 'healthy', 'the service outlived the command that started it')
  assert.deepEqual([status.health.pid, status.health.runtimeId, isAlive(reported.pid)], [reported.pid, reported.runtimeId, true])
  assert.equal((await world.start()).alreadyRunning, true, 'and another command finds it, idempotently')
  assert.equal((await world.stop()).stopped, true)
  await waitFor(() => !isAlive(reported.pid), { label: 'the detached service to be gone' })
}

test('start survives the launching command: the launcher exits and the service stays healthy', async (t) => {
  await assertServiceOutlivesItsLauncher(t)
})

test('mutation control: a service that ends with its launcher fails the survival oracle', async (t) => {
  await assert.rejects(assertServiceOutlivesItsLauncher(t, ['--stop-before-exit']), assert.AssertionError)
})

async function assertUnownedListenerIsLeftAlone(t, rules) {
  const world = serviceWorld(t)
  for (const [label, handler, answer] of [['a plain web server', (request, response) => { response.end('hello') }, 'foreign'], ['a listener that accepts and never answers', () => {}, 'timeout']]) {
    const port = await freePort()
    writeSettings(world, port)
    const requests = []
    const server = await listenOn(t, port, (request, response) => { requests.push(`${request.method} ${request.url}`); handler(request, response) })
    const status = await world.status({ probeTimeoutMs: 400 }, rules)
    assert.deepEqual([status.state, status.reason, status.answer], ['occupied', 'a-listener-without-a-record', answer], label)
    await assert.rejects(world.start({ probeTimeoutMs: 400, startTimeoutMs: 8000 }, rules), (error) => error.code === 'service-port-occupied', label)
    const stopped = await world.stop({ probeTimeoutMs: 400 }, rules)
    assert.deepEqual([stopped.state, stopped.stopped, stopped.refused], ['occupied', false, true], label)
    assert.deepEqual([world.spawned.length, world.kills.length, server.listening, recordOf(world)], [0, 0, true, null], `${label}: nothing was started, signalled or recorded`)
    assert.equal(requests.every((line) => line === 'GET /health'), true, 'only health was ever asked of it')
  }
}

test('when health never proves ownership, start stops only the child it created and reports the private log', async (t) => {
  const world = serviceWorld(t)
  const unrelated = sleeper(t)
  const result = await world.start({ entryPath: path.join(REPOSITORY_ROOT, 'test', 'support', 'obsidian-maintenance', 'idle-entry.mjs'), startTimeoutMs: 2500 })
  assert.deepEqual([result.state, result.started, result.reason, result.logPath], ['start-failed', false, 'health-never-proved-ownership', servicePaths(world.workspaceRoot()).log])
  assert.match(fs.readFileSync(result.logPath, 'utf8'), /idle entry: alive/, 'the log is where the child wrote')
  await waitFor(() => !isAlive(world.spawned[0]), { label: 'the child that start created to be gone' })
  assert.deepEqual([world.spawned.length, isAlive(unrelated.pid), recordOf(world), (await world.status()).state], [1, true, null, 'stopped'], 'only that child was stopped, and no record was left')
})

test('an unowned listener on the port is occupied: status does not adopt it, start does not take it over, stop does not touch it', async (t) => {
  await assertUnownedListenerIsLeftAlone(t, LIFECYCLE_PRIMITIVES)
})

test('mutation control: a start that goes ahead on an occupied port fails the unowned-listener oracle', async (t) => {
  await assert.rejects(assertUnownedListenerIsLeftAlone(t, { ...LIFECYCLE_PRIMITIVES, refusesOccupied: () => false }), assert.AssertionError)
})

async function assertWrongIdentityIsNeverOurs(t, rules) {
  const variants = { runtimeId: 'rt-somebody-else', pid: 1, workspaceId: 'ws-another', serviceName: 'atelier-obsidian-ws-another', executableDigest: digest('another executable'), host: '::1', port: 1 }
  for (const [field, value] of Object.entries(variants)) {
    const world = serviceWorld(t)
    const port = await freePort()
    const record = world.plantRecord({ port, pid: process.pid })
    const requests = []
    await listenOn(t, port, (request, response) => { requests.push(`${request.method} ${request.url}`); healthOf(healthFor(record, { [field]: value }))(request, response) })
    const status = await world.status({}, rules)
    assert.deepEqual([status.state, status.reason, status.disagreements], ['occupied', 'health-identity-differs', [field]], field)
    const stopped = await world.stop({}, rules)
    assert.deepEqual([stopped.stopped, stopped.refused], [false, true], field)
    await assert.rejects(world.start({}, rules), (error) => error.code === 'service-port-occupied', field)
    assert.deepEqual([requests.filter((line) => line !== 'GET /health'), world.kills, world.spawned.length, recordOf(world).runtimeId], [[], [], 0, record.runtimeId], `${field}: only health was asked, nothing signalled, nothing started, the record untouched`)
  }
}

test('a health answer with another runtime identifier, PID, workspace, service, executable or address is occupied, and stop refuses', async (t) => {
  await assertWrongIdentityIsNeverOurs(t, LIFECYCLE_PRIMITIVES)
})

test('mutation control: a status that compares nothing fails the identity oracle', async (t) => {
  await assert.rejects(assertWrongIdentityIsNeverOurs(t, { ...LIFECYCLE_PRIMITIVES, disagreements: () => [] }), assert.AssertionError)
})

test('mutation control: a stop that does not insist on a healthy status fails the identity oracle', async (t) => {
  await assert.rejects(assertWrongIdentityIsNeverOurs(t, { ...LIFECYCLE_PRIMITIVES, mayStop: () => true }), assert.AssertionError)
})

async function assertUnrelatedPidSurvives(t, stopWith) {
  const world = serviceWorld(t)
  const unrelated = sleeper(t)
  const record = world.plantRecord({ port: await freePort(), pid: unrelated.pid })
  const status = await world.status()
  assert.deepEqual([status.state, status.reason], ['pid-not-ours', 'recorded-pid-is-alive-but-nothing-listens'])
  const stopped = await stopWith(world, record)
  assert.deepEqual([stopped.stopped, stopped.refused, stopped.state], [false, true, 'pid-not-ours'])
  assert.deepEqual(world.kills, [], 'nothing was signalled')
  // Start replaces the record of a runtime that provably is not serving, and still never touches that PID.
  const started = await world.start()
  assert.deepEqual([started.started, started.record.pid !== unrelated.pid, started.record.runtimeId !== record.runtimeId], [true, true, true])
  assert.equal((await world.stop()).stopped, true)
  await new Promise((resolve) => { setTimeout(resolve, 200) })
  assert.equal(isAlive(unrelated.pid), true, 'the unrelated process that happens to have the recorded PID is still running')
}

test('PID reuse: a record that points at a live unrelated process is not ours; stop refuses and kills nothing', async (t) => {
  await assertUnrelatedPidSurvives(t, (world) => world.stop())
})

test('mutation control: a stop that signals the recorded PID fails the PID-reuse oracle', async (t) => {
  await assert.rejects(assertUnrelatedPidSurvives(t, async (world, record) => { process.kill(record.pid, 'SIGKILL'); return world.stop() }), assert.AssertionError)
})

function assertRecordRefuses(world, read) {
  const good = world.plantRecord({ port: 4100, pid: process.pid })
  const { ext: _ext, ...withoutPrivatePart } = good
  const broken = [
    { ...good, surprise: 1 }, { ...good, host: 'localhost' }, { ...good, host: '0.0.0.0' }, { ...good, port: 80 }, { ...good, workspaceId: 'ws-another' }, { ...good, serviceName: 'some-other-service' },
    { ...good, stateLocation: path.join(world.dir, 'elsewhere') }, { ...good, executable: { ...good.executable, path: 'relative/entry.mjs' } }, withoutPrivatePart, { ...good, ext: { bearer: 'short' } }, { ...good, ext: { ...good.ext, extra: 1 } },
    { ...good, pid: 0 }, { ...good, runtimeId: 'has spaces' }, { ...good, schema: 'atelier-obsidian-service-state/v2' },
  ]
  for (const document of broken) assert.throws(() => read(document), (error) => error instanceof ObsidianMaintenanceRefusal && error.code === 'invalid-service-record', JSON.stringify(document).slice(0, 120))
  return broken
}

test('a malformed or foreign record refuses start, status and stop; it is never repaired, adopted or removed', async (t) => {
  const world = serviceWorld(t)
  const file = servicePaths(world.workspaceRoot()).record
  const read = (document) => { fs.writeFileSync(file, JSON.stringify(document)); return recordOf(world) }
  const broken = assertRecordRefuses(world, read)
  for (const bytes of ['not json', JSON.stringify(broken[1]), JSON.stringify(broken[4])]) {
    fs.writeFileSync(file, bytes)
    for (const operation of [() => world.status(), () => world.start(), () => world.stop()]) await assert.rejects(operation(), (error) => error.code === 'invalid-service-record')
    assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'the record is exactly as it was found')
  }
  assert.deepEqual([world.spawned.length, world.kills.length], [0, 0])
})

test('mutation control: a reader that accepts whatever parses fails the record oracle', (t) => {
  const world = serviceWorld(t)
  assert.throws(() => assertRecordRefuses(world, (document) => document), assert.AssertionError)
})

// ---------------------------------------------------------------------------
// 20. Hard ends: nothing under staging or recovery is ever swept
// ---------------------------------------------------------------------------

test('a stale record whose PID is gone: status says so, start recovers, and staging and recovery are untouched', async (t) => {
  const world = serviceWorld(t)
  const first = await world.start()
  await world.settled(recordOf(world))
  hardKill(first.record.pid)
  await waitFor(() => !isAlive(first.record.pid), { label: 'the killed service to be gone' })
  const before = { areas: world.areas(), vaults: vaultContent(world) }
  const status = await world.status()
  assert.deepEqual([status.state, status.reason, status.record.runtimeId], ['stale-record', 'recorded-pid-is-gone', first.record.runtimeId])
  const stopped = await world.stop()
  assert.deepEqual([stopped.stopped, stopped.refused, world.kills.length], [false, true, 0], 'there is nothing proven to stop')
  const second = await world.start()
  assert.deepEqual([second.started, second.state, second.record.runtimeId !== first.record.runtimeId, second.record.port], [true, 'healthy', true, first.record.port])
  await world.settled(recordOf(world))
  assert.deepEqual({ areas: world.areas(), vaults: vaultContent(world) }, before, 'recovering from a stale record changed no vault, no staging and no recovery entry')
  assert.equal((await world.stop()).stopped, true)
})

// What a vault holds for a person: everything but the publisher's own lock bookkeeping, which every publication renews.
const vaultContent = (world) => Object.fromEntries(Object.entries(listing(path.join(world.workspaceRoot(), 'vaults'))).filter(([name]) => !name.includes('.atelier-publication')))

const digestsUnder = (...directories) => new Map(directories.flatMap((directory) => Object.entries(listing(directory)).filter(([name, value]) => value !== 'directory' && !name.includes('.atelier-publication')).map(([name, value]) => [value, name])))

async function assertHardKillConverges(t, { beforeRestart = () => {} } = {}) {
  const world = serviceWorld(t)
  const first = await world.start({ entryArgs: ['--crash-on-publication=2', '--crash-at=before-manifest-commit'] })
  const record = recordOf(world)
  assert.equal((await world.settled(record)).freshness.scopes[0].state, 'current')
  const root = world.workspaceRoot()
  const notesBefore = vaultContent(world)
  const generationBefore = world.manifest().generationId
  const tideBefore = fs.readFileSync(world.noteFile('west-wing:tide'))
  fs.appendFileSync(world.source('west-wing/logs/tide.md'), '\nWritten just before the power went.\n')
  // This tick publishes, and the process kills itself with the notes exchanged and the manifest not yet committed: the request dies with it.
  assert.notEqual((await tickService(record)).kind, 'response')
  await waitFor(() => !isAlive(first.record.pid), { label: 'the service to die mid-publication' })
  const dead = world.areas()
  const bytesAtDeath = digestsUnder(world.vault(), path.join(root, 'recovery'))
  assert.equal(world.manifest().generationId, generationBefore, 'the publication was cut before its manifest was committed')
  assert.match(fs.readFileSync(world.noteFile('west-wing:tide'), 'utf8'), /Written just before the power went/, 'with the new note already in the vault')
  assert.deepEqual([Object.values(dead.recovery).includes(digest(tideBefore)), Object.values(vaultContent(world)).includes(digest(tideBefore))], [true, false], 'and the bytes it displaced in recovery only')
  assert.equal((await world.status()).state, 'stale-record')

  await beforeRestart(world)
  const second = await world.start()
  assert.equal(second.started, true)
  const settled = await world.settled(recordOf(world))
  assert.deepEqual([settled.freshness.scopes[0].state, settled.freshness.scopes[0].verified], ['current', true], 'the restarted service converged through the publisher')
  assert.match(fs.readFileSync(world.noteFile('west-wing:tide'), 'utf8'), /Written just before the power went/)
  const notesAfter = vaultContent(world)
  for (const [name, value] of Object.entries(notesBefore)) if (!name.endsWith(world.notePath('west-wing:tide'))) assert.equal(notesAfter[name], value, `${name} is byte-identical`)
  const bytesNow = digestsUnder(world.vault(), path.join(root, 'recovery'))
  for (const [value, name] of bytesAtDeath) assert.ok(bytesNow.has(value), `the bytes of ${name}, in the vault or in recovery at the kill, are still there`)
  for (const [name, value] of Object.entries(dead.recovery)) if (name.startsWith('objects/')) assert.equal(listing(path.join(root, 'recovery'))[name], value, `${name} is unchanged`)
  assert.equal((await world.stop()).stopped, true)
}

test('a hard kill in the middle of a publication, then a restart: the publisher\'s restart recovery converges and no byte is lost', needsExchange, async (t) => {
  await assertHardKillConverges(t)
})

test('mutation control: a restart that first clears what the killed publication left fails the hard-kill oracle', needsExchange, async (t) => {
  await assert.rejects(assertHardKillConverges(t, { beforeRestart: (world) => { for (const area of ['staging', 'recovery']) fs.rmSync(path.join(world.workspaceRoot(), area), { recursive: true, force: true }) } }), assert.AssertionError)
})

// An unfinished journal with candidates in staging and recovery, and the note it was going to replace edited, so no
// tick publishes. Across start, ticks, stop, a hard kill, a stale record and another start, not one entry may go.
async function assertLifecycleLeavesStagingAndRecoveryAlone(world, { afterStop = () => {} } = {}) {
  await assertUnfinishedJournalIsLeftAlone(world, (options) => world.engine(options), (engine) => () => engine.tick())
  const before = world.areas()
  assert.ok(Object.keys(before.staging).length > 0, 'there is something in staging to lose')
  const check = (label) => {
    const now = world.areas()
    assert.deepEqual(now.staging, before.staging, `staging after ${label}`)
    for (const [name, value] of Object.entries(before.recovery)) assert.equal(now.recovery[name], value, `recovery entry ${name} after ${label}`)
    const added = Object.keys(now.recovery).filter((name) => !(name in before.recovery))
    assert.ok(added.every((name) => /^objects\/[0-9a-f]{64}\.bin$/.test(name)), `only immutable objects were added after ${label}: ${added}`)
  }
  const first = await world.start()
  check('start')
  const record = recordOf(world)
  await world.settled(record)
  for (let round = 0; round < 2; round += 1) assert.equal((await tickService(record)).body.scopes[0].state, 'held-for-your-edit')
  check('ticks')
  assert.equal((await world.stop()).stopped, true)
  await afterStop()
  check('stop')
  const second = await world.start()
  await world.settled(recordOf(world))
  hardKill(second.record.pid)
  await waitFor(() => !isAlive(second.record.pid), { label: 'the killed service to be gone' })
  check('a hard kill')
  assert.equal((await world.status()).state, 'stale-record')
  check('status of a stale record')
  await world.start()
  await world.settled(recordOf(world))
  check('start over a stale record')
  assert.equal((await world.stop()).stopped, true)
  check('the last stop')
  assert.notEqual(first.record.runtimeId, second.record.runtimeId)
}

test('the service never sweeps staging or recovery: not at start, on ticks, at stop, after a hard kill or over a stale record', needsExchange, async (t) => {
  await assertLifecycleLeavesStagingAndRecoveryAlone(serviceWorld(t))
})

test('mutation control: a shutdown that tidies staging fails the lifecycle oracle', needsExchange, async (t) => {
  const world = serviceWorld(t)
  await assert.rejects(assertLifecycleLeavesStagingAndRecoveryAlone(world, { afterStop: () => fs.rmSync(path.join(world.workspaceRoot(), 'staging'), { recursive: true, force: true }) }), /staging after stop/)
})

// ---------------------------------------------------------------------------
// 21. The operating-system startup adapter builder
// ---------------------------------------------------------------------------

const STARTUP_INPUT = { label: 'ai.mnstry.atelier.obsidian.ws-synthetic', nodePath: '/opt/synthetic/bin/node', entryPath: '/opt/synthetic/lib/service-main.mjs', args: ['--project=/srv/synthetic/atelier.project.json', '--adapter=obsidian-cli'], logPath: '/srv/synthetic/state/service.log' }

// Every effect a builder could have is counted while it runs; none may happen.
function effectsDuring(run) {
  const effects = []
  const patched = []
  const patch = (module, names) => { for (const name of names) { const original = module[name]; patched.push([module, name, original]); module[name] = (...args) => { effects.push(name); return original.apply(module, args) } } }
  patch(fs, ['writeFileSync', 'appendFileSync', 'mkdirSync', 'openSync', 'renameSync', 'unlinkSync', 'rmSync', 'readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'realpathSync', 'existsSync', 'writeFile', 'mkdir'])
  patch(childProcess, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])
  patch(os, ['homedir', 'userInfo', 'tmpdir'])
  syncBuiltinESMExports()
  try { return { value: run(), effects } } finally { for (const [module, name, original] of patched) module[name] = original; syncBuiltinESMExports() }
}

function assertBuilderIsPure(build) {
  for (const platform of ['darwin', 'linux']) {
    const { value, effects } = effectsDuring(() => build({ platform, ...STARTUP_INPUT }))
    assert.deepEqual(effects, [], `${platform}: the builder read and wrote no file, started no process and asked for no home directory`)
    assert.deepEqual(build({ platform, ...STARTUP_INPUT }), value, 'the same input gives the same text')
    // Every absolute path in the text is one the caller gave; nothing of this machine is baked in.
    const given = [STARTUP_INPUT.nodePath, STARTUP_INPUT.entryPath, STARTUP_INPUT.logPath, '/srv/synthetic/atelier.project.json']
    const found = value.text.split('\n').filter((line) => !line.startsWith('<!DOCTYPE')).join('\n').replaceAll('</', '<').match(/(?<![A-Za-z0-9.<])\/[A-Za-z0-9._/-]+/g) ?? []
    assert.deepEqual(found.filter((item) => !given.includes(item)), [], `${platform}: ${found}`)
    for (const machine of [os.homedir(), process.cwd(), process.execPath, TMP, REPOSITORY_ROOT, os.userInfo().username]) assert.equal(value.text.includes(machine), false, `${platform}: carries ${machine}`)
  }
}

test('the startup adapter builder returns the text of a launchd agent and a systemd user unit, purely, and refuses Windows typed', () => {
  assertBuilderIsPure(buildStartupAdapter)
  const agent = buildStartupAdapter({ platform: 'darwin', ...STARTUP_INPUT })
  assert.deepEqual([agent.kind, agent.fileName, Object.keys(agent).sort()], ['launchd-user-agent', `${STARTUP_INPUT.label}.plist`, ['fileName', 'kind', 'platform', 'text']])
  for (const expected of [`<string>${STARTUP_INPUT.label}</string>`, `<string>${STARTUP_INPUT.nodePath}</string>`, `<string>${STARTUP_INPUT.entryPath}</string>`, '<string>--startup</string>', '<string>--adapter=obsidian-cli</string>', '<key>RunAtLoad</key>', `<string>${STARTUP_INPUT.logPath}</string>`]) assert.ok(agent.text.includes(expected), expected)
  const unit = buildStartupAdapter({ platform: 'linux', ...STARTUP_INPUT })
  assert.deepEqual([unit.kind, unit.fileName], ['systemd-user-unit', `${STARTUP_INPUT.label}.service`])
  assert.ok(unit.text.includes(`ExecStart="${STARTUP_INPUT.nodePath}" "${STARTUP_INPUT.entryPath}" "--startup" "--project=/srv/synthetic/atelier.project.json" "--adapter=obsidian-cli"\n`))
  assert.ok(unit.text.includes('RestartPreventExitStatus=2') && unit.text.includes('WantedBy=default.target'))
  // Values are escaped for their format, not pasted.
  assert.ok(buildStartupAdapter({ platform: 'darwin', ...STARTUP_INPUT, args: ['--project=/srv/a&b/<c>.json'] }).text.includes('<string>--project=/srv/a&amp;b/&lt;c&gt;.json</string>'))
  assert.ok(buildStartupAdapter({ platform: 'linux', ...STARTUP_INPUT, args: ['--project=/srv/100%/$HOME/"q".json'] }).text.includes('"--project=/srv/100%%/$$HOME/\\"q\\".json"'))

  assert.throws(() => buildStartupAdapter({ platform: 'win32', ...STARTUP_INPUT }), (error) => error instanceof ObsidianMaintenanceRefusal && error.code === 'startup-platform-unqualified')
  assert.throws(() => buildStartupAdapter({ platform: 'freebsd', ...STARTUP_INPUT }), (error) => error.code === 'startup-platform-unsupported')
  for (const invalid of [{ nodePath: 'node' }, { entryPath: './service-main.mjs' }, { logPath: '~/service.log' }, { label: 'has spaces' }, { label: '../escape' }, { args: ['--startup'] }, { args: ['two\nlines'] }, { args: [7] }, { workingDirectory: 'relative' }]) {
    for (const platform of ['darwin', 'linux']) assert.throws(() => buildStartupAdapter({ platform, ...STARTUP_INPUT, ...invalid }), (error) => error.code === 'startup-adapter-input-invalid', JSON.stringify(invalid))
  }
})

test('mutation control: a builder that looks up this machine, or writes the unit itself, fails the purity oracle', (t) => {
  const scratch = fs.mkdtempSync(path.join(TMP, 'atelier-maintenance-unit-'))
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }))
  assert.throws(() => assertBuilderIsPure((input) => { const built = buildStartupAdapter(input); fs.writeFileSync(path.join(scratch, built.fileName), built.text); return built }), assert.AssertionError)
  // The units are POSIX text, so the builder refuses this host's own paths on Windows before the oracle sees them:
  // there the two controls below cannot be expressed, and the one above stands alone.
  if (process.platform === 'win32') return
  assert.throws(() => assertBuilderIsPure((input) => buildStartupAdapter({ ...input, workingDirectory: os.homedir() })), assert.AssertionError)
  assert.throws(() => assertBuilderIsPure((input) => buildStartupAdapter({ ...input, nodePath: process.execPath })), assert.AssertionError)
})

// ---------------------------------------------------------------------------
// 22. Nothing is left running
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The proposal adapter on a tick
// ---------------------------------------------------------------------------
//
// The engine lets the registered proposal adapter observe the open edits the
// object store does not know yet, and hands it the pending edits once per
// tick, after the automatic dispatch. The worlds below are the invented git
// repositories of the proposal tests; a view is written directly, so no
// publisher and no atomic exchange is needed and these run on every platform.

const { createEngineApplyOperation, openObjectStore: openObjectStoreForProposals } = await import('../src/projection/obsidian/edits/index.mjs')
const { PROPOSAL_ADAPTER_ID, PROPOSAL_ADAPTER_PRIMITIVES, createProposalAdapter, createProposalAdapterForOracleTests, recordedOperationOf } = await import('../src/projection/obsidian/proposals/index.mjs')
const { createMaintenanceExtensions: extensionsForProposals } = await import('../src/runtime/obsidian/extension-points.mjs')
const { REPOSITORIES: PROPOSAL_REPOSITORIES, makeProposalWorld, sourceState: proposalSourceState } = await import('./support/obsidian-proposals/world.mjs')
const { treeListing: proposalTree } = await import('./support/obsidian-edits/apply-world.mjs')

// The adapter is made with nothing: the clock and the environment it works under are the ones the engine hands it.
function proposalEngine(world, { adapter = createProposalAdapter(), apply = true, primitives = null } = {}) {
  const extensions = extensionsForProposals()
  if (apply) extensions.register('apply-operation', createEngineApplyOperation({ context: { loadProject: world.loadProject, dataRoot: world.dataRoot, env: world.env, clock: world.clock } }))
  if (adapter) extensions.register('proposal-adapter', adapter)
  return primitives === null ? world.engine({ extensions }) : world.oracleEngine({ extensions, primitives })
}
const byNode = (left, right) => (left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0)
const storesOf = (world) => Object.fromEntries(PROPOSAL_REPOSITORIES.map((name) => [name, fs.existsSync(world.storeDir(name)) ? proposalTree(world.storeDir(name)) : null]))
const adapterStateOf = (world) => (fs.existsSync(world.queueDir()) ? proposalTree(world.queueDir()) : null)

test('proposal adapter binding: a tick hands the pending edits to the registered adapter once, after the automatic dispatch, with the workspace it needs; without one nothing is handed anywhere, and an adapter that throws changes nothing else of the tick', async (t) => {
  const world = makeProposalWorld(t)
  world.addLink('east-wing:guide', 'east-wing:second')
  const calls = []
  const recording = { id: 'test.recording-adapter', async propose(context) { calls.push(context); return { adapterId: 'test.recording-adapter', examined: 0, outcomes: [], repositories: [] } } }
  const first = await proposalEngine(world, { adapter: recording }).tick()
  assert.equal(first.state, 'ticked')
  assert.equal(calls.length, 1, 'once per tick')
  const [context] = calls
  assert.deepEqual([context.workspaceId, context.workspaceRoot, typeof context.clock, context.project.repos.map((repo) => repo.name)], [world.context().workspaceId, world.workspaceRoot(), 'function', [...PROPOSAL_REPOSITORIES]])
  assert.deepEqual(context.edits.map((edit) => [edit.identity.nodeId, edit.state]), [['east-wing:guide', 'queued']], 'the edit this very tick preserved and queued is among them')
  assert.deepEqual(first.proposals, { adapterId: 'test.recording-adapter', examined: 0, outcomes: [], repositories: [] })
  // Handed a copy: an adapter cannot change the pending edits of the engine.
  context.edits[0].state = 'applied'
  assert.equal(world.editOf('east-wing:guide').state, 'queued')

  const without = await proposalEngine(world, { adapter: null }).tick()
  assert.deepEqual([without.state, Object.hasOwn(without, 'proposals'), calls.length], ['ticked', false, 1])
  const throwing = await proposalEngine(world, { adapter: { id: 'test.throwing-adapter', async propose() { throw new Error('synthetic failure') } } }).tick()
  assert.deepEqual([throwing.state, throwing.proposals, throwing.pendingEdits.map((edit) => edit.state)], ['ticked', { adapterId: 'test.throwing-adapter', failed: 'proposal-adapter-threw' }, ['queued']])
})

test('proposal adapter on the engine, manual and automatic: a structural edit becomes one proposal on the tick that observed it, unchanged ticks append zero ledger events and write nothing, apply behaves as it did, and no source byte or git state ever changes', async (t) => {
  for (const mode of ['manual', 'automatic']) {
    const world = makeProposalWorld(t)
    // The same world without an adapter: what apply and the pending edits do there is what they must do here.
    const control = makeProposalWorld(t)
    for (const each of [world, control]) {
      if (mode === 'automatic') { each.configureMachine({ maintenanceMode: 'automatic' }); each.installPolicy() }
      each.addLink('east-wing:guide', 'west-wing:guide')
      each.editFrontMatter('west-wing:second', 'Western second sheet', 'Second sheet of the west')
    }
    const before = proposalSourceState(world)
    const engine = proposalEngine(world)
    const bare = proposalEngine(control, { adapter: null })
    const [tick, controlTick] = [await engine.tick(), await bare.tick()]
    assert.deepEqual([tick.state, tick.maintenanceMode], ['ticked', mode])
    assert.deepEqual([tick.dispatched.map(({ status, code, state }) => [status, code, state]), tick.pendingEdits.map((edit) => edit.state)], [controlTick.dispatched.map(({ status, code, state }) => [status, code, state]), controlTick.pendingEdits.map((edit) => edit.state)], `${mode}: dispatch and the pending edits are what they are without an adapter`)
    // The observation of this tick recorded both operations as proposed, in either mode, and the adapter routed them in the same tick.
    assert.deepEqual([...tick.observed.observed].sort(byNode).map(({ nodeId, status, code, kind, operationState }) => [nodeId, status, code, kind, operationState]),
      [['east-wing:guide', 'observed', 'observed', 'semantic-proposal', 'proposed'], ['west-wing:second', 'observed', 'observed', 'semantic-proposal', 'proposed']])
    assert.deepEqual(tick.proposals.outcomes.map((item) => [item.repoId, item.status, item.dedupe]), [['east-wing', 'acknowledged', 'new'], ['west-wing', 'acknowledged', 'new']])
    if (mode === 'automatic') {
      assert.deepEqual(tick.dispatched.map(({ status, code }) => [status, code]), [['refused', 'edit-not-applicable'], ['refused', 'edit-not-applicable']])
    } else {
      // Manual: nothing on a tick applies. A person who asks apply to look afterwards gets the answer apply always gave.
      assert.deepEqual(tick.dispatched, [])
      for (const edit of world.pendingEdits()) assert.deepEqual((({ status, code }) => [status, code])(await world.sourceApply().apply({ editId: edit.editId, mode: 'manual' })), ['refused', 'edit-not-applicable'])
    }
    assert.deepEqual(PROPOSAL_REPOSITORIES.map((name) => world.adapterProposals(name).map((record) => [record.proposal.path, record.payload.adapter.id])), [[['notes/guide.md', PROPOSAL_ADAPTER_ID]], [['notes/second.md', PROPOSAL_ADAPTER_ID]]])

    // Many unchanged ticks, across full reconciliations and every retry interval: not one ledger byte, store file or adapter record.
    const settled = { stores: storesOf(world), queue: adapterStateOf(world), edits: world.pendingEdits() }
    for (let index = 0; index < 25; index += 1) {
      world.advance(7 * 60 * 1000)
      const again = await engine.tick()
      assert.deepEqual([again.state, again.proposals.outcomes, again.proposals.repositories], ['ticked', [], []])
    }
    assert.deepEqual({ stores: storesOf(world), queue: adapterStateOf(world), edits: world.pendingEdits().map((edit, index) => ({ ...edit, attempts: settled.edits[index].attempts, lastAttemptAt: settled.edits[index].lastAttemptAt, lastResult: settled.edits[index].lastResult, state: settled.edits[index].state })) },
      settled, `${mode}: twenty-five unchanged ticks append zero ledger events and write nothing of the adapter's`)
    assert.ok(world.pendingEdits().every((edit) => edit.closedAt === null), 'a proposal closes no pending edit: the note is still held for the person')
    assert.deepEqual(proposalSourceState(world), before, `${mode}: no source byte and no git state changed`)

    // Mutation control: an adapter that hands everything over again and does not look appends an event per tick.
    const chatty = proposalEngine(world, { adapter: createProposalAdapterForOracleTests({ ...PROPOSAL_ADAPTER_PRIMITIVES, handOver: () => true, isSettled: () => false, lookBeforeCreate: false })({ env: world.env }) })
    world.advance(1000)
    await chatty.tick()
    assert.notDeepEqual(storesOf(world), settled.stores, 'the control grows the ledger on a tick where nothing changed')
  }
})

// Manual mode, one structural edit, many ticks and no apply: exactly one proposal, from the observation of a tick.
// Beside it a body edit, which only apply may write, and an edit the lens refuses, which is recorded once. The
// scenario is a function of the engine primitives so that the mutation control below runs it unchanged.
async function assertTickObservationProposes(world, primitives) {
  world.addLink('east-wing:guide', 'east-wing:second')
  world.editNote('east-wing:plain', 'Only the body', 'Nothing but the body')
  fs.appendFileSync(world.noteFile('east-wing:third'), Buffer.from([0xff, 0xfe]))
  const sources = world.sourceDigests()
  const before = proposalSourceState(world)
  const engine = proposalEngine(world, { primitives })
  const first = await engine.tick()
  assert.deepEqual([first.state, first.maintenanceMode, first.dispatched], ['ticked', 'manual', []], 'manual: nothing on a tick applies')
  const classified = (tick) => [...(tick.observed?.observed ?? [])].sort(byNode).map(({ nodeId, status, code, kind, operationState }) => [nodeId, status, code, kind, operationState])
  assert.deepEqual(classified(first), [
    ['east-wing:guide', 'observed', 'observed', 'semantic-proposal', 'proposed'],
    ['east-wing:plain', 'observed', 'observed', 'body-replacement', 'pending'],
    ['east-wing:third', 'observed', 'observed', 'body-replacement', 'refused'],
  ], 'the tick observed every open edit from its preserved bytes and recorded what each is')
  assert.deepEqual(first.proposals.outcomes.map((item) => [item.nodeId, item.status, item.dedupe]), [['east-wing:guide', 'acknowledged', 'new']], 'the structural edit was routed in the same tick; the body replacement and the refused edit were not')
  assert.deepEqual(PROPOSAL_REPOSITORIES.map((name) => world.adapterProposals(name).map((record) => [record.proposal.path, record.payload.editId])), [[['notes/guide.md', world.editOf('east-wing:guide').editId]], []], 'exactly one proposal, in the store of the repository that owns the source')
  // The object store says what each edit is, as an apply would have recorded it, and the pending edits are untouched.
  const objects = openObjectStoreForProposals({ stateRoot: world.workspaceRoot(), workspaceId: world.context().workspaceId, repositoryRoots: world.context().repositoryRoots, clock: world.clock })
  const recordedAs = (nodeId) => (({ kind, state }) => [kind, state])(recordedOperationOf(objects, world.editOf(nodeId)))
  assert.deepEqual(['east-wing:guide', 'east-wing:plain', 'east-wing:third'].map(recordedAs), [['semantic-proposal', 'proposed'], ['body-replacement', 'pending'], ['body-replacement', 'refused']])
  assert.deepEqual(world.pendingEdits().map((edit) => [edit.state, edit.closedAt]), [['queued', null], ['queued', null], ['queued', null]], 'every edit is still queued for the person: a tick in manual mode applies nothing and closes nothing')

  // Many later ticks, across full reconciliations: nothing is observed again, nothing is routed again, and not one
  // byte of any ledger, adapter record or object event log changes. The refused edit is never retried.
  const settled = { stores: storesOf(world), queue: adapterStateOf(world), logs: world.objectLogs() }
  for (let index = 0; index < 12; index += 1) {
    world.advance(7 * 60 * 1000)
    const again = await engine.tick()
    assert.deepEqual([again.state, again.observed.observed, again.proposals.outcomes], ['ticked', [], []], `tick ${index + 2} is quiet`)
  }
  assert.deepEqual({ stores: storesOf(world), queue: adapterStateOf(world), logs: world.objectLogs() }, settled, 'twelve later ticks: zero ledger events, zero adapter records, zero object events')
  // An engine and an adapter that have just started and remember nothing find everything recorded and append nothing.
  world.advance(1000)
  const restarted = await proposalEngine(world, { primitives }).tick()
  assert.deepEqual([restarted.observed.observed.map((item) => item.code), restarted.proposals.outcomes], [['already-observed', 'already-observed', 'already-observed'], []])
  assert.deepEqual({ stores: storesOf(world), queue: adapterStateOf(world), logs: world.objectLogs() }, settled)
  assert.equal(world.adapterProposals('east-wing').length, 1, 'still exactly one proposal')
  assert.deepEqual(world.sourceDigests(), sources, 'no source byte changed, in either repository')
  assert.deepEqual(proposalSourceState(world), before, 'and no git state')

  // The body replacement was left for apply: asked by a person, apply finds it recorded as pending and treats it as
  // its own (applied where an atomic exchange exists, refused where none does), and never as a proposal.
  const applied = await world.sourceApply().apply({ editId: world.editOf('east-wing:plain').editId, mode: 'manual' })
  assert.notEqual(applied.code, 'edit-not-applicable', `the body replacement is apply's to write: ${applied.status} ${applied.code}`)
  world.advance(1000)
  await engine.tick()
  assert.equal(world.adapterProposals('east-wing').length, 1, 'a body replacement never becomes a proposal')
}

test('tick observation in manual mode: one structural edit, many ticks and no apply give exactly one proposal in the store of its repository, later ticks append nothing anywhere, a body replacement stays queued for apply, a lens refusal is recorded once and never retried, and no source byte changes', async (t) => {
  await assertTickObservationProposes(makeProposalWorld(t), ENGINE_PRIMITIVES)
})

test('mutation control for tick observation: an engine that never lets the adapter observe records nothing and proposes nothing in manual mode, and the oracle above fails for it', async (t) => {
  const blind = { ...ENGINE_PRIMITIVES, observeEdits: () => false }
  await assert.rejects(assertTickObservationProposes(makeProposalWorld(t), blind), assert.AssertionError)
  const world = makeProposalWorld(t)
  world.addLink('east-wing:guide', 'east-wing:second')
  const engine = proposalEngine(world, { primitives: blind })
  for (let index = 0; index < 5; index += 1) { world.advance(7 * 60 * 1000); await engine.tick() }
  assert.deepEqual([storesOf(world), world.pendingEdits().map((edit) => edit.state)], [{ 'east-wing': null, 'west-wing': null }, ['queued']], 'without the observation of a tick, manual mode has no proposal until somebody runs apply')
})

test('no process this suite started is left behind', async () => {
  assert.ok(SPAWNED.length > 0, 'this suite does start processes')
  // Anything its own test did not see gone is ended here as a last resort, and then named: the guard fails either way.
  const left = SPAWNED.filter(processLives)
  const outcomes = []
  for (const entry of left) outcomes.push(`${describeProcess(entry)}: ${(await endProcess(entry)) ? 'ended by the guard' : 'STILL RUNNING after the guard tried to end it'}`)
  assert.deepEqual(outcomes, [], 'every process was ended by the test that started it')
  if (process.platform !== 'win32') {
    const children = childProcess.spawnSync('pgrep', ['-P', String(process.pid)], { encoding: 'utf8' })
    if (!children.error) assert.deepEqual(children.stdout.split('\n').filter((line) => line.trim() !== '' && isAlive(Number(line))), [], 'the test process has no child left')
  }
})
