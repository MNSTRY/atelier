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
import { promisify } from 'node:util'

// ---------------------------------------------------------------------------
// 0. The spawn guard. Installed before anything else is imported, for every
// way this process can start another one. Nothing in this file may start the
// installed app, its command-line tool, an operating-system opener or a
// service manager; an attempt throws here instead of running.
//
// A child that could reach a running Obsidian itself (the production service
// entry with its command-line adapter, or anything that loads the production
// app seams) must be given an environment that leads to no app of the
// developer's: the command-line tool finds the app through a socket under
// HOME on macOS and under XDG_RUNTIME_DIR on Linux, and the app keeps its
// settings under HOME (under XDG_CONFIG_HOME on Linux, when that is set). On
// Windows the app listens on a named pipe of the user account, which no
// environment changes, so no such child is started there at all. With the
// developer's own environment such a child would ask the developer's own
// Obsidian, which is out of bounds for a test.
// ---------------------------------------------------------------------------

const BANNED_PROGRAMS = ['obsidian-cli', 'obsidian', 'open', 'xdg-open', 'launchctl', 'systemctl']
const WRAPPERS = ['sh', 'bash', 'zsh', 'dash', 'env', 'cmd', 'powershell', 'pwsh', 'nohup', 'sudo']
const REACHES_THE_APP = /--adapter=obsidian-cli|app-production-seams/
const REAL_HOMES = [os.homedir(), process.env.HOME].filter((home) => typeof home === 'string' && home !== '').map((home) => path.resolve(home))
const REAL_RUNTIME_DIRS = [process.env.XDG_RUNTIME_DIR, typeof process.getuid === 'function' ? `/run/user/${process.getuid()}` : ''].filter((dir) => typeof dir === 'string' && dir !== '').map((dir) => path.resolve(dir))
const REAL_CONFIG_HOMES = [process.env.XDG_CONFIG_HOME, ...REAL_HOMES.map((home) => path.join(home, '.config'))].filter((dir) => typeof dir === 'string' && dir !== '').map((dir) => path.resolve(dir))
const oneOf = (value, list) => typeof value === 'string' && value !== '' && list.includes(path.resolve(value))
// Why a child with this env could reach the developer's own Obsidian on this platform; null when it cannot.
function reachesOwnApp(env, platform = process.platform) {
  if (platform !== 'darwin' && platform !== 'linux') return 'a child that can reach a running Obsidian is never started on this platform: the app listens on a pipe of the user account, which no environment isolates'
  if (typeof env?.HOME !== 'string' || env.HOME === '' || oneOf(env.HOME, REAL_HOMES)) return 'a child that can reach a running Obsidian needs a private HOME, never the developer\'s own'
  if (platform === 'linux') {
    const runtime = env.XDG_RUNTIME_DIR
    if (typeof runtime !== 'string' || runtime === '' || oneOf(runtime, REAL_RUNTIME_DIRS) || /^\/run\/user\//.test(runtime)) return 'a child that can reach a running Obsidian needs a private XDG_RUNTIME_DIR on Linux, never the session\'s own'
    if (oneOf(env.XDG_CONFIG_HOME, REAL_CONFIG_HOMES)) return 'a child that can reach a running Obsidian needs no XDG_CONFIG_HOME on Linux, or a private one'
  }
  return null
}
const programName = (command) => path.basename(String(command).replaceAll('\\', '/')).toLowerCase().replace(/\.(exe|app|cmd|bat)$/, '')
const guardErrors = []
function guardSpawn(command, args, options) {
  const words = [command, ...(Array.isArray(args) ? args : [])].map(String)
  // The program itself, always; its arguments too when the program only runs another one; an app link anywhere.
  const wrapper = WRAPPERS.includes(programName(command))
  const banned = words.find((word, index) => ((index === 0 || wrapper) && BANNED_PROGRAMS.includes(programName(word))) || /obsidian:\/\//i.test(word))
  if (banned !== undefined) {
    const error = new Error(`spawn guard: this test suite may never start "${programName(banned)}"`)
    guardErrors.push(error.message)
    throw error
  }
  // A child with no env of its own inherits this process's, and with it the developer's HOME.
  const refusal = words.some((word) => REACHES_THE_APP.test(word)) ? reachesOwnApp(options?.env ?? process.env) : null
  if (refusal !== null) {
    const error = new Error(`spawn guard: ${refusal}`)
    guardErrors.push(error.message)
    throw error
  }
}
for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
  const original = childProcess[method]
  // exec and execSync take one shell line, and their options come second.
  const check = (command, args, rest) => (method === 'exec' || method === 'execSync' ? guardSpawn('sh', String(command).split(/\s+/), args) : guardSpawn(command, args, Array.isArray(args) ? rest[0] : args))
  const guarded = function guarded(command, args, ...rest) { check(command, args, rest); return original.call(this, command, args, ...rest) }
  // exec and execFile have a promisified form of their own ({ stdout, stderr }); it is kept, and guarded the same way.
  const custom = original[promisify.custom]
  if (typeof custom === 'function') guarded[promisify.custom] = function guardedPromise(command, args, ...rest) { check(command, args, rest); return custom.call(this, command, args, ...rest) }
  childProcess[method] = guarded
}
syncBuiltinESMExports()

// The env of a child that may reach a running Obsidian: this process's, with a private HOME and XDG_RUNTIME_DIR in `dir`
// and no XDG_CONFIG_HOME. Only where the guard lets such a child start at all (`needsAppIsolation`).
function privateHomeEnv(dir, base = process.env) {
  const home = path.join(dir, 'private-home')
  const runtime = path.join(dir, 'private-runtime')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 })
  const { XDG_CONFIG_HOME: _config, ...rest } = base
  return { ...rest, HOME: home, XDG_RUNTIME_DIR: runtime }
}
const APP_ISOLATION_HERE = reachesOwnApp({ HOME: path.join(os.tmpdir(), 'private-home'), XDG_RUNTIME_DIR: path.join(os.tmpdir(), 'private-runtime') }) === null
const needsAppIsolation = APP_ISOLATION_HERE ? {} : { skip: 'the app listens on a pipe of the user account on this platform, which no environment isolates: no child that could reach it is started' }

const { resolveProjectConfig, writeJson } = await import('../src/project/config.mjs')
const { isContractIdentifier, validateObsidianContract } = await import('../src/projection/obsidian/contracts.mjs')
const { MAX_OBSIDIAN_SETTINGS_BYTES, NEUTRAL_DIRECTORY, OBSIDIAN_SETTINGS_FILE, createEditorAdapter, createObsidianCliCall, enclosingVaults, findVaultEntry, obsidianSandboxedBuild, obsidianUserDataDir, publicationRoute, readObsidianSettings, resolveExchange, vaultRoute } = await import('../src/projection/obsidian/publication/index.mjs')
const { BUILT_IN_OPERATIONS, COMMAND_SCHEMA, EXIT, default: defaultCommand, runObsidianCommand, runObsidianCommandForOracleTests } = await import('../src/commands/obsidian.mjs')
const { MINIMUM_APP_VERSION, compareAppVersions, createQualifiedAdapterFactory, meetsMinimumAppVersion, parseAppVersion, qualifyApp, readEvalAnswer, readVersionAnswer } = await import('../src/runtime/obsidian/app-capability.mjs')
const { appStateSignature, registerVaultInObsidianSettings } = await import('../src/runtime/obsidian/app-registration.mjs')
const { loadContributions } = await import('../src/runtime/obsidian/contributions.mjs')
const { ENGINE_PRIMITIVES, createMaintenanceEngineForOracleTests } = await import('../src/runtime/obsidian/engine.mjs')
const { ObsidianMaintenanceRefusal } = await import('../src/runtime/obsidian/errors.mjs')
const { createObsidianRegistry } = await import('../src/runtime/obsidian/extension-points.mjs')
const { LIFECYCLE_PRIMITIVES, releaseStanding, requestServiceTick, serviceStatus, startService, stopService } = await import('../src/runtime/obsidian/lifecycle.mjs')
const { ensureWorkspaceIdentity, protectedRoots, readMachineSettings, workspaceStateRoot, writeMachineSettings } = await import('../src/runtime/obsidian/machine-settings.mjs')
const { OPENING_OUTCOMES, OPENING_PRIMITIVES, REASON_NEXT, nextStep } = await import('../src/runtime/obsidian/opening.mjs')
const { createAbandonmentProof, machineDigest } = await import('../src/runtime/obsidian/private-lock.mjs')
const { commandLineNamesRecord, readProcessCommandLine } = await import('../src/runtime/obsidian/process-identity.mjs')
const { HEALTH_SCHEMA, probeHealth, requestLoopback } = await import('../src/runtime/obsidian/service-client.mjs')
const { readServiceRecord, readServiceSettings, releaseIdentity, serviceNameFor, writeServiceRecord, writeServiceSettings } = await import('../src/runtime/obsidian/service-record.mjs')
const { createRecoveryStore } = await import('../src/projection/obsidian/recovery/store.mjs')
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
// Obsidian runs and does not answer for this vault: the publisher writes nothing. There is no other publisher.
const UNCOORDINATED_PUBLICATION = { state: 'refused', refusal: { code: 'editor-uncoordinated', message: 'stub' }, notes: [], retainedEdits: [], lateWriters: [] }

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
const unreachable = (name) => () => { throw new Error(`the ${name} was reached`) }
const UNREACHABLE_SEAMS = Object.freeze({
  appProbe: { inspect: unreachable('app probe'), inspectSync: unreachable('app probe'), vaultState: unreachable('app probe') },
  launcher: { open: unreachable('launcher') },
  registry: { listThroughApp: unreachable('app registry'), registerThroughApp: unreachable('app registry'), readSettings: unreachable('app registry'), registerInSettings: unreachable('app registry') },
  service: { entryPath: TEST_SERVICE_ENTRY, spawn() { throw new Error('a service was started') } },
})

