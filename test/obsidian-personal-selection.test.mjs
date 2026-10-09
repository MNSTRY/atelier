import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import nodeTest, { after } from 'node:test'
import { fileURLToPath } from 'node:url'

// A person's confirmed selection, bound to the Obsidian maintenance engine: what is published follows the generation
// the person confirmed (selectPersonalGeneration), and nothing else. One invented person, Ari, with two scratch
// repositories (a and b), a private home made through the personal-workspace module's own API, outside every Git
// worktree, mode 0700, a scratch HOME and a data root. Who may see the vaults is written as a fixture, as the binding
// never decides it. No app, no socket: the editor adapter is absent and nothing here listens.
//
// Nothing here may start the installed app, its command-line tool, an operating-system opener or a service manager.
const BANNED_PROGRAMS = ['obsidian-cli', 'obsidian', 'open', 'xdg-open', 'launchctl', 'systemctl']
const programName = (command) => path.basename(String(command).replaceAll('\\', '/')).toLowerCase().replace(/\.(exe|app|cmd|bat)$/, '')
for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
  const original = childProcess[method]
  childProcess[method] = function guarded(command, args, ...rest) {
    const words = (method === 'exec' || method === 'execSync' ? String(command).split(/\s+/) : [command, ...(Array.isArray(args) ? args : [])]).map(String)
    if (BANNED_PROGRAMS.includes(programName(words[0])) || words.some((word) => /obsidian:\/\/|--adapter=obsidian-cli/i.test(word))) throw new Error(`spawn guard: this suite may never start "${programName(words[0])}"`)
    return original.call(this, command, args, ...rest)
  }
}
syncBuiltinESMExports()

// The personal-workspace module refuses ambient Git variables: the whole file runs under a sanitized environment.
const AMBIENT = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^GIT_/i.test(name) || /^MNSTRY_ATELIER_/.test(name) || ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'].includes(name)))
for (const name of Object.keys(AMBIENT)) delete process.env[name]
const SCRATCH = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-ps-obsidian-')))
fs.chmodSync(SCRATCH, 0o700)
process.env.HOME = path.join(SCRATCH, 'home')
process.env.XDG_CONFIG_HOME = path.join(SCRATCH, 'home', '.config')
fs.mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true, mode: 0o700 })
after(() => {
  fs.rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  for (const name of Object.keys(process.env)) if (/^GIT_/i.test(name) || ['HOME', 'XDG_CONFIG_HOME'].includes(name)) delete process.env[name]
  Object.assign(process.env, AMBIENT)
})

const {
  MANIFEST_SCHEMA, OVERLAY_SCHEMA, composePersonalWorkspace, materializePersonalGeneration, planPersonalGeneration, planPersonalRestore, readPersonalSelectionHead, resolvePersonalWorkspace,
  restorePersonalInputs, selectPersonalGeneration, selectionConfirmDigest,
} = await import('@mnstry/atelier/personal-workspace')
const { createEditorAdapter, resolveExchange } = await import('../src/projection/obsidian/publication/index.mjs')
const { createMaintenanceEngine } = await import('../src/runtime/obsidian/engine.mjs')
const { ObsidianMaintenanceRefusal } = await import('../src/runtime/obsidian/errors.mjs')
const { ONLY_YOU_AUDIENCES, defaultMachineSettings, ensureWorkspaceIdentity, protectedRoots, withDecision, workspaceStateRoot, writeMachineSettings } = await import('../src/runtime/obsidian/machine-settings.mjs')
const { createProductionSeams } = await import('../src/runtime/obsidian/pipeline.mjs')
const { createMaintenanceStateStore } = await import('../src/runtime/obsidian/state-store.mjs')
const { bindPersonalWorkspace, createPersonalWorkspaceBinderForOracleTests, personalSelectionOf } = await import('../src/projection/obsidian/personal-workspace.mjs')
const { SELECTION_PRIMITIVES, loadSelectedProject, loadSelectedProjectOffThread, locatePersonalHome } = await import('../src/runtime/obsidian/personal-selection.mjs')
const { resolveServiceWorkspace, runMaintenanceService, serviceWorkspaceInputs } = await import('../src/runtime/obsidian/service.mjs')
const { createViewPermission } = await import('../src/runtime/obsidian/view-permission.mjs')
const { serviceOptionsFromArgv } = await import('../src/runtime/obsidian/service-main.mjs')
const { planLoginItem } = await import('../src/runtime/obsidian/login-item.mjs')
const { readLastStartup } = await import('../src/runtime/obsidian/service-record.mjs')
const { EXIT, FLAGS, runObsidianCommandForOracleTests } = await import('../src/commands/obsidian.mjs')

