import childProcess from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveProjectConfig } from '../../../src/project/config.mjs'
import { createRecoveryStore } from '../../../src/projection/obsidian/recovery/index.mjs'
import { loadContributions } from '../../../src/runtime/obsidian/contributions.mjs'
import { readServiceStatusDocument, requestServiceTick, serviceStatus, startService, stopService } from '../../../src/runtime/obsidian/lifecycle.mjs'
import { defaultMachineSettings, ensureWorkspaceIdentity, protectedRoots, readMachineSettings, workspaceStateRoot, writeMachineSettings } from '../../../src/runtime/obsidian/machine-settings.mjs'
import { isProcessAlive } from '../../../src/runtime/obsidian/private-lock.mjs'
import { probeHealth } from '../../../src/runtime/obsidian/service-client.mjs'
import { SERVICE_ENTRY_PATH } from '../../../src/runtime/obsidian/service-main.mjs'
import { resolveServiceWorkspace, runMaintenanceService } from '../../../src/runtime/obsidian/service.mjs'
import { SERVICE_SETTINGS_SCHEMA, readServiceRecord, readServiceSettings, servicePaths, writeServiceSettings } from '../../../src/runtime/obsidian/service-record.mjs'
import { createMaintenanceStateStore } from '../../../src/runtime/obsidian/state-store.mjs'
import { isoNow, sha256Digest, walkFiles } from './common.mjs'
import { waitUntil } from './measure.mjs'

// The seams AP-03 and AP-05 run through, each one replaceable by a fake in
// the test suite: the workspace and its private state, the owned maintenance
// service (start / status / tick / stop / kill, and a start from a launcher
// that exits), the `atelier obsidian` command run in this process, and the
// note editor of an isolated app instance. Nothing here starts an application
// or a service on import; every production seam is constructed by a caller
// that decided to.

export const PRODUCTION_ENTRY_ARGS = Object.freeze(['--adapter=obsidian-cli'])
export const LAUNCHER_PATH = fileURLToPath(new URL('./service-launcher.mjs', import.meta.url))
const IGNORED_SOURCE_DIRECTORIES = new Set(['.git', '.atelier-proposals', '.atelier-local', '.mnstry-local'])

// The project configuration of a synthetic workspace, read without any
// overlay this process may carry.
export function stripProjectEnv(env = process.env) {
  const { MNSTRY_ATELIER_PROJECT_CONFIG: _config, MNSTRY_ATELIER_LOCAL_CONFIG: _overlay, ...rest } = env
  return rest
}

export const loadProjectFrom = (projectFile, env) => resolveProjectConfig({ argv: [`--project=${projectFile}`], cwd: path.dirname(projectFile), env, writeLocalState: false })

// Resolves (and on first use creates) the identity and private state root of
// a synthetic workspace under an explicit data root, and the vault of each
// declared view exactly where the engine will publish it.
export function prepareWorkspace({ projectFile, dataRoot, env = stripProjectEnv(), randomBytes, audienceAllow = ['team'], now = isoNow }) {
  const loadProject = () => loadProjectFrom(projectFile, env)
  const project = loadProject()
  const pointer = ensureWorkspaceIdentity({ project, dataRoot, ...(randomBytes ? { randomBytes } : {}) })
  const requested = workspaceStateRoot(dataRoot, pointer.workspaceId)
  fs.mkdirSync(requested, { recursive: true, mode: 0o700 })
  const workspaceRoot = fs.realpathSync(requested)
  const repositoryRoots = protectedRoots(project)
  // The audiences a view may show are a private machine setting; without one every view is empty.
  const identity = { workspaceRoot, workspaceId: pointer.workspaceId }
  const machine = readMachineSettings(identity) ?? defaultMachineSettings({ workspaceId: pointer.workspaceId, updatedAt: now() })
  if (JSON.stringify(machine.audienceAllow) !== JSON.stringify(audienceAllow)) writeMachineSettings({ ...identity, repositoryRoots, settings: { ...machine, audienceAllow: [...audienceAllow], updatedAt: now() } })
  const stores = new Map()
  const storeFor = (scopeId) => {
    if (!stores.has(scopeId)) stores.set(scopeId, createRecoveryStore({ workspaceRoot, workspaceId: pointer.workspaceId, scopeId, repositoryRoots }))
    return stores.get(scopeId)
  }
  return {
    projectFile, dataRoot, env, loadProject, project, workspaceId: pointer.workspaceId, workspaceRoot, repositoryRoots,
    workspaceDir: project.workspaceRoot, repositories: (project.repos ?? []).filter((repo) => !repo.external).map((repo) => ({ repoId: repo.name, path: repo.path })),
    storeFor,
    vaultRootFor: (scopeId) => storeFor(scopeId).vaultRoot,
    manifestFor: (scopeId) => storeFor(scopeId).readCurrentManifest() ?? null,
    stateStore: () => createMaintenanceStateStore({ workspaceRoot, workspaceId: pointer.workspaceId }),
  }
}

