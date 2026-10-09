import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { LOCAL_OVERLAY_ENV, resolveProjectConfig, writeJson } from '../src/project/config.mjs'
import { OBSIDIAN_EXT_KEY } from '../src/projection/obsidian/contracts.mjs'
import { ObsidianMaintenanceRefusal } from '../src/runtime/obsidian/errors.mjs'
import { LOCAL_POINTER_SCHEMA, ensureWorkspaceIdentity, localPointerPath, workspaceStateRoot } from '../src/runtime/obsidian/machine-settings.mjs'
import { readLastStartup, readServiceRecord } from '../src/runtime/obsidian/service-record.mjs'
import { runServiceProcess } from '../src/runtime/obsidian/service-main.mjs'
import { resolveServiceWorkspace, runMaintenanceService, serviceWorkspaceInputs } from '../src/runtime/obsidian/service.mjs'
import {
  DEFAULT_KEEP_FOR_MS, DEFAULT_LOAD_DEADLINE_MS, DEFAULT_RETRY_AFTER_MS, DEFAULT_SLOW_LOAD_MS, STATUS_LOAD_EVENT, createLoadReport, createViewPermission,
} from '../src/runtime/obsidian/view-permission.mjs'

// Whether the project allows a view right now (view-permission.mjs), asked the
// way the maintenance service asks before it tells a plugin what it stored.
// Real project files in temporary directories, the real loader and the real
// workspace resolution. No listener, timer or vault; time is a number the test
// moves. The service is started only to show it refuses a loader that answers a
// promise, before it reads or listens. Its own answer over its listener is in
// obsidian-plugin.test.mjs, and a bound personal workspace in
// obsidian-personal-workspace.test.mjs.

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
    dir, projectDir, dataRoot, configPath, overlayPath, envOverlayPath, env, write, keepDataRootIn, stateOf, loads: 0, time: 0,
    load: () => resolveProjectConfig({ argv: [`--project=${configPath}`], cwd: projectDir, env, writeLocalState: false }),
    loadProject: () => { self.loads += 1; return self.load() },
    advance: (ms) => { self.time += ms },
    // The permission as the service makes it: its loader, and the workspace resolved as at its start; time is the test's.
    permission: ({ loadProject = self.loadProject, resolveWorkspace = (project) => resolveServiceWorkspace({ project, dataRoot: injected, env }), ...times } = {}) => createViewPermission({
      loadProject, resolveWorkspace, workspaceInputsOf: serviceWorkspaceInputs, workspaceId: WORKSPACE_ID, workspaceRoot: self.workspaceRoot, now: () => self.time, ...times,
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

test('a link is followed as the system follows it: a `..` after a link in its target leads where the system says, not where the text says', { skip: noLinks }, (t) => {
  const w = world(t)
  // atelier.project.json -> shared/../atelier.real.json, and shared -> elsewhere/inner: the loader opens
  // elsewhere/atelier.real.json. Read as text, the target would name the project's own atelier.real.json.
  const elsewhere = path.join(w.dir, 'elsewhere')
  fs.mkdirSync(path.join(elsewhere, 'inner'), { recursive: true })
  fs.symlinkSync(path.join(elsewhere, 'inner'), path.join(w.projectDir, 'shared'))
  const opened = path.join(elsewhere, 'atelier.real.json')
  const named = path.join(w.projectDir, 'atelier.real.json')
  w.write(settings(), opened)
  w.write(settings({ enabled: false }), named)
  w.link(w.configPath, 'shared/../atelier.real.json')
  assert.equal(fs.readFileSync(w.configPath, 'utf8'), fs.readFileSync(opened, 'utf8'), 'the system opens the file in elsewhere')
  const permits = w.permission()
  assert.deepEqual(answers(permits, 4), [true])
  // A change to the file the loader opens is seen at the next request.
  w.write(settings({ enabled: false }), opened)
  assert.equal(permits(VIEW), false)
  w.write(settings(), opened)
  assert.deepEqual(answers(permits, 4), [true])
  // A change to the file the text names is no change.
  const loads = w.loads
  w.write(settings({ scopes: [view('narrow')] }), named)
  assert.deepEqual(answers(permits, 4), [true])
  assert.equal(w.loads, loads)
})

test('a link to a folder above a file that decides the project, pointed elsewhere, is a change even where every byte is the same', { skip: noLinks }, (t) => {
  const w = world(t)
  // The project is reached through a link to its folder, as a checkout kept elsewhere and linked into place would be.
  const linked = path.join(w.dir, 'linked-project')
  fs.symlinkSync(w.projectDir, linked)
  const configThrough = path.join(linked, 'atelier.project.json')
  const permits = w.permission({ loadProject: () => { w.loads += 1; return resolveProjectConfig({ argv: [`--project=${configThrough}`], cwd: linked, env: w.env, writeLocalState: false }) } })
  assert.deepEqual(answers(permits, 10), [true])
  assert.equal(w.loads, 3)
  // A copy of the folder, byte for byte, pointer included, and the link pointed at it.
  const copy = path.join(w.dir, 'project-copy')
  fs.cpSync(w.projectDir, copy, { recursive: true })
  fs.rmSync(linked)
  fs.symlinkSync(copy, linked)
  assert.deepEqual(answers(permits, 10), [true])
  assert.equal(w.loads, 5, 'loaded again: the files are other files now')
  // And the copy is what decides from then on.
  w.write(settings({ enabled: false }), path.join(copy, 'atelier.project.json'))
  assert.equal(permits(VIEW), false)
})

test('two loads agree on what the permission reads of a project, not on every field: a time or a binding under a symbol key that differs does not keep a project from being kept, a protected root that differs does', async (t) => {
  const w = world(t)
  const loader = deferredLoader(w)
  const binding = Symbol('binding')
  let stamp = 0
  const stamped = () => { stamp += 1; return { ...w.load(), loadedAt: stamp, [binding]: { stamp } } }
  const permits = w.permission({ loadProject: loader.loadProject })
  for (let round = 0; round < 3; round += 1) { assert.equal(permits(VIEW), false); await loader.answerWith(stamped()) }
  assert.deepEqual(answers(permits, 10), [true])
  assert.equal(w.loads, 3, 'kept by the third load, as any project')
  // A project that protects another repository from one load to the next is never kept.
  w.write({ ...settings(), defaultScopeId: VIEW })
  const extra = { name: 'extra', path: path.join(w.dir, 'extra'), external: false, readBoundary: 'team' }
  for (let round = 0; round < 4; round += 1) {
    assert.equal(permits(VIEW), false)
    const project = w.load()
    await loader.answerWith(round % 2 === 0 ? project : { ...project, repos: [...project.repos, extra] })
  }
  assert.equal(permits(VIEW), false)
})

test('a promised load whose answer comes after its deadline, before any request saw the deadline pass, is given up all the same', async (t) => {
  const w = world(t)
  const loader = deferredLoader(w)
  const permits = w.permission({ loadProject: loader.loadProject })
  await keepUnder(permits, loader, 3)
  assert.equal(permits(VIEW), true)
  // A change; the first load over it answers in time.
  w.write({ ...settings(), defaultScopeId: VIEW })
  assert.equal(permits(VIEW), false)
  await loader.answer()
  // The second would agree with it, but answers only once its deadline has passed, with no request in between.
  assert.equal(permits(VIEW), false)
  w.advance(DEFAULT_LOAD_DEADLINE_MS)
  await loader.answer()
  assert.equal(permits(VIEW), false, 'its answer is not taken')
  assert.equal(w.loads, 5, 'and the loader is not asked again at once')
  w.advance(DEFAULT_RETRY_AFTER_MS)
  assert.equal(permits(VIEW), false)
  assert.equal(w.loads, 6)
  await loader.answer()
  assert.equal(permits(VIEW), true, 'a load in time agrees with the one before the given-up one')
})

test('each load is told with how long it took and how it ended: times and codes only, and a listener that throws changes no answer', async (t) => {
  const w = world(t)
  const told = []
  let failing = false
  const permits = w.permission({
    loadProject: () => { w.advance(120); if (failing) throw new Error('the project cannot be loaded'); return w.loadProject() },
    onLoad: (entry) => { told.push(entry); throw new Error('a listener that fails') },
  })
  assert.equal(permits(VIEW), true)
  failing = true
  w.write(settings({ enabled: false }))
  assert.equal(permits(VIEW), false)
  assert.deepEqual(told, [{ durationMs: 120, outcome: 'answered', promised: false }, { durationMs: 120, outcome: 'failed', promised: false }])

  const promisedTold = []
  const loader = deferredLoader(w)
  const promised = w.permission({ loadProject: loader.loadProject, onLoad: (entry) => promisedTold.push(entry) })
  w.write(settings())
  promised(VIEW)
  w.advance(900)
  await loader.answer()
  promised(VIEW)
  w.advance(400)
  await loader.fail()
  w.advance(DEFAULT_RETRY_AFTER_MS)
  promised(VIEW)
  w.advance(DEFAULT_LOAD_DEADLINE_MS)
  promised(VIEW)
  assert.deepEqual(promisedTold, [
    { durationMs: 900, outcome: 'answered', promised: true },
    { durationMs: 400, outcome: 'failed', promised: true },
    { durationMs: DEFAULT_LOAD_DEADLINE_MS, outcome: 'given-up', promised: true },
  ])
  assert.deepEqual(Object.keys(promisedTold[0]).sort(), ['durationMs', 'outcome', 'promised'])
})

test('a promised load that answers, or is refused, only after its deadline with no request in between is told as given up, once, and counts as one failure', async (t) => {
  for (const late of ['answer', 'fail']) {
    const w = world(t)
    const told = []
    const loader = deferredLoader(w)
    const permits = w.permission({ loadProject: loader.loadProject, onLoad: (entry) => told.push(entry) })
    assert.equal(permits(VIEW), false)
    w.advance(DEFAULT_LOAD_DEADLINE_MS + 5)
    await loader[late]()
    assert.deepEqual(told, [{ durationMs: DEFAULT_LOAD_DEADLINE_MS + 5, outcome: 'given-up', promised: true }], late)
    assert.equal(permits(VIEW), false)
    w.advance(DEFAULT_RETRY_AFTER_MS - 1)
    assert.equal(permits(VIEW), false)
    assert.equal(w.loads, 1, 'given up: not asked again at once')
    // One failure waits two seconds; two in a row would wait four.
    w.advance(1)
    assert.equal(permits(VIEW), false)
    assert.equal(w.loads, 2)
    assert.equal(told.length, 1)
  }
})

test('the load report writes a line for a load that failed, was given up or held the event loop, and for the first that answered after a failure; never one per load', () => {
  const lines = []
  const report = createLoadReport({ write: (line) => lines.push(line) })
  const load = (outcome, durationMs = 120, promised = false) => report.onLoad({ durationMs, outcome, promised })
  // A healthy service: every load answers in time. Nothing is written, however many there are.
  for (let index = 0; index < 500; index += 1) load('answered')
  assert.deepEqual(lines, [])
  // A loader that keeps failing: the first, then when the row is 2, 4, 8, ... long.
  for (let index = 0; index < 100; index += 1) load(index % 10 === 9 ? 'given-up' : 'failed', 30, index % 10 === 9)
  assert.deepEqual(lines.map((line) => line.inARow), [1, 2, 4, 8, 16, 32, 64])
  assert.deepEqual(lines[0], { event: 'status-project-loaded', durationMs: 30, outcome: 'failed', promised: false, inARow: 1 })
  assert.equal(STATUS_LOAD_EVENT, 'status-project-loaded')
  // The first that answers after it, once.
  lines.length = 0
  load('answered')
  load('answered')
  assert.deepEqual(lines, [{ event: 'status-project-loaded', durationMs: 120, outcome: 'answered', promised: false, afterFailures: 100 }])
  // A load that answered at once and took a second or more held the listener's event loop that long; a promised one
  // held nothing. Slow loads in a row are written on the same doubling row.
  lines.length = 0
  load('answered', DEFAULT_SLOW_LOAD_MS - 1)
  load('answered', 60_000, true)
  assert.deepEqual(lines, [])
  for (let index = 0; index < 40; index += 1) load('answered', DEFAULT_SLOW_LOAD_MS + index)
  assert.deepEqual(lines.map(({ slow, inARow, durationMs }) => [slow, inARow, durationMs]), [[true, 1, 1000], [true, 2, 1001], [true, 4, 1003], [true, 8, 1007], [true, 16, 1015], [true, 32, 1031]])
  load('answered')
  load('answered', DEFAULT_SLOW_LOAD_MS)
  assert.equal(lines.at(-1).inARow, 1, 'a load in time ends the row')
  // Every load is counted, written or not.
  assert.deepEqual(report.counts(), { answered: 546, failed: 90, givenUp: 10, slow: 41, longestMs: 60_000 })
  assert.throws(() => createLoadReport({}), TypeError)
})

test('what the service logs of a status load names the event and holds times, codes and counts only: no path, view or message of a load that failed', (t) => {
  const w = world(t)
  const lines = []
  const report = createLoadReport({ write: (line) => lines.push(line) })
  let failing = false
  const permits = w.permission({
    loadProject: () => { if (failing) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${w.configPath}'`), { code: 'ENOENT', path: w.configPath }); return w.loadProject() },
    onLoad: report.onLoad,
  })
  assert.deepEqual(answers(permits, 4), [true])
  assert.deepEqual(lines, [], 'a healthy start writes nothing')
  failing = true
  w.write(settings({ enabled: false }))
  assert.equal(permits(VIEW), false)
  failing = false
  w.write(settings())
  assert.equal(permits(VIEW), true)
  assert.deepEqual(lines.map((line) => [line.event, line.outcome]), [['status-project-loaded', 'failed'], ['status-project-loaded', 'answered']])
  for (const line of lines) {
    assert.deepEqual(Object.keys(line).filter((key) => !['event', 'durationMs', 'outcome', 'promised', 'inARow', 'afterFailures', 'slow'].includes(key)), [])
    for (const [key, value] of Object.entries(line)) assert.ok(key === 'event' || key === 'outcome' ? /^[a-z-]+$/.test(value) : typeof value === 'number' || typeof value === 'boolean', `${key} is a code, a number or a flag`)
  }
  const written = JSON.stringify(lines)
  for (const word of [w.dir, w.configPath, VIEW, 'ENOENT', path.sep === '/' ? '/' : '\\']) assert.equal(written.includes(word), false, `a line holds ${word}`)
})

for (const [name, differing] of [
  ['the data root its local overlay prefers', (project, w) => ({ ...project, localOverlay: { ...project.localOverlay, overlay: { ...project.localOverlay.overlay, preferences: { [OBSIDIAN_EXT_KEY]: { dataRoot: path.join(w.dir, 'data-elsewhere') } } } } })],
  ['the folder its pointer is under', (project, w) => ({ ...project, configDir: path.join(w.dir, 'another-folder') })],
  ['a repository it protects', (project, w) => ({ ...project, repos: [...project.repos, { name: 'extra', path: path.join(w.dir, 'extra'), external: false, readBoundary: 'team' }] })],
]) {
  test(`two loads that differ in ${name} are never taken for the same project: each is something the workspace is resolved from`, async (t) => {
    const w = world(t)
    const loader = deferredLoader(w)
    const permits = w.permission({ loadProject: loader.loadProject })
    await keepUnder(permits, loader, 3)
    assert.equal(permits(VIEW), true)
    w.write({ ...settings(), defaultScopeId: VIEW })
    for (let round = 0; round < 6; round += 1) {
      assert.equal(permits(VIEW), false)
      assert.equal(loader.waiting(), 1, 'nothing is kept: a load is under way again')
      const project = w.load()
      await loader.answerWith(round % 2 === 0 ? project : differing(project, w))
    }
    // And the resolution reads nothing of a project but those inputs.
    const whole = w.load()
    assert.deepEqual(resolveServiceWorkspace({ project: serviceWorkspaceInputs(whole), dataRoot: w.dataRoot, env: w.env }), resolveServiceWorkspace({ project: whole, dataRoot: w.dataRoot, env: w.env }))
    assert.deepEqual(Object.keys(serviceWorkspaceInputs(whole)).sort(), ['configDir', 'localOverlay', 'repos'])
  })
}

const refusingRealpath = () => { throw Object.assign(new Error('EISDIR: illegal operation on a directory, realpath'), { code: 'EISDIR' }) }

test('where the system resolves no path for a regular file that is there, the file is kept by its own path and its bytes', (t) => {
  const w = world(t)
  const permits = w.permission({ realpath: refusingRealpath })
  assert.deepEqual(answers(permits, 20), [true])
  assert.equal(w.loads, 3, 'kept, as where the system resolves it')
  w.write(settings({ enabled: false }))
  assert.equal(permits(VIEW), false, 'its bytes decide')
  w.write(settings())
  assert.deepEqual(answers(permits, 20), [true])
  assert.equal(w.loads, 6, 'one load while it was off, two to keep it again')
  // A file that appears is still a change, and a folder in a file's place still vouches for nothing.
  writeJson(path.join(w.projectDir, 'atelier.workspace.local.json'), { preferences: {} })
  assert.deepEqual(answers(permits, 5), [true])
  assert.equal(w.loads, 8)
  fs.mkdirSync(path.join(w.projectDir, 'repo-access.v1.json'))
  assert.deepEqual(answers(permits, 5), [true])
  assert.equal(w.loads, 13, 'loaded at every request')
})

test('where the system resolves no path, a link still vouches for nothing: nobody can say where it leads', { skip: noLinks }, (t) => {
  const w = world(t)
  const kept = path.join(w.dir, 'dotfiles', 'atelier.project.json')
  fs.mkdirSync(path.dirname(kept), { recursive: true })
  fs.renameSync(w.configPath, kept)
  w.link(w.configPath, kept)
  const permits = w.permission({ realpath: refusingRealpath })
  assert.deepEqual(answers(permits, 10), [true])
  assert.equal(w.loads, 10, 'never kept')
})

const SERVICE_ENTRY = fileURLToPath(new URL('./support/obsidian-maintenance/service-entry.mjs', import.meta.url))
for (const kind of ['promise', 'refused-promise', 'thenable']) {
  test(`started by a login item on a loader that answers a ${kind}, the service asks the loader once, records its typed refusal and ends cleanly`, (t) => {
    const w = world(t)
    const child = childProcess.spawnSync(process.execPath, [SERVICE_ENTRY, `--project=${w.configPath}`, `--data-root=${w.dataRoot}`, `--workspace-id=${WORKSPACE_ID}`, '--startup', `--loader-answers=${kind}`], { env: w.env, encoding: 'utf8', windowsHide: true, timeout: 120_000 })
    assert.equal(child.status, 0, `a refusal under a login item ends with 0, so the service manager does not start it again at once: ${child.stdout}${child.stderr}`)
    assert.equal(/unhandled|rejection/i.test(child.stderr), false, child.stderr)
    const startup = readLastStartup({ workspaceRoot: w.workspaceRoot, workspaceId: WORKSPACE_ID })
    assert.deepEqual([startup?.outcome, startup?.code], ['refused', 'service-loader-not-synchronous'])
    assert.deepEqual(child.stdout.split('\n').filter((line) => line.includes('loader-calls')).map((line) => JSON.parse(line).count), [1], 'one call serves the lookup of the workspace and the service\'s start')
    assert.equal(readServiceRecord({ workspaceRoot: w.workspaceRoot, workspaceId: WORKSPACE_ID }), null)
  })
}

test('under a login item a refused promise the loader answered is let go even when the service ends before it asks its loader', async (t) => {
  const unhandled = []
  const record = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', record)
  const exitCode = process.exitCode
  t.after(() => { process.off('unhandledRejection', record); process.exitCode = exitCode })
  const w = world(t)
  let asked = 0
  // No adapter factory: the service throws, untyped, before its first call of the loader.
  await runServiceProcess({
    startup: true, loadProject: () => { asked += 1; return Promise.reject(new Error('the composition refused')) }, dataRoot: w.dataRoot, workspaceId: WORKSPACE_ID, env: w.env,
    entryPath: path.join(w.dir, 'service-entry.mjs'),
  })
  await settled()
  assert.deepEqual(unhandled, [])
  assert.equal(asked, 1)
  assert.equal(process.exitCode, 1, 'an error nobody typed is a crash, as before')
  process.exitCode = exitCode
})

for (const [name, answer] of [
  ['a promise', (w) => Promise.resolve(w.load())],
  ['a promise that is refused', () => Promise.reject(new Error('the composition refused'))],
  ['a thenable', (w) => ({ then: (resolve) => resolve(w.load()) })],
]) {
  test(`the service refuses, typed, to start on a loader that answers ${name}, before it reads anything from it, listens or records anything`, async (t) => {
    const unhandled = []
    const record = (reason) => unhandled.push(reason)
    process.on('unhandledRejection', record)
    t.after(() => process.off('unhandledRejection', record))
    const w = world(t)
    const start = (loadProject) => runMaintenanceService({
      loadProject, dataRoot: w.dataRoot, env: w.env, entryPath: path.join(w.dir, 'service-entry.mjs'), adapterFactory: () => { throw new Error('no adapter is made') },
    })
    await assert.rejects(start(() => answer(w)), (error) => error instanceof ObsidianMaintenanceRefusal && error.code === 'service-loader-not-synchronous')
    await settled()
    assert.deepEqual(unhandled, [])
    assert.equal(readServiceRecord({ workspaceRoot: w.workspaceRoot, workspaceId: WORKSPACE_ID }), null)
    // The same project from a loader that answers at once gets past that check, and stops at the next one: this machine
    // recorded no service settings for the workspace.
    await assert.rejects(start(() => w.load()), (error) => error instanceof ObsidianMaintenanceRefusal && error.code === 'service-settings-absent')
    // So does a project that merely has a member named `then` that is not a function: it answers no promise.
    await assert.rejects(start(() => ({ ...w.load(), then: 'later' })), (error) => error instanceof ObsidianMaintenanceRefusal && error.code === 'service-settings-absent')
  })
}

test('a permission is made with a loader, a workspace resolution and what that resolution reads, or not at all', () => {
  assert.throws(() => createViewPermission({ resolveWorkspace: () => null, workspaceInputsOf: () => ({}), workspaceId: WORKSPACE_ID, workspaceRoot: TMP }), TypeError)
  assert.throws(() => createViewPermission({ loadProject: () => ({}), workspaceInputsOf: () => ({}), workspaceId: WORKSPACE_ID, workspaceRoot: TMP }), TypeError)
  assert.throws(() => createViewPermission({ loadProject: () => ({}), resolveWorkspace: () => null, workspaceId: WORKSPACE_ID, workspaceRoot: TMP }), TypeError)
})
