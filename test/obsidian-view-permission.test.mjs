import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveProjectConfig, writeJson } from '../src/project/config.mjs'
import { OBSIDIAN_EXT_KEY } from '../src/projection/obsidian/contracts.mjs'
import { LOCAL_POINTER_SCHEMA, ensureWorkspaceIdentity, localPointerPath, workspaceStateRoot } from '../src/runtime/obsidian/machine-settings.mjs'
import { resolveServiceWorkspace } from '../src/runtime/obsidian/service.mjs'
import { createViewPermission } from '../src/runtime/obsidian/view-permission.mjs'

// Whether the project allows a view right now (view-permission.mjs), asked the
// way the maintenance service asks before it tells a plugin what it stored.
// Real project files in temporary directories, the real loader and the real
// workspace resolution. No service, listener, timer or vault; the service's own
// answer over its listener is in obsidian-plugin.test.mjs.

const TMP = fs.realpathSync(os.tmpdir())
const WORKSPACE_ID = `ws-${'0a'.repeat(12)}`
const OTHER_WORKSPACE_ID = `ws-${'0b'.repeat(12)}`
const VIEW = 'wide'
const fixedRandom = (size) => Buffer.alloc(size, 0x0a)
const view = (scopeId) => ({ scopeId, mode: 'full', selector: { all: true } })
const settings = (changes = {}) => ({ schema: 'atelier-obsidian-ext-settings/v1', enabled: true, scopes: [view(VIEW)], ...changes })
// Past every microtask and timer a settled load leaves behind.
const settled = () => new Promise((resolve) => { setImmediate(resolve) })

// One project that declares one view, its workspace pointer, and its private state under a temporary data root.
// `dataRootFrom`: 'injected' hands the data root to the resolution, as a service started with one; 'overlay' leaves it
// to the project's local overlay.
function world(t, { dataRootFrom = 'injected' } = {}) {
  const dir = fs.mkdtempSync(path.join(TMP, 'atelier-view-permission-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
  const projectDir = path.join(dir, 'project')
  const dataRoot = path.join(dir, 'data')
  fs.mkdirSync(path.join(projectDir, 'harbor'), { recursive: true })
  const configPath = path.join(projectDir, 'atelier.project.json')
  const overlayPath = path.join(projectDir, 'atelier.local.json')
  const configWith = (member) => ({
    schema: 'mnstry.atelier-project-config@v1', name: 'permission-fixture', roots: { workspace: '.', repoOps: '.' },
    repos: [{ name: 'harbor', path: 'harbor', readBoundary: 'team' }],
    ...(member === null ? {} : { ext: { [OBSIDIAN_EXT_KEY]: member } }),
  })
  const write = (member) => writeJson(configPath, configWith(member))
  const keepDataRootIn = (root) => writeJson(overlayPath, { preferences: { [OBSIDIAN_EXT_KEY]: { dataRoot: root } } })
  write(settings())
  if (dataRootFrom === 'overlay') keepDataRootIn(dataRoot)
  const { MNSTRY_ATELIER_PROJECT_CONFIG: _config, MNSTRY_ATELIER_LOCAL_CONFIG: _overlay, ...env } = process.env
  const load = () => resolveProjectConfig({ argv: [`--project=${configPath}`], cwd: projectDir, env, writeLocalState: false })
  const pointer = ensureWorkspaceIdentity({ project: load(), randomBytes: fixedRandom })
  assert.equal(pointer.workspaceId, WORKSPACE_ID)
  const stateOf = (root, workspaceId) => { const requested = workspaceStateRoot(root, workspaceId); fs.mkdirSync(requested, { recursive: true, mode: 0o700 }); return fs.realpathSync(requested) }
  const workspaceRoot = stateOf(dataRoot, WORKSPACE_ID)
  const injected = dataRootFrom === 'injected' ? dataRoot : undefined
  const self = {
    dir, projectDir, dataRoot, configPath, workspaceRoot, write, keepDataRootIn, stateOf, load, loads: 0,
    pointerPath: localPointerPath(load()),
    loadProject: () => { self.loads += 1; return load() },
    // The permission as the service makes it: its loader, and the workspace resolved as at its start.
    permission: ({ loadProject = self.loadProject } = {}) => createViewPermission({
      loadProject, resolveWorkspace: (project) => resolveServiceWorkspace({ project, dataRoot: injected, env }), workspaceId: WORKSPACE_ID, workspaceRoot,
    }),
  }
  return self
}

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
]) {
  test(`a view ${name} is no longer permitted at the very next request, and is permitted again once that is undone`, (t) => {
    const w = world(t)
    const permits = w.permission()
    assert.equal(permits(VIEW), true)
    assert.equal(permits(VIEW), true)
    withdraw(w)
    assert.equal(permits(VIEW), false, 'nothing ticked in between: the project is asked as it is now')
    assert.equal(permits(VIEW), false)
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
    assert.equal(permits(VIEW), true)
    assert.equal(permits(VIEW), true)
    move(w)
    assert.equal(permits(VIEW), false, 'the pointer and the place of the private state are read at every request')
    restore(w)
    assert.equal(permits(VIEW), true)
  })
}

