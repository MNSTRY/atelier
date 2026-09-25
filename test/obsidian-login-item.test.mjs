import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// 0. The guards, installed before anything else is imported.
//
// Nothing in this file may start a service manager, an operating-system
// opener, the installed app or its command-line tool: an attempt throws here
// instead of running. Nothing may write, rename, remove or open anything in
// this account's real LaunchAgents folder, its systemd user folder or
// Obsidian's own settings folder: an attempt throws here too. Every login item
// below is installed into a temporary folder by a stand-in for the service
// manager that never runs launchctl or systemctl, and the production manager
// is only ever reached in a child process that it refuses.
// ---------------------------------------------------------------------------

const BANNED_PROGRAMS = ['obsidian-cli', 'obsidian', 'open', 'xdg-open', 'launchctl', 'systemctl', 'osascript']
const WRAPPERS = ['sh', 'bash', 'zsh', 'dash', 'env', 'cmd', 'powershell', 'pwsh', 'nohup', 'sudo']
// A child that could reach the session's own service manager or app: it must run under a private HOME.
const REACHES_THE_SESSION = /--adapter=obsidian-cli|app-production-seams|service-manager-production/
const REAL_HOMES = [os.homedir(), process.env.HOME].filter((home) => typeof home === 'string' && home !== '').map((home) => path.resolve(home))
const PROTECTED = [...new Set(REAL_HOMES.flatMap((home) => [
  path.join(home, 'Library', 'LaunchAgents'), path.join(home, '.config', 'systemd'), path.join(home, 'Library', 'Application Support', 'obsidian'), path.join(home, '.config', 'obsidian'),
]).concat(typeof process.env.XDG_CONFIG_HOME === 'string' && process.env.XDG_CONFIG_HOME !== '' ? [path.join(process.env.XDG_CONFIG_HOME, 'systemd'), path.join(process.env.XDG_CONFIG_HOME, 'obsidian')] : []))]
const programName = (command) => path.basename(String(command).replaceAll('\\', '/')).toLowerCase().replace(/\.(exe|app|cmd|bat)$/, '')
const guardErrors = []
function guardSpawn(command, args, options) {
  const words = [command, ...(Array.isArray(args) ? args : [])].map(String)
  const wrapper = WRAPPERS.includes(programName(command))
  const banned = words.find((word, index) => ((index === 0 || wrapper) && BANNED_PROGRAMS.includes(programName(word))) || /obsidian:\/\//i.test(word))
  if (banned !== undefined) {
    const error = new Error(`spawn guard: this test suite may never start "${programName(banned)}"`)
    guardErrors.push(error.message)
    throw error
  }
  const home = (options?.env ?? process.env).HOME
  if (words.some((word) => REACHES_THE_SESSION.test(word)) && (typeof home !== 'string' || home === '' || REAL_HOMES.includes(path.resolve(home)))) {
    const error = new Error('spawn guard: a child that can reach the session\'s service manager or app needs a private HOME, never the developer\'s own')
    guardErrors.push(error.message)
    throw error
  }
}
for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
  const original = childProcess[method]
  childProcess[method] = function guarded(command, args, ...rest) {
    if (method === 'exec' || method === 'execSync') guardSpawn('sh', String(command).split(/\s+/), args)
    else guardSpawn(command, args, Array.isArray(args) ? rest[0] : args)
    return original.call(this, command, args, ...rest)
  }
}
const protectedTarget = (target) => {
  if (typeof target !== 'string' && !(target instanceof URL)) return null
  const resolved = path.resolve(target instanceof URL ? fileURLToPath(target) : target)
  return PROTECTED.find((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`)) ?? null
}
function guardPaths(name, ...targets) {
  const hit = targets.map(protectedTarget).find((root) => root !== null)
  if (hit === undefined) return
  const error = new Error(`fs guard: ${name} may never touch ${hit}`)
  guardErrors.push(error.message)
  throw error
}
for (const [name, arity] of [['writeFileSync', 1], ['appendFileSync', 1], ['mkdirSync', 1], ['renameSync', 2], ['unlinkSync', 1], ['rmSync', 1], ['rmdirSync', 1], ['openSync', 1], ['symlinkSync', 2], ['linkSync', 2], ['copyFileSync', 2], ['chmodSync', 1], ['utimesSync', 1]]) {
  const original = fs[name]
  fs[name] = function guarded(...args) {
    guardPaths(name, ...args.slice(0, arity))
    return original.apply(this, args)
  }
}
syncBuiltinESMExports()

const { resolveProjectConfig, writeJson } = await import('../src/project/config.mjs')
const { createEditorAdapter } = await import('../src/projection/obsidian/publication/index.mjs')
const { EXIT, runObsidianCommand } = await import('../src/commands/obsidian.mjs')
const { readServiceStatusDocument, serviceStatus, startService, stopService } = await import('../src/runtime/obsidian/lifecycle.mjs')
const { defaultMachineSettings, ensureWorkspaceIdentity, protectedRoots, workspaceStateRoot, writeMachineSettings } = await import('../src/runtime/obsidian/machine-settings.mjs')
const { commandLineNamesRecord, processRunsRecordedExecutable } = await import('../src/runtime/obsidian/process-identity.mjs')
const { SERVICE_ENTRY_PATH } = await import('../src/runtime/obsidian/service-entry-path.mjs')
const { readServiceRecord, readServiceSettings, servicePaths, writeServiceSettings } = await import('../src/runtime/obsidian/service-record.mjs')
const { runMaintenanceService } = await import('../src/runtime/obsidian/service.mjs')
const { buildStartupAdapter } = await import('../src/runtime/obsidian/startup-adapters.mjs')

// What this change adds is loaded inside each test, so a module that does not exist yet fails the tests that need it
// and no other.
const managers = () => import('../src/runtime/obsidian/service-managers.mjs')
const loginItems = () => import('../src/runtime/obsidian/login-item.mjs')
const releases = () => import('../src/runtime/obsidian/release-watch.mjs')
const startupAdapters = () => import('../src/runtime/obsidian/startup-adapters.mjs')
const records = () => import('../src/runtime/obsidian/service-record.mjs')

// A login item on macOS and Linux, and what each part of it does, on a real filesystem in temporary directories.
// Invented, synthetic content only. Services are children of the test entry under test/support/obsidian-maintenance/,
// whose editor adapter reports that no app runs; each is started either by `start` or by the stand-in for launchd
// below, exactly as launchd would start it from the unit it was given. Every process is followed and ended in
// teardown, and the last test asserts that none is left.

const TMP = fs.realpathSync(os.tmpdir())
const REPOSITORY_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const TEST_SERVICE_ENTRY = path.join(REPOSITORY_ROOT, 'test', 'support', 'obsidian-maintenance', 'service-entry.mjs')
const EXT = 'mnstry.atelier.obsidian'
const WORKSPACE_ID = `ws-${'07'.repeat(12)}`
const START = Date.parse('2026-01-05T10:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()
const fixedRandom = (size) => Buffer.alloc(size, 7)
const sha256 = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })
const CONSENT_ACTOR = 'test-suite'
const FAST_PROBE = 1500
const IDLE_INTERVAL = 60 * 60 * 1000
// The units name POSIX paths, and a login item is offered on macOS and Linux only.
const POSIX_HERE = process.platform !== 'win32'
const needsPosix = POSIX_HERE ? {} : { skip: 'a login item is offered on macOS and Linux, and its unit names POSIX paths, which this host has none of' }

// ---------------------------------------------------------------------------
// Processes, followed by their handles and ended in teardown
// ---------------------------------------------------------------------------

const SPAWNED = []
const isAlive = (pid) => { try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' } }
function follow(t, child, how) {
  const entry = { pid: child.pid, child, how, test: t.name, gone: child.pid === undefined }
  child.once('exit', () => { entry.gone = true })
  SPAWNED.push(entry)
  t.after(() => endChild(entry))
  return child
}
async function endChild(entry) {
  if (entry.gone || entry.child.exitCode !== null || entry.child.signalCode !== null) { entry.gone = true; return }
  const exited = new Promise((resolve) => { entry.child.once('exit', resolve) })
  entry.child.kill('SIGKILL')
  await Promise.race([exited, sleep(10000)])
}
const followingSpawn = (t) => (...args) => follow(t, childProcess.spawn(...args), 'spawned by startService')
const forbiddenSpawn = () => { throw new Error('startService started a child beside the login item') }

async function waitFor(check, { timeoutMs = 20000, everyMs = 25, label = 'condition' } = {}) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`)
    await sleep(everyMs)
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => { const { port } = server.address(); server.close(() => resolve(port)) })
  })
}

function listing(directory) {
  const found = {}
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : 1))) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) { found[`${path.relative(directory, absolute)}/`] = 'directory'; walk(absolute) } else found[path.relative(directory, absolute)] = sha256(fs.readFileSync(absolute))
    }
  }
  if (fs.existsSync(directory)) walk(directory)
  return found
}

// ---------------------------------------------------------------------------
// A stand-in for launchd
// ---------------------------------------------------------------------------

const unxml = (value) => value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&')
// The members of a unit this file writes that launchd acts on.
function readPlist(text) {
  const string = (key) => { const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(text); return match === null ? null : unxml(match[1]) }
  const words = [...(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? '').matchAll(/<string>([^<]*)<\/string>/g)].map((match) => unxml(match[1]))
  const searchPath = /<key>EnvironmentVariables<\/key>\s*<dict>\s*<key>PATH<\/key>\s*<string>([^<]*)<\/string>/.exec(text)?.[1]
  return { label: string('Label'), words, cwd: string('WorkingDirectory') ?? '/', searchPath: searchPath === undefined ? null : unxml(searchPath), keepAliveOnFailure: /<key>SuccessfulExit<\/key>\s*<false\/>/.test(text), runAtLoad: /<key>RunAtLoad<\/key>\s*<true\/>/.test(text) }
}