const EXCHANGE_HERE = (() => { try { resolveExchange({}); return true } catch { return false } })()
const test = (name, fn) => nodeTest(name, {
  skip: process.platform === 'win32' ? 'private-root qualification is POSIX-only in the personal-workspace module'
    : !EXCHANGE_HERE ? 'no atomic exchange on this platform: the publisher refuses, which the recovery suite asserts' : false,
}, fn)

const NOW = '2026-01-05T10:00:00.000Z'
const clock = () => new Date(NOW)
const noteText = ({ id, title, body }) => `---\ntitle: "${title}"\nkg:\n  id: "${id}"\n  type: "document"\n  status: "active"\n  audience: "team"\n---\n\n# ${title}\n\n${body}\n`
const SHARED_A = {
  'notes/harbor.md': noteText({ id: 'a:harbor', title: 'Harbor', body: 'Shared harbor note.' }),
  'notes/tide.md': noteText({ id: 'a:tide', title: 'Tide', body: 'Tide tables follow the [[Harbor]].' }),
}
const SHARED_B = { 'notes/ledger.md': noteText({ id: 'b:ledger', title: 'Ledger', body: 'LEDGER_7f3a ledger entries.' }) }
const git = (cwd, args) => childProcess.execFileSync('git', ['-c', 'user.name=Synthetic Author', '-c', 'user.email=author@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }, stdio: ['ignore', 'pipe', 'pipe'] })
const absentAdapter = () => createEditorAdapter({ call: async () => { throw new Error('no app') }, processProbe: () => 'absent', kind: 'absent' })
// A binder that composes in this thread, so a tick does not wait on a worker; production loaders compose in one.
const inThread = () => createPersonalWorkspaceBinderForOracleTests({ compose: (input) => composePersonalWorkspace(input) })
const refusedWith = (code) => (error) => error instanceof ObsidianMaintenanceRefusal && error.code === code && error.detail?.source === 'personal-workspace'

function makeRepository(base, name, files) {
  const root = path.join(base, 'shared', name)
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true })
    fs.writeFileSync(path.join(root, relative), content)
  }
  git(root, ['init', '-q'])
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', 'synthetic fixture'])
  return root
}