// Source apply and the proposal router ask git about each enrolled repository
// (whether a source or the copy-only store is ignored), so a synthetic
// workspace whose repositories are bare `.git` directories gives them no
// answer. Each repository becomes a real, empty git repository that ignores
// the proposal store; nothing is committed and no remote exists.
export function initialiseRepositories(repositories, { run = childProcess.execFileSync } = {}) {
  const initialised = []
  for (const repo of repositories) {
    const directory = typeof repo === 'string' ? repo : repo.path
    fs.rmSync(path.join(directory, '.git'), { recursive: true, force: true })
    run('git', ['init', '-q'], { cwd: directory, stdio: 'ignore' })
    fs.writeFileSync(path.join(directory, '.gitignore'), '.atelier-proposals/\n')
    initialised.push(directory)
  }
  return initialised
}

// Points an isolated instance's private profile at the vault the engine
// maintains, so the app opens exactly that directory. The layout's own
// synthetic vault directory is left where it is and never registered.
export function bindLayoutToVault(layout, vaultRoot) {
  fs.mkdirSync(vaultRoot, { recursive: true })
  const profileFile = path.join(layout.profile, 'obsidian.json')
  const profile = JSON.parse(fs.readFileSync(profileFile, 'utf8'))
  profile.vaults = { atelierg00synthetic: { path: vaultRoot, ts: Date.now(), open: true } }
  fs.writeFileSync(profileFile, JSON.stringify(profile))
  return { ...layout, vault: vaultRoot }
}

// ---------------------------------------------------------------------------
// Sources, vault notes and private state, as digests
// ---------------------------------------------------------------------------

export function sourceDigests({ workspaceDir, repositories }) {
  const digests = {}
  for (const repo of repositories) {
    for (const file of walkFiles(repo.path)) {
      const relative = path.relative(repo.path, file).split(path.sep).join('/')
      if (relative.split('/').some((segment) => IGNORED_SOURCE_DIRECTORIES.has(segment))) continue
      digests[`${repo.repoId}/${relative}`] = sha256Digest(fs.readFileSync(file))
    }
  }
  return digests
}

export function digestDifferences(before, after) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  return keys.filter((key) => before[key] !== after[key]).map((key) => ({ key, before: before[key] ?? null, after: after[key] ?? null }))
}

export const fileDigest = (file) => (fs.existsSync(file) ? sha256Digest(fs.readFileSync(file)) : null)

export function noteFile(vaultRoot, notePath) { return path.join(vaultRoot, ...notePath.split('/')) }