// launchctl as launchd answers it, for the production launchd manager's own code: units are read from the files the
// manager wrote into a temporary LaunchAgents folder, a loaded unit's ProgramArguments are run here with its working
// directory and search path, and a unit whose process exits with anything but 0 is started again (KeepAlive with
// SuccessfulExit false), one that exits 0 is not. `disable(label)` stands for the person switching it off in System
// Settings. launchctl itself is never run.
async function fakeLaunchd(t, { home, env }) {
  const { createLaunchdManager } = await managers()
  const directory = path.join(home, 'Library', 'LaunchAgents')
  const jobs = new Map()
  const disabled = new Set()
  const calls = []
  const answer = (status, stdout = '', stderr = '') => ({ status, stdout, stderr })
  const labelOf = (target) => String(target).split('/').slice(2).join('/')
  function launch(job) {
    const [program, ...args] = job.words
    const child = follow(t, childProcess.spawn(program, args, { cwd: job.cwd, env: { ...env, ...(job.searchPath === null ? {} : { PATH: job.searchPath }) }, stdio: 'ignore', windowsHide: true }), `started by the stand-in for launchd: ${job.label}`)
    job.child = child
    job.runs += 1
    child.once('exit', (code, signal) => {
      job.exits.push(code ?? signal)
      job.child = null
      if (job.loaded && !job.stopping && job.keepAliveOnFailure && code !== 0) launch(job)
    })
  }
  async function unload(job) {
    job.stopping = true
    job.loaded = false
    if (job.child !== null) {
      const exited = new Promise((resolve) => { job.child.once('exit', resolve) })
      job.child.kill('SIGTERM')
      await Promise.race([exited, sleep(20000)])
    }
  }
  const run = async (program, args) => {
    calls.push(args.join(' '))
    assert.equal(program, '/bin/launchctl', 'the manager runs launchctl by its absolute path')
    const [verb, ...rest] = args
    if (verb === 'bootstrap') {
      const [domain, file] = rest
      assert.equal(domain, 'gui/501')
      const unit = readPlist(fs.readFileSync(file, 'utf8'))
      if (jobs.get(unit.label)?.loaded) return answer(5, '', 'Bootstrap failed: 5: Input/output error')
      if (disabled.has(unit.label)) return answer(5, '', 'Bootstrap failed: 5: Input/output error')
      const job = { ...unit, file, loaded: true, stopping: false, runs: 0, exits: [], child: null }
      jobs.set(unit.label, job)
      if (job.runAtLoad) launch(job)
      return answer(0)
    }
    const job = jobs.get(labelOf(rest.at(-1)))
    if (verb === 'bootout') {
      if (!job?.loaded) return answer(3, '', 'Boot-out failed: 3: No such process')
      await unload(job)
      return answer(0)
    }
    if (verb === 'kickstart') {
      assert.equal(rest[0], '-p')
      if (!job?.loaded) return answer(113, '', `Could not find service "${labelOf(rest.at(-1))}" in domain for user gui: 501`)
      if (job.child === null) { job.stopping = false; launch(job) }
      return answer(0, `${job.child.pid}\n`)
    }
    if (verb === 'print') {
      if (!job?.loaded) return answer(113, '', `Could not find service "${labelOf(rest.at(-1))}" in domain for user gui: 501`)
      return answer(0, `gui/501/${job.label} = {\n\tactive count = ${job.child ? 1 : 0}\n\tpath = ${job.file}\n\ttype = LaunchAgent\n\tstate = ${job.child ? 'running' : 'not running'}\n\n${job.child ? `\tpid = ${job.child.pid}\n` : ''}\tlast exit code = ${job.exits.length === 0 ? '(never exited)' : job.exits.at(-1)}\n}\n`)
    }
    if (verb === 'print-disabled') return answer(0, `disabled services = {\n${[...disabled].map((label) => `\t"${label}" => disabled\n`).join('')}\t"com.example.unrelated" => enabled\n}\n`)
    return answer(64, '', `Unrecognized subcommand: ${verb}`)
  }
  const manager = createLaunchdManager({ run, uid: 501, directory, pollMs: 10 })
  return {
    manager, jobs, calls, directory,
    async unloadAll() { for (const job of jobs.values()) await unload(job) },
    job: (label) => jobs.get(label) ?? null,
    disable(label) { disabled.add(label) },
    // The person, or anybody, unloading it behind Atelier's back.
    async bootoutBehindTheBack(label) { const job = jobs.get(label); if (job) await unload(job) },
  }
}

// A `run` that records every call and answers from a table (`args joined by spaces` -> answer), 0 otherwise.
function recordingRun(answers = {}) {
  const calls = []
  const run = async (program, args) => {
    calls.push([program, ...args].join(' '))
    const answer = typeof answers === 'function' ? answers(program, args) : answers[args.join(' ')]
    return { status: 0, stdout: '', stderr: '', ...(answer ?? {}) }
  }
  return { run, calls }
}

// ---------------------------------------------------------------------------
// A project, a data root, a private HOME, and the command run in this process
// ---------------------------------------------------------------------------

const note = ({ id, title, body }) => `---\ntitle: "${title}"\nkg:\n  id: "${id}"\n  type: "document"\n  status: "active"\n  audience: "team"\n---\n\n# ${title}\n\n${body}\n`
const FILES = {
  'east-wing/notes/lantern.md': note({ id: 'east-wing:lantern', title: 'Lantern room', body: 'The lamp turns once a minute.' }),
  'west-wing/logs/tide.md': note({ id: 'west-wing:tide', title: 'Tide log', body: 'High water at noon.' }),
}
const REPOSITORIES = ['east-wing', 'west-wing']
const FULL_SCOPE = { scopeId: 'scope-whole', mode: 'full', selector: { all: true } }
const projectDocument = (name) => ({
  schema: 'mnstry.atelier-project-config@v1', name, roots: { workspace: '.', repoOps: '.' },
  graph: { repoAccessPath: 'repo-access.v1.json', outputPath: 'atelier-output/knowledge.graph.json' },
  projection: { outputRoot: 'atelier-output', readinessPath: 'atelier-output/atelier-readiness.json' },
  repos: REPOSITORIES.map((repo) => ({ name: repo, path: repo, readBoundary: 'team' })),
  ext: { [EXT]: { schema: 'atelier-obsidian-ext-settings/v1', enabled: true, scopes: [FULL_SCOPE] } },
})

// Nothing that app seams answer is ever needed here, except that no app is installed.
const unreachable = (name) => () => { throw new Error(`the ${name} was reached`) }
const NO_APP = Object.freeze({
  appProbe: { inspect: async () => ({ installed: false, cli: false, running: false, version: null }), vaultState: unreachable('app probe') },
  launcher: { open: unreachable('launcher') },
  registry: { listThroughApp: unreachable('app registry'), registerThroughApp: unreachable('app registry'), readSettings: unreachable('app registry'), registerInSettings: unreachable('app registry') },
})

// Whether a login item can name the test entry here: it is refused from a temporary folder, as an npx cache would be.
let ENTRY_IS_STABLE = null
async function entryIsStable() {
  if (ENTRY_IS_STABLE === null) {
    let roots = [TMP]
    try { roots = (await loginItems()).temporaryRoots() } catch { /* a tree without login items: its tests fail on their own */ }
    ENTRY_IS_STABLE = !roots.some((root) => TEST_SERVICE_ENTRY.startsWith(`${root}${path.sep}`))
  }
  return ENTRY_IS_STABLE
}

// `withLaunchd: false` for a test of the service alone, which needs no service manager.
async function makeWorld(t, { name = 'Harbor Notes', entryArgs = [`--interval-ms=${IDLE_INTERVAL}`], withLaunchd = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(TMP, 'atelier-login-item-')))
  // One hook, in this order: the units' processes, every other process of this test, then the folder.
  let launchd = null
  t.after(async () => {
    if (launchd !== null) await launchd.unloadAll()
    for (const entry of SPAWNED.filter((item) => item.test === t.name)) await endChild(entry)
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })
  const projectDir = path.join(dir, 'harbor-notes')
  const dataRoot = path.join(dir, 'data')
  const home = path.join(dir, 'home')
  fs.mkdirSync(home, { recursive: true })
  for (const [relative, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(projectDir, relative)), { recursive: true })
    fs.writeFileSync(path.join(projectDir, relative), content)
  }
  for (const repo of REPOSITORIES) fs.mkdirSync(path.join(projectDir, repo, '.git'), { recursive: true })
  const configPath = path.join(projectDir, 'atelier.project.json')
  writeJson(configPath, projectDocument(name))
  writeJson(path.join(projectDir, 'repo-access.v1.json'), { schema: 'mnstry.atelier-repo-access@v1', defaultReadBoundary: 'team', repos: Object.fromEntries(REPOSITORIES.map((repo) => [repo, { readBoundary: 'team' }])) })
  const { MNSTRY_ATELIER_PROJECT_CONFIG: _config, MNSTRY_ATELIER_LOCAL_CONFIG: _overlay, XDG_CONFIG_HOME: _xdg, ...inherited } = process.env
  const env = { ...inherited, HOME: home }
  const loadProject = () => resolveProjectConfig({ argv: [`--project=${configPath}`], cwd: projectDir, env, writeLocalState: false })
  const project = loadProject()
  ensureWorkspaceIdentity({ project, randomBytes: fixedRandom })
  const workspaceRoot = workspaceStateRoot(dataRoot, WORKSPACE_ID)
  writeMachineSettings({ workspaceRoot, workspaceId: WORKSPACE_ID, repositoryRoots: protectedRoots(project), settings: { ...defaultMachineSettings({ workspaceId: WORKSPACE_ID, updatedAt: iso(START) }), audienceAllow: ['team'] } })
  if (withLaunchd) launchd = await fakeLaunchd(t, { home, env })
  const world = {
    dir, projectDir, dataRoot, home, configPath, env, loadProject, launchd,
    workspace: () => ({ workspaceRoot: fs.realpathSync(workspaceRoot), workspaceId: WORKSPACE_ID }),
    record: () => readServiceRecord(world.workspace()),
    settings: () => readServiceSettings(world.workspace()),
    loginItem: () => { try { return JSON.parse(fs.readFileSync(servicePaths(world.workspace().workspaceRoot).loginItem, 'utf8')) } catch { return null } },
    lastStartup: () => { try { return JSON.parse(fs.readFileSync(servicePaths(world.workspace().workspaceRoot).lastStartup, 'utf8')) } catch { return null } },
    seams: (extra = {}) => ({ ...NO_APP, service: { entryPath: TEST_SERVICE_ENTRY, entryArgs, spawn: forbiddenSpawn }, serviceManager: launchd?.manager, ...extra }),
    async run(argv, { seams, platform = 'darwin', ...extra } = {}) {
      const out = []
      const err = []
      const exit = await runObsidianCommand({
        argv: [...argv, `--project=${configPath}`, `--data-root=${dataRoot}`], seams: seams ?? world.seams(), env, cwd: projectDir, platform, contributions: [], probeTimeoutMs: FAST_PROBE,
        stdout: (text) => out.push(text), stderr: (text) => err.push(text), ...extra,
      })
      const stdout = out.join('\n')
      let json = null
      try { json = JSON.parse(stdout) } catch { json = null }
      return { exit, stdout, stderr: err.join('\n'), json }
    },
    lifecycle: (extra = {}) => ({ loadProject, dataRoot, env, probeTimeoutMs: FAST_PROBE, ...extra }),
    // The service the record names, once it answers health as itself.
    async healthy(label = 'the service to prove itself') {
      return waitFor(async () => { const status = await serviceStatus(world.lifecycle()); return status.state === 'healthy' ? status : null }, { label })
    },
  }
  return world
}

// ---------------------------------------------------------------------------
// 1. The unit texts, exactly
// ---------------------------------------------------------------------------

const GOLDEN_INPUT = Object.freeze({
  nodePath: '/opt/synthetic/node-22.18.0/bin/node',
  entryPath: '/srv/synthetic/harbor-notes/node_modules/@mnstry/atelier/src/runtime/obsidian/service-main.mjs',
  args: ['--project=/srv/synthetic/harbor-notes/atelier.project.json', '--adapter=obsidian-cli'],
  logPath: '/srv/synthetic/data/obsidian/ws-070707070707070707070707/state/service/login-item.log',
  searchPath: '/opt/synthetic/node-22.18.0/bin:/usr/local/bin:/usr/bin:/bin',
})

const GOLDEN_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.mnstry.atelier.harbor-notes.ws-070707070707070707070707</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/synthetic/node-22.18.0/bin/node</string>
    <string>/srv/synthetic/harbor-notes/node_modules/@mnstry/atelier/src/runtime/obsidian/service-main.mjs</string>
    <string>--startup</string>
    <string>--project=/srv/synthetic/harbor-notes/atelier.project.json</string>
    <string>--adapter=obsidian-cli</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/synthetic/node-22.18.0/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>/</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>60</integer>
  <key>ExitTimeOut</key>
  <integer>60</integer>
  <key>ProcessType</key>
  <string>Standard</string>
  <key>StandardOutPath</key>
  <string>/srv/synthetic/data/obsidian/ws-070707070707070707070707/state/service/login-item.log</string>
  <key>StandardErrorPath</key>
  <string>/srv/synthetic/data/obsidian/ws-070707070707070707070707/state/service/login-item.log</string>
</dict>
</plist>
`

const GOLDEN_UNIT = `[Unit]
Description=Atelier Obsidian maintenance (atelier-obsidian-ws-070707070707070707070707)