// Ari: a private home with a generation materialized from its authored inputs and nothing confirmed yet, a workspace
// pointer in the home, and machine settings deciding "only you" (written as a fixture: the binding decides no audience).
function makePerson(t) {
  const base = path.join(SCRATCH, `world-${Math.random().toString(16).slice(2, 10)}`)
  fs.mkdirSync(base, { mode: 0o700 })
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
  const a = makeRepository(base, 'a', SHARED_A)
  const b = makeRepository(base, 'b', SHARED_B)
  const home = path.join(base, 'home-ari')
  fs.mkdirSync(home, { mode: 0o700 })
  const person = {
    base, a, b, home, dataRoot: path.join(base, 'data'), randomBytes: (size) => Buffer.alloc(size, 0x0a),
    manifest: { schema: MANIFEST_SCHEMA, workspaceId: 'ari', revision: 1, bindings: [a], repos: [{ repoId: 'a', root: a, remote: null, enrolled: true }, { repoId: 'b', root: b, remote: null, enrolled: true }] },
    overlay: {
      schema: OVERLAY_SCHEMA, workspaceId: 'ari', connections: [], collections: [], preferences: {},
      annotations: [{ id: 'harbor-thought', target: { repoId: 'a', nodeId: 'a:harbor' }, note: 'ARI_51c2 the harbor matters most.' }],
      views: [{ id: 'harbor-only', name: 'Harbor only', repoIds: ['a'] }, { id: 'both', name: 'Both', repoIds: ['a', 'b'] }],
    },
  }
  person.save = () => {
    fs.writeFileSync(path.join(home, 'atelier.personal.json'), JSON.stringify(person.manifest))
    fs.writeFileSync(path.join(home, 'atelier.overlay.json'), JSON.stringify(person.overlay))
  }
  person.materialize = () => {
    person.save()
    person.generationId = materializePersonalGeneration(planPersonalGeneration(resolvePersonalWorkspace({ folder: a, personalHome: home })), { personalHome: home }).generationId
    return person.generationId
  }
  // The person's explicit confirmation, as its command records it.
  person.select = (generationId = person.generationId) => selectPersonalGeneration({ personalHome: home, generationId, confirm: selectionConfirmDigest({ generationId, previous: readPersonalSelectionHead({ personalHome: home }).head }) })
  person.record = (sequence) => path.join(home, 'selections', `${String(sequence).padStart(6, '0')}.json`)
  person.load = (options = {}) => loadSelectedProject({ personalHome: home }, { bind: inThread(), ...options })
  person.locate = () => locatePersonalHome({ personalHome: home })
  person.workspaceRoot = () => fs.realpathSync(workspaceStateRoot(person.dataRoot, person.workspaceId))
  person.vault = (scopeId) => path.join(person.workspaceRoot(), 'vaults', scopeId)
  person.freshness = () => createMaintenanceStateStore({ workspaceRoot: person.workspaceRoot(), workspaceId: person.workspaceId }).readFreshness()
  person.manifestOf = (scopeId) => {
    const directory = path.join(person.workspaceRoot(), 'state', 'manifests', scopeId)
    return JSON.parse(fs.readFileSync(path.join(directory, JSON.parse(fs.readFileSync(path.join(directory, 'current.json'), 'utf8')).manifestFile), 'utf8'))
  }
  person.noteFile = (scopeId, nodeId) => path.join(person.vault(scopeId), person.manifestOf(scopeId).notes.find((note) => note.nodeId === nodeId).path)
  // A command run with --personal-home and nothing else naming the project: the command's own loader and locator.
  person.command = async (argv) => {
    const out = []
    const exit = await runObsidianCommandForOracleTests({ argv: [...argv, `--personal-home=${home}`, '--json'], seams: {}, dataRoot: person.dataRoot, env: process.env, cwd: base, clock, contributions: [], stdout: (text) => out.push(text), stderr: (text) => out.push(text), account: () => 'person-synthetic' })
    return { exit, json: JSON.parse(out.join('\n')) }
  }
  person.engine = ({ rules, ...options } = {}) => createMaintenanceEngine({
    loadProject: () => person.load(rules === undefined ? {} : { rules }), dataRoot: person.dataRoot, adapterFactory: absentAdapter, clock, randomBytes: person.randomBytes, quietPeriodMs: 0, env: process.env, ...options,
  })
  person.materialize()
  const project = bindPersonalWorkspace({ personalHome: home, generationId: person.generationId }).project
  person.workspaceId = ensureWorkspaceIdentity({ project, randomBytes: person.randomBytes }).workspaceId
  const settings = withDecision({ ...defaultMachineSettings({ workspaceId: person.workspaceId, updatedAt: NOW }), audienceAllow: [...ONLY_YOU_AUDIENCES] }, 'audience', { choice: 'only-you', unclassified: 'withheld' }, { decidedAt: NOW, via: 'command' })
  writeMachineSettings({ workspaceRoot: workspaceStateRoot(person.dataRoot, person.workspaceId), workspaceId: person.workspaceId, repositoryRoots: protectedRoots(project), settings })
  return person
}
// An overlay change: the generation the person confirmed no longer holds, and the next one is not confirmed.
const reviseOverlay = (person) => { person.overlay.annotations[0].note += ' Revised.'; person.save() }
const everyView = (report, state, reason) => report.scopes.length === 3 && report.scopes.every((scope) => scope.state === state && (reason === undefined || scope.reason === reason))

test('nothing is published until a generation is confirmed; then the confirmed generation is, composed off the event loop', async (t) => {
  const ari = makePerson(t)
  const engine = ari.engine({ loadProject: () => loadSelectedProjectOffThread({ personalHome: ari.home }) })
  t.after(() => engine.stop())
  const none = await engine.tick()
  assert.deepEqual([none.state, none.refusal?.code, none.refusal?.detail?.source], ['refused', 'nothing-selected', 'personal-workspace'], JSON.stringify(none))
  assert.equal(fs.existsSync(path.join(ari.workspaceRoot(), 'vaults')), false, 'no vault is made')
  ari.select()
  const published = await engine.tick()
  assert.ok(everyView(published, 'current'), JSON.stringify(published.scopes))
  assert.ok(ari.manifestOf('both').notes.some((note) => note.nodeId === 'b:ledger'))
})