test('a local overlay that moves the private state elsewhere is a change of the project: its views are not permitted for the old place', (t) => {
  const w = world(t, { dataRootFrom: 'overlay' })
  const permits = w.permission()
  assert.equal(permits(VIEW), true)
  assert.equal(permits(VIEW), true)
  const elsewhere = path.join(w.dir, 'data-elsewhere')
  w.stateOf(elsewhere, WORKSPACE_ID)
  const before = w.loads
  w.keepDataRootIn(elsewhere)
  assert.equal(permits(VIEW), false, 'the same workspace identity, kept in another place')
  assert.equal(w.loads, before + 1, 'the overlay is one of the files that decide the project')
  w.keepDataRootIn(w.dataRoot)
  assert.equal(permits(VIEW), true)
})

test('the project is loaded again only when a file that decides it changed, however often a view is asked about', (t) => {
  const w = world(t)
  const permits = w.permission()
  assert.equal(permits(VIEW), true)
  assert.equal(w.loads, 1)
  assert.equal(permits(VIEW), true)
  assert.equal(w.loads, 2, 'kept by the second load: its files were read before it')
  for (let index = 0; index < 50; index += 1) assert.equal(permits(index % 2 === 0 ? VIEW : 'narrow'), index % 2 === 0)
  assert.equal(w.loads, 2, 'fifty requests, no load')
  w.write(settings({ enabled: false }))
  for (let index = 0; index < 50; index += 1) assert.equal(permits(VIEW), false)
  assert.equal(w.loads, 3, 'one load for one change')
  // A file among them that appears is a change too.
  writeJson(path.join(w.projectDir, 'atelier.workspace.local.json'), { preferences: {} })
  assert.equal(permits(VIEW), false)
  assert.equal(w.loads, 4)
  w.write(settings())
  for (let index = 0; index < 50; index += 1) assert.equal(permits(VIEW), true)
  assert.equal(w.loads, 5)
})

test('a change that keeps a file\'s size and its modification time is still seen: the bytes decide, not the times', (t) => {
  const w = world(t)
  // A whole second, which every file system keeps as given.
  const stamp = new Date('2026-01-05T10:00:00.000Z')
  fs.utimesSync(w.configPath, stamp, stamp)
  const permits = w.permission()
  assert.equal(permits(VIEW), true)
  assert.equal(permits(VIEW), true)
  const before = fs.statSync(w.configPath)
  // `tall` for `wide`: another view under a name of the same length.
  w.write(settings({ scopes: [view('tall')] }))
  fs.utimesSync(w.configPath, stamp, stamp)
  const after = fs.statSync(w.configPath)
  assert.deepEqual([after.size, after.mtimeMs], [before.size, before.mtimeMs])
  assert.equal(permits(VIEW), false)
  assert.equal(permits('tall'), true)
})

test('the files are read before the load they vouch for: a change that lands during a load is seen by the next request', (t) => {
  const w = world(t)
  let landing = null
  const permits = w.permission({ loadProject: () => { const project = w.loadProject(); if (landing !== null) { landing(); landing = null } return project } })
  assert.equal(permits(VIEW), true)
  assert.equal(permits(VIEW), true)
  // A change that asks for a load, and the view turned off while that load is under way, after it read the settings.
  w.write({ ...settings(), defaultScopeId: VIEW })
  landing = () => w.write(settings({ enabled: false }))
  permits(VIEW)
  assert.equal(landing, null, 'the load ran')
  assert.equal(permits(VIEW), false, 'the project that load returned is not kept past the bytes it was loaded over')
})

test('a file that decides the project and is a link vouches for nothing: the project is loaded at every request, and a change behind the link is seen', { skip: process.platform === 'win32' ? 'links need a privilege there' : false }, (t) => {
  const w = world(t)
  const real = path.join(w.dir, 'kept-elsewhere.json')
  fs.renameSync(w.configPath, real)
  fs.symlinkSync(real, w.configPath)
  const permits = w.permission()
  for (let index = 0; index < 5; index += 1) assert.equal(permits(VIEW), true)
  assert.equal(w.loads, 5, 'never kept')
  writeJson(real, { ...JSON.parse(fs.readFileSync(real, 'utf8')), ext: { [OBSIDIAN_EXT_KEY]: settings({ enabled: false }) } })
  assert.equal(permits(VIEW), false)
})