[Service]
Type=simple
ExecStart="/opt/synthetic/node-22.18.0/bin/node" "/srv/synthetic/harbor-notes/node_modules/@mnstry/atelier/src/runtime/obsidian/service-main.mjs" "--startup" "--project=/srv/synthetic/harbor-notes/atelier.project.json" "--adapter=obsidian-cli"
Environment="PATH=/opt/synthetic/node-22.18.0/bin:/usr/local/bin:/usr/bin:/bin"
WorkingDirectory=/
Restart=on-failure
RestartSec=60
RestartPreventExitStatus=2
TimeoutStopSec=60
StandardOutput=append:/srv/synthetic/data/obsidian/ws-070707070707070707070707/state/service/login-item.log
StandardError=append:/srv/synthetic/data/obsidian/ws-070707070707070707070707/state/service/login-item.log

[Install]
WantedBy=default.target
`

test('golden: the launchd agent runs the installed entry in the root folder with the person\'s search path, as a standard process, restarted only after a failure', () => {
  const agent = buildStartupAdapter({ platform: 'darwin', label: 'ai.mnstry.atelier.harbor-notes.ws-070707070707070707070707', ...GOLDEN_INPUT })
  assert.equal(agent.text, GOLDEN_PLIST)
  assert.deepEqual([agent.kind, agent.fileName], ['launchd-user-agent', 'ai.mnstry.atelier.harbor-notes.ws-070707070707070707070707.plist'])
})

test('golden: the systemd user unit carries the same program, search path and working directory, and restarts only after a failure', () => {
  const unit = buildStartupAdapter({ platform: 'linux', label: 'atelier-obsidian-ws-070707070707070707070707', ...GOLDEN_INPUT })
  assert.equal(unit.text, GOLDEN_UNIT)
  assert.deepEqual([unit.kind, unit.fileName], ['systemd-user-unit', 'atelier-obsidian-ws-070707070707070707070707.service'])
})

test('the search path is escaped for each format, and `$` means nothing in a systemd assignment', () => {
  const searchPath = '/opt/a&b/<bin>:/srv/100%/$HOME/"q"'
  const agent = buildStartupAdapter({ platform: 'darwin', label: 'ai.mnstry.atelier.x.ws-1', ...GOLDEN_INPUT, searchPath })
  assert.ok(agent.text.includes('<string>/opt/a&amp;b/&lt;bin&gt;:/srv/100%/$HOME/&quot;q&quot;</string>'))
  const unit = buildStartupAdapter({ platform: 'linux', label: 'atelier-obsidian-ws-1', ...GOLDEN_INPUT, searchPath })
  assert.ok(unit.text.includes('Environment="PATH=/opt/a&b/<bin>:/srv/100%%/$HOME/\\"q\\""\n'))
  for (const invalid of ['relative/bin', '/ok:relative', '/two\nlines', '']) {
    for (const platform of ['darwin', 'linux']) assert.throws(() => buildStartupAdapter({ platform, label: 'x', ...GOLDEN_INPUT, searchPath: invalid }), (error) => error.code === 'startup-adapter-input-invalid', JSON.stringify(invalid))
  }
})

test('the search path a unit carries keeps absolute entries once, in their order, and none in a temporary folder', async () => {
  const { startupSearchPath } = await startupAdapters()
  const temporary = ['/tmp', '/srv/scratch/T']
  assert.equal(startupSearchPath('/opt/tool/bin:bin:./x::/usr/bin/:/usr/bin:/tmp/agent-1/bin:/srv/scratch/T/session/bin:/tmpfiles/bin:/bin', { temporary }), '/opt/tool/bin:/usr/bin:/tmpfiles/bin:/bin')
  assert.equal(startupSearchPath('relative:', { temporary }), null)
  assert.equal(startupSearchPath(undefined), null)
  assert.equal(startupSearchPath('/usr/bin\u0007:/bin'), '/bin', 'an entry with a control character is dropped')
})

test('on macOS the golden property list is one plutil accepts', { skip: process.platform === 'darwin' ? false : 'plutil is a macOS program' }, (t) => {
  const dir = fs.mkdtempSync(path.join(TMP, 'atelier-plist-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'ai.mnstry.atelier.harbor-notes.ws-070707070707070707070707.plist')
  fs.writeFileSync(file, GOLDEN_PLIST)
  const lint = childProcess.spawnSync('/usr/bin/plutil', ['-lint', file], { encoding: 'utf8' })
  assert.equal(lint.status, 0, lint.stdout + lint.stderr)
})

test('a label names the project for people and the workspace for machines, allocated as a plain identifier', async () => {
  const { labelSlug, loginItemLabel } = await loginItems()
  assert.deepEqual(['Harbor Notes', 'Caf\u00e9 Cr\u00e8me!', '  --  ', '', '\u00c4\u00d6\u00dc \u00df', 'x'.repeat(60)].map(labelSlug), ['harbor-notes', 'cafe-creme', 'project', 'project', 'aou', 'x'.repeat(40)])
  assert.equal(loginItemLabel({ platform: 'darwin', projectName: 'Harbor Notes', workspaceId: WORKSPACE_ID }), `ai.mnstry.atelier.harbor-notes.${WORKSPACE_ID}`)
  assert.equal(loginItemLabel({ platform: 'linux', projectName: 'Harbor Notes', workspaceId: WORKSPACE_ID }), `atelier-obsidian-${WORKSPACE_ID}`)
})

// ---------------------------------------------------------------------------
// 2. The service managers: what each asks of launchctl and systemctl, in order
// ---------------------------------------------------------------------------

async function managerWorld(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(TMP, 'atelier-units-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { dir, directory: path.join(dir, 'LaunchAgents') }
}

test('launchd: install writes the property list first, owner-writable only, lets a loaded job go and bootstraps it; start, remove and inspect are one call each', async (t) => {
  const { createLaunchdManager } = await managers()
  const { directory } = await managerWorld(t)
  const label = 'ai.mnstry.atelier.harbor-notes.ws-1'
  const file = path.join(directory, `${label}.plist`)
  let printed = 0
  // The job is loaded when installation begins: it answers print once more after its bootout, then is gone.
  const { run, calls } = recordingRun((program, args) => {
    if (args[0] === 'bootstrap') assert.equal(fs.readFileSync(file, 'utf8'), 'unit text', 'the file is written before launchd reads it')
    if (args[0] === 'print') { printed += 1; return printed === 1 ? { status: 0, stdout: 'state = running' } : { status: 113, stderr: 'Could not find service' } }
    if (args[0] === 'kickstart') return { stdout: '4242\n' }
    if (args[0] === 'print-disabled') return { stdout: `disabled services = {\n\t"${label}" => enabled\n}\n` }
    return undefined
  })
  const manager = createLaunchdManager({ run, uid: 501, directory, pollMs: 1 })
  assert.deepEqual(await manager.install({ label, fileName: `${label}.plist`, text: 'unit text' }), { ok: true, file })
  if (POSIX_HERE) assert.equal(fs.statSync(file).mode & 0o777, 0o644)
  assert.deepEqual(calls, [`/bin/launchctl bootout gui/501/${label}`, `/bin/launchctl print gui/501/${label}`, `/bin/launchctl print gui/501/${label}`, `/bin/launchctl bootstrap gui/501 ${file}`])
  calls.length = 0
  assert.deepEqual(await manager.start({ label, fileName: `${label}.plist` }), { ok: true, pid: 4242 })
  assert.deepEqual(calls, [`/bin/launchctl kickstart -p gui/501/${label}`])
  calls.length = 0
  const seen = await manager.inspect({ label, fileName: `${label}.plist` })
  assert.deepEqual([seen.present, seen.loaded, seen.disabled], [true, false, false])
  assert.deepEqual(calls, [`/bin/launchctl print gui/501/${label}`, '/bin/launchctl print-disabled gui/501'])
  calls.length = 0
  assert.deepEqual(await manager.remove({ label, fileName: `${label}.plist` }), { ok: true, removed: true })
  assert.deepEqual([calls[0], fs.existsSync(file)], [`/bin/launchctl bootout gui/501/${label}`, false])
})

test('launchd: a refused bootstrap, a start of a job it does not have and a job it keeps are typed; nothing is written through a link', async (t) => {
  const { createLaunchdManager } = await managers()
  const { dir, directory } = await managerWorld(t)
  const label = 'ai.mnstry.atelier.harbor-notes.ws-1'
  const notFound = { status: 113, stderr: 'Could not find service' }
  const refusing = createLaunchdManager({ run: recordingRun((program, args) => (args[0] === 'bootout' ? { status: 3 } : args[0] === 'print' ? notFound : args[0] === 'bootstrap' ? { status: 5, stderr: 'Bootstrap failed: 5: Input/output error' } : args[0] === 'kickstart' ? notFound : undefined)).run, uid: 501, directory, pollMs: 1 })
  assert.deepEqual(await refusing.install({ label, fileName: `${label}.plist`, text: 'x' }), { ok: false, code: 'login-item-install-failed', status: 5, message: 'Bootstrap failed: 5: Input/output error' })
  assert.equal((await refusing.start({ label, fileName: `${label}.plist` })).code, 'login-item-not-loaded')
  const keeping = createLaunchdManager({ run: recordingRun((program, args) => (args[0] === 'print' ? { status: 0 } : undefined)).run, uid: 501, directory, waitMs: 30, pollMs: 5 })
  assert.equal((await keeping.remove({ label, fileName: `${label}.plist` })).code, 'login-item-remove-failed', 'a job launchd keeps loaded is not reported removed')
  if (!POSIX_HERE) return
  // A link at the unit's name: nothing is written through it, and it is not removed.
  const elsewhere = path.join(dir, 'elsewhere.txt')
  fs.writeFileSync(elsewhere, 'somebody else\'s')
  fs.rmSync(directory, { recursive: true, force: true })
  fs.mkdirSync(directory)
  fs.symlinkSync(elsewhere, path.join(directory, `${label}.plist`))
  const quiet = createLaunchdManager({ run: recordingRun({ [`print gui/501/${label}`]: notFound }).run, uid: 501, directory, pollMs: 1 })
  assert.equal((await quiet.install({ label, fileName: `${label}.plist`, text: 'x' })).code, 'login-item-file-unsafe')
  assert.equal((await quiet.remove({ label, fileName: `${label}.plist` })).code, 'login-item-file-unsafe')
  assert.equal(fs.readFileSync(elsewhere, 'utf8'), 'somebody else\'s')
})

test('mutation control: a launchd manager that bootstraps before it writes the file fails the order oracle', async (t) => {
  const { createLaunchdManager } = await managers()
  const { directory } = await managerWorld(t)
  const label = 'ai.mnstry.atelier.harbor-notes.ws-1'
  const file = path.join(directory, `${label}.plist`)
  const seen = []
  const run = async (program, args) => { if (args[0] === 'bootstrap') seen.push(fs.existsSync(file)); return args[0] === 'print' ? { status: 113, stdout: '', stderr: '' } : { status: 0, stdout: '', stderr: '' } }
  const real = createLaunchdManager({ run, uid: 501, directory, pollMs: 1 })
  await real.install({ label, fileName: `${label}.plist`, text: 'x' })
  // The broken order: bootstrap first, then the same installation.
  fs.rmSync(file)
  await run('/bin/launchctl', ['bootstrap', 'gui/501', file])
  await real.install({ label, fileName: `${label}.plist`, text: 'x' })
  assert.deepEqual(seen, [true, false, true])
  assert.throws(() => assert.ok(seen.every(Boolean)), assert.AssertionError)
})

test('launchd: what print and print-disabled say is read from their texts', async () => {
  const { readLaunchdDisabled, readLaunchdPrint } = await managers()
  const running = 'gui/501/ai.x = {\n\tactive count = 1\n\tpath = /srv/synthetic/home/Library/LaunchAgents/ai.x.plist\n\ttype = LaunchAgent\n\tstate = running\n\n\tprogram = /opt/node\n\tpid = 5150\n\tlast exit code = (never exited)\n}\n'
  assert.deepEqual(readLaunchdPrint(running), { state: 'running', pid: 5150, lastExit: null })
  assert.deepEqual(readLaunchdPrint('gui/501/ai.x = {\n\tstate = not running\n\tlast exit code = 75\n}\n'), { state: 'not running', pid: null, lastExit: 75 })
  const listed = 'disabled services = {\n\t"com.apple.x" => disabled\n\t"ai.x" => disabled\n\t"ai.y" => enabled\n\t"ai.old" => true\n}\n'
  assert.deepEqual(['ai.x', 'ai.y', 'ai.old', 'ai.absent'].map((label) => readLaunchdDisabled(listed, label)), [true, false, true, null])
})

test('systemd: install writes the unit, reloads and enables it; start, remove and inspect; no user instance is login-item-unavailable and leaves nothing behind', async (t) => {
  const { createSystemdManager, readSystemdShow } = await managers()
  const { dir } = await managerWorld(t)
  const directory = path.join(dir, 'systemd', 'user')
  const unit = 'atelier-obsidian-ws-1.service'
  const { run, calls } = recordingRun({ [`--user show -p LoadState,ActiveState,SubState,UnitFileState,MainPID,ExecMainStatus ${unit}`]: { stdout: 'LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\nMainPID=777\nExecMainStatus=0\n' } })
  const manager = createSystemdManager({ run, systemctl: '/usr/bin/systemctl', directory })
  assert.deepEqual(await manager.install({ label: 'atelier-obsidian-ws-1', fileName: unit, text: 'unit text' }), { ok: true, file: path.join(directory, unit) })
  assert.deepEqual(calls, ['/usr/bin/systemctl --user daemon-reload', `/usr/bin/systemctl --user enable ${unit}`])
  calls.length = 0
  assert.deepEqual(await manager.start({ label: 'atelier-obsidian-ws-1', fileName: unit }), { ok: true, pid: null })
  const seen = await manager.inspect({ label: 'atelier-obsidian-ws-1', fileName: unit })
  assert.deepEqual([seen.loaded, seen.running, seen.pid, seen.disabled], [true, true, 777, false])
  assert.deepEqual(await manager.remove({ label: 'atelier-obsidian-ws-1', fileName: unit }), { ok: true, removed: true })
  assert.deepEqual(calls, [`/usr/bin/systemctl --user start ${unit}`, `/usr/bin/systemctl --user show -p LoadState,ActiveState,SubState,UnitFileState,MainPID,ExecMainStatus ${unit}`, `/usr/bin/systemctl --user disable --now ${unit}`, '/usr/bin/systemctl --user daemon-reload'])
  assert.equal(fs.existsSync(path.join(directory, unit)), false)
  // WSL or a container: no user instance answers. The unit written on the way is gone again.
  const noBus = createSystemdManager({ run: recordingRun({ '--user daemon-reload': { status: 1, stderr: 'Failed to connect to bus: No medium found' } }).run, systemctl: '/usr/bin/systemctl', directory })
  assert.equal((await noBus.install({ label: 'atelier-obsidian-ws-1', fileName: unit, text: 'unit text' })).code, 'login-item-unavailable')
  assert.equal(fs.existsSync(path.join(directory, unit)), false)
  assert.deepEqual(readSystemdShow('LoadState=not-found\nActiveState=inactive\nUnitFileState=\n'), { loadState: 'not-found', activeState: 'inactive', subState: null, unitFileState: '', pid: null, lastExit: null })
})

// ---------------------------------------------------------------------------
// 3. The production manager is reached only by the real entry, and refuses a private HOME and the test runner
// ---------------------------------------------------------------------------

test('whether HOME is the account\'s home is decided before any login item is installed', async (t) => {
  const { homeIsAccountHome } = await managers()
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(TMP, 'atelier-home-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const account = path.join(dir, 'account')
  fs.mkdirSync(account)
  if (POSIX_HERE) fs.symlinkSync(account, path.join(dir, 'link'))
  const cases = [[account, true], [`${account}/`, true], [path.join(dir, 'private-home'), false], ['relative/home', false], ['', false], [undefined, false], ...(POSIX_HERE ? [[path.join(dir, 'link'), true]] : [])]
  for (const [home, expected] of cases) assert.equal(homeIsAccountHome({ env: { HOME: home }, accountHome: account }), expected, String(home))
})

test('the production manager refuses under the test runner and for a HOME that is not the account\'s, before anything is looked up or run', needsPosix, async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(TMP, 'atelier-production-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const home = path.join(dir, 'private-home')
  fs.mkdirSync(home)
  const module = path.join(REPOSITORY_ROOT, 'src', 'runtime', 'obsidian', 'service-manager-production.mjs')
  const probe = (platform) => `import(${JSON.stringify(module)}).then((m) => { try { m.createProductionServiceManager({ platform: ${JSON.stringify(platform)} }); console.log('constructed') } catch (error) { console.log(error.code) } })`
  const { NODE_TEST_CONTEXT: _runner, ...plain } = process.env
  const answer = (env, platform = process.platform) => childProcess.spawnSync(process.execPath, ['--input-type=module', '-e', probe(platform)], { env, encoding: 'utf8', windowsHide: true }).stdout.trim()
  assert.equal(answer({ ...plain, HOME: home, NODE_TEST_CONTEXT: 'child-v8' }), 'real-login-item-under-test')
  assert.equal(answer({ ...plain, HOME: home }), 'login-item-home-mismatch')
  assert.equal(answer({ ...plain, HOME: home }, 'win32'), 'startup-platform-unqualified')
  assert.equal(answer({ ...plain, HOME: home }, 'freebsd'), 'startup-platform-unsupported')
  // The same through the real command-line entry, which is where the production manager is ever made.
  const project = path.join(dir, 'project')
  fs.mkdirSync(project)
  writeJson(path.join(project, 'atelier.project.json'), projectDocument('Harbor Notes'))
  for (const repo of REPOSITORIES) fs.mkdirSync(path.join(project, repo, '.git'), { recursive: true })
  writeJson(path.join(project, 'repo-access.v1.json'), { schema: 'mnstry.atelier-repo-access@v1', defaultReadBoundary: 'team', repos: Object.fromEntries(REPOSITORIES.map((repo) => [repo, { readBoundary: 'team' }])) })
  const before = listing(dir)
  for (const [env, code] of [[{ ...plain, HOME: home, NODE_TEST_CONTEXT: 'child-v8' }, 'real-login-item-under-test'], [{ ...plain, HOME: home }, 'login-item-home-mismatch']]) {
    const child = childProcess.spawnSync(process.execPath, [path.join(REPOSITORY_ROOT, 'bin', 'atelier.mjs'), 'obsidian', 'service', 'unit', '--install', '--json', '--adapter=obsidian-cli', '--consent-actor', CONSENT_ACTOR, `--project=${path.join(project, 'atelier.project.json')}`, `--data-root=${path.join(dir, 'data')}`], { env, cwd: project, encoding: 'utf8', windowsHide: true })
    assert.deepEqual([child.status, JSON.parse(child.stdout).error.code], [EXIT.refused, code], child.stderr)
  }
  const after = listing(dir)
  assert.deepEqual(Object.keys(after).filter((key) => !key.startsWith('project/.atelier-local') && !key.startsWith('data/')), Object.keys(before), 'nothing but the workspace pointer and its private state was written')
  assert.equal(Object.keys(after).some((key) => key.includes('LaunchAgents') || key.includes('login-item')), false)
})

test('the production manager is imported in exactly one place, dynamically; this process never loaded it', () => {
  const sources = []
  const walk = (directory) => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) walk(file); else if (entry.name.endsWith('.mjs')) sources.push(file) } }
  walk(path.join(REPOSITORY_ROOT, 'src'))
  const naming = sources.filter((file) => fs.readFileSync(file, 'utf8').includes('service-manager-production.mjs')).map((file) => path.relative(REPOSITORY_ROOT, file).split(path.sep).join('/'))
  assert.deepEqual(naming, ['src/commands/obsidian.mjs'])
  const command = fs.readFileSync(path.join(REPOSITORY_ROOT, naming[0]), 'utf8')
  assert.equal(/^import [^\n]*service-manager-production/m.test(command), false)
  assert.match(command, /import\('[^']*service-manager-production\.mjs'\)/)
  assert.equal(globalThis[Symbol.for('mnstry.atelier.obsidian.production-service-manager-loaded')], undefined)
})

test('the guards throw before a service manager starts or a real unit folder is touched, and let everything else through', () => {
  const before = guardErrors.length
  for (const program of ['launchctl', '/bin/launchctl', 'systemctl', '/usr/bin/systemctl', 'osascript', 'open', 'obsidian-cli']) assert.throws(() => childProcess.spawnSync(program, ['print']), /spawn guard/, program)
  assert.throws(() => childProcess.spawnSync('/usr/bin/env', ['launchctl', 'bootstrap']), /spawn guard/)
  assert.throws(() => childProcess.spawnSync(process.execPath, ['-e', '0', '--', 'service-manager-production'], { env: { ...process.env } }), /private HOME/)
  for (const root of PROTECTED) {
    assert.throws(() => fs.writeFileSync(path.join(root, 'ai.mnstry.atelier.guard.plist'), 'x'), /fs guard/)
    assert.throws(() => fs.mkdirSync(path.join(root, 'user'), { recursive: true }), /fs guard/)
  }
  assert.equal(guardErrors.length, before + 9 + 2 * PROTECTED.length)
  guardErrors.length = before
  assert.doesNotThrow(() => guardSpawn('node', ['--version']))
})

// ---------------------------------------------------------------------------
// 4. The service started by a login item: refusals end cleanly, its own log, and a new release ends it after a tick
// ---------------------------------------------------------------------------

function serviceSettings(world, port, coverage) {
  return writeServiceSettings({ ...world.workspace(), settings: { schema: 'atelier-obsidian-service-settings/v1', workspaceId: WORKSPACE_ID, host: '127.0.0.1', port, consent: { grantedAt: iso(START), actor: CONSENT_ACTOR, coverage }, updatedAt: iso(START) } })
}

// A child of node, awaited without blocking this process: { status, signal, stdout }.
function runChild(t, args, env) {
  const child = follow(t, childProcess.spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }), 'a service run to its end')
  let stdout = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  return new Promise((resolve) => { child.once('close', (status, signal) => resolve({ status, signal, stdout })) })
}

const entryWords = (world, extra = []) => [TEST_SERVICE_ENTRY, `--project=${world.configPath}`, `--data-root=${world.dataRoot}`, ...extra]

test('under --startup a refusal exits 0 and records why, so the manager does not start it again; without --startup it still exits 2', needsPosix, async (t) => {
  const world = await makeWorld(t, { withLaunchd: false })
  serviceSettings(world, await freePort(), 'service')
  const withoutConsent = childProcess.spawnSync(process.execPath, entryWords(world, ['--startup']), { env: world.env, encoding: 'utf8', windowsHide: true })
  assert.equal(withoutConsent.status, 0, withoutConsent.stdout + withoutConsent.stderr)
  assert.deepEqual((({ at: _at, ...rest }) => rest)(world.lastStartup()), { schema: 'atelier-obsidian-last-startup/v1', workspaceId: WORKSPACE_ID, outcome: 'refused', code: 'startup-consent-absent' })
  assert.equal(withoutConsent.stdout.includes('startup-consent-absent'), false, 'the refusal went to the service\'s own log, not to the unit\'s output')
  assert.ok(fs.readFileSync(servicePaths(world.workspace().workspaceRoot).log, 'utf8').includes('"code":"startup-consent-absent"'))
  // No settings at all: refused with and without a login item, and only the login item's run ends cleanly.
  fs.rmSync(servicePaths(world.workspace().workspaceRoot).settings)
  const startup = childProcess.spawnSync(process.execPath, entryWords(world, ['--startup']), { env: world.env, encoding: 'utf8', windowsHide: true })
  assert.deepEqual([startup.status, world.lastStartup().code], [0, 'service-settings-absent'])
  const plain = childProcess.spawnSync(process.execPath, entryWords(world), { env: world.env, encoding: 'utf8', windowsHide: true })
  assert.deepEqual([plain.status, /service-settings-absent/.test(plain.stdout)], [2, true], 'the same refusal, not under a login item, is still exit 2 and printed')
  // Arguments a unit can never change: the production entry without its adapter, under --startup, ends cleanly too.
  const argumentsRefused = childProcess.spawnSync(process.execPath, [SERVICE_ENTRY_PATH, '--startup', `--project=${world.configPath}`], { env: world.env, encoding: 'utf8', windowsHide: true })
  assert.deepEqual([argumentsRefused.status, /service-adapter-not-selected/.test(argumentsRefused.stdout)], [0, true])
  assert.equal(childProcess.spawnSync(process.execPath, [SERVICE_ENTRY_PATH, `--project=${world.configPath}`], { env: world.env, encoding: 'utf8', windowsHide: true }).status, 2)
})

test('under --startup beside a service that runs: service-already-running, exit 0, recorded; the running one keeps its record', needsPosix, async (t) => {
  const world = await makeWorld(t, { withLaunchd: false })
  serviceSettings(world, await freePort(), 'service-and-startup')
  const absent = () => createEditorAdapter({ call: async () => { throw new Error('no app') }, processProbe: () => 'absent', kind: 'absent' })
  const running = await runMaintenanceService({ loadProject: world.loadProject, dataRoot: world.dataRoot, env: world.env, adapterFactory: absent, entryPath: TEST_SERVICE_ENTRY, intervalMs: IDLE_INTERVAL, engineOptions: { quietPeriodMs: 0, watcherFactory: () => ({ close() {} }) } })
  t.after(() => running.shutdown('test-teardown'))
  // Run asynchronously: this process answers the health the child asks for.
  const second = await runChild(t, entryWords(world, ['--startup']), world.env)
  assert.equal(second.status, 0)
  assert.deepEqual([world.lastStartup().outcome, world.lastStartup().code, world.record().runtimeId], ['refused', 'service-already-running', running.identity.runtimeId])
})

async function syntheticPackage(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(TMP, 'atelier-release-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'src', 'runtime'), { recursive: true })
  fs.mkdirSync(path.join(root, 'contracts'))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'synthetic', version: '1.0.0' }))
  fs.writeFileSync(path.join(root, 'src', 'runtime', 'a.mjs'), 'export const a = 1\n')
  fs.writeFileSync(path.join(root, 'contracts', 'c.json'), '{}\n')
  return root
}

test('a service a login item started exits 75 after the tick that finds another release on disk; one that `start` started keeps running', needsPosix, async (t) => {
  const world = await makeWorld(t, { withLaunchd: false })
  serviceSettings(world, await freePort(), 'service-and-startup')
  const root = await syntheticPackage(t)
  const child = follow(t, childProcess.spawn(process.execPath, entryWords(world, ['--startup', '--interval-ms=100', `--release-root=${root}`]), { env: world.env, stdio: 'ignore', windowsHide: true }), 'a service under --startup')
  const exited = new Promise((resolve) => { child.once('exit', (code, signal) => resolve({ code, signal })) })
  const record = (await world.healthy()).record
  assert.equal(record.pid, child.pid)
  fs.writeFileSync(path.join(root, 'src', 'runtime', 'a.mjs'), 'export const a = 2\n')
  const { code, signal } = await Promise.race([exited, sleep(15000).then(() => ({ code: 'still running' }))])
  assert.deepEqual([code, signal ?? null], [75, null])
  assert.equal(world.record(), null, 'it removed its own record on the way out')
  const log = fs.readFileSync(servicePaths(world.workspace().workspaceRoot).log, 'utf8')
  assert.ok(/"event":"release-changed"/.test(log) && /"reason":"release-changed"/.test(log))

  // Started by `start`, not by a login item: the same change is nobody's business but the next `open`'s.
  serviceSettings(world, await freePort(), 'service')
  const plain = follow(t, childProcess.spawn(process.execPath, entryWords(world, ['--interval-ms=100', `--release-root=${root}`]), { env: world.env, stdio: 'ignore', windowsHide: true }), 'a service without --startup')
  await world.healthy()
  fs.writeFileSync(path.join(root, 'src', 'runtime', 'a.mjs'), 'export const a = 3\n')
  await sleep(1500)
  assert.equal(plain.exitCode, null, 'it is still running')
  assert.equal((await stopService(world.lifecycle({ stopTimeoutMs: 10000 }))).stopped, true)
})

test('the release is asked after the tick, never before it: the tick in flight finishes, then the service stops as release-changed', needsPosix, async (t) => {
  const world = await makeWorld(t, { withLaunchd: false })
  serviceSettings(world, await freePort(), 'service-and-startup')
  const order = []
  let changed = false
  const service = await runMaintenanceService({
    loadProject: world.loadProject, dataRoot: world.dataRoot, env: world.env, entryPath: TEST_SERVICE_ENTRY, intervalMs: IDLE_INTERVAL, startup: true,
    adapterFactory: () => createEditorAdapter({ call: async () => { throw new Error('no app') }, processProbe: () => 'absent', kind: 'absent' }),
    createEngine: () => ({ stop() {}, tick: async () => { order.push('tick'); await sleep(50); order.push('tick-done'); return { state: 'ticked', scopes: [], changes: [], pendingEdits: [], dispatched: [], lateWriters: [] } } }),
    releaseWatch: { changed: () => { order.push('asked'); return changed } },
  })
  t.after(() => service.shutdown('test-teardown'))
  await waitFor(() => order.includes('asked'), { label: 'the first tick' })
  changed = true
  const outcome = await service.tickNow()
  assert.deepEqual([outcome.ok, outcome.report.state], [true, 'ticked'], 'the tick that found the change completed and answered')
  assert.deepEqual(await Promise.race([service.done, sleep(5000).then(() => null)]), { reason: 'release-changed' })
  assert.deepEqual(order.slice(-3), ['tick', 'tick-done', 'asked'])
})

test('control: a service not started by a login item, or one that never asks, is not ended by a new release', needsPosix, async (t) => {
  const world = await makeWorld(t, { withLaunchd: false })
  for (const variant of [{ startup: false, releaseWatch: { changed: () => true } }, { startup: true, releaseWatch: null }]) {
    serviceSettings(world, await freePort(), 'service-and-startup')
    const service = await runMaintenanceService({
      loadProject: world.loadProject, dataRoot: world.dataRoot, env: world.env, entryPath: TEST_SERVICE_ENTRY, intervalMs: IDLE_INTERVAL, ...variant,
      adapterFactory: () => createEditorAdapter({ call: async () => { throw new Error('no app') }, processProbe: () => 'absent', kind: 'absent' }),
      createEngine: () => ({ stop() {}, tick: async () => ({ state: 'ticked', scopes: [], changes: [], pendingEdits: [], dispatched: [], lateWriters: [] }) }),
    })
    await service.tickNow()
    assert.equal(await Promise.race([service.done.then(() => 'ended'), sleep(300).then(() => 'running')]), 'running', JSON.stringify(variant.startup))
    await service.shutdown('test-teardown')
  }
})

// ---------------------------------------------------------------------------
// 5. The release watch: status first, digest only when that changed
// ---------------------------------------------------------------------------

test('the release watch compares the files\' status first, digests only when that changed, and a change is a new version or new content', async (t) => {
  const { createReleaseWatch, readReleaseIdentity, releaseStatSignature } = await releases()
  const root = await syntheticPackage(t)
  let digests = 0
  const identityOf = (input) => { digests += 1; return readReleaseIdentity(input) }
  const watch = createReleaseWatch({ root, identityOf, signatureOf: releaseStatSignature })
  assert.deepEqual([watch.changed(), watch.changed(), digests], [false, false, 1], 'unchanged status: no digest')
  const file = path.join(root, 'src', 'runtime', 'a.mjs')
  const staged = path.join(root, 'staged.tmp')
  fs.writeFileSync(staged, fs.readFileSync(file))
  fs.renameSync(staged, file)
  assert.deepEqual([watch.changed(), digests], [false, 2], 'the same bytes under a new inode: digested, and the same release')
  assert.deepEqual([watch.changed(), digests], [false, 2], 'and that status is remembered')
  fs.writeFileSync(path.join(root, 'src', 'runtime', 'b.mjs'), 'export const b = 1\n')
  assert.equal(watch.changed(), true, 'a module added is another release')

  const bumped = createReleaseWatch({ root })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'synthetic', version: '1.0.1' }))
  assert.equal(bumped.changed(), true, 'another version is another release')
  const edited = createReleaseWatch({ root })
  fs.writeFileSync(path.join(root, 'contracts', 'c.json'), '{"x":1}\n')
  assert.equal(edited.changed(), true, 'a contract changed is another release')
  const removed = createReleaseWatch({ root })
  fs.rmSync(path.join(root, 'src'), { recursive: true })
  assert.equal(removed.changed(), false, 'a package that cannot be read right now is not a change yet')
})

test('the release identity is read uncached from a root, the cached one is kept per process, and the plugin is part of what the watch compares', async (t) => {
  const { createReleaseWatch } = await releases()
  const { readReleaseIdentity, releaseIdentity } = await records()
  const root = await syntheticPackage(t)
  const cached = releaseIdentity({ root })
  const before = readReleaseIdentity({ root })
  assert.deepEqual(before, cached)
  fs.mkdirSync(path.join(root, 'plugins'))
  assert.deepEqual(readReleaseIdentity({ root }), before, 'a package without plugins/ reads as one with an empty one')
  const watch = createReleaseWatch({ root })
  fs.mkdirSync(path.join(root, 'plugins', 'obsidian'))
  fs.writeFileSync(path.join(root, 'plugins', 'obsidian', 'main.js'), 'module.exports = 1\n')
  const after = readReleaseIdentity({ root })
  assert.notEqual(after.digest, before.digest, 'read now, the plugin is part of the release')
  assert.deepEqual(releaseIdentity({ root }), cached, 'the cached identity stays the one this process first read')
  assert.equal(watch.changed(), true, 'a service whose package\'s plugin changed runs another release')
})

test('the installed release a running service is measured against is read from the entry that would be started, through the path it is named by', needsPosix, async (t) => {
  const { readReleaseIdentity } = await releases()
  const { runtimeRelease } = await import('../src/runtime/obsidian/lifecycle.mjs')
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(TMP, 'atelier-installed-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const makePackage = (name, module) => {
    const root = path.join(dir, name)
    fs.mkdirSync(path.join(root, 'src', 'runtime', 'obsidian'), { recursive: true })
    fs.mkdirSync(path.join(root, 'contracts'))
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@mnstry/atelier', version: '9.9.9' }))
    fs.writeFileSync(path.join(root, 'src', 'runtime', 'obsidian', 'service-main.mjs'), 'export const entry = 1\n')
    fs.writeFileSync(path.join(root, 'src', 'runtime', 'obsidian', 'other.mjs'), module)
    fs.writeFileSync(path.join(root, 'contracts', 'c.json'), '{}\n')
    return root
  }
  const first = makePackage('first', 'export const other = 1\n')
  const second = makePackage('second', 'export const other = 2\n')
  // The project's package is a link, as a `file:` install makes it; the login item names the entry through it.
  const linked = path.join(dir, 'project', 'node_modules', '@mnstry', 'atelier')
  fs.mkdirSync(path.dirname(linked), { recursive: true })
  fs.symlinkSync(first, linked)
  const entry = path.join(linked, 'src', 'runtime', 'obsidian', 'service-main.mjs')
  const running = { state: 'healthy', record: { executable: { path: path.join(first, 'src', 'runtime', 'obsidian', 'service-main.mjs'), digest: sha256('export const entry = 1\n'), ext: { release: readReleaseIdentity({ root: first }) } } } }
  assert.equal(runtimeRelease(running, entry), 'current', 'the service runs the release the item\'s package holds, whatever package this command runs from')
  fs.unlinkSync(linked)
  fs.symlinkSync(second, linked)
  assert.equal(runtimeRelease(running, entry), 'outdated', 'the link pointed at another package of the same version with other modules is another release')
  fs.writeFileSync(path.join(second, 'package.json'), JSON.stringify({ name: '@mnstry/atelier', version: '9.9.8' }))
  assert.equal(runtimeRelease(running, entry), 'later', 'an earlier installed version never replaces the running one')
})

test('the package root of a service entry is read from its path, without resolving links', async () => {
  const { packageRootOfEntry } = await releases()
  const entry = (root) => path.join(root, 'src', 'runtime', 'obsidian', 'service-main.mjs')
  const project = path.resolve(path.sep, 'srv', 'synthetic', 'harbor-notes', 'node_modules', '@mnstry', 'atelier')
  assert.equal(packageRootOfEntry(entry(project)), project)
  assert.equal(packageRootOfEntry(TEST_SERVICE_ENTRY), null)
  assert.equal(packageRootOfEntry('src/runtime/obsidian/service-main.mjs'), null)
  assert.equal(packageRootOfEntry(path.join(project, 'src', 'runtime', 'other', 'service-main.mjs')), null)
})

// ---------------------------------------------------------------------------
// 6. Which entry a login item runs
// ---------------------------------------------------------------------------

test('a login item runs the package installed for the project, by its path; without one, the command\'s own unless it is in a runner\'s cache or a temporary folder', async (t) => {
  const { resolveLoginItemEntry } = await loginItems()
  const root = path.resolve(path.sep, 'srv', 'synthetic')
  const entryIn = (base) => path.join(base, 'node_modules', '@mnstry', 'atelier', 'src', 'runtime', 'obsidian', 'service-main.mjs')
  const project = { configDir: path.join(root, 'harbor-notes') }
  const only = (...files) => (file) => files.includes(file)
  const stable = entryIn(path.resolve(path.sep, 'usr', 'local', 'lib'))
  assert.deepEqual(resolveLoginItemEntry({ project, ownEntry: stable, temporary: [], exists: only(entryIn(project.configDir)) }), { entryPath: entryIn(project.configDir), source: 'project' })
  assert.deepEqual(resolveLoginItemEntry({ project, ownEntry: stable, temporary: [], exists: only(entryIn(root)) }), { entryPath: entryIn(root), source: 'project' }, 'as Node finds it: in a folder above too')
  assert.deepEqual(resolveLoginItemEntry({ project, ownEntry: stable, temporary: [], exists: only() }), { entryPath: stable, source: 'command' })
  const npx = entryIn(path.join(root, 'home', '.npm', '_npx', '0a1b2c'))
  const temporary = path.join(root, 'tmp')
  for (const transient of [npx, entryIn(path.join(temporary, 'agent'))]) {
    assert.throws(() => resolveLoginItemEntry({ project, ownEntry: transient, temporary: [temporary], exists: only() }), (error) => error.code === 'login-item-needs-installed-package', transient)
    assert.equal(resolveLoginItemEntry({ project, ownEntry: transient, temporary: [temporary], exists: only(entryIn(project.configDir)) }).source, 'project', 'the project\'s own package wins over a transient command')
  }
  if (!POSIX_HERE) return
  // A linked install is named through its link, so pointing the link elsewhere is what the next start runs.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(TMP, 'atelier-linked-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const checkout = path.join(dir, 'checkout')
  fs.mkdirSync(path.join(checkout, 'src', 'runtime', 'obsidian'), { recursive: true })
  fs.writeFileSync(path.join(checkout, 'src', 'runtime', 'obsidian', 'service-main.mjs'), '')
  fs.mkdirSync(path.join(dir, 'project', 'node_modules', '@mnstry'), { recursive: true })
  fs.symlinkSync(checkout, path.join(dir, 'project', 'node_modules', '@mnstry', 'atelier'))
  assert.equal(resolveLoginItemEntry({ project: { configDir: path.join(dir, 'project') }, ownEntry: stable, temporary: [] }).entryPath, entryIn(path.join(dir, 'project')))
})

test('a live PID is proven to run the recorded entry by the path it was started by, when that path leads to the recorded one, and by nothing else', needsPosix, async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(TMP, 'atelier-alias-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const real = path.join(dir, 'real', 'service-main.mjs')
  fs.mkdirSync(path.dirname(real))
  fs.writeFileSync(real, 'entry')
  fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'linked'))
  const linked = path.join(dir, 'linked', 'service-main.mjs')
  const record = { pid: 4242, runtimeId: 'rt-a', executable: { path: real, digest: sha256('entry'), ext: { invokedAs: linked } } }
  const identityOf = (file) => ({ digest: sha256(fs.readFileSync(file)) })
  assert.equal(processRunsRecordedExecutable(record, { commandLineOf: () => ['node', linked, '--startup'], identityOf }), true)
  assert.equal(processRunsRecordedExecutable(record, { commandLineOf: () => `node ${linked} --startup`, identityOf }), true)
  assert.equal(processRunsRecordedExecutable({ ...record, executable: { ...record.executable, ext: { invokedAs: path.join(dir, 'other.mjs') } } }, { commandLineOf: () => ['node', path.join(dir, 'other.mjs')], identityOf }), false, 'a path that does not lead to the recorded entry proves nothing')
  assert.equal(commandLineNamesRecord(['node', linked], record), false, 'the pure check names only what it is given')
})

// A listener on the recorded port that has written no record, as the service a manager has just started is for a
// moment (it listens before it records itself). `close()` ends it.
async function silentListener(t, port) {
  const server = net.createServer((socket) => socket.destroy())
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port }, resolve) })
  const close = () => new Promise((resolve) => { server.close(() => resolve()) })
  t.after(close)
  return { close }
}

test('a service a login item started that is busy in its first tick is waited for until it is healthy, as a child started here is', needsPosix, async (t) => {
  const world = await makeWorld(t, { withLaunchd: false })
  serviceSettings(world, await freePort(), 'service-and-startup')
  const loginItem = {
    async start() {
      follow(t, childProcess.spawn(process.execPath, entryWords(world, ['--startup', `--interval-ms=${IDLE_INTERVAL}`, '--first-tick-block-ms=2500']), { env: world.env, stdio: 'ignore', windowsHide: true }), 'the service a manager started')
      return { ok: true, entryPath: TEST_SERVICE_ENTRY }
    },
  }
  const started = await startService(world.lifecycle({ entryPath: TEST_SERVICE_ENTRY, loginItem, spawn: forbiddenSpawn, probeTimeoutMs: 200, startTimeoutMs: 20000 }))
  assert.deepEqual([started.state, started.started, started.busy ?? false, started.loginItem], ['healthy', true, false, { via: 'login-item' }])
  assert.equal((await stopService(world.lifecycle({ stopTimeoutMs: 10000 }))).stopped, true)
})

test('with a login item, a listener that has not recorded itself yet is waited for as the service its manager is starting, and only a runtime that proves itself is taken', needsPosix, async (t) => {
  const world = await makeWorld(t, { withLaunchd: false })
  const port = await freePort()
  serviceSettings(world, port, 'service-and-startup')
  const listener = await silentListener(t, port)
  // The manager's start: the process that listened goes, and the real service comes up on the port, as launchd starts it.
  const loginItem = {
    async start() {
      await listener.close()
      follow(t, childProcess.spawn(process.execPath, entryWords(world, ['--startup', `--interval-ms=${IDLE_INTERVAL}`]), { env: world.env, stdio: 'ignore', windowsHide: true }), 'the service a manager started')
      return { ok: true, entryPath: TEST_SERVICE_ENTRY }
    },
  }
  const started = await startService(world.lifecycle({ entryPath: TEST_SERVICE_ENTRY, loginItem, spawn: forbiddenSpawn }))
  assert.deepEqual([started.state, started.started, started.loginItem], ['healthy', true, { via: 'login-item' }])
  assert.equal(started.record.pid, world.record().pid)
  // Without a login item the same silent listener is occupied, and nothing is started.
  assert.equal((await stopService(world.lifecycle({ stopTimeoutMs: 10000 }))).stopped, true)
  const again = await silentListener(t, port)
  await assert.rejects(startService(world.lifecycle({ entryPath: TEST_SERVICE_ENTRY, spawn: forbiddenSpawn })), (error) => error.code === 'service-port-occupied')
  await again.close()
})

// ---------------------------------------------------------------------------
// 7. Through the command: install, start through it, refresh, remove, uninstall
// ---------------------------------------------------------------------------

const commandTest = async () => (POSIX_HERE && await entryIsStable() ? {} : { skip: POSIX_HERE ? 'the test entry lies in a temporary folder here, which a login item refuses to name' : needsPosix.skip })

test('service unit --install records the consent that covers startup first, installs the unit, and the service runs as the unit starts it', await commandTest(), async (t) => {
  const world = await makeWorld(t)
  const installed = await world.run(['service', 'unit', '--install', '--json', '--consent-actor', CONSENT_ACTOR])
  assert.equal(installed.exit, EXIT.ok, installed.stdout)
  const label = `ai.mnstry.atelier.harbor-notes.${WORKSPACE_ID}`
  const file = path.join(world.launchd.directory, `${label}.plist`)
  assert.deepEqual([installed.json.loginItem.installed, installed.json.loginItem.label, installed.json.loginItem.file, installed.json.loginItem.entry], [true, label, file, { path: TEST_SERVICE_ENTRY, source: 'command' }])
  assert.equal(world.settings().consent.coverage, 'service-and-startup')
  const unit = readPlist(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(unit.words.slice(1), [TEST_SERVICE_ENTRY, '--startup', `--project=${world.configPath}`, `--data-root=${world.dataRoot}`, `--interval-ms=${IDLE_INTERVAL}`])
  assert.equal(unit.words[0], fs.realpathSync(process.execPath))
  assert.equal(unit.cwd, '/')
  // The service that answers is the one the unit started, and startService started nothing beside it.
  const job = world.launchd.job(label)
  assert.ok(['healthy', 'busy'].includes(installed.json.service.state), installed.json.service.state)
  await world.healthy()
  assert.deepEqual([world.record().pid, job.runs], [job.child.pid, 1])
  const record = world.loginItem()
  assert.deepEqual([record.schema, record.label, record.file, record.digest, record.program.entry], ['atelier-obsidian-login-item/v1', label, file, sha256(fs.readFileSync(file)), TEST_SERVICE_ENTRY])
  if (POSIX_HERE) assert.equal(fs.statSync(servicePaths(world.workspace().workspaceRoot).loginItem).mode & 0o777, 0o600)

  const status = await world.run(['status'])
  assert.ok(status.stdout.includes(`login item: on (running); ${file}`), status.stdout)
  const printed = await world.run(['service', 'unit', '--print', '--json'])
  assert.deepEqual([printed.json.installed, printed.json.unit.text], [true, fs.readFileSync(file, 'utf8')], '--print shows what is installed')
  // Installed again: the same label, the same file, reloaded.
  const again = await world.run(['service', 'unit', '--install', '--json'])
  assert.deepEqual([again.exit, again.json.loginItem.label, world.loginItem().installedAt], [EXIT.ok, label, record.installedAt], 'a recorded consent that covers startup is enough the second time')
})

test('without a consent that covers startup nothing is installed; on Windows a login item is not offered', await commandTest(), async (t) => {
  const world = await makeWorld(t)
  const before = listing(world.dir)
  const refused = await world.run(['service', 'unit', '--install', '--json'])
  assert.deepEqual([refused.exit, refused.json.error.code, world.launchd.calls], [EXIT.refused, 'startup-consent-required', []])
  const windows = await world.run(['service', 'unit', '--install', '--json', '--consent-actor', CONSENT_ACTOR], { platform: 'win32' })
  assert.deepEqual([windows.exit, windows.json.error.code, world.launchd.calls], [EXIT.refused, 'startup-platform-unqualified', []])
  const after = listing(world.dir)
  assert.deepEqual(Object.keys(after).filter((key) => !Object.hasOwn(before, key)).filter((key) => !key.endsWith('/')), [], 'no file was written')
  // A command that runs from a package runner's cache, in a project with no package installed, installs nothing either.
  const npx = await world.run(['service', 'unit', '--install', '--json', '--consent-actor', CONSENT_ACTOR], { seams: world.seams({ service: { entryPath: path.join(world.dir, '.npm', '_npx', 'a1', 'node_modules', '@mnstry', 'atelier', 'src', 'runtime', 'obsidian', 'service-main.mjs'), entryArgs: [], spawn: forbiddenSpawn } }) })
  assert.deepEqual([npx.exit, npx.json.error.code, world.launchd.calls], [EXIT.refused, 'login-item-needs-installed-package', []])
  assert.equal(world.settings(), null, 'and no consent was recorded')
})

test('once installed, a stopped service is started through the login item, and a unit that differs from what would be written now is refreshed on the way', await commandTest(), async (t) => {
  const world = await makeWorld(t)
  assert.equal((await world.run(['service', 'unit', '--install', '--json', '--consent-actor', CONSENT_ACTOR])).exit, EXIT.ok)
  const label = `ai.mnstry.atelier.harbor-notes.${WORKSPACE_ID}`
  const job = world.launchd.job(label)
  assert.equal((await stopAskingAgain(world)).stopped, true)
  await waitFor(() => job.child === null, { label: 'the unit\'s process to end' })
  assert.deepEqual([job.exits.at(-1), job.runs], [0, 1], 'a clean stop exits 0, and the manager does not start it again')

  const started = await world.run(['service', 'start', '--json'])
  assert.deepEqual([started.exit, started.json.service.started, started.json.service.loginItem, job.runs], [EXIT.ok, true, { via: 'login-item' }, 2])

  // The node the unit names is gone (a version manager removed it): `open` writes the unit again and says so.
  assert.equal((await stopAskingAgain(world)).stopped, true)
  await waitFor(() => job.child === null, { label: 'the unit\'s process to end' })
  const file = path.join(world.launchd.directory, `${label}.plist`)
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(fs.realpathSync(process.execPath), '/opt/removed/node'))
  const opened = await world.run(['open'])
  assert.match(opened.stderr, /login item refreshed/)
  assert.equal(readPlist(fs.readFileSync(file, 'utf8')).words[0], fs.realpathSync(process.execPath))
  assert.deepEqual([world.loginItem().digest, (await serviceStatus(world.lifecycle())).state], [sha256(fs.readFileSync(file)), 'healthy'])
  assert.ok(world.launchd.calls.includes(`bootout gui/501/${label}`) && world.launchd.calls.includes(`kickstart -p gui/501/${label}`))
})

// `service stop`, asked again while the service answers that it is busy in a long tick (`retry: true`), as its answer
// says to: a first tick under load can hold health past the probe's timeout. Any other refusal is answered at once.
async function stopAskingAgain(world) {
  let last = null
  await waitFor(async () => { last = (await world.run(['service', 'stop', '--json'])).json.service; return last.stopped === true || last.retry !== true }, { label: 'the service to stop' })
  return last
}

// An earlier release: the same service entry with other bytes, as a child `start` made before an upgrade runs it.
function earlierReleaseEntry(world) {
  const earlier = path.join(world.dir, 'earlier-release', 'service-entry.mjs')
  fs.mkdirSync(path.dirname(earlier))
  fs.writeFileSync(earlier, `${fs.readFileSync(TEST_SERVICE_ENTRY, 'utf8').replaceAll("'../../../src/", `'${new URL('../src/', import.meta.url).href}`)}\n// an earlier release\n`)
  return earlier
}