// The pending edits and the journals of every view, as a comparable snapshot.
export function privateStateSnapshot(world, scopeIds) {
  const pending = world.stateStore().readPendingEdits()
  const journals = {}
  for (const scopeId of scopeIds) {
    const root = world.storeFor(scopeId).journalsRoot
    journals[scopeId] = fs.existsSync(root) ? fs.readdirSync(root).sort().map((name) => ({ journalId: name, closed: fs.existsSync(path.join(root, name, 'closed.json')) })) : []
  }
  const objects = pending.edits.map((edit) => edit.objectRef).filter(Boolean).map((ref) => ({ ref, present: fs.existsSync(path.join(world.workspaceRoot, ...ref.split('/'))) }))
  return {
    pendingEdits: pending.edits.map(({ editId, scopeId, path: notePath, state, observedDigest, objectRef, attempts, closedAt, lastResult }) => ({ editId, scopeId, path: notePath, state, observedDigest, objectRef, attempts, closedAt, lastCode: lastResult?.code ?? null })),
    pendingDigest: sha256Digest(Buffer.from(JSON.stringify(pending))),
    journals, retainedObjects: objects,
  }
}

export const openEdits = (snapshot) => snapshot.pendingEdits.filter((edit) => edit.closedAt === null)

// ---------------------------------------------------------------------------
// The owned service, through the runtime's own lifecycle API
// ---------------------------------------------------------------------------

