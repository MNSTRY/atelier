import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { LOCAL_OVERLAY_ENV, resolveProjectConfig, writeJson } from '../src/project/config.mjs'
import { OBSIDIAN_EXT_KEY } from '../src/projection/obsidian/contracts.mjs'
import { LOCAL_POINTER_SCHEMA, ensureWorkspaceIdentity, localPointerPath, workspaceStateRoot } from '../src/runtime/obsidian/machine-settings.mjs'
import { resolveServiceWorkspace } from '../src/runtime/obsidian/service.mjs'
import { DEFAULT_KEEP_FOR_MS, DEFAULT_LOAD_DEADLINE_MS, DEFAULT_RETRY_AFTER_MS, createViewPermission } from '../src/runtime/obsidian/view-permission.mjs'

// Whether the project allows a view right now (view-permission.mjs), asked the
// way the maintenance service asks before it tells a plugin what it stored.
// Real project files in temporary directories, the real loader and the real
// workspace resolution. No service, listener, timer or vault; time is a number
// the test moves. The service's own answer over its listener is in
// obsidian-plugin.test.mjs.

const TMP = fs.realpathSync(os.tmpdir())
const WORKSPACE_ID = `ws-${'0a'.repeat(12)}`
const OTHER_WORKSPACE_ID = `ws-${'0b'.repeat(12)}`
const VIEW = 'wide'
const HALF = DEFAULT_KEEP_FOR_MS / 2
const fixedRandom = (size) => Buffer.alloc(size, 0x0a)
const view = (scopeId) => ({ scopeId, mode: 'full', selector: { all: true } })
const settings = (changes = {}) => ({ schema: 'atelier-obsidian-ext-settings/v1', enabled: true, scopes: [view(VIEW)], ...changes })
const configWith = (member) => ({
  schema: 'mnstry.atelier-project-config@v1', name: 'permission-fixture', roots: { workspace: '.', repoOps: '.' },
  repos: [{ name: 'harbor', path: 'harbor', readBoundary: 'team' }],
  ...(member === null ? {} : { ext: { [OBSIDIAN_EXT_KEY]: member } }),
})
const noLinks = process.platform === 'win32' ? 'links need a privilege there' : false
// Past every microtask and timer a settled load leaves behind.
const settled = () => new Promise((resolve) => { setImmediate(resolve) })

