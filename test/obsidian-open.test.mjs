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
import { fileURLToPath, pathToFileURL } from 'node:url'

// ---------------------------------------------------------------------------
// 0. The spawn guard. Installed before anything else is imported, for every
// way this process can start another one. Nothing in this file may start the
// installed app, its command-line tool, an operating-system opener or a
// service manager; an attempt throws here instead of running.
// ---------------------------------------------------------------------------

const BANNED_PROGRAMS = ['obsidian-cli', 'obsidian', 'open', 'xdg-open', 'launchctl', 'systemctl']
const WRAPPERS = ['sh', 'bash', 'zsh', 'dash', 'env', 'cmd', 'powershell', 'pwsh', 'nohup', 'sudo']
const programName = (command) => path.basename(String(command).replaceAll('\\', '/')).toLowerCase().replace(/\.(exe|app|cmd|bat)$/, '')
const guardErrors = []
function guardSpawn(command, args) {
  const words = [command, ...(Array.isArray(args) ? args : [])].map(String)
  // The program itself, always; its arguments too when the program only runs another one; an app link anywhere.
  const wrapper = WRAPPERS.includes(programName(command))
  const banned = words.find((word, index) => ((index === 0 || wrapper) && BANNED_PROGRAMS.includes(programName(word))) || /obsidian:\/\//i.test(word))
  if (banned === undefined) return
  const error = new Error(`spawn guard: this test suite may never start "${programName(banned)}"`)
  guardErrors.push(error.message)
  throw error
}
for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
  const original = childProcess[method]
  childProcess[method] = function guarded(command, args, ...rest) {
    // exec and execSync take one shell line.
    if (method === 'exec' || method === 'execSync') guardSpawn('sh', String(command).split(/\s+/)); else guardSpawn(command, args)
    return original.call(this, command, args, ...rest)
  }
}
syncBuiltinESMExports()

const { resolveProjectConfig, writeJson } = await import('../src/project/config.mjs')
const { createEditorAdapter, resolveExchange } = await import('../src/projection/obsidian/publication/index.mjs')
const { BUILT_IN_OPERATIONS, COMMAND_SCHEMA, EXIT, default: defaultCommand, runObsidianCommand, runObsidianCommandForOracleTests } = await import('../src/commands/obsidian.mjs')
const { MINIMUM_APP_VERSION, compareAppVersions, createQualifiedAdapterFactory, meetsMinimumAppVersion, parseAppVersion, qualifyApp } = await import('../src/runtime/obsidian/app-capability.mjs')
const { loadContributions } = await import('../src/runtime/obsidian/contributions.mjs')
const { ENGINE_PRIMITIVES, createMaintenanceEngineForOracleTests } = await import('../src/runtime/obsidian/engine.mjs')
const { ObsidianMaintenanceRefusal } = await import('../src/runtime/obsidian/errors.mjs')
const { createObsidianRegistry } = await import('../src/runtime/obsidian/extension-points.mjs')
const { LIFECYCLE_PRIMITIVES, serviceStatus, startService, stopService } = await import('../src/runtime/obsidian/lifecycle.mjs')
const { ensureWorkspaceIdentity, protectedRoots, readMachineSettings, workspaceStateRoot, writeMachineSettings } = await import('../src/runtime/obsidian/machine-settings.mjs')
const { OPENING_OUTCOMES, OPENING_PRIMITIVES } = await import('../src/runtime/obsidian/opening.mjs')
const { createAbandonmentProof, machineDigest } = await import('../src/runtime/obsidian/private-lock.mjs')
const { commandLineNamesRecord, readProcessCommandLine } = await import('../src/runtime/obsidian/process-identity.mjs')
const { HEALTH_SCHEMA, probeHealth } = await import('../src/runtime/obsidian/service-client.mjs')
const { readServiceRecord, serviceNameFor, writeServiceRecord, writeServiceSettings } = await import('../src/runtime/obsidian/service-record.mjs')
const { runMaintenanceService } = await import('../src/runtime/obsidian/service.mjs')
const { createMaintenanceStateStore } = await import('../src/runtime/obsidian/state-store.mjs')
const { maintenanceNoticeFor } = await import('../src/runtime/obsidian/sync-notice.mjs')
const { enrollRepository, obsidianMaintenanceNotice } = await import('../src/runtime/supervisor.mjs')
const { resolveGitExecutable, runGit } = await import('../src/runtime/git-adapter.mjs')

// The `obsidian` command, opening and freshness, on a real filesystem in
// temporary directories. Invented, synthetic content only. There is no app:
// what is installed and whether a vault opened are answered by injected
// seams, the editor adapter always reports that no Obsidian runs, and every
// data root is a temporary directory (the resolver refuses the platform
// default under the test runner).
//
// Services are either run inside this process or are children of the test
// entry under test/support/obsidian-maintenance/. Every child is recorded and
// ended in teardown, and the last test asserts none is left.
//
// Platform notes. Where no atomic exchange exists (Windows today) the
// publisher refuses, so every case that needs a real publication is skipped
// there (`needsExchange`); the opening states that need no publication run
// everywhere. Proving that a silent PID runs our executable reads the process
// table, which is established on Linux and macOS only (`needsProcessProof`).

const EXCHANGE_HERE = (() => { try { resolveExchange({}); return true } catch { return false } })()
const needsExchange = EXCHANGE_HERE ? {} : { skip: 'no atomic exchange on this platform: the publisher refuses, which the recovery suite asserts' }
const PROCESS_PROOF_HERE = process.platform === 'linux' || process.platform === 'darwin'
const needsProcessProof = PROCESS_PROOF_HERE ? {} : { skip: 'the command line of another process is not established on this platform: a silent service reads as occupied, which the portable lifecycle case asserts' }

const REPOSITORY_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const TEST_SERVICE_ENTRY = path.join(REPOSITORY_ROOT, 'test', 'support', 'obsidian-maintenance', 'service-entry.mjs')
const TMP = fs.realpathSync(os.tmpdir())
const EXT = 'mnstry.atelier.obsidian'
const START = Date.parse('2026-01-05T10:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()
const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`
// The policy without its `digest` member, keys sorted at every depth, two-space indentation, one final newline, UTF-8.
const sortedDeep = (value) => (Array.isArray(value) ? value.map(sortedDeep) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedDeep(value[key])])) : value)
const canonicalPolicyDigest = ({ digest: _carried, ...content }) => digest(Buffer.from(`${JSON.stringify(sortedDeep(content), null, 2)}\n`, 'utf8'))
const fixedRandom = (size) => Buffer.alloc(size, 7)
const WORKSPACE_ID = `ws-${'07'.repeat(12)}`
const CONSENT = { actor: 'test-suite', coverage: 'service' }
const IDLE_INTERVAL = 60 * 60 * 1000
const FAST_PROBE = 1500

const note = ({ id, title, body }) => `---\ntitle: "${title}"\nkg:\n  id: "${id}"\n  type: "document"\n  status: "active"\n  audience: "team"\n---\n\n# ${title}\n\n${body}\n`
const FILES = {
  'east-wing/notes/lantern.md': note({ id: 'east-wing:lantern', title: 'Lantern room', body: 'The lamp turns once a minute. See the [compass](compass.md).' }),
  'east-wing/notes/compass.md': note({ id: 'east-wing:compass', title: 'Compass rose', body: 'North is painted red.' }),
  'west-wing/logs/tide.md': note({ id: 'west-wing:tide', title: 'Tide log', body: 'High water at noon.' }),
}
const REPOSITORIES = ['east-wing', 'west-wing']
const FULL_SCOPE = { scopeId: 'scope-whole', mode: 'full', selector: { all: true } }
const EAST_SCOPE = { scopeId: 'scope-east', mode: 'scoped', selector: { repo: 'east-wing' } }
const settingsOf = (scopes = [FULL_SCOPE], extra = {}) => ({ schema: 'atelier-obsidian-ext-settings/v1', enabled: true, scopes, ...extra })
const projectDocument = (ext) => ({
  schema: 'mnstry.atelier-project-config@v1', name: 'opening-fixture', roots: { workspace: '.', repoOps: '.' },
  graph: { repoAccessPath: 'repo-access.v1.json', outputPath: 'atelier-output/knowledge.graph.json' },
  projection: { outputRoot: 'atelier-output', readinessPath: 'atelier-output/atelier-readiness.json' },
  repos: REPOSITORIES.map((name) => ({ name, path: name, readBoundary: 'team' })),
  ...(ext === undefined ? {} : { ext: { [EXT]: ext } }),
})
const absentAdapter = () => createEditorAdapter({ call: async () => { throw new Error('no app') }, processProbe: () => 'absent', kind: 'absent' })
const REFUSED_PUBLICATION = { state: 'refused', refusal: { code: 'exchange-unsupported-platform', message: 'stub' }, notes: [], retainedEdits: [], lateWriters: [] }
const CONFLICT_PUBLICATION = { state: 'refused', refusal: { code: 'publication-in-progress', message: 'stub' }, notes: [], retainedEdits: [], lateWriters: [] }

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

// Seams that must never be reached: a read-only operation that touches one fails its test.
const UNREACHABLE_SEAMS = Object.freeze({
  appProbe: { inspect() { throw new Error('the app probe was reached') }, inspectSync() { throw new Error('the app probe was reached') }, vaultState() { throw new Error('the app probe was reached') } },
  launcher: { open() { throw new Error('the launcher was reached') } },
  service: { entryPath: TEST_SERVICE_ENTRY, spawn() { throw new Error('a service was started') } },
})

// An installed app, as the injected probe describes it, and a launcher that records what it was asked.
function fakeApp(overrides = {}) {
  const state = { installed: true, cli: true, running: false, version: '1.13.7 (installer 1.12.7)', answered: true, indexReady: true, launchResult: { launched: true, reason: 'fake' }, comesUp: true, ...overrides }
  const launches = []
  return {
    state, launches,
    appProbe: {
      inspect: async () => ({ installed: state.installed, cli: state.cli, running: state.running, version: state.running ? state.version : null }),
      vaultState: async ({ vaultRoot }) => ({ answered: state.answered && launches.includes(vaultRoot), indexReady: state.answered && state.indexReady && launches.includes(vaultRoot) }),
    },
    launcher: { open: async ({ vaultRoot }) => { launches.push(vaultRoot); if (state.launchResult.launched && state.comesUp) state.running = true; return state.launchResult } },
  }
}

const SPAWNED = []
const isAlive = (pid) => { try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' } }
function followChild(t, child) {
  const entry = { pid: child.pid, child, test: t.name, gone: child.pid === undefined }
  child.once('exit', () => { entry.gone = true })
  SPAWNED.push(entry)
  t.after(async () => {
    if (entry.gone || child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise((resolve) => { child.once('exit', resolve) })
    child.kill('SIGKILL')
    await Promise.race([exited, new Promise((resolve) => { setTimeout(resolve, 10000) })])
  })
  return child
}
const trackingSpawn = (t) => (...args) => followChild(t, childProcess.spawn(...args))

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

async function listenOn(t, port, handler) {
  const server = http.createServer(handler)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port }, resolve) })
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections() }))
  return server
}