// An installed app, as the injected probe describes it, its vault list, and a launcher that records what it was asked.
// The app answers for a vault only once it was asked to open it AND its list knows it, as the real app does.
function fakeApp(overrides = {}) {
  // `noVaultAnswers`: how many inspections of the running app answer that no vault is open before it has one;
  // `noVaultUntilLaunch`: the running app has no vault open until it is asked to open one.
  // `vaults`: the app's own list, id -> { path, open }. `settingsRefusal`: a typed refusal its settings file gives.
  // `registerResult`: what the app answers when asked to add a vault; `registerForgets`: it answers true and lists nothing;
  // `loadingAnswers`: how many list calls after an addition reach the new window while it is still loading.
  // `listNoVault` / `registerNoVault`: the app answered its version, then its last vault window closed, so the list or
  // the addition answers "Vault not found.". `registerUnanswered`: the addition gets no answer (a call that timed
  // out); 'added' when the app added the vault all the same, 'not-added' when it did not.
  const state = {
    installed: true, cli: true, running: false, version: '1.13.7 (installer 1.12.7)', answered: true, indexReady: true, launchResult: { launched: true, reason: 'fake' }, comesUp: true, noVaultAnswers: 0,
    noVaultUntilLaunch: false, vaults: {}, settingsRefusal: null, registerResult: true, registerForgets: false, listAnswers: true, loadingAnswers: 0, listNoVault: false, registerNoVault: false,
    registerUnanswered: null, ...overrides,
  }
  const launches = []
  const registrations = []
  // Each listed vault a call about a vault reached, by id: the app opens a vault that takes a call and is closed.
  const reached = []
  const listed = (vaultRoot) => Object.values(state.vaults).some((entry) => entry.path === vaultRoot)
  const noVaultNow = () => state.running && (state.noVaultAnswers > 0 || (state.noVaultUntilLaunch && launches.length === 0))
  const add = (vaultRoot, via) => { registrations.push({ via, vaultRoot }); if (!state.registerForgets) state.vaults[`fake${String(registrations.length).padStart(12, '0')}`] = { path: vaultRoot, ts: 1, open: true } }
  // The listed vault that takes a call, as Obsidian 1.13.7 routes one: a first argument `vault=<value>` names the first
  // listed vault whose id is the value, or whose folder's name is the value in any letter case; otherwise the first
  // listed vault whose folder is the working directory or contains it takes the call, in list order.
  const takerOf = (route) => {
    const ids = Object.keys(state.vaults)
    if (route.how === 'id') return ids.find((id) => id === route.id || path.basename(state.vaults[id].path).toUpperCase() === route.id.toUpperCase()) ?? null
    if (route.how !== 'folder') return null
    return ids.find((id) => { const folder = path.resolve(state.vaults[id].path); return route.cwd === folder || route.cwd.startsWith(folder + path.sep) }) ?? null
  }
  return {
    state, launches, registrations, reached, noVaultNow,
    appProbe: {
      inspect: async () => {
        if (noVaultNow()) { if (state.noVaultAnswers > 0) state.noVaultAnswers -= 1; return { installed: state.installed, cli: state.cli, running: true, version: null, noVaultOpen: true } }
        return { installed: state.installed, cli: state.cli, running: state.running, version: state.running ? state.version : null }
      },
      // A call with no route runs in the vault's folder, as every call about a vault did before routes.
      vaultState: async ({ vaultRoot, route = { how: 'folder', cwd: vaultRoot } }) => {
        const taker = takerOf(route)
        if (taker !== null) reached.push(taker)
        const holds = taker !== null && state.vaults[taker].path === vaultRoot && state.answered && launches.includes(vaultRoot)
        return { answered: holds, indexReady: holds && state.indexReady }
      },
    },
    launcher: { open: async ({ vaultRoot }) => { launches.push(vaultRoot); if (state.launchResult.launched && state.comesUp) state.running = true; return state.launchResult } },
    registry: {
      listThroughApp: async () => {
        if (!state.running) throw new Error('the app does not run')
        if (noVaultNow() || state.listNoVault) return { answered: false, reason: 'no-vault-open' }
        if (registrations.length > 0 && state.loadingAnswers > 0) { state.loadingAnswers -= 1; return { answered: false, reason: 'no-value' } }
        return state.listAnswers ? { answered: true, vaults: structuredClone(state.vaults) } : { answered: false, reason: 'cli-failed' }
      },
      registerThroughApp: async ({ vaultRoot }) => {
        if (!state.running || noVaultNow()) throw new Error('the app cannot be asked')
        if (state.registerNoVault) return { answered: false, reason: 'no-vault-open' }
        if (state.registerUnanswered !== null) { if (state.registerUnanswered === 'added') add(vaultRoot, 'app'); return { answered: false, reason: 'cli-failed' } }
        if (state.registerResult === true) add(vaultRoot, 'app')
        return { answered: true, result: state.registerResult }
      },
      readSettings: () => (state.settingsRefusal ?? { ok: true, vaults: structuredClone(state.vaults) }),
      registerInSettings: ({ vaultRoot }) => {
        if (state.running) return { ok: false, code: 'app-may-be-running', message: 'fake' }
        if (state.settingsRefusal) return state.settingsRefusal
        const known = Object.keys(state.vaults).find((id) => state.vaults[id].path === vaultRoot)
        if (known !== undefined) return { ok: true, registered: 'already', entry: { id: known, path: vaultRoot, open: true }, confirmed: true, vaults: structuredClone(state.vaults) }
        if (Object.values(state.vaults).some((entry) => vaultRoot.startsWith(entry.path + path.sep))) return { ok: false, code: 'vault-inside-another-vault', message: 'fake' }
        add(vaultRoot, 'settings')
        // `settingsUnconfirmed`: an app started right after the write, and may have read the list before it; or, when it
        // names a reason, that reason (`registration-not-read-back`: the written file could not be read back).
        const unconfirmed = state.settingsUnconfirmed === true ? 'app-started-during-registration' : state.settingsUnconfirmed || null
        return { ok: true, registered: 'written', entry: { id: 'fake', path: vaultRoot, open: true }, confirmed: unconfirmed === null, vaults: structuredClone(state.vaults), ...(unconfirmed === null ? {} : { reason: unconfirmed }) }
      },
    },
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

// The decision of the guard, for each platform: macOS needs a private HOME; Linux a private HOME and XDG_RUNTIME_DIR,
// and no XDG_CONFIG_HOME of the developer's; on Windows, and anywhere else, no such child is started.
function assertGuardDecisions(decide, isolated) {
  const own = os.homedir()
  const decisions = [
    ['darwin', { HOME: own }, /private HOME/], ['darwin', { HOME: '' }, /private HOME/], ['darwin', {}, /private HOME/],
    ['darwin', { HOME: isolated.HOME }, null], ['darwin', { HOME: isolated.HOME, XDG_RUNTIME_DIR: '/run/user/501' }, null],
    ['linux', { HOME: isolated.HOME }, /private XDG_RUNTIME_DIR/], ['linux', { HOME: isolated.HOME, XDG_RUNTIME_DIR: '/run/user/1000' }, /private XDG_RUNTIME_DIR/],
    ['linux', { HOME: isolated.HOME, XDG_RUNTIME_DIR: '' }, /private XDG_RUNTIME_DIR/], ['linux', { HOME: own, XDG_RUNTIME_DIR: isolated.XDG_RUNTIME_DIR }, /private HOME/],
    ['linux', { HOME: isolated.HOME, XDG_RUNTIME_DIR: isolated.XDG_RUNTIME_DIR, XDG_CONFIG_HOME: path.join(own, '.config') }, /XDG_CONFIG_HOME/],
    ['linux', { HOME: isolated.HOME, XDG_RUNTIME_DIR: isolated.XDG_RUNTIME_DIR }, null],
    ['win32', isolated, /never started on this platform/], ['freebsd', isolated, /never started on this platform/],
  ]
  for (const [platform, env, expected] of decisions) {
    const reason = decide(env, platform)
    if (expected === null) assert.equal(reason, null, `${platform} ${JSON.stringify(env)}`)
    else assert.match(String(reason), expected, `${platform} ${JSON.stringify(env)}`)
  }
}

test('the spawn guard refuses a child that can reach a running Obsidian unless nothing in its environment leads to the developer\'s own app, whichever way it is started', async (t) => {
  const dir = fs.mkdtempSync(path.join(TMP, 'atelier-home-guard-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  // The decision, for each platform: macOS needs a private HOME; Linux a private HOME and XDG_RUNTIME_DIR, and no
  // XDG_CONFIG_HOME of the developer's; on Windows, and anywhere else, no such child is started.
  const isolated = privateHomeEnv(dir)
  const own = os.homedir()
  assertGuardDecisions(reachesOwnApp, isolated)
  // Here, through every way a child is started.
  const before = guardErrors.length
  const production = ['-e', '0', '--', '--adapter=obsidian-cli']
  const seams = ['--input-type=module', '-e', `// ${path.join(REPOSITORY_ROOT, 'src/runtime/obsidian/app-production-seams.mjs')}`]
  for (const args of [production, seams]) {
    // No env of its own is this process's env, with the developer's HOME; so is an env that copies it.
    assert.throws(() => childProcess.spawnSync(process.execPath, args), /spawn guard/)
    assert.throws(() => childProcess.spawnSync(process.execPath, args, { env: { ...process.env } }), /spawn guard/)
    assert.throws(() => childProcess.execFileSync(process.execPath, args, { env: { ...process.env, HOME: '' } }), /spawn guard/)
    assert.throws(() => childProcess.spawn(process.execPath, args, { env: { ...process.env, HOME: own } }), /spawn guard/)
    // A private HOME alone is enough on macOS only; the whole private environment wherever a child can be isolated.
    const homeOnly = { ...isolated, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '' }
    if (process.platform === 'darwin') assert.equal(childProcess.spawnSync(process.execPath, args, { env: homeOnly }).status, 0)
    else assert.throws(() => childProcess.spawnSync(process.execPath, args, { env: homeOnly }), /spawn guard/)
    if (APP_ISOLATION_HERE) assert.equal(childProcess.spawnSync(process.execPath, args, { env: isolated }).status, 0)
    else assert.throws(() => childProcess.spawnSync(process.execPath, args, { env: isolated }), /never started on this platform/)
  }
  assert.throws(() => childProcess.execSync(`${JSON.stringify(process.execPath)} -e 0 -- --adapter=obsidian-cli`), /spawn guard/)
  // The promisified execFile keeps its own form ({ stdout, stderr }), and is guarded too.
  assert.throws(() => promisify(childProcess.execFile)(process.execPath, production), /spawn guard/)
  assert.equal(guardErrors.length, before + 10 + (process.platform === 'darwin' ? 0 : 2) + (APP_ISOLATION_HERE ? 0 : 2))
  guardErrors.length = before
  if (APP_ISOLATION_HERE) {
    const answered = await promisify(childProcess.execFile)(process.execPath, ['-e', 'process.stdout.write("ok")', '--', '--adapter=obsidian-cli'], { env: isolated })
    assert.deepEqual(answered, { stdout: 'ok', stderr: '' })
  }
  // Mutation control: a child that names neither passes whatever environment it has.
  assert.doesNotThrow(() => childProcess.spawnSync(process.execPath, ['-e', '0']))
})

test('mutation control: the guard of #76, which looked at HOME alone, lets a Linux child reach the session\'s app and starts one on Windows', (t) => {
  const dir = fs.mkdtempSync(path.join(TMP, 'atelier-home-guard-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const homeAlone = (env) => (typeof env?.HOME !== 'string' || env.HOME === '' || oneOf(env.HOME, REAL_HOMES) ? 'a child that can reach a running Obsidian needs a private HOME, never the developer\'s own' : null)
  assert.throws(() => assertGuardDecisions(homeAlone, privateHomeEnv(dir)), assert.AssertionError)
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
  assert.match(entry, /createQualifiedAdapterFactory\(\{ appProbe: createProductionAppProbe\(\), createAdapter: \(\{ qualification \}\) => createObsidianCliAdapter\(\{ qualification \}\) \}\)/, 'the service constructs the CLI adapter only through the version-qualified factory, and hands it the qualification')
  assert.equal((entry.match(/createObsidianCliAdapter\(/g) ?? []).length, 1)
  assert.equal(globalThis[Symbol.for('mnstry.atelier.obsidian.production-seams-loaded')], undefined)
})

test('control: the trace of the production seams exists; a child that only evaluates the module (it constructs and calls nothing) shows it', needsAppIsolation, (t) => {
  const dir = fs.mkdtempSync(path.join(TMP, 'atelier-seams-trace-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const seen = childProcess.spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(path.join(REPOSITORY_ROOT, 'src/runtime/obsidian/app-production-seams.mjs')).href)}); process.stdout.write(String(globalThis[Symbol.for('mnstry.atelier.obsidian.production-seams-loaded')]))`], { encoding: 'utf8', windowsHide: true, env: privateHomeEnv(dir) })
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

// What the command-line tool prints with no vault open, on either stream, with either exit status; and a real version for contrast.
const NO_VAULT = 'Vault not found.'
const VERSION_ANSWERS = [
  [{ stdout: `${NO_VAULT}\n`, exited: true }, 'no-vault-open'],
  [{ stdout: `${NO_VAULT}\n`, exited: false }, 'no-vault-open'],
  [{ stderr: `${NO_VAULT}\n`, exited: false }, 'no-vault-open'],
  [{ stdout: '', stderr: `${NO_VAULT}\n`, exited: true }, 'no-vault-open'],
  [{ stdout: '1.13.7 (installer 1.12.7)\n', exited: true }, 'meets-minimum-version'],
  [{ stdout: '1.13.7 (installer 1.12.7)\n', exited: false }, 'version-unknown'],
  [{ stdout: '', exited: true }, 'version-unknown'],
  [{ stdout: 'Error: the app did not answer\n', exited: true }, 'version-unreadable'],
  // A vault window that is still loading, right after the app started: the app is not up yet, so there is no version to read.
  [{ stdout: 'Error: Command "version" not found. It may require a plugin to be enabled.\n', exited: true }, 'version-unknown'],
]

// `read` turns one CLI answer into { version, noVaultOpen }; the oracle qualifies a running app with it.
function assertNoVaultIsNotAVersion(read) {
  for (const [answer, reason] of VERSION_ANSWERS) {
    const { version, noVaultOpen } = read(answer)
    const qualification = qualifyApp({ installed: true, cli: true, running: true, version, ...(noVaultOpen ? { noVaultOpen } : {}) }, { requireVersion: false })
    assert.equal(qualification.reason, reason, JSON.stringify(answer))
    if (reason === 'no-vault-open') assert.deepEqual([qualification.outcome, qualification.version], ['app-version-unsupported', null], 'the answer is not recorded as a version')
  }
}

test('an app that runs with no vault open answers "Vault not found." to every command; that is the reason no-vault-open, never a version, and it does not qualify', () => {
  assertNoVaultIsNotAVersion(readVersionAnswer)
  assert.deepEqual(readVersionAnswer({ stdout: NO_VAULT }), { version: null, noVaultOpen: true })
  // The answer proves the app runs, so the path for an app that is positively not running does not apply.
  for (const running of [true, false, null]) {
    for (const requireVersion of [true, false]) assert.equal(qualifyApp({ installed: true, cli: true, running, version: null, noVaultOpen: true }, { requireVersion }).reason, 'no-vault-open', `running ${running}, requireVersion ${requireVersion}`)
  }
  const built = []
  const factory = createQualifiedAdapterFactory({ appProbe: { inspectSync: () => ({ installed: true, cli: true, running: true, version: null, noVaultOpen: true }) }, createAdapter: (input) => { built.push(input); return { kind: 'fake' } } })
  assert.throws(() => factory({}), (error) => error instanceof ObsidianMaintenanceRefusal && error.code === 'app-version-unsupported' && error.detail.reason === 'no-vault-open')
  assert.deepEqual([built.length, factory.lastQualification().reason], [0, 'no-vault-open'], 'nothing is published through it')
})

test('mutation control: reading the answer of 0.2.0-alpha.9, which took any successful output as the version, records "Vault not found." as a version', () => {
  const tookAnyOutput = ({ stdout = '', exited = true }) => ({ version: exited && typeof stdout === 'string' && stdout.trim() !== '' ? stdout.trim() : null, noVaultOpen: false })
  assert.equal(tookAnyOutput({ stdout: `${NO_VAULT}\n` }).version, NO_VAULT)
  assert.throws(() => assertNoVaultIsNotAVersion(tookAnyOutput), assert.AssertionError)
})

test('the production app probe reads both output streams of the version call, with either exit status', needsAppIsolation, (t) => {
  // The command-line tool is played by this Node binary running a script named `version` in the child's directory, so the
  // same arrangement runs on every platform. `win32` keeps the process table out of it: the version is always asked.
  const dir = fs.mkdtempSync(path.join(TMP, 'atelier-version-answer-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'version'), "process[process.env.ANSWER_STREAM].write(process.env.ANSWER_TEXT + '\\n'); process.exitCode = Number(process.env.ANSWER_STATUS)\n")
  const cases = [['stdout', NO_VAULT, 0], ['stdout', NO_VAULT, 1], ['stderr', NO_VAULT, 1], ['stderr', NO_VAULT, 0], ['stdout', '1.13.7 (installer 1.12.7)', 0], ['stdout', '1.13.7 (installer 1.12.7)', 1]]
  const seams = pathToFileURL(path.join(REPOSITORY_ROOT, 'src/runtime/obsidian/app-production-seams.mjs')).href
  const script = `const { createProductionAppProbe } = await import(${JSON.stringify(seams)})
const seen = []
for (const [stream, text, status] of ${JSON.stringify(cases)}) {
  const probe = createProductionAppProbe({ platform: 'win32', cliPath: process.execPath, workingDirectory: process.cwd(), env: { ...process.env, ANSWER_STREAM: stream, ANSWER_TEXT: text, ANSWER_STATUS: String(status) } })
  seen.push({ sync: probe.inspectSync(), async: await probe.inspect() })
}
process.stdout.write(JSON.stringify(seen))`
  const child = childProcess.spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 60000, env: privateHomeEnv(dir) })
  assert.equal(child.status, 0, child.stderr)
  const seen = JSON.parse(child.stdout)
  const expected = ['no-vault-open', 'no-vault-open', 'no-vault-open', 'no-vault-open', 'meets-minimum-version', 'version-unknown']
  for (const [index, { sync, async }] of seen.entries()) {
    assert.deepEqual(sync, async, `${cases[index].join(' ')}: both probes read the same answer`)
    assert.deepEqual([sync.installed, sync.cli, qualifyApp(sync, { requireVersion: false }).reason], [true, true, expected[index]], cases[index].join(' '))
    if (expected[index] === 'no-vault-open') assert.deepEqual([sync.version, sync.noVaultOpen], [null, true])
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
  assert.deepEqual(status.json.service.app, { outcome: 'app-version-unsupported', reason: 'below-minimum-version', version: '1.12.4', floor: MINIMUM_APP_VERSION, next: OPENING_OUTCOMES['app-version-unsupported'].next })
  assert.deepEqual([status.json.scopes[0].outcome, status.json.scopes[0].reason, fs.readdirSync(world.vault()).filter((name) => name.endsWith('.md')).length], ['not-prepared', 'app-version-unsupported', 0], 'nothing was published through it')
})

test('a service that found the app running with no vault open says so, and status tells the person to open a vault or quit the app', async (t) => {
  const world = makeWorld(t)
  const adapterFactory = createQualifiedAdapterFactory({ appProbe: { inspectSync: () => ({ installed: true, cli: true, running: true, version: null, noVaultOpen: true }) }, createAdapter: absentAdapter })
  await world.service({ adapterFactory, appStatus: () => { const known = adapterFactory.lastQualification(); return known === null ? null : { outcome: known.outcome, reason: known.reason, version: known.version, floor: known.floor } } })
  const status = await world.run(['status', '--json'])
  assert.deepEqual(status.json.service.app, { outcome: 'app-version-unsupported', reason: 'no-vault-open', version: null, floor: MINIMUM_APP_VERSION, next: REASON_NEXT['no-vault-open'] })
  assert.match(REASON_NEXT['no-vault-open'], /open any vault in Obsidian, or quit Obsidian/)
  assert.equal(fs.readdirSync(world.vault()).filter((name) => name.endsWith('.md')).length, 0, 'nothing was published through it')
  const lines = (await world.run(['status'])).stdout.split('\n')
  assert.ok(lines.some((line) => line.includes('app app-version-unsupported (no-vault-open)')), lines.join('\n'))
  assert.ok(lines.includes(`Next for the app: ${REASON_NEXT['no-vault-open']}`), lines.join('\n'))
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

test('open with the app running and no vault open launches nothing and says to open a vault or quit the app; an app that opens its vault after the launch is waited for', needsExchange, async (t) => {
  const noVault = await openWithApp(t, undefined, { running: true, noVaultAnswers: Number.POSITIVE_INFINITY })
  assert.deepEqual([noVault.result.json.outcome, noVault.result.json.reason, noVault.result.json.next, noVault.app.launches.length, noVault.result.json.launched], ['app-version-unsupported', 'no-vault-open', REASON_NEXT['no-vault-open'], 0, false])
  assert.equal(noVault.result.json.app.version, null)
  // Started by the launch, the app answers with no vault open while it is still opening the one it was asked for.
  const opening = await openWithApp(t, undefined, { running: false, noVaultAnswers: 2 })
  assert.deepEqual([opening.result.json.outcome, opening.app.launches.length, opening.app.state.noVaultAnswers], ['current', 1, 0])
  const neverOpens = await openWithApp(t, undefined, { running: false, noVaultAnswers: Number.POSITIVE_INFINITY })
  assert.deepEqual([neverOpens.result.json.outcome, neverOpens.result.json.reason, neverOpens.result.json.next, neverOpens.result.json.launched], ['app-version-unsupported', 'no-vault-open', REASON_NEXT['no-vault-open'], true])
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

test('a first publication stopped as editor-uncoordinated: open adds the vault through the running app, opens it and asks again; a publisher that still refuses is reported with the step left', async (t) => {
  const world = makeWorld(t)
  const attempts = []
  await world.service({ engineOptions: { seams: { publishView: async (input) => { attempts.push(input.recoveryStore.vaultRoot); return UNCOORDINATED_PUBLICATION } } } })
  assert.equal(attempts.length, 1, 'the service tried once when it started')
  const scopeBefore = (await world.run(['status', '--json'])).json.scopes[0]
  assert.deepEqual([scopeBefore.outcome, scopeBefore.reason, scopeBefore.next], ['publisher-conflict', 'editor-uncoordinated', REASON_NEXT['editor-uncoordinated']])
  assert.match(REASON_NEXT['editor-uncoordinated'], /`atelier obsidian open` adds this view's vault to Obsidian and publishes through it/)
  const app = fakeApp({ running: true })
  const opened = await world.run(openArgs(), { seams: { ...UNREACHABLE_SEAMS, ...app }, open: { appWaitMs: 150, appPollMs: 25 } })
  // Asked on the tick open requested, and again once the app held the vault: no change was needed for either.
  assert.equal(attempts.length, 3, 'open re-attempts the refused view on its own tick, and again after the app holds the vault')
  assert.deepEqual(app.registrations, [{ via: 'app', vaultRoot: world.vault() }], 'the vault was added through the running app, once')
  assert.deepEqual(app.launches, [world.vault()])
  assert.deepEqual([opened.json.outcome, opened.json.reason, opened.json.launched, opened.json.registration?.how, opened.json.readBack.readable], ['publisher-conflict', 'editor-uncoordinated', true, 'added-through-app', false])
  assert.equal(opened.json.next, nextStep('publisher-conflict', 'editor-uncoordinated', { afterOpen: true }))
  assert.match(opened.json.next, /quit Obsidian .*then open again/)
  // A second open finds the vault in the app's list and adds nothing.
  const again = await world.run(openArgs(), { seams: { ...UNREACHABLE_SEAMS, ...app }, open: { appWaitMs: 150, appPollMs: 25 } })
  assert.deepEqual([again.json.outcome, again.json.registration?.how, app.registrations.length], ['publisher-conflict', 'listed', 1])
})

test('the same refusal after a view was published: open adds and opens the vault in the running app, and the view asked for again is current', needsExchange, async (t) => {
  const world = makeWorld(t)
  const { publishView } = await import('../src/projection/obsidian/publication/publisher.mjs')
  const app = fakeApp({ running: true })
  // The publisher coordinates only with an app that holds the vault: until then it stops as uncoordinated.
  let appRuns = false
  const holds = () => appRuns && app.launches.length > 0 && app.registrations.length > 0
  await world.service({ engineOptions: { seams: { publishView: (input) => (!appRuns || holds() ? publishView(input) : Promise.resolve(UNCOORDINATED_PUBLICATION)) } } })
  appRuns = true
  fs.appendFileSync(world.source('west-wing/logs/tide.md'), '\nLow water at six.\n')
  world.advance(1000)
  const opened = await world.run(openArgs(), { seams: { ...UNREACHABLE_SEAMS, ...app }, open: { appWaitMs: 150, appPollMs: 25 } })
  assert.deepEqual([opened.json.outcome, opened.json.ok, opened.exit, opened.json.launched, opened.json.registration?.how], ['current', true, EXIT.ok, true, 'added-through-app'])
  assert.ok(fs.readFileSync(world.noteFile('west-wing:tide'), 'utf8').includes('Low water at six.'), 'the change was published once the app held the vault')
  assert.deepEqual(app.launches, [world.vault()])
})

// ---------------------------------------------------------------------------
// 4b. The first open is automatic in every state of the app
// ---------------------------------------------------------------------------

// A service whose publisher coordinates only with an app that holds the vault, as the real one does: until the app
// was asked to open this vault and its list knows it, a publication with the app running stops as uncoordinated.
// A generation that is already the committed one is settled before any app is asked, as the real publisher does.
async function serviceBehindApp(world, app, options = {}) {
  const { publishView } = await import('../src/projection/obsidian/publication/publisher.mjs')
  const attempts = []
  const holds = (vaultRoot) => !app.state.running || (app.launches.includes(vaultRoot) && Object.values(app.state.vaults).some((entry) => entry.path === vaultRoot))
  const publish = (input) => {
    const unchanged = input.recoveryStore.readCurrent()?.generationId === input.preparedView.manifest.generationId
    const held = unchanged || holds(input.recoveryStore.vaultRoot)
    attempts.push(held ? 'published' : 'refused')
    return held ? publishView(input) : Promise.resolve(UNCOORDINATED_PUBLICATION)
  }
  const service = await world.service({ ...options, engineOptions: { ...options.engineOptions, seams: { publishView: publish } } })
  return { service, attempts }
}
const FAST_APP = { appWaitMs: 400, appPollMs: 20 }

test('app running with another vault: open adds the vault through the app, opens it, and the first publication runs once the app holds it; current, with no step by hand', needsExchange, async (t) => {
  const world = makeWorld(t)
  const app = fakeApp({ running: true, loadingAnswers: 3, vaults: { aaaaaaaaaaaaaaaa: { path: path.join(world.dir, 'somebody-else'), ts: 1, open: true } } })
  const { attempts } = await serviceBehindApp(world, app)
  assert.deepEqual(attempts, ['refused'], 'with the app running and not holding the vault, the first publication stops')
  const opened = await world.run(openArgs(), { seams: { ...UNREACHABLE_SEAMS, ...app }, open: FAST_APP })
  assert.deepEqual([opened.json.outcome, opened.json.ok, opened.exit, opened.json.launched, opened.json.registration?.how], ['current', true, EXIT.ok, true, 'added-through-app'], JSON.stringify(opened.json))
  assert.deepEqual(app.registrations, [{ via: 'app', vaultRoot: world.vault() }])
  assert.equal(app.state.loadingAnswers, 0, 'the list was asked again while the new window was loading')
  assert.deepEqual(attempts, ['refused', 'refused', 'published'], 'refused again on the tick open asked for, then published on the tick after the app held the vault')
  assert.deepEqual([opened.json.readBack.intact, opened.json.readBack.generationId, opened.json.freshness.verified], [true, world.manifest().generationId, true])
  assert.equal(Object.keys(app.state.vaults).length, 2, 'the other vault stays in the app\'s list')
})

test('app not running: the view is published on the path with no app, the vault is added to the app\'s settings, the app is started on it; current', needsExchange, async (t) => {
  const world = makeWorld(t)
  const app = fakeApp({ running: false })
  const { attempts } = await serviceBehindApp(world, app)
  assert.deepEqual(attempts, ['published'])
  const opened = await world.run(openArgs(), { seams: { ...UNREACHABLE_SEAMS, ...app }, open: FAST_APP })
  assert.deepEqual([opened.json.outcome, opened.json.launched, opened.json.registration?.how], ['current', true, 'added-to-settings'], JSON.stringify(opened.json))
  assert.deepEqual([app.registrations, app.launches], [[{ via: 'settings', vaultRoot: world.vault() }], [world.vault()]])
  // Opened again, with the app now running and holding it: nothing is added a second time.
  const again = await world.run(openArgs(), { seams: { ...UNREACHABLE_SEAMS, ...app }, open: FAST_APP })
  assert.deepEqual([again.json.outcome, again.json.registration?.how, app.registrations.length], ['current', 'listed', 1])
})

test('several views of one workspace each get their own vault in the app: one added while the app is quit, the next through the running app, each found again by its own path', needsExchange, async (t) => {
  const world = makeWorld(t, { ext: settingsOf([FULL_SCOPE, EAST_SCOPE]) })
  const app = fakeApp({ running: false })
  await serviceBehindApp(world, app)
  const [wholeVault, eastVault] = [world.vault(FULL_SCOPE.scopeId), world.vault(EAST_SCOPE.scopeId)]
  assert.notEqual(wholeVault, eastVault)
  const openScope = (scopeId) => world.run(openArgs(['--scope', scopeId]), { seams: { ...UNREACHABLE_SEAMS, ...app }, open: FAST_APP })
  const whole = await openScope(FULL_SCOPE.scopeId)
  const east = await openScope(EAST_SCOPE.scopeId)
  assert.deepEqual([whole.json.outcome, whole.json.registration?.how, east.json.outcome, east.json.registration?.how], ['current', 'added-to-settings', 'current', 'added-through-app'], JSON.stringify([whole.json.reason, east.json.reason]))
  assert.deepEqual(app.registrations, [{ via: 'settings', vaultRoot: wholeVault }, { via: 'app', vaultRoot: eastVault }])
  assert.deepEqual(app.launches, [wholeVault, eastVault])
  assert.deepEqual(Object.values(app.state.vaults).map((entry) => entry.path).sort(), [wholeVault, eastVault].sort())
  for (const scopeId of [FULL_SCOPE.scopeId, EAST_SCOPE.scopeId]) {
    const again = await openScope(scopeId)
    assert.deepEqual([again.json.outcome, again.json.registration?.how], ['current', 'listed'], scopeId)
  }
  assert.equal(app.registrations.length, 2, 'nothing was added twice')
})

test('app running with no vault open: a vault its list knows is opened by path and published through the app; one it does not know is a typed answer, and nothing is written or launched', needsExchange, async (t) => {
  // Known: the app lists the vault from an earlier open. Its command line answers nothing until a vault is open.
  const world = makeWorld(t)
  const known = fakeApp({ running: true, noVaultUntilLaunch: true, vaults: { bbbbbbbbbbbbbbbb: { path: world.vault(), ts: 1 } } })
  const refusing = (input) => { if (known.noVaultNow()) throw new ObsidianMaintenanceRefusal('app-version-unsupported', 'stub', { reason: 'no-vault-open' }); return absentAdapter(input) }
  await world.service({ adapterFactory: refusing })
  assert.deepEqual([(await world.run(['status', '--json'])).json.scopes[0].reason], ['app-version-unsupported'], 'nothing was published while the app answered nothing')
  const opened = await world.run(openArgs(), { seams: { ...UNREACHABLE_SEAMS, ...known }, open: FAST_APP })
  assert.deepEqual([opened.json.outcome, opened.json.launched, opened.json.registration?.how, known.registrations, known.launches], ['current', true, 'listed', [], [world.vault()]], JSON.stringify(opened.json))

  // Unknown: the app's settings belong to the running app and are not written; there is nothing to open by path.
  const other = makeWorld(t)
  const unknown = fakeApp({ running: true, noVaultAnswers: Number.POSITIVE_INFINITY })
  await other.service()
  const refused = await other.run(openArgs(), { seams: { ...UNREACHABLE_SEAMS, ...unknown }, open: FAST_APP })
  assert.deepEqual([refused.json.outcome, refused.json.reason, refused.json.next, refused.json.launched, unknown.registrations, unknown.launches], ['app-version-unsupported', 'no-vault-open', REASON_NEXT['no-vault-open'], false, [], []])
})

test('open verifies what the app says: a vault it refuses, one its list does not show afterwards, a list it does not give, and settings it cannot take are typed, and nothing is launched', needsExchange, async (t) => {
  const cases = [
    [{ running: true, registerResult: 'folder not found' }, 'app-refused-registration'],
    [{ running: true, registerForgets: true }, 'registration-not-verified'],
    [{ running: true, listAnswers: false }, 'app-did-not-list-its-vaults'],
    [{ running: false, settingsRefusal: { ok: false, code: 'obsidian-settings-missing', message: 'fake' } }, 'obsidian-settings-missing'],
    [{ running: false, settingsRefusal: { ok: false, code: 'obsidian-settings-unsafe', message: 'fake' } }, 'obsidian-settings-unsafe'],
    // Written, but an app started just then and may have read its list before: a URL it may not resolve is never sent.
    [{ running: false, settingsUnconfirmed: true }, 'app-started-during-registration'],
    // Written, and not read back: the same, with its own reason.
    [{ running: false, settingsUnconfirmed: 'registration-not-read-back' }, 'registration-not-read-back'],
    // Too large to write, and a Flatpak or snap build, whose list is not this file.
    [{ running: false, settingsRefusal: { ok: false, code: 'obsidian-settings-too-large', message: 'fake' } }, 'obsidian-settings-too-large'],
    [{ running: false, settingsRefusal: { ok: false, code: 'obsidian-sandboxed', message: 'fake' } }, 'obsidian-sandboxed'],
    // An addition the app did not answer, and after which its list does not show the vault.
    [{ running: true, registerUnanswered: 'not-added' }, 'addition-not-answered'],
  ]
  for (const [state, reason] of cases) {
    const world = makeWorld(t)
    await world.service()
    const app = fakeApp(state)
    const result = await world.run(openArgs(), { seams: { ...UNREACHABLE_SEAMS, ...app }, open: FAST_APP })
    assert.equal(typeof REASON_NEXT[reason], 'string', `${reason} has a next step of its own`)
    assert.deepEqual([result.json.outcome, result.json.reason, result.json.next, result.json.launched, app.launches], ['launch-failed', reason, REASON_NEXT[reason], false, []], reason)
  }
})

test('an addition the app did not answer (a call that timed out, say) is looked up in its list: made all the same, the vault is opened', needsExchange, async (t) => {
  const world = makeWorld(t)
  const app = fakeApp({ running: true, registerUnanswered: 'added' })
  await serviceBehindApp(world, app)
  const opened = await world.run(openArgs(), { seams: { ...UNREACHABLE_SEAMS, ...app }, open: FAST_APP })
  assert.deepEqual([opened.json.outcome, opened.json.registration?.how, app.launches], ['current', 'added-through-app', [world.vault()]], JSON.stringify(opened.json).slice(0, 400))
})

test('an app whose last vault window closes between its version answer and the list or the addition is a typed answer, never an internal error; nothing is added or launched', async (t) => {
  for (const race of [{ listNoVault: true }, { registerNoVault: true }]) {
    const world = makeWorld(t)
    await world.service({ engineOptions: { seams: { publishView: async () => UNCOORDINATED_PUBLICATION } } })
    const app = fakeApp({ running: true, ...race })
    const result = await world.run(openArgs(), { seams: { ...UNREACHABLE_SEAMS, ...app }, open: FAST_APP })
    assert.deepEqual([result.exit, result.json?.outcome, result.json?.reason, result.json?.next, result.json?.launched, app.registrations, app.launches], [EXIT.notSuccess, 'app-version-unsupported', 'no-vault-open', REASON_NEXT['no-vault-open'], false, [], []], `${JSON.stringify(race)}: ${result.stdout.slice(0, 300)}`)
  }
})

test('a vault Obsidian lists at a folder above the view\'s vault never takes its calls: open reaches the view\'s vault by its id, never adds a vault inside another one, and refuses when the id names another vault first', needsExchange, async (t) => {
  // Listed first, as a vault at the home folder would be: a call run in the view's vault folder reaches it instead.
  const ABOVE = 'aaaaaaaaaaaaaaaa'
  const OURS = 'bbbbbbbbbbbbbbbb'
  const above = (world, extra = {}) => ({ [ABOVE]: { path: world.dir, ts: 1, ...extra } })

  // Listed already, below it: reached by its id, and the vault above it is never reached, so never opened.
  const listed = makeWorld(t)
  const app = fakeApp({ running: true, vaults: { ...above(listed), [OURS]: { path: listed.vault(), ts: 2 } } })
  await serviceBehindApp(listed, app)
  const opened = await listed.run(openArgs(), { seams: { ...UNREACHABLE_SEAMS, ...app }, open: FAST_APP })
  assert.deepEqual([opened.json.outcome, opened.json.registration?.how, app.launches], ['current', 'listed', [listed.vault()]], JSON.stringify(opened.json))
  assert.deepEqual([...new Set(app.reached)], [OURS], 'only the view\'s vault was reached')

  // Not listed yet: it is added neither through the running app nor to the settings of a quit one, and nothing is launched.
  for (const running of [true, false]) {
    const world = makeWorld(t)
    const nested = fakeApp({ running, vaults: above(world, { open: true }) })
    await serviceBehindApp(world, nested)
    const refused = await world.run(openArgs(), { seams: { ...UNREACHABLE_SEAMS, ...nested }, open: FAST_APP })
    assert.deepEqual([refused.json.outcome, refused.json.reason, refused.json.next, nested.registrations, nested.launches, nested.reached], ['launch-failed', 'vault-inside-another-vault', REASON_NEXT['vault-inside-another-vault'], [], [], []], `running: ${running}`)
  }

  // The id names another vault first: one listed before it whose folder has the id as its name, in another case.
  const clash = makeWorld(t)
  const clashing = fakeApp({ running: true, vaults: { ...above(clash), cccccccccccccccc: { path: path.join(clash.dir, OURS.toUpperCase()), ts: 2 }, [OURS]: { path: clash.vault(), ts: 3 } } })
  await serviceBehindApp(clash, clashing)
  const ambiguous = await clash.run(openArgs(), { seams: { ...UNREACHABLE_SEAMS, ...clashing }, open: FAST_APP })
  assert.deepEqual([ambiguous.json.outcome, ambiguous.json.reason, clashing.launches, clashing.reached], ['launch-failed', 'vault-inside-another-vault', [], []])
})

const DUPLICATED_PUBLICATION = { state: 'refused', refusal: { code: 'vault-open-in-several-windows', message: 'stub' }, notes: [], retainedEdits: [], lateWriters: [] }

test('a vault the app has open in several windows, one per entry of its list that names its folder, is not opened through one of them: open answers publisher-conflict, names the entries and launches nothing; with one window left, that window is the one reached', needsExchange, async (t) => {
  const OURS = 'cccccccccccccccc'
  const OTHER = 'dddddddddddddddd'
  // Another spelling of the view's folder: with a trailing separator.
  const twice = (world, otherOpen = true) => ({ [OURS]: { path: world.vault(), ts: 1, open: true }, [OTHER]: { path: `${world.vault()}${path.sep}`, ts: 2, open: otherOpen } })
  const named = (world) => [{ id: OURS, path: world.vault() }, { id: OTHER, path: `${world.vault()}${path.sep}` }]

  // The publication was refused as such (the publisher's own case is in obsidian-recovery): a publisher conflict.
  const refused = makeWorld(t)
  await refused.service({ engineOptions: { seams: { publishView: async () => DUPLICATED_PUBLICATION } } })
  const app = fakeApp({ running: true, vaults: twice(refused) })
  const answer = await refused.run(openArgs(), { seams: { ...UNREACHABLE_SEAMS, ...app }, open: FAST_APP })
  assert.deepEqual([answer.json.outcome, answer.json.reason, answer.json.next, answer.json.duplicates], ['publisher-conflict', 'vault-open-in-several-windows', REASON_NEXT['vault-open-in-several-windows'], named(refused)], JSON.stringify(answer.json))
  assert.deepEqual([app.launches, app.registrations, app.reached], [[], [], []], 'nothing is launched, added or asked')
  // The app keeps the last window it closed marked open, so two entries can be marked open with one window showing:
  // the step that always clears it is removing the extra entries; closing windows is not offered as the remedy.
  assert.match(answer.json.next, /remove the extra entries from Obsidian's vault list/)
  assert.doesNotMatch(answer.json.next, /close the extra windows/)
  const shown = await refused.run(['open', '--consent-actor', CONSENT.actor], { seams: { ...UNREACHABLE_SEAMS, ...app }, open: FAST_APP })
  assert.ok(`${shown.stdout}\n${shown.stderr}`.split('\n').includes(`open in Obsidian as: ${named(refused).map((entry) => entry.path).join(', ')}`), shown.stderr)

  // A current view whose vault the app holds in two windows: the same answer, before anything is launched.
  const current = makeWorld(t)
  const later = fakeApp({ running: false })
  await serviceBehindApp(current, later)
  Object.assign(later.state, { running: true, vaults: twice(current) })
  const held = await current.run(openArgs(), { seams: { ...UNREACHABLE_SEAMS, ...later }, open: FAST_APP })
  assert.deepEqual([held.json.outcome, held.json.reason, held.json.duplicates, later.launches, later.reached], ['publisher-conflict', 'vault-open-in-several-windows', named(current), [], []], JSON.stringify(held.json))

  // One window left, below a closed entry of the same folder: that window is launched and reached, never the closed entry.
  const one = makeWorld(t)
  const single = fakeApp({ running: true, vaults: { [OTHER]: { path: `${one.vault()}${path.sep}`, ts: 2 }, [OURS]: { path: one.vault(), ts: 1, open: true } } })
  await serviceBehindApp(one, single)
  const opened = await one.run(openArgs(), { seams: { ...UNREACHABLE_SEAMS, ...single }, open: FAST_APP })
  assert.deepEqual([opened.json.outcome, single.launches, [...new Set(single.reached)]], ['current', [one.vault()], [OURS]], JSON.stringify(opened.json))
})

test('a view the app kept, with no app answering and none known to run (an unknown process table), keeps its own outcome and advice; nothing is added or launched', async (t) => {
  const world = makeWorld(t)
  await world.service({ engineOptions: { seams: { publishView: async () => UNCOORDINATED_PUBLICATION } } })
  const app = fakeApp({ running: null })
  const result = await world.run(openArgs(), { seams: { ...UNREACHABLE_SEAMS, ...app }, open: FAST_APP })
  assert.deepEqual([result.json.outcome, result.json.reason, result.json.next, result.json.app.reason, app.registrations, app.launches], ['publisher-conflict', 'editor-uncoordinated', nextStep('publisher-conflict', 'editor-uncoordinated', { afterOpen: true }), 'version-unknown', [], []])
  // An app that runs and is below the floor is what the person has to fix, and says so.
  const below = makeWorld(t)
  await below.service({ engineOptions: { seams: { publishView: async () => UNCOORDINATED_PUBLICATION } } })
  const old = fakeApp({ running: true, version: '1.13.6' })
  const refused = await below.run(openArgs(), { seams: { ...UNREACHABLE_SEAMS, ...old }, open: FAST_APP })
  assert.deepEqual([refused.json.outcome, refused.json.reason, old.registrations, old.launches], ['app-version-unsupported', 'below-minimum-version', [], []])
})

test('mutation control: an open that does not ask again for a view the app kept from publication reports the conflict it could have cleared', needsExchange, async (t) => {
  const world = makeWorld(t)
  const app = fakeApp({ running: true })
  await serviceBehindApp(world, app)
  const result = await world.run(openArgs(), { seams: { ...UNREACHABLE_SEAMS, ...app }, open: FAST_APP, rules: { opening: { ...OPENING_PRIMITIVES, keptByApp: () => false } } })
  assert.deepEqual([result.json.outcome, result.json.reason, app.registrations.length], ['publisher-conflict', 'editor-uncoordinated', 0])
})

// ---------------------------------------------------------------------------
// 4c. A refused publication is tried again soon, not only at the full reconciliation
// ---------------------------------------------------------------------------

async function assertRefusedViewRetriedSoon(t, primitives = ENGINE_PRIMITIVES) {
  const world = makeWorld(t)
  let refusing = true
  let appState = 'running|other-vault'
  const attempts = []
  const { publishView } = await import('../src/projection/obsidian/publication/publisher.mjs')
  const engine = world.engine({
    primitives, fullReconciliationIntervalMs: 60 * 60 * 1000, publicationRetryMs: 30 * 1000, observeApp: () => appState,
    seams: { publishView: (input) => { attempts.push(world.clock().toISOString()); return refusing ? Promise.resolve(UNCOORDINATED_PUBLICATION) : publishView(input) } },
  })
  const tick = async () => (await engine.tick()).scopes[0]
  assert.equal((await tick()).state, 'publisher-conflict')
  assert.equal(attempts.length, 1)
  await tick()
  assert.equal(attempts.length, 1, 'nothing changed and nothing asked: not tried on every tick')
  engine.requestPreparation('scope-not-declared')
  await tick()
  assert.equal(attempts.length, 1, 'a request for a view this project does not declare changes nothing')
  engine.requestPreparation(FULL_SCOPE.scopeId)
  await tick()
  assert.equal(attempts.length, 2, 'a tick after a request for this view tries it again at once')
  await tick()
  assert.equal(attempts.length, 2, 'the request is used up')
  appState = 'absent'
  await tick()
  assert.equal(attempts.length, 3, 'the app quit: tried again at once')
  await tick()
  assert.equal(attempts.length, 3)
  // Three attempts in a row: the next is due 30 s x 2^2 after the last.
  world.advance(119 * 1000)
  await tick()
  assert.equal(attempts.length, 3)
  world.advance(1000)
  await tick()
  assert.equal(attempts.length, 4, 'due after 120 s')
  world.advance(239 * 1000)
  await tick()
  assert.equal(attempts.length, 4)
  world.advance(1000)
  refusing = false
  const settled = await tick()
  assert.deepEqual([attempts.length, settled.state], [5, 'current'], 'due after 240 s, and it settles')
  world.advance(3 * 60 * 1000)
  appState = 'running|this-vault'
  await tick()
  assert.equal(attempts.length, 5, 'a settled view is not tried again because the app changed')
}

test('a view refused as a publisher conflict is tried again on a requested tick, when the app changes, and after a delay that doubles; never on every tick', needsExchange, async (t) => {
  await assertRefusedViewRetriedSoon(t)
})

test('mutation control: an engine that tries a refused view again only at the full reconciliation fails the retry oracle', needsExchange, async (t) => {
  await assert.rejects(assertRefusedViewRetriedSoon(t, { ...ENGINE_PRIMITIVES, isRetryDue: () => false }), assert.AssertionError)
})

test('the retry delay doubles per attempt up to the full reconciliation interval, and an app whose state is unknown triggers nothing', () => {
  const due = (attempts, sinceMs, { then = 'a', now = 'a' } = {}) => ENGINE_PRIMITIVES.isRetryDue({ nowMs: 10_000_000, unsettled: { attempts, lastAttemptMs: 10_000_000 - sinceMs, appState: then }, appState: () => now, retryMs: 30_000, maxMs: 300_000 })
  // attempts in a row -> the delay after the last one: 30 s doubling, never longer than the full reconciliation interval.
  for (const [attempts, delayMs] of [[1, 30_000], [2, 60_000], [3, 120_000], [4, 240_000], [5, 300_000], [6, 300_000], [40, 300_000]]) {
    assert.deepEqual([due(attempts, delayMs - 1), due(attempts, delayMs)], [false, true], `${attempts} attempt(s): due after ${delayMs} ms`)
  }
  assert.equal(due(1, 0, { then: 'a', now: 'b' }), true, 'an app that changed is tried at once')
  assert.equal(due(1, 0, { then: 'a', now: null }), false, 'an app that cannot be observed changes nothing')
  assert.equal(ENGINE_PRIMITIVES.isRetryDue({ nowMs: 1, unsettled: undefined, appState: () => 'b', retryMs: 1, maxMs: 1 }), false, 'a view this engine never tried waits for the full reconciliation')
})

test('a tick requested for a view over the service listener prepares it once more; a plain tick, and a tick of the service\'s own, do not', async (t) => {
  const world = makeWorld(t)
  const attempts = []
  const service = await world.service({ engineOptions: { seams: { publishView: async () => { attempts.push(1); return UNCOORDINATED_PUBLICATION } } } })
  assert.equal(attempts.length, 1)
  await service.tickNow()
  assert.equal(attempts.length, 1, 'a tick of the service\'s own has nothing new to try')
  const lifecycle = { loadProject: world.loadProject, dataRoot: world.dataRoot, env: world.env, probeTimeoutMs: FAST_PROBE }
  const plain = await requestServiceTick(lifecycle)
  assert.deepEqual([plain.requested, plain.tick.state, attempts.length], [true, 'ticked', 1], 'a tick that names no view prepares none')
  const asked = await requestServiceTick({ ...lifecycle, scopeId: FULL_SCOPE.scopeId })
  assert.deepEqual([asked.requested, asked.tick.scopes[0].state, attempts.length], [true, 'publisher-conflict', 2], 'the tick asked for this view tried it again')
  // The body names the runtime and, for a tick, at most one view by its identity; anything else is refused.
  const record = readServiceRecord(world.workspace())
  const post = (operation, payload) => requestLoopback({ host: record.host, port: record.port, method: 'POST', path: operation, bearer: record.ext.bearer, payload, timeoutMs: 10000 })
  for (const [operation, payload, statusCode, error] of [
    ['/tick', { runtimeId: record.runtimeId, scopeId: '../escape' }, 400, 'request-invalid'], ['/tick', { runtimeId: record.runtimeId, scopeId: 7 }, 400, 'request-invalid'],
    ['/tick', { runtimeId: record.runtimeId, scopeId: 'a'.repeat(129) }, 400, 'request-invalid'],
    ['/tick', { runtimeId: record.runtimeId, scopeId: FULL_SCOPE.scopeId, extra: true }, 400, 'request-member-unknown'],
    ['/stop', { runtimeId: record.runtimeId, scopeId: FULL_SCOPE.scopeId }, 400, 'request-member-unknown'],
    ['/tick', { runtimeId: 'rt-another', scopeId: FULL_SCOPE.scopeId }, 409, 'request-names-another-runtime'],
  ]) {
    const answer = await post(operation, payload)
    assert.deepEqual([answer.kind, answer.statusCode, answer.body?.error], ['response', statusCode, error], `${operation} ${JSON.stringify(payload).slice(0, 80)}`)
  }
  assert.equal(attempts.length, 2, 'a refused request prepares nothing')
})

test('a preparation is taken for a view the project declares, at most 64 at a time before the first tick; any other request is not taken', async (t) => {
  const world = makeWorld(t)
  const engine = world.engine()
  // Before the first tick nothing says which views are declared: requests wait, bounded.
  const taken = Array.from({ length: 70 }, (_, index) => engine.requestPreparation(`scope-${index}`))
  assert.deepEqual([taken.filter(Boolean).length, taken.slice(64).some(Boolean)], [64, false])
  await engine.tick()
  assert.deepEqual([engine.requestPreparation('scope-not-declared'), engine.requestPreparation(FULL_SCOPE.scopeId), engine.requestPreparation(FULL_SCOPE.scopeId), engine.requestPreparation(''), engine.requestPreparation(7)], [false, true, true, false, false])
})

test('the listener checks a view against the contracts\' own identifier, and has no pattern of its own', () => {
  const scopeOf = (scopeId) => ({ schema: 'atelier-obsidian-scope/v1', scopeId, mode: 'full', selector: { all: true } })
  for (const value of ['scope-whole', 'a', 'a'.repeat(128), 'a'.repeat(129), '.hidden', '-lead', 'a:b.c_d-e', '', 'ä', '../escape', 'with space', 7, null]) {
    assert.equal(isContractIdentifier(value), typeof value === 'string' && validateObsidianContract('scope', scopeOf(value)).length === 0, JSON.stringify(value))
  }
  const source = fs.readFileSync(path.join(REPOSITORY_ROOT, 'src/runtime/obsidian/service-server.mjs'), 'utf8')
  assert.equal(/\[A-Za-z0-9\]\[A-Za-z0-9\._:-\]/.test(source), false)
  assert.match(source, /isContractIdentifier\(scopeId\)/)
})

test('a requested tick asks the app again: an adapter-factory refusal remembered from before the app changed is not reused', async (t) => {
  const world = makeWorld(t)
  let observation = { installed: true, cli: true, running: true, version: null, noVaultOpen: true }
  const adapterFactory = createQualifiedAdapterFactory({ appProbe: { inspectSync: () => observation }, createAdapter: absentAdapter })
  const engine = world.engine({ adapterFactory })
  assert.deepEqual([(await engine.tick()).scopes[0].reason], ['app-version-unsupported'])
  // The app now has a vault open and answers its version; the refusal above is remembered for ten seconds.
  observation = { installed: true, cli: true, running: true, version: '1.13.7' }
  engine.requestPreparation(FULL_SCOPE.scopeId)
  const report = await engine.tick()
  assert.equal(report.scopes[0].reason === 'app-version-unsupported', false, `asked again: ${report.scopes[0].reason}`)
  assert.equal(adapterFactory.lastQualification().outcome, 'qualified')
})

test('a view prepared again whose generation is the committed one is settled by the publisher without an adapter: an app that cannot be qualified never makes it stale, and a publication still asks the app first', needsExchange, async (t) => {
  const world = makeWorld(t)
  const { publishView } = await import('../src/projection/obsidian/publication/publisher.mjs')
  let qualifies = true
  const built = []
  const published = []
  const adapterFactory = (input) => { built.push(input.scope.scopeId); if (!qualifies) throw new ObsidianMaintenanceRefusal('app-version-unsupported', 'stub', { reason: 'no-vault-open' }); return absentAdapter(input) }
  const engine = world.engine({ adapterFactory, fullReconciliationIntervalMs: 60 * 1000, seams: { publishView: (input) => { published.push(input.preparedView.manifest.generationId); return publishView(input) } } })
  const view = async () => (await engine.tick()).scopes[0]
  assert.deepEqual([(await view()).state, built.length, published.length], ['current', 1, 1])
  // The app now runs with no vault open, and cannot be qualified.
  qualifies = false
  engine.requestPreparation(FULL_SCOPE.scopeId)
  const again = await view()
  assert.deepEqual([again.state, again.reason, built.length, published.length], ['current', 'verified-by-read-back', 1, 2], 'the publisher settled it, and no adapter was built')
  // A change that needs a publication builds the adapter first: its refusal is what the view reports, and the publisher is not reached.
  fs.appendFileSync(world.source('west-wing/logs/tide.md'), '\nLow water at six.\n')
  world.advance(61 * 1000)
  const changed = await view()
  assert.deepEqual([changed.state, changed.reason, built.length, published.length], ['stale', 'app-version-unsupported', 2, 2])
})

test('open, with the app running and no vault open, leaves a view published while the app was quit current: the tick it asks for does not make it stale, and status says so afterwards', needsExchange, async (t) => {
  const world = makeWorld(t)
  const app = fakeApp({ running: false })
  const adapterFactory = (input) => { if (app.noVaultNow()) throw new ObsidianMaintenanceRefusal('app-version-unsupported', 'stub', { reason: 'no-vault-open' }); return absentAdapter(input) }
  await world.service({ adapterFactory })
  assert.equal((await world.run(['status', '--json'])).json.scopes[0].outcome, 'current')
  // The app starts with no vault open, and its list does not have the view's vault: open cannot add it.
  Object.assign(app.state, { running: true, noVaultAnswers: Number.POSITIVE_INFINITY })
  const opened = await world.run(openArgs(), { seams: { ...UNREACHABLE_SEAMS, ...app }, open: FAST_APP })
  assert.deepEqual([opened.json.outcome, opened.json.reason, opened.json.launched, opened.json.freshness?.state], ['app-version-unsupported', 'no-vault-open', false, 'current'], JSON.stringify(opened.json).slice(0, 400))
  const status = await world.run(['status', '--json'])
  assert.deepEqual([status.json.scopes[0].outcome, status.json.scopes[0].reason], ['current', 'verified-by-read-back'])
})

// Through a running service: a tick asked for one view over the listener reaches the engine, which drops what the
// service's adapter factory remembered. `hand` is what the service is given for that factory.
async function assertServiceAsksTheAppAgain(t, hand = (factory) => factory) {
  const world = makeWorld(t)
  let observation = { installed: true, cli: true, running: true, version: null, noVaultOpen: true }
  const adapterFactory = createQualifiedAdapterFactory({ appProbe: { inspectSync: () => observation }, createAdapter: absentAdapter })
  await world.service({ adapterFactory: hand(adapterFactory) })
  assert.equal((await world.run(['status', '--json'])).json.scopes[0].reason, 'app-version-unsupported')
  // The app now has a vault open. The refusal above is remembered for ten seconds; the tick asked for does not reuse it.
  observation = { installed: true, cli: true, running: true, version: '1.13.7' }
  const lifecycle = { loadProject: world.loadProject, dataRoot: world.dataRoot, env: world.env, probeTimeoutMs: FAST_PROBE }
  const asked = await requestServiceTick({ ...lifecycle, scopeId: FULL_SCOPE.scopeId })
  assert.deepEqual([asked.tick?.scopes?.[0]?.state, adapterFactory.lastQualification().outcome], ['current', 'qualified'], JSON.stringify(asked.tick).slice(0, 300))
}

test('through the running service, a tick asked for a view makes the adapter factory ask the app again', needsExchange, async (t) => {
  await assertServiceAsksTheAppAgain(t)
})

test('mutation control: a service that hands the engine a wrapper of its adapter factory without `forget` reuses the refusal', needsExchange, async (t) => {
  await assert.rejects(assertServiceAsksTheAppAgain(t, (factory) => (input) => factory(input)), assert.AssertionError)
})

// ---------------------------------------------------------------------------
// 4d. Obsidian's settings file: written only while no Obsidian runs, atomically, keeping everything else
// ---------------------------------------------------------------------------

const SETTINGS_BEFORE = { cli: true, vaults: { aaaaaaaaaaaaaaaa: { path: '/somewhere/else', ts: 1700000000000, open: true } }, updateDisabled: true, frame: 'hidden', nested: { list: [1, 2, { deep: null }], flag: false } }

function settingsWorld(t, { document = SETTINGS_BEFORE, text } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(TMP, 'atelier-obsidian-settings-')))
  t.after(() => { try { fs.chmodSync(path.join(dir, 'user-data'), 0o700) } catch { /* gone */ } fs.rmSync(dir, { recursive: true, force: true }) })
  const userDataDir = path.join(dir, 'user-data')
  const vaultRoot = path.join(dir, 'vaults', 'scope-whole')
  fs.mkdirSync(userDataDir, { recursive: true })
  fs.mkdirSync(vaultRoot, { recursive: true })
  const file = path.join(userDataDir, OBSIDIAN_SETTINGS_FILE)
  if (text !== null) fs.writeFileSync(file, text ?? JSON.stringify(document), { mode: 0o640 })
  if (text !== null) fs.chmodSync(file, 0o640)
  // The process table, as a list of answers; the last one repeats.
  const probeOf = (answers, onCall = () => {}) => { let calls = 0; return () => { const answer = answers[Math.min(calls, answers.length - 1)]; calls += 1; onCall(calls); return answer } }
  const bytes = () => (fs.existsSync(file) ? fs.readFileSync(file) : null)
  return { dir, userDataDir, vaultRoot, file, probeOf, bytes, names: () => fs.readdirSync(userDataDir).sort() }
}

test('the settings file is written only while no Obsidian runs: the new vault is added, every other key and entry is kept in its place, a backup is kept, and the replacement is atomic', (t) => {
  const world = settingsWorld(t)
  const before = world.bytes()
  const result = registerVaultInObsidianSettings({ userDataDir: world.userDataDir, vaultRoot: world.vaultRoot, processProbe: world.probeOf(['absent']), now: () => START })
  assert.deepEqual([result.ok, result.registered, result.confirmed], [true, 'written', true], JSON.stringify(result))
  const after = JSON.parse(world.bytes().toString('utf8'))
  assert.deepEqual(Object.keys(after), Object.keys(SETTINGS_BEFORE), 'keys keep their order')
  const { vaults, ...rest } = after
  const { vaults: vaultsBefore, ...restBefore } = SETTINGS_BEFORE
  assert.deepEqual(rest, restBefore, 'every other key is kept as it was')
  const added = Object.keys(vaults).filter((id) => !Object.hasOwn(vaultsBefore, id))
  assert.equal(added.length, 1)
  assert.match(added[0], /^[0-9a-f]{16}$/)
  assert.deepEqual(vaults[added[0]], { path: world.vaultRoot, ts: START, open: true })
  assert.deepEqual(Object.fromEntries(Object.entries(vaults).filter(([id]) => id !== added[0])), vaultsBefore, 'every other vault entry is kept')
  if (process.platform !== 'win32') assert.equal(fs.statSync(world.file).mode & 0o777, 0o640, 'the file keeps its mode')
  assert.deepEqual(world.names(), [OBSIDIAN_SETTINGS_FILE, `${OBSIDIAN_SETTINGS_FILE}.atelier-backup-20260105T100000000Z`], 'the backup, and no temporary file, is left beside it')
  assert.deepEqual(fs.readFileSync(result.backupPath), before, 'the backup holds the bytes as they were')
  assert.deepEqual([result.entry.id, result.entry.path], [added[0], world.vaultRoot])
  // Read back, the app would find it by path.
  assert.equal(findVaultEntry(readObsidianSettings({ userDataDir: world.userDataDir }).vaults, world.vaultRoot).id, added[0])
  // A second registration, and one through a link to the same folder, find it and write nothing.
  const written = world.bytes()
  const alias = path.join(world.dir, 'alias')
  if (process.platform !== 'win32') fs.symlinkSync(world.vaultRoot, alias)
  for (const vaultRoot of process.platform === 'win32' ? [world.vaultRoot] : [world.vaultRoot, alias]) {
    const again = registerVaultInObsidianSettings({ userDataDir: world.userDataDir, vaultRoot, processProbe: world.probeOf(['absent']), now: () => START + 1 })
    assert.deepEqual([again.ok, again.registered, again.entry.id], [true, 'already', added[0]])
  }
  assert.deepEqual([world.bytes(), world.names().length], [written, 2])
})

test('the settings file takes several vaults of one workspace, one after the other, each under its own id, and keeps the first when the second is added', (t) => {
  const world = settingsWorld(t)
  const second = path.join(world.dir, 'vaults', 'scope-east')
  fs.mkdirSync(second, { recursive: true })
  const first = registerVaultInObsidianSettings({ userDataDir: world.userDataDir, vaultRoot: world.vaultRoot, processProbe: world.probeOf(['absent']), now: () => START })
  const next = registerVaultInObsidianSettings({ userDataDir: world.userDataDir, vaultRoot: second, processProbe: world.probeOf(['absent']), now: () => START + 1000 })
  assert.deepEqual([first.registered, next.registered], ['written', 'written'])
  assert.notEqual(first.entry.id, next.entry.id)
  const { vaults } = readObsidianSettings({ userDataDir: world.userDataDir })
  assert.deepEqual([findVaultEntry(vaults, world.vaultRoot).id, findVaultEntry(vaults, second).id], [first.entry.id, next.entry.id])
  assert.equal(Object.keys(vaults).length, 3, 'the vault that was there, and the two added')
  assert.equal(world.names().filter((name) => name.includes('atelier-backup')).length, 2, 'each write kept its own backup')
})

test('the settings file is refused, typed and with nothing written, while an app may run, when it is a link, not this user\'s, not a JSON object, unreadable or missing', (t) => {
  const refusedWith = (world, options, code) => {
    const before = world.bytes()
    const namesBefore = fs.existsSync(world.userDataDir) ? world.names() : null
    const result = registerVaultInObsidianSettings({ userDataDir: world.userDataDir, vaultRoot: world.vaultRoot, processProbe: world.probeOf(['absent']), now: () => START, ...options })
    assert.deepEqual([result.ok, result.code], [false, code], JSON.stringify(result))
    assert.deepEqual(world.bytes(), before, `${code}: the file is unchanged`)
    assert.deepEqual(fs.existsSync(world.userDataDir) ? world.names() : null, namesBefore, `${code}: nothing is left beside it`)
  }
  for (const answer of ['running', 'unknown']) { const world = settingsWorld(t); refusedWith(world, { processProbe: world.probeOf([answer]) }, 'app-may-be-running') }
  { const world = settingsWorld(t); refusedWith(world, { processProbe: () => { throw new Error('ps failed') } }, 'app-may-be-running') }
  // An app that appears after the file was read and before the rename: the prepared files are removed again.
  { const world = settingsWorld(t); refusedWith(world, { processProbe: world.probeOf(['absent', 'running']) }, 'app-may-be-running') }
  // A file that changes after it was read (the app started and quit, a sync tool): it is not replaced, and the change stays.
  {
    const world = settingsWorld(t)
    const changed = Buffer.from(JSON.stringify({ ...SETTINGS_BEFORE, frame: 'native' }))
    const result = registerVaultInObsidianSettings({ userDataDir: world.userDataDir, vaultRoot: world.vaultRoot, now: () => START, processProbe: world.probeOf(['absent'], (calls) => { if (calls === 2) fs.writeFileSync(world.file, changed) }) })
    assert.deepEqual([result.ok, result.code, world.bytes(), world.names()], [false, 'obsidian-settings-changed', changed, [OBSIDIAN_SETTINGS_FILE]])
  }
  if (process.platform !== 'win32') {
    const world = settingsWorld(t)
    const real = path.join(world.dir, 'real-settings.json')
    fs.renameSync(world.file, real)
    fs.symlinkSync(real, world.file)
    const target = fs.readFileSync(real)
    refusedWith(world, {}, 'obsidian-settings-unsafe')
    assert.deepEqual(fs.readFileSync(real), target, 'the file a link points at is not written either')
  }
  if (process.platform !== 'win32') {
    const world = settingsWorld(t)
    const real = path.join(world.dir, 'real-user-data')
    fs.renameSync(world.userDataDir, real)
    fs.symlinkSync(real, world.userDataDir)
    refusedWith(world, {}, 'obsidian-settings-unsafe')
  }
  if (typeof process.getuid === 'function') { const world = settingsWorld(t); refusedWith(world, { uid: process.getuid() + 1 }, 'obsidian-settings-not-owned') }
  for (const text of ['[]', '"vaults"', '{"vaults":[]}', '{"vaults":"none"}', 'null']) refusedWith(settingsWorld(t, { text }), {}, 'obsidian-settings-not-object')
  for (const text of ['not json', '{"vaults":', '']) refusedWith(settingsWorld(t, { text }), {}, 'obsidian-settings-unreadable')
  // Obsidian has not run here: the file is never created, and neither is its directory.
  { const world = settingsWorld(t, { text: null }); refusedWith(world, {}, 'obsidian-settings-missing'); assert.equal(fs.existsSync(world.file), false) }
  { const world = settingsWorld(t); fs.rmSync(world.userDataDir, { recursive: true }); refusedWith(world, {}, 'obsidian-settings-missing'); assert.equal(fs.existsSync(world.userDataDir), false) }
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    const world = settingsWorld(t)
    fs.chmodSync(world.userDataDir, 0o500)
    refusedWith(world, {}, 'obsidian-settings-unwritable')
    fs.chmodSync(world.userDataDir, 0o700)
  }
  // The location of the settings is not known (another platform, no HOME).
  { const world = settingsWorld(t); refusedWith({ ...world, userDataDir: null, names: () => world.names() }, {}, 'obsidian-settings-location-unknown') }
})

test('the settings file: an app that appears right after the rename leaves the entry unconfirmed, a colliding id is drawn again, and a list without vaults gains one', (t) => {
  const late = settingsWorld(t)
  const result = registerVaultInObsidianSettings({ userDataDir: late.userDataDir, vaultRoot: late.vaultRoot, now: () => START, processProbe: late.probeOf(['absent', 'absent', 'running']) })
  assert.deepEqual([result.ok, result.registered, result.confirmed, result.reason], [true, 'written', false, 'app-started-during-registration'])

  const colliding = settingsWorld(t)
  const draws = [Buffer.from('aaaaaaaaaaaaaaaa', 'hex'), Buffer.from('0123456789abcdef', 'hex'), Buffer.from('feedfacecafe', 'hex')]
  const collided = registerVaultInObsidianSettings({ userDataDir: colliding.userDataDir, vaultRoot: colliding.vaultRoot, now: () => START, processProbe: colliding.probeOf(['absent']), randomBytes: (size) => draws.shift() ?? randomBytes(size) })
  assert.equal(collided.entry.id, '0123456789abcdef', 'an id an entry already has is never used')
  assert.equal(JSON.parse(colliding.bytes()).vaults.aaaaaaaaaaaaaaaa.path, '/somewhere/else')

  const empty = settingsWorld(t, { document: { cli: true } })
  const gained = registerVaultInObsidianSettings({ userDataDir: empty.userDataDir, vaultRoot: empty.vaultRoot, now: () => START, processProbe: empty.probeOf(['absent']) })
  assert.equal(gained.ok, true)
  assert.deepEqual(Object.keys(JSON.parse(empty.bytes())), ['cli', 'vaults'])
})

test('the settings file never gains a vault inside another listed vault; one listed already is found, and a vault beside or inside it is no reason to refuse', (t) => {
  const world = settingsWorld(t)
  const register = () => registerVaultInObsidianSettings({ userDataDir: world.userDataDir, vaultRoot: world.vaultRoot, processProbe: world.probeOf(['absent']), now: () => START })
  const list = (vaults) => { fs.writeFileSync(world.file, JSON.stringify({ ...SETTINGS_BEFORE, vaults: { ...SETTINGS_BEFORE.vaults, ...vaults } })); return world.bytes() }
  const before = list({ bbbbbbbbbbbbbbbb: { path: world.dir, ts: 1 } })
  const refused = register()
  assert.deepEqual([refused.ok, refused.code, world.bytes(), world.names()], [false, 'vault-inside-another-vault', before, [OBSIDIAN_SETTINGS_FILE]])
  const listedBelow = list({ bbbbbbbbbbbbbbbb: { path: world.dir, ts: 1 }, cccccccccccccccc: { path: world.vaultRoot, ts: 2 } })
  const found = register()
  assert.deepEqual([found.ok, found.registered, found.entry.id, Object.keys(found.vaults), world.bytes()], [true, 'already', 'cccccccccccccccc', ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc'], listedBelow])
  list({ bbbbbbbbbbbbbbbb: { path: `${world.vaultRoot}-old`, ts: 1 }, dddddddddddddddd: { path: path.join(world.vaultRoot, 'inner'), ts: 1 } })
  const added = register()
  assert.deepEqual([added.ok, added.registered, added.confirmed], [true, 'written', true], JSON.stringify(added))
  assert.deepEqual(Object.keys(added.vaults), ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'dddddddddddddddd', added.entry.id], 'the list as written is answered')
})

test('a write that fails at any step leaves the settings file as it was and nothing beside it: every file-system call it makes in the app\'s directory is failed in turn', (t) => {
  // Only calls about the app's directory and the files in it are counted and failed. A failed close releases its
  // descriptor all the same, as close(2) does.
  const control = { directory: null, failAt: 0, calls: [] }
  const descriptors = new Map()
  const inside = (target) => control.directory !== null && typeof target === 'string' && (target === control.directory || target.startsWith(control.directory + path.sep))
  const label = (target) => {
    const name = path.basename(target)
    return target === control.directory ? 'directory' : name === OBSIDIAN_SETTINGS_FILE ? 'settings' : name.endsWith('.tmp') ? 'temporary' : name.includes('.atelier-backup-') ? 'backup' : name
  }
  for (const name of ['lstatSync', 'statSync', 'openSync', 'fstatSync', 'readFileSync', 'readSync', 'writeFileSync', 'writeSync', 'fchmodSync', 'fsyncSync', 'closeSync', 'renameSync']) {
    const original = fs[name]
    t.mock.method(fs, name, function failing(...args) {
      const [first, second] = args
      const target = typeof first === 'number' ? descriptors.get(first) : typeof first === 'string' ? first : undefined
      const counted = inside(target) || (name === 'renameSync' && inside(second))
      if (counted) {
        control.calls.push(`${name} ${label(target)}`)
        if (control.calls.length === control.failAt) {
          if (name === 'closeSync') { descriptors.delete(first); original.apply(this, args) }
          throw Object.assign(new Error(`injected failure of ${name}`), { code: 'EIO' })
        }
      }
      const result = original.apply(this, args)
      if (name === 'openSync' && counted) descriptors.set(result, target)
      if (name === 'closeSync') descriptors.delete(first)
      return result
    })
  }
  const BACKUP = `${OBSIDIAN_SETTINGS_FILE}.atelier-backup-20260105T100000000Z`
  const attempt = (failAt) => {
    const world = settingsWorld(t)
    const before = world.bytes()
    Object.assign(control, { directory: world.userDataDir, failAt, calls: [] })
    try {
      const result = registerVaultInObsidianSettings({ userDataDir: world.userDataDir, vaultRoot: world.vaultRoot, processProbe: world.probeOf(['absent']), now: () => START })
      return { world, before, result, calls: control.calls }
    } finally {
      control.directory = null
    }
  }
  const { result: written, calls: steps } = attempt(0)
  assert.equal(written.ok, true, JSON.stringify(written))
  // Among the reads around it, the write makes these calls, in this order. Windows opens no directory to fsync it.
  let from = 0
  for (const step of ['openSync temporary', 'writeSync temporary', 'fchmodSync temporary', 'fsyncSync temporary', 'closeSync temporary', 'openSync backup', 'writeSync backup', 'fchmodSync backup', 'fsyncSync backup', 'closeSync backup', 'readFileSync settings', 'renameSync temporary', 'openSync directory', ...(process.platform === 'win32' ? [] : ['fsyncSync directory'])]) {
    const at = steps.indexOf(step, from)
    assert.ok(at >= 0, `${step} is made after the calls before it: ${steps.join(', ')}`)
    from = at + 1
  }
  const renamed = steps.indexOf('renameSync temporary') + 1
  const unconfirmed = []
  for (let failAt = 1; failAt <= steps.length; failAt += 1) {
    const { world, before, result, calls } = attempt(failAt)
    const step = `${calls[failAt - 1]} (call ${failAt})`
    assert.equal(calls[failAt - 1], steps[failAt - 1], `${step}: the same calls up to the failure`)
    assert.equal(typeof result?.ok, 'boolean', `${step}: an answer, not an exception`)
    if (/^(openSync|writeFileSync|writeSync|fchmodSync|fsyncSync|closeSync) (temporary|backup)$|^renameSync/.test(calls[failAt - 1])) assert.equal(result.ok, false, `${step}: a failed write is refused`)
    if (failAt > renamed) assert.equal(result.ok, true, `${step}: after the replacement, the vault is added`)
    if (result.ok) {
      // Written, and the file could not be read back to find the entry: said as such, never as an app that started.
      if (!result.confirmed) { assert.equal(result.reason, 'registration-not-read-back', step); unconfirmed.push(step) }
      assert.deepEqual(world.names(), [OBSIDIAN_SETTINGS_FILE, BACKUP], `${step}: the backup and no temporary file`)
      assert.deepEqual(fs.readFileSync(path.join(world.userDataDir, BACKUP)), before, `${step}: the whole backup`)
      assert.notEqual(findVaultEntry(JSON.parse(world.bytes().toString('utf8')).vaults, world.vaultRoot), null, step)
    } else {
      assert.match(result.code, /^obsidian-settings-/, step)
      assert.deepEqual([world.bytes(), world.names()], [before, [OBSIDIAN_SETTINGS_FILE]], `${step}: the file as it was, and nothing beside it`)
    }
  }
  assert.ok(unconfirmed.length > 0, 'a failed read-back after the rename was among the steps')
})

test('the settings file is never written larger than a settings file this module reads, nor through a second name (a hard link), nor for a Flatpak or snap build', (t) => {
  const refusedWith = (world, options, code) => {
    const before = world.bytes()
    const result = registerVaultInObsidianSettings({ userDataDir: world.userDataDir, vaultRoot: world.vaultRoot, processProbe: world.probeOf(['absent']), now: () => START, ...options })
    assert.deepEqual([result.ok, result.code, world.bytes(), world.names()], [false, code, before, [OBSIDIAN_SETTINGS_FILE]], JSON.stringify(result))
  }
  // Just under the bound as it is: the entry would take it over.
  const filler = 'x'.repeat(MAX_OBSIDIAN_SETTINGS_BYTES - Buffer.byteLength(JSON.stringify({ ...SETTINGS_BEFORE, filler: '' })) - 10)
  const full = settingsWorld(t, { document: { ...SETTINGS_BEFORE, filler } })
  assert.equal(readObsidianSettings({ userDataDir: full.userDataDir }).ok, true, 'the file as it is can be read')
  refusedWith(full, {}, 'obsidian-settings-too-large')
  const linked = settingsWorld(t)
  let linkedHere = true
  try { fs.linkSync(linked.file, path.join(linked.dir, 'another-name.json')) } catch (error) { if (process.platform !== 'win32') throw error; linkedHere = false }
  if (linkedHere) {
    const other = fs.readFileSync(path.join(linked.dir, 'another-name.json'))
    refusedWith(linked, {}, 'obsidian-settings-unsafe')
    assert.deepEqual(fs.readFileSync(path.join(linked.dir, 'another-name.json')), other, 'the other name keeps the same list')
  }
  for (const sandbox of ['flatpak', 'snap']) refusedWith(settingsWorld(t), { sandbox }, 'obsidian-sandboxed')
})

test('of the backups beside the settings file, the first (the list as it was before Atelier wrote it) and the latest are kept', (t) => {
  const world = settingsWorld(t)
  const before = world.bytes()
  const vaults = ['scope-east', 'scope-west', 'scope-north'].map((name) => { const folder = path.join(world.dir, 'vaults', name); fs.mkdirSync(folder, { recursive: true }); return folder })
  const results = vaults.map((vaultRoot, index) => registerVaultInObsidianSettings({ userDataDir: world.userDataDir, vaultRoot, processProbe: world.probeOf(['absent']), now: () => START + index * 1000 }))
  assert.deepEqual(results.map((result) => result.registered), ['written', 'written', 'written'])
  const backups = world.names().filter((name) => name.includes('.atelier-backup-'))
  assert.deepEqual(backups, [path.basename(results[0].backupPath), path.basename(results[2].backupPath)], 'the first and the latest')
  assert.deepEqual(fs.readFileSync(results[0].backupPath), before, 'the first holds the list as it was before any write')
  // A file that only looks like a backup is not one of Atelier's, and stays.
  fs.writeFileSync(path.join(world.userDataDir, `${OBSIDIAN_SETTINGS_FILE}.atelier-backup-kept-by-hand`), 'x')
  const next = path.join(world.dir, 'vaults', 'scope-south')
  fs.mkdirSync(next)
  registerVaultInObsidianSettings({ userDataDir: world.userDataDir, vaultRoot: next, processProbe: world.probeOf(['absent']), now: () => START + 9000 })
  assert.equal(world.names().includes(`${OBSIDIAN_SETTINGS_FILE}.atelier-backup-kept-by-hand`), true)
  assert.equal(world.names().filter((name) => /\.atelier-backup-\d{8}T\d{9}Z$/.test(name)).length, 2)
})

test('a Flatpak or snap build is recognised by its sandbox for this account or its installation, on Linux only', () => {
  // The paths are Linux's, whatever platform runs this: what exists is answered from a list.
  const present = new Set()
  const build = (platform = 'linux', env = { HOME: '/home/someone' }) => obsidianSandboxedBuild({ platform, env, exists: (candidate) => present.has(candidate) })
  assert.equal(build(), null)
  present.add('/home/someone/snap/obsidian')
  assert.equal(build(), 'snap')
  present.add('/home/someone/.var/app/md.obsidian.Obsidian')
  assert.equal(build(), 'flatpak')
  for (const platform of ['darwin', 'win32']) assert.equal(build(platform), null, platform)
  for (const [where, expected] of [['/home/someone/.local/share/flatpak/app/md.obsidian.Obsidian', 'flatpak'], ['/var/lib/flatpak/app/md.obsidian.Obsidian', 'flatpak'], ['/snap/obsidian', 'snap']]) {
    present.clear()
    present.add(where)
    assert.equal(build(), expected, where)
  }
  // Installed system-wide, it is found whatever HOME is; a HOME that is not an absolute POSIX path names no sandbox of its own.
  assert.equal(build('linux', {}), 'snap')
  present.clear()
  present.add('relative/snap/obsidian')
  assert.equal(build('linux', { HOME: 'relative' }), null)
})

// Whether this file system folds letter case, as macOS does by default: a folder can then be spelled in another case
// than the one it is stored in, and the operating system reports a working directory in the stored one.
const CASE_FOLDING = (() => {
  try {
    const probe = fs.mkdtempSync(path.join(TMP, 'atelier-Case-'))
    try { return probe !== probe.toLowerCase() && fs.existsSync(probe.toLowerCase()) } finally { fs.rmSync(probe, { recursive: true, force: true }) }
  } catch { return false }
})()
const needsCaseFolding = CASE_FOLDING && process.platform !== 'win32' ? {} : { skip: 'this file system tells letter case apart, or it is Windows: a folder has one spelling here' }

test('a vault root spelled in another letter case than it is stored in is taken as stored: the store, the enclosing check, routing and the settings file see what the app sees', needsCaseFolding, (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(TMP, 'atelier-Spelling-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const home = path.join(dir, 'Home')
  const workspaceRoot = path.join(home, 'Data', 'Workspace')
  fs.mkdirSync(workspaceRoot, { recursive: true })
  // The store derives the vault root in the stored spelling, whichever spelling it was given.
  const store = createRecoveryStore({ workspaceRoot: workspaceRoot.toLowerCase(), workspaceId: WORKSPACE_ID, scopeId: FULL_SCOPE.scopeId, repositoryRoots: [] })
  assert.equal(store.vaultRoot, path.join(workspaceRoot, 'vaults', FULL_SCOPE.scopeId))
  const spelled = store.vaultRoot.toLowerCase()
  // A vault listed above it in the stored spelling contains it, and the vault is reached by its id, not by a working
  // directory that the operating system would report in the stored spelling.
  const above = { aaaaaaaaaaaaaaaa: { path: home, ts: 1 } }
  assert.deepEqual(enclosingVaults({ vaults: above, vaultRoot: spelled }).map((entry) => entry.id), ['aaaaaaaaaaaaaaaa'])
  assert.deepEqual(vaultRoute({ vaults: { ...above, cccccccccccccccc: { path: spelled, ts: 2 } }, vaultRoot: spelled }), { how: 'id', id: 'cccccccccccccccc' })
  // The settings file names the stored spelling.
  const userDataDir = path.join(dir, 'user-data')
  fs.mkdirSync(userDataDir)
  fs.writeFileSync(path.join(userDataDir, OBSIDIAN_SETTINGS_FILE), JSON.stringify({ vaults: {} }))
  const written = registerVaultInObsidianSettings({ userDataDir, vaultRoot: spelled, processProbe: () => 'absent', now: () => START })
  assert.deepEqual([written.ok, written.entry.path], [true, store.vaultRoot], JSON.stringify(written))
})

test('open\'s check that the app answers for the vault takes the app\'s folder as the file system stores it, as the bridge does: a vault the app holds under another letter case or through a link answers, another folder does not', needsCaseFolding.skip === undefined ? needsAppIsolation : needsCaseFolding, (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(TMP, 'atelier-Held-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const vaultRoot = path.join(dir, 'Stand', 'Vaults', 'scope-whole')
  fs.mkdirSync(vaultRoot, { recursive: true })
  fs.mkdirSync(path.join(dir, 'other'))
  fs.symlinkSync(path.join(dir, 'Stand', 'Vaults'), path.join(dir, 'linked'))
  // A stand-in for the command-line tool that runs the code it is given as the app runs it, in a vault the app holds
  // at HELD, the folder its list names (one added, say, from a data root typed in another letter case).
  const script = `const vm = require('vm')
const app = { vault: { adapter: { basePath: process.env.HELD } }, metadataCache: { initialized: true } }
console.log('=> ' + vm.runInNewContext(process.argv.at(-1).slice('code='.length), { app, require, process }))\n`
  fs.writeFileSync(path.join(vaultRoot, 'eval'), script)
  fs.writeFileSync(path.join(dir, 'vault=cccccccccccccccc'), script)
  const held = { stored: vaultRoot, otherCase: path.join(dir, 'stand', 'vaults', 'scope-whole'), throughLink: path.join(dir, 'linked', 'scope-whole'), another: path.join(dir, 'other') }
  const seams = pathToFileURL(path.join(REPOSITORY_ROOT, 'src/runtime/obsidian/app-production-seams.mjs')).href
  const child = `const { createProductionAppProbe } = await import(${JSON.stringify(seams)})
const vaultRoot = ${JSON.stringify(vaultRoot)}
const out = {}
for (const [name, where] of Object.entries(${JSON.stringify(held)})) {
  const probe = createProductionAppProbe({ cliPath: process.execPath, workingDirectory: ${JSON.stringify(dir)}, env: { ...process.env, HELD: where } })
  out[name] = [await probe.vaultState({ vaultRoot, route: { how: 'folder', cwd: vaultRoot } }), await probe.vaultState({ vaultRoot, route: { how: 'id', id: 'cccccccccccccccc' } })]
}
process.stdout.write(JSON.stringify(out))`
  const run = childProcess.spawnSync(process.execPath, ['--input-type=module', '-e', child], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 120000, env: privateHomeEnv(dir) })
  assert.equal(run.status, 0, run.stderr)
  const [yes, no] = [{ answered: true, indexReady: true }, { answered: false, indexReady: false }]
  assert.deepEqual(JSON.parse(run.stdout), { stored: [yes, yes], otherCase: [yes, yes], throughLink: [yes, yes], another: [no, no] })
})

test('a Flatpak or snap build is told from a native one by whose vault list was written last; installation traces decide only when no build wrote one', () => {
  // Linux paths under a POSIX HOME, whatever platform runs this: what exists, and when a list was written, from a table.
  const lists = new Map()
  const traces = new Set()
  const build = (env = { HOME: '/home/someone' }) => obsidianSandboxedBuild({ platform: 'linux', env, exists: (candidate) => traces.has(candidate) || lists.has(candidate), modified: (candidate) => lists.get(candidate) ?? null })
  const NATIVE = '/home/someone/.config/obsidian/obsidian.json'
  const FLATPAK = '/home/someone/.var/app/md.obsidian.Obsidian/config/obsidian/obsidian.json'
  const SNAP = '/home/someone/snap/obsidian/current/.config/obsidian/obsidian.json'
  // The data of an uninstalled Flatpak stays behind; the native build wrote its list since.
  traces.add('/home/someone/.var/app/md.obsidian.Obsidian')
  lists.set(FLATPAK, 1000)
  lists.set(NATIVE, 2000)
  assert.equal(build(), null)
  lists.set(FLATPAK, 3000)
  assert.equal(build(), 'flatpak')
  lists.set(SNAP, 4000)
  assert.equal(build(), 'snap')
  // XDG_CONFIG_HOME moves the native list.
  lists.set('/cfg/obsidian/obsidian.json', 5000)
  assert.equal(build({ HOME: '/home/someone', XDG_CONFIG_HOME: '/cfg' }), null)
  // No list anywhere: the installation decides, a snap mounted under /var/lib/snapd included.
  lists.clear()
  traces.clear()
  traces.add('/var/lib/snapd/snap/obsidian')
  assert.equal(build(), 'snap')
})

test('a listed folder is compared as written first, and its real path is read only when its last component is the vault root\'s: no other vault is waited on', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(TMP, 'atelier-lexical-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const vaultRoot = path.join(dir, 'vaults', 'scope-whole')
  fs.mkdirSync(vaultRoot, { recursive: true })
  const others = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`${String(index).padStart(16, 'a')}`, { path: path.join(dir, 'elsewhere', `vault-${index}`), ts: 1 }]))
  // Both Node's own resolution and the one that reads the spelling from the disk (`.native`) are counted.
  const asked = []
  const realpath = fs.realpathSync
  t.after(() => { fs.realpathSync = realpath })
  const native = (target, ...rest) => { asked.push(String(target)); return realpath.native(target, ...rest) }
  fs.realpathSync = Object.assign((target, ...rest) => { asked.push(String(target)); return realpath(target, ...rest) }, { native })
  const count = (operation) => { asked.length = 0; const answer = operation(); return { answer, others: asked.filter((target) => target !== vaultRoot).length } }
  const listed = { ...others, cccccccccccccccc: { path: vaultRoot, ts: 2, open: true } }
  assert.deepEqual(count(() => findVaultEntry(listed, vaultRoot)), { answer: { id: 'cccccccccccccccc', path: vaultRoot, open: true }, others: 0 })
  assert.deepEqual(count(() => findVaultEntry(others, vaultRoot)), { answer: null, others: 0 })
  assert.deepEqual(count(() => vaultRoute({ vaults: listed, vaultRoot, open: true })), { answer: { how: 'id', id: 'cccccccccccccccc' }, others: 0 })
  assert.deepEqual(count(() => enclosingVaults({ vaults: { ...others, dddddddddddddddd: { path: dir } }, vaultRoot }).map((entry) => entry.id)), { answer: ['dddddddddddddddd'], others: 0 })
  // The vault root reached through a linked parent keeps its last component, and is still found.
  if (process.platform !== 'win32') {
    fs.symlinkSync(path.join(dir, 'vaults'), path.join(dir, 'linked'))
    const throughLink = { eeeeeeeeeeeeeeee: { path: path.join(dir, 'linked', 'scope-whole'), ts: 3 } }
    assert.equal(findVaultEntry({ ...others, ...throughLink }, vaultRoot)?.id, 'eeeeeeeeeeeeeeee')
  }
})

test('where the app keeps its settings: under HOME on macOS, under XDG_CONFIG_HOME or ~/.config on Linux, unknown elsewhere or without an absolute HOME', () => {
  assert.equal(obsidianUserDataDir({ platform: 'darwin', env: { HOME: '/home/someone' } }), '/home/someone/Library/Application Support/obsidian')
  assert.equal(obsidianUserDataDir({ platform: 'linux', env: { HOME: '/home/someone' } }), '/home/someone/.config/obsidian')
  assert.equal(obsidianUserDataDir({ platform: 'linux', env: { HOME: '/home/someone', XDG_CONFIG_HOME: '/cfg' } }), '/cfg/obsidian')
  assert.equal(obsidianUserDataDir({ platform: 'linux', env: { HOME: '/home/someone', XDG_CONFIG_HOME: 'relative' } }), '/home/someone/.config/obsidian')
  for (const [platform, env] of [['win32', { HOME: 'C:\\Users\\someone' }], ['darwin', {}], ['darwin', { HOME: 'relative' }]]) assert.equal(obsidianUserDataDir({ platform, env }), null)
})

// ---------------------------------------------------------------------------
// 4e. The command line of the app: its answers, and the window a call reaches
// ---------------------------------------------------------------------------

test('an eval answer is read from the value after "=> ", once or twice parsed; "Vault not found." and a failed call are typed', () => {
  assert.deepEqual(readEvalAnswer({ stdout: '=> {"vaults":{"a":{"path":"/v"}}}\n' }), { answered: true, value: { vaults: { a: { path: '/v' } } } })
  assert.deepEqual(readEvalAnswer({ stdout: '=> "{\\"result\\":true}"\n' }), { answered: true, value: { result: true } }, 'a tool that quotes the string it prints')
  assert.deepEqual(readEvalAnswer({ stdout: 'Vault not found.\n' }), { answered: false, reason: 'no-vault-open' })
  assert.deepEqual(readEvalAnswer({ stderr: 'Vault not found.\n', failed: true }), { answered: false, reason: 'no-vault-open' })
  assert.deepEqual(readEvalAnswer({ stdout: '=> {"result":true}', failed: true }), { answered: false, reason: 'cli-failed' }, 'the value of a failed call is not believed')
  assert.deepEqual(readEvalAnswer({ stdout: 'Error: Command "eval" not found.\n' }), { answered: false, reason: 'no-value' })
  assert.deepEqual(readEvalAnswer({ stdout: '=> /a/plain/string\n' }), { answered: false, reason: 'no-value' })
})

test('what the app looks like, from the process table and its list alone, changes when it quits or starts and when a vault opens or closes; the service asks the app nothing to find out', () => {
  const settings = (open) => ({ ok: true, vaults: { a: { path: '/one', open: open.includes('/one') }, b: { path: '/two', open: open.includes('/two') } } })
  const base = appStateSignature({ processes: 'running', settings: settings(['/one']) })
  assert.equal(appStateSignature({ processes: 'running', settings: settings(['/one']) }), base)
  for (const other of [
    appStateSignature({ processes: 'absent', settings: settings(['/one']) }),
    appStateSignature({ processes: 'unknown', settings: settings(['/one']) }),
    appStateSignature({ processes: 'running', settings: settings(['/one', '/two']) }),
    appStateSignature({ processes: 'running', settings: { ok: false, code: 'obsidian-settings-missing' } }),
  ]) assert.notEqual(other, base)
  // Built from the process table and the settings file, never from a qualification, which runs the command-line tool
  // in the window that had focus last.
  const entry = fs.readFileSync(path.join(REPOSITORY_ROOT, 'src/runtime/obsidian/service-main.mjs'), 'utf8')
  assert.match(entry, /const observeApp = \(\) => appStateSignature\(\{ processes: defaultObsidianProcessProbe\(\), settings: /)
  assert.equal(/\.qualification\(\)/.test(entry), false)
})

test('the service\'s adapter factory asks the app without blocking, and only when a view is published', needsExchange, async (t) => {
  let asked = 0
  let answer = { installed: true, cli: true, running: true, version: '1.13.7 (installer 1.12.7)' }
  const appProbe = { inspect: async () => { asked += 1; await new Promise((resolve) => { setImmediate(resolve) }); return answer } }
  const factory = createQualifiedAdapterFactory({ appProbe, createAdapter: absentAdapter })
  const pending = factory({})
  assert.ok(pending instanceof Promise, 'an answer to wait for, not a call that blocks')
  assert.equal(typeof (await pending).probe, 'function')
  answer = { installed: true, cli: true, running: true, version: '1.13.6' }
  factory.forget()
  await assert.rejects(factory({}), (error) => error instanceof ObsidianMaintenanceRefusal && error.code === 'app-version-unsupported')
  assert.equal(asked, 2)
  // The engine waits for it: a view is published through it, and a tick with nothing to publish asks nothing.
  const world = makeWorld(t)
  answer = { installed: true, cli: true, running: false, version: null }
  asked = 0
  const engine = world.engine({ adapterFactory: createQualifiedAdapterFactory({ appProbe, createAdapter: absentAdapter }) })
  assert.equal((await engine.tick()).scopes[0].state, 'current')
  const afterFirst = asked
  await engine.tick()
  await engine.tick()
  assert.deepEqual([afterFirst, asked], [1, 1], 'nothing to publish, nothing asked')
})

test('where a call about a vault reaches the app, predicted from the app\'s list as the app routes it: by its id, in its folder when the id is not enough, or not at all', () => {
  // The paths need not exist: the list is compared as the app compares it.
  const root = path.join(TMP, 'atelier-route-nowhere')
  const home = path.join(root, 'home')
  const vaultRoot = path.join(home, 'data', 'vault')
  const OURS = 'cccccccccccccccc'
  const ours = { path: vaultRoot, ts: 2, open: true }
  const route = (vaults, options = {}) => vaultRoute({ vaults, vaultRoot, ...options })
  const FOLDER = { how: 'folder', cwd: vaultRoot }
  const ID = { how: 'id', id: OURS }
  // By its id whenever the id names it first: that does not depend on how a working directory is spelled.
  assert.deepEqual(route({ [OURS]: ours }), ID)
  assert.deepEqual(route({ aaaaaaaaaaaaaaaa: { path: home, ts: 1 }, [OURS]: ours }), ID, 'a vault listed first at a folder above it would take a call run in its folder')
  assert.deepEqual(route({ [OURS]: ours, aaaaaaaaaaaaaaaa: { path: home, ts: 1 } }), ID)
  // The id names another vault first: its folder has the id as its name, in another letter case, and it is listed before.
  // Then the folder, when the first listed vault that is or contains it is this one.
  const namedLikeIt = { path: path.join(root, OURS.toUpperCase()), ts: 1 }
  assert.deepEqual(route({ dddddddddddddddd: namedLikeIt, [OURS]: ours }), FOLDER)
  assert.deepEqual(route({ dddddddddddddddd: namedLikeIt, [OURS]: ours, aaaaaaaaaaaaaaaa: { path: home, ts: 1 } }), FOLDER, 'listed after it, the vault above takes nothing')
  assert.deepEqual(route({ dddddddddddddddd: namedLikeIt, aaaaaaaaaaaaaaaa: { path: `${vaultRoot}-old`, ts: 1 }, bbbbbbbbbbbbbbbb: { path: path.join(root, 'ho'), ts: 1 }, [OURS]: ours }), FOLDER, 'a folder whose name only begins the same contains nothing')
  assert.deepEqual(route({ dddddddddddddddd: namedLikeIt, aaaaaaaaaaaaaaaa: { path: path.parse(vaultRoot).root, ts: 1 }, [OURS]: ours }), FOLDER, 'the app routes no call to a vault at the root of the file system')
  assert.deepEqual(route({ aaaaaaaaaaaaaaaa: { path: home, ts: 1 }, dddddddddddddddd: namedLikeIt, [OURS]: ours }), { how: 'ambiguous' }, 'neither the id nor the folder reaches only this vault')
  assert.deepEqual(route({ aaaaaaaaaaaaaaaa: { path: home, ts: 1 }, [OURS]: ours, dddddddddddddddd: namedLikeIt }), ID)
  // With `open`, only an entry the app lists open may take a call: a closed vault is never reopened.
  assert.deepEqual(route({ [OURS]: { ...ours, open: false } }, { open: true }), { how: 'unlisted' })
  assert.deepEqual(route({ [OURS]: { ...ours, open: false } }), ID)
  for (const vaults of [{}, null, [], { [OURS]: { path: 'relative/vault' } }, { aaaaaaaaaaaaaaaa: { path: home } }]) assert.deepEqual(route(vaults), { how: 'unlisted' }, JSON.stringify(vaults))
  // The vaults that contain it: any listed above it, whatever their order, and none beside or inside it.
  const vaults = { [OURS]: ours, aaaaaaaaaaaaaaaa: { path: home, ts: 1 }, bbbbbbbbbbbbbbbb: { path: `${vaultRoot}-old` }, dddddddddddddddd: { path: path.join(vaultRoot, 'inner') }, eeeeeeeeeeeeeeee: { path: path.parse(vaultRoot).root } }
  assert.deepEqual(enclosingVaults({ vaults, vaultRoot }).map((entry) => entry.id), ['aaaaaaaaaaaaaaaa', 'eeeeeeeeeeeeeeee'])
  assert.deepEqual(enclosingVaults({ vaults: { [OURS]: ours }, vaultRoot }), [])
})

test('a folder the app lists open more than once, one window per entry, is duplicated: no call reaches every window that holds it, with `open` or without; while one entry has a window, a closed entry of the same folder is never reached, nor found first', (t) => {
  const OURS = 'cccccccccccccccc'
  const OTHER = 'dddddddddddddddd'
  // Another spelling of the same folder on every platform: with a trailing separator. The paths need not exist.
  const vaultRoot = path.join(TMP, 'atelier-route-twice', 'data', 'vault')
  const spelled = `${vaultRoot}${path.sep}`
  const both = { [OURS]: { path: vaultRoot, ts: 1, open: true }, [OTHER]: { path: spelled, ts: 2, open: true } }
  const duplicated = { how: 'duplicated', entries: [{ id: OURS, path: vaultRoot }, { id: OTHER, path: spelled }] }
  assert.deepEqual(vaultRoute({ vaults: both, vaultRoot, open: true }), duplicated)
  assert.deepEqual(vaultRoute({ vaults: both, vaultRoot }), duplicated)
  // One window: that entry, even below a closed entry of the same folder. None: the first entry, as before.
  const oneOpen = { [OTHER]: { path: spelled, ts: 2 }, [OURS]: { path: vaultRoot, ts: 1, open: true } }
  for (const open of [true, false]) assert.deepEqual(vaultRoute({ vaults: oneOpen, vaultRoot, open }), { how: 'id', id: OURS }, `open: ${open}`)
  assert.deepEqual(findVaultEntry(oneOpen, vaultRoot), { id: OURS, path: vaultRoot, open: true })
  const closed = { [OTHER]: { path: spelled, ts: 2 }, [OURS]: { path: vaultRoot, ts: 1 } }
  assert.deepEqual([vaultRoute({ vaults: closed, vaultRoot }), vaultRoute({ vaults: closed, vaultRoot, open: true }), findVaultEntry(closed, vaultRoot)?.id], [{ how: 'id', id: OTHER }, { how: 'unlisted' }, OTHER])
  // The folder opened by another path, through a link.
  if (process.platform !== 'win32') {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(TMP, 'atelier-twice-')))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const real = path.join(dir, 'vaults', 'scope-whole')
    fs.mkdirSync(real, { recursive: true })
    fs.symlinkSync(path.join(dir, 'vaults'), path.join(dir, 'linked'))
    const linked = path.join(dir, 'linked', 'scope-whole')
    assert.deepEqual(vaultRoute({ vaults: { [OURS]: { path: real, ts: 1, open: true }, [OTHER]: { path: linked, ts: 2, open: true } }, vaultRoot: real, open: true }), { how: 'duplicated', entries: [{ id: OURS, path: real }, { id: OTHER, path: linked }] })
  }
})

test('a publication call reaches only this vault: by its id while the app lists it open, whatever vault is listed above it, and not at all when neither its id nor its folder reaches only it; otherwise in a directory that is no vault', { skip: process.platform === 'win32' && 'no location of the app\'s settings is known on Windows: every call runs in a directory that is no vault' }, async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(TMP, 'atelier-cli-route-')))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const vaultRoot = path.join(home, 'data', 'vault')
  fs.mkdirSync(vaultRoot, { recursive: true })
  const userDataDir = obsidianUserDataDir({ platform: 'darwin', env: { HOME: home } })
  fs.mkdirSync(userDataDir, { recursive: true })
  const list = (vaults) => fs.writeFileSync(path.join(userDataDir, OBSIDIAN_SETTINGS_FILE), JSON.stringify({ vaults }))
  const route = publicationRoute({ env: { HOME: home }, platform: 'darwin' })
  const payload = { op: 'inspect', vaultRoot, path: 'notes/x.md' }
  const NOWHERE = { cwd: NEUTRAL_DIRECTORY, args: [] }
  const OURS = 'cccccccccccccccc'
  assert.deepEqual(route(payload), NOWHERE, 'the app does not list it: no vault is chosen')
  list({ [OURS]: { path: vaultRoot, ts: 2 } })
  assert.deepEqual(route(payload), NOWHERE, 'listed but closed: maintenance never reopens it')
  list({ [OURS]: { path: vaultRoot, ts: 2, open: true } })
  assert.deepEqual(route(payload), { cwd: NEUTRAL_DIRECTORY, args: [`vault=${OURS}`] }, 'listed and open: its window by its id, whichever has focus')
  // The home folder as a vault, listed first: a call run in the vault's folder would reach it, and open it when closed.
  list({ aaaaaaaaaaaaaaaa: { path: home, ts: 1 }, [OURS]: { path: vaultRoot, ts: 2, open: true } })
  assert.deepEqual(route(payload), { cwd: NEUTRAL_DIRECTORY, args: [`vault=${OURS}`] })
  list({ aaaaaaaaaaaaaaaa: { path: home, ts: 1, open: true }, [OURS]: { path: vaultRoot, ts: 2 } })
  assert.deepEqual(route(payload), NOWHERE, 'closed, below an open vault above it: no vault is chosen either')
  list({ aaaaaaaaaaaaaaaa: { path: home, ts: 1 }, dddddddddddddddd: { path: path.join(home, OURS.toUpperCase()), ts: 1 }, [OURS]: { path: vaultRoot, ts: 2, open: true } })
  assert.throws(() => route(payload), /vault-inside-another-vault/, 'no call can reach only this vault')
  assert.deepEqual(route({ ...payload, vaultRoot: path.join(home, 'another') }), NOWHERE)

  // A call takes its route's directory and leading arguments; a route that refuses makes no call. The command-line
  // tool is played by this Node binary running the script that the first argument names, in the directory it runs in.
  const log = path.join(home, 'calls.jsonl')
  fs.writeFileSync(path.join(home, `vault=${OURS}`), `require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), script: require('path').basename(process.argv[1]), next: process.argv[2] }) + '\\n'); console.log('=> ' + JSON.stringify({ status: 'inspected' }))\n`)
  const call = createObsidianCliCall({ cliPath: process.execPath, env: process.env, route: () => ({ cwd: home, args: [`vault=${OURS}`] }) })
  assert.deepEqual(await call(payload), { status: 'inspected' })
  const refusing = createObsidianCliCall({ cliPath: process.execPath, env: process.env, route: () => { throw new Error('vault-inside-another-vault: stub') } })
  await assert.rejects(refusing(payload), /vault-inside-another-vault/)
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)), [{ cwd: home, script: `vault=${OURS}`, next: 'eval' }], 'one call, naming the vault first; none for the route that refused')
})

test('the production registry and vault check, against a stand-in for the command-line tool: a path travels only as base64 JSON, a vault is reached by its route, answers are verified, and failures are typed', needsAppIsolation, (t) => {
  // The command-line tool is played by this Node binary running the script its first argument names (`eval`, or
  // `vault=<id>`) in the directory the call runs in: the registry's calls run in `workingDirectory`, and so does a vault
  // check that names the vault; a vault check routed by folder runs in the vault's folder.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(TMP, 'atelier-registry-cli-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const vaultRoot = path.join(dir, "it's a vault `${x}` $(y) é")
  fs.mkdirSync(vaultRoot)
  const script = `const fs = require('fs'); fs.appendFileSync(process.env.EVAL_LOG, JSON.stringify({ cwd: process.cwd(), first: require('path').basename(process.argv[1]), code: process.argv.at(-1) }) + '\\n');
const mode = process.env.EVAL_MODE
if (mode === 'no-vault') console.log('Vault not found.')
else if (mode === 'fail') process.exitCode = 3
else if (mode === 'hang') setTimeout(() => {}, 60000)
else console.log('=> ' + process.env.EVAL_ANSWER)\n`
  for (const where of [dir, vaultRoot]) fs.writeFileSync(path.join(where, 'eval'), script)
  fs.writeFileSync(path.join(dir, 'vault=dddddddddddddddd'), script)
  fs.mkdirSync(path.join(dir, 'flatpak-home', '.var', 'app', 'md.obsidian.Obsidian'), { recursive: true })
  const log = path.join(dir, 'log.jsonl')
  const seams = pathToFileURL(path.join(REPOSITORY_ROOT, 'src/runtime/obsidian/app-production-seams.mjs')).href
  const child = `const { createProductionAppProbe, createProductionAppRegistry } = await import(${JSON.stringify(seams)})
const env = (mode, answer = '') => ({ ...process.env, EVAL_LOG: ${JSON.stringify(log)}, EVAL_MODE: mode, EVAL_ANSWER: answer })
const registry = (mode, answer, extra = {}) => createProductionAppRegistry({ platform: 'win32', cliPath: process.execPath, workingDirectory: ${JSON.stringify(dir)}, env: env(mode, answer), userDataDir: null, ...extra })
const vaultRoot = ${JSON.stringify(vaultRoot)}
const out = {}
out.list = await registry('answer', JSON.stringify({ vaults: { dddddddddddddddd: { path: vaultRoot, ts: 1, open: true } } })).listThroughApp()
out.listNoVault = await registry('no-vault').listThroughApp()
out.listFailed = await registry('fail').listThroughApp()
out.listNotAMap = await registry('answer', JSON.stringify({ vaults: [] })).listThroughApp()
out.register = await registry('answer', JSON.stringify({ result: true })).registerThroughApp({ vaultRoot })
out.registerOther = await registry('answer', JSON.stringify({ result: true })).registerThroughApp({ vaultRoot: '/another/folder' })
out.registerRefused = await registry('answer', JSON.stringify({ result: 'folder not found' })).registerThroughApp({ vaultRoot })
const started = Date.now()
out.registerHung = await registry('hang', '', { timeoutMs: 1500 }).registerThroughApp({ vaultRoot })
out.hungMs = Date.now() - started
out.settings = registry('answer').registerInSettings({ vaultRoot })
const sandboxed = registry('answer', '', { platform: 'linux', env: { ...env('answer'), HOME: ${JSON.stringify(path.join(dir, 'flatpak-home'))} }, userDataDir: undefined })
out.sandboxed = [sandboxed.readSettings().code, sandboxed.registerInSettings({ vaultRoot }).code]
const probe = (answer) => createProductionAppProbe({ platform: 'win32', cliPath: process.execPath, workingDirectory: ${JSON.stringify(dir)}, env: env('answer', answer) })
const folder = { how: 'folder', cwd: vaultRoot }
out.vaultState = await probe(JSON.stringify({ basePath: vaultRoot, ready: true })).vaultState({ vaultRoot, route: folder })
out.vaultStateById = await probe(JSON.stringify({ basePath: vaultRoot, ready: true })).vaultState({ vaultRoot, route: { how: 'id', id: 'dddddddddddddddd' } })
out.vaultStateOther = await probe(JSON.stringify({ basePath: '/another/folder', ready: true })).vaultState({ vaultRoot, route: folder })
out.vaultStateIndexing = await probe(JSON.stringify({ basePath: vaultRoot, ready: false })).vaultState({ vaultRoot, route: folder })
out.vaultStateUnrouted = await probe(JSON.stringify({ basePath: vaultRoot, ready: true })).vaultState({ vaultRoot })
out.vaultStateAmbiguous = await probe(JSON.stringify({ basePath: vaultRoot, ready: true })).vaultState({ vaultRoot, route: { how: 'ambiguous' } })
process.stdout.write(JSON.stringify(out))`
  const run = childProcess.spawnSync(process.execPath, ['--input-type=module', '-e', child], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 120000, env: privateHomeEnv(dir) })
  assert.equal(run.status, 0, run.stderr)
  const out = JSON.parse(run.stdout)
  assert.deepEqual(out.list, { answered: true, vaults: { dddddddddddddddd: { path: vaultRoot, ts: 1, open: true } } })
  assert.deepEqual([out.listNoVault, out.listFailed, out.listNotAMap], [{ answered: false, reason: 'no-vault-open' }, { answered: false, reason: 'cli-failed' }, { answered: false, reason: 'no-value' }])
  assert.deepEqual([out.register, out.registerRefused], [{ answered: true, result: true }, { answered: true, result: 'folder not found' }])
  assert.deepEqual(out.registerHung, { answered: false, reason: 'cli-failed' })
  assert.ok(out.hungMs < 10000, 'a call that does not answer is killed at its timeout')
  assert.deepEqual([out.settings.ok, out.settings.code], [false, 'obsidian-settings-location-unknown'])
  assert.deepEqual(out.sandboxed, ['obsidian-sandboxed', 'obsidian-sandboxed'], 'a Flatpak build\'s list is neither read nor written where the native build keeps it')
  assert.deepEqual([out.vaultState, out.vaultStateById, out.vaultStateOther, out.vaultStateIndexing], [{ answered: true, indexReady: true }, { answered: true, indexReady: true }, { answered: false, indexReady: false }, { answered: true, indexReady: false }])
  assert.deepEqual([out.vaultStateUnrouted, out.vaultStateAmbiguous], [{ answered: false, indexReady: false }, { answered: false, indexReady: false }], 'without a route that reaches only this vault, nothing is asked')
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  // Three answered; the one that hangs may be killed before it logs anything.
  const registerCalls = calls.filter((call) => call.code.includes("'vault-open'"))
  assert.ok(registerCalls.length >= 3, `${registerCalls.length} calls`)
  for (const call of calls.filter((call) => !call.code.includes('app.vault.adapter.basePath'))) assert.deepEqual([call.cwd, call.first], [dir, 'eval'], 'calls about no vault run in the working directory they were given, naming none')
  const checks = calls.filter((call) => call.code.includes('app.vault.adapter.basePath')).map((call) => [call.cwd, call.first])
  assert.deepEqual(checks, [[vaultRoot, 'eval'], [dir, 'vault=dddddddddddddddd'], [vaultRoot, 'eval'], [vaultRoot, 'eval']], 'the vault check runs inside the vault\'s folder, or names the vault first; four checks, none without a route')
  // The path is never part of the code: it travels as base64 JSON, and only that literal differs between two paths.
  const [mine, other] = [registerCalls[0].code, registerCalls[1].code]
  assert.equal(mine.includes(vaultRoot) || mine.includes("it's") || mine.includes('${x}') || mine.includes('$(y)'), false)
  const literal = /atob\('([A-Za-z0-9+/=]+)'\)/
  assert.deepEqual(JSON.parse(Buffer.from(literal.exec(mine)[1], 'base64').toString('utf8')), { path: vaultRoot })
  assert.equal(mine.replace(literal, "atob('')"), other.replace(literal, "atob('')"))
  assert.match(mine, /sendSync\('vault-open',P\.path,false\)/, 'an existing folder is added, never created')
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

test('the service is started in the root directory, whichever directory the command runs in', async (t) => {
  const world = makeWorld(t)
  const seen = []
  const spawn = (command, args, options) => { seen.push(options?.cwd); return trackingSpawn(t)(command, args, options) }
  const seams = { ...UNREACHABLE_SEAMS, service: { entryPath: TEST_SERVICE_ENTRY, intervalMs: IDLE_INTERVAL, spawn } }
  const started = await world.run(['service', 'start', '--json', '--consent-actor', CONSENT.actor], { seams })
  assert.equal(started.json.service.state, 'healthy', JSON.stringify(started.json).slice(0, 300))
  assert.deepEqual(seen, [path.parse(fs.realpathSync(TEST_SERVICE_ENTRY)).root], 'never the project folder the command was run in')
  const record = readServiceRecord(world.workspace())
  const stopped = await world.run(['service', 'stop', '--json'], { seams })
  assert.equal(stopped.json.service.stopped, true)
  await waitFor(() => !isAlive(record.pid), { label: 'the stopped service to exit' })
})

// A copy of the test service entry: another file with other bytes, so to the lifecycle the entry of an earlier release.
// Its imports name the repository's modules by absolute URL.
function earlierEntry(dir) {
  const source = fs.readFileSync(TEST_SERVICE_ENTRY, 'utf8').replaceAll("'../../../src/", `'${pathToFileURL(path.join(REPOSITORY_ROOT, 'src')).href}/`)
  assert.ok(!source.includes("'../"), 'every import of the copy is absolute')
  const file = path.join(dir, 'earlier-service-entry.mjs')
  fs.writeFileSync(file, `${source}\n// the entry of an earlier release\n`)
  return file
}

test('open restarts the owned service when it runs another entry than the installed one, under the consent already recorded, and says so; the next open finds it current', async (t) => {
  const world = makeWorld(t)
  const spawn = trackingSpawn(t)
  const seams = (entryPath) => ({ ...UNREACHABLE_SEAMS, ...fakeApp(), service: { entryPath, intervalMs: IDLE_INTERVAL, spawn } })
  const started = await world.run(['service', 'start', '--json', '--consent-actor', 'first-actor'], { seams: seams(earlierEntry(world.dir)) })
  assert.equal(started.json.service.state, 'healthy', JSON.stringify(started.json).slice(0, 400))
  const before = readServiceRecord(world.workspace())
  const consent = readServiceSettings(world.workspace()).consent
  const opened = await world.run(openArgs(), { seams: seams(TEST_SERVICE_ENTRY), open: FAST_APP })
  const after = readServiceRecord(world.workspace())
  assert.deepEqual([opened.json.service?.restarted, opened.json.service?.runtimeId, opened.json.outcome], ['outdated', after.runtimeId, EXCHANGE_HERE ? 'current' : 'not-prepared'], JSON.stringify(opened.json).slice(0, 600))
  assert.notEqual(after.runtimeId, before.runtimeId)
  assert.equal(after.executable.digest, digest(fs.readFileSync(TEST_SERVICE_ENTRY)), 'the installed entry runs now')
  await waitFor(() => !isAlive(before.pid), { label: 'the earlier runtime to end' })
  assert.deepEqual(readServiceSettings(world.workspace()).consent, consent, 'under the consent already recorded, not the one open was given')
  const again = await world.run(openArgs(), { seams: seams(TEST_SERVICE_ENTRY), open: FAST_APP })
  assert.deepEqual([again.json.service?.restarted, again.json.service?.runtimeId], [undefined, after.runtimeId], 'nothing is restarted twice')
  const stopped = await world.run(['service', 'stop', '--json'], { seams: seams(TEST_SERVICE_ENTRY) })
  assert.equal(stopped.json.service.stopped, true)
  await waitFor(() => !isAlive(after.pid), { label: 'the stopped service to exit' })
})

// A stand-in for a runtime of this workspace, in a process of its own. Health and stop answer as a service's; a tick
// answers `{ ok, state: 'ticked', scopes: [] }` when the listener takes it. `mode`:
//   refuses-views     the listener of 0.2.0-alpha.11: a POST body has exactly one member, the runtime it is meant for,
//                     so a tick that names a view is refused (409);
//   current           the listener of now: a tick may name a view;
//   replaced-on-view  as current, but the first tick that names a view finds that another runtime took this one's
//                     place just before (this process stands for it): its record now names that runtime, and the
//                     request, aimed at the one before, is refused (409).
const STAND_IN_RUNTIME = `import http from 'node:http'
const [mode, port, first, bearer, identity, next, recordModule, workspaceRoot, workspaceId, nextRecord] = process.argv.slice(2)
let runtimeId = first
const send = (response, status, body) => { response.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' }); response.end(JSON.stringify(body)) }
const takes = (body) => body.runtimeId === runtimeId && Object.keys(body).every((key) => key === 'runtimeId' || (mode !== 'refuses-views' && key === 'scopeId'))
const server = http.createServer((request, response) => {
  let text = ''
  request.on('data', (chunk) => { text += chunk })
  request.on('end', async () => {
    if (request.method === 'GET' && request.url === '/health') return send(response, 200, { ...JSON.parse(identity), runtimeId, pid: process.pid })
    if (request.headers.authorization !== 'Bearer ' + bearer) return send(response, 401, { error: 'bearer-required' })
    let body = null
    try { body = JSON.parse(text) } catch { body = null }
    if (body === null || typeof body !== 'object') return send(response, 400, { error: 'request-invalid' })
    if (mode === 'replaced-on-view' && request.url === '/tick' && body.scopeId !== undefined && runtimeId === first) {
      runtimeId = next
      const { writeServiceRecord } = await import(recordModule)
      writeServiceRecord({ workspaceRoot, workspaceId, record: { ...JSON.parse(nextRecord), runtimeId: next, pid: process.pid } })
      return send(response, 409, { error: 'request-names-another-runtime' })
    }
    if (!takes(body)) return send(response, 409, { error: 'request-names-another-runtime' })
    if (request.url === '/tick') return send(response, 200, { ok: true, state: 'ticked', scopes: [] })
    if (request.url === '/stop') { send(response, 202, { runtimeId, pid: process.pid }); server.close(); setTimeout(() => process.exit(0), 20); return }
    send(response, 404, { error: 'unknown-operation' })
  })
})
server.listen(Number(port), '127.0.0.1')
`

test('`plugin on` with the installed entry to start replaces a service of an earlier release before its tick, under the consent already recorded, and the view is published with the plugin', async (t) => {
  const world = makeWorld(t)
  const spawn = trackingSpawn(t)
  const seams = (entryPath) => ({ ...UNREACHABLE_SEAMS, service: { entryPath, intervalMs: IDLE_INTERVAL, spawn } })
  const started = await world.run(['service', 'start', '--json', '--consent-actor', 'first-actor'], { seams: seams(earlierEntry(world.dir)) })
  assert.equal(started.json.service.state, 'healthy', JSON.stringify(started.json).slice(0, 400))
  const before = readServiceRecord(world.workspace())
  const consent = readServiceSettings(world.workspace()).consent
  const on = await world.run(['plugin', 'on', '--json', '--scope', FULL_SCOPE.scopeId], { seams: seams(TEST_SERVICE_ENTRY) })
  const after = readServiceRecord(world.workspace())
  assert.deepEqual([on.exit, on.json.choice.state, on.json.service.restarted, on.json.takesEffect], [0, 'requested', 'outdated', EXCHANGE_HERE ? 'published' : 'next-publication'], JSON.stringify(on.json).slice(0, 600))
  assert.notEqual(after.runtimeId, before.runtimeId)
  assert.equal(after.executable.digest, digest(fs.readFileSync(TEST_SERVICE_ENTRY)), 'the installed entry runs now')
  assert.deepEqual(readServiceSettings(world.workspace()).consent, consent, 'under the consent already recorded')
  await waitFor(() => !isAlive(before.pid), { label: 'the earlier runtime to end' })
  if (EXCHANGE_HERE) assert.ok(fs.existsSync(path.join(world.vault(), '.obsidian', 'plugins', 'atelier-projection', 'main.js')), 'the plugin is in the vault')
  const stopped = await world.run(['service', 'stop', '--json'], { seams: seams(TEST_SERVICE_ENTRY) })
  assert.equal(stopped.json.service.stopped, true)
  await waitFor(() => !isAlive(after.pid), { label: 'the stopped service to exit' })
})

// The release a record names: this package's by default (`releaseIdentity`, where it exists), or the one given.
const currentRelease = () => (typeof releaseIdentity === 'function' ? releaseIdentity() : undefined)

// Starts a stand-in runtime of `world`'s workspace that proves itself ours: service settings, the record, the process,
// and health. Its record names the installed test entry and `release` (none when undefined), or `ext` as given.
async function standInRuntime(t, world, { mode, release = currentRelease(), ext = release === undefined ? undefined : { release }, next = 'rt-replacing-runtime' }) {
  const port = await freePort()
  const consent = { grantedAt: iso(START), actor: 'first-actor', coverage: 'service' }
  writeServiceSettings({ ...world.workspace(), settings: { schema: 'atelier-obsidian-service-settings/v1', workspaceId: WORKSPACE_ID, host: '127.0.0.1', port, consent, updatedAt: iso(START) } })
  const runtimeId = 'rt-stand-in'
  const bearer = randomBytes(32).toString('base64url')
  const installed = { path: fs.realpathSync(TEST_SERVICE_ENTRY), digest: digest(fs.readFileSync(TEST_SERVICE_ENTRY)) }
  const record = {
    schema: 'atelier-obsidian-service-state/v1', contractVersion: '1.0.0', workspaceId: WORKSPACE_ID, serviceName: serviceNameFor(WORKSPACE_ID), host: '127.0.0.1', port, runtimeId,
    executable: { ...installed, ...(ext === undefined ? {} : { ext }) }, stateLocation: path.join(world.workspaceRoot(), 'state'), health: { status: 'healthy', checkedAt: iso(START) }, consent, ext: { bearer },
  }
  const script = path.join(world.dir, `stand-in-${mode}.mjs`)
  fs.writeFileSync(script, STAND_IN_RUNTIME)
  const identity = { schema: HEALTH_SCHEMA, serviceName: serviceNameFor(WORKSPACE_ID), workspaceId: WORKSPACE_ID, host: '127.0.0.1', port, executableDigest: installed.digest, startedAt: iso(START), status: 'running' }
  const recordModule = pathToFileURL(path.join(REPOSITORY_ROOT, 'src/runtime/obsidian/service-record.mjs')).href
  const child = trackingSpawn(t)(process.execPath, [script, mode, String(port), runtimeId, bearer, JSON.stringify(identity), next, recordModule, world.workspaceRoot(), WORKSPACE_ID, JSON.stringify(record)], { stdio: 'ignore', windowsHide: true })
  writeServiceRecord({ ...world.workspace(), record: { ...record, pid: child.pid } })
  await waitFor(async () => (await probeHealth({ host: '127.0.0.1', port, timeoutMs: 1000 })).kind === 'health', { label: 'the stand-in runtime to listen' })
  return { child, runtimeId, consent, port }
}

const stopWhateverRuns = async (world, seams) => {
  const record = readServiceRecord(world.workspace())
  const stopped = await world.run(['service', 'stop', '--json'], { seams })
  assert.equal(stopped.json.service.stopped, true, JSON.stringify(stopped.json).slice(0, 300))
  if (record) await waitFor(() => !isAlive(record.pid), { label: 'the stopped service to exit' })
}

test('open restarts an owned service of an earlier release that refuses a tick naming a view, and says so; without the installed entry to start, such a service is only reported', async (t) => {
  const world = makeWorld(t)
  // Its record names this release: only the refused tick tells it apart.
  const earlier = await standInRuntime(t, world, { mode: 'refuses-views' })
  const lifecycle = { loadProject: world.loadProject, dataRoot: world.dataRoot, env: world.env, probeTimeoutMs: FAST_PROBE }
  assert.equal((await serviceStatus(lifecycle)).state, 'healthy', 'it proves itself ours')
  const reported = await requestServiceTick({ ...lifecycle, scopeId: FULL_SCOPE.scopeId })
  assert.deepEqual([reported.requested, reported.tick, reported.reason, isAlive(earlier.child.pid)], [true, null, 'service-outdated', true])
  const seams = { ...UNREACHABLE_SEAMS, ...fakeApp(), service: { entryPath: TEST_SERVICE_ENTRY, intervalMs: IDLE_INTERVAL, spawn: trackingSpawn(t) } }
  const opened = await world.run(['open', '--consent-actor', CONSENT.actor], { seams, open: FAST_APP })
  // The lines of an answer that is not success go to stderr: `not-prepared` where no atomic exchange exists.
  const shown = `${opened.stdout}\n${opened.stderr}`
  assert.ok(shown.split('\n').includes('service: restarted (outdated)'), shown)
  await waitFor(() => !isAlive(earlier.child.pid), { label: 'the earlier runtime to end' })
  assert.notEqual(readServiceRecord(world.workspace()).runtimeId, earlier.runtimeId)
  assert.deepEqual(readServiceSettings(world.workspace()).consent, earlier.consent, 'under the consent already recorded')
  await stopWhateverRuns(world, seams)
})

test('a service whose entry module is the installed one but whose release is another (other modules changed) is replaced by the next open', async (t) => {
  const world = makeWorld(t)
  // The listener of now takes the view; only the recorded release differs from this package's.
  const older = await standInRuntime(t, world, { mode: 'current', release: { version: currentRelease()?.version ?? '0.0.0', digest: `sha256:${'0'.repeat(64)}` } })
  const seams = { ...UNREACHABLE_SEAMS, ...fakeApp(), service: { entryPath: TEST_SERVICE_ENTRY, intervalMs: IDLE_INTERVAL, spawn: trackingSpawn(t) } }
  const opened = await world.run(openArgs(), { seams, open: FAST_APP })
  assert.equal(opened.json.service?.restarted, 'outdated', JSON.stringify(opened.json).slice(0, 500))
  await waitFor(() => !isAlive(older.child.pid), { label: 'the older runtime to end' })
  const record = readServiceRecord(world.workspace())
  assert.deepEqual(record.executable.ext?.release, releaseIdentity(), 'the runtime started in its place records this release')
  // Opened again, it is this release: nothing is replaced.
  const again = await world.run(openArgs(), { seams, open: FAST_APP })
  assert.deepEqual([again.json.service?.restarted, again.json.service?.runtimeId], [undefined, record.runtimeId])
  await stopWhateverRuns(world, seams)
})

test('which runtime the installed release replaces: an earlier version, this version with another entry module or other modules, or one that records no release; never a later version, nor one that cannot be ordered', () => {
  const release = (version, digest = `sha256:${'a'.repeat(64)}`) => ({ version, digest })
  const other = `sha256:${'0'.repeat(64)}`
  const installed = { entry: `sha256:${'e'.repeat(64)}`, release: release('0.2.0-alpha.12') }
  const recording = (ext, digest = installed.entry) => ({ path: '/installed/service-main.mjs', digest, ...(ext === undefined ? {} : { ext }) })
  const standing = (executable) => releaseStanding(executable, installed)
  assert.equal(standing(recording({ runner: '/node', release: installed.release })), 'current')
  // What 0.2.0-alpha.11 and earlier record (no release; no ext at all), earlier versions (a prerelease number is a
  // number: alpha.9 is before alpha.12), and this version with other content.
  const outdated = [
    recording({ runner: '/node' }), recording(undefined), recording({ release: release('0.2.0-alpha.11', installed.release.digest) }), recording({ release: release('0.2.0-alpha.9') }),
    recording({ release: release('0.1.9') }), recording({ release: release('0.2.0-alpha.12', other) }), recording({ release: installed.release }, other),
  ]
  assert.deepEqual(outdated.map(standing), outdated.map(() => 'outdated'))
  // A later version, whatever its content, or one that cannot be ordered: never replaced by this release.
  const later = [
    recording({ release: release('0.2.0-alpha.13', installed.release.digest) }), recording({ release: release('0.2.0') }), recording({ release: release('0.3.0-alpha.1') }, other),
    recording({ release: release('not a version') }), recording({ release: {} }), recording({ release: 'x' }),
  ]
  assert.deepEqual(later.map(standing), later.map(() => 'later'))
})

test('a version that cannot be ordered, the same on both sides (a fork\'s "dev", say), is compared by content: the runtime open just started is current, and other content is outdated, so "service stop, then open" never loops', () => {
  const content = `sha256:${'a'.repeat(64)}`
  const other = `sha256:${'0'.repeat(64)}`
  const entry = `sha256:${'e'.repeat(64)}`
  for (const version of ['dev', 'not a version']) {
    const installed = { entry, release: { version, digest: content } }
    const recording = (release, digest = entry) => ({ path: '/installed/service-main.mjs', digest, ext: { runner: '/node', release } })
    assert.equal(releaseStanding(recording({ version, digest: content }), installed), 'current', version)
    assert.equal(releaseStanding(recording({ version, digest: other }), installed), 'outdated', version)
    assert.equal(releaseStanding(recording({ version, digest: content }, other), installed), 'outdated', version)
    // Another version string that cannot be ordered against this one stays a release of its own.
    assert.equal(releaseStanding(recording({ version: '0.2.0-alpha.12', digest: content }), installed), 'later', version)
  }
})

test('a service of a later release than the installed one is neither replaced nor asked by open, which answers service-other-release with its next step; stopped, the next open starts the installed release', async (t) => {
  const world = makeWorld(t)
  const later = await standInRuntime(t, world, { mode: 'current', release: { version: '999.0.0', digest: `sha256:${'0'.repeat(64)}` } })
  const seams = { ...UNREACHABLE_SEAMS, ...fakeApp(), service: { entryPath: TEST_SERVICE_ENTRY, intervalMs: IDLE_INTERVAL, spawn: trackingSpawn(t) } }
  const opened = await world.run(openArgs(), { seams, open: FAST_APP })
  assert.deepEqual([opened.json.outcome, opened.json.reason, opened.json.service?.restarted, opened.json.service?.runtimeId], ['service-unavailable', 'service-other-release', undefined, later.runtimeId], JSON.stringify(opened.json).slice(0, 500))
  assert.equal(opened.json.next, REASON_NEXT['service-other-release'])
  assert.match(opened.json.next, /atelier obsidian service stop`, then open again/)
  assert.deepEqual([isAlive(later.child.pid), readServiceRecord(world.workspace()).runtimeId], [true, later.runtimeId], 'the later runtime still runs, under its own record')
  // The next step: stopped, the next open starts this release.
  await stopWhateverRuns(world, seams)
  const again = await world.run(openArgs(), { seams, open: FAST_APP })
  assert.notEqual(again.json.reason, 'service-other-release', JSON.stringify(again.json).slice(0, 500))
  assert.deepEqual(readServiceRecord(world.workspace()).executable.ext?.release, releaseIdentity())
  await stopWhateverRuns(world, seams)
})

test('a service whose record names the installed entry module and no release, as 0.2.0-alpha.11 records it, is replaced by the next open', async (t) => {
  const world = makeWorld(t)
  const earlier = await standInRuntime(t, world, { mode: 'current', ext: { runner: process.execPath } })
  const seams = { ...UNREACHABLE_SEAMS, ...fakeApp(), service: { entryPath: TEST_SERVICE_ENTRY, intervalMs: IDLE_INTERVAL, spawn: trackingSpawn(t) } }
  const opened = await world.run(openArgs(), { seams, open: FAST_APP })
  assert.equal(opened.json.service?.restarted, 'outdated', JSON.stringify(opened.json).slice(0, 500))
  await waitFor(() => !isAlive(earlier.child.pid), { label: 'the earlier runtime to end' })
  assert.deepEqual(readServiceRecord(world.workspace()).executable.ext?.release, releaseIdentity())
  await stopWhateverRuns(world, seams)
})

test('a tick refused because another runtime took the service\'s place just before is asked of that runtime; nothing is stopped or restarted', async (t) => {
  const world = makeWorld(t)
  const replaced = await standInRuntime(t, world, { mode: 'replaced-on-view' })
  const lifecycle = { loadProject: world.loadProject, dataRoot: world.dataRoot, env: world.env, probeTimeoutMs: FAST_PROBE }
  const service = { entryPath: TEST_SERVICE_ENTRY, intervalMs: IDLE_INTERVAL, spawn: trackingSpawn(t) }
  const asked = await requestServiceTick({ ...lifecycle, scopeId: FULL_SCOPE.scopeId, service })
  assert.deepEqual([asked.requested, asked.reason, asked.runtimeId, asked.restarted, asked.tick?.state], [true, 'tick-ran', 'rt-replacing-runtime', undefined, 'ticked'], JSON.stringify(asked))
  assert.equal(isAlive(replaced.child.pid), true, 'the runtime that took its place still runs')
  await stopWhateverRuns(world, { ...UNREACHABLE_SEAMS, service })
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
  // The real entry with the obsidian-cli adapter reaches a running Obsidian
  // through the command-line tool's socket under HOME: the child gets a
  // private HOME, so the developer's own Obsidian is never contacted.
  const env = privateHomeEnv(world.dir, world.env)
  const entryPath = path.join(REPOSITORY_ROOT, 'src', 'runtime', 'obsidian', 'service-main.mjs')
  const seams = { ...UNREACHABLE_SEAMS, ...fakeApp(), service: { entryPath, entryArgs: ['--adapter=obsidian-cli'], intervalMs: IDLE_INTERVAL, spawn: trackingSpawn(t) } }
  const started = await world.run(['service', 'start', '--json', '--consent-actor', CONSENT.actor], { seams, startTimeoutMs: 20000, env })
  assert.deepEqual([started.exit, started.json.service.state, started.json.service.started], [EXIT.ok, 'healthy', true], JSON.stringify(started.json).slice(0, 600))
  const status = await world.run(['service', 'status', '--json'], { seams, env })
  assert.equal(status.json.service.state, 'healthy')
  const stop = await world.run(['service', 'stop', '--json'], { seams, env })
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

test('a publisher refusal for an app without this vault open advises open, which adds the vault, or quitting the app; after open it advises quitting', () => {
  for (const afterOpen of [false, true]) {
    const next = nextStep('publisher-conflict', 'editor-uncoordinated', { afterOpen })
    assert.match(next, /quit Obsidian/)
    assert.doesNotMatch(next, /other publisher/)
    for (const reason of ['publication-in-progress', 'generation-mismatch', 'state-mismatch']) {
      assert.equal(nextStep('publisher-conflict', reason, { afterOpen }), OPENING_OUTCOMES['publisher-conflict'].next, `${reason} is another publisher or a changed state, and keeps its advice`)
    }
  }
  assert.equal(nextStep('publisher-conflict', 'editor-uncoordinated'), REASON_NEXT['editor-uncoordinated'])
  assert.match(REASON_NEXT['editor-uncoordinated'], /`atelier obsidian open` adds this view's vault to Obsidian and publishes through it/)
  assert.doesNotMatch(nextStep('publisher-conflict', 'editor-uncoordinated', { afterOpen: true }), /`atelier obsidian open` adds/, 'open does not advise itself')
  // The reason has several causes (another vault open, a command line that did not answer, an unknown process table,
  // an app started during a publication with the app closed): the text names none of them as the cause, stops short
  // of claiming nothing was written, and names what clears every one of them.
  for (const next of [REASON_NEXT['editor-uncoordinated'], nextStep('publisher-conflict', 'editor-uncoordinated', { afterOpen: true })]) {
    assert.doesNotMatch(next, /without (this|the|that) vault|nothing (is|was) written/)
    assert.match(next, /may hold this vault could not be coordinated with/)
    assert.match(next, /on Linux, also any app that runs on a system Electron/)
  }
  // No step is a manual one: nothing asks a person to open a vault folder by hand.
  for (const text of [...Object.values(REASON_NEXT), ...Object.values(OPENING_OUTCOMES).map((entry) => entry.next)]) assert.doesNotMatch(text, /by hand/)
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