export function createServiceRuntime({
  loadProject, dataRoot, env, consent, intervalMs, probeTimeoutMs, entryPath = SERVICE_ENTRY_PATH, entryArgs = [...PRODUCTION_ENTRY_ARGS],
  spawn = childProcess.spawn, execPath = process.execPath, launcherPath = LAUNCHER_PATH, launchThroughShell = true, kill = process.kill.bind(process), alive = isProcessAlive,
}) {
  const lifecycle = { loadProject, dataRoot, env, ...(probeTimeoutMs === undefined ? {} : { probeTimeoutMs }) }
  const workspace = () => resolveServiceWorkspace({ project: loadProject(), dataRoot, env })
  return {
    kind: 'lifecycle-api',
    entryPath,
    async start() { const { child: _child, ...result } = await startService({ ...lifecycle, detached: true, entryPath, entryArgs, consent, ...(intervalMs === undefined ? {} : { intervalMs }) }); return result },
    status: () => serviceStatus(lifecycle),
    statusDocument: () => readServiceStatusDocument(lifecycle),
    tick: (options = {}) => requestServiceTick({ ...lifecycle, ...options }),
    stop: (options = {}) => stopService({ ...lifecycle, ...options }),
    kill(pid, signal = 'SIGKILL') { kill(pid, signal); return { pid, signal } },
    alive,
    record() { const found = workspace(); return found?.workspaceRoot ? readServiceRecord({ workspaceRoot: found.workspaceRoot, workspaceId: found.workspaceId }) : null },
    async health() {
      const record = this.record()
      if (!record) return { record: null, answer: null }
      const answer = await probeHealth({ host: record.host, port: record.port, ...(probeTimeoutMs === undefined ? {} : { timeoutMs: probeTimeoutMs }) })
      return { record: { runtimeId: record.runtimeId, pid: record.pid, host: record.host, port: record.port, executableDigest: record.executable.digest }, answer }
    },
    logPath() { const found = workspace(); return found?.workspaceRoot ? servicePaths(found.workspaceRoot).log : null },
    // Starts the service from a child that exits as soon as `start` returned, the way a terminal that is then closed
    // would. The child is detached and its exit is awaited; what it printed is the record it saw.
    async startFromExitingLauncher() {
      const project = loadProject()
      const args = [launcherPath, `--project=${project.configPath}`, `--data-root=${dataRoot}`, `--entry=${entryPath}`, ...(entryArgs.length ? [`--entry-args=${entryArgs.join(',')}`] : []), `--consent-actor=${consent.actor}`, ...(intervalMs === undefined ? [] : [`--interval-ms=${intervalMs}`])]
      const child = launchThroughShell
        ? spawn('/bin/sh', ['-c', 'exec "$0" "$@"', execPath, ...args], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn(execPath, args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
      const exit = await new Promise((resolve) => { child.once('close', (code, signal) => resolve({ code, signal })) })
      let reported = null
      try { reported = JSON.parse(stdout) } catch { reported = null }
      return { launcher: { pid: child.pid, throughShell: launchThroughShell, exit, alive: alive(child.pid), stdout, stderr: stderr.slice(0, 4000) }, reported }
    },
  }
}

// The maintenance service of one workspace inside this process: the same
// service body (`runMaintenanceService`: loopback listener, owner-only record,
// tick loop) with an adapter factory the caller chooses. AP-05 needs it: one
// service maintains two vaults that two isolated apps hold, and each app is
// reached through its own private HOME, which one detached process with one
// environment cannot do. Ownership, status and ticks go through the same
// lifecycle API as for a detached service; a stop is the service's own
// shutdown, awaited.
export function createInProcessServiceRuntime({ loadProject, dataRoot, env, consent, adapterFactory, extensions, intervalMs = 60 * 60 * 1000, probeTimeoutMs, startTimeoutMs = 120 * 1000, entryPath = SERVICE_ENTRY_PATH, clock = () => new Date(), log = () => {} }) {
  const lifecycle = { loadProject, dataRoot, env, ...(probeTimeoutMs === undefined ? {} : { probeTimeoutMs }) }
  const workspace = () => resolveServiceWorkspace({ project: loadProject(), dataRoot, env, create: true })
  let service = null
  const logLines = []
  const record = () => { const found = workspace(); return found?.workspaceRoot ? readServiceRecord({ workspaceRoot: found.workspaceRoot, workspaceId: found.workspaceId }) : null }
  return {
    kind: 'in-process-service',
    entryPath,
    logLines,
    async start() {
      if (service !== null) { const status = await serviceStatus(lifecycle); return { ...status, started: false, alreadyRunning: true } }
      const { workspaceRoot, workspaceId } = workspace()
      const current = readServiceSettings({ workspaceRoot, workspaceId })
      if (current === null) {
        const port = await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => { const { port: chosen } = server.address(); server.close(() => resolve(chosen)) }) })
        writeServiceSettings({ workspaceRoot, workspaceId, settings: { schema: SERVICE_SETTINGS_SCHEMA, workspaceId, host: '127.0.0.1', port, consent: { grantedAt: clock().toISOString(), actor: consent.actor, coverage: consent.coverage ?? 'service' }, updatedAt: clock().toISOString() } })
      }
      service = await runMaintenanceService({ loadProject, dataRoot, env, adapterFactory, entryPath, intervalMs, clock, log: (entry) => { logLines.push(entry); log(entry) }, engineOptions: { ...(extensions ? { extensions } : {}), quietPeriodMs: 0 } })
      // The first tick runs in this process the moment the loop starts and holds the event loop through its synchronous
      // parts, so health may not answer at once. A detached service in that state reads `busy` (its command line
      // names the entry); this process's does not, so the status is asked again until the tick has let go.
      let status = null
      const settled = await waitUntil(async () => { status = await serviceStatus(lifecycle); return status.state === 'healthy' }, { timeoutMs: startTimeoutMs, intervalMs: 200 })
      return { ...status, started: true, alreadyRunning: false, firstTickWaitMs: settled.elapsedMs }
    },
    status: () => serviceStatus(lifecycle),
    statusDocument: () => readServiceStatusDocument(lifecycle),
    tick: (options = {}) => requestServiceTick({ ...lifecycle, ...options }),
    async stop() {
      if (service === null) return { state: 'stopped', stopped: false, refused: false, reason: 'not-running-in-this-process' }
      const { identity } = service
      await service.shutdown('stop-requested')
      await service.done
      service = null
      return { state: 'stopped', stopped: true, refused: false, reason: 'stopped-the-in-process-runtime', runtimeId: identity.runtimeId, pid: identity.pid }
    },
    record,
    alive: isProcessAlive,
  }
}