// One project that declares one view, its workspace pointer, and its private state under a temporary data root.
// `dataRootFrom`: 'injected' hands the data root to the resolution, as a service started with one; 'overlay' leaves it
// to the project's local overlay. `envOverlay`: an overlay file the environment names, not written.
function world(t, { dataRootFrom = 'injected', envOverlay = false } = {}) {
  const dir = fs.mkdtempSync(path.join(TMP, 'atelier-view-permission-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
  const projectDir = path.join(dir, 'project')
  const dataRoot = path.join(dir, 'data')
  fs.mkdirSync(path.join(projectDir, 'harbor'), { recursive: true })
  const configPath = path.join(projectDir, 'atelier.project.json')
  const overlayPath = path.join(projectDir, 'atelier.local.json')
  const envOverlayPath = path.join(dir, 'overlay-named-by-the-environment.json')
  const write = (member, file = configPath) => writeJson(file, configWith(member))
  const keepDataRootIn = (root, file = overlayPath) => writeJson(file, { preferences: { [OBSIDIAN_EXT_KEY]: { dataRoot: root } } })
  write(settings())
  if (dataRootFrom === 'overlay') keepDataRootIn(dataRoot)
  const { MNSTRY_ATELIER_PROJECT_CONFIG: _config, MNSTRY_ATELIER_LOCAL_CONFIG: _overlay, ...inherited } = process.env
  const env = envOverlay ? { ...inherited, [LOCAL_OVERLAY_ENV]: envOverlayPath } : inherited
  const stateOf = (root, workspaceId) => { const requested = workspaceStateRoot(root, workspaceId); fs.mkdirSync(requested, { recursive: true, mode: 0o700 }); return fs.realpathSync(requested) }
  const self = {
    dir, projectDir, dataRoot, configPath, overlayPath, envOverlayPath, write, keepDataRootIn, stateOf, loads: 0, time: 0,
    load: () => resolveProjectConfig({ argv: [`--project=${configPath}`], cwd: projectDir, env, writeLocalState: false }),
    loadProject: () => { self.loads += 1; return self.load() },
    advance: (ms) => { self.time += ms },
    // The permission as the service makes it: its loader, and the workspace resolved as at its start; time is the test's.
    permission: ({ loadProject = self.loadProject, resolveWorkspace = (project) => resolveServiceWorkspace({ project, dataRoot: injected, env }), ...times } = {}) => createViewPermission({
      loadProject, resolveWorkspace, workspaceId: WORKSPACE_ID, workspaceRoot: self.workspaceRoot, now: () => self.time, ...times,
    }),
    // Puts a link where `file` is, to `target`.
    link(file, target) { fs.rmSync(file, { recursive: true, force: true }); fs.symlinkSync(target, file) },
  }
  const pointer = ensureWorkspaceIdentity({ project: self.load(), randomBytes: fixedRandom })
  assert.equal(pointer.workspaceId, WORKSPACE_ID)
  self.pointerPath = localPointerPath(self.load())
  self.workspaceRoot = stateOf(dataRoot, WORKSPACE_ID)
  const injected = dataRootFrom === 'injected' ? dataRoot : undefined
  return self
}

// Asks `times` times and returns the distinct answers.
const answers = (permits, times, scopeId = VIEW) => [...new Set(Array.from({ length: times }, () => permits(scopeId)))]

test('a view the project enables and declares, in the workspace its pointer names, is permitted; another view is not', (t) => {
  const w = world(t)
  const permits = w.permission()
  assert.equal(permits(VIEW), true)
  assert.equal(permits('narrow'), false, 'a view the settings do not declare')
  assert.equal(permits(VIEW), true, 'asking about another view changes nothing for this one')
})

for (const [name, withdraw] of [
  ['turned off in the settings', (w) => w.write(settings({ enabled: false }))],
  ['left without its settings member', (w) => w.write(null)],
  ['taken out of the settings while another view stays', (w) => w.write(settings({ scopes: [view('narrow')] }))],
  ['under settings that do not satisfy their contract', (w) => w.write(settings({ surprise: true }))],
  ['under a configuration that is not JSON', (w) => fs.writeFileSync(w.configPath, '{ "schema": ')],
  ['after its configuration file is removed', (w) => fs.rmSync(w.configPath)],
  ['under a folder in its configuration file\'s place', (w) => { fs.rmSync(w.configPath); fs.mkdirSync(w.configPath) }],
]) {
  test(`a view ${name} is no longer permitted at the very next request, and is permitted again once that is undone`, (t) => {
    const w = world(t)
    const permits = w.permission()
    assert.deepEqual(answers(permits, 4), [true], 'kept by now')
    withdraw(w)
    assert.equal(permits(VIEW), false, 'nothing ticked in between: the project is asked as it is now')
    assert.equal(permits(VIEW), false)
    fs.rmSync(w.configPath, { recursive: true, force: true })
    w.write(settings())
    assert.equal(permits(VIEW), true)
  })
}

for (const [name, move, restore] of [
  ['whose pointer is removed', (w) => fs.rmSync(w.pointerPath), (w) => writeJson(w.pointerPath, { schema: LOCAL_POINTER_SCHEMA, workspaceId: WORKSPACE_ID })],
  ['whose pointer names another workspace', (w) => { w.stateOf(w.dataRoot, OTHER_WORKSPACE_ID); writeJson(w.pointerPath, { schema: LOCAL_POINTER_SCHEMA, workspaceId: OTHER_WORKSPACE_ID }) }, (w) => writeJson(w.pointerPath, { schema: LOCAL_POINTER_SCHEMA, workspaceId: WORKSPACE_ID })],
  ['whose pointer is not a pointer', (w) => fs.writeFileSync(w.pointerPath, '[]'), (w) => writeJson(w.pointerPath, { schema: LOCAL_POINTER_SCHEMA, workspaceId: WORKSPACE_ID })],
  ['whose private state is gone', (w) => fs.renameSync(w.workspaceRoot, `${w.workspaceRoot}-aside`), (w) => fs.renameSync(`${w.workspaceRoot}-aside`, w.workspaceRoot)],
]) {
  test(`a project ${name} permits no view of the workspace a service still runs for, until it names that workspace again`, (t) => {
    const w = world(t)
    const permits = w.permission()
    assert.deepEqual(answers(permits, 4), [true])
    const loads = w.loads
    move(w)
    assert.equal(permits(VIEW), false, 'the pointer and the place of the private state are read at every request')
    restore(w)
    assert.equal(permits(VIEW), true)
    assert.equal(w.loads, loads, 'neither is a file the project is kept by: the kept project decides, the pointer is read again')
  })
}

test('the workspace is compared by its identity as well as by its place', (t) => {
  const w = world(t)
  // The real resolution cannot answer this workspace's place under another identity; a resolution may, and is not taken.
  let identity = WORKSPACE_ID
  const permits = w.permission({ resolveWorkspace: (project) => ({ ...resolveServiceWorkspace({ project, dataRoot: w.dataRoot, env: {} }), workspaceId: identity }) })
  assert.equal(permits(VIEW), true)
  identity = OTHER_WORKSPACE_ID
  assert.equal(permits(VIEW), false)
})

test('a local overlay that moves the private state elsewhere is a change of the project: its views are not permitted for the old place', (t) => {
  const w = world(t, { dataRootFrom: 'overlay' })
  const permits = w.permission()
  assert.deepEqual(answers(permits, 4), [true])
  const elsewhere = path.join(w.dir, 'data-elsewhere')
  w.stateOf(elsewhere, WORKSPACE_ID)
  const before = w.loads
  w.keepDataRootIn(elsewhere)
  assert.equal(permits(VIEW), false, 'the same workspace identity, kept in another place')
  assert.equal(w.loads, before + 1, 'the overlay is one of the files that decide the project')
  w.keepDataRootIn(w.dataRoot)
  assert.equal(permits(VIEW), true)
})

test('the project is kept once two loads in a row agreed over the same bytes, and loaded again only when a file that decides it changed', (t) => {
  const w = world(t)
  const permits = w.permission()
  assert.equal(permits(VIEW), true)
  assert.equal(permits(VIEW), true)
  assert.equal(permits(VIEW), true)
  assert.equal(w.loads, 3, 'the first load tells which files decide the project; the next two agree')
  for (let index = 0; index < 50; index += 1) assert.equal(permits(index % 2 === 0 ? VIEW : 'narrow'), index % 2 === 0)
  assert.equal(w.loads, 3, 'fifty requests, no load')
  w.write(settings({ enabled: false }))
  assert.deepEqual(answers(permits, 50), [false])
  assert.equal(w.loads, 5, 'two loads for one change')
  // A file among them that appears is a change too.
  writeJson(path.join(w.projectDir, 'atelier.workspace.local.json'), { preferences: {} })
  assert.deepEqual(answers(permits, 5), [false])
  assert.equal(w.loads, 7)
  w.write(settings())
  assert.deepEqual(answers(permits, 50), [true])
  assert.equal(w.loads, 9)
})

test('a change that keeps a file\'s size and its modification time is still seen: the bytes decide, not the times', (t) => {
  const w = world(t)
  // A whole second, which every file system keeps as given.
  const stamp = new Date('2026-01-05T10:00:00.000Z')
  fs.utimesSync(w.configPath, stamp, stamp)
  const permits = w.permission()
  assert.deepEqual(answers(permits, 4), [true])
  const before = fs.statSync(w.configPath)
  // `tall` for `wide`: another view under a name of the same length.
  w.write(settings({ scopes: [view('tall')] }))
  fs.utimesSync(w.configPath, stamp, stamp)
  const after = fs.statSync(w.configPath)
  assert.deepEqual([after.size, after.mtimeMs], [before.size, before.mtimeMs])
  assert.equal(permits(VIEW), false)
  assert.equal(permits('tall'), true)
})

test('a file the project comes to name is watched from the load that named it; until a load names it, the kept project is loaded again within half its time', (t) => {
  const w = world(t, { dataRootFrom: 'overlay', envOverlay: true })
  const permits = w.permission()
  assert.deepEqual(answers(permits, 4), [true])
  const loads = w.loads
  // An overlay named by the environment that was not there at the load is not a file the project names (as for the
  // engine): it moves the private state elsewhere, and nothing loads.
  const elsewhere = path.join(w.dir, 'data-elsewhere')
  w.stateOf(elsewhere, WORKSPACE_ID)
  w.keepDataRootIn(elsewhere, w.envOverlayPath)
  assert.deepEqual(answers(permits, 5), [true])
  assert.equal(w.loads, loads)
  w.advance(HALF - 1)
  assert.equal(permits(VIEW), true)
  assert.equal(w.loads, loads)
  // Half the kept project's time: it is loaded again, and the overlay it now names decides.
  w.advance(1)
  assert.equal(permits(VIEW), false)
  assert.equal(w.loads, loads + 1)
  assert.deepEqual(answers(permits, 5), [false])
  assert.equal(w.loads, loads + 3, 'kept again, under the files that load named')
  // From that load on the overlay is one of the files: putting it back is seen at once, with no time passing.
  w.keepDataRootIn(w.dataRoot, w.envOverlayPath)
  assert.equal(permits(VIEW), true)
  assert.equal(w.loads, loads + 4)
})

test('a file that decides the project and is a link is kept like any file: the file it leads to decides, and a link pointed elsewhere is a change', { skip: noLinks }, (t) => {
  const w = world(t)
  const kept = path.join(w.dir, 'dotfiles', 'atelier.project.json')
  fs.mkdirSync(path.dirname(kept), { recursive: true })
  fs.renameSync(w.configPath, kept)
  w.link(w.configPath, kept)
  const permits = w.permission()
  assert.deepEqual(answers(permits, 50), [true])
  assert.equal(w.loads, 3, 'kept as a regular file is')
  // A change behind the link.
  w.write(settings({ enabled: false }), kept)
  assert.equal(permits(VIEW), false)
  w.write(settings(), kept)
  assert.deepEqual(answers(permits, 5), [true])
  const loads = w.loads
  // Pointed at another file with the very same bytes: what the loader reads is another file, so it is loaded again.
  const copy = path.join(w.dir, 'dotfiles', 'copy.json')
  fs.copyFileSync(kept, copy)
  w.link(w.configPath, copy)
  assert.deepEqual(answers(permits, 5), [true])
  assert.equal(w.loads, loads + 2)
  // Pointed at one with the view turned off.
  const off = path.join(w.dir, 'dotfiles', 'off.json')
  w.write(settings({ enabled: false }), off)
  w.link(w.configPath, off)
  assert.equal(permits(VIEW), false)
  // A link to a link is followed to the file at its end.
  const hop = path.join(w.dir, 'dotfiles', 'hop.json')
  fs.symlinkSync(kept, hop)
  w.link(w.configPath, hop)
  assert.deepEqual(answers(permits, 10), [true])
  w.write(settings({ enabled: false }), kept)
  assert.equal(permits(VIEW), false)
})

// A file the loader reads around: the repository access file, which the project names and does not need to load.
for (const [name, replace, skip] of [
  ['a folder', (w, file) => { fs.rmSync(file, { force: true }); fs.mkdirSync(file) }, false],
  ['a link that leads nowhere', (w, file) => w.link(file, path.join(w.dir, 'nowhere.json')), noLinks],
  ['a link to a folder', (w, file) => { fs.mkdirSync(path.join(w.dir, 'a-folder')); w.link(file, path.join(w.dir, 'a-folder')) }, noLinks],
]) {
  test(`${name} in place of a file that decides the project vouches for nothing: nothing is kept, and a loader that answers at once decides every request`, { skip }, (t) => {
    const w = world(t)
    const access = path.join(w.projectDir, 'repo-access.v1.json')
    const permits = w.permission()
    assert.deepEqual(answers(permits, 4), [true])
    replace(w, access)
    const loads = w.loads
    assert.deepEqual(answers(permits, 5), [true])
    assert.equal(w.loads, loads + 5, 'loaded at every request')
    w.write(settings({ enabled: false }))
    assert.equal(permits(VIEW), false)
    w.write(settings())
    fs.rmSync(access, { recursive: true, force: true })
    assert.deepEqual(answers(permits, 10), [true])
    assert.equal(w.loads, loads + 6 + 2, 'kept again once the file vouches')
  })
}

test('the files are read before the load they vouch for: a change that lands during a load is seen by the next request', (t) => {
  const w = world(t)
  let landing = null
  const permits = w.permission({ loadProject: () => { const project = w.loadProject(); if (landing !== null) { landing(); landing = null } return project } })
  assert.deepEqual(answers(permits, 4), [true])
  // A change that asks for a load, and the view turned off while that load is under way, after it read the settings.
  w.write({ ...settings(), defaultScopeId: VIEW })
  landing = () => w.write(settings({ enabled: false }))
  permits(VIEW)
  assert.equal(landing, null, 'the load ran')
  assert.equal(permits(VIEW), false, 'the project that load returned is not kept past the bytes it was loaded over')
})

test('a loader that fails permits nothing, and is asked again after two seconds, then four, up to thirty; a change to the files is tried at once', (t) => {
  const w = world(t)
  let failing = true
  const permits = w.permission({ loadProject: () => { if (failing) { w.loads += 1; throw new Error('the project cannot be loaded') } return w.loadProject() } })
  const at = []
  // Ninety seconds of requests, one every half second, as a plugin would make them.
  for (let step = 0; step <= 180; step += 1) {
    const before = w.loads
    assert.equal(permits(VIEW), false)
    if (w.loads > before) at.push(w.time)
    w.advance(500)
  }
  assert.deepEqual(at, [0, 2000, 6000, 14000, 30000, 60000, 90000])
  failing = false
  w.advance(30000)
  assert.deepEqual(answers(permits, 3), [true])
  assert.deepEqual(answers(permits, 5), [true])
  // A project that loaded, then fails: what was kept is not a reason to go on.
  failing = true
  w.write(settings())
  assert.equal(permits(VIEW), true, 'the same bytes: nothing changed, nothing is loaded')
  const loads = w.loads
  w.write(settings({ enabled: false }))
  assert.equal(permits(VIEW), false)
  assert.equal(w.loads, loads + 1, 'tried at once: the files changed')
  w.write(settings())
  assert.equal(permits(VIEW), false, 'a changed project that does not load permits nothing, whatever it says')
  assert.equal(w.loads, loads + 2, 'and a change back is tried at once too')
})

// A loader that answers a promise, as one that composes a personal workspace off the event loop does. Each load waits
// until the test lets it answer, with the project as it is at that moment or as the test hands it, or fail.
function deferredLoader(w) {
  const waiting = []
  const next = async (settle) => { settle(waiting.shift()); await settled() }
  return {
    loadProject: () => { w.loads += 1; return new Promise((resolve, reject) => { waiting.push({ resolve, reject }) }) },
    waiting: () => waiting.length,
    answer: () => next(({ resolve }) => resolve(w.load())),
    answerWith: (project) => next(({ resolve }) => resolve(project)),
    fail: () => next(({ reject }) => reject(new Error('the composition refused'))),
    // The oldest load left waiting, to answer later.
    takeOldest: () => waiting.shift(),
  }
}

// Asks, and answers the load under way, `count` times: three keep a project from the start, two after a change.
async function keepUnder(permits, loader, count) {
  for (let index = 0; index < count; index += 1) { permits(VIEW); if (loader.waiting() > 0) await loader.answer() }
}

test('a loader that answers a promise is never waited for: nothing is permitted until two loads agreed, one load at a time', async (t) => {
  const w = world(t)
  const loader = deferredLoader(w)
  const permits = w.permission({ loadProject: loader.loadProject })
  assert.deepEqual(answers(permits, 11), [false], 'not known yet')
  assert.deepEqual([w.loads, loader.waiting()], [1, 1], 'eleven requests, one load under way')
  await loader.answer()
  assert.equal(permits(VIEW), false, 'the first load only told which files decide the project')
  await loader.answer()
  assert.equal(permits(VIEW), false, 'one load over these bytes is not enough')
  await loader.answer()
  assert.deepEqual(answers(permits, 50), [true])
  assert.equal(permits('narrow'), false)
  assert.equal(w.loads, 3, 'kept: fifty requests, no load')

  // Turned off: not permitted from the request that sees the change, while the loads run and after.
  w.write(settings({ enabled: false }))
  assert.equal(permits(VIEW), false)
  await loader.answer()
  assert.equal(permits(VIEW), false)
  await loader.answer()
  assert.deepEqual(answers(permits, 5), [false])
  assert.equal(w.loads, 5)
  // Turned on again: permitted only once two loads that saw it have answered.
  w.write(settings())
  assert.deepEqual(answers(permits, 2), [false])
  await loader.answer()
  assert.equal(permits(VIEW), false)
  await loader.answer()
  assert.deepEqual(answers(permits, 5), [true])
  assert.equal(w.loads, 7)
})

test('a change undone and done again while one promised load runs never leaves that load\'s project kept under the bytes that are there now', async (t) => {
  const w = world(t)
  const loader = deferredLoader(w)
  const permits = w.permission({ loadProject: loader.loadProject })
  await keepUnder(permits, loader, 3)
  assert.equal(permits(VIEW), true, 'kept with the view on')
  // Saved with the view off. The request that sees it starts a load over those bytes.
  w.write(settings({ enabled: false }))
  assert.equal(permits(VIEW), false)
  assert.equal(loader.waiting(), 1)
  // Undone: the load reads the project with the view on. Done again before it answers.
  w.write(settings())
  const readWhileUndone = w.load()
  w.write(settings({ enabled: false }))
  await loader.answerWith(readWhileUndone)
  // The bytes are the ones read before that load, but its project is not kept: one load is not enough.
  assert.equal(permits(VIEW), false)
  await loader.answer()
  assert.equal(permits(VIEW), false)
  await loader.answer()
  assert.deepEqual(answers(permits, 10), [false])
  assert.equal(loader.waiting(), 0, 'kept, with the view off')
})

test('a promised load of a project kept through a link is kept like any other, and a link pointed elsewhere is seen', { skip: noLinks }, async (t) => {
  const w = world(t)
  const kept = path.join(w.dir, 'dotfiles', 'atelier.project.json')
  fs.mkdirSync(path.dirname(kept), { recursive: true })
  fs.renameSync(w.configPath, kept)
  w.link(w.configPath, kept)
  const loader = deferredLoader(w)
  const permits = w.permission({ loadProject: loader.loadProject })
  await keepUnder(permits, loader, 3)
  assert.deepEqual(answers(permits, 50), [true])
  assert.equal(w.loads, 3)
  const off = path.join(w.dir, 'dotfiles', 'off.json')
  w.write(settings({ enabled: false }), off)
  w.link(w.configPath, off)
  assert.equal(permits(VIEW), false)
  await keepUnder(permits, loader, 2)
  assert.deepEqual(answers(permits, 5), [false])
  assert.equal(w.loads, 5)
})

test('with a promised loader, a file that vouches for nothing permits nothing, and the loader is asked again only after a while', async (t) => {
  const w = world(t)
  const loader = deferredLoader(w)
  const permits = w.permission({ loadProject: loader.loadProject })
  await keepUnder(permits, loader, 3)
  fs.mkdirSync(path.join(w.projectDir, 'repo-access.v1.json'))
  assert.equal(permits(VIEW), false)
  await loader.answer()
  assert.deepEqual(answers(permits, 10), [false])
  assert.equal(loader.waiting(), 0, 'nothing could be kept from that answer: not asked again at once')
  w.advance(DEFAULT_RETRY_AFTER_MS)
  assert.equal(permits(VIEW), false)
  assert.equal(loader.waiting(), 1)
})

test('a promised load that never answers is given up at its deadline, its late answer is ignored, and the loader is asked again after a while', async (t) => {
  const w = world(t)
  const loader = deferredLoader(w)
  const permits = w.permission({ loadProject: loader.loadProject })
  assert.equal(permits(VIEW), false)
  const stuck = loader.takeOldest()
  w.advance(DEFAULT_LOAD_DEADLINE_MS - 1)
  assert.equal(permits(VIEW), false)
  assert.equal(w.loads, 1, 'still under way')
  w.advance(1)
  assert.equal(permits(VIEW), false)
  assert.equal(w.loads, 1, 'given up, and not asked again at once')
  w.advance(DEFAULT_RETRY_AFTER_MS)
  assert.equal(permits(VIEW), false)
  assert.equal(w.loads, 2)
  // The load given up answers now, with a project that would permit the view: nobody listens.
  stuck.resolve(w.load())
  await settled()
  assert.equal(permits(VIEW), false)
  assert.equal(loader.waiting(), 1, 'the load under way is still the one asked after it')
  await loader.answer()
  await keepUnder(permits, loader, 2)
  assert.equal(permits(VIEW), true)
})

test('a promised load that is refused, again and again, permits nothing and is asked again after two seconds, then four, up to thirty', async (t) => {
  const unhandled = []
  const record = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', record)
  t.after(() => process.off('unhandledRejection', record))
  const w = world(t)
  const loader = deferredLoader(w)
  const permits = w.permission({ loadProject: loader.loadProject })
  const at = []
  for (let step = 0; step <= 180; step += 1) {
    const before = w.loads
    assert.equal(permits(VIEW), false)
    if (w.loads > before) { at.push(w.time); await loader.fail() }
    w.advance(500)
  }
  assert.deepEqual(at, [0, 2000, 6000, 14000, 30000, 60000, 90000])
  w.advance(30000)
  await keepUnder(permits, loader, 3)
  assert.equal(permits(VIEW), true)
  assert.deepEqual(unhandled, [])
})

test('a kept project is loaded again once half its time has gone, decides meanwhile, and is never used past its time', async (t) => {
  const w = world(t)
  const loader = deferredLoader(w)
  const keepForMs = 10_000
  const permits = w.permission({ loadProject: loader.loadProject, keepForMs, loadDeadlineMs: 60_000 })
  await keepUnder(permits, loader, 3)
  w.advance(keepForMs / 2 - 1)
  assert.equal(permits(VIEW), true)
  assert.equal(loader.waiting(), 0)
  w.advance(1)
  assert.equal(permits(VIEW), true, 'the kept project decides while it is loaded again')
  assert.equal(loader.waiting(), 1)
  w.advance(keepForMs / 2 - 1)
  assert.equal(permits(VIEW), true)
  w.advance(1)
  assert.equal(permits(VIEW), false, 'its time is over, and the load has not answered')
  await loader.answer()
  assert.equal(permits(VIEW), true, 'that load agreed with the one before it: kept again, from its start')
})

test('a promised load that fails is handled, permits nothing, and is asked for again by a later request', async (t) => {
  const unhandled = []
  const record = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', record)
  t.after(() => process.off('unhandledRejection', record))
  const w = world(t)
  const loader = deferredLoader(w)
  const permits = w.permission({ loadProject: loader.loadProject })
  assert.equal(permits(VIEW), false)
  await loader.fail()
  assert.equal(permits(VIEW), false)
  assert.equal(w.loads, 1)
  w.advance(DEFAULT_RETRY_AFTER_MS)
  assert.equal(permits(VIEW), false)
  assert.equal(w.loads, 2, 'asked for again')
  await keepUnder(permits, loader, 3)
  assert.equal(permits(VIEW), true)
  assert.deepEqual(unhandled, [])
})

test('a permission is made with a loader and a workspace resolution, or not at all', () => {
  assert.throws(() => createViewPermission({ resolveWorkspace: () => null, workspaceId: WORKSPACE_ID, workspaceRoot: TMP }), TypeError)
  assert.throws(() => createViewPermission({ loadProject: () => ({}), workspaceId: WORKSPACE_ID, workspaceRoot: TMP }), TypeError)
})