test('an outdated service is replaced through the login item: at --install before the unit is loaded, and by open once it is, never beside it', await commandTest(), async (t) => {
  const world = await makeWorld(t)
  const earlier = earlierReleaseEntry(world)
  // The first start records a consent for the service alone; a later one runs under the consent recorded then.
  const runEarlier = async (consent = undefined) => {
    const outdated = await startService(world.lifecycle({ entryPath: earlier, ...(consent === undefined ? {} : { consent }), detached: true, spawn: followingSpawn(t), intervalMs: IDLE_INTERVAL }))
    assert.equal(outdated.state, 'healthy')
    return outdated
  }
  // Installed while an earlier release runs: it is stopped once the consent is recorded, before the unit is loaded, so
  // the unit's own start at load runs the installed entry.
  const first = await runEarlier({ actor: CONSENT_ACTOR, coverage: 'service' })
  const installed = await world.run(['service', 'unit', '--install', '--json', '--consent-actor', CONSENT_ACTOR])
  assert.deepEqual([installed.exit, installed.json.service.replaced], [EXIT.ok, 'outdated'], installed.stdout)
  const label = `ai.mnstry.atelier.harbor-notes.${WORKSPACE_ID}`
  const job = world.launchd.job(label)
  const atLoad = await world.healthy()
  assert.deepEqual([isAlive(first.record.pid), atLoad.record.executable.digest, atLoad.record.pid, job.runs, world.lastStartup().outcome], [false, sha256(fs.readFileSync(TEST_SERVICE_ENTRY)), job.child.pid, 1, 'started'])
  // Once it is loaded: an earlier release started beside it (by another installation, say) is replaced by open,
  // stopped as its owner stops it and started again by the manager.
  assert.equal((await stopAskingAgain(world)).stopped, true)
  await waitFor(() => job.child === null, { label: 'the unit\'s process to end' })
  const second = await runEarlier()
  const opened = await world.run(['open', '--json'])
  assert.equal(opened.json.service.restarted, 'outdated', opened.stdout)
  const current = world.record()
  assert.deepEqual([current.executable.digest, current.pid, job.runs], [sha256(fs.readFileSync(TEST_SERVICE_ENTRY)), job.child.pid, 2], 'the manager started the installed entry; startService started no child')
  assert.equal(isAlive(second.record.pid), false, 'the earlier service was stopped')
})