test('a head that moves while the generation is loaded refuses personal-selection-changed; mutation control: a loader that does not read it again loads under a record the history no longer ends with', async (t) => {
  const ari = makePerson(t)
  ari.select()
  // A confirmation that lands while the generation is composed: the same generation, confirmed again.
  let race = true
  const racing = createPersonalWorkspaceBinderForOracleTests({ compose: (input) => { const composed = composePersonalWorkspace(input); if (race) { race = false; ari.select() } return composed } })
  assert.throws(() => loadSelectedProject({ personalHome: ari.home }, { bind: racing }), refusedWith('personal-selection-changed'))
  race = true
  await assert.rejects(loadSelectedProjectOffThread({ personalHome: ari.home }, { bind: racing }), refusedWith('personal-selection-changed'))
  race = true
  const project = loadSelectedProject({ personalHome: ari.home }, { bind: racing, rules: { ...SELECTION_PRIMITIVES, readsHeadAgain: false } })
  assert.deepEqual([personalSelectionOf(project).sequence, readPersonalSelectionHead({ personalHome: ari.home }).sequence], [3, 4])
})

test('a history cut short is followed at the next tick; mutation control: unobserved, the engine goes on publishing a selection the history no longer holds', async (t) => {
  const ari = makePerson(t)
  ari.select()
  reviseOverlay(ari)
  ari.materialize()
  ari.select()
  const second = fs.readFileSync(ari.record(2))
  const cut = async (engine) => {
    assert.ok(everyView(await engine.tick(), 'current'))
    fs.rmSync(ari.record(2))
    const after = await engine.tick()
    fs.writeFileSync(ari.record(2), second)
    return after
  }
  // Mutation control: the records are not observed, and the cut goes unseen.
  const blind = ari.engine({ rules: { ...SELECTION_PRIMITIVES, pin: { observe: false } } })
  t.after(() => blind.stop())
  assert.ok(everyView(await cut(blind), 'current'), 'the oracle can fail')
  const engine = ari.engine()
  t.after(() => engine.stop())
  const vault = fs.readFileSync(ari.noteFile('everything', 'personal-ari:annotation-harbor-thought'), 'utf8')
  // The history now ends with the first record, whose generation the revised inputs no longer compose: nothing is published.
  const after = await cut(engine)
  assert.deepEqual([after.state, after.refusal?.code], ['refused', 'stale-generation'], JSON.stringify(after))
  assert.ok(ari.freshness().scopes.every((scope) => scope.state === 'stale' && scope.reason === 'stale-generation'))
  assert.equal(fs.readFileSync(ari.noteFile('everything', 'personal-ari:annotation-harbor-thought'), 'utf8'), vault, 'the vault keeps the last confirmed content')
  assert.match(vault, /Revised\./)
})

test('a confirmation during a tick refuses the view being published as mixed-read, and the next tick publishes under the new record', async (t) => {
  const ari = makePerson(t)
  ari.select()
  let confirmDuring = false
  const production = createProductionSeams()
  const engine = ari.engine({ seams: { publishView: (input) => { if (confirmDuring) { confirmDuring = false; ari.select() } return production.publishView(input) } } })
  t.after(() => engine.stop())
  assert.ok(everyView(await engine.tick(), 'current'))
  fs.writeFileSync(path.join(ari.a, 'notes', 'tide.md'), SHARED_A['notes/tide.md'].replace('Tide tables', 'Revised tide tables'))
  confirmDuring = true
  const during = await engine.tick()
  assert.ok(during.scopes.every((scope) => scope.state !== 'current') && during.scopes.some((scope) => scope.reason === 'mixed-read'), JSON.stringify(during.scopes))
  const next = await engine.tick()
  assert.ok(everyView(next, 'current'), JSON.stringify(next.scopes))
  assert.match(fs.readFileSync(ari.noteFile('everything', 'a:tide'), 'utf8'), /Revised tide tables/)
})