test('a loader that fails permits nothing, and is asked again by the next request', (t) => {
  const w = world(t)
  let failing = true
  const permits = w.permission({ loadProject: () => { if (failing) { w.loads += 1; throw new Error('the project cannot be loaded') } return w.loadProject() } })
  assert.equal(permits(VIEW), false)
  assert.equal(permits(VIEW), false)
  assert.equal(w.loads, 2)
  failing = false
  assert.equal(permits(VIEW), true)
  // And a project that loaded, then fails: what was kept is not a reason to go on.
  assert.equal(permits(VIEW), true)
  failing = true
  w.write(settings())
  assert.equal(permits(VIEW), true, 'the same bytes: nothing changed, nothing is loaded')
  w.write(settings({ enabled: false }))
  assert.equal(permits(VIEW), false)
  w.write(settings())
  assert.equal(permits(VIEW), false, 'a changed project that does not load permits nothing, whatever it says')
})

// A loader that answers a promise, as one that composes a personal workspace off the event loop does. Each load waits
// until the test lets it answer, with the project as it is at that moment, or fail.
function deferredLoader(w) {
  const waiting = []
  return {
    loadProject: () => { w.loads += 1; return new Promise((resolve, reject) => { waiting.push({ answer: () => resolve(w.load()), fail: () => reject(new Error('the composition refused')) }) }) },
    waiting: () => waiting.length,
    async answer() { waiting.shift().answer(); await settled() },
    async fail() { waiting.shift().fail(); await settled() },
  }
}

test('a loader that answers a promise is never waited for: nothing is permitted until it answered, one load at a time, and a later request is decided from it', async (t) => {
  const w = world(t)
  const loader = deferredLoader(w)
  const permits = w.permission({ loadProject: loader.loadProject })
  assert.equal(permits(VIEW), false, 'not known yet')
  for (let index = 0; index < 10; index += 1) assert.equal(permits(VIEW), false)
  assert.deepEqual([w.loads, loader.waiting()], [1, 1], 'eleven requests, one load under way')
  await loader.answer()
  // The first load told which files decide the project; the second is the one their bytes vouch for.
  assert.equal(permits(VIEW), false)
  assert.equal(w.loads, 2)
  await loader.answer()
  for (let index = 0; index < 50; index += 1) assert.equal(permits(VIEW), true)
  assert.equal(permits('narrow'), false)
  assert.equal(w.loads, 2, 'kept: fifty requests, no load')

  // Turned off: not permitted from the request that sees the change, before the load has answered and after it.
  w.write(settings({ enabled: false }))
  assert.equal(permits(VIEW), false)
  assert.equal(w.loads, 3)
  await loader.answer()
  assert.equal(permits(VIEW), false)
  assert.equal(w.loads, 3)
  // Turned on again: permitted only once the load that saw it has answered.
  w.write(settings())
  assert.equal(permits(VIEW), false)
  assert.equal(permits(VIEW), false)
  assert.equal(w.loads, 4)
  await loader.answer()
  assert.equal(permits(VIEW), true)
  assert.equal(w.loads, 4)
})

test('a change that lands while a promised load is under way is not answered from that load', async (t) => {
  const w = world(t)
  const loader = deferredLoader(w)
  const permits = w.permission({ loadProject: loader.loadProject })
  permits(VIEW)
  await loader.answer()
  permits(VIEW)
  await loader.answer()
  assert.equal(permits(VIEW), true)
  // A change asks for a load. That load reads the project while the view is still on; the view is turned off before
  // the load answers.
  w.write({ ...settings(), defaultScopeId: VIEW })
  assert.equal(permits(VIEW), false)
  const stillOn = w.load()
  w.write(settings({ enabled: false }))
  assert.equal(permits(VIEW), false, 'still under way')
  assert.equal(loader.waiting(), 1)
  const load = w.load
  w.load = () => stillOn
  await loader.answer()
  w.load = load
  assert.equal(permits(VIEW), false, 'what that load returned says the view is on; the bytes read before it are not the ones there now, so it is not used')
  assert.equal(w.loads, 4, 'loaded again instead')
  await loader.answer()
  assert.equal(permits(VIEW), false)
})

test('a promised load that fails is handled, permits nothing, and is asked for again by a later request', async (t) => {
  const w = world(t)
  const unhandled = []
  const record = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', record)
  t.after(() => process.off('unhandledRejection', record))
  const loader = deferredLoader(w)
  const permits = w.permission({ loadProject: loader.loadProject })
  assert.equal(permits(VIEW), false)
  await loader.fail()
  assert.equal(permits(VIEW), false)
  assert.equal(w.loads, 2, 'asked for again')
  await loader.fail()
  assert.equal(permits(VIEW), false)
  await loader.answer()
  assert.equal(permits(VIEW), false)
  await loader.answer()
  assert.equal(permits(VIEW), true)
  assert.deepEqual(unhandled, [])
})

test('a permission is made with a loader and a workspace resolution, or not at all', () => {
  assert.throws(() => createViewPermission({ resolveWorkspace: () => null, workspaceId: WORKSPACE_ID, workspaceRoot: TMP }), TypeError)
  assert.throws(() => createViewPermission({ loadProject: () => ({}), workspaceId: WORKSPACE_ID, workspaceRoot: TMP }), TypeError)
})