test('a login item whose package is gone says so in status, and the next start writes it again for the entry of now', await commandTest(), async (t) => {
  const world = await makeWorld(t)
  assert.equal((await world.run(['service', 'unit', '--install', '--json', '--consent-actor', CONSENT_ACTOR])).exit, EXIT.ok)
  const label = `ai.mnstry.atelier.harbor-notes.${WORKSPACE_ID}`
  const job = world.launchd.job(label)
  assert.equal((await stopAskingAgain(world)).stopped, true)
  await waitFor(() => job.child === null, { label: 'the unit\'s process to end' })
  // The package the unit and the record name was removed (the project's node_modules deleted, say).
  const gone = path.join(world.dir, 'removed', 'node_modules', '@mnstry', 'atelier', 'src', 'runtime', 'obsidian', 'service-main.mjs')
  const file = path.join(world.launchd.directory, `${label}.plist`)
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(`<string>${TEST_SERVICE_ENTRY}</string>`, `<string>${gone}</string>`))
  const record = world.loginItem()
  fs.writeFileSync(servicePaths(world.workspace().workspaceRoot).loginItem, `${JSON.stringify({ ...record, program: { ...record.program, entry: gone }, digest: sha256(fs.readFileSync(file)) }, null, 2)}\n`)
  const status = await world.run(['status', '--json'])
  assert.equal(status.json.loginItem.programPresent, false)
  assert.match((await world.run(['status'])).stdout, /login item: installed, but the Node or the package it runs is gone, so it cannot start/)
  const started = await world.run(['service', 'start', '--json'])
  assert.deepEqual([started.exit, started.json.service.loginItem], [EXIT.ok, { via: 'login-item', refreshed: true }])
  assert.deepEqual([readPlist(fs.readFileSync(file, 'utf8')).words[1], world.loginItem().program.entry, (await world.run(['status', '--json'])).json.loginItem.programPresent], [TEST_SERVICE_ENTRY, TEST_SERVICE_ENTRY, true])
})