// One adapter factory for several isolated apps: the vault a publication is
// for selects the app that holds it, reached through that app's private
// HOME. Each app is qualified on its own (version floor, running process).
export function createPerVaultAdapterFactory(apps, { createQualifiedAdapterFactory, createProductionAppProbe, createObsidianCliAdapter }) {
  const factories = apps.map(({ vaultRoot, env }) => ({ vaultRoot: fs.realpathSync(vaultRoot), factory: createQualifiedAdapterFactory({ appProbe: createProductionAppProbe({ env }), createAdapter: () => createObsidianCliAdapter({ env }) }) }))
  const factory = (input) => {
    const vaultRoot = input?.store?.vaultRoot
    const match = factories.find((item) => item.vaultRoot === vaultRoot)
    if (!match) throw new Error(`no isolated app holds the vault ${String(vaultRoot)}`)
    return match.factory(input)
  }
  factory.lastQualification = () => factories.map((item) => item.factory.lastQualification())
  return factory
}

// ---------------------------------------------------------------------------
// `atelier obsidian <operation>` in this process
// ---------------------------------------------------------------------------

const UNREACHABLE = new Proxy({}, { get: (_target, name) => { throw new Error(`the app seam ${String(name)} was reached by a command that must not open the app`) } })

// Every operation the procedures call is read-only towards the app: mode,
// policy, apply, conflicts, proposals, status. `open` and `service start` are
// never called here (the runtime seam owns the service), so the app seams
// throw if anything reaches them.
export async function createCommandRunner({ projectFile, dataRoot, env = stripProjectEnv(), cwd = path.dirname(projectFile), clock = () => new Date(), contributions = null, entryPath = SERVICE_ENTRY_PATH }) {
  const { runObsidianCommandForOracleTests } = await import('../../../src/commands/obsidian.mjs')
  // The shipped directory now holds the selection contribution, so the production loader is the whole set.
  const loaded = contributions ?? await loadContributions()
  const calls = []
  const run = async (...argv) => {
    const out = []
    const err = []
    const startedAt = isoNow()
    const exit = await runObsidianCommandForOracleTests({
      argv: [...argv, '--json', `--project=${projectFile}`, `--data-root=${dataRoot}`], seams: { appProbe: UNREACHABLE, launcher: UNREACHABLE, service: { entryPath, entryArgs: [...PRODUCTION_ENTRY_ARGS] } },
      env, cwd, clock, contributions: loaded, stdout: (text) => out.push(text), stderr: (text) => err.push(text),
    }, {})
    const stdout = out.join('\n')
    let json = null
    try { json = JSON.parse(stdout) } catch { json = null }
    const record = { argv, startedAt, endedAt: isoNow(), exit, json, stderr: err.join('\n') }
    calls.push(record)
    return record
  }
  run.calls = calls
  return run
}

// ---------------------------------------------------------------------------
// Editing a note in an isolated app instance: real input through CDP
// ---------------------------------------------------------------------------

// `typeAt` opens the note in the main window, places the caret after `anchor`,
// types `text` as keyboard input, waits until the app saved the note to disk
// (the bytes on disk carry the text), then closes the note so the publisher
// coordinates with a vault nothing holds open. Every step and its wall clock
// are answered; nothing here reads the note back into the caller.
export function createAppEditor(instance, { vaultRoot, saveTimeoutMs = 30000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  return {
    kind: 'cdp-input',
    vaultRoot,
    async typeAt({ notePath, anchor, text }) {
      const trace = { notePath, anchor, text, openedAt: isoNow() }
      await instance.stimulus('open', notePath)
      await sleep(500)
      await instance.stimulus('focusAt', notePath, { anchor })
      trace.typedAt = isoNow()
      trace.typeReply = String(await instance.typeText(text, notePath)).trim().slice(0, 200)
      const file = noteFile(vaultRoot, notePath)
      const saved = await waitUntil(() => fs.readFileSync(file, 'utf8').includes(text), { timeoutMs: saveTimeoutMs, intervalMs: 250 })
      trace.savedToDisk = { met: saved.met, elapsedMs: saved.elapsedMs, attempts: saved.attempts, error: saved.error }
      trace.savedAt = isoNow()
      await instance.stimulus('closeAll', notePath)
      trace.closedAt = isoNow()
      trace.noteDigest = fileDigest(file)
      return trace
    },
  }
}

export { isProcessAlive }