test('a restore publishes nothing until the restored generation is confirmed again', async (t) => {
  const ari = makePerson(t)
  const first = ari.generationId
  ari.select()
  reviseOverlay(ari)
  ari.materialize()
  ari.select()
  const engine = ari.engine()
  t.after(() => engine.stop())
  assert.ok(everyView(await engine.tick(), 'current'))
  const annotation = () => fs.readFileSync(ari.noteFile('everything', 'personal-ari:annotation-harbor-thought'), 'utf8')
  assert.match(annotation(), /Revised\./)
  const plan = planPersonalRestore({ personalHome: ari.home, generationId: first })
  restorePersonalInputs(plan, { personalHome: ari.home, confirm: plan.confirm })
  const restored = await engine.tick()
  assert.deepEqual([restored.state, restored.refusal?.code], ['refused', 'stale-generation'], JSON.stringify(restored))
  assert.match(annotation(), /Revised\./, 'the vault keeps the last confirmed content')
  ari.select(first)
  assert.ok(everyView(await engine.tick(), 'current'))
  assert.doesNotMatch(annotation(), /Revised\./)
})

test('a narrowing: a generated note of a source the confirmed selection drops leaves the vault for recovery, and a note the person edited is held, never removed or overwritten', async (t) => {
  const ari = makePerson(t)
  ari.select()
  const engine = ari.engine()
  t.after(() => engine.stop())
  assert.ok(everyView(await engine.tick(), 'current'))
  const edited = ari.noteFile('both', 'b:ledger')
  fs.writeFileSync(edited, fs.readFileSync(edited, 'utf8').replace('ledger entries.', 'ledger entries, edited in the vault.'))
  const editedBytes = fs.readFileSync(edited)
  const queued = await engine.tick()
  assert.ok(queued.pendingEdits.some((edit) => edit.scopeId === 'both'), JSON.stringify(queued.pendingEdits))
  const untouched = ari.noteFile('everything', 'b:ledger')
  // b is withdrawn and the narrower generation confirmed.
  ari.manifest.repos[1].enrolled = false
  ari.overlay.views = ari.overlay.views.map((view) => ({ ...view, repoIds: view.repoIds.filter((id) => id !== 'b') }))
  ari.materialize()
  ari.select()
  const narrowed = await engine.tick()
  const view = (scopeId) => narrowed.scopes.find((scope) => scope.scopeId === scopeId)
  assert.deepEqual([view('both').state, view('both').reason], ['held-for-your-edit', 'publication-withheld-for-your-edit'], JSON.stringify(narrowed.scopes))
  assert.deepEqual(fs.readFileSync(edited), editedBytes, 'the edited note is neither removed nor overwritten')
  assert.deepEqual([view('everything').state, view('harbor-only').state], ['current', 'current'])
  assert.equal(fs.existsSync(untouched), false, 'the generated note of the dropped source left the vault')
  assert.equal(ari.manifestOf('everything').notes.some((note) => note.repoId === 'b'), false)
  const recovered = []
  const walk = (directory) => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) walk(file); else if (fs.readFileSync(file).includes('LEDGER_7f3a')) recovered.push(file) } }
  for (const area of ['recovery', 'state']) walk(path.join(ari.workspaceRoot(), area))
  assert.ok(recovered.length > 0, 'its bytes are kept in private recovery state')
})

test('a selection record that is not a regular file refuses without waiting on it; mutation control: opened as before, a reader waits on it', (t) => {
  const ari = makePerson(t)
  ari.select()
  fs.rmSync(ari.record(1))
  childProcess.execFileSync('mkfifo', [ari.record(1)])
  // In a child, so a reader that waits cannot hold this runner.
  const run = (body) => childProcess.spawnSync(process.execPath, ['--input-type=module', '-e', body], { encoding: 'utf8', timeout: 20_000, env: { PATH: process.env.PATH, HOME: process.env.HOME } })
  const module = new URL('../src/personal-workspace/index.mjs', import.meta.url).href
  const read = run(`const { readPersonalSelectionHead } = await import(${JSON.stringify(module)}); try { readPersonalSelectionHead({ personalHome: ${JSON.stringify(ari.home)} }); console.log('read') } catch (error) { console.log(error.code) }`)
  assert.equal(read.stdout.trim(), 'selection-history-corrupt', read.stderr)
  const waited = run(`const fs = await import('node:fs'); fs.openSync(${JSON.stringify(ari.record(1))}, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); console.log('opened')`)
  assert.deepEqual([waited.status, waited.stdout], [null, ''], 'the oracle can fail: without O_NONBLOCK the open waits for a writer')
})