test('a refusal under the login item is answered at once with its code, is not retried in a loop, and status says why', await commandTest(), async (t) => {
  const world = await makeWorld(t)
  assert.equal((await world.run(['service', 'unit', '--install', '--json', '--consent-actor', CONSENT_ACTOR])).exit, EXIT.ok)
  const label = `ai.mnstry.atelier.harbor-notes.${WORKSPACE_ID}`
  const job = world.launchd.job(label)
  assert.equal((await stopAskingAgain(world)).stopped, true)
  await waitFor(() => job.child === null, { label: 'the unit\'s process to end' })
  // The consent is lowered behind the item's back: its start is refused.
  const current = world.settings()
  writeServiceSettings({ ...world.workspace(), settings: { ...current, consent: { ...current.consent, coverage: 'service' } } })
  // The reason can only come from the refusal the service recorded: a start that waited out its deadline says
  // health-never-proved-ownership instead.
  const started = await world.run(['service', 'start', '--json'])
  assert.deepEqual([started.exit, started.json.service.state, started.json.service.reason], [EXIT.notSuccess, 'start-failed', 'startup-consent-absent'])
  await waitFor(() => job.child === null, { label: 'the refused process to end' })
  await sleep(500)
  assert.deepEqual([job.exits.at(-1), job.runs, job.child], [0, 2, null], 'it exited 0 and was not started again')
  const status = await world.run(['status'])
  assert.match(status.stdout, /the login item did not start the service: startup-consent-absent/)
  assert.match(status.stdout, /Next: install it again with `atelier obsidian service unit --install --consent-actor ID`/)
})