// One temporary project, one temporary data root, one controllable clock, and the command run inside this process.
function makeWorld(t, { ext = settingsOf(), machine = { maintenanceMode: 'manual', audienceAllow: ['team'] } } = {}) {
  const dir = fs.mkdtempSync(path.join(TMP, 'atelier-opening-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
  const projectDir = path.join(dir, 'project')
  const dataRoot = path.join(dir, 'data')
  for (const [relative, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(projectDir, relative)), { recursive: true })
    fs.writeFileSync(path.join(projectDir, relative), content)
  }
  for (const name of REPOSITORIES) fs.mkdirSync(path.join(projectDir, name, '.git'), { recursive: true })
  const configPath = path.join(projectDir, 'atelier.project.json')
  writeJson(configPath, projectDocument(ext === null ? undefined : ext))
  writeJson(path.join(projectDir, 'repo-access.v1.json'), { schema: 'mnstry.atelier-repo-access@v1', defaultReadBoundary: 'team', repos: Object.fromEntries(REPOSITORIES.map((name) => [name, { readBoundary: 'team' }])) })
  const { MNSTRY_ATELIER_PROJECT_CONFIG: _config, MNSTRY_ATELIER_LOCAL_CONFIG: _overlay, ...env } = process.env
  const loadProject = () => resolveProjectConfig({ argv: [`--project=${configPath}`], cwd: projectDir, env, writeLocalState: false })
  let nowMs = START
  const world = {
    dir, projectDir, dataRoot, configPath, loadProject, env,
    clock: () => new Date(nowMs),
    advance: (ms) => { nowMs += ms },
    source: (relative) => path.join(projectDir, relative),
    writeExt: (next) => writeJson(configPath, projectDocument(next)),
    workspaceRoot: () => fs.realpathSync(workspaceStateRoot(dataRoot, WORKSPACE_ID)),
    workspace: () => ({ workspaceRoot: world.workspaceRoot(), workspaceId: WORKSPACE_ID }),
    vault: (scopeId = FULL_SCOPE.scopeId) => path.join(world.workspaceRoot(), 'vaults', scopeId),
    stateStore: () => createMaintenanceStateStore(world.workspace()),
    manifest(scopeId = FULL_SCOPE.scopeId) {
      const directory = path.join(world.workspaceRoot(), 'state', 'manifests', scopeId)
      const pointer = JSON.parse(fs.readFileSync(path.join(directory, 'current.json'), 'utf8'))
      return JSON.parse(fs.readFileSync(path.join(directory, pointer.manifestFile), 'utf8'))
    },
    noteFile: (nodeId, scopeId) => path.join(world.vault(scopeId), world.manifest(scopeId).notes.find((item) => item.nodeId === nodeId).path),
    machine: () => readMachineSettings(world.workspace()),
    configureMachine(settings) {
      const project = loadProject()
      const pointer = ensureWorkspaceIdentity({ project, randomBytes: fixedRandom })
      const root = workspaceStateRoot(dataRoot, pointer.workspaceId)
      const current = fs.existsSync(root) ? readMachineSettings({ workspaceRoot: root, workspaceId: pointer.workspaceId }) : null
      return writeMachineSettings({ workspaceRoot: root, workspaceId: pointer.workspaceId, repositoryRoots: protectedRoots(project), settings: { schema: 'atelier-obsidian-machine-settings/v1', workspaceId: pointer.workspaceId, applyPolicy: null, ...(current ?? {}), ...settings, updatedAt: world.clock().toISOString() } })
    },
    policyFile(overrides = {}) {
      const policy = {
        schema: 'atelier-obsidian-apply-policy/v1', policyId: 'policy-synthetic', workspaceId: WORKSPACE_ID, mode: 'automatic', status: 'active', actor: { kind: 'agent', id: 'agent-synthetic' },
        version: 1, digest: digest('policy-synthetic-1'), allowedEditClasses: ['body-replacement'], selector: { all: true }, maxBatchSize: 10, retryBudget: 2, conflictDisposition: 'hold', ...overrides,
      }
      // The digest a policy must carry, computed here from the documented canonical form and never by the code under test.
      if (overrides.digest === undefined) policy.digest = canonicalPolicyDigest(policy)
      const file = path.join(dir, `policy-${randomBytes(4).toString('hex')}.json`)
      fs.writeFileSync(file, JSON.stringify(policy))
      return { file, policy }
    },
    engine({ primitives = ENGINE_PRIMITIVES, ...options } = {}) {
      const engine = createMaintenanceEngineForOracleTests({ loadProject, dataRoot, adapterFactory: absentAdapter, clock: world.clock, randomBytes: fixedRandom, quietPeriodMs: 0, watcherFactory: () => ({ close() {} }), ...options }, primitives)
      t.after(() => engine.stop())
      return engine
    },
    // The command, in this process. Seams default to ones that fail the test when reached.
    async run(argv, { seams = UNREACHABLE_SEAMS, rules, ...extra } = {}) {
      const out = []
      const err = []
      const options = { argv: [...argv, `--project=${configPath}`, `--data-root=${dataRoot}`], seams, env, cwd: projectDir, clock: world.clock, contributions: [], probeTimeoutMs: FAST_PROBE, stdout: (text) => out.push(text), stderr: (text) => err.push(text), ...extra }
      const exit = rules ? await runObsidianCommandForOracleTests(options, rules) : await runObsidianCommand(options)
      const stdout = out.join('\n')
      let json = null
      try { json = JSON.parse(stdout) } catch { json = null }
      return { exit, stdout, stderr: err.join('\n'), json }
    },
    // A maintenance service inside this process, reachable by the lifecycle exactly like a child.
    async service({ engineOptions = {}, ...rest } = {}) {
      const port = await freePort()
      writeServiceSettings({ ...world.workspace(), settings: { schema: 'atelier-obsidian-service-settings/v1', workspaceId: WORKSPACE_ID, host: '127.0.0.1', port, consent: { grantedAt: iso(START), ...CONSENT }, updatedAt: iso(START) } })
      const service = await runMaintenanceService({
        loadProject, dataRoot, env, adapterFactory: absentAdapter, entryPath: TEST_SERVICE_ENTRY, intervalMs: IDLE_INTERVAL, clock: world.clock,
        engineOptions: { quietPeriodMs: 0, watcherFactory: () => ({ close() {} }), randomBytes: fixedRandom, ...engineOptions }, ...rest,
      })
      t.after(() => service.shutdown('test-teardown'))
      await service.tickNow()
      return service
    },
  }
  if (machine) world.configureMachine(machine)
  return world
}

// A service whose engine does nothing, so the freshness a test wrote is the freshness `open` finds.
const idleEngine = () => ({ tick: async () => ({ state: 'ticked', scopes: [], changes: [], pendingEdits: [], dispatched: [], lateWriters: [] }), stop() {} })

function plantFreshness(world, entries) {
  world.stateStore().writeFreshness({
    schema: 'atelier-obsidian-freshness/v1', workspaceId: WORKSPACE_ID, enablement: 'enabled', maintenanceMode: 'manual', lastTickAt: iso(START), lastFullReconciliationAt: iso(START),
    scopes: entries.map((entry) => ({ scopeId: FULL_SCOPE.scopeId, reason: 'planted', generationId: null, preparedGenerationId: null, verified: false, heldNotes: [], changeClasses: [], retainedEdits: 0, checkedAt: iso(START), ...entry })),
  })
}

const openArgs = (extra = []) => ['open', '--json', '--consent-actor', CONSENT.actor, ...extra]

// ---------------------------------------------------------------------------
// 1. Safety: no production seam, no banned program
// ---------------------------------------------------------------------------

test('the spawn guard throws before any banned program is started, whichever way it is asked for', () => {
  const before = guardErrors.length
  for (const program of ['open', '/usr/bin/open', 'xdg-open', 'launchctl', 'systemctl', 'obsidian-cli', '/Applications/Obsidian.app/Contents/MacOS/obsidian-cli', '/Applications/Obsidian.app/Contents/MacOS/Obsidian', 'C:\\Programs\\Obsidian\\Obsidian.exe']) {
    assert.throws(() => childProcess.spawn(program, ['anything']), /spawn guard/, program)
    assert.throws(() => childProcess.execFileSync(program, []), /spawn guard/, program)
  }
  assert.throws(() => childProcess.execFile('/bin/sh', ['-c', 'x', 'obsidian://open?path=x']), /spawn guard/)
  assert.throws(() => childProcess.execSync('open somewhere'), /spawn guard/)
  assert.throws(() => childProcess.spawn('/usr/bin/env', ['launchctl', 'load']), /spawn guard/)
  assert.equal(guardErrors.length, before + 21)
  guardErrors.length = before
  // Mutation control: a guard that does not know a program lets it through, so the list is what protects.
  assert.doesNotThrow(() => guardSpawn('node', ['--version']))
})

test('the command never falls through to a real app: without seams it refuses, and as the real entry it refuses without an explicit adapter', async (t) => {
  const world = makeWorld(t)
  assert.equal(defaultCommand, runObsidianCommand)
  const out = []
  const bare = await runObsidianCommand({ argv: ['status', '--json', `--project=${world.configPath}`, `--data-root=${world.dataRoot}`], env: world.env, cwd: world.projectDir, stdout: (text) => out.push(text), stderr: () => {} })
  assert.deepEqual([bare, JSON.parse(out[0]).error.code], [EXIT.refused, 'seams-required'], 'a caller that passes no seams and is not the real entry reaches nothing, for any operation')
  for (const argv of [openArgs(), ['service', 'start', '--json', '--consent-actor', 'somebody'], ['service', 'unit', '--print', '--json']]) {
    const result = await world.run(argv, { seams: null, production: true })
    assert.deepEqual([result.exit, result.json.error.code], [EXIT.refused, 'app-adapter-not-selected'], argv.join(' '))
  }
  // The same through the real entry, as a child: it refuses before it loads anything that could reach an app.
  const child = childProcess.spawnSync(process.execPath, [path.join(REPOSITORY_ROOT, 'bin', 'atelier.mjs'), 'obsidian', 'open', '--json', `--project=${world.configPath}`, `--data-root=${world.dataRoot}`], { env: world.env, cwd: world.projectDir, encoding: 'utf8', windowsHide: true })
  assert.deepEqual([child.status, JSON.parse(child.stdout).error.code], [EXIT.refused, 'app-adapter-not-selected'])
  assert.equal(fs.existsSync(world.dataRoot) ? Object.keys(listing(path.join(world.dataRoot, 'obsidian', WORKSPACE_ID, 'state', 'service'))).length : 0, 0, 'and started nothing')
})

test('the production seams are imported in exactly two places, dynamically, behind the explicit adapter; this process never loaded them', () => {
  const sources = []
  const walk = (directory) => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) walk(file); else if (entry.name.endsWith('.mjs')) sources.push(file) } }
  walk(path.join(REPOSITORY_ROOT, 'src'))
  const naming = sources.filter((file) => fs.readFileSync(file, 'utf8').includes('app-production-seams.mjs')).map((file) => path.relative(REPOSITORY_ROOT, file).split(path.sep).join('/')).sort()
  assert.deepEqual(naming, ['src/commands/obsidian.mjs', 'src/runtime/obsidian/service-main.mjs'])
  for (const file of naming) {
    const text = fs.readFileSync(path.join(REPOSITORY_ROOT, file), 'utf8')
    assert.equal(/^import [^\n]*app-production-seams/m.test(text), false, `${file} must not import the production seams statically`)
    assert.match(text, /import\('[^']*app-production-seams\.mjs'\)/)
  }
  const command = fs.readFileSync(path.join(REPOSITORY_ROOT, 'src/commands/obsidian.mjs'), 'utf8')
  assert.ok(command.indexOf("refuse('app-adapter-not-selected'", command.indexOf('const appSeams')) < command.indexOf("import('../runtime/obsidian/app-production-seams.mjs')"), 'the adapter is checked before the import')
  const entry = fs.readFileSync(path.join(REPOSITORY_ROOT, 'src/runtime/obsidian/service-main.mjs'), 'utf8')
  assert.match(entry, /createQualifiedAdapterFactory\(\{ appProbe: createProductionAppProbe\(\), createAdapter: \(\) => createObsidianCliAdapter\(\) \}\)/, 'the service constructs the CLI adapter only through the version-qualified factory')
  assert.equal((entry.match(/createObsidianCliAdapter\(/g) ?? []).length, 1)
  assert.equal(globalThis[Symbol.for('mnstry.atelier.obsidian.production-seams-loaded')], undefined)
  // Control: the trace exists. A child that only evaluates the module (it constructs and calls nothing) shows it.
  const seen = childProcess.spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(path.join(REPOSITORY_ROOT, 'src/runtime/obsidian/app-production-seams.mjs')).href)}); process.stdout.write(String(globalThis[Symbol.for('mnstry.atelier.obsidian.production-seams-loaded')]))`], { encoding: 'utf8', windowsHide: true })
  assert.equal(seen.stdout, 'true')
})

// ---------------------------------------------------------------------------
// 2. The minimum app version
// ---------------------------------------------------------------------------

const VERSION_CASES = [
  ['1.13.7', true], ['1.13.7 (installer 1.12.7)', true], ['v1.13.7', true], ['1.13.8', true], ['1.14.0', true], ['2.0.0', true], ['1.13.10', true], ['1.13.7+build.5', true],
  ['1.13.6', false], ['1.12.99', false], ['0.99.99', false], ['1.13.7-beta', false], ['1.13.7-rc.1', false], ['1.14.0-insider', true], ['1.13', false], ['1.13.7.1', false],
  ['', false], ['latest', false], ['installer 1.13.7', false], ['1.13.x', false], ['01.13.7', false], ['1.13.7abc', false], [' ', false], ['9'.repeat(300), false], [null, false], [undefined, false], [11307, false], [{}, false],
]

function assertVersionFloor(meets) {
  for (const [version, expected] of VERSION_CASES) assert.equal(meets(version), expected, `version ${JSON.stringify(version)}`)
}

test('the minimum app version is one constant and a pure comparator; prereleases rank below their release and garbage never passes', () => {
  assert.equal(MINIMUM_APP_VERSION, '1.13.7')
  assertVersionFloor((version) => meetsMinimumAppVersion(version))
  assert.deepEqual([compareAppVersions('1.13.7', '1.13.7'), compareAppVersions('1.13.7-rc.1', '1.13.7-rc.2'), compareAppVersions('1.13.7-rc.2', '1.13.7-rc.10'), compareAppVersions('1.13.7-1', '1.13.7-alpha'), compareAppVersions('1.2.3', 'garbage')], [0, -1, -1, -1, null])
  assert.deepEqual(parseAppVersion('1.13.7-rc.1 (installer 1.12.7)'), { major: 1, minor: 13, patch: 7, prerelease: ['rc', '1'] })
})

test('mutation control: a comparator that reads the first number it finds, or compares text, fails the version oracle', () => {
  assert.throws(() => assertVersionFloor((version) => { const found = /(\d+)\.(\d+)\.(\d+)/.exec(String(version)); return found !== null && (Number(found[1]) > 1 || Number(found[2]) > 13 || (Number(found[2]) === 13 && Number(found[3]) >= 7)) }), assert.AssertionError)
  assert.throws(() => assertVersionFloor((version) => String(version) >= '1.13.7'), assert.AssertionError)
})

const APP_CASES = [
  [{ installed: false, cli: false, running: null, version: null }, 'app-missing'],
  [{ installed: true, cli: false, running: true, version: '1.13.7' }, 'app-cli-unavailable'],
  [{ installed: true, cli: true, running: true, version: '1.13.6' }, 'app-version-unsupported'],
  [{ installed: true, cli: true, running: true, version: 'nonsense' }, 'app-version-unsupported'],
  [{ installed: true, cli: true, running: true, version: null }, 'app-version-unsupported'],
  [{ installed: true, cli: true, running: null, version: null }, 'app-version-unsupported'],
  [{ installed: true, cli: true, running: true, version: '1.13.7' }, 'qualified'],
  [null, 'app-missing'],
]

test('the app qualification is typed and fails closed; the qualified adapter factory never constructs an adapter for an app below the floor', () => {
  for (const [observation, outcome] of APP_CASES) assert.equal(qualifyApp(observation).outcome, outcome, JSON.stringify(observation))
  assert.equal(qualifyApp({ installed: true, cli: true, running: false, version: null }).outcome, 'app-version-unsupported', 'opening needs the version')
  assert.equal(qualifyApp({ installed: true, cli: true, running: false, version: null }, { requireVersion: false }).outcome, 'qualified', 'nothing is published through an app that does not run')

  const factoryFor = (observation) => { const built = []; const factory = createQualifiedAdapterFactory({ appProbe: { inspectSync: () => { if (observation instanceof Error) throw observation; return observation } }, createAdapter: (input) => { built.push(input); return { kind: 'fake' } } }); return { factory, built } }
  for (const [observation, code] of [[{ installed: true, cli: true, running: true, version: '1.13.6' }, 'app-version-unsupported'], [{ installed: true, cli: true, running: true, version: 'what' }, 'app-version-unsupported'], [{ installed: true, cli: true, running: null, version: null }, 'app-version-unsupported'], [{ installed: true, cli: false, running: false, version: null }, 'app-cli-unavailable']]) {
    const { factory, built } = factoryFor(observation)
    assert.throws(() => factory({}), (error) => error instanceof ObsidianMaintenanceRefusal && error.code === code, JSON.stringify(observation))
    assert.deepEqual([built.length, factory.lastQualification().outcome], [0, code])
  }
  for (const observation of [{ installed: true, cli: true, running: true, version: '1.13.7' }, { installed: true, cli: true, running: false, version: null }, { installed: false, cli: false, running: false, version: null }, new Error('probe failed')]) {
    const { factory, built } = factoryFor(observation)
    // No app at all (or a probe that fails, which reads as none) is the publisher's own path; its adapter looks at the process table itself.
    assert.equal(factory({}).kind, 'fake')
    assert.equal(built.length, 1)
  }
})

async function assertUnqualifiedAppIsNeverPublishedThrough(t, factoryOf) {
  const world = makeWorld(t)
  const published = []
  const built = []
  const adapterFactory = factoryOf({ appProbe: { inspectSync: () => ({ installed: true, cli: true, running: true, version: '1.13.6' }) }, createAdapter: () => { built.push(1); return absentAdapter() } })
  const engine = world.engine({ adapterFactory, seams: { publishView: async (input) => { published.push(input); return REFUSED_PUBLICATION } } })
  const report = await engine.tick()
  assert.deepEqual([report.scopes[0].state, report.scopes[0].reason, published.length, built.length], ['stale', 'app-version-unsupported', 0, 0], 'the reason is persisted as freshness and the publisher is never reached')
  const status = await world.run(['status', '--json'])
  assert.deepEqual([status.json.scopes[0].outcome, status.json.scopes[0].reason], ['not-prepared', 'app-version-unsupported'], 'and status says so')
}

test('below the floor the engine publishes nothing, and status reports why', async (t) => {
  await assertUnqualifiedAppIsNeverPublishedThrough(t, createQualifiedAdapterFactory)
})

test('a service whose adapter factory qualified an app says what it learned in its status, and the command repeats it', async (t) => {
  const world = makeWorld(t)
  const adapterFactory = createQualifiedAdapterFactory({ appProbe: { inspectSync: () => ({ installed: true, cli: true, running: true, version: '1.12.4' }) }, createAdapter: absentAdapter })
  await world.service({ adapterFactory, appStatus: () => { const known = adapterFactory.lastQualification(); return known === null ? null : { outcome: known.outcome, reason: known.reason, version: known.version, floor: known.floor } } })
  const status = await world.run(['status', '--json'])
  assert.deepEqual(status.json.service.app, { outcome: 'app-version-unsupported', reason: 'below-minimum-version', version: '1.12.4', floor: MINIMUM_APP_VERSION })
  assert.deepEqual([status.json.scopes[0].outcome, status.json.scopes[0].reason, fs.readdirSync(world.vault()).filter((name) => name.endsWith('.md')).length], ['not-prepared', 'app-version-unsupported', 0], 'nothing was published through it')
})

test('mutation control: a factory that does not look at the version fails the floor oracle', async (t) => {
  await assert.rejects(assertUnqualifiedAppIsNeverPublishedThrough(t, ({ createAdapter }) => (input) => createAdapter(input)), assert.AssertionError)
})

// ---------------------------------------------------------------------------
// 3. Every opening outcome, reached, and no two confusable
// ---------------------------------------------------------------------------

// Each scenario builds its own world and answers what `open` reported. The expected outcome is the key.
const SCENARIOS = {
  current: { ...needsExchange, async run(t, rules) { const world = makeWorld(t); await world.service(); const app = fakeApp(); return { result: await world.run(openArgs(), { seams: { ...UNREACHABLE_SEAMS, ...app }, rules }), app, world } } },
  'held-for-your-edit': {
    ...needsExchange,
    async run(t, rules) {
      const world = makeWorld(t)
      await world.service()
      fs.appendFileSync(world.noteFile('west-wing:tide'), '\nA line somebody typed in the vault.\n')
      world.advance(1000)
      return { result: await world.run(openArgs(), { seams: { ...UNREACHABLE_SEAMS, ...fakeApp() }, rules }), world }
    },
  },
  'stale-readable': {
    ...needsExchange,
    async run(t, rules) {
      const world = makeWorld(t)
      let broken = false
      const { buildGraph } = await import('../src/runtime/obsidian/pipeline.mjs')
      await world.service({ engineOptions: { seams: { buildGraph: (input) => { if (broken) throw new ObsidianMaintenanceRefusal('canonical-graph-invalid', 'stub'); return buildGraph(input) } } } })
      broken = true
      fs.appendFileSync(world.source('west-wing/logs/tide.md'), '\nLow water at six.\n')
      world.advance(1000)
      return { result: await world.run(openArgs(), { seams: { ...UNREACHABLE_SEAMS, ...fakeApp() }, rules }), world }
    },
  },
  'not-prepared': { async run(t, rules) { const world = makeWorld(t); await world.service({ engineOptions: { seams: { publishView: async () => REFUSED_PUBLICATION } } }); return { result: await world.run(openArgs(), { seams: { ...UNREACHABLE_SEAMS, ...fakeApp() }, rules }), world } } },
  'publisher-conflict': { async run(t, rules) { const world = makeWorld(t); await world.service({ engineOptions: { seams: { publishView: async () => CONFLICT_PUBLICATION } } }); return { result: await world.run(openArgs(), { seams: { ...UNREACHABLE_SEAMS, ...fakeApp() }, rules }), world } } },
  updating: { async run(t, rules) { const world = makeWorld(t); await world.service({ createEngine: idleEngine }); plantFreshness(world, [{ state: 'updating', reason: 'publishing' }]); return { result: await world.run(openArgs(), { seams: { ...UNREACHABLE_SEAMS, ...fakeApp() }, rules }), world } } },
  disabled: { async run(t, rules) { const world = makeWorld(t, { ext: { ...settingsOf(), enabled: false } }); return { result: await world.run(openArgs(), { seams: { ...UNREACHABLE_SEAMS, ...fakeApp() }, rules }), world } } },
  'service-unavailable': {
    async run(t, rules) {
      const world = makeWorld(t)
      const port = await freePort()
      await listenOn(t, port, (request, response) => { response.writeHead(200, { 'Content-Type': 'text/plain', Connection: 'close' }); response.end('somebody else') })
      writeServiceSettings({ ...world.workspace(), settings: { schema: 'atelier-obsidian-service-settings/v1', workspaceId: WORKSPACE_ID, host: '127.0.0.1', port, consent: { grantedAt: iso(START), ...CONSENT }, updatedAt: iso(START) } })
      return { result: await world.run(openArgs(), { seams: { ...UNREACHABLE_SEAMS, ...fakeApp() }, rules }), world }
    },
  },
  busy: {
    async run(t, rules) {
      const world = makeWorld(t)
      const port = await freePort()
      await listenOn(t, port, () => { /* accepts, never answers: a service in a long tick */ })
      writeServiceSettings({ ...world.workspace(), settings: { schema: 'atelier-obsidian-service-settings/v1', workspaceId: WORKSPACE_ID, host: '127.0.0.1', port, consent: { grantedAt: iso(START), ...CONSENT }, updatedAt: iso(START) } })
      plantRecord(world, { port, pid: process.pid })
      // This process stands for the recorded service: its command line is made to name the recorded entry.
      return { result: await world.run(openArgs(), { seams: { ...UNREACHABLE_SEAMS, ...fakeApp() }, rules: { ...rules, lifecycle: { ...LIFECYCLE_PRIMITIVES, provesOurProcess: () => true } }, probeTimeoutMs: 400 }), world }
    },
  },
  'app-missing': { ...needsExchange, run: (t, rules) => openWithApp(t, rules, { installed: false, cli: false }) },
  'app-cli-unavailable': { ...needsExchange, run: (t, rules) => openWithApp(t, rules, { cli: false }) },
  'app-version-unsupported': { ...needsExchange, run: (t, rules) => openWithApp(t, rules, { version: '1.13.6' }) },
  indexing: { ...needsExchange, run: (t, rules) => openWithApp(t, rules, { indexReady: false }) },
  'launch-failed': { ...needsExchange, run: (t, rules) => openWithApp(t, rules, { launchResult: { launched: false, reason: 'os-open-failed' } }) },
}

function plantRecord(world, { port, pid, runtimeId = 'rt-planted' }) {
  return writeServiceRecord({
    ...world.workspace(),
    record: {
      schema: 'atelier-obsidian-service-state/v1', contractVersion: '1.0.0', workspaceId: WORKSPACE_ID, serviceName: serviceNameFor(WORKSPACE_ID), host: '127.0.0.1', port, runtimeId, pid,
      executable: { path: fs.realpathSync(TEST_SERVICE_ENTRY), digest: digest(fs.readFileSync(TEST_SERVICE_ENTRY)) }, stateLocation: path.join(world.workspaceRoot(), 'state'),
      health: { status: 'healthy', checkedAt: iso(START) }, consent: { grantedAt: iso(START), ...CONSENT }, ext: { bearer: randomBytes(32).toString('base64url') },
    },
  })
}

async function openWithApp(t, rules, appState) {
  const world = makeWorld(t)
  await world.service()
  const app = fakeApp(appState)
  return { result: await world.run(openArgs(), { seams: { ...UNREACHABLE_SEAMS, ...app }, rules, open: { appWaitMs: 150, appPollMs: 25 } }), app, world }
}

const runnable = (name) => SCENARIOS[name].skip === undefined

async function assertOutcomesAreDistinct(t, rules) {
  const seen = new Map()
  for (const name of Object.keys(SCENARIOS).filter(runnable)) {
    const { result } = await SCENARIOS[name].run(t, rules)
    assert.notEqual(result.json, null, `${name}: one JSON document`)
    seen.set(name, result.json.outcome)
    assert.equal(result.json.outcome, name, `the ${name} scenario reported ${result.json.outcome} (${result.json.reason})`)
    assert.deepEqual([result.json.ok, result.exit], name === 'current' ? [true, EXIT.ok] : [false, EXIT.notSuccess], `${name}: only current is success`)
    assert.deepEqual([result.json.summary, result.json.next], [OPENING_OUTCOMES[name].summary, OPENING_OUTCOMES[name].next])
  }
  assert.equal(new Set(seen.values()).size, seen.size, 'no two scenarios share an outcome')
}

test('every opening outcome is reached through the command, is typed with an explanation and a next step, and only current is success', async (t) => {
  await assertOutcomesAreDistinct(t, undefined)
  assert.deepEqual(Object.keys(SCENARIOS).sort(), Object.keys(OPENING_OUTCOMES).sort(), 'the table names every outcome the command can report')
  for (const entry of Object.values(OPENING_OUTCOMES)) assert.ok(entry.summary.length > 10 && !entry.summary.includes('\n') && entry.next.length > 5)
  assert.equal(new Set(Object.values(OPENING_OUTCOMES).map((entry) => entry.summary)).size, Object.keys(OPENING_OUTCOMES).length)
})

test('mutation control: rules that collapse a publisher conflict into updating fail the distinctness oracle', async (t) => {
  const collapsed = { ...OPENING_PRIMITIVES, outcomeOfState: (state) => (state === 'publisher-conflict' ? 'updating' : OPENING_PRIMITIVES.outcomeOfState(state)) }
  await assert.rejects(assertOutcomesAreDistinct(t, { opening: collapsed }), assert.AssertionError)
})

test('open reports a skipped platform honestly', { skip: EXCHANGE_HERE ? 'this platform publishes: nothing was skipped above' : false }, () => {
  assert.deepEqual(Object.keys(SCENARIOS).filter((name) => !runnable(name)).sort(), ['app-cli-unavailable', 'app-missing', 'app-version-unsupported', 'current', 'held-for-your-edit', 'indexing', 'launch-failed', 'stale-readable'])
})

// ---------------------------------------------------------------------------
// 4. `current` needs the exact generation, a read-back and the app
// ---------------------------------------------------------------------------

test('open is current only after a tick, an exact verified generation, a byte-for-byte read-back and a qualified app that answers for this vault', needsExchange, async (t) => {
  const { result, app, world } = await SCENARIOS.current.run(t)
  const document = result.json
  assert.deepEqual([document.outcome, document.launched, document.app.outcome, document.app.floor], ['current', true, 'qualified', MINIMUM_APP_VERSION])
  assert.deepEqual(app.launches, [world.vault()], 'the launcher was asked for exactly this vault, once')
  assert.equal(document.freshness.generationId, world.manifest().generationId)
  assert.deepEqual([document.freshness.generationId === document.freshness.preparedGenerationId, document.freshness.verified, document.readBack.intact, document.readBack.generationId, document.readBack.noteCount > 0], [true, true, true, document.freshness.generationId, true])
  assert.deepEqual([document.pendingEdits.open, document.pendingEdits.apply], [0, 'apply-unavailable'], 'apply-unavailable is a sub-state of pending edits, not an opening failure')
})

// A service that did nothing wrote "current" for a generation; what `open` believes is decided by reading back.
async function assertReadBackDecides(t, rules, { claim, tamper }) {
  const world = makeWorld(t)
  const real = await world.service()
  const published = world.manifest().generationId
  await real.shutdown('handing over to a service that lies')
  await world.service({ createEngine: idleEngine })
  const generationId = claim === 'another-generation' ? `${published}-later` : published
  plantFreshness(world, [{ state: 'current', reason: 'published-and-verified', generationId, preparedGenerationId: generationId, verified: true }])
  if (tamper) fs.appendFileSync(world.noteFile('east-wing:compass'), '\nwritten after the last look\n')
  const app = fakeApp()
  const result = await world.run(openArgs(), { seams: { ...UNREACHABLE_SEAMS, ...app }, rules })
  return { result, app }
}

test('a lying publisher, a stale generation and a note changed since the last look are never current, and the app is not launched', needsExchange, async (t) => {
  const stale = await assertReadBackDecides(t, undefined, { claim: 'another-generation' })
  assert.deepEqual([stale.result.json.outcome, stale.result.json.reason, stale.app.launches.length], ['stale-readable', 'trusted-generation-differs', 0])
  const edited = await assertReadBackDecides(t, undefined, { claim: 'this-generation', tamper: true })
  assert.deepEqual([edited.result.json.outcome, edited.result.json.reason, edited.result.json.readBack.differing, edited.app.launches.length], ['updating', 'vault-differs-from-trusted-generation', 1, 0])
  const honest = await assertReadBackDecides(t, undefined, { claim: 'this-generation' })
  assert.equal(honest.result.json.outcome, 'current', 'control: the same arrangement with a true claim is current')

  // A publisher that claims a commit it never made: the engine does not believe it, and neither does open.
  const world = makeWorld(t)
  await world.service({ engineOptions: { seams: { publishView: async ({ preparedView }) => ({ state: 'committed', alreadyCommitted: false, generationId: preparedView.manifest.generationId, journalId: 'journal-none', notes: [], retainedEdits: [], lateWriters: [] }) } } })
  const lied = await world.run(openArgs(), { seams: { ...UNREACHABLE_SEAMS, ...fakeApp() } })
  assert.notEqual(lied.json.outcome, 'current')
  assert.equal(lied.json.ok, false)
})

test('mutation control: an open that believes the persisted claim without reading back reports a stale generation as current', needsExchange, async (t) => {
  const believing = { opening: { ...OPENING_PRIMITIVES, readBackAgrees: () => true } }
  assert.equal((await assertReadBackDecides(t, believing, { claim: 'another-generation' })).result.json.outcome, 'current')
  assert.equal((await assertReadBackDecides(t, believing, { claim: 'this-generation', tamper: true })).result.json.outcome, 'current')
})

test('an app below the floor is never launched; one that turns out to be below it after launch is not current; one that never comes up is a failed launch', needsExchange, async (t) => {
  const below = await openWithApp(t, undefined, { running: true, version: '1.13.6' })
  assert.deepEqual([below.result.json.outcome, below.result.json.reason, below.app.launches.length, below.result.json.launched], ['app-version-unsupported', 'below-minimum-version', 0, false])
  const unreadable = await openWithApp(t, undefined, { running: true, version: 'Obsidian' })
  assert.deepEqual([unreadable.result.json.outcome, unreadable.result.json.reason, unreadable.app.launches.length], ['app-version-unsupported', 'version-unreadable', 0])
  const afterLaunch = await openWithApp(t, undefined, { running: false, version: '1.12.0' })
  assert.deepEqual([afterLaunch.result.json.outcome, afterLaunch.app.launches.length, afterLaunch.result.json.launched], ['app-version-unsupported', 1, true], 'the version is only knowable once the app runs')
  const neverUp = await openWithApp(t, undefined, { comesUp: false })
  assert.deepEqual([neverUp.result.json.outcome, neverUp.result.json.reason], ['app-version-unsupported', 'version-unknown'], 'an app whose version never becomes known is not qualified')
  const otherVault = await openWithApp(t, undefined, { answered: false })
  assert.deepEqual([otherVault.result.json.outcome, otherVault.result.json.reason], ['launch-failed', 'app-did-not-answer-for-this-vault'])
})

test('mutation control: an open that skips the app prerequisites reports current for an app below the floor', needsExchange, async (t) => {
  const result = await openWithApp(t, { opening: { ...OPENING_PRIMITIVES, appQualifies: () => true } }, { running: true, version: '1.13.6' })
  assert.equal(result.result.json.outcome, 'current')
})

test('--allow-stale opens a readable vault as it is and still does not call it current', needsExchange, async (t) => {
  const world = makeWorld(t)
  await world.service()
  fs.appendFileSync(world.noteFile('west-wing:tide'), '\nA line somebody typed in the vault.\n')
  world.advance(1000)
  const app = fakeApp()
  const result = await world.run(openArgs(['--allow-stale']), { seams: { ...UNREACHABLE_SEAMS, ...app } })
  assert.deepEqual([result.json.outcome, result.json.ok, result.exit, result.json.launched, app.launches.length], ['held-for-your-edit', false, EXIT.notSuccess, true, 1])
  assert.deepEqual([result.json.pendingEdits.open, result.json.pendingEdits.byState.queued], [1, 1])
})

test('open starts the owned service the first time only with a consent, reconnects afterwards, and an unknown view refuses', async (t) => {
  const world = makeWorld(t)
  const seams = { ...UNREACHABLE_SEAMS, ...fakeApp(), service: { entryPath: TEST_SERVICE_ENTRY, intervalMs: IDLE_INTERVAL, spawn: trackingSpawn(t) } }
  const refused = await world.run(['open', '--json'], { seams })
  assert.deepEqual([refused.json.outcome, refused.json.reason, SPAWNED.filter((entry) => entry.test === t.name).length], ['service-unavailable', 'startup-consent-required', 0])
  const bareStart = await world.run(['service', 'start', '--json'], { seams })
  assert.deepEqual([bareStart.exit, bareStart.json.error.code, SPAWNED.filter((entry) => entry.test === t.name).length], [EXIT.refused, 'startup-consent-required', 0], 'service start needs the same explicit consent the first time')
  const first = await world.run(openArgs(), { seams })
  const record = readServiceRecord(world.workspace())
  assert.ok(record !== null && isAlive(record.pid), 'the service it started is running')
  assert.equal(first.json.service.runtimeId, record.runtimeId)
  assert.equal(first.json.outcome, EXCHANGE_HERE ? 'current' : 'not-prepared')
  const again = await world.run(['open', '--json'], { seams })
  assert.deepEqual([again.json.service.runtimeId, SPAWNED.filter((entry) => entry.test === t.name).length], [record.runtimeId, 1], 'a second open reconnects: no consent needed, nothing started')
  const unknown = await world.run(openArgs(['--scope', 'scope-nowhere']), { seams })
  assert.deepEqual([unknown.exit, unknown.json.error.code], [EXIT.refused, 'unknown-scope'])
  const stopped = await world.run(['service', 'stop', '--json'], { seams })
  assert.deepEqual([stopped.exit, stopped.json.service.stopped], [EXIT.ok, true])
  await waitFor(() => !isAlive(record.pid), { label: 'the stopped service to exit' })
})

// ---------------------------------------------------------------------------
// 5. busy, occupied and pid-not-ours
// ---------------------------------------------------------------------------

async function assertBusyIsToldApart(t, provesOurProcess) {
  const world = makeWorld(t)
  const silent = await freePort()
  await listenOn(t, silent, () => { /* accepts, never answers */ })
  const lifecycle = { loadProject: world.loadProject, dataRoot: world.dataRoot, env: world.env, probeTimeoutMs: 300, entryPath: TEST_SERVICE_ENTRY, spawn: () => { throw new Error('a service was started') }, kill: () => { throw new Error('a PID was signalled') } }
  const using = { ...LIFECYCLE_PRIMITIVES, provesOurProcess }
  writeServiceSettings({ ...world.workspace(), settings: { schema: 'atelier-obsidian-service-settings/v1', workspaceId: WORKSPACE_ID, host: '127.0.0.1', port: silent, consent: { grantedAt: iso(START), ...CONSENT }, updatedAt: iso(START) } })

  // Ours, alive, silent: busy. Never stopped, never started over.
  plantRecord(world, { port: silent, pid: process.pid, runtimeId: 'rt-ours' })
  assert.deepEqual([(await serviceStatus(lifecycle, using)).state, (await serviceStatus(lifecycle, using)).reason], ['busy', 'our-service-did-not-answer-health-in-time'])
  const started = await startService(lifecycle, using)
  assert.deepEqual([started.state, started.started, started.alreadyRunning, started.busy], ['busy', false, true, true])
  const stopped = await stopService(lifecycle, using)
  assert.deepEqual([stopped.state, stopped.stopped, stopped.refused, stopped.retry, stopped.reason], ['busy', false, true, true, 'service-is-busy-ask-again-later'])
  assert.equal(readServiceRecord(world.workspace()).runtimeId, 'rt-ours', 'the record of a busy service is left alone')

  // The same silent listener under a record nobody proved: occupied. Start refuses, stop refuses without a retry hint.
  plantRecord(world, { port: silent, pid: process.pid, runtimeId: 'rt-unproven' })
  assert.deepEqual([(await serviceStatus(lifecycle, using)).state, (await serviceStatus(lifecycle, using)).reason], ['occupied', 'listener-did-not-answer-in-time'])
  await assert.rejects(startService(lifecycle, using), (error) => error.code === 'service-port-occupied')
  const refused = await stopService(lifecycle, using)
  assert.deepEqual([refused.state, refused.refused, refused.retry ?? false], ['occupied', true, false])

  // A closed port with a live recorded PID: not ours, whatever the process looks like.
  const closed = await freePort()
  writeServiceSettings({ ...world.workspace(), settings: { schema: 'atelier-obsidian-service-settings/v1', workspaceId: WORKSPACE_ID, host: '127.0.0.1', port: closed, consent: { grantedAt: iso(START), ...CONSENT }, updatedAt: iso(START) } })
  plantRecord(world, { port: closed, pid: process.pid, runtimeId: 'rt-ours' })
  assert.equal((await serviceStatus(lifecycle, using)).state, 'pid-not-ours')
  // A silent listener whose recorded PID is gone is never busy either.
  const gone = childProcess.spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid
  writeServiceSettings({ ...world.workspace(), settings: { schema: 'atelier-obsidian-service-settings/v1', workspaceId: WORKSPACE_ID, host: '127.0.0.1', port: silent, consent: { grantedAt: iso(START), ...CONSENT }, updatedAt: iso(START) } })
  plantRecord(world, { port: silent, pid: gone, runtimeId: 'rt-ours' })
  assert.equal((await serviceStatus(lifecycle, using)).state, 'occupied')
}

test('busy is a silent listener whose live recorded PID provably runs our executable; occupied and pid-not-ours stay what they were', async (t) => {
  // The process table is not consulted here: the proof is stood in for by the runtime the record names.
  await assertBusyIsToldApart(t, (record) => record.runtimeId === 'rt-ours')
  // The production proof, on this very process: it does not run the recorded entry, so it is not proven.
  const record = { pid: process.pid, runtimeId: 'rt-ours', executable: { path: fs.realpathSync(TEST_SERVICE_ENTRY), digest: digest(fs.readFileSync(TEST_SERVICE_ENTRY)) } }
  assert.equal(LIFECYCLE_PRIMITIVES.provesOurProcess(record), false)
})

test('mutation control: a status that calls every silent listener busy fails the busy oracle', async (t) => {
  await assert.rejects(assertBusyIsToldApart(t, () => true), assert.AssertionError)
})

test('the command line proof: the recorded entry and, when named, the recorded runtime', () => {
  const entry = path.join(path.sep, 'opt', 'synthetic', 'service entry.mjs')
  const record = { runtimeId: 'rt-one', executable: { path: entry } }
  assert.equal(commandLineNamesRecord(['node', entry, '--project=x', '--runtime-id=rt-one'], record), true)
  assert.equal(commandLineNamesRecord(['node', entry, '--startup'], record), true, 'a unit names no runtime')
  assert.equal(commandLineNamesRecord(['node', entry, '--runtime-id=rt-two'], record), false, 'an earlier runtime of the same entry')
  assert.equal(commandLineNamesRecord(['node', `${entry}.bak`, '--runtime-id=rt-one'], record), false)
  assert.equal(commandLineNamesRecord([entry], record), false, 'the entry must be an argument, not the program')
  assert.equal(commandLineNamesRecord(`node ${entry} --runtime-id=rt-one`, record), true)
  assert.equal(commandLineNamesRecord(`node ${entry}.bak --runtime-id=rt-one`, record), false)
  assert.equal(commandLineNamesRecord(`node ${entry} --runtime-id=rt-two`, record), false)
  for (const nothing of [null, undefined, '', [], 7]) assert.equal(commandLineNamesRecord(nothing, record), false)
  assert.equal(readProcessCommandLine(process.pid, { platform: 'win32' }), null, 'not established on Windows: a silent service reads as occupied there')
  assert.deepEqual(readProcessCommandLine(41, { platform: 'linux', readFile: () => `node\u0000${entry}\u0000--startup\u0000` }), ['node', entry, '--startup'])
  assert.equal(readProcessCommandLine(41, { platform: 'darwin', run: () => { throw new Error('no such process') } }), null)
})

// A real service that stops answering: its event loop is blocked, as in a long synchronous tick.
const BLOCKING_ENTRY = (flag) => `import fs from 'node:fs'
import { createEditorAdapter } from ${JSON.stringify(pathToFileURL(path.join(REPOSITORY_ROOT, 'src/projection/obsidian/publication/index.mjs')).href)}
import { runServiceProcess, serviceOptionsFromArgv } from ${JSON.stringify(pathToFileURL(path.join(REPOSITORY_ROOT, 'src/runtime/obsidian/service-main.mjs')).href)}
import { fileURLToPath } from 'node:url'
const { adapter: _never, ...options } = serviceOptionsFromArgv(process.argv.slice(2))
setInterval(() => { if (!fs.existsSync(${JSON.stringify(flag)})) return; fs.rmSync(${JSON.stringify(flag)}); const until = Date.now() + 9000; while (Date.now() < until) { /* busy */ } }, 50)
await runServiceProcess({ ...options, entryPath: fileURLToPath(import.meta.url), adapterFactory: () => createEditorAdapter({ call: async () => { throw new Error('no app') }, processProbe: () => 'absent', kind: 'absent' }), createEngine: () => ({ tick: async () => ({ state: 'ticked', scopes: [] }), stop() {} }) })
`

// The shipped service entry loads the command contributions at top level
// before it serves. Nothing those contributions import may reach the entry
// through a static import, or the process deadlocks on its own await and exits
// 13 before it ever listens. The stub entry the other tests spawn never loads
// them, so this one spawns the real entry.
test('the real service entry starts and serves: loading the shipped contributions does not deadlock the process', needsProcessProof, async (t) => {
  const world = makeWorld(t)
  const entryPath = path.join(REPOSITORY_ROOT, 'src', 'runtime', 'obsidian', 'service-main.mjs')
  const seams = { ...UNREACHABLE_SEAMS, ...fakeApp(), service: { entryPath, entryArgs: ['--adapter=obsidian-cli'], intervalMs: IDLE_INTERVAL, spawn: trackingSpawn(t) } }
  const started = await world.run(['service', 'start', '--json', '--consent-actor', CONSENT.actor], { seams, startTimeoutMs: 20000 })
  assert.deepEqual([started.exit, started.json.service.state, started.json.service.started], [EXIT.ok, 'healthy', true], JSON.stringify(started.json).slice(0, 600))
  const status = await world.run(['service', 'status', '--json'], { seams })
  assert.equal(status.json.service.state, 'healthy')
  const stop = await world.run(['service', 'stop', '--json'], { seams })
  assert.equal(stop.json.service.stopped, true, JSON.stringify(stop.json).slice(0, 300))
})

test('a real service in a long tick is busy: open says so, start starts nothing, stop refuses with a retry hint, and it is healthy again afterwards', needsProcessProof, async (t) => {
  const world = makeWorld(t)
  const flag = path.join(world.dir, 'block-now')
  const entryPath = path.join(world.dir, 'blocking-entry.mjs')
  fs.writeFileSync(entryPath, BLOCKING_ENTRY(flag))
  const seams = { ...UNREACHABLE_SEAMS, ...fakeApp(), service: { entryPath, intervalMs: IDLE_INTERVAL, spawn: trackingSpawn(t) } }
  const started = await world.run(['service', 'start', '--json', '--consent-actor', CONSENT.actor], { seams })
  assert.deepEqual([started.exit, started.json.service.state, started.json.service.started], [EXIT.ok, 'healthy', true])
  const { pid, runtimeId } = started.json.service.record
  fs.writeFileSync(flag, 'x')
  await waitFor(() => !fs.existsSync(flag), { label: 'the service to begin its long tick' })

  const fast = { seams, probeTimeoutMs: 500 }
  const opened = await world.run(openArgs(), fast)
  assert.deepEqual([opened.json.outcome, opened.exit, opened.json.launched], ['busy', EXIT.notSuccess, false])
  const startedAgain = await world.run(['service', 'start', '--json'], fast)
  assert.deepEqual([startedAgain.exit, startedAgain.json.service.state, startedAgain.json.service.started, startedAgain.json.service.busy], [EXIT.ok, 'busy', false, true])
  const stop = await world.run(['service', 'stop', '--json'], fast)
  assert.deepEqual([stop.exit, stop.json.service.state, stop.json.service.retry, stop.json.service.stopped], [EXIT.notSuccess, 'busy', true, false])
  const status = await world.run(['status', '--json'], fast)
  assert.equal(status.json.service.state, 'busy')
  assert.deepEqual([SPAWNED.filter((entry) => entry.test === t.name).length, isAlive(pid), readServiceRecord(world.workspace()).runtimeId], [1, true, runtimeId], 'one service, still alive, its record untouched')

  await waitFor(async () => (await serviceStatus({ loadProject: world.loadProject, dataRoot: world.dataRoot, env: world.env, probeTimeoutMs: 1000 })).state === 'healthy', { timeoutMs: 30000, label: 'the long tick to end' })
  const stopped = await world.run(['service', 'stop', '--json'], { seams })
  assert.deepEqual([stopped.exit, stopped.json.service.stopped], [EXIT.ok, true])
  await waitFor(() => !isAlive(pid), { label: 'the stopped service to exit' })
})

async function assertTimeoutIsNotAbandonment(t, proofOf) {
  const silent = await freePort()
  const closed = await freePort()
  await listenOn(t, silent, () => { /* a busy owner: accepts, never answers */ })
  const ticket = (port) => ({ machine: machineDigest(), pid: process.ppid > 0 ? process.ppid : 1, acquiredAt: iso(START), service: { host: '127.0.0.1', port, runtimeId: 'rt-holder' } })
  const prove = proofOf({ probe: ({ host, port }) => probeHealth({ host, port, timeoutMs: 300 }), alive: () => true })
  assert.deepEqual(await prove(ticket(silent), { nowMs: START }), { abandoned: false, reason: 'live-process-unproven' }, 'a timeout proves nothing: the lock of a busy owner is never taken')
  assert.deepEqual(await prove(ticket(closed), { nowMs: START }), { abandoned: true, reason: 'service-address-closed' }, 'a refused connection is the proof')
}

test('the engine lock is never taken from a busy owner: a refused connection proves abandonment, a timeout does not', async (t) => {
  await assertTimeoutIsNotAbandonment(t, createAbandonmentProof)
})

test('mutation control: a takeover rule that reads a timeout as a closed address fails the busy-owner oracle', async (t) => {
  const hasty = ({ probe, alive }) => createAbandonmentProof({ alive, probe: async (address) => { const answer = await probe(address); return answer.kind === 'timeout' ? { kind: 'refused' } : answer } })
  await assert.rejects(assertTimeoutIsNotAbandonment(t, hasty), assert.AssertionError)
})

// ---------------------------------------------------------------------------
// 6. Read-only operations, and one JSON document
// ---------------------------------------------------------------------------

const READ_ONLY = [['status'], ['scope', 'list'], ['scope', 'show', 'scope-whole'], ['audience', 'show'], ['mode', 'show'], ['policy', 'show'], ['service', 'status'], ['help'], ['apply']]

async function assertReadOnly(t, operations) {
  const world = makeWorld(t, { ext: settingsOf([FULL_SCOPE, EAST_SCOPE]) })
  if (EXCHANGE_HERE) { const service = await world.service(); fs.appendFileSync(world.noteFile('west-wing:tide'), '\nan edit that waits\n'); world.advance(1000); await service.tickNow() } else await world.service({ engineOptions: { seams: { publishView: async () => REFUSED_PUBLICATION } } })
  const areas = () => ({ source: listing(world.projectDir), vaults: listing(path.join(world.workspaceRoot(), 'vaults')), recovery: listing(path.join(world.workspaceRoot(), 'recovery')), staging: listing(path.join(world.workspaceRoot(), 'staging')), state: listing(path.join(world.workspaceRoot(), 'state')) })
  const before = areas()
  assert.ok(Object.keys(before.source).length > 5 && Object.keys(before.state).length > 3)
  for (const argv of operations) for (const form of [[...argv, '--json'], argv]) {
    const result = await world.run(form)
    assert.ok([EXIT.ok, EXIT.refused].includes(result.exit), form.join(' '))
    assert.deepEqual(areas(), before, `${form.join(' ')} changed a byte`)
  }
}

test('status, scope, audience show, mode show, policy show and service status leave source, vaults, recovery, staging and state byte-identical and reach no seam', async (t) => {
  await assertReadOnly(t, READ_ONLY)
})

test('mutation control: an operation that writes fails the read-only oracle', async (t) => {
  await assert.rejects(assertReadOnly(t, [...READ_ONLY, ['audience', 'set', 'team,guests']]), assert.AssertionError)
})

test('open never writes a source file, and neither does a manual-mode service behind it, even with an edit pending', needsExchange, async (t) => {
  const world = makeWorld(t)
  await world.service()
  fs.appendFileSync(world.noteFile('west-wing:tide'), '\nA line somebody typed in the vault.\n')
  world.advance(1000)
  const source = () => Object.fromEntries(REPOSITORIES.map((name) => [name, listing(path.join(world.projectDir, name))]))
  const before = source()
  for (const extra of [[], ['--allow-stale'], ['--scope', FULL_SCOPE.scopeId]]) { await world.run(openArgs(extra), { seams: { ...UNREACHABLE_SEAMS, ...fakeApp() } }); world.advance(1000) }
  assert.deepEqual(source(), before)
  assert.equal(world.machine().maintenanceMode, 'manual')
})

const ONE_DOCUMENT_CASES = [
  ['status'], ['scope', 'list'], ['scope', 'show', 'scope-whole'], ['scope', 'show', 'scope-nowhere'], ['scope', 'show'], ['audience', 'show'], ['audience', 'set', 'team,guests'], ['audience', 'set', 'not an id'], ['audience', 'set'], ['audience', 'clear'],
  ['mode', 'show'], ['mode', 'set', 'manual'], ['mode', 'set', 'automatic'], ['mode', 'set', 'sometimes'], ['policy', 'show'], ['policy', 'install', 'no-such-file.json'], ['policy', 'install'], ['policy', 'revoke'],
  ['service', 'status'], ['service', 'stop'], ['service', 'unit'], ['service', 'unit', '--print'], ['service', 'install'], ['open', '--scope', 'scope-nowhere'], ['apply'], ['help'], [], ['nonsense'], ['status', '--surprise'], ['status', '--scope'],
]

function assertOneDocument(label, { exit, stdout, stderr, json }) {
  assert.notEqual(json, null, `${label}: stdout is not one JSON document: ${stdout.slice(0, 200)}`)
  assert.equal(stderr, '', `${label}: nothing beside the document`)
  assert.deepEqual([json.schema, json.ok, typeof json.operation === 'string' || json.operation === null], [COMMAND_SCHEMA, exit === EXIT.ok, true], label)
  if (exit === EXIT.refused) assert.ok(typeof json.error.code === 'string' && typeof json.error.message === 'string' && typeof json.error.next === 'string', `${label}: a typed refusal`)
  assert.notEqual(exit, EXIT.error, `${label}: no untyped error`)
}

test('--json prints exactly one parseable document for every operation, refusals and usage errors included, and a typed code with a non-zero exit on refusal', async (t) => {
  const world = makeWorld(t)
  const seams = { ...UNREACHABLE_SEAMS, ...fakeApp() }
  const codes = {}
  for (const argv of ONE_DOCUMENT_CASES) {
    const result = await world.run([...argv, '--json'], { seams })
    assertOneDocument(argv.join(' '), result)
    codes[argv.join(' ')] = result.json.error?.code ?? 'ok'
  }
  assert.deepEqual(
    [codes['scope show scope-nowhere'], codes['audience set not an id'], codes['mode set automatic'], codes['policy install no-such-file.json'], codes['service unit'], codes.apply, codes.nonsense, codes['status --surprise'], codes['open --scope scope-nowhere']],
    ['unknown-scope', 'invalid-audience', 'automatic-mode-refused', 'invalid-apply-policy', 'usage', 'apply-unavailable', 'usage', 'usage', 'unknown-scope'],
  )
  // Human output: a refusal goes to stderr with its code and a next step, and stdout stays empty.
  const human = await world.run(['mode', 'set', 'automatic'], { seams })
  assert.deepEqual([human.exit, human.stdout, /^\[automatic-mode-refused\] /.test(human.stderr), /\nNext: /.test(human.stderr)], [EXIT.refused, '', true, true])
})

test('mutation control: an emitter that prints a progress line beside the document fails the one-document oracle', () => {
  const chatty = '{"progress":"starting"}\n{"schema":"atelier-obsidian-command/v1","ok":true,"operation":"status"}'
  let json = null
  try { json = JSON.parse(chatty) } catch { json = null }
  assert.throws(() => assertOneDocument('chatty', { exit: EXIT.ok, stdout: chatty, stderr: '', json }), assert.AssertionError)
})

test('status is honest: a persisted current is not repeated while no service proves it, and apply is reported unavailable', needsExchange, async (t) => {
  const world = makeWorld(t)
  const service = await world.service()
  const running = await world.run(['status', '--json'])
  assert.deepEqual([running.json.service.state, running.json.scopes[0].outcome, running.json.apply.state, running.json.apply.available, running.json.app.probed], ['healthy', 'current', 'apply-unavailable', false, false])
  await service.shutdown('stopped for the test')
  const stopped = await world.run(['status', '--json'])
  assert.deepEqual([stopped.json.service.state, stopped.json.scopes[0].outcome, stopped.json.scopes[0].reason, stopped.json.scopes[0].freshness.state], ['stopped', 'stale-readable', 'maintenance-not-running', 'current'], 'directly opening a vault bypasses the launcher: status does not claim currentness from an old check')
})

test('the service unit is printed by the pure builder and nothing is written or installed', async (t) => {
  const world = makeWorld(t)
  const before = listing(world.dir)
  const seams = { ...UNREACHABLE_SEAMS, service: { entryPath: TEST_SERVICE_ENTRY, entryArgs: ['--adapter=stub-for-text'], spawn() { throw new Error('a service was started') } } }
  const posix = process.platform === 'win32' ? null : await world.run(['service', 'unit', '--print', '--json'], { seams, platform: 'linux' })
  if (posix) {
    assert.deepEqual([posix.exit, posix.json.unit.kind, posix.json.installed], [EXIT.ok, 'systemd-user-unit', false])
    assert.ok(posix.json.unit.text.includes('--startup') && posix.json.unit.text.includes('--adapter=stub-for-text') && posix.json.unit.text.includes(`--project=${world.configPath}`))
  }
  const windows = await world.run(['service', 'unit', '--print', '--json'], { seams, platform: 'win32' })
  assert.deepEqual([windows.exit, windows.json.error.code], [EXIT.refused, 'startup-platform-unqualified'])
  assert.deepEqual(listing(world.dir), before)
})

// ---------------------------------------------------------------------------
// 7. Audiences, mode and the apply policy, through the command
// ---------------------------------------------------------------------------

async function assertAudienceChangeRepublishes(t, change) {
  const world = makeWorld(t, { machine: null })
  const engine = world.engine()
  const first = await engine.tick()
  assert.deepEqual([first.scopes[0].state, world.manifest().notes.length], ['current', 0], 'the default allows no audience: the first view is empty')
  const emptyGeneration = world.manifest().generationId
  await change(world)
  world.advance(1000)
  const second = await engine.tick()
  assert.deepEqual(second.changes.map((item) => item.changeClass), ['eligibility'], 'the settings digest the engine compares changed')
  assert.deepEqual([second.scopes[0].state, world.manifest().notes.length, world.manifest().generationId !== emptyGeneration], ['current', 3, true])
}

test('audience set is private, invalidates every view through the digest the engine compares, and republishes', needsExchange, async (t) => {
  await assertAudienceChangeRepublishes(t, async (world) => {
    const result = await world.run(['audience', 'set', 'team', '--json'])
    assert.deepEqual([result.exit, result.json.audienceAllow, result.json.changed, result.json.takesEffect], [EXIT.ok, ['team'], true, 'next-tick'])
    assert.deepEqual((await world.run(['audience', 'show', '--json'])).json.audienceAllow, ['team'])
    assert.deepEqual(world.machine().audienceAllow, ['team'])
    assert.equal(JSON.stringify(listing(world.projectDir)).includes('audienceAllow'), false, 'never in the project')
  })
})

test('mutation control: showing the audiences instead of setting them fails the republication oracle', needsExchange, async (t) => {
  await assert.rejects(assertAudienceChangeRepublishes(t, (world) => world.run(['audience', 'show', '--json'])), assert.AssertionError)
})

test('audience set validates, clear removes, and a project that does not declare the integration refuses', async (t) => {
  const world = makeWorld(t)
  for (const bad of ['two words', 'team,team', '-dash', `x${'y'.repeat(200)}`]) assert.equal((await world.run(['audience', 'set', bad, '--json'])).json.error.code, 'invalid-audience', bad)
  assert.deepEqual(world.machine().audienceAllow, ['team'], 'a refused set changed nothing')
  assert.deepEqual((await world.run(['audience', 'clear', '--json'])).json.audienceAllow, [])
  assert.deepEqual(world.machine().audienceAllow, [])
  const bare = makeWorld(t, { ext: null, machine: null })
  assert.equal((await bare.run(['audience', 'set', 'team', '--json'])).json.error.code, 'disabled')
  assert.equal(fs.existsSync(bare.dataRoot), false, 'and nothing was created for it')
})

test('--actor is an option of apply run: every operation that has no use for it refuses it as a usage error and does nothing', async (t) => {
  const world = makeWorld(t)
  const before = listing(world.dir)
  for (const argv of [['status'], ['scope', 'list'], ['audience', 'show'], ['mode', 'show'], ['mode', 'set', 'manual'], ['policy', 'show'], ['policy', 'revoke'], ['service', 'status'], ['open', 'scope-whole'], ['apply']]) {
    const answer = await world.run([...argv, '--actor', 'person-synthetic', '--json'])
    assert.deepEqual([answer.exit, answer.json.error.code], [EXIT.refused, 'usage'], argv.join(' '))
    assert.match(answer.json.error.message, /--actor/, argv.join(' '))
  }
  assert.deepEqual(listing(world.dir), before, 'a refused option changes nothing')
  assert.equal((await world.run(['mode', 'show', '--json'])).exit, EXIT.ok, 'the same operation without the option answers')
})

test('policy install verifies the digest a policy carries and names the expected one; policy digest prints it, reads only, and the filled-in file installs', async (t) => {
  const world = makeWorld(t)
  const { file, policy } = world.policyFile({ digest: digest('a digest nobody computed') })
  const expected = canonicalPolicyDigest(policy)
  const before = { project: listing(world.projectDir), data: fs.existsSync(world.dataRoot) ? listing(world.dataRoot) : null }
  const refused = await world.run(['policy', 'install', file, '--json'])
  assert.deepEqual([refused.exit, refused.json.error.code, refused.json.error.detail], [EXIT.refused, 'policy-digest-mismatch', { expected, carried: policy.digest }])
  assert.equal((await world.run(['policy', 'show', '--json'])).json.installed, false, 'a policy whose digest is wrong is not stored')
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), policy, 'the file of the person is never rewritten')

  const printed = await world.run(['policy', 'digest', file, '--json'])
  assert.deepEqual([printed.exit, printed.json.digest, printed.json.carried, printed.json.matches], [EXIT.ok, expected, policy.digest, false])
  assert.equal((await world.run(['policy', 'digest', file])).stdout.trim().split('\n')[0], expected, 'the first line is the digest and nothing else')
  assert.deepEqual({ project: listing(world.projectDir), data: fs.existsSync(world.dataRoot) ? listing(world.dataRoot) : null }, before, 'policy digest and a refused install write nothing')
  // Key order and the carried digest do not change it.
  const reordered = path.join(world.dir, 'policy-reordered.json')
  fs.writeFileSync(reordered, JSON.stringify(Object.fromEntries(Object.entries({ ...policy, digest: expected }).reverse())))
  assert.equal((await world.run(['policy', 'digest', reordered, '--json'])).json.matches, true)
  for (const [argv, code] of [[['policy', 'digest'], 'usage'], [['policy', 'digest', path.join(world.dir, 'no-such-file.json')], 'invalid-apply-policy']]) {
    const answer = await world.run([...argv, '--json'])
    assert.deepEqual([answer.exit, answer.json.error.code], [EXIT.refused, code], argv.join(' '))
  }

  const installed = await world.run(['policy', 'install', reordered, '--json'])
  assert.deepEqual([installed.exit, installed.json.reference.digest], [EXIT.ok, expected])
  assert.deepEqual((await world.run(['mode', 'set', 'automatic', '--json'])).exit, EXIT.ok)
})

test('policy install validates against the frozen contract and stores privately; mode set automatic refuses without an installed, matching, active policy', async (t) => {
  const world = makeWorld(t)
  const project = listing(world.projectDir)
  const automatic = () => world.run(['mode', 'set', 'automatic', '--json'])
  const refusal = async (reason) => { const result = await automatic(); assert.deepEqual([result.exit, result.json.error.code, result.json.error.detail.reason, world.machine().maintenanceMode], [EXIT.refused, 'automatic-mode-refused', reason, 'manual'], reason) }
  await refusal('no-apply-policy-installed')

  for (const [label, overrides] of [['an unknown key', { surprise: true }], ['an unknown edit class', { allowedEditClasses: ['rename-everything'] }], ['another workspace', { workspaceId: 'ws-elsewhere' }], ['an unknown schema', { schema: 'atelier-obsidian-apply-policy/v2' }]]) {
    const result = await world.run(['policy', 'install', world.policyFile(overrides).file, '--json'])
    assert.deepEqual([result.exit, result.json.error.code], [EXIT.refused, 'invalid-apply-policy'], label)
  }
  const notJson = path.join(world.dir, 'not-json.json')
  fs.writeFileSync(notJson, 'policy: yes')
  assert.equal((await world.run(['policy', 'install', notJson, '--json'])).json.error.code, 'invalid-apply-policy')
  assert.equal((await world.run(['policy', 'show', '--json'])).json.installed, false, 'a refused policy is not stored')

  for (const [overrides, reason] of [[{ status: 'paused' }, 'apply-policy-paused'], [{ mode: 'manual' }, 'apply-policy-manual'], [{ status: 'revoked' }, 'apply-policy-revoked']]) {
    assert.equal((await world.run(['policy', 'install', world.policyFile(overrides).file, '--json'])).exit, EXIT.ok)
    await refusal(reason)
  }
  const { file, policy } = world.policyFile()
  const installed = await world.run(['policy', 'install', file, '--json'])
  assert.deepEqual([installed.exit, installed.json.reference, world.machine().maintenanceMode], [EXIT.ok, { policyId: policy.policyId, version: 1, digest: policy.digest }, 'manual'], 'installing does not switch the mode')
  const stored = path.join(world.workspaceRoot(), 'state', 'settings', 'apply-policy.json')
  assert.deepEqual(JSON.parse(fs.readFileSync(stored, 'utf8')), policy)
  if (process.platform !== 'win32') assert.equal(fs.statSync(stored).mode & 0o777, 0o600)
  assert.deepEqual(listing(world.projectDir), project, 'never in the project, a repository or a note')

  const switched = await automatic()
  assert.deepEqual([switched.exit, switched.json.maintenanceMode, switched.json.apply.state, world.machine().maintenanceMode], [EXIT.ok, 'automatic', 'apply-unavailable', 'automatic'])
  assert.deepEqual((await world.run(['mode', 'show', '--json'])).json.automaticApply, { authorized: true, reason: 'apply-policy-active' })
  const revoked = await world.run(['policy', 'revoke', '--json'])
  assert.deepEqual([revoked.json.revoked, world.machine().maintenanceMode, JSON.parse(fs.readFileSync(stored, 'utf8')).status], [true, 'manual', 'revoked'])
  await refusal('apply-policy-revoked')
  assert.equal((await world.run(['policy', 'revoke', '--json'])).json.reason, 'already-revoked')
})

// Two edits wait; the apply operation revokes the policy, through the command, while it handles the first.
async function assertRevocationPrecedesQueuedApply(t, primitives) {
  const world = makeWorld(t)
  const applied = []
  const registry = createObsidianRegistry({ contributions: [{ id: 'fake-apply', register: ({ extensions }) => extensions.register('apply-operation', { id: 'fake.apply', async apply({ edit }) { applied.push(edit.path); assert.equal((await world.run(['policy', 'revoke', '--json'])).json.revoked, true); return { status: 'applied', code: 'fake' } } }) }] })
  const engine = world.engine({ primitives, extensions: registry.extensions })
  await engine.tick()
  assert.equal((await world.run(['policy', 'install', world.policyFile().file, '--json'])).exit, EXIT.ok)
  assert.equal((await world.run(['mode', 'set', 'automatic', '--json'])).exit, EXIT.ok)
  fs.appendFileSync(world.noteFile('west-wing:tide'), '\nfirst edit\n')
  fs.appendFileSync(world.noteFile('east-wing:compass'), '\nsecond edit\n')
  world.advance(1000)
  const report = await engine.tick()
  assert.deepEqual([applied.length, report.dispatched.length], [1, 1], 'the edit queued behind the revocation was never dispatched')
  assert.deepEqual(report.pendingEdits.map((edit) => edit.state), ['queued'])
  assert.equal(world.machine().maintenanceMode, 'manual')
  world.advance(120000)
  await engine.tick()
  assert.equal(applied.length, 1, 'nor on a later tick')
}

test('policy revoke through the command takes effect before an apply that is already queued', needsExchange, async (t) => {
  await assertRevocationPrecedesQueuedApply(t, ENGINE_PRIMITIVES)
})

test('mutation control: an engine that authorizes once per tick applies the queued edit after the revocation', needsExchange, async (t) => {
  let remembered = null
  const once = { ...ENGINE_PRIMITIVES, authorize: (input) => { remembered ??= ENGINE_PRIMITIVES.authorize(input); return remembered } }
  await assert.rejects(assertRevocationPrecedesQueuedApply(t, once), assert.AssertionError)
})

test('automatic mode before an apply operation ships: every attempt is the typed apply-unavailable, and status, open and the apply operation all say so', needsExchange, async (t) => {
  const world = makeWorld(t)
  const service = await world.service()
  assert.equal((await world.run(['policy', 'install', world.policyFile().file, '--json'])).exit, EXIT.ok)
  assert.equal((await world.run(['mode', 'set', 'automatic', '--json'])).exit, EXIT.ok)
  const source = listing(path.join(world.projectDir, 'west-wing'))
  fs.appendFileSync(world.noteFile('west-wing:tide'), '\nan edit with nowhere to go yet\n')
  world.advance(1000)
  await service.tickNow()
  const status = await world.run(['status', '--json'])
  assert.deepEqual([status.json.apply.state, status.json.scopes[0].pendingEdits.byState['apply-unavailable'], status.json.scopes[0].pendingEdits.apply, status.json.scopes[0].outcome], ['apply-unavailable', 1, 'apply-unavailable', 'held-for-your-edit'])
  const opened = await world.run(openArgs(), { seams: { ...UNREACHABLE_SEAMS, ...fakeApp() } })
  assert.deepEqual([opened.json.outcome, opened.json.pendingEdits.apply, opened.json.pendingEdits.byState['apply-unavailable']], ['held-for-your-edit', 'apply-unavailable', 1], 'a sub-state of the pending edit, not the opening outcome')
  const attempt = await world.run(['apply', '--json'])
  assert.deepEqual([attempt.exit, attempt.json.error.code], [EXIT.refused, 'apply-unavailable'])
  assert.deepEqual(listing(path.join(world.projectDir, 'west-wing')), source, 'and no source file was written')
})

// ---------------------------------------------------------------------------
// 8. Extension points: registered from outside, no shared file edited
// ---------------------------------------------------------------------------

const OUTSIDE = (calls) => ({
  id: 'later-work',
  register({ extensions, operations }) {
    extensions.register('apply-operation', { id: 'later.apply', async apply(input) { calls.push(['apply', input.edit.path]); return { status: 'applied', code: 'later' } } })
    extensions.register('proposal-adapter', { id: 'later.proposals', async propose() { return null } })
    operations.register({ name: 'focus', summary: 'a sub-operation added by later work', async run({ args, registry }) { calls.push(['focus', ...args]); return { exit: 0, document: { focused: args, apply: registry.extensions.applyOperation().id }, human: [`focused ${args.join(' ')}`] } } })
    operations.register({ name: 'apply', summary: 'the real apply, replacing the placeholder', async run() { calls.push(['apply-command']); return { exit: 0, document: { applied: 0 } } } })
  },
})

test('later work registers an apply operation, a proposal adapter and sub-operations from outside, and the engine and the command both use them', needsExchange, async (t) => {
  const world = makeWorld(t)
  const calls = []
  const contributions = [OUTSIDE(calls)]
  const focused = await world.run(['focus', 'east', 'wing', '--json'], { contributions })
  assert.deepEqual([focused.exit, focused.json.operation, focused.json.focused, focused.json.apply], [EXIT.ok, 'focus', ['east', 'wing'], 'later.apply'])
  assert.equal((await world.run(['apply', '--json'], { contributions })).json.applied, 0, 'the placeholder apply was replaced')
  const status = await world.run(['status', '--json'], { contributions })
  assert.deepEqual([status.json.apply, status.json.extensions, status.json.operations.map((item) => item.name)], [{ available: true, state: 'available', operationId: 'later.apply' }, [{ kind: 'apply-operation', id: 'later.apply' }, { kind: 'proposal-adapter', id: 'later.proposals' }], ['apply', 'focus']])
  // Control: without the contribution none of it exists.
  assert.deepEqual([(await world.run(['focus', '--json'])).json.error.code, (await world.run(['apply', '--json'])).json.error.code, (await world.run(['status', '--json'])).json.apply.state], ['usage', 'apply-unavailable', 'apply-unavailable'])

  // The same registry value is what a service hands its engine.
  const registry = createObsidianRegistry({ reservedOperations: BUILT_IN_OPERATIONS, contributions })
  const service = await world.service({ engineOptions: { extensions: registry.extensions } })
  assert.equal((await world.run(['policy', 'install', world.policyFile().file, '--json'])).exit, EXIT.ok)
  assert.equal((await world.run(['mode', 'set', 'automatic', '--json'], { contributions })).json.apply.state, 'available')
  fs.appendFileSync(world.noteFile('west-wing:tide'), '\nan edit the later operation takes\n')
  world.advance(1000)
  await service.tickNow()
  assert.equal(calls.filter(([kind]) => kind === 'apply').length, 1)
})

test('a contribution is a module in a directory: found without editing any dispatch file, and a built-in name cannot be taken', async (t) => {
  const world = makeWorld(t)
  const directory = path.join(world.dir, 'contributions')
  fs.mkdirSync(directory)
  fs.writeFileSync(path.join(directory, '10-echo.mjs'), "export default { id: 'echo', register({ operations }) { operations.register({ name: 'echo', summary: 'says what it was given', run: async ({ args }) => ({ exit: 0, document: { said: args } }) }) } }\n")
  fs.writeFileSync(path.join(directory, 'README.txt'), 'not a module')
  assert.deepEqual((await loadContributions({ directory })).map((item) => item.id), ['echo'])
  const result = await world.run(['echo', 'hello', '--json'], { contributions: null, contributionsDirectory: directory })
  assert.deepEqual([result.exit, result.json.said], [EXIT.ok, ['hello']])
  assert.deepEqual(await loadContributions({ directory: path.join(world.dir, 'nowhere') }), [])
  assert.deepEqual((await loadContributions()).map((item) => item.id), ['atelier.proposal-adapter', 'atelier.selection-ui', 'atelier.source-apply'], 'the shipped directory holds the proposal adapter, the selection and the source apply contribution, in name order, and nothing else')
  const run = fs.readFileSync(path.join(REPOSITORY_ROOT, 'src/cli/run.mjs'), 'utf8')
  assert.deepEqual([(run.match(/obsidian\.mjs/g) ?? []).length, run.includes("'echo'")], [1, false], 'the dispatch table names the command once and no sub-operation')

  for (const name of BUILT_IN_OPERATIONS.filter((item) => item !== 'apply')) {
    const taken = await world.run(['status', '--json'], { contributions: [{ id: 'greedy', register: ({ operations }) => operations.register({ name, summary: 'x', run: async () => ({ exit: 0, document: {} }) }) }] })
    assert.deepEqual([taken.exit, taken.json.error.code], [EXIT.refused, 'operation-name-reserved'], name)
  }
  for (const broken of [{ id: 'no-register' }, null, { id: '', register() {} }]) assert.equal((await world.run(['status', '--json'], { contributions: [broken] })).json.error.code, 'invalid-extension')
  const twice = { id: 'same', register() {} }
  assert.equal((await world.run(['status', '--json'], { contributions: [twice, twice] })).json.error.code, 'extension-already-registered')
  const answersWrongly = await world.run(['odd', '--json'], { contributions: [{ id: 'odd', register: ({ operations }) => operations.register({ name: 'odd', summary: 'answers nothing', run: async () => undefined }) }] })
  assert.equal(answersWrongly.json.error.code, 'invalid-extension')
})

test('the shipped contributions reach the command: apply, conflicts, apply-policy, selection and proposals answer on an enabled workspace with the discipline of the built-ins', async (t) => {
  const world = makeWorld(t)
  world.configureMachine({ maintenanceMode: 'manual', audienceAllow: ['team'] })
  // `contributions: null` makes the command load the shipped directory itself, exactly as the real entry does.
  const shipped = { contributions: null }
  const status = await world.run(['status', '--json'], shipped)
  assert.equal(status.exit, EXIT.ok)
  assert.deepEqual(status.json.operations.map((item) => item.name), ['apply', 'apply-policy', 'conflicts', 'proposals', 'selection'], 'status lists every contributed operation')
  assert.deepEqual(status.json.apply, { available: true, state: 'available', operationId: 'atelier.source-apply/v1' })

  const list = await world.run(['apply', 'list', '--json'], shipped)
  assert.deepEqual([list.exit, list.json.ok, list.json.operation, list.json.edits], [EXIT.ok, true, 'apply', []], 'apply list answers an empty list on a workspace with no pending edit')
  const conflicts = await world.run(['conflicts', '--json'], shipped)
  assert.deepEqual([conflicts.exit, conflicts.json.operation, conflicts.json.objects], [EXIT.ok, 'conflicts', []])
  const policy = await world.run(['apply-policy', 'show', '--json'], shipped)
  assert.deepEqual([policy.exit, policy.json.operation, policy.json.installed], [EXIT.ok, 'apply-policy', false])
  const selections = await world.run(['selection', 'list', '--json'], shipped)
  assert.deepEqual([selections.exit, selections.json.operation, selections.json.selections], [EXIT.ok, 'selection', []])
  const resolved = await world.run(['selection', 'resolve', FULL_SCOPE.scopeId, '--json'], shipped)
  assert.deepEqual([resolved.exit, resolved.json.scopeId, resolved.json.persisted, resolved.json.selection.mode], [EXIT.ok, FULL_SCOPE.scopeId, false, 'full'])
  const proposals = await world.run(['proposals', 'list', '--json'], shipped)
  assert.deepEqual([proposals.exit, proposals.json.operation, Array.isArray(proposals.json.operations)], [EXIT.ok, 'proposals', true])

  // Refusals keep the shape and the exit code of the built-ins: one document, a typed code, exit 2.
  const unknown = await world.run(['nonesuch', '--json'], shipped)
  assert.deepEqual([unknown.exit, unknown.json.ok, unknown.json.error.code, unknown.json.error.message], [EXIT.refused, false, 'usage', 'unknown operation: nonesuch'])
  const badVerb = await world.run(['apply', 'frobnicate', '--json'], shipped)
  assert.deepEqual([badVerb.exit, badVerb.json.error.code], [EXIT.refused, 'usage'])
  const noEdit = await world.run(['apply', 'run', '--actor', 'someone', '--json'], shipped)
  assert.deepEqual([noEdit.exit, noEdit.json.error.code], [EXIT.refused, 'usage'])
  const actorElsewhere = await world.run(['conflicts', '--actor', 'someone', '--json'], shipped)
  assert.deepEqual([actorElsewhere.exit, actorElsewhere.json.error.code], [EXIT.refused, 'usage'], 'a contributed operation that has no use for --actor refuses it as the built-ins do')
  const human = await world.run(['apply', 'list'], shipped)
  assert.deepEqual([human.exit, human.stdout, human.stderr], [EXIT.ok, 'no pending edit', ''])

  // Beside the shipped set, a contribution that wants a built-in name is refused before anything runs.
  const production = await loadContributions()
  for (const name of ['scope', 'policy', 'mode']) {
    const taken = await world.run(['apply', 'list', '--json'], { contributions: [...production, { id: 'greedy', register: ({ operations }) => operations.register({ name, summary: 'x', run: async () => ({ exit: 0, document: {} }) }) }] })
    assert.deepEqual([taken.exit, taken.json.error.code, taken.json.error.detail], [EXIT.refused, 'operation-name-reserved', { name }], name)
  }
  // And the usage text names every contributed operation the shipped set registers.
  const help = await world.run(['--help', '--json'], shipped)
  for (const name of status.json.operations.map((item) => item.name)) assert.ok(new RegExp(`^  ${name} `, 'm').test(help.json.usage), `usage names ${name}`)
})

// ---------------------------------------------------------------------------
// 9. sync only reports
// ---------------------------------------------------------------------------

test('the maintenance notice is null unless the integration is enabled, and reading it writes nothing', async (t) => {
  const absent = makeWorld(t, { ext: null, machine: null })
  const disabled = makeWorld(t, { ext: { ...settingsOf(), enabled: false } })
  const enabled = makeWorld(t)
  assert.equal(maintenanceNoticeFor(absent.loadProject(), { dataRoot: absent.dataRoot, env: absent.env }), null)
  assert.equal(maintenanceNoticeFor(disabled.loadProject(), { dataRoot: disabled.dataRoot, env: disabled.env }), null)
  await enabled.service({ engineOptions: { seams: { publishView: async () => REFUSED_PUBLICATION } } })
  const before = listing(enabled.dir)
  const notice = maintenanceNoticeFor(enabled.loadProject(), { dataRoot: enabled.dataRoot, env: enabled.env })
  assert.deepEqual([notice.state, notice.service, notice.hint, notice.scopes.map((scope) => [scope.scopeId, scope.lastKnownState])], ['enabled', 'recorded-not-verified', 'atelier obsidian status', [['scope-whole', 'stale']]])
  assert.deepEqual(listing(enabled.dir), before)
  enabled.writeExt({ ...settingsOf(), surprise: true })
  assert.deepEqual(maintenanceNoticeFor(enabled.loadProject(), { dataRoot: enabled.dataRoot, env: enabled.env }), { state: 'refused', code: 'invalid-ext-settings', hint: 'atelier obsidian status' })
})

function syncFixture(t, ext) {
  const git = resolveGitExecutable()
  // The native form: on Windows a temporary directory can be an 8.3 short path, and enrollment records the long one.
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-opening-sync-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  runGit(git, root, ['init', '--initial-branch=main'])
  for (const [key, value] of [['user.name', 'Atelier Test'], ['user.email', 'atelier@example.invalid'], ['commit.gpgsign', 'false']]) runGit(git, root, ['config', key, value])
  fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n')
  writeJson(path.join(root, 'atelier.project.json'), { ...projectDocument(ext), repos: [{ name: 'workspace', path: '.', readBoundary: 'team' }] })
  writeJson(path.join(root, 'repo-access.v1.json'), { schema: 'mnstry.atelier-repo-access@v1', defaultReadBoundary: 'team', repos: { workspace: { readBoundary: 'team' } } })
  runGit(git, root, ['add', '.'])
  runGit(git, root, ['commit', '-m', 'initial'])
  // No project path is passed: enrollment finds atelier.project.json under the root it resolved itself, so the recorded
  // path and the root it is later checked against are the same spelling on every platform.
  const enrolled = enrollRepository({ repoPath: root, gitExecutable: git })
  assert.equal(path.basename(enrolled.enrollment.projectConfig ?? ''), 'atelier.project.json', 'the enrollment names the project configuration')
  const { MNSTRY_ATELIER_PROJECT_CONFIG: _config, MNSTRY_ATELIER_LOCAL_CONFIG: _overlay, ...env } = process.env
  const status = () => {
    const result = childProcess.spawnSync(process.execPath, [path.join(REPOSITORY_ROOT, 'src/commands/sync.mjs'), 'status', '--repo', root], { encoding: 'utf8', env, windowsHide: true })
    let document
    try { document = JSON.parse(result.stdout) } catch {
      throw new Error(`sync status printed no JSON document: exit ${result.status}, signal ${result.signal}, error ${result.error?.code ?? result.error?.message ?? 'none'}, stdout ${JSON.stringify(String(result.stdout).slice(0, 500))}, stderr ${JSON.stringify(String(result.stderr).slice(0, 2000))}`)
    }
    return { code: result.status, document }
  }
  return { root, status }
}

test('sync status is exactly what it was when the Obsidian member is absent or disabled, and only gains a report when it is enabled', (t) => {
  const absent = syncFixture(t, undefined).status()
  const disabled = syncFixture(t, { ...settingsOf(), enabled: false }).status()
  const enabledFixture = syncFixture(t, settingsOf())
  const before = listing(enabledFixture.root)
  const enabled = enabledFixture.status()
  const keys = ['control', 'enrollment', 'ok', 'state', 'traceError', 'traceLength']
  assert.deepEqual([Object.keys(absent.document).sort(), Object.keys(disabled.document).sort()], [keys, keys])
  assert.deepEqual(Object.keys(enabled.document).sort(), [...keys, 'obsidianMaintenance'].sort())
  assert.deepEqual(enabled.document.obsidianMaintenance, { state: 'enabled', maintainedBy: 'the Obsidian maintenance service, not by sync', hint: 'atelier obsidian status', service: 'never-started', scopes: [] })
  assert.deepEqual([absent.code, disabled.code, enabled.code, absent.document.state.status, enabled.document.state.status], [absent.code, absent.code, absent.code, enabled.document.state.status, absent.document.state.status], 'the report changes neither the state nor the exit code')
  assert.deepEqual(listing(enabledFixture.root), before, 'and reporting started nothing and wrote nothing')
  assert.equal(obsidianMaintenanceNotice({ repoPath: path.join(TMP, 'not-enrolled-anywhere') }), null, 'a report never throws into sync')
})

// ---------------------------------------------------------------------------
// 10. Nothing left behind
// ---------------------------------------------------------------------------

test('no process this suite started is left behind, no banned program was asked for, and the production seams were never loaded', async () => {
  await waitFor(() => SPAWNED.every((entry) => entry.gone || entry.child.exitCode !== null || entry.child.signalCode !== null), { timeoutMs: 15000, label: 'every child to exit' }).catch(() => {})
  const left = SPAWNED.filter((entry) => !entry.gone && entry.child.exitCode === null && entry.child.signalCode === null)
  for (const entry of left) { try { entry.child.kill('SIGKILL') } catch { /* gone */ } }
  assert.deepEqual(left.map((entry) => `pid ${entry.pid} started by "${entry.test}"`), [])
  assert.deepEqual(guardErrors, [], 'the spawn guard never fired outside its own test')
  assert.equal(globalThis[Symbol.for('mnstry.atelier.obsidian.production-seams-loaded')], undefined)
})