test('a history broken before its last record is refused at the next full reconciliation; mutation control: not read again, the views stay current', async (t) => {
  const ari = makePerson(t)
  ari.select()
  ari.select()
  const blind = ari.engine({ fullReconciliationIntervalMs: 0, rules: { ...SELECTION_PRIMITIVES, pin: { ...SELECTION_PRIMITIVES.pin, recheck: false } } })
  const engine = ari.engine({ fullReconciliationIntervalMs: 0 })
  t.after(() => { blind.stop(); engine.stop() })
  assert.ok(everyView(await blind.tick(), 'current'))
  assert.ok(everyView(await engine.tick(), 'current'))
  // The first record is no longer what the second links to, and neither record the engine observes changed.
  fs.appendFileSync(ari.record(1), ' ')
  assert.ok(everyView(await blind.tick(), 'current'), 'the oracle can fail')
  const full = await engine.tick()
  assert.equal(full.full, true)
  assert.ok(everyView(full, 'stale', 'selection-history-corrupt'), JSON.stringify(full.scopes))
  const next = await engine.tick()
  assert.deepEqual([next.state, next.refusal?.code], ['refused', 'selection-history-corrupt'], JSON.stringify(next))
})

test('a restart publishes the confirmed selection again; one while it is not confirmed tells every view why and keeps none current; mutation control: an engine that cannot locate the home leaves them current', async (t) => {
  const ari = makePerson(t)
  ari.select()
  const run = async (options) => { const engine = ari.engine(options); try { return await engine.tick() } finally { engine.stop() } }
  assert.ok(everyView(await run({ locateProject: ari.locate }), 'current'))
  assert.ok(everyView(await run({ locateProject: ari.locate }), 'current'), 'a new engine on the same selection')
  const annotation = ari.noteFile('everything', 'personal-ari:annotation-harbor-thought')
  const kept = fs.readFileSync(annotation)
  reviseOverlay(ari)
  // Mutation control: the load refuses before any project, and an engine without the locator finds no workspace to tell.
  const blind = await run({})
  assert.deepEqual([blind.state, blind.refusal?.code], ['refused', 'stale-generation'])
  assert.ok(ari.freshness().scopes.every((scope) => scope.state === 'current'), 'the oracle can fail: the previous run\'s freshness stands')
  const restarted = await run({ locateProject: ari.locate })
  assert.deepEqual([restarted.state, restarted.refusal?.code], ['refused', 'stale-generation'])
  const freshness = ari.freshness()
  assert.equal(freshness.enablement, 'refused')
  assert.ok(freshness.scopes.length === 3 && freshness.scopes.every((scope) => scope.state === 'stale' && scope.reason === 'stale-generation'), JSON.stringify(freshness.scopes))
  assert.deepEqual(fs.readFileSync(annotation), kept, 'the vault keeps the last confirmed content')
})

test('the service resolves its workspace from the home alone when its loader answers a promise; a bare promised loader, or a locator that answers one, is still refused at start', async (t) => {
  const unhandled = []
  const record = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', record)
  t.after(() => process.off('unhandledRejection', record))
  const ari = makePerson(t)
  let loads = 0
  const promised = () => { loads += 1; return loadSelectedProjectOffThread({ personalHome: ari.home }) }
  const start = (options) => runMaintenanceService({ dataRoot: ari.dataRoot, env: process.env, entryPath: path.join(ari.base, 'service-entry.mjs'), adapterFactory: absentAdapter, ...options })
  const refused = (code) => (error) => error instanceof ObsidianMaintenanceRefusal && error.code === code
  await assert.rejects(start({ loadProject: promised }), refused('service-loader-not-synchronous'))
  assert.equal(loads, 1)
  // Located from the home, the workspace is found with nothing selected, and the start stops at the next check: this
  // machine recorded no service settings for it. The loader is not asked.
  await assert.rejects(start({ loadProject: promised, locateProject: ari.locate }), refused('service-settings-absent'))
  assert.equal(loads, 1, 'the loader is not asked at start')
  await assert.rejects(start({ loadProject: promised, locateProject: () => Promise.resolve(ari.locate()) }), refused('service-loader-not-synchronous'))
  await assert.rejects(start({ loadProject: promised, locateProject: () => ({}) }), refused('service-locator-invalid'))
  assert.throws(() => locatePersonalHome({ personalHome: 'relative/home' }), refusedWith('path-not-absolute'))
  await new Promise((resolve) => { setImmediate(resolve) })
  assert.deepEqual(unhandled, [])
})