test('a package upgraded under a service the login item started: it exits 75 after a tick and its manager starts the new release', await commandTest(), async (t) => {
  const root = await syntheticPackage(t)
  const world = await makeWorld(t, { entryArgs: ['--interval-ms=100', `--release-root=${root}`] })
  assert.equal((await world.run(['service', 'unit', '--install', '--json', '--consent-actor', CONSENT_ACTOR])).exit, EXIT.ok)
  const job = world.launchd.job(`ai.mnstry.atelier.harbor-notes.${WORKSPACE_ID}`)
  const first = world.record()
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'synthetic', version: '1.0.1' }))
  const second = await waitFor(() => { const record = world.record(); return record && record.runtimeId !== first.runtimeId ? record : null }, { label: 'the service of the new release' })
  assert.deepEqual([job.exits[0], job.runs, second.pid === job.child.pid], [75, 2, true])
  assert.equal((await world.healthy()).record.runtimeId, second.runtimeId)
})

test('a login item its manager does not have loaded is not forced: the service is started for this command only, and the answer says why', await commandTest(), async (t) => {
  const world = await makeWorld(t)
  assert.equal((await world.run(['service', 'unit', '--install', '--json', '--consent-actor', CONSENT_ACTOR])).exit, EXIT.ok)
  const label = `ai.mnstry.atelier.harbor-notes.${WORKSPACE_ID}`
  await world.launchd.bootoutBehindTheBack(label)
  world.launchd.disable(label)
  await waitFor(async () => (await serviceStatus(world.lifecycle())).state !== 'healthy', { label: 'the service to stop' })
  const started = await world.run(['service', 'start'], { seams: world.seams({ service: { entryPath: TEST_SERVICE_ENTRY, entryArgs: [`--interval-ms=${IDLE_INTERVAL}`], spawn: followingSpawn(t) } }) })
  assert.equal(started.exit, EXIT.ok, started.stderr)
  assert.match(started.stdout, /the login item did not start the service \(login-item-not-loaded\); it was started for this session only/)
  const status = await world.run(['status', '--json'])
  assert.deepEqual([status.json.loginItem.state, status.json.service.state], ['switched-off', 'healthy'])
  assert.match((await world.run(['status'])).stdout, /login item: installed, switched off in System Settings/)
})

test('service unit --remove lowers the consent first, unloads and deletes the unit, and starts the service again for this session as a process of its own', await commandTest(), async (t) => {
  const world = await makeWorld(t)
  assert.equal((await world.run(['service', 'unit', '--install', '--json', '--consent-actor', CONSENT_ACTOR])).exit, EXIT.ok)
  const label = `ai.mnstry.atelier.harbor-notes.${WORKSPACE_ID}`
  const job = world.launchd.job(label)
  const first = (await world.healthy()).record
  const seams = world.seams({ service: { entryPath: TEST_SERVICE_ENTRY, entryArgs: [`--interval-ms=${IDLE_INTERVAL}`], spawn: followingSpawn(t) } })
  const removed = await world.run(['service', 'unit', '--remove', '--json'], { seams })
  assert.deepEqual([removed.exit, removed.json.loginItem.removed, removed.json.loginItem.file], [EXIT.ok, true, path.join(world.launchd.directory, `${label}.plist`)])
  assert.deepEqual([world.settings().consent.coverage, world.settings().consent.actor, world.loginItem(), fs.existsSync(path.join(world.launchd.directory, `${label}.plist`))], ['service', CONSENT_ACTOR, null, false])
  assert.deepEqual([job.loaded, job.child, job.runs], [false, null, 1], 'unloaded, and its manager does not start it again')
  assert.deepEqual([removed.json.service.state, removed.json.service.started], ['healthy', true], 'the service runs again at once')
  const record = world.record()
  assert.notEqual(record.runtimeId, first.runtimeId)
  assert.equal(isAlive(first.pid), false, 'the one the unit ran was stopped as it was unloaded')
  assert.deepEqual(record.consent.coverage, 'service', 'under the consent now recorded')
  const status = await world.run(['status'])
  assert.match(status.stdout, /login item: off/)
  const words = await world.run(['service', 'unit', '--remove'], { seams })
  assert.match(words.stdout, /no login item was installed/)
  const again = await world.run(['service', 'unit', '--remove', '--json'], { seams })
  assert.deepEqual([again.exit, again.json.loginItem.removed, again.json.service.started, world.record().runtimeId], [EXIT.ok, false, false, record.runtimeId], 'removing it twice changes nothing and starts nothing')
})

test('when no entry may be started, --remove removes the item and leaves the service to the next open', await commandTest(), async (t) => {
  const world = await makeWorld(t)
  assert.equal((await world.run(['service', 'unit', '--install', '--json', '--consent-actor', CONSENT_ACTOR])).exit, EXIT.ok)
  await world.healthy()
  // No entry this command may start (for the real entry: no --adapter given or remembered): the start is refused, typed.
  const removed = await world.run(['service', 'unit', '--remove', '--json'], { seams: world.seams({ service: {} }) })
  assert.deepEqual([removed.exit, removed.json.loginItem.removed, removed.json.service.started, removed.json.service.reason], [EXIT.ok, true, false, 'seams-required'])
  assert.match((await world.run(['service', 'unit', '--remove'], { seams: world.seams({ service: {} }) })).stdout, /no login item was installed/)
  assert.notEqual((await serviceStatus(world.lifecycle())).state, 'healthy')
})

test('installing, removing and uninstalling remember the answer as the loginItem decision, with who gave it', await commandTest(), async (t) => {
  const world = await makeWorld(t)
  const decision = async () => (await world.run(['settings', '--json'])).json.decisions.loginItem
  assert.equal(await decision(), null)
  const installed = await world.run(['service', 'unit', '--install', '--json', '--consent-actor', CONSENT_ACTOR])
  assert.deepEqual([installed.json.rememberedNow.loginItem, await decision()], ['on', { choice: 'on', decidedAt: (await decision()).decidedAt, decidedBy: CONSENT_ACTOR, via: 'command' }])
  const seams = world.seams({ service: { entryPath: TEST_SERVICE_ENTRY, entryArgs: [`--interval-ms=${IDLE_INTERVAL}`], spawn: followingSpawn(t) } })
  // A program that names nobody: the answer is recorded, by nobody known.
  const removed = await world.run(['service', 'unit', '--remove', '--json'], { seams })
  assert.deepEqual([removed.json.rememberedNow.loginItem, (await decision()).choice, (await decision()).decidedBy], ['off', 'off', null])
  assert.match((await world.run(['settings'])).stdout, /^Change: `atelier obsidian service unit --install` starts maintenance at login/m)
  // A person at a terminal gives it by their account's name.
  const terminal = { terminal: { stdin: true, stdout: true }, account: () => 'harbor-person' }
  assert.equal((await world.run(['service', 'unit', '--install'], terminal)).exit, EXIT.ok)
  assert.deepEqual([(await decision()).choice, (await decision()).decidedBy], ['on', 'harbor-person'])
  assert.equal((await world.run(['uninstall'], terminal)).exit, EXIT.ok)
  assert.deepEqual([(await decision()).choice, (await decision()).decidedBy], ['off', 'harbor-person'])
})

test('at a terminal, --install needs no --consent-actor: the account\'s name allows maintenance at login, or the actor already recorded keeps it', await commandTest(), async (t) => {
  const world = await makeWorld(t)
  const terminal = { terminal: { stdin: true, stdout: true }, account: () => 'harbor-person' }
  const installed = await world.run(['service', 'unit', '--install'], terminal)
  assert.equal(installed.exit, EXIT.ok, installed.stderr)
  assert.match(installed.stdout, /Maintenance at login is allowed by harbor-person; recorded for this workspace\./)
  assert.deepEqual([world.settings().consent.actor, world.settings().consent.coverage], ['harbor-person', 'service-and-startup'])
  // Another workspace state: the consent recorded by somebody else for the service alone is raised, not replaced.
  const seams = world.seams({ service: { entryPath: TEST_SERVICE_ENTRY, entryArgs: [`--interval-ms=${IDLE_INTERVAL}`], spawn: followingSpawn(t) } })
  assert.equal((await world.run(['service', 'unit', '--remove', '--json'], { seams })).exit, EXIT.ok)
  const current = world.settings()
  writeServiceSettings({ ...world.workspace(), settings: { ...current, consent: { ...current.consent, actor: CONSENT_ACTOR } } })
  assert.equal((await world.run(['service', 'unit', '--install'], terminal)).exit, EXIT.ok)
  assert.deepEqual([world.settings().consent.actor, world.settings().consent.coverage], [CONSENT_ACTOR, 'service-and-startup'])
  // A program still names its actor.
  assert.equal((await world.run(['service', 'unit', '--remove', '--json'], { seams })).exit, EXIT.ok)
  const refused = await world.run(['service', 'unit', '--install', '--json'], terminal)
  assert.deepEqual([refused.exit, refused.json.error.code], [EXIT.refused, 'startup-consent-required'], '--json means nobody is at a terminal')
})

test('--install with --adapter remembers the adapter, as service start does', await commandTest(), async (t) => {
  const world = await makeWorld(t)
  const installed = await world.run(['service', 'unit', '--install', '--json', '--consent-actor', CONSENT_ACTOR, '--adapter=obsidian-cli'])
  assert.deepEqual([installed.exit, installed.json.rememberedNow.adapter], [EXIT.ok, true])
  assert.equal((await world.run(['settings', '--json'])).json.decisions.adapter.choice, 'obsidian-cli')
})

test('service start replaces a proven service of an earlier release, as open does, and leaves a current one running', needsPosix, async (t) => {
  const world = await makeWorld(t, { withLaunchd: false })
  const outdated = await startService(world.lifecycle({ entryPath: earlierReleaseEntry(world), consent: { actor: CONSENT_ACTOR, coverage: 'service' }, detached: true, spawn: followingSpawn(t), intervalMs: IDLE_INTERVAL }))
  assert.equal(outdated.state, 'healthy')
  const seams = world.seams({ service: { entryPath: TEST_SERVICE_ENTRY, entryArgs: [`--interval-ms=${IDLE_INTERVAL}`], spawn: followingSpawn(t) } })
  const started = await world.run(['service', 'start', '--json'], { seams })
  assert.deepEqual([started.exit, started.json.service.state, started.json.service.started, started.json.service.replaced], [EXIT.ok, 'healthy', true, 'outdated'], started.stdout)
  const current = world.record()
  assert.deepEqual([current.executable.digest, isAlive(outdated.record.pid), current.consent.actor], [sha256(fs.readFileSync(TEST_SERVICE_ENTRY)), false, CONSENT_ACTOR], 'the installed entry runs in its place, under the consent already recorded')
  // Control: a service of this release is not replaced.
  const again = await world.run(['service', 'start'], { seams })
  assert.match(again.stdout, /healthy \(already running\)/)
  assert.equal(world.record().runtimeId, current.runtimeId)
})

test('uninstall removes the login item and stops the proven service, keeps vaults, private state, the project file and Obsidian\'s list, and names each', await commandTest(), async (t) => {
  const world = await makeWorld(t)
  assert.equal((await world.run(['service', 'unit', '--install', '--json', '--consent-actor', CONSENT_ACTOR])).exit, EXIT.ok)
  const { workspaceRoot } = world.workspace()
  const vaults = path.join(workspaceRoot, 'vaults')
  await waitFor(async () => { const { document } = await readServiceStatusDocument(world.lifecycle()); return document?.loop.ticks >= 1 && !document.loop.ticking && fs.existsSync(path.join(vaults, FULL_SCOPE.scopeId)) }, { label: 'the first publication' })
  const obsidianSettings = path.join(world.home, 'Library', 'Application Support', 'obsidian')
  fs.mkdirSync(obsidianSettings, { recursive: true })
  fs.writeFileSync(path.join(obsidianSettings, 'obsidian.json'), JSON.stringify({ vaults: { a1: { path: path.join(vaults, FULL_SCOPE.scopeId), ts: 1, open: true } } }))
  const kept = () => ({ vaults: listing(vaults), project: listing(world.projectDir), obsidian: listing(obsidianSettings) })
  const before = kept()
  const result = await world.run(['uninstall', '--json'])
  assert.equal(result.exit, EXIT.ok, result.stdout)
  assert.deepEqual([result.json.loginItem.removed, world.loginItem(), (await serviceStatus(world.lifecycle())).state], [true, null, 'stopped'])
  assert.deepEqual(result.json.kept, { vaults: [path.join(vaults, FULL_SCOPE.scopeId)], privateState: workspaceRoot, projectFile: world.configPath, pointer: path.join(world.projectDir, '.atelier-local', 'obsidian.json'), obsidianList: path.join(obsidianSettings, 'obsidian.json') })
  assert.deepEqual(kept(), before, 'nothing kept was changed')
  const words = await world.run(['uninstall'])
  assert.equal(words.exit, EXIT.ok)
  assert.match(words.stdout, /login item: none was installed/)
  assert.ok(words.stdout.includes(`vault           ${path.join(vaults, FULL_SCOPE.scopeId)}`), words.stdout)
})

// ---------------------------------------------------------------------------
// 8. Nothing is left running
// ---------------------------------------------------------------------------

test('no process this suite started is left behind, and the production manager was never loaded here', async () => {
  const left = SPAWNED.filter((entry) => !entry.gone && entry.child.exitCode === null && entry.child.signalCode === null)
  for (const entry of left) await endChild(entry)
  assert.deepEqual(left.map((entry) => `${entry.pid} (${entry.how}) from "${entry.test}"`), [], 'every process was ended by the test that started it')
  assert.equal(globalThis[Symbol.for('mnstry.atelier.obsidian.production-service-manager-loaded')], undefined)
})