test('without --personal-home nothing changes: the service entry, the login item and the command name and load the project as before', () => {
  const home = path.join(SCRATCH, 'home-synthetic')
  const plain = serviceOptionsFromArgv(['--project=/srv/synthetic/harbor/atelier.project.json', '--adapter=obsidian-cli'])
  assert.deepEqual(Object.keys(plain), ['loadProject', 'startup', 'adapter'], 'no locator: the service resolves its workspace from the loader, as before')
  const bound = serviceOptionsFromArgv([`--personal-home=${home}`, '--adapter=obsidian-cli'])
  assert.deepEqual(Object.keys(bound), ['loadProject', 'locateProject', 'startup', 'adapter'])
  assert.equal(bound.locateProject().configDir, home)
  for (const argv of [[`--personal-home=${home}`, '--project=/srv/synthetic/harbor/atelier.project.json'], ['--personal-home=relative/home'], []]) {
    assert.throws(() => serviceOptionsFromArgv(argv), (error) => error.code === 'service-arguments-invalid', argv.join(' '))
  }
  const unit = (project) => planLoginItem({ platform: 'linux', project, workspaceRoot: path.join(SCRATCH, 'state'), workspaceId: 'ws-synthetic', dataRoot: '/srv/synthetic/data', label: 'atelier-obsidian-ws-synthetic', entryPath: '/srv/synthetic/service-main.mjs', nodePath: '/opt/synthetic/node' }).text
  const ordinary = unit({ configPath: '/srv/synthetic/harbor/atelier.project.json', configDir: '/srv/synthetic/harbor' })
  assert.ok(ordinary.includes('"--project=/srv/synthetic/harbor/atelier.project.json"') && !ordinary.includes('--personal-home'), ordinary)
  const located = unit(bound.locateProject())
  assert.ok(located.includes(`"--personal-home=${home}"`) && !located.includes('--project'), located)
  assert.equal(FLAGS['personal-home'], 'value')
})

test('each refusal is typed and publishes nothing: status names it, a new engine tells every view, and the service is still found from the home', async (t) => {
  const ari = makePerson(t)
  const nothing = await ari.command(['status'])
  assert.deepEqual([nothing.exit, nothing.json.error?.code], [EXIT.refused, 'nothing-selected'], JSON.stringify(nothing.json))
  // Located from the home alone, the service's own status answers whatever the selection.
  const service = await ari.command(['service', 'status'])
  assert.deepEqual([service.exit, service.json.service?.state], [EXIT.ok, 'stopped'], JSON.stringify(service.json))
  const usage = await ari.command(['status', '--project', path.join(ari.base, 'atelier.project.json')])
  assert.deepEqual([usage.exit, usage.json.error?.code], [EXIT.refused, 'usage'])
  ari.select()
  const shown = await ari.command(['status'])
  assert.deepEqual([shown.exit, shown.json.selection], [EXIT.ok, { generationId: ari.generationId, sequence: 1 }], JSON.stringify(shown.json))
  const engine = ari.engine({ locateProject: ari.locate })
  assert.ok(everyView(await engine.tick(), 'current'))
  engine.stop()
  const annotation = ari.noteFile('everything', 'personal-ari:annotation-harbor-thought')
  const kept = fs.readFileSync(annotation)
  const refusedEverywhere = async (code) => {
    const status = await ari.command(['status'])
    assert.deepEqual([status.exit, status.json.error?.code], [EXIT.refused, code], JSON.stringify(status.json))
    const fresh = ari.engine({ locateProject: ari.locate })
    const ticked = await fresh.tick()
    fresh.stop()
    assert.deepEqual([ticked.state, ticked.refusal?.code], ['refused', code], JSON.stringify(ticked))
    assert.ok(ari.freshness().scopes.every((scope) => scope.state === 'stale' && scope.reason === code), JSON.stringify(ari.freshness().scopes))
    assert.deepEqual(fs.readFileSync(annotation), kept, `${code}: the vault keeps the last confirmed content`)
  }
  const note = ari.overlay.annotations[0].note
  reviseOverlay(ari)
  await refusedEverywhere('stale-generation')
  ari.overlay.annotations[0].note = note
  ari.save()
  const record = fs.readFileSync(ari.record(1))
  fs.appendFileSync(ari.record(1), ' ')
  await refusedEverywhere('selection-history-corrupt')
  fs.writeFileSync(ari.record(1), record)
  if (process.getuid?.() !== 0) {
    const selections = path.dirname(ari.record(1))
    fs.chmodSync(selections, 0o000)
    try { await refusedEverywhere('personal-home-unavailable') } finally { fs.chmodSync(selections, 0o700) }
  }
  // A home that is gone refuses with the module's own code.
  fs.renameSync(ari.home, `${ari.home}-moved`)
  const gone = await ari.command(['status'])
  fs.renameSync(`${ari.home}-moved`, ari.home)
  assert.deepEqual([gone.exit, gone.json.error?.code], [EXIT.refused, 'root-missing'])
  const again = await ari.command(['status'])
  assert.equal(again.exit, EXIT.ok, JSON.stringify(again.json))
})

test('started by a login item on a personal home with nothing confirmed, the service finds its workspace from the home alone and records there how its start ended', (t) => {
  const ari = makePerson(t)
  const entry = fileURLToPath(new URL('./support/obsidian-maintenance/service-entry.mjs', import.meta.url))
  // No workspace is named: only the home leads to it. No service settings are recorded, so the start refuses before it listens.
  const child = childProcess.spawnSync(process.execPath, [entry, `--personal-home=${ari.home}`, `--data-root=${ari.dataRoot}`, '--startup'], { env: { PATH: process.env.PATH, HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }, encoding: 'utf8', timeout: 120_000 })
  assert.equal(child.status, 0, `${child.stdout}${child.stderr}`)
  const startup = readLastStartup({ workspaceRoot: ari.workspaceRoot(), workspaceId: ari.workspaceId })
  assert.deepEqual([startup?.outcome, startup?.code], ['refused', 'service-settings-absent'])
})

test('the plugin status read permits a bound view once two loads of the confirmed selection agree, nothing while none is confirmed, and follows a new confirmation', async (t) => {
  const ari = makePerson(t)
  let time = 0
  const loads = []
  const loadProject = () => { const answer = loadSelectedProjectOffThread({ personalHome: ari.home }, { bind: inThread() }); loads.push(answer); return answer }
  const settle = async () => { await loads.at(-1)?.catch(() => {}); await new Promise((resolve) => { setImmediate(resolve) }) }
  const resolveWorkspace = (project) => resolveServiceWorkspace({ project, dataRoot: ari.dataRoot, env: process.env })
  const { workspaceId, workspaceRoot } = resolveWorkspace(ari.locate())
  const permits = createViewPermission({ loadProject, resolveWorkspace, workspaceInputsOf: serviceWorkspaceInputs, workspaceId, workspaceRoot, now: () => time })
  const until = async (expected) => { for (let round = 0; round < 8 && permits('both') !== expected; round += 1) { await settle(); time += 2000 } return permits('both') }
  assert.equal(await until(true), false, 'nothing is confirmed: no load answers a project')
  ari.select()
  time += 30_000
  assert.equal(await until(true), true, 'two loads of the confirmed selection agree')
  assert.deepEqual(['harbor-only', 'everything', 'mine'].map((scopeId) => permits(scopeId)), [true, true, false])
  const kept = loads.length
  for (let request = 0; request < 20; request += 1) permits('both')
  assert.equal(loads.length, kept, 'kept: nothing is loaded again while the files hold the same')
  // A confirmation appended to the history changes an observed record: the project is loaded again, under it.
  ari.select()
  assert.equal(await until(true), true)
  assert.ok(loads.length > kept)
  assert.equal(personalSelectionOf(await loads.at(-1)).sequence, 2)
})
