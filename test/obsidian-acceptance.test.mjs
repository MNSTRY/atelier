import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { EventEmitter } from 'node:events'

// ---------------------------------------------------------------------------
// 0. The spawn guard, installed before anything else is imported: nothing in
// this file may start the installed app, its command-line tool, an
// operating-system opener or a service manager. An attempt throws here.
// A child that could reach a running Obsidian itself (the production service
// entry with its command-line adapter, as the service-world harness starts it
// by default, or anything that loads the production app seams) must have an
// environment that leads to no app of the developer's: the command-line tool
// finds the app through a socket under HOME on macOS and under
// XDG_RUNTIME_DIR on Linux, and the app keeps its settings under HOME (under
// XDG_CONFIG_HOME on Linux, when set). On Windows the app listens on a named
// pipe of the user account, which no environment changes, so no such child is
// started there. With the developer's environment it would ask the
// developer's Obsidian.
// ---------------------------------------------------------------------------

const BANNED_PROGRAMS = ['obsidian-cli', 'obsidian', 'open', 'xdg-open', 'launchctl', 'systemctl']
const WRAPPERS = ['sh', 'bash', 'zsh', 'dash', 'env', 'cmd', 'powershell', 'pwsh', 'nohup', 'sudo']
const REACHES_THE_APP = /--adapter=obsidian-cli|app-production-seams/
// The obsidian command of the real entry also reaches the app through an adapter its workspace remembers. The command
// refuses a remembered adapter under the test runner, but that refusal is the code under test: such a child counts as one
// that can reach the app, inside the runner or not, and needs the private environment.
const mayUseRememberedAdapter = (words) => words.includes('obsidian') && words.some((word) => word === 'open' || word === 'service')
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
  const wrapper = WRAPPERS.includes(programName(command))
  const banned = words.find((word, index) => ((index === 0 || wrapper) && BANNED_PROGRAMS.includes(programName(word))) || /obsidian:\/\//i.test(word))
  if (banned !== undefined) {
    const error = new Error(`spawn guard: this test suite may never start "${programName(banned)}"`)
    guardErrors.push(error.message)
    throw error
  }
  // A child with no env of its own inherits this process's, and with it the developer's HOME.
  const refusal = words.some((word) => REACHES_THE_APP.test(word)) || mayUseRememberedAdapter(words) ? reachesOwnApp(options?.env ?? process.env) : null
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

// ---------------------------------------------------------------------------
// 0a. The owned run of the real-app acceptance harness (experiments/
// obsidian-publication/lib/instance.mjs, OwnedRun): what it may signal, what
// it may remove and how much output it may keep. Directories here are real
// temporary ones; the process table and the spawned handles are stand-ins,
// except in the cases at the end, which use harmless Node children of this
// process (and, on macOS, this platform's own process table) and stand-in
// scripts in place of the app and its command-line tool. The app is never
// started.
//
// ATELIER_OBSIDIAN_CLEANUP_ONLY=1 runs these cases alone, for a quick local
// loop: the rest of the file is then reported as one skipped case, and the
// switch is refused under CI, where the whole file always runs.
// ---------------------------------------------------------------------------

const CLEANUP_ONLY = process.env.ATELIER_OBSIDIAN_CLEANUP_ONLY === '1'
if (CLEANUP_ONLY && process.env.CI) throw new Error('ATELIER_OBSIDIAN_CLEANUP_ONLY skips most of this file and is refused under CI')

{
  const { Instance, OwnedRun, assertPrivateHome, createLayout, parseProcessTable, readOneProcess, readProcessTable } = await import('../experiments/obsidian-publication/lib/instance.mjs')
  const SELF = 4000
  const START = 'Mon Oct 5 00:00:00 2026'
  const LATER = 'Tue Oct 6 00:00:00 2026'
  const row = (pid, ppid = 1, { start = START, command = '/owned/app', uid = 7, exited = false } = {}) => ({ pid, ppid, uid, start, command, exited })
  const exists = (target) => fs.lstatSync(target, { throwIfNoEntry: false }) !== undefined
  const linkDirectory = (target, link) => fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  // A run over a stand-in process table. `rows` is the table, read whole (asynchronously) or one process at a time;
  // a signal sent by number is recorded, and SIGKILL ends that row. Every directory the run still holds is removed
  // when the test ends.
  const fake = (t, rows = [], options = {}) => {
    let clock = 0
    const signals = []
    const end = (pid) => { const at = rows.findIndex((item) => item.pid === pid); if (at >= 0) rows.splice(at, 1) }
    const custody = new OwnedRun({ uid: 7, self: SELF, readTable: async () => rows.map((item) => ({ ...item })), readOne: (pid) => { const found = rows.find((item) => item.pid === pid); return found ? { ...found } : null }, signal: (pid, name) => { signals.push([pid, name]); if (name === 'SIGKILL') end(pid) }, now: () => clock, pause: async (ms) => { clock += ms }, workMs: 1000, cleanupMs: 11000, ...options })
    t.after(() => { for (const root of custody.roots.keys()) fs.rmSync(root, { recursive: true, force: true }) })
    // A stand-in for the handle spawn returns: unreaped until it ends. It ends on SIGKILL, or on any signal when `gentle`.
    const spawned = (pid, { gentle = false } = {}) => {
      const child = Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null, signals: [] })
      child.kill = (name) => {
        child.signals.push(name)
        if (name === 'SIGKILL' || gentle) { child.signalCode = name; end(pid); child.emit('close', null, name) }
        return true
      }
      custody.adopt(child)
      return child
    }
    return { custody, signals, rows, spawned, end }
  }
  const rejection = async (promise) => { try { await promise } catch (error) { return error } assert.fail('expected a rejection') }
  // Holds the next read of the table: the table is taken at once, as it is then, and handed over on `release()`.
  const holdRead = (f) => {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const read = f.custody.readTable
    f.custody.readTable = async (...args) => { f.custody.readTable = read; const taken = await read(...args); await gate; return taken }
    return release
  }
  const turn = () => new Promise((resolve) => { setImmediate(resolve) })

  // -- directories ---------------------------------------------------------

  test('owned run: a layout root is recorded before it is populated and removed after population fails', async (t) => {
    const f = fake(t)
    const error = await rejection(f.custody.execute(() => createLayout(undefined, undefined, { custody: f.custody, io: { ...fs, mkdirSync: () => { throw new Error('population failed') } } })))
    assert.equal(error.message, 'population failed')
    const [root] = error.cleanup.removedRoots
    assert.ok(root.startsWith(path.join(fs.realpathSync(os.tmpdir()), 'atelier-g00-')), 'the root was created under the system temp directory')
    assert.deepEqual([error.cleanup.roots, error.cleanup.retainedRoots, exists(root)], [[root], [], false])
  })

  test('owned run: a root the caller names is never registered for removal', async (t) => {
    const f = fake(t)
    const named = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'atelier-owned-named-'))
    t.after(() => fs.rmSync(named, { recursive: true, force: true }))
    const result = await f.custody.execute(() => createLayout(named, undefined, { custody: f.custody }))
    assert.deepEqual([f.custody.roots.size, result.cleanup.roots, exists(path.join(named, 'profile', 'obsidian.json'))], [0, [], true], 'the named root is populated and left alone')
  })

  test('owned run: an explicit null root or data root is refused, as before an owned run existed, and creates nothing', async (t) => {
    let made = 0
    const io = { ...fs, mkdtempSync: (...args) => { made += 1; return fs.mkdtempSync(...args) } }
    assert.throws(() => createLayout(null, undefined, { io }), TypeError)
    const f = fake(t)
    assert.throws(() => createLayout(null, undefined, { custody: f.custody, io }), TypeError)
    assert.deepEqual([made, f.custody.roots.size], [0, 0], 'no root is created for an explicit null')
    // A null data root is refused too; the root created before it is the run's own and is removed.
    const error = await rejection(f.custody.execute(() => createLayout(undefined, null, { custody: f.custody })))
    assert.ok(error instanceof TypeError)
    assert.deepEqual([error.cleanup.removedRoots.length, error.cleanup.retainedRoots], [1, []])
  })

  test('owned run: removal checks which directory the path names, not what it is called', async (t) => {
    const f = fake(t)
    const root = f.custody.allocateRoot('atelier-owned-test-')
    const aside = `${root}.aside`
    t.after(() => fs.rmSync(aside, { recursive: true, force: true }))
    // Another directory now stands at the recorded path.
    fs.renameSync(root, aside)
    fs.mkdirSync(root)
    fs.writeFileSync(path.join(root, 'not-this-runs.txt'), 'kept')
    const error = await rejection(f.custody.execute(() => 'done'))
    assert.match(error.message, /could not be verified/)
    assert.deepEqual([error.cleanup.retainedRoots, error.cleanup.removedRoots, fs.readFileSync(path.join(root, 'not-this-runs.txt'), 'utf8'), exists(aside)], [[root], [], 'kept', true])
    assert.ok(error.cleanup.unknown.some((item) => item.startsWith('root-removal:')))
  })

  test('owned run: a link standing where a root was is neither followed nor removed', async (t) => {
    const f = fake(t)
    const root = f.custody.allocateRoot('atelier-owned-test-')
    const aside = `${root}.aside`
    const elsewhere = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'atelier-owned-elsewhere-'))
    t.after(() => { for (const target of [root, aside, elsewhere]) fs.rmSync(target, { recursive: true, force: true }) })
    fs.writeFileSync(path.join(elsewhere, 'outside.txt'), 'kept')
    fs.renameSync(root, aside)
    linkDirectory(elsewhere, root)
    const error = await rejection(f.custody.execute(() => 'done'))
    assert.deepEqual([error.cleanup.retainedRoots, fs.readFileSync(path.join(elsewhere, 'outside.txt'), 'utf8'), fs.lstatSync(root).isSymbolicLink()], [[root], 'kept', true])
  })

  test('owned run: a link inside a root is removed as a link and what it points at is kept', async (t) => {
    const f = fake(t)
    const root = f.custody.allocateRoot('atelier-owned-test-')
    const elsewhere = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'atelier-owned-elsewhere-'))
    t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }))
    fs.writeFileSync(path.join(elsewhere, 'outside.txt'), 'kept')
    fs.mkdirSync(path.join(root, 'nested'))
    fs.writeFileSync(path.join(root, 'nested', 'inside.txt'), 'removed')
    linkDirectory(elsewhere, path.join(root, 'nested', 'out'))
    const result = await f.custody.execute(() => 'done')
    assert.deepEqual([result.cleanup.removedRoots, exists(root), fs.readFileSync(path.join(elsewhere, 'outside.txt'), 'utf8')], [[root], false, 'kept'])
  })

  test('owned run: a removal that fails reports only the roots actually kept', async (t) => {
    let refused = null
    const f = fake(t, [], { io: { ...fs, rmSync: (target, options) => { if (target === refused) throw new Error('busy'); return fs.rmSync(target, options) } } })
    const removed = f.custody.allocateRoot('atelier-owned-test-')
    refused = f.custody.allocateRoot('atelier-owned-test-')
    const error = await rejection(f.custody.execute(() => 'done'))
    assert.deepEqual([error.cleanup.removedRoots, error.cleanup.retainedRoots, error.cleanup.retained, exists(removed), exists(refused)], [[removed], [refused], true, false, true])
    assert.ok(error.cleanup.unknown.includes('root-removal:busy'))
  })

  test('owned run: a root that is already gone is reported absent, and --keep removes nothing', async (t) => {
    const gone = fake(t)
    const absent = gone.custody.allocateRoot('atelier-owned-test-')
    fs.rmSync(absent, { recursive: true })
    const result = await gone.custody.execute(() => 'done')
    assert.deepEqual([result.cleanup.absentRoots, result.cleanup.removedRoots, result.cleanup.retained], [[absent], [], false])
    const kept = fake(t)
    const root = kept.custody.allocateRoot('atelier-owned-test-')
    const held = await kept.custody.execute(() => 'done', { keep: true })
    assert.deepEqual([held.cleanup.joined, held.cleanup.retained, held.cleanup.retainedRoots, exists(root)], [true, true, [root], true])
  })

  // -- processes -----------------------------------------------------------

  test('owned run: cleanup ends the spawned app by its handle and its helpers by lineage, reading until a read records nothing new, and nothing else', async (t) => {
    // 13 is listed before its parent 11. A process first recorded from a table passes lineage on only from the next
    // read, whatever the order of the table, so cleanup reads again before its first signal until a read records
    // nothing new: its first read records 11, its second 13, its third nothing.
    const table = () => [row(13, 11), row(10, SELF), row(11, 10), row(12, SELF, { command: '/owned/cli' }), row(90), row(91, SELF, { command: '/not/adopted' }), row(92, 90)]
    const f = fake(t, table())
    const root = f.custody.allocateRoot('atelier-owned-test-')
    const app = f.spawned(10, { gentle: true })
    const cli = f.spawned(12)
    let readsBeforeFirstSignal = null
    const send = f.custody.signal
    f.custody.signal = (pid, name) => { readsBeforeFirstSignal ??= f.custody.tableReads; send(pid, name) }
    const result = await f.custody.execute(() => 'done')
    assert.equal(result.cleanup.joined, true)
    assert.deepEqual([app.signals, cli.signals], [['SIGTERM'], ['SIGTERM', 'SIGKILL']], 'spawned processes are signalled through their handles')
    assert.deepEqual([f.signals, readsBeforeFirstSignal], [[[11, 'SIGTERM'], [13, 'SIGTERM'], [11, 'SIGKILL'], [13, 'SIGKILL']], 3], 'only the two helpers are signalled by number, both from the first signal on')
    assert.deepEqual([f.rows.map(({ pid }) => pid), exists(root)], [[90, 91, 92], false], 'a process this run did not start, even a child of this very process, is untouched')
    // A run whose watcher read the table before cleanup signals the same, in the same order.
    const watched = fake(t, table())
    watched.spawned(10, { gentle: true })
    watched.spawned(12)
    await watched.custody.observe()
    assert.deepEqual([...watched.custody.descendants.keys()], [11], 'one level per read')
    await watched.custody.execute(() => 'done')
    assert.deepEqual(watched.signals, [[11, 'SIGTERM'], [13, 'SIGTERM'], [11, 'SIGKILL'], [13, 'SIGKILL']])
  })

  test('owned run: the reads before cleanup\'s first signal leave SIGTERM a grace of its own', async (t) => {
    // A chain five helpers deep, and a table that takes a second to read: each read finds one more level. With a
    // cleanup budget of 11 s SIGTERM is given 5.5 s, and the reads may use its first half as far as the last read
    // predicts the next: two reads, then the first signal at 2 s, leaving 3.5 s before SIGKILL.
    const f = fake(t, [row(10, SELF), row(11, 10), row(12, 11), row(13, 12), row(14, 13), row(15, 14)])
    f.spawned(10, { gentle: true })
    const read = f.custody.readTable
    f.custody.readTable = async (...args) => { const rows = await read(...args); await f.custody.pause(1000); return rows }
    let first = null
    const send = f.custody.signal
    f.custody.signal = (pid, name) => { first ??= { pid, name, at: f.custody.now(), reads: f.custody.tableReads }; send(pid, name) }
    const result = await f.custody.execute(() => 'done')
    assert.deepEqual([first, result.cleanup.joined], [{ pid: 11, name: 'SIGTERM', at: 2000, reads: 2 }, true])
  })

  test('owned run: a grandchild first seen by cleanup is recorded and ended, even when its parent exits at the first signal', async (t) => {
    // 12 is the child of the app's helper 11. No read has been made before cleanup. 11 exits on SIGTERM, and 12, which
    // ignores SIGTERM, is left to the first process.
    const f = fake(t, [row(10, SELF), row(11, 10), row(12, 11, { command: '/owned/helper --child' })])
    const root = f.custody.allocateRoot('atelier-owned-test-')
    f.spawned(10, { gentle: true })
    const send = f.custody.signal
    f.custody.signal = (pid, name) => {
      send(pid, name)
      if (pid === 11 && name === 'SIGTERM') { f.end(11); f.rows.splice(0, f.rows.length, ...f.rows.map((item) => (item.ppid === 11 ? { ...item, ppid: 1 } : item))) }
    }
    const result = await f.custody.execute(() => 'done')
    assert.deepEqual([f.signals, f.rows, result.cleanup.joined, result.cleanup.unknown, exists(root)], [[[11, 'SIGTERM'], [12, 'SIGTERM'], [12, 'SIGKILL']], [], true, [], false], 'the grandchild was recorded before its parent was ended, and is ended by lineage')
  })

  test('owned run: a process that only names one of the run\'s directories is never signalled, and the roots are kept while it is there', async (t) => {
    const helper = '/Applications/Obsidian.app/Contents/Frameworks/Helper --type=gpu --user-data-dir=/owned/profile'
    const f = fake(t)
    const root = f.custody.allocateRoot('atelier-owned-test-')
    f.custody.profiles.add('/owned/profile')
    // 53 detached itself from the app and names only a file under the profile; 54 names the root itself.
    f.rows.push(row(50, 1, { command: `${helper} --flag` }), row(51, 1, { command: helper }), row(52, 1, { command: `${helper}-other` }), row(53, 1, { command: '/detached/handler --database=/owned/profile/reports' }), row(54, 1, { command: `/usr/bin/tool ${root}` }), row(55, 1, { command: `/usr/bin/tool ${root}-sibling/file` }))
    const error = await rejection(f.custody.execute(() => 'done'))
    assert.deepEqual(f.signals, [], 'a name is never a reason to signal')
    assert.deepEqual([error.cleanup.unknown, error.cleanup.retainedRoots, exists(root)], [['process-join-incomplete', 'unowned-process-remains:50', 'unowned-process-remains:51', 'unowned-process-remains:53', 'unowned-process-remains:54'], [root], true], 'those that name a directory of the run are reported; a longer name is another directory')
    assert.deepEqual(f.rows.map(({ pid }) => pid), [50, 51, 52, 53, 54, 55])
    // One that leaves by itself inside the cleanup budget does not hold the roots.
    const leaving = fake(t, [row(50, 1, { command: helper })])
    const second = leaving.custody.allocateRoot('atelier-owned-test-')
    leaving.custody.profiles.add('/owned/profile')
    leaving.custody.pause = async () => { leaving.end(50) }
    const result = await leaving.custody.execute(() => 'done')
    assert.deepEqual([result.cleanup.joined, leaving.signals, exists(second)], [true, [], false])
  })

  test('owned run: a number that now belongs to another process is not signalled, and the original failure is kept', async (t) => {
    const f = fake(t, [row(10, SELF), row(11, 10)])
    const root = f.custody.allocateRoot('atelier-owned-test-')
    f.spawned(10, { gentle: true })
    await f.custody.observe()
    assert.deepEqual([...f.custody.descendants.keys()], [11])
    // The helper is gone and its number was given to something else before this run looked again.
    f.rows[1] = row(11, 1, { start: LATER, command: '/someone/elses' })
    await f.custody.observe()
    assert.deepEqual([[...f.custody.descendants.keys()], [...f.custody.unknown]], [[], ['changed:11']], 'the next table alone releases it')
    const error = await rejection(f.custody.execute(() => { throw new Error('original failure') }))
    assert.equal(error.message, 'original failure')
    assert.deepEqual([f.signals, error.cleanup.joined, error.cleanup.unknown, error.cleanup.retainedRoots, exists(root)], [[], false, ['changed:11'], [root], true])
    assert.deepEqual(f.rows.map(({ pid }) => pid), [11])
  })

  test('owned run: a helper seen to exit is released, and a later holder of its number is never this run\'s', async (t) => {
    const f = fake(t, [row(10, SELF), row(11, 10), row(14, 10)])
    const root = f.custody.allocateRoot('atelier-owned-test-')
    f.spawned(10, { gentle: true })
    await f.custody.observe()
    // 11 leaves the table; 14 has exited and only awaits collection by its parent.
    f.end(11)
    f.rows[1] = row(14, 10, { command: '<defunct>', exited: true })
    await f.custody.observe()
    assert.deepEqual([...f.custody.descendants.keys()], [], 'both are released')
    // Their numbers come back as other processes, one of them with a child of its own.
    f.rows.push(row(11, 1, { start: LATER, command: '/someone/elses' }), row(15, 11, { start: LATER }))
    f.rows[1] = row(14, 1, { start: LATER, command: '/someone/elses' })
    const result = await f.custody.execute(() => 'done')
    assert.deepEqual([result.cleanup.joined, f.signals, f.rows.map(({ pid }) => pid), exists(root)], [true, [], [14, 11, 15], false])
  })

  // Each part of the identity is checked on its own: a number whose start time, command or user alone has changed
  // belongs to another process.
  for (const [part, changed] of [['start time', { start: LATER }], ['command', { command: '/owned/app --other' }], ['user', { uid: 8 }]]) {
    test(`owned run: identity is read again before every signal, and a changed ${part} alone refuses it`, async (t) => {
      const f = fake(t, [row(10, SELF), row(11, 10), row(12, 10)])
      const root = f.custody.allocateRoot('atelier-owned-test-')
      f.spawned(10, { gentle: true })
      // While the first helper is signalled, the second one's number changes hands. Nothing reads the table between
      // the two signals except the readback each signal makes for itself.
      const send = f.custody.signal
      f.custody.signal = (pid, name) => { send(pid, name); if (pid === 11 && name === 'SIGTERM') f.rows[f.rows.findIndex((item) => item.pid === 12)] = row(12, 10, changed) }
      const error = await rejection(f.custody.execute(() => 'done'))
      assert.deepEqual([f.signals, error.cleanup.unknown, f.rows.map(({ pid }) => pid), exists(root)], [[[11, 'SIGTERM'], [11, 'SIGKILL']], ['changed:12'], [12], true], 'the new holder of the number is never signalled')
    })
  }

  test('owned run: a child of a process that took over an owned number is never adopted', async (t) => {
    const f = fake(t, [row(10, SELF), row(11, 10)])
    f.spawned(10, { gentle: true })
    await f.custody.observe()
    f.rows[1] = row(11, 1, { start: LATER, command: '/someone/elses' })
    f.rows.push(row(12, 11, { start: LATER }))
    await rejection(f.custody.execute(() => 'done'))
    assert.deepEqual([f.custody.descendants.has(12), f.signals], [false, []])
  })

  // A table takes time to read. What it shows is joined only to handles the run held before the read began and
  // still holds after it; never to a handle adopted meanwhile, whose number the table may show as someone else's.
  for (const [whose, parent] of [['an unrelated process', 1], ['a process whose row names this one as its parent', SELF]]) {
    test(`owned run: a child adopted while the table is being read does not make the children of ${whose} its own`, async (t) => {
      // When the table is taken, number 40 is another process, with a child 41.
      const f = fake(t, [row(40, parent, { command: '/someone/elses' }), row(41, 40, { command: '/someone/elses --child' })])
      const root = f.custody.allocateRoot('atelier-owned-test-')
      const release = holdRead(f)
      const reading = f.custody.observe()
      await turn()
      // That process exits, and before the table is handed over the run spawns a child that is given number 40.
      f.rows[0] = row(40, SELF, { start: LATER })
      f.rows[1] = row(41, 1, { command: '/someone/elses --child' })
      const child = f.spawned(40, { gentle: true })
      release()
      await reading
      assert.deepEqual([[...f.custody.descendants.keys()], [...f.custody.strays.keys()], [...f.custody.unknown]], [[], [], []], 'nothing in that table is the new child\'s')
      const result = await f.custody.execute(() => 'done')
      assert.deepEqual([f.signals, child.signals, f.rows.map(({ pid }) => pid), result.cleanup.joined, exists(root)], [[], ['SIGTERM'], [41], true, false], 'the other process\'s child is never signalled')
    })
  }

  test('owned run: the children of a spawned process that exits while the table is being read are not recorded from that table', async (t) => {
    const f = fake(t, [row(10, SELF), row(11, 10)])
    const child = f.spawned(10)
    const release = holdRead(f)
    const reading = f.custody.observe()
    await turn()
    // The child is collected and its number is given to another process before the table is handed over.
    child.exitCode = 0
    f.rows[0] = row(10, 1, { start: LATER, command: '/someone/elses' })
    f.rows[1] = row(11, 1)
    release()
    await reading
    // The table still shows 11 under the child that was collected during the read: it is remembered, never recorded.
    assert.deepEqual([[...f.custody.descendants.keys()], [...f.custody.orphans.keys()], [...f.custody.unknown]], [[], [11], []], 'a number the run no longer holds starts no lineage, and what the table shows under it is remembered')
    child.emit('close', 0, null)
    const error = await rejection(f.custody.execute(() => 'done'))
    assert.deepEqual([f.signals, f.rows.map(({ pid }) => pid), error.cleanup.unknown], [[], [10, 11], ['process-join-incomplete', 'unrecorded-child-remains:11']], 'it is still there, so the run keeps its roots')
  })

  test('owned run: nothing is recorded under a descendant that no longer answers as itself once the table has been read', async (t) => {
    const f = fake(t, [row(10, SELF), row(11, 10)])
    const root = f.custody.allocateRoot('atelier-owned-test-')
    f.spawned(10, { gentle: true })
    await f.custody.observe()
    assert.deepEqual([...f.custody.descendants.keys()], [11])
    // ps reads row after row: it read 11 while 11 was the helper, and a moment later read 12 naming 11 as parent,
    // by when another process had taken that number and started 12. Read back after the table, 11 is not itself.
    f.rows.push(row(12, 11, { start: LATER, command: '/someone/elses --child' }))
    const release = holdRead(f)
    const reading = f.custody.observe()
    await turn()
    f.rows[1] = row(11, 1, { start: LATER, command: '/someone/elses' })
    release()
    await reading
    assert.deepEqual([[...f.custody.descendants.keys()], [...f.custody.orphans.keys()], [...f.custody.unknown]], [[], [12], ['changed:11']], '12 is not recorded but remembered, and 11 is released')
    const error = await rejection(f.custody.execute(() => 'done'))
    assert.deepEqual([f.signals, f.rows.map(({ pid }) => pid), error.cleanup.unknown, exists(root)], [[], [11, 12], ['changed:11', 'process-join-incomplete', 'unrecorded-child-remains:12'], true])
    // A helper that still answers as itself does pass its lineage on, from the read after the one that recorded it.
    const g = fake(t, [row(10, SELF), row(11, 10), row(12, 11)])
    g.spawned(10)
    await g.custody.observe()
    assert.deepEqual([...g.custody.descendants.keys()], [11], 'not from the table that first recorded it')
    await g.custody.observe()
    assert.deepEqual([...g.custody.descendants.keys()], [11, 12])
    // A helper first seen in a table, and gone by the time that table is handed over: nothing the table shows under
    // it is recorded. It is recorded itself (its parent is held), is released by the next read, and is never signalled.
    const h = fake(t, [row(10, SELF), row(11, 10), row(12, 11)])
    h.spawned(10)
    const handOver = holdRead(h)
    const stale = h.custody.observe()
    await turn()
    h.end(11)
    h.rows[1] = row(12, 1)
    handOver()
    await stale
    assert.deepEqual([[...h.custody.descendants.keys()], [...h.custody.unknown]], [[11], []])
    await h.custody.observe()
    assert.deepEqual([[...h.custody.descendants.keys()], [...h.custody.unknown], h.signals], [[], [], []])
  })

  // The table is not read at one instant. Here it read the row of 41 while 41's parent, number 40, was another
  // process; that process exited, a helper of the run's own child 10 was given number 40, and the table read 40's row
  // as that helper. Read back alone after the table, 40 answers as the helper it was recorded as.
  test('owned run: a process first recorded from a table does not pass lineage on from that same table', async (t) => {
    const f = fake(t, [row(10, SELF), row(40, 10, { command: '/owned/helper' }), row(41, 40, { command: '/someone/elses --child' })])
    const root = f.custody.allocateRoot('atelier-owned-test-')
    f.spawned(10, { gentle: true })
    const release = holdRead(f)
    const reading = f.custody.observe()
    await turn()
    // When the table is handed over, 41 is the first process's child: its parent exited long before.
    f.rows[2] = row(41, 1, { command: '/someone/elses --child' })
    release()
    await reading
    assert.deepEqual([[...f.custody.descendants.keys()], [...f.custody.strays.keys()], [...f.custody.unknown]], [[40], [], []], '40 is recorded; nothing under it is, from the same table')
    const result = await f.custody.execute(() => 'done')
    assert.deepEqual([f.signals, f.rows.map(({ pid }) => pid), result.cleanup.joined, exists(root)], [[[40, 'SIGTERM'], [40, 'SIGKILL']], [41], true, false], 'the other process\'s child is never signalled')
    // A number recorded by an earlier read that this table shows as another helper is recorded anew, as that helper,
    // and passes nothing on from this table either: it is the identity that was recorded before, not the number.
    const e = fake(t, [row(10, SELF), row(40, 10, { command: '/owned/helper' })])
    e.spawned(10)
    await e.custody.observe()
    e.rows[1] = row(40, 10, { start: LATER, command: '/owned/helper-b' })
    e.rows.push(row(41, 40, { start: LATER, command: '/someone/elses --child' }))
    await e.custody.observe()
    assert.deepEqual([[...e.custody.descendants.keys()], e.custody.descendants.get(40).command, [...e.custody.orphans.keys()], [...e.custody.unknown], e.signals], [[40], '/owned/helper-b', [41], ['changed:40'], []])
    // Control: with 40 recorded by an earlier read, and 41 its child, the same rows do pass lineage on.
    const g = fake(t, [row(10, SELF), row(40, 10, { command: '/owned/helper' })])
    g.spawned(10)
    await g.custody.observe()
    g.rows.push(row(41, 40, { command: '/owned/helper --child' }))
    await g.custody.observe()
    assert.deepEqual([...g.custody.descendants.keys()], [40, 41])
  })

  test('owned run: what a table shows, unrecorded, under a parent that lapsed during the read is remembered until it is seen gone, keeps the roots while it is there, and is never signalled', async (t) => {
    const f = fake(t, [row(10, SELF), row(11, 10)])
    const root = f.custody.allocateRoot('atelier-owned-test-')
    f.spawned(10, { gentle: true })
    await f.custody.observe()
    // 11 is recorded. A table is then taken while 11 runs with a child 12, and a child 13 that runs as another user;
    // 11 exits before that table is handed over, and its children are left to the first process.
    f.rows.push(row(12, 11, { command: '/owned/helper --child' }), row(13, 11, { uid: 0 }))
    const release = holdRead(f)
    const reading = f.custody.observe()
    await turn()
    f.end(11)
    f.rows.splice(0, f.rows.length, ...f.rows.map((item) => (item.ppid === 11 ? { ...item, ppid: 1 } : item)))
    release()
    await reading
    assert.deepEqual([[...f.custody.descendants.keys()], [...f.custody.orphans.keys()], [...f.custody.unknown]], [[], [12], []], 'the child of this user is remembered; the other user\'s is not')
    const error = await rejection(f.custody.execute(() => 'done'))
    assert.deepEqual([f.signals, error.cleanup.unknown, error.cleanup.retainedRoots, exists(root), f.rows.map(({ pid }) => pid)], [[], ['process-join-incomplete', 'unrecorded-child-remains:12'], [root], true, [12, 13]])
    // The same, with the remembered process leaving by itself during the cleanup budget: once it is seen gone it holds
    // nothing, and the run ends clean.
    const leaving = fake(t, [row(10, SELF), row(11, 10)])
    const third = leaving.custody.allocateRoot('atelier-owned-test-')
    leaving.spawned(10, { gentle: true })
    await leaving.custody.observe()
    leaving.rows.push(row(12, 11, { command: '/owned/helper --child' }))
    const handOver = holdRead(leaving)
    const late = leaving.custody.observe()
    await turn()
    leaving.end(11)
    leaving.rows.splice(0, leaving.rows.length, ...leaving.rows.map((item) => (item.ppid === 11 ? { ...item, ppid: 1 } : item)))
    handOver()
    await late
    assert.deepEqual([...leaving.custody.orphans.keys()], [12])
    const wait = leaving.custody.pause
    leaving.custody.pause = async (ms) => { leaving.end(12); await wait(ms) }
    const resolved = await leaving.custody.execute(() => 'done')
    assert.deepEqual([resolved.cleanup.joined, resolved.cleanup.unknown, leaving.signals, [...leaving.custody.orphans.keys()], exists(third)], [true, [], [], [], false])
    // A parent that exits between two reads has left its children to the first process before the next table is
    // taken: nothing is noted, and the run ends clean.
    const g = fake(t, [row(10, SELF), row(11, 10)])
    const second = g.custody.allocateRoot('atelier-owned-test-')
    g.spawned(10, { gentle: true })
    await g.custody.observe()
    g.end(11)
    g.rows.push(row(12, 1))
    const result = await g.custody.execute(() => 'done')
    assert.deepEqual([result.cleanup.joined, result.cleanup.unknown, g.signals, exists(second)], [true, [], [], false])
  })

  test('owned run: what a remembered process starts is remembered with it, so the child it leaves behind keeps the roots, and nothing is signalled', async (t) => {
    // 11 is recorded, then exits while a table is being read that shows its child 12: 12 is remembered.
    const orphanOf11 = async (f) => {
      f.spawned(10, { gentle: true })
      await f.custody.observe()
      f.rows.push(row(12, 11, { command: '/owned/helper --child' }))
      const release = holdRead(f)
      const reading = f.custody.observe()
      await turn()
      f.end(11)
      f.rows.splice(0, f.rows.length, ...f.rows.map((item) => (item.ppid === 11 ? { ...item, ppid: 1 } : item)))
      release()
      await reading
      assert.deepEqual([...f.custody.orphans.keys()], [12])
    }
    // 12 starts 14, which a table shows under it; 12 then exits, and 14 is left to the first process.
    const f = fake(t, [row(10, SELF), row(11, 10)])
    const root = f.custody.allocateRoot('atelier-owned-test-')
    await orphanOf11(f)
    f.rows.push(row(14, 12, { command: '/owned/helper --daemon' }))
    await f.custody.observe()
    assert.deepEqual([...f.custody.orphans.keys()], [12, 14], 'remembered with its parent')
    f.end(12)
    f.rows.splice(0, f.rows.length, ...f.rows.map((item) => (item.ppid === 12 ? { ...item, ppid: 1 } : item)))
    await f.custody.observe()
    assert.deepEqual([...f.custody.orphans.keys()], [14], 'the parent is seen gone; the child it left is still remembered')
    const error = await rejection(f.custody.execute(() => 'done'))
    assert.deepEqual([f.signals, error.cleanup.unknown, error.cleanup.retainedRoots, exists(root), f.rows.map(({ pid }) => pid)], [[], ['process-join-incomplete', 'unrecorded-child-remains:14'], [root], true, [14]])
    // A remembered process that exits while a table is being read: the table read its child 15's row while 12 was
    // there, naming 12 as parent, and 12's after it had gone. 15 is remembered.
    const g = fake(t, [row(10, SELF), row(11, 10)])
    const second = g.custody.allocateRoot('atelier-owned-test-')
    await orphanOf11(g)
    g.rows.push(row(15, 12, { command: '/owned/helper --daemon' }))
    g.end(12)
    await g.custody.observe()
    assert.deepEqual([...g.custody.orphans.keys()], [15])
    g.rows.splice(0, g.rows.length, ...g.rows.map((item) => (item.ppid === 12 ? { ...item, ppid: 1 } : item)))
    const kept = await rejection(g.custody.execute(() => 'done'))
    assert.deepEqual([g.signals, kept.cleanup.unknown, exists(second)], [[], ['process-join-incomplete', 'unrecorded-child-remains:15'], true])
  })

  test('owned run: a held handle starts lineage only when its row names this process as parent and started when it was bound', async (t) => {
    const f = fake(t, [row(10, 1), row(11, 10), row(20, SELF, { command: '/owned/app --user-data-dir=/owned/profile' }), row(21, 20)])
    f.spawned(10)
    f.spawned(20)
    const bound = [...f.custody.children][1]
    assert.equal((await f.custody.bind(bound, { program: '/owned/app', profile: '/owned/profile' })).start, START)
    // The row for the bound number now carries another start time.
    f.rows[2] = row(20, SELF, { start: LATER, command: '/owned/app --user-data-dir=/owned/profile' })
    await f.custody.observe()
    assert.deepEqual([[...f.custody.descendants.keys()], [...f.custody.unknown]], [[], ['spawned-row-mismatch:10', 'spawned-row-mismatch:20']])
    // With rows that agree, the same two handles start their lineage.
    f.rows[0] = row(10, SELF)
    f.rows[2] = row(20, SELF, { command: '/owned/app --user-data-dir=/owned/profile' })
    await f.custody.observe()
    assert.deepEqual([...f.custody.descendants.keys()], [11, 21])
  })

  test('owned run: a number one of the run\'s own handles holds is never recorded or signalled as a descendant', async (t) => {
    const f = fake(t, [row(10, SELF), row(12, 10), row(13, 10)])
    f.spawned(10)
    await f.custody.observe()
    assert.deepEqual([...f.custody.descendants.keys()], [12, 13])
    // Both helpers exit and the run's own new children are given their numbers: one looks different, one alike.
    f.rows[1] = row(12, SELF, { start: LATER, command: '/owned/cli' })
    f.rows[2] = row(13, SELF)
    const [different, alike] = [f.spawned(12), f.spawned(13)]
    assert.equal(f.custody.signalDescendant(13, 'SIGKILL'), false, 'not by number, however alike the row')
    f.custody.descendants.set(13, row(13, 10))
    await f.custody.observe()
    assert.deepEqual([[...f.custody.descendants.keys()], [...f.custody.unknown], f.signals, different.signals, alike.signals], [[], [], [], [], []], 'released without a claim that anything changed')
    // A table taken while 14 was a helper and 15 another process naming the profile, handed over after both numbers
    // were given to the run's own new children: neither row is recorded, as a descendant or as a process that remains.
    f.custody.profiles.add('/owned/profile')
    f.rows.push(row(14, 10), row(15, 1, { command: '/someone/elses --user-data-dir=/owned/profile' }))
    const release = holdRead(f)
    const reading = f.custody.observe()
    await turn()
    f.rows.splice(-2, 2, row(14, SELF, { start: LATER }), row(15, SELF, { start: LATER }))
    f.spawned(14)
    f.spawned(15)
    release()
    await reading
    assert.deepEqual([[...f.custody.descendants.keys()], [...f.custody.strays.keys()], [...f.custody.unknown]], [[], [], []])
  })

  test('owned run: cleanup begins its own read of the table and does not settle for one begun earlier', async (t) => {
    const f = fake(t, [row(10, SELF)])
    const root = f.custody.allocateRoot('atelier-owned-test-')
    f.spawned(10, { gentle: true })
    // A read is under way (the watcher's) when the app starts a helper, and cleanup begins before it is handed over.
    const release = holdRead(f)
    const earlier = f.custody.observe()
    await turn()
    f.rows.push(row(11, 10))
    const run = f.custody.execute(() => 'done')
    await turn()
    release()
    await earlier
    const result = await run
    assert.deepEqual([f.signals, f.rows, result.cleanup.joined, exists(root)], [[[11, 'SIGTERM'], [11, 'SIGKILL']], [], true, false], 'the helper the earlier table did not show is ended by lineage')
  })

  test('owned run: a handle that has reported its exit is never signalled, whatever now holds its number', async (t) => {
    const f = fake(t, [row(10, 1, { start: LATER, command: '/someone/elses' }), row(16, 10, { start: LATER })])
    const child = f.spawned(10)
    // Collected (the number is free again) but its streams are not yet closed.
    child.exitCode = 0
    assert.equal(f.custody.signalChild([...f.custody.children][0], 'SIGKILL'), false)
    const error = await rejection(f.custody.execute(() => 'done'))
    assert.deepEqual([child.signals, f.signals, [...f.custody.descendants.keys()], error.cleanup.unknown], [[], [], [], ['process-join-incomplete']], 'neither the number nor its new children are touched; the open streams are reported')
  })

  test('owned run: an unreadable process table is unknown custody, and spawned children are still ended through their handles', async (t) => {
    const f = fake(t, [row(10, SELF)], { readTable: () => { throw new Error('ps unavailable') } })
    const root = f.custody.allocateRoot('atelier-owned-test-')
    const app = f.spawned(10)
    const error = await rejection(f.custody.execute(() => 'done'))
    assert.deepEqual([app.signals, f.signals, f.custody.children.size], [['SIGTERM', 'SIGKILL'], [], 0])
    assert.deepEqual([error.cleanup.joined, error.cleanup.unknown, error.cleanup.retainedRoots, exists(root)], [false, ['process-readback:ps unavailable'], [root], true], 'no table is never proof that everything is gone')
  })

  test('owned run: a spawned process is read back as this run\'s own child running the asked program, or the run stops', async (t) => {
    const f = fake(t, [row(25, SELF, { command: '/foreign/app --user-data-dir=/foreign' }), row(26, SELF, { command: '/owned/app --user-data-dir=/owned/profile --flag' }), row(27, 1, { command: '/owned/app --user-data-dir=/owned/profile' })])
    const [wrong, right, notOurs] = [25, 26, 27].map((pid) => f.spawned(pid))
    const entries = [...f.custody.children]
    assert.deepEqual((await f.custody.bind(entries[1], { program: '/owned/app', profile: '/owned/profile' })).pid, right.pid)
    await assert.rejects(f.custody.bind(entries[2], { program: '/owned/app', profile: '/owned/profile' }), /identity/, 'a row whose parent is not this process is not the child')
    await assert.rejects(f.custody.bind(entries[0], { program: '/owned/app', profile: '/owned/profile' }), /identity/)
    assert.deepEqual([f.custody.children.size, wrong.signals, notOurs.signals, f.signals, f.custody.unknown.has('unbound:27')], [3, [], [], [], true], 'still held by their handles; nothing was signalled')
    assert.throws(() => f.custody.assertActive(), /identity/)
  })

  test('owned run: a spawned process read back under another user is not bound', async (t) => {
    const f = fake(t, [row(28, SELF, { command: '/owned/app --user-data-dir=/owned/profile', uid: 0 })])
    const child = f.spawned(28)
    await assert.rejects(f.custody.bind([...f.custody.children][0], { program: '/owned/app', profile: '/owned/profile' }), /identity/)
    assert.deepEqual([child.signals, f.signals, f.custody.unknown.has('unbound:28')], [[], [], true])
  })

  test('owned run: an error from a running child keeps it held; a spawn that produced no process is let go', async (t) => {
    const f = fake(t)
    const standIn = (pid) => Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null, kill: () => true })
    const running = standIn(31)
    f.custody.adopt(running)
    running.emit('error', new Error('a signal could not be delivered'))
    const never = standIn(undefined)
    f.custody.adopt(never)
    never.emit('error', new Error('spawn ENOENT'))
    assert.deepEqual([...f.custody.children].map((entry) => entry.child.pid), [31])
    // A real spawn of a program that does not exist produces no process and is let go the same way.
    const missing = childProcess.spawn(path.join(fs.realpathSync(os.tmpdir()), 'atelier-owned-no-such-program'), [], { stdio: 'ignore' })
    f.custody.adopt(missing)
    await new Promise((resolve) => { missing.once('error', resolve) })
    assert.deepEqual([missing.pid, [...f.custody.children].map((entry) => entry.child.pid)], [undefined, [31]])
  })

  test('owned run: a descendant of another user is never signalled and holds the roots', async (t) => {
    const f = fake(t, [row(10, SELF), row(11, 10, { uid: 0 })])
    const root = f.custody.allocateRoot('atelier-owned-test-')
    f.spawned(10, { gentle: true })
    const error = await rejection(f.custody.execute(() => 'done'))
    assert.deepEqual([f.signals, [...f.custody.descendants.keys()], error.cleanup.unknown, exists(root)], [[], [], ['process-join-incomplete', 'unowned-process-remains:11'], true])
  })

  test('owned run: the first process, this process and a nameless number are never signalled', (t) => {
    const f = fake(t, [row(1, 0), row(SELF, 1), row(0, 0)])
    for (const pid of [1, SELF, 0]) f.custody.descendants.set(pid, f.rows.find((item) => item.pid === pid))
    assert.deepEqual([1, SELF, 0, -10, 99].map((pid) => f.custody.signalDescendant(pid, 'SIGKILL')), [false, false, false, false, false])
    assert.deepEqual(f.signals, [])
  })

  test('owned run: the watcher reads without blocking, and two reads of the table never run at once', async () => {
    let active = 0, most = 0, reads = 0
    const custody = new OwnedRun({ uid: 7, self: SELF, watchMs: 5, readTable: async () => {
      active += 1; most = Math.max(most, active); reads += 1
      await new Promise((resolve) => { setTimeout(resolve, 30) })
      active -= 1
      return []
    } })
    const watcher = custody.watch()
    await new Promise((resolve) => { setTimeout(resolve, 15) })
    // Two more readers ask while the watcher's read is under way: they share it.
    await Promise.all([custody.observe(), custody.observe()])
    await new Promise((resolve) => { setTimeout(resolve, 150) })
    custody.stopWatching()
    const settled = reads
    await new Promise((resolve) => { setTimeout(resolve, 60) })
    assert.deepEqual([most, reads >= 2, reads, custody.watchers.size, watcher.stopped], [1, true, settled, 0, true], 'one read at a time, and none after the watcher stopped')
  })

  // -- deadline and output bound --------------------------------------------

  test('owned run: the output bound admits exactly its allowance and one byte more stops the run', async (t) => {
    const f = fake(t, [], { outputBytes: 1600 })
    const root = f.custody.allocateRoot('atelier-owned-test-')
    assert.deepEqual([f.custody.failureOutputReserve, f.custody.outputAllowance], [100, 1500])
    const error = await rejection(f.custody.execute(() => { f.custody.consume(1500); f.custody.consume(1) }))
    assert.deepEqual([error.code, f.custody.outputUsed, exists(root)], ['output-budget-exceeded', 1500, false], 'the processes were verified gone, so the roots are removed')
    assert.throws(() => f.custody.assertActive(), /output bound/)
    for (const bytes of [-1, 1.5, Number.NaN, '1']) assert.throws(() => f.custody.reserveOutput(bytes), /output bound/)
  })

  test('owned run: the deadline refuses later effects, and settled work can still clean up', async (t) => {
    const f = fake(t)
    const root = f.custody.allocateRoot('atelier-owned-test-')
    f.custody.deadline = -1
    let effects = 0
    await assert.rejects(f.custody.execute(() => { effects += 1 }), /deadline/)
    assert.deepEqual([effects, exists(root)], [0, false])
    assert.throws(() => f.custody.allocateRoot('atelier-owned-test-'), /deadline/, 'nothing is created after the run has stopped')
  })

  test('owned run: work that never returns keeps the roots and is reported', async (t) => {
    const f = fake(t)
    const root = f.custody.allocateRoot('atelier-owned-test-')
    f.custody.deadline = 1
    const error = await rejection(f.custody.execute(() => new Promise(() => {})))
    assert.deepEqual([error.cleanup.unknown, error.cleanup.retainedRoots, exists(root)], [['work-join-incomplete'], [root], true])
  })

  test('owned run: an oversized final document is refused whole before writing, and the roots are kept', async (t) => {
    const f = fake(t, [], { outputBytes: 8192 })
    const root = f.custody.allocateRoot('atelier-owned-test-')
    let writes = 0
    const error = await rejection(f.custody.execute(() => 'done', { finalize: () => {
      const text = f.custody.serializeFinal({ evidence: 'x'.repeat(8192), outcome: 'passed' })
      return f.custody.commitFinalOutput({ bytes: Buffer.byteLength(text), commit: () => { writes += 1 } })
    } }))
    assert.deepEqual([error.code, error.cleanup.retainedRoots, writes, exists(root)], ['output-budget-exceeded', [root], 0, true])
  })

  test('owned run: app output, receipt, evidence and console share one bound, reserved before anything is written', async (t) => {
    const f = fake(t, [], { outputBytes: 8192 })
    const root = f.custody.allocateRoot('atelier-owned-test-')
    f.custody.consume(7000)
    let writes = 0
    // 8192 less the 512 reserved for the failure line leaves 7680: 7000 are used, 680 fit, 681 do not.
    await assert.rejects(f.custody.execute(() => 'done', { finalize: () => f.custody.commitFinalOutput({ bytes: 681, commit: () => { writes += 1 } }) }), /output bound/)
    assert.deepEqual([writes, f.custody.outputUsed, exists(root)], [0, 7000, true])
    const fits = fake(t, [], { outputBytes: 8192 })
    fits.custody.consume(7000)
    const result = await fits.custody.execute(() => 'done', { finalize: () => fits.custody.commitFinalOutput({ bytes: 680, commit: () => 'written' }) })
    assert.deepEqual([result.value, fits.custody.outputUsed], ['written', 7680])
  })

  test('owned run: the complete final output is committed before the roots are removed', async (t) => {
    const f = fake(t)
    const root = f.custody.allocateRoot('atelier-owned-test-')
    const document = { outcome: 'blocked', evidence: 'é'.repeat(20) }
    const seen = []
    const result = await f.custody.execute(() => 'done', { finalize: (_value, cleanup) => {
      const serialized = f.custody.serializeFinal(document)
      return f.custody.commitFinalOutput({ bytes: Buffer.byteLength(serialized), commit: () => { seen.push(exists(root), cleanup.rootDispositionAtFinalOutput, JSON.parse(serialized)); return document } })
    } })
    assert.deepEqual([result.value, seen, exists(root), f.custody.outputUsed], [document, [true, 'retained-until-output-commit', document], false, Buffer.byteLength(`${JSON.stringify(document, null, 2)}\n`)], 'counted in bytes, not characters')
  })

  test('owned run: a final writer or console that fails keeps the roots, and the first failure stays the cause', async (t) => {
    const f = fake(t)
    const root = f.custody.allocateRoot('atelier-owned-test-')
    const error = await rejection(f.custody.execute(() => 'done', { finalize: () => f.custody.commitFinalOutput({ bytes: 100, commit: () => { throw new Error('writer or console unavailable') } }) }))
    assert.deepEqual([error.message, error.cleanup.retainedRoots, exists(root)], ['writer or console unavailable', [root], true])
    const both = fake(t)
    const second = both.custody.allocateRoot('atelier-owned-test-')
    const refused = await rejection(both.custody.execute(() => { throw new Error('original run failure') }, { finalize: () => { throw new Error('final output refused') } }))
    assert.deepEqual([refused.message, refused.cause.message, refused.cleanup.retainedRoots, exists(second)], ['final output refused', 'original run failure', [second], true])
  })

  test('owned run: an oversized console text is refused before any of it is written', async (t) => {
    const f = fake(t, [], { outputBytes: 8192 })
    const root = f.custody.allocateRoot('atelier-owned-test-')
    // 3000 characters of three bytes each: 9000 bytes.
    const consoleText = '✓'.repeat(3000)
    let writes = 0
    await assert.rejects(f.custody.execute(() => 'done', { finalize: () => f.custody.commitFinalOutput({ bytes: Buffer.byteLength(consoleText), commit: () => { writes += 1 } }) }), /output bound/)
    assert.deepEqual([writes, exists(root)], [0, true])
  })

  test('owned run: the failure line is bounded, names the kept roots, and is paid from its own reserve', (t) => {
    const f = fake(t, [], { outputBytes: 65536 })
    f.custody.consume(f.custody.outputAllowance)
    const roots = ['/tmp/synthetic-root-one', '/tmp/synthetic-root-two']
    const line = f.custody.failureDiagnostic({ procedureId: 'synthetic-procedure', error: new Error('m'.repeat(5000)), retainedRoots: roots })
    const parsed = JSON.parse(line)
    assert.deepEqual([parsed.procedureId, parsed.outcome, parsed.closes, parsed.humanAcceptance, parsed.retainedRoots, parsed.message.length], ['synthetic-procedure', 'failed', false, null, roots, 600])
    assert.ok(Buffer.byteLength(line) <= 4096 && f.custody.outputUsed <= f.custody.outputLimit, 'the whole run stays inside its bound')
    // A reserve too small for the reason still says the run failed.
    const small = fake(t, [], { outputBytes: 4096 })
    const short = JSON.parse(small.custody.failureDiagnostic({ procedureId: 'synthetic-procedure', error: new Error('m'.repeat(5000)), retainedRoots: roots }))
    assert.deepEqual([small.custody.failureOutputReserve, short.outcome, short.closes, 'message' in short], [256, 'failed', false, false])
    assert.throws(() => { for (let index = 0; index < 4; index += 1) small.custody.failureDiagnostic() }, /reserve exhausted/)
  })

  // -- the process table reader ---------------------------------------------

  test('owned run: process table rows are read with a signed user, the exited state and the whole command', () => {
    const table = [
      '    1     0     0 Ss   Mon Oct  5 00:00:00 2026     /sbin/launchd',
      '  345     1    -2 S    Mon Oct  5 00:00:07 2026     /usr/sbin/synthetic-daemon --flag',
      ' 4100  4000   501 S+   Tue Oct  6 09:10:11 2026     /owned/app --user-data-dir=/owned/profile  --two  spaces',
      ' 4101  4100   501 Z    Tue Oct  6 09:10:12 2026     <defunct>',
      ' 4102     1  1001 Ssl  Tue Oct  6 09:10:13 2026 node --title a\\012b',
      ' 4103     1   501 ?    Tue Oct  6 09:10:14 2026',
      '',
    ].join('\n')
    assert.deepEqual(parseProcessTable(table), [
      { pid: 1, ppid: 0, uid: 0, exited: false, start: 'Mon Oct 5 00:00:00 2026', command: '/sbin/launchd' },
      { pid: 345, ppid: 1, uid: -2, exited: false, start: 'Mon Oct 5 00:00:07 2026', command: '/usr/sbin/synthetic-daemon --flag' },
      { pid: 4100, ppid: 4000, uid: 501, exited: false, start: 'Tue Oct 6 09:10:11 2026', command: '/owned/app --user-data-dir=/owned/profile  --two  spaces' },
      { pid: 4101, ppid: 4100, uid: 501, exited: true, start: 'Tue Oct 6 09:10:12 2026', command: '<defunct>' },
      { pid: 4102, ppid: 1, uid: 1001, exited: false, start: 'Tue Oct 6 09:10:13 2026', command: 'node --title a\\012b' },
      { pid: 4103, ppid: 1, uid: 501, exited: false, start: 'Tue Oct 6 09:10:14 2026', command: '' },
    ])
    for (const unread of ['4100 4000 501 S Di 6 Okt 09:10:11 2026 /app', 'USER PID COMMAND', '4100 4000 501 S Tue Oct  6 09:10 2026 /app --secret-argument']) {
      assert.throws(() => parseProcessTable(unread), (error) => error.message === 'Unrecognized process table row', 'a row that cannot be read stops the readback and is never quoted')
    }
  })

  // -- the driver's final output ---------------------------------------------

  // The first procedure is the small-fixture one, the only one that runs as an owned run.
  const { appLogEvidence, commitOwnedOutput, finalizeOwnedSmallFixture, planProcedure: planOwned, PROCEDURE_IDS: [SMALL_FIXTURE_PROCEDURE] } = await import('../scripts/obsidian/desktop-receipts.mjs')
  const ownedOutput = (t, options = {}) => {
    const f = fake(t, [], options)
    const receiptDir = path.join(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'atelier-owned-receipts-')), 'receipts')
    t.after(() => fs.rmSync(path.dirname(receiptDir), { recursive: true, force: true }))
    const consoleWrites = []
    // What a run that failed before capability discovery records.
    const input = { custody: f.custody, plan: planOwned(SMALL_FIXTURE_PROCEDURE, { receiptDir, operator: 'op-synthetic' }), receiptDir, candidate: { commit: '1'.repeat(40), treeDigest: `sha256:${'2'.repeat(64)}`, ext: { dirty: false } },
      capabilities: { app: { name: 'Obsidian', version: null, installerVersion: null }, cli: { version: null }, lastSavedData: {}, errors: [], qualified: false }, operator: 'op-synthetic', host: { id: 'host-synthetic-desk-02' },
      evidenceByGate: { G07: [{ role: 'cli-link-inspection', name: 'G07-cli-link-inspection.txt', bytes: Buffer.from('indexReady: false\n') }, { role: null, name: 'G07-owned-cleanup.json', bytes: Buffer.from('{"error":"synthetic failure"}\n') }] },
      passedByGate: { G07: false }, timingsByGate: { G07: {} }, wallClock: { startedAt: '2026-01-05T10:00:00.000Z', endedAt: '2026-01-05T10:20:00.000Z' }, recordedAt: '2026-01-05T10:00:00.000Z', json: true, consoleNotes: ['[desktop-receipts] kept /tmp/synthetic-kept-root'], writeConsole: async (output) => { consoleWrites.push(output) } }
    return { ...f, receiptDir, consoleWrites, input }
  }
  // The output bound whose allowance (the bound less its reserve) is exactly `allowance` bytes.
  const boundFor = (allowance) => { for (let limit = allowance; ; limit += 1) if (limit - Math.min(256 * 1024, Math.floor(limit / 16)) === allowance) return limit }

  test('owned run: the final output written is exactly the output reserved, and a failed run records a valid failed receipt', async (t) => {
    const f = ownedOutput(t)
    const result = await f.custody.execute(() => 'done', { finalize: () => commitOwnedOutput(f.input) })
    const files = fs.readdirSync(f.receiptDir).sort()
    assert.deepEqual(files, ['G07-capabilities.json', 'G07-cli-link-inspection.txt', 'G07-owned-cleanup.json', 'G07.json'])
    const receipt = JSON.parse(fs.readFileSync(path.join(f.receiptDir, 'G07.json'), 'utf8'))
    assert.deepEqual([receipt.outcome, receipt.environment.app.version, receipt.evidence.map((item) => item.name), result.value.written[0].validation.schemaValid, result.value.outputHandled], ['failed', 'unknown', ['G07-capabilities.json', 'G07-cli-link-inspection.txt', 'G07-owned-cleanup.json'], true, true])
    assert.equal(f.consoleWrites.length, 1, 'the console text is one write')
    assert.ok(f.consoleWrites[0].includes(`${path.join(f.receiptDir, 'G07.json')}: outcome failed`) && f.consoleWrites[0].includes(JSON.stringify(receipt, null, 2)) && f.consoleWrites[0].includes('\n[desktop-receipts] kept /tmp/synthetic-kept-root\n') && f.consoleWrites[0].includes('manual role app-observation'))
    const onDisk = files.reduce((total, name) => total + fs.statSync(path.join(f.receiptDir, name)).size, 0)
    assert.deepEqual([result.value.outputBytes, f.custody.outputUsed], [onDisk + Buffer.byteLength(f.consoleWrites[0]), onDisk + Buffer.byteLength(f.consoleWrites[0])], 'every byte written was reserved first')
  })

  test('owned run: a final output that does not fit, with no room in the reserve for a shortened receipt, writes nothing', async (t) => {
    const sized = ownedOutput(t)
    await sized.custody.execute(() => 'done', { finalize: () => commitOwnedOutput(sized.input) })
    const needed = sized.custody.outputUsed
    // One byte short of what the same output needs; the reserve of so small a bound holds no failed receipt.
    const f = ownedOutput(t, { outputBytes: boundFor(needed - 1) })
    const root = f.custody.allocateRoot('atelier-owned-test-')
    const error = await rejection(f.custody.execute(() => 'done', { finalize: () => commitOwnedOutput(f.input) }))
    assert.deepEqual([error.code, error.shortenedOutput, exists(f.receiptDir), f.consoleWrites, error.cleanup.retainedRoots, exists(root)], ['output-budget-exceeded', undefined, false, [], [root], true])
    // A writer that fails after the reservation keeps the roots and what it had already written.
    const failing = ownedOutput(t)
    failing.input.writeConsole = async () => { throw new Error('console closed') }
    const kept = failing.custody.allocateRoot('atelier-owned-test-')
    const failure = await rejection(failing.custody.execute(() => 'done', { finalize: () => commitOwnedOutput(failing.input) }))
    assert.deepEqual([failure.message, exists(path.join(failing.receiptDir, 'G07.json')), failure.cleanup.retainedRoots, exists(kept)], ['console closed', true, [kept], true])
  })

  test('owned run: only evidence that says it is a copy of counted app output is counted once; any other evidence is counted in full', async (t) => {
    const copy = { role: null, name: 'G07-app-synthetic.log', bytes: Buffer.alloc(20000, 'y'), nativeCopyBytes: 20000 }
    const sized = ownedOutput(t)
    sized.input.evidenceByGate.G07.push(copy)
    await sized.custody.execute(() => 'done', { finalize: () => commitOwnedOutput(sized.input) })
    const needed = sized.custody.outputUsed
    // The same output, after the 20000 bytes of the log arrived from the app and were counted then, fits a bound of
    // exactly what it needs: the copy that replaces the log is not counted a second time.
    const f = ownedOutput(t, { outputBytes: boundFor(needed) })
    f.input.evidenceByGate.G07.push(copy)
    f.custody.consume(20000)
    const result = await f.custody.execute(() => 'done', { finalize: () => commitOwnedOutput(f.input) })
    assert.deepEqual([f.custody.outputUsed, f.custody.outputAllowance, f.custody.nativeCredited, result.value.outputBytes, result.value.outputCharged], [needed, needed, 20000, needed, needed - 20000])
    assert.equal(fs.readFileSync(path.join(f.receiptDir, copy.name)).length, 20000)
    // Evidence of the same size that does not say it is such a copy is counted again, and so does not fit that bound.
    const plain = ownedOutput(t, { outputBytes: boundFor(needed) })
    plain.input.evidenceByGate.G07.push({ role: copy.role, name: copy.name, bytes: copy.bytes })
    plain.custody.consume(20000)
    const refused = await rejection(plain.custody.execute(() => 'done', { finalize: () => commitOwnedOutput(plain.input) }))
    assert.deepEqual([refused.code, plain.custody.nativeCredited, exists(plain.receiptDir)], ['output-budget-exceeded', 0, false])
    // A copy is credited for no more than it holds, and for no more than arrived.
    const claims = ownedOutput(t)
    claims.input.evidenceByGate.G07.push({ ...copy, nativeCopyBytes: 10 ** 9 })
    claims.custody.consume(20500)
    await claims.custody.execute(() => 'done', { finalize: () => commitOwnedOutput(claims.input) })
    assert.deepEqual([claims.custody.nativeCredited, claims.custody.outputUsed], [20000, needed + 500])
    const counted = fake(t).custody
    counted.consume(100)
    assert.deepEqual([counted.finalCharge({ bytes: 10, evidenceBytes: 500, nativeCopyBytes: 300 }), counted.finalCharge({ bytes: 10, evidenceBytes: 500 })], [{ charge: 410, credit: 100 }, { charge: 510, credit: 0 }])
  })

  test('owned run: the app log copy is counted once only when the root that holds the original is about to be removed', (t) => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'atelier-owned-log-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    assert.equal(appLogEvidence({ gate: 'G07', root, rootWillBeRemoved: true }), null, 'no log, no evidence')
    fs.writeFileSync(path.join(root, 'app.log'), 'stand-in app output\n')
    const [replaces, beside] = [true, false].map((rootWillBeRemoved) => appLogEvidence({ gate: 'G07', root, rootWillBeRemoved }))
    // With the root kept (asked for, or cleanup unverified) the log and its copy both stay, so the copy is counted in full.
    assert.deepEqual([replaces.nativeCopyBytes, beside.nativeCopyBytes, replaces.bytes.toString('utf8'), beside.bytes.equals(replaces.bytes), replaces.name === beside.name && /^G07-app-[A-Za-z0-9._:-]+\.log$/.test(replaces.name)],
      [20, 0, `# app.log of ${root}\nstand-in app output\n`, true, true])
  })

  test('owned run: a credited copy is charged back when a root is kept after all, and what is kept beyond the allowance is reported', async (t) => {
    const copy = { role: null, name: 'G07-app-synthetic.log', bytes: Buffer.alloc(20000, 'y'), nativeCopyBytes: 20000 }
    const sized = ownedOutput(t)
    sized.input.evidenceByGate.G07.push(copy)
    await sized.custody.execute(() => 'done', { finalize: () => commitOwnedOutput(sized.input) })
    const needed = sized.custody.outputUsed
    // Each run below fits a bound of exactly what it needs only with the copy credited.
    const credited = (options = {}) => {
      const f = ownedOutput(t, { outputBytes: boundFor(needed), ...options })
      f.input.evidenceByGate.G07.push(copy)
      f.custody.consume(20000)
      return f
    }
    // The console fails after the reservation: the roots are kept, and with them the log beside its copy.
    const consoleFails = credited()
    consoleFails.input.writeConsole = async () => { throw new Error('console closed') }
    const kept = consoleFails.custody.allocateRoot('atelier-owned-test-')
    const failure = await rejection(consoleFails.custody.execute(() => 'done', { finalize: () => commitOwnedOutput(consoleFails.input) }))
    assert.deepEqual([failure.message, failure.cleanup.retainedRoots, exists(kept), failure.cleanup.outputCreditChargedBack, failure.cleanup.outputOverAllowance, consoleFails.custody.nativeCredited, consoleFails.custody.outputUsed],
      ['console closed', [kept], true, 20000, 20000, 0, needed + 20000])
    const line = JSON.parse(consoleFails.custody.failureDiagnostic({ procedureId: 'synthetic-procedure', error: failure, retainedRoots: failure.cleanup.retainedRoots }))
    assert.deepEqual([line.outcome, line.outputCreditChargedBackBytes, line.outputOverAllowanceBytes, line.retainedRoots], ['failed', 20000, 20000, [kept]], 'the failure line names the charged-back credit and says by how much')
    // The output is committed, then a root cannot be removed.
    let refused = null
    const removalFails = credited({ io: { ...fs, rmSync: (target, options) => { if (target === refused) throw new Error('busy'); return fs.rmSync(target, options) } } })
    refused = removalFails.custody.allocateRoot('atelier-owned-test-')
    const unremoved = await rejection(removalFails.custody.execute(() => 'done', { finalize: () => commitOwnedOutput(removalFails.input) }))
    assert.deepEqual([unremoved.message, unremoved.cleanup.unknown, exists(path.join(removalFails.receiptDir, 'G07.json')), unremoved.cleanup.outputCreditChargedBack, unremoved.cleanup.outputOverAllowance],
      ['Owned cleanup could not be verified', ['root-removal:busy'], true, 20000, 20000])
    // With room left in the bound the credit is still charged back, and nothing is beyond the allowance.
    const roomy = ownedOutput(t)
    roomy.input.evidenceByGate.G07.push(copy)
    roomy.input.writeConsole = async () => { throw new Error('console closed') }
    roomy.custody.consume(20000)
    roomy.custody.allocateRoot('atelier-owned-test-')
    const spare = await rejection(roomy.custody.execute(() => 'done', { finalize: () => commitOwnedOutput(roomy.input) }))
    assert.deepEqual([spare.cleanup.outputCreditChargedBack, 'outputOverAllowance' in spare.cleanup, roomy.custody.outputUsed], [20000, false, needed + 20000])
    const roomyLine = JSON.parse(roomy.custody.failureDiagnostic({ error: spare }))
    assert.deepEqual([roomyLine.outputCreditChargedBackBytes, 'outputOverAllowanceBytes' in roomyLine], [20000, false])
    assert.equal('outputCreditChargedBackBytes' in JSON.parse(fake(t).custody.failureDiagnostic({ error: new Error('no credit') })), false, 'a run with nothing charged back says nothing of it')
  })

  test('owned run: the small-fixture run credits the app log copy only when its cleanup was verified and its roots are not kept', async (t) => {
    const finalizeWith = async ({ keep = false, unverified = false } = {}) => {
      const f = ownedOutput(t)
      const layoutRoot = f.custody.allocateRoot('atelier-owned-test-')
      const log = Buffer.from('stand-in app output\n'.repeat(64))
      fs.writeFileSync(path.join(layoutRoot, 'app.log'), log)
      f.custody.consume(log.length)
      // A process that names the run's profile and does not leave: the cleanup cannot be verified.
      if (unverified) { f.custody.profiles.add('/owned/profile'); f.rows.push(row(60, 1, { command: '/detached/helper --user-data-dir=/owned/profile' })) }
      const { input } = f
      let committed = null
      const outcome = await f.custody.execute(() => 'done', { keep, finalize: async (_value, cleanup, runError) => {
        committed = await finalizeOwnedSmallFixture({ custody: f.custody, plan: input.plan, keep, receiptDir: input.receiptDir, operator: input.operator, candidate: input.candidate, host: input.host, gate: 'G07',
          evidence: input.evidenceByGate.G07.filter((item) => item.role !== null), passed: true, capabilities: { ...input.capabilities, qualified: true }, timings: {}, layoutRoot, cliProcessShape: { pid: 4321, processes: 1 }, startedAt: input.wallClock.startedAt, writeConsole: input.writeConsole }, cleanup, runError)
        return committed
      } }).then((result) => ({ result }), (error) => ({ error }))
      const receipt = JSON.parse(fs.readFileSync(path.join(input.receiptDir, 'G07.json'), 'utf8'))
      return { f, outcome, receipt, layoutRoot, logBytes: log.length, credit: committed.outputBytes - committed.outputCharged }
    }
    const removed = await finalizeWith()
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(removed.f.receiptDir, 'G07-owned-cleanup.json'), 'utf8')).cliProcessShape, { pid: 4321, processes: 1 }, 'the command-line process shape is kept beside the cleanup')
    assert.deepEqual([removed.credit, removed.f.custody.nativeCredited, removed.outcome.result.cleanup.removedRoots, exists(removed.layoutRoot), removed.receipt.outcome], [removed.logBytes, removed.logBytes, [removed.layoutRoot], false, 'blocked'], 'the copy replaces the log the removed root held')
    const kept = await finalizeWith({ keep: true })
    assert.deepEqual([kept.credit, kept.f.custody.nativeCredited, kept.outcome.result.cleanup.retainedRoots, exists(kept.layoutRoot), 'outputCreditChargedBack' in kept.outcome.result.cleanup], [0, 0, [kept.layoutRoot], true, false], 'with --keep the log and its copy both stay, and both are counted')
    const unverified = await finalizeWith({ unverified: true })
    assert.deepEqual([unverified.credit, unverified.outcome.error.message, exists(unverified.layoutRoot), 'outputCreditChargedBack' in unverified.outcome.error.cleanup, unverified.receipt.outcome], [0, 'Owned cleanup could not be verified', true, false, 'failed'], 'an unverified cleanup keeps the roots, so nothing is credited')
  })

  test('owned run: a run that used up its bound still records its failed receipt, with shortened evidence marked as shortened', async (t) => {
    const f = ownedOutput(t, { outputBytes: 8 * 1024 * 1024 })
    f.input.evidenceByGate.G07.push({ role: null, name: 'G07-app-synthetic.log', bytes: Buffer.alloc(300 * 1024, 'y') })
    f.input.capabilities = { ...f.input.capabilities, cli: { version: null, helpRaw: 'h'.repeat(100000) } }
    const root = f.custody.allocateRoot('atelier-owned-test-')
    // The app's output reached the bound while the run was going.
    const error = await rejection(f.custody.execute(() => { f.custody.consume(f.custody.outputAllowance); f.custody.consume(1) }, { finalize: () => commitOwnedOutput(f.input) }))
    assert.deepEqual([error.code, error.cause?.code, error.cleanup.retainedRoots, exists(root)], ['output-budget-exceeded', 'output-budget-exceeded', [root], true], 'the roots are kept, and the run failure stays the cause')
    assert.deepEqual([error.shortenedOutput.cap, error.shortenedOutput.shortened], [32 * 1024, [{ name: 'G07-app-synthetic.log', byteLength: 300 * 1024, keptBytes: 32 * 1024 }]])
    const receipt = JSON.parse(fs.readFileSync(path.join(f.receiptDir, 'G07.json'), 'utf8'))
    const desktop = receipt.ext['mnstry.atelier.obsidian.desktop-receipts']
    assert.equal(receipt.outcome, 'failed')
    assert.ok(desktop.notes.some((note) => note.includes(`G07-app-synthetic.log kept ${32 * 1024} of ${300 * 1024} bytes`)), 'the receipt names what was shortened')
    assert.ok(desktop.capabilities.cli.helpRaw.length < 600 && desktop.capabilities.qualified === false)
    const kept = fs.readFileSync(path.join(f.receiptDir, 'G07-app-synthetic.log'), 'utf8')
    assert.ok(kept.startsWith('y'.repeat(32 * 1024)) && kept.endsWith(`\n[shortened to fit the output bound: kept ${32 * 1024} of ${300 * 1024} bytes]\n`), 'the evidence says it was shortened')
    for (const entry of receipt.evidence) assert.equal(fs.statSync(path.join(f.receiptDir, entry.name)).size, entry.byteLength)
    assert.ok(f.consoleWrites.length === 1 && f.consoleWrites[0].includes('a failed receipt with shortened evidence was recorded'))
    // The failure line still fits, and the whole run stays inside its bound.
    const line = JSON.parse(f.custody.failureDiagnostic({ procedureId: 'synthetic-procedure', error, retainedRoots: [root] }))
    assert.deepEqual([line.outcome, line.retainedRoots, f.custody.outputUsed <= f.custody.outputLimit], ['failed', [root], true])
  })

  // -- this platform's own process table and real children -------------------

  // The harness runs on macOS, and only there is the table's format qualified; elsewhere these two are skipped.
  const realTable = process.platform === 'darwin' ? false : 'the process table reader is qualified on macOS only'
  const idle = (extra = '') => childProcess.spawn(process.execPath, ['-e', `${extra};setInterval(() => {}, 1000)`], { stdio: ['ignore', 'pipe', 'ignore'] })
  const firstLine = (child) => new Promise((resolve, reject) => { let seen = ''; child.stdout.on('data', (chunk) => { seen += chunk; if (seen.includes('\n')) resolve(seen.split('\n')[0]) }); child.once('close', () => reject(new Error('the child closed before it answered'))) })

  test('owned run: this platform\'s table is read without blocking, one process is read back alone, and a spawned child is read back as this process\'s own', { skip: realTable }, async (t) => {
    const child = idle()
    t.after(() => child.kill('SIGKILL'))
    const custody = new OwnedRun()
    const entry = custody.adopt(child)
    const bound = await custody.bind(entry, { program: process.execPath })
    assert.deepEqual([bound.pid, bound.ppid, bound.uid, bound.exited], [child.pid, process.pid, process.getuid(), false])
    // Work queued before the read runs while the table is read.
    let turned = false
    setImmediate(() => { turned = true })
    const rows = await readProcessTable()
    assert.ok(turned, 'the read did not block this process')
    assert.ok(rows.length > 1 && rows.some((item) => item.pid === process.pid) && rows.every((item) => Number.isInteger(item.pid) && Number.isInteger(item.uid) && /^\w{3} \w{3} \d{1,2} \d\d:\d\d:\d\d \d{4}$/.test(item.start)))
    const self = readOneProcess(process.pid)
    assert.deepEqual([self.pid, self.uid, self.start, self.command], [process.pid, process.getuid(), rows.find((item) => item.pid === process.pid).start, rows.find((item) => item.pid === process.pid).command])
    const gone = childProcess.spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' })
    await new Promise((resolve) => { gone.once('close', resolve) })
    assert.equal(readOneProcess(gone.pid), null, 'a number no process holds is answered null')
    assert.throws(() => readOneProcess(0), /positive integer/)
  })

  test('owned run: real children are ended (a spawned process by its handle, its own child by lineage) and an unrelated process survives', { skip: realTable }, async (t) => {
    // The spawned process starts a child of its own and prints that child's number.
    const marker = `atelier-owned-test-${process.pid}-${Date.now()}`
    const parent = idle(`const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '${marker}'], { stdio: 'ignore' }); console.log(c.pid)`)
    const unrelated = idle('console.log(process.pid)')
    t.after(() => { parent.kill('SIGKILL'); unrelated.kill('SIGKILL') })
    const grandchild = Number(await firstLine(parent))
    await firstLine(unrelated)
    // Should the case fail early, its own grandchild (told apart by the marker, not only by its number) is not left running.
    t.after(() => { if (readOneProcess(grandchild)?.command.includes(marker)) process.kill(grandchild, 'SIGKILL') })
    const byNumber = []
    // The only number this test allows a signal to reach is the grandchild it started itself.
    const custody = new OwnedRun({ signal: (pid, name) => { assert.equal(pid, grandchild, 'a signal by number reaches only the recorded descendant'); byNumber.push(name); process.kill(pid, name) } })
    const root = custody.allocateRoot('atelier-owned-test-')
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    fs.writeFileSync(path.join(root, 'kept-until-verified.txt'), 'x')
    const result = await custody.execute(async () => {
      const entry = custody.adopt(parent)
      await custody.bind(entry, { program: process.execPath })
      // What the watcher does while the app runs: one read of the whole table.
      await custody.observe()
      return [...custody.descendants.keys()]
    })
    assert.deepEqual(result.value, [grandchild], 'the lineage was read while the parent was alive')
    assert.deepEqual([result.cleanup.joined, result.cleanup.unknown, result.cleanup.removedRoots, exists(root)], [true, [], [root], false])
    assert.ok(byNumber.length >= 1 && byNumber[0] === 'SIGTERM')
    const after = await readProcessTable()
    assert.deepEqual([after.some((item) => item.pid === parent.pid && item.ppid === process.pid), after.some((item) => item.pid === grandchild && !item.exited), parent.signalCode], [false, false, 'SIGTERM'])
    assert.deepEqual([unrelated.exitCode, unrelated.signalCode, after.some((item) => item.pid === unrelated.pid && item.ppid === process.pid && !item.exited)], [null, null, true], 'a process this run did not adopt is still running')
  })

  // -- the instance under an owned run, with stand-ins for the app and its command-line tool --------------------

  // Harmless Node scripts that the instance starts in place of the installed app and its command-line tool, through
  // the instance's launcher. The command-line stand-in answers the vault listing from the private profile.
  const STAND_INS = {
    'cli.cjs': `const fs = require('node:fs'); const path = require('node:path')
const [command, value] = process.argv.slice(2)
if (command === 'vaults') { const config = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '..', 'profile', 'obsidian.json'), 'utf8')); for (const vault of Object.values(config.vaults)) process.stdout.write(vault.path + '\\n') }
else if (command === 'echo') process.stdout.write('x'.repeat(Number(value)))
else if (command === 'fail') { process.stderr.write('refused by the stand-in\\n'); process.exitCode = 3 }
else if (command === 'hang') setInterval(() => {}, 1000)
else if (command === 'eval' && value.includes("resolve('held')")) setTimeout(() => process.stdout.write('=> held\\n'), Number(value.slice(value.lastIndexOf(',') + 1, -2)))
`,
    // The app stand-in starts a helper of its own (named by the marker it is given), says something on each stream
    // and opens its command-line socket.
    'app.cjs': `const fs = require('node:fs'); const path = require('node:path'); const { spawn } = require('node:child_process')
const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', process.argv[2]], { stdio: 'ignore' })
process.stdout.write('helper ' + helper.pid + '\\n'); process.stderr.write('stand-in app warning\\n')
fs.writeFileSync(path.join(process.env.HOME, '.obsidian-cli.sock'), '')
setInterval(() => {}, 1000)
`,
    // A process that outlives its parent and keeps the parent's output open, as a detached helper of the app can.
    // It ends by itself when the stop file appears or its folder is removed, and after a minute at most.
    'holder.cjs': `const fs = require('node:fs'); const path = require('node:path')
setInterval(() => { if (fs.existsSync(process.argv[2]) || !fs.existsSync(path.dirname(process.argv[2]))) process.exit(0) }, 100)
setTimeout(() => process.exit(0), 60000)
`,
    'parent.cjs': `const { spawn } = require('node:child_process')
const holder = spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: ['ignore', 'inherit', 'inherit'], detached: true })
holder.unref()
process.stdout.write(holder.pid + '\\n')
`,
    // A script that runs an owned run over that parent, sees the run fail, says so and is expected to exit.
    'run.mjs': `import { spawn } from 'node:child_process'
const [instanceUrl, parentScript, holderScript, stop] = process.argv.slice(2)
const { OwnedRun } = await import(instanceUrl)
const custody = new OwnedRun({ readTable: async () => [], readOne: () => null, cleanupMs: 1500 })
try {
  await custody.execute(async () => {
    const child = spawn(process.execPath, [parentScript, holderScript, stop], { stdio: ['ignore', 'pipe', 'pipe'] })
    custody.adopt(child)
    await new Promise((resolve) => { child.once('exit', resolve) })
  })
  process.stdout.write('joined\\n')
} catch (error) {
  process.stdout.write('failed ' + JSON.stringify(error.cleanup?.unknown ?? [error.message]) + '\\n')
  process.exitCode = 3
}
`,
  }
  const standIns = (t) => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'atelier-owned-stand-ins-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    return Object.fromEntries(Object.entries(STAND_INS).map(([name, source]) => { fs.writeFileSync(path.join(dir, name), source); return [name.replace(/\..*$/, ''), path.join(dir, name)] }))
  }
  // Records every child the run adopts, with a promise of its close. Should a case fail early, a child still
  // running is ended through its own handle.
  const recordAdoptions = (t, custody) => {
    const adopted = []
    const adopt = custody.adopt.bind(custody)
    custody.adopt = (child) => { child.closing = new Promise((resolve) => { child.once('close', resolve) }); adopted.push(child); return adopt(child) }
    t.after(() => { for (const child of adopted) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
    return adopted
  }
  // Waits for every child to close, for ten seconds at most: a child left running fails the case instead of hanging it.
  const allClosed = async (children) => {
    let timer
    const closedInTime = await Promise.race([Promise.all(children.map((child) => child.closing)).then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), 10000) })])
    clearTimeout(timer)
    assert.ok(closedInTime, 'every child closed')
  }

  test('owned run: a command-line call is this run\'s own child, its output counted as it arrives, and it is never signalled by number', async (t) => {
    const scripts = standIns(t)
    const kills = t.mock.method(process, 'kill')
    const custody = new OwnedRun({ workMs: 60000 })
    t.after(() => { for (const root of custody.roots.keys()) fs.rmSync(root, { recursive: true, force: true }) })
    const layout = createLayout(undefined, undefined, { custody })
    const instance = new Instance(layout, { custody, launcher: { cli: [process.execPath, scripts.cli] } })
    const adopted = recordAdoptions(t, custody)
    assert.equal(await instance.cli('echo', '5000'), 'x'.repeat(5000))
    assert.equal(custody.nativeUsed, 5000)
    assert.equal((await instance.cli('vaults', 'verbose')).trim(), layout.vault)
    await assert.rejects(instance.cli('fail'), /exited with code 3: refused by the stand-in/)
    await allClosed(adopted)
    assert.deepEqual(adopted.map((child) => [child.exitCode, child.signalCode, child.killed]), [[0, null, false], [0, null, false], [3, null, false]], 'a call that has exited is not signalled')
    assert.deepEqual([custody.children.size, kills.mock.calls.filter((call) => adopted.some((child) => child.pid === call.arguments[0])).length], [0, 0], 'no call is signalled by number')
  })

  test('owned run: how many processes one command-line call becomes is read from one table while the app holds the call open, and nothing is signalled', async (t) => {
    const scripts = standIns(t)
    const kills = t.mock.method(process, 'kill')
    // A stand-in table: the call this run holds, a child and a grandchild of it, one that has exited, and a process of
    // no relation.
    const custody = new OwnedRun({ uid: 7, self: SELF, workMs: 60000, readOne: () => null, readTable: async () => {
      const call = [...custody.children].at(-1).child
      return [row(call.pid, SELF, { command: 'stand-in cli' }), row(98001, call.pid), row(98002, 98001), row(98003, call.pid, { exited: true }), row(98004, 1)]
    } })
    t.after(() => { for (const root of custody.roots.keys()) fs.rmSync(root, { recursive: true, force: true }) })
    const instance = new Instance(createLayout(undefined, undefined, { custody }), { custody, launcher: { cli: [process.execPath, scripts.cli] } })
    const adopted = recordAdoptions(t, custody)
    const shape = await instance.cliProcessShape({ holdMs: 1500 })
    await allClosed(adopted)
    assert.deepEqual(shape, { pid: adopted[0].pid, holdMs: 1500, readWhileHeld: true, processes: 3, error: null, answered: true })
    assert.deepEqual([custody.tableReads, adopted.length, adopted[0].signalCode, adopted[0].killed, kills.mock.calls.length], [1, 1, null, false, 0], 'one read, one call, and no signal')
    await assert.rejects(new Instance(createLayout(undefined, undefined, { custody })).cliProcessShape(), /owned run only/)
  })

  test('owned run: a command-line call that outlives its time is ended through its handle', async (t) => {
    const scripts = standIns(t)
    const kills = t.mock.method(process, 'kill')
    const custody = new OwnedRun({ workMs: 1500 })
    t.after(() => { for (const root of custody.roots.keys()) fs.rmSync(root, { recursive: true, force: true }) })
    const instance = new Instance(createLayout(undefined, undefined, { custody }), { custody, launcher: { cli: [process.execPath, scripts.cli] } })
    const adopted = recordAdoptions(t, custody)
    await assert.rejects(instance.cli('hang'), /CLI call timed out: hang/)
    await allClosed(adopted)
    assert.deepEqual([adopted.length, adopted[0].signalCode, adopted[0].killed, custody.children.size], [1, 'SIGKILL', true, 0])
    assert.equal(kills.mock.calls.filter((call) => call.arguments[0] === adopted[0].pid).length, 0, 'not by number')
  })

  test('owned run: a child whose output another process keeps open is let go after cleanup, so the run can end and report', { skip: process.platform === 'win32' ? 'output inherited by a detached process is a POSIX arrangement' : false }, async (t) => {
    const scripts = standIns(t)
    // The holder ends by itself once this file exists or the stand-ins' folder is removed; nothing here signals it.
    const stop = path.join(path.dirname(scripts.run), 'stop')
    t.after(() => { if (fs.existsSync(path.dirname(stop))) fs.writeFileSync(stop, '') })
    const script = childProcess.spawn(process.execPath, [scripts.run, new URL('../experiments/obsidian-publication/lib/instance.mjs', import.meta.url).href, scripts.parent, scripts.holder, stop], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    script.stdout.on('data', (chunk) => { output += chunk })
    script.stderr.on('data', (chunk) => { output += chunk })
    let timer
    const ended = await Promise.race([
      new Promise((resolve) => { script.once('close', (code) => resolve({ code })) }),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), 20000) }),
    ])
    clearTimeout(timer)
    if (ended === null) { script.kill('SIGKILL'); assert.fail(`the run did not exit after reporting: ${output.slice(0, 300)}`) }
    assert.deepEqual([ended.code, output.trim()], [3, 'failed ["process-join-incomplete"]'])
  })

  test('owned run: the app is launched as this run\'s own child: held, counted, read back, watched, and ended with its helper', { skip: realTable }, async (t) => {
    const scripts = standIns(t)
    const marker = `atelier-owned-test-${process.pid}-${Date.now()}`
    const custody = new OwnedRun({ watchMs: 100 })
    const bind = t.mock.method(custody, 'bind')
    const adopted = recordAdoptions(t, custody)
    let helper = null, app = null
    t.after(() => { if (app !== null && app.exitCode === null && app.signalCode === null) app.kill('SIGKILL') })
    // Should the case fail early, its own helper (told apart by the marker, not only by its number) is not left running.
    t.after(() => { if (helper !== null && readOneProcess(helper)?.command.includes(marker)) process.kill(helper, 'SIGKILL') })
    t.after(() => { for (const root of custody.roots.keys()) fs.rmSync(root, { recursive: true, force: true }) })
    const result = await custody.execute(async () => {
      const layout = createLayout(undefined, undefined, { custody })
      const instance = new Instance(layout, { custody, launcher: { app: [process.execPath, scripts.app, marker], cli: [process.execPath, scripts.cli] } })
      const launched = instance.launch({ readyTimeoutMs: 20000 })
      app = instance.child
      await launched
      const log = fs.readFileSync(path.join(layout.root, 'app.log'), 'utf8')
      helper = Number(/^helper (\d+)$/m.exec(log)?.[1])
      // The watcher has read the table at least once while the app ran, and recorded the app's helper.
      for (let waited = 0; custody.tableReads === 0 && waited < 10000; waited += 50) await new Promise((resolve) => { setTimeout(resolve, 50) })
      return { log, layout, watching: custody.watchers.size, reads: custody.tableReads, descendants: [...custody.descendants.keys()], native: custody.nativeUsed }
    })
    const { log, layout, watching, reads, descendants, native } = result.value
    assert.deepEqual(bind.mock.calls.map((call) => call.arguments[1]), [{ program: `${process.execPath} ${scripts.app} ${marker}`, profile: layout.profile }])
    assert.equal((await bind.mock.calls[0].result).pid, app.pid)
    assert.ok(log.includes('stand-in app warning') && Number.isInteger(helper), 'both output streams reached the app log')
    assert.ok(native >= Buffer.byteLength(log) + 2 * Buffer.byteLength(`${layout.vault}\n`), 'the app output was counted, and the vault listings')
    assert.deepEqual([watching, reads > 0, descendants], [1, true, [helper]])
    assert.deepEqual([result.cleanup.joined, result.cleanup.unknown, app.signalCode, exists(layout.root)], [true, [], 'SIGTERM', false])
    assert.equal(readOneProcess(helper)?.command.includes(marker) ?? false, false, 'the helper was ended by lineage')
    assert.equal(adopted[0], app, 'the app was adopted the turn it was spawned')
  })

  // -- the instance outside an owned run, as the other procedures and the experiment script use it ----------------

  // Records every signal sent by number or by group, and sends none of them.
  const recordKills = (t) => t.mock.method(process, 'kill', () => true)
  const TRUE_PROGRAM = ['/usr/bin/true', '/bin/true'].find((file) => fs.existsSync(file))

  test('outside an owned run: quitting signals the app only through its handle, and an app that has exited not at all', async (t) => {
    const kills = recordKills(t)
    const unused = { root: path.join(fs.realpathSync(os.tmpdir()), 'atelier-unowned-unused'), home: path.join(fs.realpathSync(os.tmpdir()), 'atelier-unowned-unused', 'home') }
    // Stand-ins for the handle spawn returned. Number 4242 stands for whatever holds that number now.
    const handle = (exitCode) => {
      const child = Object.assign(new EventEmitter(), { pid: 4242, exitCode, signalCode: null, signals: [] })
      child.kill = (name) => { child.signals.push(name); child.signalCode = name; return true }
      return child
    }
    const [running, exited] = [new Instance(unused), new Instance(unused)]
    running.child = handle(null)
    exited.child = handle(0)
    await running.quit()
    await exited.quit()
    assert.deepEqual([running.child.signals, exited.child.signals, kills.mock.calls.map((call) => call.arguments)], [['SIGTERM'], [], []], 'nothing by number, whatever now holds the number')
  })

  test('outside an owned run: a launch that gives up signals the app\'s process group only while it still holds the app', { skip: process.platform === 'win32' || !TRUE_PROGRAM ? 'a detached app leads its own process group on POSIX only' : false }, async (t) => {
    const scripts = standIns(t)
    const idle = path.join(path.dirname(scripts.cli), 'idle.cjs')
    fs.writeFileSync(idle, 'setInterval(() => {}, 1000)\n')
    const kills = recordKills(t)
    const launchGivingUp = async (app, readyTimeoutMs) => {
      const layout = createLayout()
      t.after(() => fs.rmSync(layout.root, { recursive: true, force: true }))
      const instance = new Instance(layout, { launcher: { app, cli: [process.execPath, scripts.cli] } })
      // Nothing here signals the group; a stand-in still running at the end is ended through its own handle.
      t.after(() => { if (instance.child && instance.child.exitCode === null && instance.child.signalCode === null) instance.child.kill('SIGKILL') })
      await assert.rejects(instance.launch({ readyTimeoutMs }), /did not become ready/)
      return instance.child
    }
    // Still held when the launch gives up: its group, and only its group, is signalled.
    const held = await launchGivingUp([process.execPath, idle], 1000)
    assert.deepEqual([held.exitCode, kills.mock.calls.map((call) => call.arguments)], [null, [[-held.pid, 'SIGKILL']]])
    // Exited and collected before the launch gave up: its number may be another process's, and so may a group of that
    // number. Nothing is signalled by number or by group.
    kills.mock.resetCalls()
    const exited = await launchGivingUp([TRUE_PROGRAM], 3000)
    assert.deepEqual([exited.exitCode, kills.mock.calls.length], [0, 0])
  })

  test('outside an owned run too: a launch is refused, before the socket under its HOME is removed, unless that HOME lies inside a layout root this process made and is not this user\'s own however it is reached', async (t) => {
    const made = createLayout()
    const aside = createLayout()
    const elsewhere = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'atelier-unowned-home-'))
    fs.mkdirSync(path.join(elsewhere, 'home'))
    // The layout's HOME becomes a link to this user's own HOME. Nothing below writes through it, and every removal is
    // a stand-in until the case ends; the link is then removed as a link.
    fs.rmdirSync(made.home)
    linkDirectory(os.homedir(), made.home)
    // Another directory now stands where a root this process made was.
    fs.renameSync(aside.root, `${aside.root}.moved`)
    fs.mkdirSync(path.join(aside.root, 'home'), { recursive: true })
    const removals = t.mock.method(fs, 'rmSync', () => {})
    const kills = recordKills(t)
    t.after(() => { removals.mock.restore(); for (const dir of [made.root, aside.root, `${aside.root}.moved`, elsewhere]) fs.rmSync(dir, { recursive: true, force: true }) })
    // The same HOME with the case of its first letter changed: the same directory on a volume that ignores case.
    const otherCase = os.homedir().replace(/[a-z]/i, (letter) => (letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()))
    const ignoresCase = process.platform === 'darwin' || process.platform === 'win32'
    const cases = [
      ['this user\'s own HOME', os.homedir(), /HOME is this user's own/],
      ['a link to it inside a root this process made', made.home, /HOME is this user's own/],
      ['it in another case', otherCase, ignoresCase ? /HOME is this user's own/ : /HOME is this user's own|not inside a layout root/],
      ['a directory this process did not make as a layout root', path.join(elsewhere, 'home'), /not inside a layout root this process created/],
      ['a root this process made, replaced by another directory', aside.home, /not inside a layout root this process created/],
    ]
    for (const [label, home, refusal] of cases) {
      for (const custody of [undefined, new OwnedRun({ readTable: async () => [], readOne: () => null })]) {
        const instance = new Instance({ ...made, home }, { custody, launcher: { app: [process.execPath, '-e', '0'], cli: [process.execPath, '-e', 'process.exitCode = 1'] } })
        await assert.rejects(instance.launch({ readyTimeoutMs: 300 }), refusal, label)
        assert.equal(instance.child, undefined, `${label}: nothing was started`)
      }
    }
    assert.deepEqual([removals.mock.calls.length, kills.mock.calls.length], [0, 0], 'nothing was removed or signalled')
    // Control: the HOME of a layout this process made passes.
    const fresh = createLayout()
    t.after(() => fs.rmSync(fresh.root, { recursive: true, force: true }))
    assert.doesNotThrow(() => assertPrivateHome(fresh.home))
  })

  test('outside an owned run: the event-loop benchmark signals its child\'s process group only while it still holds the child', async () => {
    const { endOwnedChild } = await import('../scripts/obsidian/benchmark-event-loop.mjs')
    let clock = 0
    // `members` stands for the processes in group 4242; `onSignal` is what a signal does to them. Nothing is sent.
    const end = async ({ exitCode = null, members, onSignal = () => {}, platform = 'darwin' }) => {
      const child = Object.assign(new EventEmitter(), { pid: 4242, exitCode, signalCode: null, connected: false, signals: [] })
      child.kill = (signal) => { child.signals.push(signal); child.signalCode = signal; members.count = 0; return true }
      const sent = []
      const kill = (pid, signal) => { sent.push([pid, signal]); if (members.count === 0) throw Object.assign(new Error('no such group'), { code: 'ESRCH' }); if (signal !== 0) onSignal(child, signal) }
      const result = await endOwnedChild(child, { value: exitCode === null ? null : { code: exitCode, signal: null } }, { kill, platform, now: () => clock, pause: async (ms) => { clock += ms }, waitMs: 100 })
      return { result, sent: sent.filter(([, signal]) => signal !== 0), child }
    }
    // Held, and the group (the child and its helper) leaves on SIGTERM.
    const group = { count: 2 }
    const whole = await end({ members: group, onSignal: (child, signal) => { child.signalCode = signal; group.count = 0 } })
    assert.deepEqual([whole.sent, whole.result.signals, whole.result.groupAbsent, 'notSignalled' in whole.result], [[[-4242, 'SIGTERM']], ['SIGTERM'], true, false])
    // The child was collected before the end began, and a group of its number still answers (a member that outlived
    // it, or another process's group): nothing is signalled, and the group is reported.
    const collected = await end({ exitCode: 0, members: { count: 1 } })
    assert.deepEqual([collected.sent, collected.result.signals, collected.result.groupAbsent, collected.result.notSignalled], [[], [], false, 'SIGTERM: the child was collected, so its group is not signalled'])
    // The child leaves on SIGTERM but a member ignores it: SIGKILL is not sent to a group whose leader is collected.
    const stubborn = { count: 2 }
    const ignored = await end({ members: stubborn, onSignal: (child, signal) => { child.signalCode = signal; stubborn.count = 1 } })
    assert.deepEqual([ignored.sent, ignored.result.signals, ignored.result.groupAbsent, ignored.result.notSignalled], [[[-4242, 'SIGTERM']], ['SIGTERM'], false, 'SIGKILL: the child was collected, so its group is not signalled'])
    // On Windows there is no group: the child is signalled through its handle, and nothing by number.
    const windows = await end({ members: { count: 1 }, platform: 'win32' })
    assert.deepEqual([windows.sent, windows.child.signals, windows.result.groupAbsent], [[], ['SIGTERM'], true])
  })

  test('owned run: nothing here tried to start the app', () => assert.deepEqual(guardErrors, []))
}
if (CLEANUP_ONLY) test('the rest of this file is skipped by ATELIER_OBSIDIAN_CLEANUP_ONLY=1', { skip: 'cleanup-only run: the acceptance cases below were not run' }, () => {})
if (!CLEANUP_ONLY) {
const { resolveProjectConfig, writeJson } = await import('../src/project/config.mjs')
const { CORPUS_ROOT } = await import('../src/contracts/corpus.mjs')
const { OBSIDIAN_EXT_KEY, ObsidianContractRefusal, identitySuffix, validateObsidianContract } = await import('../src/projection/obsidian/contracts.mjs')
const { openObjectStore } = await import('../src/projection/obsidian/edits/object-store.mjs')
const { editIdempotencyKey } = await import('../src/projection/obsidian/edits/observe.mjs')
const { applyPolicyDigest } = await import('../src/projection/obsidian/edits/policy.mjs')
const { isUserOwnedSettingsPath } = await import('../src/projection/obsidian/materialize/settings.mjs')
const {
  CONFLICT_VIEW_SCHEMA, FOCUS_QUERY_VERSION, OBJECT_VIEW_STATES, POLICY_SETUP_SCHEMA, RECEIPT_EXT_KEY, RECEIPT_GATES, RECEIPT_GATE_IDS, RECEIPT_RULES, RECEIPT_VALIDATION_LABEL,
  SELECTION_DIRECTORY, SELECTION_SCHEMA, SELECTION_STATE_SCHEMA, UI_OWNED_SETTINGS_FILES,
  assertWritableSelectionPath, buildApplyPolicy, buildFocusQuery, conflictView, createFocusQueryBuilderForOracleTests, createReceiptValidatorForOracleTests, createSelectionContribution,
  dispatchGate, focusBookmarkPayload, listSelectionStates, readConflictView, readSelectionState, receiptRequirementsFor, resolveSelection, runPolicySetup, scopeDocumentOf,
  validateAcceptanceReceipt, writeSelectionState,
} = await import('../src/projection/obsidian/selection-ui/index.mjs')
const { COMMAND_SCHEMA, EXIT, runObsidianCommandForOracleTests } = await import('../src/commands/obsidian.mjs')
const { ObsidianMaintenanceRefusal } = await import('../src/runtime/obsidian/errors.mjs')
const { authorizeAutomaticApply, defaultMachineSettings, ensureWorkspaceIdentity, protectedRoots, readInstalledApplyPolicy, readMachineSettings, workspaceStateRoot, writeMachineSettings } = await import('../src/runtime/obsidian/machine-settings.mjs')
const { dispatchAutomaticApply } = await import('../src/runtime/obsidian/pending-edits.mjs')
// AOP-4 phase 2 proof tooling (scripts/obsidian, unshipped). Imported after
// the guard: none of it may start the app, and its drivers never run on import.
const { OutputRefusal, assertExternalOutput, repositoryContaining } = await import('../scripts/obsidian/lib/common.mjs')
const { PROPOSED_TARGETS, createResourceSampler, createWarmChangeSummaryForOracleTests, percentile, waitUntil, warmChangeSummary } = await import('../scripts/obsidian/lib/measure.mjs')
const { absentAdapter, createEngineSeams, deriveWorkspace, loadProject, materializeFixtureWorkspace } = await import('../scripts/obsidian/lib/derive.mjs')
const { bindLayoutToVault, createCommandRunner, createInProcessServiceRuntime, createPerVaultAdapterFactory, createServiceRuntime, fileDigest, initialiseRepositories, noteFile, prepareWorkspace, stripProjectEnv } = await import('../scripts/obsidian/lib/service-world.mjs')
const { resolveExchange } = await import('../src/projection/obsidian/publication/index.mjs')
const { interruptService, runAp03 } = await import('../scripts/obsidian/lib/ap03.mjs')
const { AP05_EDITS, AP05_SCOPES, createAp05RunnerForOracleTests, prepareAp05Workspace, runAp05 } = await import('../scripts/obsidian/lib/ap05.mjs')
const { createMaintenanceEngine } = await import('../src/runtime/obsidian/engine.mjs')
const { runMaintenanceService } = await import('../src/runtime/obsidian/service.mjs')
const { createObsidianRegistry } = await import('../src/runtime/obsidian/extension-points.mjs')
const { createNullWatcherFactory } = await import('../src/runtime/obsidian/watchers.mjs')
const { createSourceApplyContribution } = await import('../src/projection/obsidian/edits/contribution.mjs')
const { createProposalAdapterContribution } = await import('../src/projection/obsidian/proposals/contribution.mjs')
const { DESKTOP_EXT_KEY, ReceiptRefusal, buildReceipt, evidenceFileName, writeGateReceipt } = await import('../scripts/obsidian/lib/receipts.mjs')
const { DEFAULT_SEED, PROFILES, generateScaleDataset, measureDerivation, planDataset } = await import('../scripts/obsidian/generate-scale.mjs')
const {
  DESKTOP_PROCEDURES, IsolationRefusal, PROCEDURE_IDS, assertIsolatedInstance, cleanupOwnedRuntime, cleanupProcedureRuntime, combineProcedureAndCleanupError, desktopReceiptErrorExitCode, formatDesktopReceiptError, compareMembership, compareResolvedLinks, discoverCapabilities, expectedLinkPairs, parseHelpOutput, parseVersionOutput,
  planProcedure, recordProcedureReceipts, runAp01, runAp02Membership, runAp04App,
} = await import('../scripts/obsidian/desktop-receipts.mjs')
const { SIGNED_NOTE, UNSIGNED_NOTE, createReceiptVerifierForOracleTests, formatTable, verifyReceiptSet } = await import('../scripts/obsidian/verify-receipts.mjs')
const { signReceipt } = await import('../scripts/obsidian/sign-receipt.mjs')

// AOP-4 phase 1: selection binding, focus queries, apply policy setup, the
// conflict view and acceptance receipt validation. Invented, synthetic
// content only. Nothing here opens the app, publishes a vault or writes a
// source file. The receipt tests prove the validator's shape checks and
// nothing about any gate: a schema-valid receipt closes no gate, and the
// last receipt test pins that.
//
// The literal expectations below are compared with the output of the real
// functions; the mutation controls prove each comparison can fail.

const TMP = fs.realpathSync(os.tmpdir())
const REPOSITORY_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const ORACLES = readJson(path.join(CORPUS_ROOT, 'fixtures/obsidian/contracts/oracles/scope-cases.json'))
const PROFILE = readJson(path.join(CORPUS_ROOT, ORACLES.profileFixture))
const SNAPSHOT = { nodes: ORACLES.nodes, edges: ORACLES.edges }
const FIXTURES = path.join(REPOSITORY_ROOT, 'fixtures', 'obsidian', 'acceptance', 'receipts')
const NOW = '2026-01-05T10:00:00.000Z'
// Tests that publish into a vault need this platform's atomic exchange; where there is none the publisher refuses,
// which test/obsidian-recovery.test.mjs asserts. Planning, recording and validation tests stay unguarded.
const EXCHANGE_HERE = (() => { try { resolveExchange({}); return true } catch { return false } })()
const needsExchange = EXCHANGE_HERE ? {} : { skip: 'no atomic exchange on this platform: the publisher refuses, which is asserted separately' }
const sha = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`
// The focus term of one vault path, as its rules read: an anchored regular expression, metacharacters and the
// delimiter escaped, a space and a double quote as hexadecimal escapes.
const pathTerm = (value) => `path:/^${value.replace(/[\\^$.*+?()[\]{}|/]/g, (character) => `\\${character}`).replace(/ /g, '\\x20').replace(/"/g, '\\x22')}$/`
const fixedRandom = (size) => Buffer.alloc(size, 9)
const WORKSPACE_ID = `ws-${'09'.repeat(12)}`

function refusalCode(run) {
  try { run() } catch (error) {
    assert.ok(error instanceof ObsidianMaintenanceRefusal || error instanceof ObsidianContractRefusal, `expected a typed refusal, got ${error?.stack ?? error}`)
    return error.code
  }
  return null
}

function tempDir(t, label) {
  const dir = fs.mkdtempSync(path.join(TMP, `atelier-acceptance-${label}-`))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
  return dir
}

// A private workspace root and one repository root it must stay outside of.
function tempWorkspace(t, label) {
  const dir = tempDir(t, label)
  const workspace = { workspaceRoot: path.join(dir, 'workspace'), workspaceId: WORKSPACE_ID }
  const repositoryRoots = [path.join(dir, 'repository')]
  fs.mkdirSync(workspace.workspaceRoot, { recursive: true, mode: 0o700 })
  fs.mkdirSync(repositoryRoots[0], { recursive: true })
  writeMachineSettings({ ...workspace, repositoryRoots, settings: defaultMachineSettings({ workspaceId: WORKSPACE_ID, updatedAt: NOW }) })
  return { dir, workspace, repositoryRoots }
}

const select = (scope, extra = {}) => resolveSelection({ canonicalSnapshot: SNAPSHOT, profile: PROFILE, scope, ...extra })

// ---------------------------------------------------------------------------
// 1. Selection: literal expected scopes
// ---------------------------------------------------------------------------

test('the spawn guard refuses a child that can reach a running Obsidian unless nothing in its environment leads to the developer\'s own app', async (t) => {
  const dir = tempDir(t, 'home-guard')
  const [home, runtime] = [path.join(dir, 'private-home'), path.join(dir, 'private-runtime')]
  fs.mkdirSync(home)
  fs.mkdirSync(runtime, { mode: 0o700 })
  const { XDG_CONFIG_HOME: _config, ...inherited } = process.env
  const isolated = { ...inherited, HOME: home, XDG_RUNTIME_DIR: runtime }
  // macOS needs a private HOME; Linux a private XDG_RUNTIME_DIR too; on Windows no such child is started at all.
  assert.deepEqual([reachesOwnApp(isolated, 'darwin'), reachesOwnApp(isolated, 'linux')], [null, null])
  assert.equal(reachesOwnApp({ ...isolated, XDG_RUNTIME_DIR: '/run/user/501' }, 'darwin'), null)
  assert.match(String(reachesOwnApp({ ...isolated, XDG_RUNTIME_DIR: '/run/user/1000' }, 'linux')), /private XDG_RUNTIME_DIR/)
  assert.match(String(reachesOwnApp({ HOME: home }, 'linux')), /private XDG_RUNTIME_DIR/)
  assert.match(String(reachesOwnApp({ ...isolated, HOME: os.homedir() }, 'darwin')), /private HOME/)
  assert.match(String(reachesOwnApp(isolated, 'win32')), /never started on this platform/)
  const before = guardErrors.length
  // The service-world harness starts the production entry with `--adapter=obsidian-cli` unless told otherwise.
  const args = ['-e', '0', '--', '--adapter=obsidian-cli']
  assert.throws(() => childProcess.spawnSync(process.execPath, args), /spawn guard/)
  assert.throws(() => childProcess.spawnSync(process.execPath, ['-e', '0', '--', '--entry-args=--adapter=obsidian-cli'], { env: { ...process.env } }), /spawn guard/)
  // The promisified execFile keeps its own form ({ stdout, stderr }), and is guarded too.
  assert.throws(() => promisify(childProcess.execFile)(process.execPath, args), /spawn guard/)
  assert.equal(guardErrors.length, before + 3)
  guardErrors.length = before
  if (reachesOwnApp(isolated) === null) {
    assert.equal(childProcess.spawnSync(process.execPath, args, { env: isolated }).status, 0)
    assert.deepEqual(await promisify(childProcess.execFile)(process.execPath, ['-e', 'process.stdout.write("ok")', '--', '--adapter=obsidian-cli'], { env: isolated }), { stdout: 'ok', stderr: '' })
  } else assert.throws(() => childProcess.spawnSync(process.execPath, args, { env: isolated }), /never started on this platform/)
  guardErrors.length = before
})

test('full selection is the whole authorized corpus, as an exact scope document', () => {
  const selection = select({ scopeId: 'view-full', mode: 'full', selector: { all: true } })
  assert.equal(selection.schema, SELECTION_SCHEMA)
  assert.deepEqual(selection.scope, { schema: 'atelier-obsidian-scope/v1', scopeId: 'view-full', mode: 'full', selector: { all: true } })
  assert.deepEqual(validateObsidianContract('scope', selection.scope), [])
  assert.deepEqual(selection.nodes, ['a', 'b', 'c', 'd'])
  assert.deepEqual(selection.edges, ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9'])
  assert.deepEqual(selection.outsideSelectionEdges, [])
  assert.deepEqual(selection.vaultNodes, ['a', 'b', 'c', 'd'])
  assert.equal(selection.truncated, false)
  assert.equal(selection.empty, false)
  assert.equal(selection.focus, null)
  // The withheld node x is in no list and no path.
  assert.deepEqual(Object.keys(selection.notePaths), ['a', 'b', 'c', 'd'])
  // Vault layout 2: the repository's folders, the title as the name, a wrapped file under its own name.
  assert.deepEqual(selection.notePaths, {
    a: 'north/plans/Shared concept.md', b: 'south/notes/two.json.md', c: 'west/notes/three.html.md', d: 'north/notes/Shared concept.md',
  })
  assert.notEqual(selection.notePaths.a, selection.notePaths.d, 'duplicate titles stay distinct: here by their folders')
})

test('scoped selection: repository, path prefix and a set expression give exactly the oracle sets', () => {
  const north = select({ scopeId: 'view-north', mode: 'scoped', selector: { repo: 'north' } })
  // Outside: every visible edge with exactly one end in {a, d}; e3 (c -> a) is one of them. e10 reaches the withheld x and is not visible at all.
  assert.deepEqual({ nodes: north.nodes, edges: north.edges, outside: north.outsideSelectionEdges, vault: north.vaultNodes }, { nodes: ['a', 'd'], edges: ['e4', 'e5'], outside: ['e1', 'e3', 'e6', 'e7', 'e8', 'e9'], vault: ['a', 'd'] })
  const plans = select({ scopeId: 'view-plans', mode: 'scoped', selector: { repo: 'north', pathPrefix: 'plans/' } })
  assert.deepEqual({ nodes: plans.nodes, edges: plans.edges }, { nodes: ['a'], edges: [] })
  const expression = readJson(path.join(CORPUS_ROOT, 'fixtures/obsidian/contracts/scope/valid/scoped-set-expression.v1.json'))
  const scoped = select(expression)
  assert.deepEqual(scoped.scope, expression, 'the requested document comes back exactly')
  // (plans/ of north ∪ tag topic ∪ {b}) \ (html ∩ west) = {a, b}, then one outgoing hop within a budget of 3: c joins.
  assert.deepEqual({ nodes: scoped.nodes, edges: scoped.edges, truncated: scoped.truncated }, { nodes: ['a', 'b', 'c'], edges: ['e1', 'e2', 'e3', 'e6'], truncated: true })
  assert.deepEqual(scoped.diagnostics, ['expansion-truncated-at-node-budget'])
})

test('bounded expansion is exact and the two defaulted members are written into the document; budgets never are', () => {
  const expanded = select({ scopeId: 'view-expand', mode: 'scoped', selector: { ids: ['a'] }, expansion: { depth: 1, maxNodes: 3 } })
  assert.deepEqual(expanded.scope.expansion, { depth: 1, maxNodes: 3, direction: 'outgoing', order: 'canonical-id' })
  assert.deepEqual({ nodes: expanded.nodes, edges: expanded.edges, truncated: expanded.truncated }, { nodes: ['a', 'b', 'c'], edges: ['e1', 'e2', 'e3', 'e6'], truncated: true })
  const incoming = select({ scopeId: 'view-in', mode: 'scoped', selector: { ids: ['a'] }, expansion: { depth: 1, maxNodes: 10, direction: 'incoming' } })
  assert.deepEqual({ nodes: incoming.nodes, edges: incoming.edges, truncated: incoming.truncated }, { nodes: ['a', 'c', 'd'], edges: ['e3', 'e4', 'e5', 'e6', 'e8'], truncated: false })
  assert.equal(refusalCode(() => select({ scopeId: 'view-x', mode: 'scoped', selector: { ids: ['a'] }, expansion: { depth: 1 } })), 'missing-expansion-budget')
  assert.equal(refusalCode(() => select({ scopeId: 'view-x', mode: 'scoped', selector: { ids: ['a'] }, expansion: { maxNodes: 3 } })), 'missing-expansion-budget')
  assert.equal(refusalCode(() => select({ scopeId: 'view-x', mode: 'scoped', selector: { ids: ['a'] }, expansion: { depth: 9, maxNodes: 3 } })), 'invalid-expansion')
})

test('focus selection keeps the full vault and derives the graph query from the selected paths', () => {
  const focus = select({ scopeId: 'view-focus', mode: 'focus', selector: { ids: ['a', 'b'] } })
  assert.deepEqual({ nodes: focus.nodes, edges: focus.edges, vault: focus.vaultNodes, vaultEdges: focus.vaultEdges }, { nodes: ['a', 'b'], edges: ['e1'], vault: ['a', 'b', 'c', 'd'], vaultEdges: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9'] })
  assert.deepEqual(focus.focus, {
    version: FOCUS_QUERY_VERSION,
    query: `${pathTerm('north/plans/Shared concept.md')} OR ${pathTerm('south/notes/two.json.md')}`,
    queryDigest: sha(`${pathTerm('north/plans/Shared concept.md')} OR ${pathTerm('south/notes/two.json.md')}`),
    paths: ['north/plans/Shared concept.md', 'south/notes/two.json.md'],
    bookmark: { type: 'graph', title: 'Atelier focus view-focus', options: { search: `${pathTerm('north/plans/Shared concept.md')} OR ${pathTerm('south/notes/two.json.md')}` } },
  })
  // The same identity has the same path in the full view.
  const full = select({ scopeId: 'view-full', mode: 'full', selector: { all: true } })
  assert.equal(full.notePaths.a, focus.notePaths.a)
  assert.equal(full.notePaths.b, focus.notePaths.b)
  // Deterministic: the same request is the same answer.
  assert.deepEqual(select({ scopeId: 'view-focus', mode: 'focus', selector: { ids: ['a', 'b'] } }), focus)
})

test('a persisted path registry decides the paths a focus names, through the view\'s own section', () => {
  // The view's section may hold a qualified name of the same identity (one allocated after a collision); a path no rule can produce is refused.
  const sectionOf = (entries) => ({ schema: 'atelier-obsidian-path-registry/v1', workspaceId: PROFILE.workspaceId, layout: 2, entries: [], assets: [], views: { 'view-focus': { entries, assets: [] } } })
  const registry = sectionOf([{ repoId: 'north', nodeId: 'a', path: 'north/plans/Shared concept (one).md' }])
  const focus = select({ scopeId: 'view-focus', mode: 'focus', selector: { ids: ['a'] } }, { pathRegistry: registry })
  assert.equal(focus.focus.query, pathTerm('north/plans/Shared concept (one).md'))
  for (const path of ['north/plans/.Shared concept.md', 'north/plans/Shared [concept].md', 'Shared concept.md']) {
    assert.equal(refusalCode(() => select({ scopeId: 'view-focus', mode: 'focus', selector: { ids: ['a'] } }, { pathRegistry: sectionOf([{ repoId: 'north', nodeId: 'a', path }]) })), 'invalid-path-registry', path)
  }
  // Another view's section decides nothing for this one.
  const elsewhere = { ...registry, views: { 'view-other': registry.views['view-focus'] } }
  assert.equal(select({ scopeId: 'view-focus', mode: 'focus', selector: { ids: ['a'] } }, { pathRegistry: elsewhere }).focus.query, pathTerm('north/plans/Shared concept.md'))
  // A layout 1 registry holds no view: the paths are allocated anew.
  const earlier = { schema: 'atelier-obsidian-path-registry/v1', workspaceId: PROFILE.workspaceId, entries: [{ repoId: 'north', nodeId: 'a', path: 'notes/Shared concept--82f6d012eaad.md' }] }
  assert.equal(select({ scopeId: 'view-focus', mode: 'focus', selector: { ids: ['a'] } }, { pathRegistry: earlier }).focus.query, pathTerm('north/plans/Shared concept.md'))
})

test('refusals: empty, withheld, unbounded expansion, focus of nothing, full mode with a subset', () => {
  assert.equal(refusalCode(() => select({ scopeId: 'view-e', mode: 'scoped', selector: { ids: [] } })), 'selection-empty')
  const honest = select({ scopeId: 'view-e', mode: 'scoped', selector: { ids: [] } }, { allowEmpty: true })
  assert.deepEqual({ nodes: honest.nodes, edges: honest.edges, vault: honest.vaultNodes, empty: honest.empty, reason: honest.emptyReason, paths: honest.notePaths }, { nodes: [], edges: [], vault: [], empty: true, reason: 'explicit-empty', paths: {} })
  // Withheld: absent and withheld are one answer, and no fallback to all.
  let error = null
  try { select({ scopeId: 'view-w', mode: 'scoped', selector: { ids: ['x', 'nobody'] } }) } catch (caught) { error = caught }
  assert.equal(error?.code, 'selection-empty')
  assert.deepEqual(error.detail, { reason: 'no-visible-members', unresolvedIds: ['nobody', 'x'] })
  const withheld = select({ scopeId: 'view-w', mode: 'scoped', selector: { ids: ['x'] } }, { allowEmpty: true })
  assert.deepEqual({ nodes: withheld.nodes, reason: withheld.emptyReason, diagnostics: withheld.diagnostics }, { nodes: [], reason: 'no-visible-members', diagnostics: ['selection-has-no-visible-members'] })
  assert.equal(refusalCode(() => select({ scopeId: 'view-f', mode: 'focus', selector: { ids: ['x'] } }, { allowEmpty: true })), 'focus-selection-empty', 'a focus is never widened, even when empty is allowed')
  assert.equal(refusalCode(() => select({ scopeId: 'view-f', mode: 'focus', selector: { ids: [] } }, { allowEmpty: true })), 'focus-selection-empty')
  assert.equal(refusalCode(() => select({ scopeId: 'view-full', mode: 'full', selector: { ids: ['a'] } })), 'invalid-scope')
  assert.equal(refusalCode(() => select({ scopeId: 'view-u', mode: 'scoped', selector: { repo: 'nowhere' } })), 'unknown-repo')
  assert.equal(refusalCode(() => select({ scopeId: 'view-u', mode: 'scoped', selector: { glob: '*' } })), 'invalid-scope')
  assert.equal(refusalCode(() => select({ scopeId: 'view-u', mode: 'everything', selector: { all: true } })), 'invalid-scope')
  assert.equal(refusalCode(() => scopeDocumentOf({ scopeId: '', mode: 'full', selector: { all: true } })), 'invalid-scope')
})

// ---------------------------------------------------------------------------
// 2. Focus query escaping, and its mutation control
// ---------------------------------------------------------------------------

const ESCAPING_CASES = [
  { name: 'spaces', paths: ['notes/Shared concept--82f6d012eaad.md'], query: 'path:/^notes\\/Shared\\x20concept--82f6d012eaad\\.md$/' },
  { name: 'double quotes', paths: ['notes/He said "go"--0123456789ab.md'], query: 'path:/^notes\\/He\\x20said\\x20\\x22go\\x22--0123456789ab\\.md$/' },
  { name: 'unicode, composed', paths: ['notes/Caf\u00e9 \u00fcnicode \u2014 \u5317--0123456789ab.md'], query: 'path:/^notes\\/Caf\u00e9\\x20\u00fcnicode\\x20\u2014\\x20\u5317--0123456789ab\\.md$/' },
  { name: 'unicode, decomposed input is composed on output', paths: ['notes/Cafe\u0301--0123456789ab.md'], query: 'path:/^notes\\/Caf\u00e9--0123456789ab\\.md$/' },
  { name: 'several, in the order given', paths: ['notes/B--0123456789ab.md', 'notes/A--0123456789ab.md'], query: 'path:/^notes\\/B--0123456789ab\\.md$/ OR path:/^notes\\/A--0123456789ab\\.md$/' },
  { name: 'search operators and regular-expression characters stay text', paths: ['notes/tag:#x OR -y (z) [a|b] $1.md'], query: 'path:/^notes\\/tag:#x\\x20OR\\x20-y\\x20\\(z\\)\\x20\\[a\\|b\\]\\x20\\$1\\.md$/' },
]

test('a focus names exact paths: no path matches a term of another, whether it contains it, lies inside it, or differs in case alone', () => {
  const built = buildFocusQuery(['r/a/Plan.md', 'r/b/Notes (2).md'])
  // Each term is an anchored regular expression; the app's search compares a path case-insensitively.
  const regexes = built.query.split(' OR ').map((term) => new RegExp(/^path:\/(.*)\/$/.exec(term)[1], 'i'))
  const matched = (vaultPath) => regexes.some((regex) => regex.test(vaultPath))
  for (const vaultPath of ['r/a/Plan.md', 'r/b/Notes (2).md', 'R/A/plan.md']) assert.equal(matched(vaultPath), true, vaultPath)
  for (const vaultPath of ['qr/a/Plan.md', 'r/a/Plan.md.md', 'r/a/Plan (b).md', 'x/r/a/Plan.md', 'r/a/Plan.mdx', 'r/b/Notes (22).md', 'r/b/Notes 2.md']) assert.equal(matched(vaultPath), false, vaultPath)
  assert.equal(built.version, FOCUS_QUERY_VERSION)
  assert.equal(FOCUS_QUERY_VERSION, 'obsidian-graph-search-paths/v2')
})

test('focus query escaping: spaces, quotes and unicode give the literal expected query', () => {
  for (const item of ESCAPING_CASES) {
    const built = buildFocusQuery(item.paths)
    assert.equal(built.query, item.query, item.name)
    assert.equal(built.queryDigest, sha(item.query), item.name)
    assert.equal(built.version, FOCUS_QUERY_VERSION)
  }
  assert.deepEqual(focusBookmarkPayload({ scopeId: 'view-focus', query: 'path:"a"' }), { type: 'graph', title: 'Atelier focus view-focus', options: { search: 'path:"a"' } })
  assert.deepEqual(UI_OWNED_SETTINGS_FILES, ['workspace.json', 'graph.json', 'bookmarks.json'])
  for (const name of UI_OWNED_SETTINGS_FILES) assert.ok(isUserOwnedSettingsPath(`.obsidian/${name}`), `${name} is a file the person owns`)
})

test('focus query refusals: nothing, a control character, a backslash path, an absolute path, a repeated path', () => {
  assert.equal(refusalCode(() => buildFocusQuery([])), 'focus-selection-empty')
  assert.equal(refusalCode(() => buildFocusQuery(['notes/a\nb--0123456789ab.md'])), 'focus-path-unrepresentable')
  // The two Unicode line separators are written as escapes here and in the builder; neither file holds the literal character.
  assert.equal(refusalCode(() => buildFocusQuery(['notes/a\u2028b--0123456789ab.md'])), 'focus-path-unrepresentable')
  assert.equal(refusalCode(() => buildFocusQuery(['notes/a\u2029b--0123456789ab.md'])), 'focus-path-unrepresentable')
  assert.equal(refusalCode(() => buildFocusQuery(['notes/a\u0085b--0123456789ab.md'])), 'focus-path-unrepresentable')
  for (const file of ['src/projection/obsidian/selection-ui/focus.mjs', 'test/obsidian-acceptance.test.mjs']) {
    assert.doesNotMatch(fs.readFileSync(path.join(REPOSITORY_ROOT, file), 'utf8'), /[\u2028\u2029]/, `${file} carries no literal line separator`)
  }
  assert.equal(refusalCode(() => buildFocusQuery(['notes\\a--0123456789ab.md'])), 'focus-path-unrepresentable')
  assert.equal(refusalCode(() => buildFocusQuery(['/notes/a--0123456789ab.md'])), 'focus-path-unrepresentable')
  assert.equal(refusalCode(() => buildFocusQuery(['notes/../a--0123456789ab.md'])), 'focus-path-unrepresentable')
  assert.equal(refusalCode(() => buildFocusQuery(['notes/a--0123456789ab.md', 'notes/a--0123456789ab.md'])), 'duplicate-identity')
  assert.equal(refusalCode(() => focusBookmarkPayload({ scopeId: 'view-focus', query: '' })), 'focus-selection-empty')
})

test('a focus persisted with the earlier query version is still read; a new focus is written with this one', async () => {
  const { validateSelectionState } = await import('../src/projection/obsidian/selection-ui/selection-state.mjs')
  const query = 'path:"north/plans/Shared concept.md"'
  const focus = { version: 'obsidian-graph-search-paths/v1', query, queryDigest: sha(query), paths: ['north/plans/Shared concept.md'], bookmark: { type: 'graph', title: 'Atelier focus view-focus', options: { search: query } } }
  const document = { schema: SELECTION_STATE_SCHEMA, workspaceId: WORKSPACE_ID, scopeId: 'view-focus', mode: 'focus', selector: { ids: ['a'] }, expansion: null, focus, updatedAt: NOW }
  assert.deepEqual(validateSelectionState(document, WORKSPACE_ID), document)
  assert.throws(() => validateSelectionState({ ...document, focus: { ...focus, version: 'obsidian-graph-search-paths/v9' } }, WORKSPACE_ID))
  assert.equal(select({ scopeId: 'view-focus', mode: 'focus', selector: { ids: ['a'] } }).focus.version, 'obsidian-graph-search-paths/v2')
})

test('mutation control: a builder that drops escaping fails the escaping oracle', () => {
  // Every case holds a separator and a dot, which an unescaped term would read as regular-expression syntax.
  const unescaped = createFocusQueryBuilderForOracleTests({ escape: (value) => value })
  assert.equal(ESCAPING_CASES.filter((item) => unescaped(item.paths).query !== item.query).length, ESCAPING_CASES.length)
  const unanchored = createFocusQueryBuilderForOracleTests({ term: (value) => `path:/${value}/` })
  assert.equal(ESCAPING_CASES.filter((item) => unanchored(item.paths).query !== item.query).length, ESCAPING_CASES.length)
  const wrongJoin = createFocusQueryBuilderForOracleTests({ join: (terms) => terms.join(' ') })
  assert.deepEqual(ESCAPING_CASES.filter((item) => wrongJoin(item.paths).query !== item.query).map((item) => item.name), ['several, in the order given'])
})

// ---------------------------------------------------------------------------
// 3. The selector persists in Atelier state, never in a UI-owned file
// ---------------------------------------------------------------------------

test('a selection persists under state/selection, is read back exactly, and rewrites only when it changes', (t) => {
  const { workspace, repositoryRoots } = tempWorkspace(t, 'state')
  const focus = select({ scopeId: 'view-focus', mode: 'focus', selector: { ids: ['a', 'b'] } })
  const written = writeSelectionState({ ...workspace, repositoryRoots, selection: focus, now: NOW })
  assert.equal(path.relative(workspace.workspaceRoot, written.file).split(path.sep).join('/'), 'state/selection/view-focus.json')
  assert.equal(written.changed, true)
  assert.deepEqual(written.document, {
    schema: SELECTION_STATE_SCHEMA, workspaceId: WORKSPACE_ID, scopeId: 'view-focus', mode: 'focus', selector: { ids: ['a', 'b'] }, expansion: null,
    focus: { version: FOCUS_QUERY_VERSION, query: focus.focus.query, queryDigest: focus.focus.queryDigest, paths: focus.focus.paths, bookmark: focus.focus.bookmark }, updatedAt: NOW,
  })
  if (process.platform !== 'win32') assert.equal(fs.statSync(written.file).mode & 0o777, 0o600, 'owner-only')
  assert.deepEqual(readSelectionState({ ...workspace, scopeId: 'view-focus' }), written.document)
  // The same selection later: no rewrite, the earlier time stays.
  const again = writeSelectionState({ ...workspace, repositoryRoots, selection: focus, now: '2026-01-05T11:00:00.000Z' })
  assert.deepEqual({ changed: again.changed, updatedAt: again.document.updatedAt }, { changed: false, updatedAt: NOW })
  // A changed selection is a rewrite.
  const wider = select({ scopeId: 'view-focus', mode: 'focus', selector: { ids: ['a', 'b', 'c'] } })
  assert.equal(writeSelectionState({ ...workspace, repositoryRoots, selection: wider, now: '2026-01-05T11:00:00.000Z' }).changed, true)
  assert.equal(readSelectionState({ ...workspace, scopeId: 'view-focus' }).focus.paths.length, 3)
  // Several scopes list in scope order; a scoped one carries no focus.
  writeSelectionState({ ...workspace, repositoryRoots, selection: select({ scopeId: 'view-a:north', mode: 'scoped', selector: { repo: 'north' }, expansion: { depth: 1, maxNodes: 4 } }), now: NOW })
  assert.deepEqual(listSelectionStates(workspace).map((item) => [item.scopeId, item.mode, item.focus === null, item.expansion]), [['view-a:north', 'scoped', true, { depth: 1, maxNodes: 4, direction: 'outgoing', order: 'canonical-id' }], ['view-focus', 'focus', false, null]])
  assert.equal(readSelectionState({ ...workspace, scopeId: 'view-none' }), null)
  // Nothing under any vault and nothing under .obsidian/ exists in the workspace.
  const files = []
  const walk = (directory) => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const full = path.join(directory, entry.name); if (entry.isDirectory()) walk(full); else files.push(path.relative(workspace.workspaceRoot, full).split(path.sep).join('/')) } }
  walk(workspace.workspaceRoot)
  assert.deepEqual(files.sort(), ['state/selection/view-a_north.json', 'state/selection/view-focus.json', 'state/settings/machine.json'])
  assert.ok(files.every((file) => !file.includes('.obsidian') && !file.startsWith('vaults/')))
})

test('the selection writer refuses a UI-owned target, a vault target, an outside target and an overlap with a repository', (t) => {
  const { workspace, repositoryRoots } = tempWorkspace(t, 'guard')
  const root = workspace.workspaceRoot
  for (const name of UI_OWNED_SETTINGS_FILES) assert.equal(refusalCode(() => assertWritableSelectionPath({ workspaceRoot: root, file: path.join(root, 'vaults', 'view-full', '.obsidian', name) })), 'ui-owned-file-refused')
  assert.equal(refusalCode(() => assertWritableSelectionPath({ workspaceRoot: root, file: path.join(root, 'vaults', 'view-full', 'notes', 'x.md') })), 'ui-owned-file-refused')
  assert.equal(refusalCode(() => assertWritableSelectionPath({ workspaceRoot: root, file: path.join(root, 'state', 'maintenance', 'x.json') })), 'selection-state-outside-workspace')
  assert.equal(refusalCode(() => assertWritableSelectionPath({ workspaceRoot: root, file: path.join(path.dirname(root), 'x.json') })), 'selection-state-outside-workspace')
  assert.equal(assertWritableSelectionPath({ workspaceRoot: root, file: path.join(root, SELECTION_DIRECTORY, 'view.json') }), path.join(root, SELECTION_DIRECTORY, 'view.json'))
  const selection = select({ scopeId: 'view-full', mode: 'full', selector: { all: true } })
  assert.equal(refusalCode(() => writeSelectionState({ ...workspace, repositoryRoots: [root], selection, now: NOW })), 'managed-root-inside-repository')
  assert.equal(refusalCode(() => writeSelectionState({ ...workspace, repositoryRoots, selection: { schema: 'something-else' }, now: NOW })), 'invalid-selection')
  assert.equal(refusalCode(() => writeSelectionState({ ...workspace, repositoryRoots, selection, now: 'yesterday' })), 'invalid-selection-state')
  // A stored document of another workspace, or with a member the shape does not know, refuses on read.
  fs.mkdirSync(path.join(root, SELECTION_DIRECTORY), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(root, SELECTION_DIRECTORY, 'view-x.json'), JSON.stringify({ schema: SELECTION_STATE_SCHEMA, workspaceId: 'ws-other', scopeId: 'view-x', mode: 'full', selector: { all: true }, expansion: null, focus: null, updatedAt: NOW }))
  assert.equal(refusalCode(() => readSelectionState({ ...workspace, scopeId: 'view-x' })), 'invalid-selection-state')
  fs.writeFileSync(path.join(root, SELECTION_DIRECTORY, 'view-x.json'), JSON.stringify({ schema: SELECTION_STATE_SCHEMA, workspaceId: WORKSPACE_ID, scopeId: 'view-x', mode: 'full', selector: { all: true }, expansion: null, focus: null, updatedAt: NOW, graphSettings: {} }))
  assert.equal(refusalCode(() => readSelectionState({ ...workspace, scopeId: 'view-x' })), 'invalid-selection-state')
})

// ---------------------------------------------------------------------------
// 4. Apply policy setup: create, show, revoke; revocation wins
// ---------------------------------------------------------------------------

test('policy setup round trip: create manual, show, create automatic, revoke; the digest is the canonical one', (t) => {
  const { workspace, repositoryRoots } = tempWorkspace(t, 'policy')
  const actor = { kind: 'user', id: 'person-synthetic' }
  const manual = runPolicySetup({ action: 'create', input: { policyId: 'policy-house', mode: 'manual', actor, selector: { all: true } }, workspace, repositoryRoots, now: NOW })
  assert.equal(manual.schema, POLICY_SETUP_SCHEMA)
  assert.equal(manual.ok, true)
  assert.deepEqual(validateObsidianContract('apply-policy', manual.policy), [])
  assert.deepEqual({ ...manual.policy, digest: 'x' }, { schema: 'atelier-obsidian-apply-policy/v1', policyId: 'policy-house', workspaceId: WORKSPACE_ID, mode: 'manual', status: 'active', actor, version: 1, allowedEditClasses: [], selector: { all: true }, maxBatchSize: 10, retryBudget: 0, conflictDisposition: 'hold', digest: 'x' })
  assert.equal(manual.policy.digest, applyPolicyDigest(manual.policy))
  assert.deepEqual(manual.reference, { policyId: 'policy-house', version: 1, digest: manual.policy.digest, mode: 'manual', status: 'active' })
  assert.deepEqual(manual.automaticApply, { authorized: false, reason: 'maintenance-mode-manual' })
  assert.deepEqual(readInstalledApplyPolicy(workspace), manual.policy)
  assert.deepEqual(readMachineSettings(workspace).applyPolicy, { policyId: 'policy-house', version: 1, digest: manual.policy.digest })

  const shown = runPolicySetup({ action: 'show', workspace })
  assert.deepEqual({ ok: shown.ok, installed: shown.installed, policy: shown.policy, reference: shown.reference, maintenanceMode: shown.maintenanceMode, automaticApply: shown.automaticApply }, { ok: true, installed: true, policy: manual.policy, reference: readMachineSettings(workspace).applyPolicy, maintenanceMode: 'manual', automaticApply: { authorized: false, reason: 'maintenance-mode-manual' } })

  // The next revision of the same identity is one version up; only the implemented class can be allowed.
  const automatic = runPolicySetup({ action: 'create', input: { policyId: 'policy-house', mode: 'automatic', actor: { kind: 'agent', id: 'agent-synthetic' }, selector: { intersection: [{ repo: 'north' }, { type: 'md' }] }, maxBatchSize: 3, retryBudget: 1 }, workspace, repositoryRoots, now: NOW })
  assert.equal(automatic.ok, true)
  assert.deepEqual({ version: automatic.policy.version, classes: automatic.policy.allowedEditClasses, mode: automatic.policy.mode }, { version: 2, classes: ['body-replacement'], mode: 'automatic' })
  assert.equal(readMachineSettings(workspace).maintenanceMode, 'manual', 'installing a policy never switches the mode')
  assert.deepEqual(automatic.automaticApply, { authorized: false, reason: 'maintenance-mode-manual' })
  const stale = runPolicySetup({ action: 'create', input: { policyId: 'policy-house', version: 2, mode: 'automatic', actor, selector: { all: true } }, workspace, repositoryRoots, now: NOW })
  assert.deepEqual({ ok: stale.ok, code: stale.refusal.code }, { ok: false, code: 'policy-version-not-newer' })
  assert.equal(readInstalledApplyPolicy(workspace).digest, automatic.policy.digest, 'a refused create installs nothing')
  for (const [input, code] of [
    [{ policyId: 'policy-x', mode: 'automatic', actor, selector: { all: true }, allowedEditClasses: ['rename'] }, 'unimplemented-edit-class'],
    [{ policyId: 'policy-x', mode: 'automatic', actor, selector: { all: true }, allowedEditClasses: [] }, 'invalid-apply-policy'],
    [{ policyId: 'policy-x', mode: 'agentic', actor, selector: { all: true } }, 'invalid-apply-policy'],
    [{ policyId: 'policy-x', mode: 'automatic', actor: { kind: 'robot', id: 'r' }, selector: { all: true } }, 'invalid-apply-policy'],
    [{ policyId: 'policy-x', mode: 'automatic', actor, selector: { glob: '*' } }, 'invalid-apply-policy'],
    [{ policyId: 'policy-x', mode: 'automatic', actor, selector: { all: true }, maxBatchSize: 0 }, 'invalid-apply-policy'],
    [{ policyId: 'policy-x', mode: 'automatic', actor, selector: { all: true }, retryBudget: 99 }, 'invalid-apply-policy'],
  ]) {
    const result = runPolicySetup({ action: 'create', input, workspace, repositoryRoots, now: NOW })
    assert.deepEqual({ ok: result.ok, code: result.refusal.code }, { ok: false, code }, JSON.stringify(input))
  }
  assert.equal(runPolicySetup({ action: 'delete', workspace, repositoryRoots, now: NOW }).refusal.code, 'usage')
  assert.equal(refusalCode(() => buildApplyPolicy({ workspaceId: WORKSPACE_ID, policyId: 'p', mode: 'automatic', actor, selector: { all: true }, allowedEditClasses: ['body-replacement', 'rename'] })), 'unimplemented-edit-class')

  // Authorized once the person switches the mode; revoked durably afterwards.
  writeMachineSettings({ ...workspace, repositoryRoots, settings: { ...readMachineSettings(workspace), maintenanceMode: 'automatic', updatedAt: NOW } })
  assert.deepEqual(dispatchGate(workspace), { authorized: true, reason: 'apply-policy-active', policyDigest: automatic.policy.digest })
  const revoked = runPolicySetup({ action: 'revoke', workspace, repositoryRoots, now: '2026-01-05T10:01:00.000Z' })
  assert.deepEqual({ ok: revoked.ok, revoked: revoked.revoked, reason: revoked.reason, status: revoked.policy.status, mode: revoked.maintenanceMode }, { ok: true, revoked: true, reason: 'revoked', status: 'revoked', mode: 'manual' })
  assert.equal(readInstalledApplyPolicy(workspace).status, 'revoked', 'the stored policy says revoked')
  assert.equal(readMachineSettings(workspace).maintenanceMode, 'manual')
  assert.deepEqual(dispatchGate(workspace), { authorized: false, reason: 'maintenance-mode-manual', policyDigest: null })
  assert.deepEqual(authorizeAutomaticApply({ ...workspace, assumeAutomatic: true }), { authorized: false, reason: 'apply-policy-revoked', policy: null }, 'even if the mode were automatic, a revoked policy denies')
  assert.deepEqual(runPolicySetup({ action: 'revoke', workspace, repositoryRoots, now: NOW }).reason, 'already-revoked')
  assert.equal(runPolicySetup({ action: 'show', workspace }).policy.status, 'revoked')
})

// The engine's dispatch (AOP-1) reads authorization from disk immediately
// before every edit. A revocation that lands between two edits of one batch
// stops the second: nothing queued behind a revocation is applied.
test('revocation wins over a queued apply: the dispatch that follows a revocation never reaches the operation', async (t) => {
  const { workspace, repositoryRoots } = tempWorkspace(t, 'revoke')
  const actor = { kind: 'agent', id: 'agent-synthetic' }
  assert.equal(runPolicySetup({ action: 'create', input: { policyId: 'policy-auto', mode: 'automatic', actor, selector: { all: true }, maxBatchSize: 10, retryBudget: 2 }, workspace, repositoryRoots, now: NOW }).ok, true)
  writeMachineSettings({ ...workspace, repositoryRoots, settings: { ...readMachineSettings(workspace), maintenanceMode: 'automatic', updatedAt: NOW } })
  const edit = (suffix, observedAt) => ({
    editId: `edit-${suffix.repeat(32)}`, identity: { workspaceId: WORKSPACE_ID, repoId: 'north', nodeId: `n-${suffix}` }, scopeId: 'view-full', generationId: 'gen-1', path: `notes/${suffix}.md`,
    baseNoteDigest: sha(`base-${suffix}`), observedDigest: sha(`observed-${suffix}`), objectRef: `recovery/objects/${sha(`observed-${suffix}`).slice(7)}.bin`,
    observedAt, state: 'queued', attempts: 0, retryBudget: null, lastAttemptAt: null, lastResult: null, closedAt: null,
  })
  const edits = [edit('a', '2026-01-05T09:00:00.000Z'), edit('b', '2026-01-05T09:01:00.000Z')]
  const reached = []
  const applyOperation = {
    id: 'atelier.test-apply',
    async apply({ edit: dispatched, policyDigest }) {
      reached.push(dispatched.editId)
      // Somebody revokes while the first edit is being applied.
      runPolicySetup({ action: 'revoke', workspace, repositoryRoots, now: '2026-01-05T10:00:30.000Z' })
      return { status: 'applied', code: `applied-under-${policyDigest.slice(0, 15)}` }
    },
  }
  const outcome = await dispatchAutomaticApply({ edits, applyOperation, now: NOW, nowMs: Date.parse(NOW), retryIntervalMs: 0, authorize: () => authorizeAutomaticApply(workspace) })
  assert.deepEqual(reached, [`edit-${'a'.repeat(32)}`], 'the second edit is never dispatched')
  assert.equal(outcome.authorization, 'maintenance-mode-manual', 'the re-read before the second edit found the revocation')
  assert.deepEqual(outcome.edits.map((item) => item.state), ['applied', 'queued'])
  // And after a restart nothing is dispatched at all: the revocation is on disk.
  const later = await dispatchAutomaticApply({ edits: outcome.edits, applyOperation, now: NOW, nowMs: Date.parse(NOW), retryIntervalMs: 0, authorize: () => authorizeAutomaticApply(workspace) })
  assert.deepEqual({ reached: reached.length, dispatched: later.dispatched, authorization: later.authorization }, { reached: 1, dispatched: [], authorization: 'maintenance-mode-manual' })
  // Switching the mode back to automatic by hand does not resurrect a revoked policy.
  writeMachineSettings({ ...workspace, repositoryRoots, settings: { ...readMachineSettings(workspace), maintenanceMode: 'automatic', updatedAt: NOW } })
  const resumed = await dispatchAutomaticApply({ edits: outcome.edits, applyOperation, now: NOW, nowMs: Date.parse(NOW), retryIntervalMs: 0, authorize: () => authorizeAutomaticApply(workspace) })
  assert.deepEqual({ reached: reached.length, authorization: resumed.authorization }, { reached: 1, authorization: 'apply-policy-revoked' })
})

// ---------------------------------------------------------------------------
// 5. Conflict view
// ---------------------------------------------------------------------------

test('conflict view is a typed, sorted function of the object entries and the open edits', () => {
  const objects = [
    { repoId: 'south', nodeId: 'b', state: 'pending', sequence: 2, sourceDigest: sha('b'), scopes: ['view-full'], operations: [{ idempotencyKey: `op-${'1'.repeat(64)}`, kind: 'body-replacement', state: 'pending', reason: null, by: null }], leaseHeld: false, intentOutcomeUnknown: false },
    { repoId: 'north', nodeId: 'a', state: 'conflicted', sequence: 4, sourceDigest: null, scopes: ['view-full', 'view-north'], operations: [
      { idempotencyKey: `op-${'2'.repeat(64)}`, kind: 'body-replacement', state: 'conflicted', reason: 'divergent-edits', by: null },
      { idempotencyKey: `op-${'3'.repeat(64)}`, kind: 'body-replacement', state: 'conflicted', reason: 'divergent-edits', by: null },
      { idempotencyKey: `op-${'4'.repeat(64)}`, kind: 'body-replacement', state: 'superseded', reason: 'resolved', by: `op-${'2'.repeat(64)}` },
    ], leaseHeld: true, intentOutcomeUnknown: false },
    { repoId: 'west', nodeId: 'c', state: 'settled', sequence: 9, sourceDigest: sha('c'), scopes: ['view-full'], operations: [{ idempotencyKey: `op-${'5'.repeat(64)}`, kind: 'body-replacement', state: 'applied', reason: null, by: null }], leaseHeld: false, intentOutcomeUnknown: true },
    { repoId: null, nodeId: null, state: 'unreadable', code: 'object-identity-unknown' },
    { repoId: 'west', nodeId: 'z', state: 'mystery' },
  ]
  const edits = [
    { editId: `edit-${'a'.repeat(32)}`, identity: { workspaceId: WORKSPACE_ID, repoId: 'north', nodeId: 'a' }, scopeId: 'view-north', state: 'apply-failed', lastResult: { status: 'conflict', code: 'object-conflicted' } },
    { editId: `edit-${'b'.repeat(32)}`, identity: { workspaceId: WORKSPACE_ID, repoId: 'north', nodeId: 'a' }, scopeId: 'view-full', state: 'queued', lastResult: null },
    { editId: `edit-${'c'.repeat(32)}`, identity: { workspaceId: WORKSPACE_ID, repoId: 'north', nodeId: 'a' }, scopeId: 'view-full', state: 'applied', lastResult: null },
  ]
  const view = conflictView({ objects, edits })
  assert.equal(view.schema, CONFLICT_VIEW_SCHEMA)
  assert.deepEqual(view.objects.map((item) => [item.repoId, item.nodeId, item.state, item.needsPerson]), [[null, null, 'unreadable', true], ['north', 'a', 'conflicted', true], ['south', 'b', 'pending', false], ['west', 'c', 'settled', true], ['west', 'z', 'unreadable', true]])
  const north = view.objects[1]
  assert.deepEqual(north.conflictedOperations, [`op-${'2'.repeat(64)}`, `op-${'3'.repeat(64)}`])
  assert.deepEqual(north.operations[2], { idempotencyKey: `op-${'4'.repeat(64)}`, kind: 'body-replacement', state: 'superseded', reason: 'resolved', by: `op-${'2'.repeat(64)}` })
  assert.deepEqual(north.pendingEdits, [{ editId: `edit-${'b'.repeat(32)}`, scopeId: 'view-full', state: 'queued', lastCode: null }, { editId: `edit-${'a'.repeat(32)}`, scopeId: 'view-north', state: 'apply-failed', lastCode: 'object-conflicted' }])
  assert.equal(north.leaseHeld, true)
  assert.match(north.next, /names every conflicted operation/)
  assert.match(view.objects[3].next, /outcome is not recorded/)
  assert.deepEqual(view.summary, { total: 5, byState: { conflicted: 1, pending: 1, settled: 1, empty: 0, inconsistent: 0, unreadable: 2 }, needsPerson: 4, openEdits: 2 })
  assert.equal(view.needsPerson, true)
  // Narrowed to one view: only that view's edits are attached.
  assert.deepEqual(conflictView({ objects, edits, scopeId: 'view-north' }).objects[1].pendingEdits.map((item) => item.editId), [`edit-${'a'.repeat(32)}`])
  assert.deepEqual(conflictView({ objects: [], edits: [] }), { schema: CONFLICT_VIEW_SCHEMA, scopeId: null, objects: [], summary: { total: 0, byState: Object.fromEntries(OBJECT_VIEW_STATES.map((state) => [state, 0])), needsPerson: 0, openEdits: 0 }, needsPerson: false })
  // No note text, title or path leaves the view.
  assert.ok(!JSON.stringify(view).includes('notes/'))
})

test('conflict view over the real arbitration record: two divergent edits of one object from two views are conflicted', (t) => {
  const { workspace, repositoryRoots } = tempWorkspace(t, 'arbitration')
  const clock = () => new Date(NOW)
  const store = openObjectStore({ stateRoot: workspace.workspaceRoot, workspaceId: WORKSPACE_ID, repositoryRoots, clock })
  const base = sha('source-as-generated')
  const operation = (editId, observed, next, scopeId) => ({
    schema: 'atelier-obsidian-edit-operation/v1', editId, workspaceId: WORKSPACE_ID, repoId: 'north', nodeId: 'a', origin: { scopeId, generationId: 'gen-0001' }, kind: 'body-replacement',
    baseSourceDigest: base, observed: { digest: sha(observed), byteLength: 40, recoveryRef: `recovery/objects/${sha(observed).slice(7)}.bin` },
    idempotencyKey: editIdempotencyKey({ workspaceId: WORKSPACE_ID, repoId: 'north', nodeId: 'a', baseSourceDigest: base, observedDigest: sha(observed) }),
    state: 'pending', observedAt: NOW, ext: { [OBSIDIAN_EXT_KEY]: { result: { newSourceDigest: sha(next), newByteLength: 41 } } },
  })
  assert.equal(store.observe(operation('edit-one', 'typed in the full view', 'source one', 'view-full')).object.state, 'pending')
  // The same bytes from another view coalesce: still one pending operation.
  assert.equal(store.observe(operation('edit-two', 'typed in the full view', 'source one', 'view-north')).object.state, 'pending')
  assert.equal(readConflictView({ ...workspace, repositoryRoots, clock }).objects[0].state, 'pending')
  assert.equal(store.observe(operation('edit-three', 'typed differently', 'source two', 'view-north')).object.state, 'conflicted')
  const sequenceBefore = store.stateOf({ repoId: 'north', nodeId: 'a' }).sequence
  const view = readConflictView({ ...workspace, repositoryRoots, clock })
  assert.deepEqual(view.objects.map((item) => [item.repoId, item.nodeId, item.state, item.needsPerson, item.operations.map((operation) => [operation.state, operation.reason])]), [['north', 'a', 'conflicted', true, [['conflicted', 'divergent-edits'], ['conflicted', 'divergent-edits']]]])
  assert.equal(view.objects[0].conflictedOperations.length, 2)
  assert.deepEqual({ needsPerson: view.needsPerson, foreign: view.foreign, byState: view.summary.byState.conflicted }, { needsPerson: true, foreign: 0, byState: 1 })
  assert.deepEqual(readConflictView({ ...workspace, repositoryRoots, clock, scopeId: 'view-elsewhere' }).objects, [], 'an object no such view edited is not listed for it')
  // The view read nothing into the source and wrote no event: the object log is as the observer left it.
  assert.equal(store.stateOf({ repoId: 'north', nodeId: 'a' }).sequence, sequenceBefore)
})

// ---------------------------------------------------------------------------
// 6. Receipt validation: schema validation only
// ---------------------------------------------------------------------------

const fixture = (gate) => readJson(path.join(FIXTURES, `${gate}.valid.v1.json`))
const withExt = (receipt, change) => { const copy = structuredClone(receipt); change(copy, copy.ext[RECEIPT_EXT_KEY]); return copy }

test('every owned gate has a valid synthetic receipt fixture, and validating it closes nothing', () => {
  assert.deepEqual(RECEIPT_GATE_IDS, ['G07', 'G13', 'G14', 'G15', 'G16', 'G17', 'G18'])
  assert.deepEqual(fs.readdirSync(FIXTURES).sort(), RECEIPT_GATE_IDS.map((gate) => `${gate}.valid.v1.json`))
  for (const gate of RECEIPT_GATE_IDS) {
    const receipt = fixture(gate)
    assert.deepEqual(validateObsidianContract('acceptance-receipt', receipt), [], gate)
    const result = validateAcceptanceReceipt(receipt, { gate })
    assert.deepEqual({ label: result.label, gate: result.gate, schemaValid: result.schemaValid, requirementsMet: result.requirementsMet, valid: result.valid, gateClosed: result.gateClosed, closes: result.closes, missing: result.missing, outcome: result.outcome, evidenceType: result.evidenceType },
      { label: RECEIPT_VALIDATION_LABEL, gate, schemaValid: true, requirementsMet: true, valid: true, gateClosed: false, closes: 'nothing', missing: [], outcome: 'passed', evidenceType: RECEIPT_GATES[gate].evidenceType }, gate)
    assert.match(result.note, /closes no gate/)
    // Without naming the gate, the receipt's own gate is checked.
    assert.equal(validateAcceptanceReceipt(receipt).valid, true)
    // The synthetic fixture names no real host, person or machine path. The extension key is the one registered name it must carry.
    assert.doesNotMatch(JSON.stringify(receipt).replaceAll(RECEIPT_EXT_KEY, ''), /mnstry|\.local|\/Users\/|C:\\/i, gate)
  }
})

test('the receipt field table is pinned per gate', () => {
  const table = Object.fromEntries(RECEIPT_GATE_IDS.map((gate) => [gate, receiptRequirementsFor(gate)]))
  const always = ['candidate.commit', 'candidate.treeDigest', 'environment.os.{name,version}', 'environment.app.{name,version}', 'environment.cli.version', 'evidence[].{name,digest,byteLength>0}', `ext.${RECEIPT_EXT_KEY}.host.id`, `ext.${RECEIPT_EXT_KEY}.operator.id`]
  assert.deepEqual(table, {
    G07: { gate: 'G07', procedure: 'AP-01', evidenceType: 'real-app', always, evidenceRoles: ['cli-link-inspection', 'app-observation'], acceptance: 'human', wallClock: false, dataset: false, tarballDigest: false },
    G13: { gate: 'G13', procedure: 'AP-02', evidenceType: 'real-app', always, evidenceRoles: ['on-disk-membership', 'app-index-membership', 'graph-filter-observation'], acceptance: 'human', wallClock: false, dataset: false, tarballDigest: false },
    G14: { gate: 'G14', procedure: 'AP-03', evidenceType: 'host', always, evidenceRoles: ['source-refresh-trace', 'dropped-event-recovery', 'sleep-wake-clock'], acceptance: null, wallClock: true, dataset: false, tarballDigest: false },
    G15: { gate: 'G15', procedure: 'AP-03', evidenceType: 'host', always, evidenceRoles: ['ownership-health', 'terminal-closure'], acceptance: null, wallClock: true, dataset: false, tarballDigest: false },
    G16: { gate: 'G16', procedure: 'AP-04', evidenceType: 'real-app', always, evidenceRoles: ['dataset-manifest', 'resource-samples', 'app-indexing-timings', 'warm-update-latencies'], acceptance: null, wallClock: true, dataset: true, tarballDigest: false },
    G17: { gate: 'G17', procedure: 'AP-05', evidenceType: 'real-app', always, evidenceRoles: ['multi-vault-edit-trace', 'manual-apply-trace', 'automatic-apply-trace', 'uninstall-retention'], acceptance: 'human', wallClock: false, dataset: false, tarballDigest: false },
    G18: { gate: 'G18', procedure: 'AP-06', evidenceType: 'human', always, evidenceRoles: ['tarball-audit', 'adopter-acceptance'], acceptance: 'adopter', wallClock: false, dataset: false, tarballDigest: true },
  })
  assert.equal(receiptRequirementsFor('G02'), null)
})

// Each negative names the one rule it is sensitive to. The mutation control
// below switches that rule off and proves the negative then passes.
const NEGATIVES = [
  { name: 'gate mismatch', gate: 'G07', rule: 'gate', code: 'gate-mismatch', change: (receipt) => { receipt.gate = 'G13' } },
  { name: 'procedure of another gate', gate: 'G13', rule: 'procedure', code: 'procedure-mismatch', change: (receipt) => { receipt.procedureId = 'AP-01' } },
  { name: 'procedure variant is fine, an unrelated id is not', gate: 'G13', rule: 'procedure', code: 'procedure-mismatch', change: (receipt) => { receipt.procedureId = 'AP-020' } },
  { name: 'node evidence for a real-app gate', gate: 'G07', rule: 'evidenceType', code: 'evidence-type-mismatch', change: (receipt) => { receipt.evidenceType = 'node' } },
  { name: 'real-app evidence for a host gate', gate: 'G14', rule: 'evidenceType', code: 'evidence-type-mismatch', change: (receipt) => { receipt.evidenceType = 'real-app' } },
  { name: 'app version placeholder', gate: 'G07', rule: 'versionPins', code: 'version-not-pinned', change: (receipt) => { receipt.environment.app.version = 'latest' } },
  { name: 'cli version unknown', gate: 'G13', rule: 'versionPins', code: 'version-not-pinned', change: (receipt) => { receipt.environment.cli.version = 'unknown' } },
  { name: 'os version blank', gate: 'G15', rule: 'versionPins', code: 'version-not-pinned', change: (receipt) => { receipt.environment.os.version = ' ' } },
  { name: 'candidate commit placeholder', gate: 'G17', rule: 'candidateIdentity', code: 'candidate-not-pinned', change: (receipt) => { receipt.candidate.commit = '0'.repeat(40) } },
  { name: 'tarball digest missing for the release gate', gate: 'G18', rule: 'candidateIdentity', code: 'candidate-not-pinned', change: (receipt) => { delete receipt.candidate.tarballDigest } },
  { name: 'host identity missing', gate: 'G14', rule: 'hostIdentity', code: 'host-identity-missing', change: (receipt, ext) => { delete ext.host } },
  { name: 'operator identity missing', gate: 'G16', rule: 'hostIdentity', code: 'operator-identity-missing', change: (receipt, ext) => { delete ext.operator } },
  { name: 'evidence role missing', gate: 'G07', rule: 'evidenceHashes', code: 'evidence-role-missing', change: (receipt, ext) => { delete ext.evidenceRoles['cli-link-inspection'] } },
  { name: 'evidence role names an entry that is not there', gate: 'G13', rule: 'evidenceHashes', code: 'evidence-role-missing', change: (receipt, ext) => { ext.evidenceRoles['app-index-membership'] = 'elsewhere.txt' } },
  { name: 'evidence role unknown to the gate', gate: 'G15', rule: 'evidenceHashes', code: 'evidence-role-unknown', change: (receipt, ext) => { ext.evidenceRoles['sleep-wake-clock'] = 'ownership-health.txt' } },
  { name: 'empty evidence file', gate: 'G17', rule: 'evidenceHashes', code: 'evidence-not-hashed', change: (receipt) => { receipt.evidence[0].byteLength = 0 } },
  { name: 'human acceptance missing', gate: 'G07', rule: 'acceptance', code: 'acceptance-missing', change: (receipt, ext) => { delete ext.acceptance } },
  { name: 'adopter acceptance missing', gate: 'G18', rule: 'acceptance', code: 'acceptance-missing', change: (receipt, ext) => { delete ext.acceptance } },
  { name: 'adopter acceptance given by the operator', gate: 'G18', rule: 'acceptance', code: 'acceptance-not-separate', change: (receipt, ext) => { ext.acceptance.actor = ext.operator.id } },
  { name: 'human acceptance where an adopter is needed', gate: 'G18', rule: 'acceptance', code: 'acceptance-kind-mismatch', change: (receipt, ext) => { ext.acceptance.kind = 'human' } },
  { name: 'acceptance names no evidence of its own', gate: 'G17', rule: 'acceptance', code: 'acceptance-missing', change: (receipt, ext) => { ext.acceptance.evidenceName = 'nowhere.txt' } },
  { name: 'acceptance where the gate records host evidence', gate: 'G14', rule: 'acceptance', code: 'acceptance-not-expected', change: (receipt, ext) => { ext.acceptance = { kind: 'human', actor: 'reviewer-synthetic', recordedAt: '2026-02-01T12:30:00Z', evidenceName: 'sleep-wake-clock.txt' } } },
  { name: 'wall clock missing', gate: 'G14', rule: 'wallClock', code: 'wall-clock-missing', change: (receipt, ext) => { delete ext.wallClock } },
  { name: 'wall clock runs backwards', gate: 'G15', rule: 'wallClock', code: 'wall-clock-missing', change: (receipt, ext) => { ext.wallClock.endedAt = '2026-02-01T10:00:00Z' } },
  { name: 'dataset missing', gate: 'G16', rule: 'dataset', code: 'dataset-missing', change: (receipt, ext) => { delete ext.dataset } },
  { name: 'dataset without a fixture digest', gate: 'G16', rule: 'dataset', code: 'dataset-missing', change: (receipt, ext) => { delete ext.dataset.fixtureDigest } },
]

test('receipt negatives per gate: each is rejected for exactly its reason, and never as gate closed', () => {
  for (const item of NEGATIVES) {
    const receipt = withExt(fixture(item.gate), item.change)
    const result = validateAcceptanceReceipt(receipt, { gate: item.gate })
    assert.deepEqual({ schemaValid: result.schemaValid, valid: result.valid, gateClosed: result.gateClosed, codes: [...new Set(result.missing.map((entry) => entry.code))] }, { schemaValid: true, valid: false, gateClosed: false, codes: [item.code] }, item.name)
    for (const entry of result.missing) assert.match(entry.pointer, /^\//, item.name)
  }
  // Procedure variants are accepted; a bare name of another procedure is not.
  assert.equal(validateAcceptanceReceipt(withExt(fixture('G13'), (receipt) => { receipt.procedureId = 'AP-02:run-3' }), { gate: 'G13' }).valid, true)
  // The extension is a closed shape.
  const extra = validateAcceptanceReceipt(withExt(fixture('G07'), (receipt, ext) => { ext.screenshots = 4 }), { gate: 'G07' })
  assert.deepEqual(extra.missing.map((entry) => entry.code), ['extension-key-unknown'])
  const none = validateAcceptanceReceipt(withExt(fixture('G07'), (receipt) => { delete receipt.ext }), { gate: 'G07' })
  assert.ok(none.missing.some((entry) => entry.code === 'extension-missing') && none.missing.some((entry) => entry.code === 'host-identity-missing') && none.missing.some((entry) => entry.code === 'acceptance-missing'))
  assert.equal(none.schemaValid, true, 'schema-valid and still not a receipt of this gate')
})

test('a schema-invalid receipt, an unowned gate and a non-object are refused before any rule runs', () => {
  const broken = fixture('G07')
  delete broken.environment
  const result = validateAcceptanceReceipt(broken, { gate: 'G07' })
  assert.deepEqual({ schemaValid: result.schemaValid, valid: result.valid, gateClosed: result.gateClosed, outcome: result.outcome }, { schemaValid: false, valid: false, gateClosed: false, outcome: null })
  assert.ok(result.missing.some((entry) => entry.code === 'schema-violation'))
  const g02 = readJson(path.join(CORPUS_ROOT, 'fixtures/obsidian/contracts/acceptance-receipt/valid/node-gate.v1.json'))
  assert.deepEqual(validateObsidianContract('acceptance-receipt', g02), [])
  assert.deepEqual(validateAcceptanceReceipt(g02).missing.map((entry) => entry.code), ['gate-not-owned'])
  assert.deepEqual(validateAcceptanceReceipt(g02, { gate: 'G07' }).missing.map((entry) => entry.code), ['gate-mismatch'].concat(validateAcceptanceReceipt(g02, { gate: 'G07' }).missing.map((entry) => entry.code).slice(1)))
  assert.equal(validateAcceptanceReceipt(g02, { gate: 'G07' }).valid, false)
  for (const value of [null, 'receipt', 42, []]) assert.equal(validateAcceptanceReceipt(value, { gate: 'G07' }).valid, false)
  assert.equal(validateAcceptanceReceipt(null).missing[0].code, 'gate-not-owned')
})

test('a failed or blocked receipt is a valid receipt of its outcome; validity is not a pass', () => {
  for (const outcome of ['failed', 'blocked']) {
    const result = validateAcceptanceReceipt(withExt(fixture('G13'), (receipt) => { receipt.outcome = outcome }), { gate: 'G13' })
    assert.deepEqual({ valid: result.valid, outcome: result.outcome, gateClosed: result.gateClosed }, { valid: true, outcome, gateClosed: false })
  }
})

test('mutation control: a validator that ignores a required field accepts the receipt that lacks it', () => {
  for (const rule of Object.keys(RECEIPT_RULES)) {
    const blind = createReceiptValidatorForOracleTests({ [rule]: () => [] })
    const sensitive = NEGATIVES.filter((item) => item.rule === rule)
    assert.ok(sensitive.length > 0, `a negative case exercises ${rule}`)
    for (const item of sensitive) {
      const receipt = withExt(fixture(item.gate), item.change)
      assert.equal(validateAcceptanceReceipt(receipt, { gate: item.gate }).valid, false, `${item.name}: the real validator rejects`)
      assert.equal(blind(receipt, { gate: item.gate }).valid, true, `${item.name}: a validator blind to ${rule} accepts`)
      assert.equal(blind(receipt, { gate: item.gate }).gateClosed, false, 'and even that closes nothing')
    }
  }
})

// ---------------------------------------------------------------------------
// 7. Through the command: the contribution registered on AOP-1's operations
// ---------------------------------------------------------------------------

const EXT = OBSIDIAN_EXT_KEY
const note = ({ id, title, body }) => `---\ntitle: "${title}"\nkg:\n  id: "${id}"\n  type: "document"\n  status: "active"\n  audience: "team"\n---\n\n# ${title}\n\n${body}\n`
const FILES = {
  'harbor/notes/quay.md': note({ id: 'harbor:quay', title: 'Quay ledger', body: 'Boats moor at dawn. See the [beacon](beacon.md).' }),
  'harbor/notes/beacon.md': note({ id: 'harbor:beacon', title: 'Beacon "north" side', body: 'The beacon blinks twice.' }),
  'orchard/rows/apple.md': note({ id: 'orchard:apple', title: 'Apple rows', body: 'Rows run east to west.' }),
}
const REPOSITORIES = ['harbor', 'orchard']
const SCOPES = [
  { scopeId: 'view-all', mode: 'full', selector: { all: true } },
  { scopeId: 'view-harbor', mode: 'scoped', selector: { repo: 'harbor' } },
  { scopeId: 'view-beacon', mode: 'focus', selector: { ids: ['harbor:quay', 'harbor:beacon'] } },
  { scopeId: 'view-nobody', mode: 'scoped', selector: { ids: ['harbor:nobody'] } },
  { scopeId: 'view-focus-nobody', mode: 'focus', selector: { ids: ['harbor:nobody'] } },
]
const UNREACHABLE = new Proxy({}, { get: (_target, name) => { throw new Error(`the seam ${String(name)} was reached`) } })
const UNREACHABLE_SEAMS = { appProbe: UNREACHABLE, launcher: UNREACHABLE, service: { entryPath: path.join(REPOSITORY_ROOT, 'test', 'support', 'obsidian-maintenance', 'service-entry.mjs') } }

function makeWorld(t) {
  const dir = tempDir(t, 'command')
  const projectDir = path.join(dir, 'project')
  const dataRoot = path.join(dir, 'data')
  for (const [relative, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(projectDir, relative)), { recursive: true })
    fs.writeFileSync(path.join(projectDir, relative), content)
  }
  for (const name of REPOSITORIES) fs.mkdirSync(path.join(projectDir, name, '.git'), { recursive: true })
  const configPath = path.join(projectDir, 'atelier.project.json')
  writeJson(configPath, {
    schema: 'mnstry.atelier-project-config@v1', name: 'selection-fixture', roots: { workspace: '.', repoOps: '.' },
    graph: { repoAccessPath: 'repo-access.v1.json', outputPath: 'atelier-output/knowledge.graph.json' },
    projection: { outputRoot: 'atelier-output', readinessPath: 'atelier-output/atelier-readiness.json' },
    repos: REPOSITORIES.map((name) => ({ name, path: name, readBoundary: 'team' })),
    ext: { [EXT]: { schema: 'atelier-obsidian-ext-settings/v1', enabled: true, scopes: SCOPES, defaultScopeId: 'view-all' } },
  })
  writeJson(path.join(projectDir, 'repo-access.v1.json'), { schema: 'mnstry.atelier-repo-access@v1', defaultReadBoundary: 'team', repos: Object.fromEntries(REPOSITORIES.map((name) => [name, { readBoundary: 'team' }])) })
  const { MNSTRY_ATELIER_PROJECT_CONFIG: _config, MNSTRY_ATELIER_LOCAL_CONFIG: _overlay, ...env } = process.env
  const loadProject = () => resolveProjectConfig({ argv: [`--project=${configPath}`], cwd: projectDir, env, writeLocalState: false })
  const project = loadProject()
  const pointer = ensureWorkspaceIdentity({ project, randomBytes: fixedRandom })
  const workspaceRoot = workspaceStateRoot(dataRoot, pointer.workspaceId)
  const workspace = { workspaceRoot, workspaceId: pointer.workspaceId }
  const repositoryRoots = protectedRoots(project)
  writeMachineSettings({ ...workspace, repositoryRoots, settings: { ...defaultMachineSettings({ workspaceId: pointer.workspaceId, updatedAt: NOW }), audienceAllow: ['team'] } })
  const clock = () => new Date(NOW)
  return {
    dir, projectDir, dataRoot, configPath, workspace: { ...workspace, workspaceRoot: fs.realpathSync(workspaceRoot) }, repositoryRoots, clock,
    async run(argv) {
      const out = []
      const err = []
      const exit = await runObsidianCommandForOracleTests({
        argv: [...argv, '--json', `--project=${configPath}`, `--data-root=${dataRoot}`], seams: UNREACHABLE_SEAMS, env, cwd: projectDir, clock, contributions: [createSelectionContribution()], probeTimeoutMs: 500,
        stdout: (text) => out.push(text), stderr: (text) => err.push(text),
      }, {})
      const stdout = out.join('\n')
      return { exit, stdout, stderr: err.join('\n'), json: JSON.parse(stdout) }
    },
  }
}

test('selection through the command: resolve, persist, show and list bind the declared views to the canonical graph', async (t) => {
  const world = makeWorld(t)
  const status = await world.run(['status'])
  assert.equal(status.exit, EXIT.ok)
  assert.deepEqual(status.json.operations, [
    { name: 'apply-policy', summary: status.json.operations[0].summary }, { name: 'conflicts', summary: status.json.operations[1].summary }, { name: 'selection', summary: status.json.operations[2].summary },
  ])
  const full = await world.run(['selection', 'resolve', 'view-all'])
  assert.equal(full.exit, EXIT.ok, full.stdout)
  assert.deepEqual({ schema: full.json.schema, operation: full.json.operation, scopeId: full.json.scopeId, persisted: full.json.persisted }, { schema: COMMAND_SCHEMA, operation: 'selection', scopeId: 'view-all', persisted: false })
  assert.deepEqual(full.json.selection.nodes, ['harbor:beacon', 'harbor:quay', 'orchard:apple'])
  assert.deepEqual(full.json.selection.scope, { schema: 'atelier-obsidian-scope/v1', scopeId: 'view-all', mode: 'full', selector: { all: true } })
  assert.equal(full.json.selection.edges.length, 1, 'the derived link from the quay to the beacon')
  const harbor = await world.run(['selection', 'resolve', 'view-harbor'])
  assert.deepEqual({ nodes: harbor.json.selection.nodes, outside: harbor.json.selection.outsideSelectionEdges }, { nodes: ['harbor:beacon', 'harbor:quay'], outside: [] })

  const focus = await world.run(['selection', 'persist', 'view-beacon'])
  assert.equal(focus.exit, EXIT.ok, focus.stdout)
  assert.deepEqual({ persisted: focus.json.persisted, changed: focus.json.changed, file: focus.json.file }, { persisted: true, changed: true, file: 'state/selection/view-beacon.json' })
  const beaconPath = focus.json.selection.notePaths['harbor:beacon']
  assert.equal(beaconPath, 'harbor/notes/Beacon north side.md', 'the readable title drops the quote characters the filesystem rules remove')
  assert.equal(focus.json.selection.focus.query, `${pathTerm(beaconPath)} OR ${pathTerm(focus.json.selection.notePaths['harbor:quay'])}`)
  assert.deepEqual(focus.json.selection.vaultNodes, ['harbor:beacon', 'harbor:quay', 'orchard:apple'], 'a focus keeps the full vault')
  const shown = await world.run(['selection', 'show', 'view-beacon'])
  assert.deepEqual({ exit: shown.exit, persisted: shown.json.persisted, query: shown.json.selection.focus.query, mode: shown.json.selection.mode }, { exit: EXIT.ok, persisted: true, query: focus.json.selection.focus.query, mode: 'focus' })
  assert.deepEqual(readSelectionState({ ...world.workspace, scopeId: 'view-beacon' }), shown.json.selection)
  const unchanged = await world.run(['selection', 'persist', 'view-beacon'])
  assert.equal(unchanged.json.changed, false)
  const listed = await world.run(['selection', 'list'])
  assert.deepEqual(listed.json.selections.map((item) => [item.scopeId, item.mode]), [['view-beacon', 'focus']])
  const missing = await world.run(['selection', 'show', 'view-harbor'])
  assert.deepEqual({ exit: missing.exit, persisted: missing.json.persisted, selection: missing.json.selection }, { exit: EXIT.notSuccess, persisted: false, selection: null })
  // Nothing was written to any vault and no .obsidian/ file exists anywhere under the workspace.
  const found = []
  const walk = (directory) => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const full = path.join(directory, entry.name); if (entry.isDirectory()) walk(full); else found.push(path.relative(world.workspace.workspaceRoot, full).split(path.sep).join('/')) } }
  walk(world.workspace.workspaceRoot)
  assert.deepEqual(found.sort(), ['state/selection/view-beacon.json', 'state/settings/machine.json'])
})

test('selection refusals through the command are typed: unknown view, withheld members, empty focus, usage', async (t) => {
  const world = makeWorld(t)
  const unknown = await world.run(['selection', 'resolve', 'view-elsewhere'])
  assert.deepEqual({ exit: unknown.exit, code: unknown.json.error.code }, { exit: EXIT.refused, code: 'unknown-scope' })
  // An unresolved identity is reported without saying whether it is withheld or absent.
  const nobody = await world.run(['selection', 'resolve', 'view-nobody'])
  assert.deepEqual({ exit: nobody.exit, nodes: nobody.json.selection.nodes, empty: nobody.json.selection.empty, reason: nobody.json.selection.emptyReason, unresolved: nobody.json.selection.unresolvedIds }, { exit: EXIT.ok, nodes: [], empty: true, reason: 'no-visible-members', unresolved: ['harbor:nobody'] })
  const persistEmpty = await world.run(['selection', 'persist', 'view-nobody'])
  assert.deepEqual({ exit: persistEmpty.exit, code: persistEmpty.json.error.code }, { exit: EXIT.refused, code: 'selection-empty' })
  const persistNamed = await world.run(['selection', 'persist', 'view-nobody', 'allow-empty'])
  assert.deepEqual({ exit: persistNamed.exit, nodes: persistNamed.json.selection.nodes }, { exit: EXIT.ok, nodes: [] })
  const focusEmpty = await world.run(['selection', 'resolve', 'view-focus-nobody'])
  assert.deepEqual({ exit: focusEmpty.exit, code: focusEmpty.json.error.code }, { exit: EXIT.refused, code: 'focus-selection-empty' })
  const usage = await world.run(['selection', 'forget', 'view-all'])
  assert.deepEqual({ exit: usage.exit, code: usage.json.error.code }, { exit: EXIT.refused, code: 'usage' })
  assert.deepEqual((await world.run(['selection', 'resolve', 'view-all', 'allow-empty'])).json.error.code, 'usage')
  assert.deepEqual(guardErrors, [], 'nothing tried to start the app')
})

test('apply-policy and conflicts through the command: create, show, revoke and the empty conflict view', async (t) => {
  const world = makeWorld(t)
  const request = path.join(world.dir, 'policy-request.json')
  fs.writeFileSync(request, JSON.stringify({ policyId: 'policy-harbor', mode: 'automatic', actor: { kind: 'agent', id: 'agent-synthetic' }, selector: { repo: 'harbor' }, maxBatchSize: 2, retryBudget: 1 }))
  const created = await world.run(['apply-policy', 'create', request])
  assert.equal(created.exit, EXIT.ok, created.stdout)
  assert.deepEqual({ ok: created.json.ok, action: created.json.action, installed: created.json.installed, version: created.json.policy.version, mode: created.json.maintenanceMode, automatic: created.json.automaticApply }, { ok: true, action: 'create', installed: true, version: 1, mode: 'manual', automatic: { authorized: false, reason: 'maintenance-mode-manual' } })
  assert.deepEqual(readInstalledApplyPolicy(world.workspace), created.json.policy)
  // The built-in policy operation sees the same installed policy; the built-in mode switch can now go automatic.
  const builtIn = await world.run(['policy', 'show'])
  assert.deepEqual(builtIn.json.policy, created.json.policy)
  const mode = await world.run(['mode', 'set', 'automatic'])
  assert.equal(mode.exit, EXIT.ok, mode.stdout)
  const shown = await world.run(['apply-policy', 'show'])
  assert.deepEqual(shown.json.automaticApply, { authorized: true, reason: 'apply-policy-active' })
  const bad = path.join(world.dir, 'bad-request.json')
  fs.writeFileSync(bad, JSON.stringify({ policyId: 'policy-harbor', mode: 'automatic', actor: { kind: 'agent', id: 'agent-synthetic' }, selector: { repo: 'harbor' }, allowedEditClasses: ['rename'] }))
  const refused = await world.run(['apply-policy', 'create', bad])
  assert.deepEqual({ exit: refused.exit, ok: refused.json.ok, code: refused.json.refusal.code }, { exit: EXIT.notSuccess, ok: false, code: 'unimplemented-edit-class' })
  assert.equal(readInstalledApplyPolicy(world.workspace).version, 1)
  const revoked = await world.run(['apply-policy', 'revoke'])
  assert.deepEqual({ exit: revoked.exit, revoked: revoked.json.revoked, status: revoked.json.policy.status, mode: revoked.json.maintenanceMode, automatic: revoked.json.automaticApply }, { exit: EXIT.ok, revoked: true, status: 'revoked', mode: 'manual', automatic: { authorized: false, reason: 'maintenance-mode-manual' } })
  assert.equal(readMachineSettings(world.workspace).maintenanceMode, 'manual')
  assert.deepEqual((await world.run(['apply-policy', 'create'])).json.error.code, 'usage')
  assert.deepEqual((await world.run(['apply-policy', 'create', path.join(world.dir, 'absent.json')])).json.error.code, 'invalid-apply-policy')
  const conflicts = await world.run(['conflicts'])
  assert.deepEqual({ exit: conflicts.exit, schema: conflicts.json.schema, objects: conflicts.json.objects, needsPerson: conflicts.json.needsPerson }, { exit: EXIT.ok, schema: CONFLICT_VIEW_SCHEMA, objects: [], needsPerson: false })
  const narrowed = await world.run(['conflicts', 'view-harbor'])
  assert.deepEqual({ scopeId: narrowed.json.scopeId, objects: narrowed.json.objects }, { scopeId: 'view-harbor', objects: [] })
  assert.equal((await world.run(['conflicts', 'view-elsewhere'])).json.error.code, 'unknown-scope')
  assert.deepEqual(guardErrors, [], 'nothing tried to start the app')
})

// ---------------------------------------------------------------------------
// 7. AOP-4 phase 2 proof tooling: scale generator, measurement helpers,
// desktop planner and runners against a fake instance, receipt writer,
// signer and verifier. Nothing here starts the app; the fake instance answers
// scripted text and the spawn guard stays silent.
// ---------------------------------------------------------------------------

const TINY_FIXTURE_DIGEST = 'sha256:f29cd4f5f97f7e01958125af2d94fc75775b8d4880b94c91b2614abf60a804a3'
const CANDIDATE = { commit: '1'.repeat(40), treeDigest: `sha256:${'2'.repeat(64)}`, ext: { dirty: false } }
const CAPABILITIES = { discoveredAt: NOW, qualified: true, app: { name: 'Obsidian', version: '1.13.7', installerVersion: '1.12.7', raw: 'Obsidian 1.13.7 (installer 1.12.7)' }, cli: { version: 'Obsidian 1.13.7 (installer 1.12.7)', commands: { vaults: true, eval: true, links: true, backlinks: true, unresolved: true } }, lastSavedData: { present: true }, errors: [] }
const WALL = { startedAt: '2026-01-05T10:00:00.000Z', endedAt: '2026-01-05T10:20:00.000Z' }
const HOST = { id: 'host-synthetic-desk-02' }

// A scripted instance: `answers` maps a substring of the CLI arguments to the
// text the CLI would print. `eval` scripts are matched by their probe text.
function fakeInstance(t, { vaults, home, answers = {} } = {}) {
  const root = tempDir(t, 'instance')
  const layout = { root, home: home ?? path.join(root, 'home'), profile: path.join(root, 'profile'), vault: path.join(root, 'vault') }
  fs.mkdirSync(layout.vault, { recursive: true })
  const calls = []
  return {
    layout,
    env: { HOME: layout.home },
    calls,
    async cli(...args) {
      calls.push(args)
      const joined = args.join(' ')
      if (args[0] === 'vaults') return (vaults ?? [`atelierg00synthetic\t${layout.vault}`]).join('\n')
      for (const [needle, answer] of Object.entries(answers)) if (joined.includes(needle)) return typeof answer === 'function' ? answer(args) : answer
      throw new Error(`fake instance has no answer for ${joined.slice(0, 80)}`)
    },
  }
}

test('scale generator: same seed, same fixture digest; another seed differs; writes only outside repositories and fixtures', (t) => {
  const dir = tempDir(t, 'scale')
  const first = generateScaleDataset({ outDir: path.join(dir, 'a'), profile: 'tiny' })
  const second = generateScaleDataset({ outDir: path.join(dir, 'b'), profile: 'tiny', seed: DEFAULT_SEED })
  assert.equal(first.manifest.fixtureDigest, TINY_FIXTURE_DIGEST, 'the tiny profile digest is pinned')
  assert.equal(second.manifest.fixtureDigest, first.manifest.fixtureDigest)
  assert.deepEqual(first.manifest.counts, { nodes: 50, edges: 100, repositories: 2, files: 50, bytes: first.manifest.counts.bytes })
  assert.deepEqual({ schema: first.manifest.schema, generatorVersion: first.manifest.generatorVersion, seed: first.manifest.seed, profile: first.manifest.profile, derivation: first.manifest.derivation }, { schema: 'atelier-obsidian-scale-dataset/v1', generatorVersion: '1.0.0', seed: DEFAULT_SEED, profile: 'tiny', derivation: null })
  assert.notEqual(generateScaleDataset({ outDir: path.join(dir, 'c'), profile: 'tiny', seed: 7 }).manifest.fixtureDigest, TINY_FIXTURE_DIGEST)
  // Edge planning is exact: 100 declared relations over 50 nodes, none to self, none repeated.
  const plan = planDataset({ nodes: 50, edges: 100, repositories: 2 })
  const declared = plan.records.flatMap((record) => Object.values(record.relations).flat())
  assert.equal(declared.length, 100)
  assert.ok(plan.records.every((record) => new Set(Object.values(record.relations).flat()).size === Object.values(record.relations).flat().length && !Object.values(record.relations).flat().includes(record.nodeId)))
  assert.deepEqual(PROFILES.standard, { nodes: 10000, edges: 50000, repositories: 4 })
  assert.deepEqual(PROFILES.stress, { nodes: 100000, edges: 500000, repositories: 8 })
  // Refusals: inside this repository, under any fixtures path, inside another repository, a relative path, a non-empty target.
  const refusal = (options, code) => { try { generateScaleDataset(options) } catch (error) { assert.ok(error instanceof OutputRefusal, error.stack); return error.code } return null }
  assert.equal(refusal({ outDir: path.join(REPOSITORY_ROOT, '.artifacts', 'scale'), profile: 'tiny' }, 'output-inside-repository'), 'output-inside-repository')
  assert.equal(refusal({ outDir: path.join(dir, 'fixtures', 'scale'), profile: 'tiny' }, 'output-inside-fixtures'), 'output-inside-fixtures')
  fs.mkdirSync(path.join(dir, 'repo', '.git'), { recursive: true })
  assert.equal(repositoryContaining(path.join(dir, 'repo', 'deep', 'er')), path.join(dir, 'repo'))
  assert.equal(refusal({ outDir: path.join(dir, 'repo', 'deep'), profile: 'tiny' }, 'output-inside-repository'), 'output-inside-repository')
  assert.equal(refusal({ outDir: 'relative/scale', profile: 'tiny' }, 'output-not-absolute'), 'output-not-absolute')
  assert.equal(refusal({ outDir: path.join(dir, 'a'), profile: 'tiny' }, 'output-not-empty'), 'output-not-empty')
  assert.equal(refusal({ outDir: path.join(dir, 'd'), profile: 'huge' }, 'unknown-profile'), 'unknown-profile')
  assert.ok(!fs.existsSync(path.join(REPOSITORY_ROOT, '.artifacts', 'scale')), 'nothing was written inside the repository')
  assert.equal(assertExternalOutput(path.join(dir, 'ok')), path.join(dir, 'ok'))
  assert.deepEqual(guardErrors, [], 'nothing tried to start the app')
})

test('cold derivation of the tiny dataset: the real pipeline publishes every note into a temporary vault with no app', needsExchange, async (t) => {
  const dir = tempDir(t, 'derive')
  const { manifest } = generateScaleDataset({ outDir: path.join(dir, 'data'), profile: 'tiny' })
  const vaultRoot = path.join(dir, 'vault')
  const result = await deriveWorkspace({ projectFile: manifest.projectFile, stateRoot: path.join(dir, 'state'), vaultRoot })
  assert.deepEqual({ state: result.state, mode: result.mode, graph: result.graph, notes: result.manifest.notes.length }, { state: 'committed', mode: 'direct', graph: { nodes: 50, edges: 100 }, notes: 50 })
  assert.equal(result.manifest.links.length, 100, 'every declared relation is a manifest link')
  for (const key of ['loadProjectMs', 'buildGraphMs', 'captureSnapshotMs', 'prepareViewMs', 'publishViewMs', 'totalMs']) assert.ok(typeof result.timings[key] === 'number' && result.timings[key] >= 0, key)
  assert.ok(result.written.files >= 50 && result.written.bytes > 0)
  // Warm path: one source change, the same store, a replace of exactly that note.
  const source = fs.readdirSync(path.join(manifest.workspaceDir, 'scale-1', 'notes', '000')).sort()[0]
  fs.appendFileSync(path.join(manifest.workspaceDir, 'scale-1', 'notes', '000', source), '\nWarm change 1.\n')
  const warm = await deriveWorkspace({ projectFile: manifest.projectFile, stateRoot: path.join(dir, 'state'), vaultRoot })
  assert.deepEqual({ state: warm.state, expected: warm.expectedGeneration }, { state: 'committed', expected: result.generationId })
  const changed = warm.files.filter((file) => file.kind === 'note' && fs.readFileSync(path.join(vaultRoot, file.path), 'utf8').includes('Warm change 1.'))
  assert.equal(changed.length, 1)
  assert.deepEqual(guardErrors, [], 'nothing tried to start the app')
})

// The warm path the measurement records is the engine's: caches and an
// observation index carried between derivations. Its vault is byte-identical
// to the one bare production seams publish from nothing, and a source the
// observation index knows unchanged is not opened by the graph build.
test('warm derivation through the engine seams publishes the same bytes as the path from nothing, and opens only the changed source', needsExchange, async (t) => {
  const dir = tempDir(t, 'derive-engine')
  const { manifest } = generateScaleDataset({ outDir: path.join(dir, 'data'), profile: 'tiny' })
  const tree = (root) => { const found = {}; const walk = (directory) => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const full = path.join(directory, entry.name); if (entry.isDirectory()) walk(full); else found[path.relative(root, full).split(path.sep).join('/')] = fs.readFileSync(full).toString('hex') } }; walk(root); return found }
  const engine = createEngineSeams()
  const project = loadProject(manifest.projectFile)
  const vaults = { engine: path.join(dir, 'vault-engine'), plain: path.join(dir, 'vault-plain') }
  engine.observe(project, { full: true })
  const cold = await deriveWorkspace({ projectFile: manifest.projectFile, stateRoot: path.join(dir, 'state-engine'), vaultRoot: vaults.engine, seams: engine.seams })
  assert.equal(cold.state, 'committed')
  const source = path.join(manifest.workspaceDir, 'scale-1', 'notes', '000', fs.readdirSync(path.join(manifest.workspaceDir, 'scale-1', 'notes', '000')).sort()[0])
  fs.appendFileSync(source, '\nWarm change 1.\n')
  const observed = engine.observe(project, { full: false })
  assert.equal(observed.changes.length, 1, 'the stat hint sees the one edited source')
  const warm = await deriveWorkspace({ projectFile: manifest.projectFile, stateRoot: path.join(dir, 'state-engine'), vaultRoot: vaults.engine, seams: engine.seams })
  assert.deepEqual({ state: warm.state, expected: warm.expectedGeneration }, { state: 'committed', expected: cold.generationId })
  // From nothing, over the edited corpus, into a second vault.
  const plain = await deriveWorkspace({ projectFile: manifest.projectFile, stateRoot: path.join(dir, 'state-plain'), vaultRoot: vaults.plain })
  assert.equal(plain.state, 'committed')
  const [engineTree, plainTree] = [tree(vaults.engine), tree(vaults.plain)]
  for (const root of [engineTree, plainTree]) for (const key of Object.keys(root)) if (key.startsWith('.atelier-publication/')) delete root[key]
  assert.deepEqual(engineTree, plainTree, 'the vault bytes do not depend on the path taken')
  assert.deepEqual(warm.files.map((file) => [file.path, file.digest]).sort(), plain.files.map((file) => [file.path, file.digest]).sort())
  // The graph build behind the warm derivation opened only the edited source.
  const graph = engine.seams.buildGraph({ project, eligibility: (await import('../src/runtime/obsidian/pipeline.mjs')).DEFAULT_ELIGIBILITY })
  assert.equal(graph.fileCensus.read, 0, 'nothing changed since the last build, so no source is opened')
  fs.appendFileSync(source, '\nWarm change 2.\n')
  engine.observe(project, { full: false })
  assert.equal(engine.seams.buildGraph({ project, eligibility: (await import('../src/runtime/obsidian/pipeline.mjs')).DEFAULT_ELIGIBILITY }).fileCensus.read, 1)
  assert.deepEqual(guardErrors, [], 'nothing tried to start the app')
})

test('measureDerivation records the engine warm path: every sample finds its note, carries observeMs and names the path', needsExchange, async (t) => {
  const dir = tempDir(t, 'measure-engine')
  const { manifestPath } = generateScaleDataset({ outDir: path.join(dir, 'data'), profile: 'tiny' })
  const manifest = await measureDerivation({ manifestPath, warm: 2, sampleIntervalMs: 50 })
  assert.equal(manifest.derivation.warm.samples.length, 2)
  for (const sample of manifest.derivation.warm.samples) {
    assert.equal(sample.fileFound, true)
    assert.equal(sample.state, 'committed')
    assert.ok(typeof sample.sourceToFileMs === 'number' && sample.sourceToFileMs >= 0)
    assert.ok(typeof sample.timings.observeMs === 'number')
    assert.deepEqual(sample.observed, { changes: 1, hashed: 1 })
  }
  assert.match(manifest.derivation.warmPath, /observation index/)
  assert.deepEqual(guardErrors, [], 'nothing tried to start the app')
})

test('AP-04 measurement helpers: p95 pinned on a literal sample, file and app series independent, no app target substituted', () => {
  const sample = [120, 340, 90, 5000, 410, 260, 275, 310, 4900, 150]
  assert.equal(percentile(sample, 95), 5000, 'nearest rank: ceil(0.95 * 10) = 10th value')
  assert.equal(percentile(sample, 50), 275)
  assert.equal(percentile(sample, 0), 90)
  assert.equal(percentile([], 95), null)
  assert.equal(percentile(Array.from({ length: 30 }, (_, index) => index + 1), 95), 29, 'ceil(0.95 * 30) = 29th value')
  const changes = Array.from({ length: 30 }, (_, index) => ({ change: index + 1, sourceToFileMs: 100 + index * 10, sourceToAppMs: null }))
  const summary = warmChangeSummary(changes)
  assert.deepEqual({ count: summary.count, complete: summary.complete, file: summary.sourceToFile, app: summary.sourceToApp }, {
    count: 30, complete: true,
    file: { samples: 30, p50Ms: 240, p95Ms: 380, maxMs: 390, targetP95Ms: 5000, withinTarget: true, status: 'measured' },
    app: { samples: 0, p50Ms: null, p95Ms: null, maxMs: null, targetP95Ms: null, withinTarget: null, status: 'not-measured' },
  })
  const withApp = warmChangeSummary(changes.map((change) => ({ ...change, sourceToAppMs: 9000 })))
  assert.deepEqual({ fileP95: withApp.sourceToFile.p95Ms, appP95: withApp.sourceToApp.p95Ms, appWithin: withApp.sourceToApp.withinTarget }, { fileP95: 380, appP95: 9000, appWithin: null }, 'a slow app never fails the file target and has no substituted target')
  assert.deepEqual({ file: PROPOSED_TARGETS.fileUpdate.p95Ms, recovery: PROPOSED_TARGETS.droppedEventRecovery.maxMs, app: PROPOSED_TARGETS.appUsableOpen.budgetMs }, { file: 5000, recovery: 60000, app: null })
  assert.equal(warmChangeSummary(changes.slice(0, 12)).complete, false)
  // Resource sampler with an injected reader and clock.
  let tick = 0
  const timers = []
  const sampler = createResourceSampler({ intervalMs: 100, now: () => tick, read: () => ({ rssBytes: 1000 + tick, heapUsedBytes: 1, cpuUserMicros: tick * 2, cpuSystemMicros: tick }), setInterval: (callback) => { timers.push(callback); return 1 }, clearInterval: () => {} }).start()
  tick = 100; timers[0]()
  tick = 250; sampler.sample('phase')
  tick = 400
  const samples = sampler.stop()
  assert.deepEqual(samples.map(({ atMs, label, rssBytes }) => [atMs, label, rssBytes]), [[0, 'start', 1000], [100, null, 1100], [250, 'phase', 1250], [400, 'stop', 1400]])
  assert.deepEqual(sampler.summary(), { samples: 4, intervalMs: 100, rssPeakBytes: 1400, rssEndBytes: 1400, cpuUserMicros: 800, cpuSystemMicros: 400, wallMs: 400 })
})

test('waitUntil records a met condition and a timeout without throwing', async () => {
  let clock = 0
  let answers = 0
  const met = await waitUntil(async () => { answers += 1; return answers === 3 }, { timeoutMs: 1000, intervalMs: 10, now: () => clock, sleep: async () => { clock += 10 } })
  assert.deepEqual(met, { met: true, elapsedMs: 20, attempts: 3, error: null })
  const late = await waitUntil(async () => { throw new Error('not yet') }, { timeoutMs: 30, intervalMs: 10, now: () => clock, sleep: async () => { clock += 10 } })
  assert.deepEqual(late, { met: false, elapsedMs: 30, attempts: 4, error: 'not yet' })
})

test('desktop planner: every gate role is automated or an exact manual step; the plan closes nothing', () => {
  assert.deepEqual(PROCEDURE_IDS, ['AP-01', 'AP-02', 'AP-03', 'AP-04', 'AP-05'])
  const manual = {}
  for (const id of PROCEDURE_IDS) {
    const plan = planProcedure(id, { receiptDir: '/tmp/receipts', operator: 'op-synthetic', isolatedHome: '/tmp/iso/home', workspaceDir: '/tmp/ws' })
    assert.deepEqual({ gates: plan.gates, closes: plan.closes }, { gates: [...DESKTOP_PROCEDURES[id].gates], closes: false })
    manual[id] = plan.manualStepsRequired.map((step) => `${step.gate}:${step.role}`)
    for (const step of plan.manualStepsRequired) assert.ok(step.instructions.length > 0 && step.instructions.every((line) => !line.includes('<ISOLATED_HOME>') && !line.includes('<SYNTHETIC_WORKSPACE>') && !line.includes('<OPERATOR>')), 'placeholders are filled')
  }
  assert.deepEqual(manual, {
    'AP-01': ['G07:app-observation'],
    'AP-02': ['G13:graph-filter-observation'],
    'AP-03': ['G14:sleep-wake-clock'],
    'AP-04': [],
    'AP-05': [],
  })
  assert.deepEqual({ ap03: planProcedure('AP-03', {}).automatedRoles, ap05: planProcedure('AP-05', {}).automatedRoles }, {
    ap03: { G14: ['source-refresh-trace', 'dropped-event-recovery'], G15: ['ownership-health', 'terminal-closure'] },
    ap05: { G17: ['multi-vault-edit-trace', 'manual-apply-trace', 'automatic-apply-trace', 'uninstall-retention'] },
  })
  assert.deepEqual(planProcedure('AP-04', {}).receipts.map((item) => [item.gate, item.status]), [['G16', 'complete']])
  assert.deepEqual(planProcedure('AP-03', {}).receipts.map((item) => [item.gate, item.status]), [['G14', 'incomplete'], ['G15', 'complete']])
  assert.deepEqual(planProcedure('AP-05', {}).receipts.map((item) => [item.gate, item.status]), [['G17', 'complete']])
  const sleep = planProcedure('AP-03', { isolatedHome: '/tmp/iso/home', isolatedProfile: '/tmp/iso/profile', workspaceDir: '/tmp/ws', dataRoot: '/tmp/data', operator: 'op-x' }).manualStepsRequired.find((step) => step.role === 'sleep-wake-clock')
  assert.ok(sleep.instructions[0].includes('HOME=/tmp/iso/home /Applications/Obsidian.app/Contents/MacOS/Obsidian --user-data-dir=/tmp/iso/profile'), sleep.instructions[0])
  assert.ok(sleep.instructions[2].includes('HOME=/tmp/iso/home node bin/atelier.mjs obsidian service status --project /tmp/ws/atelier.project.json --data-root /tmp/data --json'), sleep.instructions[2])
  assert.ok(sleep.instructions.every((line) => !line.includes('<DATA_ROOT>') && !line.includes('<ISOLATED_PROFILE>')))
  assert.throws(() => planProcedure('AP-09'), (error) => error instanceof OutputRefusal && error.code === 'unknown-procedure')
})

test('desktop runner refuses anything but the isolated instance: two vaults, a foreign vault, a shared HOME', async (t) => {
  const refusal = async (instance, options) => { try { await assertIsolatedInstance(instance, options) } catch (error) { assert.ok(error instanceof IsolationRefusal, error.stack); return error.code } return null }
  const two = fakeInstance(t)
  two.cli = async () => `atelierg00synthetic\t${two.layout.vault}\nreal-vault\t${path.join(os.homedir(), 'Documents', 'Notes')}`
  assert.equal(await refusal(two), 'unexpected-vaults-visible')
  const foreign = fakeInstance(t, { vaults: ['other\t/somewhere/else/vault'] })
  assert.equal(await refusal(foreign), 'unexpected-vaults-visible')
  const shared = fakeInstance(t, { home: os.homedir() })
  assert.equal(await refusal(shared), 'instance-home-not-private')
  const elsewhere = fakeInstance(t)
  elsewhere.env = { HOME: elsewhere.layout.home }
  elsewhere.layout = { ...elsewhere.layout, home: path.join(tempDir(t, 'other'), 'home') }
  assert.equal(await refusal(elsewhere), 'instance-home-not-private')
  assert.equal(await refusal({}), 'instance-not-isolated')
  const good = fakeInstance(t)
  assert.deepEqual(await assertIsolatedInstance(good), { vaultRoot: good.layout.vault, vaultsOutput: `atelierg00synthetic\t${good.layout.vault}` })
  assert.deepEqual(guardErrors, [], 'nothing tried to start the app')
})

test('capability discovery records versions, CLI commands and lastSavedData from raw output; an unsupported CLI fails qualification', async (t) => {
  assert.deepEqual(parseVersionOutput('Obsidian 1.13.7 (installer 1.12.7)'), { appVersion: '1.13.7', installerVersion: '1.12.7' })
  assert.deepEqual(parseVersionOutput('garbage'), { appVersion: null, installerVersion: null })
  const help = 'Commands:\n  vaults [verbose]\n  eval code=...\n  links file=...\n  backlinks file=...\n  unresolved\n  dev:cdp method=...\n  version\n  help\n'
  assert.deepEqual(parseHelpOutput(help), { version: true, help: true, vaults: true, eval: true, links: true, backlinks: true, unresolved: true, file: true, 'dev:cdp': true })
  const qualified = fakeInstance(t, { answers: { version: 'Obsidian 1.13.7 (installer 1.12.7)', help, 'openFile': '=> ok', 'lastSavedData': '=> {"views":[{"path":"notes/a.md","hasLastSavedData":true}]}', 'detach': '=> ok' } })
  const record = await discoverCapabilities(qualified, { now: () => NOW })
  assert.deepEqual({ qualified: record.qualified, app: record.app.version, installer: record.app.installerVersion, cli: record.cli.version, last: record.lastSavedData.present, errors: record.errors }, { qualified: true, app: '1.13.7', installer: '1.12.7', cli: 'Obsidian 1.13.7 (installer 1.12.7)', last: true, errors: [] })
  const unsupported = fakeInstance(t, { answers: { version: 'Obsidian 1.13.7 (installer 1.12.7)', help: 'Commands:\n  vaults\n  eval\n', 'openFile': '=> ok', 'lastSavedData': '=> {"views":[{"path":"notes/a.md","hasLastSavedData":false}]}', 'detach': '=> ok' } })
  const failed = await discoverCapabilities(unsupported, { now: () => NOW })
  assert.deepEqual({ qualified: failed.qualified, links: failed.cli.commands.links, last: failed.lastSavedData.present }, { qualified: false, links: false, last: false })
  assert.deepEqual(guardErrors, [], 'nothing tried to start the app')
})

test('AP-01 and AP-02 runners record raw app output and compare it with the generation manifest through a fake instance', needsExchange, async (t) => {
  const dir = tempDir(t, 'ap01')
  const { materializeFixtureWorkspace } = await import('../scripts/obsidian/lib/derive.mjs')
  const fixture = materializeFixtureWorkspace(path.join(dir, 'workspace'))
  const vaultRoot = path.join(dir, 'vault')
  const derived = await deriveWorkspace({ projectFile: fixture.projectFile, stateRoot: path.join(dir, 'state'), vaultRoot })
  assert.equal(derived.state, 'committed')
  const expected = expectedLinkPairs(derived.manifest)
  assert.ok(expected.length > 0)
  const resolved = {}
  for (const pair of expected) { const [source, target] = pair.split(' -> '); (resolved[source] ??= {})[target] = 1 }
  const instance = fakeInstance(t, { answers: {
    'metadataCache.initialized': '=> true',
    'resolvedLinks': `=> ${JSON.stringify({ resolved, unresolved: {} })}`,
    'getMarkdownFiles().map': `=> ${JSON.stringify(derived.manifest.notes.map((note) => note.path).sort())}`,
    unresolved: 'no unresolved links',
    links: (args) => `links of ${args[1]}`,
    backlinks: (args) => `backlinks of ${args[1]}`,
  } })
  const run = await runAp01({ instance, manifest: derived.manifest })
  assert.deepEqual({ passed: run.passed, roles: run.evidence.map((item) => item.role), matches: run.comparison.matches, missing: run.comparison.missing, unexpected: run.comparison.unexpected }, { passed: true, roles: ['cli-link-inspection'], matches: true, missing: [], unexpected: [] })
  const raw = run.evidence[0].bytes.toString('utf8')
  assert.ok(raw.includes('indexReady: true') && raw.includes('## obsidian-cli unresolved\nno unresolved links') && raw.includes('## obsidian-cli backlinks file=') && raw.includes('links of file='))
  // A destination the app did not resolve is a recorded mismatch, never averaged away.
  const short = compareResolvedLinks({ resolved: {}, expected })
  assert.deepEqual({ matches: short.matches, missing: short.missing.length, resolved: short.resolved }, { matches: false, missing: expected.length, resolved: 0 })
  const membership = await runAp02Membership({ instance, label: 'full', vaultRoot, manifest: derived.manifest })
  assert.deepEqual({ passed: membership.passed, disk: membership.disk.matches, app: membership.app.matches, expected: membership.expected.length }, { passed: true, disk: true, app: true, expected: derived.manifest.notes.length })
  assert.deepEqual(compareMembership(['a.md', 'b.md'], ['b.md', 'c.md']), { actual: 2, expected: 2, missing: ['c.md'], unexpected: ['a.md'], matches: false })
  assert.deepEqual(guardErrors, [], 'nothing tried to start the app')
})

test('AP-04 app runner measures usable-open, indexing and source-to-file/source-to-app independently through a fake instance', async (t) => {
  const dir = tempDir(t, 'ap04')
  const workspaceDir = path.join(dir, 'workspace')
  const vaultRoot = path.join(dir, 'vault')
  fs.mkdirSync(workspaceDir, { recursive: true })
  fs.mkdirSync(vaultRoot, { recursive: true })
  fs.writeFileSync(path.join(workspaceDir, 'note.md'), '# Note\n')
  let appSees = true
  const instance = fakeInstance(t, { answers: { 'layoutReady': '=> true', 'metadataCache.initialized': '=> true', 'adapter.read': () => (appSees ? '=> true' : '=> false') } })
  // The fake derivation copies the edited source into the vault, as the pipeline would.
  const derive = async () => { fs.writeFileSync(path.join(vaultRoot, 'note.md'), fs.readFileSync(path.join(workspaceDir, 'note.md'))); return { state: 'committed', mode: 'in-app', files: [{ kind: 'note', path: 'note.md' }], store: { vaultRoot } } }
  const run = await runAp04App({ instance, launchedAtMs: Date.now() - 50, scaleManifest: { workspaceDir }, derive, warm: 3, sampleAppRss: async () => 4096, random: () => 0 })
  assert.deepEqual({ passed: run.passed, count: run.summary.count, complete: run.summary.complete, fileStatus: run.summary.sourceToFile.status, appStatus: run.summary.sourceToApp.status, budget: run.timings.budget.budgetMs }, { passed: true, count: 3, complete: true, fileStatus: 'measured', appStatus: 'measured', budget: null })
  assert.ok(run.timings.usableOpen.met && run.timings.appIndexing.met && run.timings.usableOpen.sinceLaunchMs >= 50)
  assert.ok(run.samples.every((sample) => sample.sourceToFileMs !== null && sample.sourceToAppMs !== null && sample.sourceToAppMs >= sample.sourceToFileMs))
  assert.deepEqual(run.appSamples.map((sample) => sample.label), ['after-index', 'end'])
  appSees = false
  const unseen = await runAp04App({ instance, launchedAtMs: Date.now(), scaleManifest: { workspaceDir }, derive, warm: 1, appTimeoutMs: 250, random: () => 0 })
  assert.deepEqual({ passed: unseen.passed, file: unseen.samples[0].sourceToFileMs !== null, app: unseen.samples[0].sourceToAppMs }, { passed: false, file: true, app: null }, 'an app that never shows the change fails the run; the file measurement stands on its own')
  assert.deepEqual(guardErrors, [], 'nothing tried to start the app')
})

// Writes an AP-01 receipt set (G07) and an AP-04 receipt (G16) into `dir`.
function writeDesktopSet(t, dir, { candidate = CANDIDATE } = {}) {
  const g07 = recordProcedureReceipts({ plan: planProcedure('AP-01', { receiptDir: dir, operator: 'op-synthetic' }), receiptDir: dir, candidate, capabilities: CAPABILITIES, operator: 'op-synthetic', host: HOST, evidenceByGate: { G07: [{ role: 'cli-link-inspection', name: evidenceFileName('G07', 'cli-link-inspection'), bytes: Buffer.from('indexReady: true\nlinks\n') }] }, passedByGate: { G07: true }, wallClock: WALL, recordedAt: NOW })
  const g16 = recordProcedureReceipts({ plan: planProcedure('AP-04', { receiptDir: dir, operator: 'op-synthetic' }), receiptDir: dir, candidate, capabilities: CAPABILITIES, operator: 'op-synthetic', host: HOST, evidenceByGate: { G16: ['dataset-manifest', 'resource-samples', 'app-indexing-timings', 'warm-update-latencies'].map((role) => ({ role, name: evidenceFileName('G16', role, 'json'), bytes: Buffer.from(`{"role":"${role}"}\n`) })) }, passedByGate: { G16: true }, wallClock: WALL, dataset: { nodes: 10000, edges: 50000, fixtureDigest: TINY_FIXTURE_DIGEST }, recordedAt: NOW })
  return { g07: g07[0], g16: g16[0] }
}

test('receipt writer: schema-valid, closes false, human acceptance null; manual roles leave the receipt incomplete and blocked', (t) => {
  const dir = tempDir(t, 'write')
  const { g07, g16 } = writeDesktopSet(t, dir)
  for (const written of [g07, g16]) {
    assert.deepEqual(validateObsidianContract('acceptance-receipt', written.receipt), [])
    assert.deepEqual({ schemaValid: written.validation.schemaValid, label: written.validation.label, gateClosed: written.validation.gateClosed }, { schemaValid: true, label: RECEIPT_VALIDATION_LABEL, gateClosed: false })
    const desktop = written.receipt.ext[DESKTOP_EXT_KEY]
    assert.deepEqual({ closes: desktop.closes, human: desktop.humanAcceptance, signature: desktop.signature }, { closes: false, human: null, signature: null })
    assert.ok(fs.existsSync(written.receiptPath))
    for (const item of written.receipt.evidence) assert.equal(sha(fs.readFileSync(path.join(dir, item.name))), item.digest, `${item.name} is hashed as written`)
  }
  assert.deepEqual({ status: g07.receipt.ext[DESKTOP_EXT_KEY].status, outcome: g07.receipt.outcome, pending: g07.receipt.ext[DESKTOP_EXT_KEY].pendingRoles, missing: g07.validation.missing.map((item) => item.code) }, { status: 'incomplete', outcome: 'blocked', pending: ['app-observation'], missing: ['evidence-role-missing', 'acceptance-missing'] })
  assert.deepEqual({ status: g16.receipt.ext[DESKTOP_EXT_KEY].status, outcome: g16.receipt.outcome, met: g16.validation.requirementsMet, dataset: g16.receipt.ext[RECEIPT_EXT_KEY].dataset }, { status: 'complete', outcome: 'passed', met: true, dataset: { nodes: 10000, edges: 50000, fixtureDigest: TINY_FIXTURE_DIGEST } })
  assert.equal(g07.receipt.environment.app.ext.installerVersion, '1.12.7')
  // A failed automated check or an unqualified CLI is a failed receipt, never a skipped pass.
  const failed = recordProcedureReceipts({ plan: planProcedure('AP-04', { receiptDir: dir }), receiptDir: path.join(dir, 'failed'), candidate: CANDIDATE, capabilities: { ...CAPABILITIES, qualified: false }, operator: 'op-synthetic', host: HOST, evidenceByGate: { G16: ['dataset-manifest', 'resource-samples', 'app-indexing-timings', 'warm-update-latencies'].map((role) => ({ role, name: evidenceFileName('G16', role, 'json'), bytes: Buffer.from('{}\n') })) }, passedByGate: { G16: true }, wallClock: WALL, dataset: { nodes: 10, edges: 5, fixtureDigest: TINY_FIXTURE_DIGEST }, recordedAt: NOW })
  assert.equal(failed[0].receipt.outcome, 'failed')
  // The writer refuses what a receipt cannot carry.
  const refusal = (input, code) => { try { buildReceipt(input) } catch (error) { assert.ok(error instanceof ReceiptRefusal, error.stack); return error.code } return null }
  const base = { gate: 'G16', candidate: CANDIDATE, environment: g16.receipt.environment, host: HOST, operator: 'op-synthetic', evidence: [{ role: null, name: 'x.txt', bytes: Buffer.from('x') }], recordedAt: NOW, outcome: 'passed', wallClock: WALL, dataset: { nodes: 1, edges: 0, fixtureDigest: TINY_FIXTURE_DIGEST } }
  assert.equal(refusal({ ...base, evidence: [{ role: null, name: 'x.txt', bytes: Buffer.alloc(0) }] }), 'evidence-empty')
  assert.equal(refusal({ ...base, evidence: [{ role: 'app-observation', name: 'x.txt', bytes: Buffer.from('x') }] }), 'evidence-role-unknown')
  assert.equal(refusal({ ...base, evidence: [{ role: null, name: '../x.txt', bytes: Buffer.from('x') }] }), 'evidence-name-invalid')
  assert.equal(refusal({ ...base, candidate: { commit: '0'.repeat(40) } }), 'candidate-missing')
  assert.equal(refusal({ ...base, wallClock: null }), 'wall-clock-missing')
  assert.equal(refusal({ ...base, dataset: null }), 'dataset-missing')
  assert.equal(refusal({ ...base, gate: 'G18' }), 'gate-not-owned', 'the adopter gate is never written by the desktop tooling')
  assert.throws(() => writeGateReceipt({ ...base, receiptDir: 'relative' }), (error) => error.code === 'receipt-dir-not-absolute')
})

test('verifier: a complete signed set passes; missing, hash mismatch, incomplete, unsigned and wrong candidate each fail; a hash-blind verifier accepts tampering', (t) => {
  const dir = tempDir(t, 'verify')
  writeDesktopSet(t, dir)
  const statuses = (result) => Object.fromEntries(result.rows.map((row) => [row.gate, row.status]))
  // Fresh from the writer: G07 incomplete (a manual role outstanding), G16 complete but unsigned.
  const fresh = verifyReceiptSet({ receiptDir: dir, required: ['G07', 'G16'] })
  assert.deepEqual({ ok: fresh.ok, closes: fresh.closes, statuses: statuses(fresh), note16: fresh.rows[1].note }, { ok: false, closes: false, statuses: { G07: 'incomplete', G16: 'unsigned' }, note16: UNSIGNED_NOTE })
  // Signing refuses while manual steps are outstanding, then attaches the human evidence and signs.
  const signRefusal = (input) => { try { signReceipt(input) } catch (error) { assert.ok(error instanceof ReceiptRefusal, error.stack); return error.code } return null }
  assert.equal(signRefusal({ receiptDir: dir, gate: 'G07', actor: 'owner-synthetic', note: 'looked' }), 'manual-steps-outstanding')
  fs.writeFileSync(path.join(dir, 'observation.txt'), 'graph readable; both Shared concept notes distinct; links opened\n')
  assert.equal(signRefusal({ receiptDir: dir, gate: 'G07', actor: 'owner-synthetic', note: 'looked', attach: [{ role: 'app-observation', file: path.join(dir, 'observation.txt') }] }), 'outcome-required')
  const signed07 = signReceipt({ receiptDir: dir, gate: 'G07', actor: 'owner-synthetic', note: 'inspected the graph and the CLI inspection', attach: [{ role: 'app-observation', file: path.join(dir, 'observation.txt') }], outcome: 'passed', signedAt: NOW })
  assert.deepEqual({ met: signed07.validation.requirementsMet, closes: signed07.closes, acceptance: signed07.receipt.ext[RECEIPT_EXT_KEY].acceptance, human: signed07.receipt.ext[DESKTOP_EXT_KEY].humanAcceptance.actor, outcome: signed07.receipt.outcome }, { met: true, closes: false, acceptance: { kind: 'human', actor: 'owner-synthetic', recordedAt: NOW, evidenceName: 'G07-acceptance-record.txt' }, human: 'owner-synthetic', outcome: 'passed' })
  assert.equal(signRefusal({ receiptDir: dir, gate: 'G07', actor: 'owner-synthetic', note: 'again' }), 'already-signed')
  assert.equal(signRefusal({ receiptDir: dir, gate: 'G16', actor: 'owner-synthetic', note: 'x', outcome: 'failed' }), 'outcome-fixed')
  assert.equal(signRefusal({ receiptDir: dir, gate: 'G18', actor: 'owner-synthetic', note: 'x' }), 'adopter-acceptance-separate')
  const signed16 = signReceipt({ receiptDir: dir, gate: 'G16', actor: 'owner-synthetic', note: 'inspected the dataset manifest, samples and latencies', signedAt: NOW })
  assert.deepEqual({ met: signed16.validation.requirementsMet, human: signed16.receipt.ext[DESKTOP_EXT_KEY].humanAcceptance, signature: signed16.receipt.ext[DESKTOP_EXT_KEY].signature.actor }, { met: true, human: null, signature: 'owner-synthetic' })
  // Complete, hashed, signed: exit-zero territory, and still not a closed gate.
  const complete = verifyReceiptSet({ receiptDir: dir, required: ['G07', 'G16'] })
  assert.deepEqual({ ok: complete.ok, closes: complete.closes, statuses: statuses(complete), notes: complete.rows.map((row) => row.note), signed: complete.rows.map((row) => row.signedBy) }, { ok: true, closes: false, statuses: { G07: 'ok', G16: 'ok' }, notes: [SIGNED_NOTE, SIGNED_NOTE], signed: ['owner-synthetic', 'owner-synthetic'] })
  const table = formatTable(complete)
  assert.ok(table.includes('G07   ok') && table.includes(SIGNED_NOTE) && !/\bclosed\b/.test(table))
  // Missing gate.
  const missing = verifyReceiptSet({ receiptDir: dir, required: ['G07', 'G13', 'G16'] })
  assert.deepEqual({ ok: missing.ok, G13: statuses(missing).G13 }, { ok: false, G13: 'missing' })
  // Wrong candidate: against an explicit commit, and a set whose receipts disagree.
  const wrong = verifyReceiptSet({ receiptDir: dir, required: ['G07', 'G16'], candidateCommit: '3'.repeat(40) })
  assert.deepEqual({ ok: wrong.ok, statuses: statuses(wrong) }, { ok: false, statuses: { G07: 'wrong-candidate', G16: 'wrong-candidate' } })
  const mixed = tempDir(t, 'verify-mixed')
  writeDesktopSet(t, mixed)
  signReceipt({ receiptDir: mixed, gate: 'G16', actor: 'owner-synthetic', note: 'ok', signedAt: NOW })
  const other = path.join(mixed, 'G07.json')
  const otherCandidate = JSON.parse(fs.readFileSync(path.join(dir, 'G07.json'), 'utf8'))
  otherCandidate.candidate.commit = '4'.repeat(40)
  fs.writeFileSync(other, JSON.stringify(otherCandidate))
  for (const name of otherCandidate.evidence.map((item) => item.name)) fs.copyFileSync(path.join(dir, name), path.join(mixed, name))
  assert.deepEqual(statuses(verifyReceiptSet({ receiptDir: mixed, required: ['G16', 'G07'] })), { G16: 'ok', G07: 'wrong-candidate' })
  // Hash mismatch: tampered evidence beside a signed receipt; the hash-blind mutation control accepts it.
  fs.appendFileSync(path.join(dir, 'G16-warm-update-latencies.json'), 'tampered\n')
  const tampered = verifyReceiptSet({ receiptDir: dir, required: ['G16'] })
  assert.deepEqual({ ok: tampered.ok, status: tampered.rows[0].status, detail: tampered.rows[0].detail }, { ok: false, status: 'hash-mismatch', detail: ['evidence-length-mismatch: G16-warm-update-latencies.json', 'evidence-digest-mismatch: G16-warm-update-latencies.json'] })
  const blind = createReceiptVerifierForOracleTests({ checkHashes: false })({ receiptDir: dir, required: ['G16'] })
  assert.deepEqual({ ok: blind.ok, status: blind.rows[0].status }, { ok: true, status: 'ok' }, 'mutation control: without the hash check the tampered receipt passes, so the check is load-bearing')
  fs.rmSync(path.join(dir, 'G16-dataset-manifest.json'))
  assert.equal(verifyReceiptSet({ receiptDir: dir, required: ['G16'] }).rows[0].detail[0], 'evidence-file-missing: G16-dataset-manifest.json')
  // Schema-invalid and unparseable receipts.
  fs.writeFileSync(path.join(dir, 'G13.json'), JSON.stringify({ schema: 'atelier-obsidian-acceptance-receipt/v1', gate: 'G13' }))
  fs.writeFileSync(path.join(dir, 'G14.json'), '{not json')
  assert.deepEqual(statuses(verifyReceiptSet({ receiptDir: dir, required: ['G13', 'G14'] })), { G13: 'schema-invalid', G14: 'schema-invalid' })
  assert.throws(() => verifyReceiptSet({ receiptDir: dir, required: ['G99'] }), (error) => error instanceof OutputRefusal && error.code === 'usage')
  assert.throws(() => verifyReceiptSet({ receiptDir: 'relative', required: ['G07'] }), (error) => error.code === 'usage')
  assert.deepEqual(guardErrors, [], 'nothing tried to start the app')
})

test('verify-receipts and generate-scale command lines: exit codes on a complete set, an incomplete set and a refused output', async (t) => {
  const dir = tempDir(t, 'cli')
  writeDesktopSet(t, dir)
  signReceipt({ receiptDir: dir, gate: 'G16', actor: 'owner-synthetic', note: 'ok', signedAt: NOW })
  const run = (script, args) => new Promise((resolve) => childProcess.execFile(process.execPath, [path.join(REPOSITORY_ROOT, 'scripts', 'obsidian', script), ...args], { encoding: 'utf8' }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })))
  const ok = await run('verify-receipts.mjs', ['--required', 'G16', '--receipt-dir', dir])
  assert.deepEqual({ code: ok.code, signed: ok.stdout.includes(SIGNED_NOTE), closed: /\bclosed\b/.test(ok.stdout) }, { code: 0, signed: true, closed: false }, ok.stdout + ok.stderr)
  const incomplete = await run('verify-receipts.mjs', ['--required', 'G07,G16', '--receipt-dir', dir])
  assert.deepEqual({ code: incomplete.code, status: incomplete.stdout.includes('G07   incomplete') }, { code: 1, status: true }, incomplete.stdout + incomplete.stderr)
  const usage = await run('verify-receipts.mjs', ['--receipt-dir', dir])
  assert.equal(usage.code, 2)
  const refused = await run('generate-scale.mjs', ['--out', path.join(REPOSITORY_ROOT, 'fixtures', 'obsidian', 'acceptance', 'scale'), '--profile', 'tiny'])
  assert.deepEqual({ code: refused.code, message: refused.stderr.includes('output-inside-fixtures') }, { code: 2, message: true })
  assert.ok(!fs.existsSync(path.join(REPOSITORY_ROOT, 'fixtures', 'obsidian', 'acceptance', 'scale')))
  const planOnly = await run('desktop-receipts.mjs', ['--procedure', 'AP-03', '--receipt-dir', path.join(dir, 'receipts')])
  assert.deepEqual({ code: planOnly.code, plan: planOnly.stdout.includes('plan only'), sleep: planOnly.stdout.includes('sleep-wake-clock'), nothingWritten: !fs.existsSync(path.join(dir, 'receipts')) }, { code: 0, plan: true, sleep: true, nothingWritten: true })
  assert.deepEqual(guardErrors, [], 'nothing tried to start the app')
})

test('the desktop derivation applies the fixture\'s withheld list and refuses a vault that carries a sentinel', needsExchange, async (t) => {
  const { deriveWorkspace, materializeFixtureWorkspace } = await import('../scripts/obsidian/lib/derive.mjs')
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-derive-withheld-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const fixture = materializeFixtureWorkspace(path.join(temp, 'workspace'))
  assert.ok(fixture.withheldByEligibility.length > 0 && fixture.sentinels.length > 0)
  const vault = path.join(temp, 'vault')
  const derived = await deriveWorkspace({ projectFile: fixture.projectFile, stateRoot: path.join(temp, 'state'), vaultRoot: vault, withheld: fixture.withheldByEligibility, sentinels: fixture.sentinels })
  assert.equal(derived.state, 'committed')
  const names = fs.readdirSync(vault, { recursive: true }).map((name) => name.split(path.sep).join('/')).filter((name) => !name.startsWith('.obsidian') && !name.startsWith('.atelier-publication'))
  assert.ok(names.some((name) => name.endsWith('.md')), 'the vault holds notes')
  for (const sentinel of fixture.sentinels) assert.ok(!names.some((name) => name.includes(sentinel)), `${sentinel} must not name a note or a folder`)
  // Control: without the withheld list the sentinel reaches the vault and the derivation refuses to be evidence.
  await assert.rejects(() => deriveWorkspace({ projectFile: fixture.projectFile, stateRoot: path.join(temp, 'state-2'), vaultRoot: path.join(temp, 'vault-2'), sentinels: fixture.sentinels }), /withheld sentinel/)
})

// ---------------------------------------------------------------------------
// 8. AOP-4 phase 2, AP-03 and AP-05: the lifecycle and editing procedures run
// against the real runtime (a service process of the test entry for AP-03,
// an in-process engine with the real apply and proposal contributions for
// AP-05), a fake app that reads the vault from disk, and the shipped command.
// The spawn guard stays silent: the test entry's adapter reports no app.
// ---------------------------------------------------------------------------

const TEST_SERVICE_ENTRY = path.join(REPOSITORY_ROOT, 'test', 'support', 'obsidian-maintenance', 'service-entry.mjs')
const FULL_ONLY = [{ scopeId: 'scope-full', mode: 'full', selector: { all: true } }]
// Fixture teardown exercises the same cleanup authority as the production runner;
// a deliberately damaged record may still refuse proof after its held child is
// already joined, so that diagnostic refusal is safe to absorb here.
const endLeftService = (runtime) => async () => {
  try { await cleanupOwnedRuntime(runtime, { gracefulTimeoutMs: 5000 }) }
  catch (error) {
    if (error?.code !== 'owned-service-cleanup-unverified' || runtime.fixtureMayAbsorbUnknownRefusal !== true || error.detail?.alive === true || error.detail?.status?.state === 'occupied') throw error
    const held = await runtime.stopHeld()
    assert.equal(held.joined, true, 'fixture teardown must join every owned child')
  }
}

// A synthetic workspace with real (empty) git repositories, its private state under a data root of its own.
function serviceWorld(t, label, { scoped = false } = {}) {
  const dir = tempDir(t, label)
  const workspaceDir = path.join(dir, 'workspace')
  const fixture = scoped ? prepareAp05Workspace(workspaceDir) : materializeFixtureWorkspace(workspaceDir, { scopes: FULL_ONLY })
  if (!scoped) initialiseRepositories(fixture.repositories.map((repoId) => path.join(workspaceDir, repoId)))
  const env = stripProjectEnv(process.env)
  const world = prepareWorkspace({ projectFile: fixture.projectFile, dataRoot: path.join(dir, 'data'), env, randomBytes: fixedRandom })
  return { dir, fixture, env, world }
}

// The app of AP-03, faked: it "opens" any note and reads the vault file from disk, as the real probe reads app.vault.
const diskApp = (vaultRoot) => ({ openNote: async (notePath) => `opened ${notePath}`, readIncludes: ({ path: notePath, needle }) => { try { return fs.readFileSync(noteFile(vaultRoot, notePath), 'utf8').includes(needle) } catch { return false } } })

test('AP-03 production cleanup sweeps the owned child before a malformed status record refuses proof', async () => {
  const calls = []
  const runtime = {
    async stop(options) { calls.push(['stop', options]); throw new Error('status record unavailable') },
    async stopHeld(options) { calls.push(['stopHeld', options]); return { joined: true, signals: [{ pid: 7, sent: true, through: 'handle' }], remaining: [] } },
    record() { throw new Error('malformed record') },
    status() { throw new Error('malformed record') },
  }
  await assert.rejects(() => cleanupOwnedRuntime(runtime), (error) => {
    assert.equal(error.code, 'owned-service-cleanup-unverified')
    assert.equal(error.detail.held.joined, true)
    assert.deepEqual(error.detail.gracefulError, { name: 'Error', message: 'status record unavailable' })
    return true
  })
  assert.deepEqual(calls, [['stop', { stopTimeoutMs: 35000 }], ['stopHeld', { timeoutMs: 5000 }]])
})

test('AP-03 production cleanup refuses and retains custody when an owned child remains live', async () => {
  let live = true
  const runtime = {
    async stop(options) { if (options.force === true) live = false; return options.force === true ? { state: 'stopped', stopped: true } : { state: 'stale-record', stopped: false } },
    record() { return { pid: 8 } },
    alive() { return live },
    async stopHeld() { return { joined: false, signals: [{ pid: 8, sent: false, through: 'handle' }], remaining: [8] } },
  }
  await assert.rejects(
    () => cleanupOwnedRuntime(runtime),
    (error) => error instanceof IsolationRefusal && error.code === 'owned-service-cleanup-incomplete' && error.detail.held.remaining[0] === 8,
  )
})

test('AP-03 fixture teardown does not absorb a live or occupied service refusal', async () => {
  const runtime = {
    async stop() { return { stopped: false, state: 'busy' } },
    async stopHeld() { return { joined: true, signals: [], remaining: [] } },
    status() { return { state: 'occupied' } },
    record() { return { pid: 9 } },
    alive() { return true },
  }
  await assert.rejects(
    () => endLeftService(runtime)(),
    (error) => error instanceof IsolationRefusal && error.code === 'owned-service-cleanup-unverified' && error.detail.status.state === 'occupied',
  )
})

test('AP-03 production cleanup force-stops a detached service only after identity proof', async () => {
  const calls = []
  let live = true
  const runtime = {
    async stop(options) { calls.push(options); if (options.force === true) live = false; return options.force === true ? { state: 'stopped', stopped: true } : { state: 'busy', stopped: false, refused: true } },
    record() { return { runtimeId: 'rt-detached', pid: 4242 } },
    alive() { return live },
    async stopHeld(options) { calls.push({ held: options }); return { joined: true, signals: [], remaining: [] } },
  }
  const result = await cleanupOwnedRuntime(runtime)
  assert.deepEqual(calls, [{ stopTimeoutMs: 35000 }, { held: { timeoutMs: 5000 } }, { stopTimeoutMs: 5000, force: true }])
  assert.equal(result.forced.stopped, true)
  assert.equal(result.after.alive, false)
})

test('AP-03 production cleanup refuses a detached service when no stop proof exists', async () => {
  const runtime = {
    async stop() { throw new Error('status unavailable') },
    record() { return null },
    async stopHeld() { return { joined: true, signals: [], remaining: [] } },
  }
  await assert.rejects(
    () => cleanupOwnedRuntime(runtime),
    (error) => error instanceof IsolationRefusal && error.code === 'owned-service-cleanup-unverified',
  )
})

test('AP-03 cleanup preserves the procedure failure when cleanup also refuses', () => {
  const primary = new Error('procedure failed first')
  const cleanup = new IsolationRefusal('owned-service-cleanup-unverified', 'cleanup proof missing')
  const combined = combineProcedureAndCleanupError(primary, cleanup)
  assert.ok(combined instanceof AggregateError)
  assert.deepEqual(combined.errors, [primary, cleanup])
  const output = formatDesktopReceiptError(combined)
  assert.match(output, /Error: procedure failed first/)
  assert.match(output, /IsolationRefusal \[owned-service-cleanup-unverified\]/)
  assert.match(output, /cleanup proof missing/)
  assert.equal(desktopReceiptErrorExitCode(combined), 2)
  assert.equal(desktopReceiptErrorExitCode(new AggregateError([primary])), 1)
})

test('AP-03 production cleanup keeps bearer data out of success and refusal evidence', async () => {
  const record = { runtimeId: 'rt-stale', pid: 1234, ext: { bearer: 'synthetic-secret-marker' } }
  const runtime = {
    async stop() { return { state: 'stale-record', stopped: false, record } },
    async status() { return { state: 'stale-record', record } },
    record: () => record, alive: () => false,
    async stopHeld() { return { joined: true, signals: [], remaining: [] } },
  }
  const cleanup = await cleanupOwnedRuntime(runtime)
  const success = JSON.stringify(cleanup)
  assert.equal(success.includes('synthetic-secret-marker'), false)
  assert.equal(success.includes('"ext"'), false)
  assert.equal(success.includes('"bearer"'), false)
  runtime.status = async () => ({ state: 'occupied', record })
  const outcome = await cleanupProcedureRuntime(runtime, { procedureError: new Error('procedure failure') })
  assert.equal(outcome.retainRoots, true)
  assert.ok(outcome.error instanceof AggregateError)
  assert.equal(outcome.error.errors[1].code, 'owned-service-cleanup-unverified')
  const refusal = JSON.stringify(outcome.error.errors[1].detail)
  assert.equal(refusal.includes('synthetic-secret-marker'), false)
  assert.equal(refusal.includes('"ext"'), false)
  runtime.status = async () => ({ state: 'stale-record', record })
  const settled = await cleanupProcedureRuntime(runtime)
  assert.equal(settled.retainRoots, false)
  assert.equal(settled.error, null)
})

test('AP-03 interruption: a service is killed only when it answered healthy with a process number, and only through a handle the runtime holds', async (t) => {
  const failures = []
  const check = (step, condition, message) => { if (!condition) failures.push(`${step}: ${message}`); return condition }
  const runtimeAnswering = (status, kill) => ({ calls: [], async status() { return status }, async tick() { return { requested: true, state: 'healthy' } }, kill(pid, signal) { this.calls.push([pid, signal]); return kill(pid, signal) } })
  const stale = runtimeAnswering({ state: 'stale-record', record: { runtimeId: 'rt-synthetic', pid: 4242 } }, () => ({ sent: true }))
  const noPid = runtimeAnswering({ state: 'healthy', record: { runtimeId: 'rt-synthetic', pid: null } }, () => ({ sent: true }))
  for (const runtime of [stale, noPid]) {
    const record = await interruptService({ runtime, point: 'idle-between-ticks', check, sleep: async () => {} })
    assert.deepEqual([runtime.calls, record.kill.sent, record.kill.reason], [[], false, 'no-healthy-service'], 'nothing is killed')
  }
  // Healthy, but the number is not one the runtime holds: refused, and a failure of the step.
  const refusing = runtimeAnswering({ state: 'healthy', record: { runtimeId: 'rt-synthetic', pid: 4242 } }, (pid, signal) => ({ pid, signal, sent: false, reason: 'not-a-service-this-runtime-holds' }))
  const refused = await interruptService({ runtime: refusing, point: 'during-a-tick', check, sleep: async () => {} })
  assert.deepEqual([refusing.calls, refused.kill.sent, refused.tickInFlight.answer.state], [[[4242, 'SIGKILL']], false, 'healthy'])
  // Healthy and held: killed once, and no failure.
  const holding = runtimeAnswering({ state: 'healthy', record: { runtimeId: 'rt-synthetic', pid: 4243 } }, (pid, signal) => ({ pid, signal, sent: true, through: 'handle' }))
  const before = failures.length
  const killed = await interruptService({ runtime: holding, point: 'idle-between-ticks', check, sleep: async () => {} })
  assert.deepEqual([holding.calls, killed.kill.sent, failures.length - before], [[[4243, 'SIGKILL']], true, 0])
  assert.deepEqual(failures, ['interruption: idle-between-ticks: no healthy service to interrupt', 'interruption: idle-between-ticks: no healthy service to interrupt', 'interruption: during-a-tick: the service was not interrupted (not-a-service-this-runtime-holds)'])
  // The runtime itself signals no number it does not hold: here it has started nothing.
  const kills = t.mock.method(process, 'kill', () => true)
  const runtime = createServiceRuntime({ loadProject: () => { throw new Error('not loaded') }, dataRoot: '/nonexistent', env: {}, consent: { actor: 'op-synthetic' } })
  assert.deepEqual([runtime.kill(4242, 'SIGKILL'), runtime.kill(process.pid), runtime.kill(null), kills.mock.calls.length], [{ pid: 4242, signal: 'SIGKILL', sent: false, reason: 'not-a-service-this-runtime-holds' }, { pid: process.pid, signal: 'SIGKILL', sent: false, reason: 'not-a-service-this-runtime-holds' }, { pid: null, signal: 'SIGKILL', sent: false, reason: 'not-a-service-this-runtime-holds' }, 0])
})

// Register service cleanup before serviceWorld registers removal of its data root.
function ap03ServiceWorld(t, label, { spawn = childProcess.spawn } = {}) {
  let runtime
  t.after(async () => { if (runtime) await endLeftService(runtime)() })
  const setup = serviceWorld(t, label)
  const { world, env } = setup
  runtime = createServiceRuntime({ loadProject: world.loadProject, dataRoot: world.dataRoot, env, consent: { actor: 'op-synthetic', coverage: 'service' }, intervalMs: 3_600_000, entryPath: TEST_SERVICE_ENTRY, entryArgs: [], launchThroughShell: false, probeTimeoutMs: 2000, spawn })
  return { ...setup, runtime }
}

test('AP-03 cleanup: a deliberately left service ends before its temporary workspace is removed', needsExchange, async (t) => {
  let runtime, pid, dir
  const cleanupStarts = []
  // Regression-failure recovery uses only the unreaped child handle, even if a mutation removes the record first.
  t.after(async () => {
    if (!runtime || !pid) return
    runtime.kill(pid, 'SIGKILL')
    const deadline = Date.now() + 5000
    while (runtime.alive(pid) && Date.now() < deadline) await new Promise((resolve) => { setTimeout(resolve, 25) })
    assert.equal(runtime.alive(pid), false, 'regression cleanup must join its owned service')
  })
  await t.test('leave a started service for the registered after-hook', async (child) => {
    const setup = ap03ServiceWorld(child, 'ap03-leftover')
    ;({ runtime, dir } = setup)
    const started = await runtime.start()
    pid = started.record?.pid
    assert.equal(started.state, 'healthy')
    assert.ok(Number.isInteger(pid) && runtime.alive(pid))
    assert.ok(fs.existsSync(dir))
    const stop = runtime.stop
    runtime.stop = async (...args) => {
      let recordReadable = false
      try { recordReadable = runtime.record()?.pid === pid } catch { /* capture the failed ordering */ }
      cleanupStarts.push({ directoryPresent: fs.existsSync(dir), recordReadable })
      return stop(...args)
    }
  })
  assert.deepEqual(cleanupStarts[0], { directoryPresent: true, recordReadable: true }, 'cleanup must start before workspace and record removal')
  assert.equal(runtime.alive(pid), false, 'cleanup must stop the service while its record is still readable')
  assert.equal(fs.existsSync(dir), false, 'workspace removal follows service cleanup')
})

for (const damaged of ['missing', 'malformed']) {
  test(`AP-03 cleanup: held child is joined after stop failure with a ${damaged} record`, needsExchange, async (t) => {
    const { world, runtime } = ap03ServiceWorld(t, `ap03-record-${damaged}`)
    const started = await runtime.start()
    const pid = started.record?.pid
    assert.equal(started.state, 'healthy')
    // Recover in the test body: a failed earlier after-hook can prevent later
    // hooks from running. Joining here also precedes temporary-root removal.
    try {
      const record = path.join(world.workspaceRoot, 'state', 'service', 'runtime.json')
      runtime.fixtureMayAbsorbUnknownRefusal = true
      if (damaged === 'missing') fs.unlinkSync(record)
      else fs.writeFileSync(record, '{')
      try {
        const cleanup = await cleanupOwnedRuntime(runtime)
        assert.equal(cleanup.held.joined, true)
      } catch (error) {
        assert.ok(error instanceof IsolationRefusal)
        assert.equal(error.code, 'owned-service-cleanup-unverified')
        assert.equal(error.detail.held.joined, true)
      }
      assert.equal(runtime.alive(pid), false, 'missing or malformed records cannot hide a held child')
    } finally {
      const recovery = await runtime.stopHeld()
      assert.equal(recovery.joined, true, 'regression recovery must join its owned service')
      // A malformed retained record is diagnostic state; remove only this test's
      // damaged fixture after proving the real cleanup refusal and child join.
      fs.rmSync(path.join(world.workspaceRoot, 'state', 'service', 'runtime.json'), { force: true })
    }
  })
}

test('AP-03 production cleanup joins a real launcher-started unheld service', needsExchange, async (t) => {
  const { runtime } = ap03ServiceWorld(t, 'ap03-unheld-cleanup')
  const started = await runtime.startFromExitingLauncher()
  const status = await runtime.status()
  const pid = started.reported?.pid ?? status.record?.pid
  assert.equal(started.reported?.state ?? status.state, 'healthy')
  assert.equal(runtime.alive(pid), true)
  assert.equal(runtime.kill(pid).sent, false, 'the launcher child is not a retained service handle')
  const cleanup = await cleanupOwnedRuntime(runtime)
  assert.equal(cleanup.graceful.stopped, true)
  assert.equal(cleanup.held.joined, true)
  assert.equal(runtime.alive(pid), false)
})

test('AP-03 cleanup: held sweep reports an unjoined live child without PID signalling', needsExchange, async (t) => {
  let held
  const { runtime } = ap03ServiceWorld(t, 'ap03-unjoined', { spawn: (...args) => { held = childProcess.spawn(...args); return held } })
  const started = await runtime.start()
  const pid = started.record?.pid
  assert.equal(started.state, 'healthy')
  // Refuse signalling through this particular handle, then restore its real
  // method for emergency recovery and the registered after-hook.
  const kill = held.kill
  try {
    held.kill = () => false
    const result = await runtime.stopHeld({ timeoutMs: 25 })
    assert.equal(result.joined, false)
    assert.deepEqual(result.remaining, [pid])
    assert.deepEqual(result.signals, [{ pid, sent: false, through: 'handle' }])
    await assert.rejects(() => runtime.stopHeld({ timeoutMs: Infinity }), RangeError)
  } finally {
    held.kill = kill
    const joined = await runtime.stopHeld()
    assert.equal(joined.joined, true)
    assert.deepEqual(joined.remaining, [])
  }
})

test('AP-03 runner: source refresh, dropped event with the null watcher, kills at owned points and a start from an exiting launcher, against a real service process', needsExchange, async (t) => {
  const { world, runtime } = ap03ServiceWorld(t, 'ap03')
  // Passed through, and recorded: the interruptions must not reach the service by its number.
  const kills = t.mock.method(process, 'kill')
  const run = await runAp03({ world, runtime, app: diskApp(world.vaultRootFor('scope-full')), adapterFactory: () => absentAdapter(), recoveryIntervalMs: 400, settleMs: 300, midTickDelayMs: 5 })
  const interrupted = run.steps.interruption.points.map((point) => point.before.pid)
  assert.deepEqual([run.steps.interruption.points.map((point) => [point.kill.sent, point.kill.through]), kills.mock.calls.filter((call) => interrupted.includes(call.arguments[0]) && call.arguments[1] !== 0).length], [[[true, 'handle'], [true, 'handle']], 0], 'each interruption went through the handle of the process this run started')
  assert.deepEqual({ passed: run.passed, failures: run.failures, roles: run.evidence.map((item) => [item.role, item.name]) }, { passed: true, failures: [], roles: [['source-refresh-trace', 'G14-source-refresh-trace.json'], ['dropped-event-recovery', 'G14-dropped-event-recovery.json'], ['ownership-health', 'G15-ownership-health.json'], ['terminal-closure', 'G15-terminal-closure.json']] })
  const { steps } = run
  assert.ok(steps['source-refresh'].fileUpdate.met && steps['source-refresh'].appReadback.met && steps['source-refresh'].after.sourceDigest !== steps['source-refresh'].before.sourceDigest)
  assert.ok(typeof run.timings.sourceToFileMs === 'number' && typeof run.timings.sourceToAppMs === 'number', 'both latencies are recorded, separately')
  // The first trial's tick is full only when the short test interval elapsed during the trial, so its `full` is not pinned.
  assert.deepEqual(steps['dropped-event'].trials.map((trial) => [trial.label, trial.caught, trial.label === 'full-hash-pass' ? trial.tick.full : null, trial.tick.changes.some((change) => change.changeClass === 'source-body')]), [['stat-and-digest', true, null, true], ['full-hash-pass', true, true, true]])
  assert.deepEqual(steps.interruption.points.map((point) => [point.point, point.afterKill.state, point.restart.state, point.restart.pid !== point.before.pid, point.retained.pendingEditsUnchanged, point.retained.journalsRetained, point.retained.objectsPresent]), [['idle-between-ticks', 'stale-record', 'healthy', true, true, true, true], ['during-a-tick', 'stale-record', 'healthy', true, true, true, true]])
  assert.ok(steps.interruption.reference.pendingEdits.length >= 1 && steps.interruption.reference.retainedObjects.every((item) => item.present))
  const launcher = steps['launcher-exit']
  assert.deepEqual({ exit: launcher.launcher.exit, alive: launcher.launcher.alive, reported: launcher.reported.state, sameRuntime: launcher.statusLater.runtimeId === launcher.reported.runtimeId && launcher.statusLater.pid === launcher.reported.pid, health: launcher.healthAfterExit.answer.kind }, { exit: { code: 0, signal: null }, alive: false, reported: 'healthy', sameRuntime: true, health: 'health' })
  assert.equal(launcher.finalStop.stopped, true)
  // The evidence is what the receipt hashes: every role carries the wall clock of its step and the source digests.
  const refresh = JSON.parse(run.evidence[0].bytes.toString('utf8'))
  assert.ok(refresh.step.startedAt && refresh.step.endedAt && refresh.host.sourceDigests['north-desk/plans/harbor-plan.md'].startsWith('sha256:'))
  assert.deepEqual(guardErrors, [], 'nothing tried to start the app')
})

test('AP-03 runner: a refused interruption fails the run, which still returns its failures and its evidence', needsExchange, async (t) => {
  const { world, runtime } = ap03ServiceWorld(t, 'ap03-refused')
  // The same runtime, except that it refuses every interruption, as it does for a service it does not hold.
  const refusing = Object.assign(Object.create(runtime), { kill: (pid, signal) => ({ pid, signal, sent: false, reason: 'not-a-service-this-runtime-holds' }) })
  const kills = t.mock.method(process, 'kill')
  const run = await runAp03({ world, runtime: refusing, app: diskApp(world.vaultRootFor('scope-full')), adapterFactory: () => absentAdapter(), recoveryIntervalMs: 400, settleMs: 300, midTickDelayMs: 5 })
  assert.deepEqual({ passed: run.passed, failures: run.failures, roles: run.evidence.map((item) => item.role) }, {
    passed: false,
    failures: ['interruption: idle-between-ticks: the service was not interrupted (not-a-service-this-runtime-holds)', 'interruption: during-a-tick: the service was not interrupted (not-a-service-this-runtime-holds)'],
    roles: ['source-refresh-trace', 'dropped-event-recovery', 'ownership-health', 'terminal-closure'],
  })
  assert.deepEqual(run.timings.interruptions, [{ point: 'idle-between-ticks', killSent: false, processGoneMs: null, retained: null }, { point: 'during-a-tick', killSent: false, processGoneMs: null, retained: null }])
  const ownership = JSON.parse(run.evidence.find((item) => item.role === 'ownership-health').bytes.toString('utf8'))
  assert.deepEqual(ownership.interruption.points.map((point) => [point.point, point.kill.sent, point.kill.reason, 'restart' in point]), [['idle-between-ticks', false, 'not-a-service-this-runtime-holds', false], ['during-a-tick', false, 'not-a-service-this-runtime-holds', false]])
  assert.deepEqual([run.steps['launcher-exit'].finalStop.stopped, kills.mock.calls.filter((call) => call.arguments[1] !== 0).length], [true, 0], 'the service was stopped by its owner, and nothing was signalled')
  assert.deepEqual(guardErrors, [], 'nothing tried to start the app')
})

// The AP-05 runtime for tests: the real engine with the real apply operation and proposal adapter, in this process.
// `start` creates a fresh engine (what a restarted service does: everything it knows comes from disk).
function engineRuntime(world, env, { onTick = () => {} } = {}) {
  const context = { loadProject: world.loadProject, dataRoot: world.dataRoot, env, platform: process.platform }
  const contributions = [createSourceApplyContribution({ context }), createProposalAdapterContribution(), createSelectionContribution()]
  let engine = null
  let generation = 0
  let ticks = 0
  return {
    contributions,
    async start() { generation += 1; engine = createMaintenanceEngine({ ...context, adapterFactory: () => absentAdapter(), clock: () => new Date(), extensions: createObsidianRegistry({ contributions }).extensions, watcherFactory: createNullWatcherFactory(), quietPeriodMs: 0 }); return { state: 'healthy', started: true, record: { runtimeId: `rt-engine-${generation}`, pid: process.pid } } },
    async tick() { ticks += 1; onTick(ticks); const report = await engine.tick(); return { requested: true, state: 'healthy', reason: 'tick-ran', tick: { ok: report.state !== 'refused', state: report.state, reason: report.reason ?? report.refusal?.code ?? null, scopes: (report.scopes ?? []).map(({ scopeId, state, reason }) => ({ scopeId, state, reason })), dispatched: report.dispatched ?? [] } } },
    async stop() { engine?.stop(); engine = null; return { stopped: true } },
    async status() { return { state: engine ? 'healthy' : 'stopped' } },
  }
}

// The editor of a fake instance: the same bytes real typing leaves on disk after the app saved.
const fileEditor = (world, scopeId) => ({ async typeAt({ notePath, anchor, text }) { const file = noteFile(world.vaultRootFor(scopeId), notePath); const held = fs.readFileSync(file, 'utf8'); const at = held.indexOf(anchor); if (at < 0) throw new Error(`no anchor "${anchor}" in ${notePath}`); fs.writeFileSync(file, held.slice(0, at + anchor.length) + text + held.slice(at + anchor.length)); return { notePath, anchor, text, typedAt: new Date().toISOString(), noteDigest: fileDigest(file) } } })

// The production shape of the AP-05 runtime: the service body in this process, with the same contributions and an
// adapter factory that reports no app for either vault.
function inProcessRuntime(t, world, env) {
  const context = { loadProject: world.loadProject, dataRoot: world.dataRoot, env, platform: process.platform }
  const contributions = [createSourceApplyContribution({ context }), createProposalAdapterContribution(), createSelectionContribution()]
  const runtime = createInProcessServiceRuntime({ ...context, consent: { actor: 'op-synthetic', coverage: 'service' }, probeTimeoutMs: 2000, adapterFactory: () => absentAdapter(), extensions: createObsidianRegistry({ contributions }).extensions })
  t.after(async () => { try { await runtime.stop() } catch { /* already stopped */ } })
  return Object.assign(runtime, { contributions })
}

async function ap05World(t, label, { onTick, inProcess = false } = {}) {
  const { world, env, fixture } = serviceWorld(t, label, { scoped: true })
  const runtime = inProcess ? inProcessRuntime(t, world, env) : engineRuntime(world, env, { onTick })
  const command = await createCommandRunner({ projectFile: fixture.projectFile, dataRoot: world.dataRoot, env, contributions: runtime.contributions })
  const views = { full: { scopeId: AP05_SCOPES.full, editor: fileEditor(world, AP05_SCOPES.full) }, scoped: { scopeId: AP05_SCOPES.scoped, editor: fileEditor(world, AP05_SCOPES.scoped) } }
  return { world, runtime, command, views, fixture }
}

test('AP-05 runner: coalesced and conflicted edits across two vaults, manual and automatic apply, pending kinds, idempotent restart, proposal store and retention', needsExchange, async (t) => {
  const { world, runtime, command, views, fixture } = await ap05World(t, 'ap05', { inProcess: true })
  assert.deepEqual(fixture.extraNotes, ['north-desk/plans/quay-notes.md', 'north-desk/plans/lantern-log.md', 'north-desk/plans/mooring-notes.md'])
  const run = await runAp05({ world, views, runtime, command, operator: 'op-synthetic' })
  // runAp05 stops between its retention assertions; restart the same runtime so
  // cleanupOwnedRuntime is proven against a live in-process service as well.
  const live = await runtime.start()
  assert.equal(live.state, 'healthy')
  const cleanup = await cleanupOwnedRuntime(runtime)
  assert.equal(cleanup.held.joined, true, 'production cleanup joins a live real in-process AP-05 runtime')
  assert.deepEqual({ start: [run.steps.baseline.start.state, run.steps.baseline.start.started, run.steps.baseline.start.record.pid], restart: [run.steps.automatic.restart.stop.stopped, run.steps.automatic.restart.start.state, run.steps.automatic.restart.start.record.runtimeId !== run.steps.baseline.start.record.runtimeId], stopped: run.steps.retention.uninstall.serviceStatus.state, log: runtime.logLines.filter((entry) => entry.event === 'started').length }, { start: ['healthy', true, process.pid], restart: [true, 'healthy', true], stopped: 'stopped', log: 3 }, 'the in-process service body was started twice, proven by health, restarted for live cleanup coverage, and stopped')
  assert.deepEqual({ passed: run.passed, failures: run.failures, roles: run.evidence.map((item) => item.role) }, { passed: true, failures: [], roles: ['multi-vault-edit-trace', 'manual-apply-trace', 'automatic-apply-trace', 'uninstall-retention', null] })
  const { steps } = run
  assert.deepEqual({ identical: [steps['multi-vault'].identical.object.state, steps['multi-vault'].identical.object.operations.length, steps['multi-vault'].identical.object.pendingEdits.length], divergent: [steps['multi-vault'].divergent.object.state, steps['multi-vault'].divergent.object.conflictedOperations.length] }, { identical: ['pending', 1, 2], divergent: ['conflicted', 2] })
  assert.deepEqual({ ticks: steps.manual.ticks.map((item) => item.sourceChanges.length), applied: steps.manual.apply.answer.result.status, exact: steps.manual.after.exactlyAsTyped, others: steps.manual.after.otherSourceChanges }, { ticks: [0, 0, 0], applied: 'applied', exact: true, others: [] })
  assert.ok(fs.readFileSync(path.join(world.workspaceDir, 'south-desk', 'tables', 'tide-table.md'), 'utf8').includes(AP05_EDITS.identical.text), 'the explicit apply wrote exactly the typed text into the source')
  assert.deepEqual({ eligible: [steps.automatic.eligible.after.exactlyAsTyped, steps.automatic.eligible.appliedRecord.map((item) => [item.state, item.lastCode, item.attempts]), steps.automatic.eligible.show.answer.edit.object.state], pending: Object.fromEntries(Object.entries(steps.automatic.pendingSummary).map(([kind, list]) => [kind, list.map((edit) => [edit.state, edit.lastCode, edit.objectState])])) }, {
    eligible: [true, [['applied', 'applied', 1]], 'settled'],
    pending: {
      outOfScope: [['retry-exhausted', 'outside-policy-selection', 'pending']],
      stale: [['retry-exhausted', 'stale-source', 'conflicted']],
      unsupported: [['retry-exhausted', 'edit-not-applicable', 'settled']],
      conflicting: [['retry-exhausted', 'object-conflicted', 'conflicted'], ['retry-exhausted', 'object-conflicted', 'conflicted']],
      revoked: [['queued', null, 'pending']],
    },
  })
  assert.deepEqual({ same: steps.automatic.restart.idempotent.sameOpenEdits, sourceChanges: steps.automatic.restart.idempotent.sourceChanges, journals: steps.automatic.restart.idempotent.journalsRetained }, { same: true, sourceChanges: [], journals: true })
  assert.ok(steps.retention.ledger.exists && steps.retention.ledger.lines >= 1 && steps.retention.structuralSource.unchangedSinceTyped, 'the structural edit reached the copy-only store and the source stayed')
  assert.ok(steps.retention.retained.vaultHolds.length >= 8 && steps.retention.retained.vaultHolds.every((item) => item.present) && steps.retention.retained.recoveryObjects.every((item) => item.present))
  assert.deepEqual(run.timings.sourceChangesSinceBaseline, ['north-desk/plans/quay-notes.md', 'north-desk/plans/shared-b.md', 'south-desk/tables/tide-table.md'], 'exactly the moved stale source, the automatic apply and the manual apply changed a source')
  assert.deepEqual(guardErrors, [], 'nothing tried to start the app')
})

test('AP-05 production cleanup joins a live in-process service after a bounded graceful timeout', needsExchange, async (t) => {
  const { world, env } = serviceWorld(t, 'ap05-stop-held-join', { scoped: true })
  const context = { loadProject: world.loadProject, dataRoot: world.dataRoot, env, platform: process.platform }
  let release
  const runtime = createInProcessServiceRuntime({
    ...context,
    consent: { actor: 'op-synthetic', coverage: 'service' },
    probeTimeoutMs: 100,
    adapterFactory: () => absentAdapter(),
    runService: async (input) => {
      const service = await runMaintenanceService({ ...input, shutdownGraceMs: 0 })
      const shutdown = service.shutdown
      release = () => shutdown('test-cleanup')
      return { ...service, shutdown: async (reason) => { await new Promise((resolve) => setTimeout(resolve, 250)); return shutdown(reason) } }
    },
  })
  t.after(async () => { if (release) await release() })
  let started
  try { started = await runtime.start() }
  catch (error) {
    if (error?.code === 'EPERM') return t.skip('host loopback is unavailable in this sandbox')
    throw error
  }
  assert.equal(started.started, true)
  const timed = await runtime.stop({ stopTimeoutMs: 10 })
  assert.equal(timed.reason, 'stop-timed-out')
  const cleanup = await cleanupOwnedRuntime(runtime, { gracefulTimeoutMs: 10, heldTimeoutMs: 5000 })
  assert.equal(cleanup.graceful.stopped, false)
  assert.equal(cleanup.held.joined, true)
  assert.equal(cleanup.after.record, null)
})

test('AP-05 production cleanup fails closed when a live in-process shutdown never settles', needsExchange, async (t) => {
  const { world, env } = serviceWorld(t, 'ap05-stop-timeout', { scoped: true })
  const context = { loadProject: world.loadProject, dataRoot: world.dataRoot, env, platform: process.platform }
  let release
  const runtime = createInProcessServiceRuntime({
    ...context,
    consent: { actor: 'op-synthetic', coverage: 'service' },
    probeTimeoutMs: 100,
    adapterFactory: () => absentAdapter(),
    runService: async (input) => {
      const service = await runMaintenanceService({ ...input, shutdownGraceMs: 0 })
      release = service.shutdown
      return { ...service, shutdown: () => new Promise(() => {}) }
    },
  })
  t.after(async () => { if (release) await release('test-cleanup') })
  let started
  try { started = await runtime.start() }
  catch (error) {
    if (error?.code === 'EPERM') return t.skip('host loopback is unavailable in this sandbox')
    throw error
  }
  assert.equal(started.started, true)
  const stop = await runtime.stop({ stopTimeoutMs: 10 })
  assert.equal(stop.reason, 'stop-timed-out')
  const held = await runtime.stopHeld({ timeoutMs: 10 })
  assert.deepEqual([held.joined, held.remaining.length], [false, 1])
  const outcome = await cleanupProcedureRuntime(runtime, { gracefulTimeoutMs: 10, heldTimeoutMs: 10 })
  assert.equal(outcome.retainRoots, true)
  assert.ok(outcome.error instanceof IsolationRefusal)
  assert.equal(outcome.error.code, 'owned-service-cleanup-incomplete')
  assert.equal(outcome.error.detail.held.joined, false)
  assert.equal(outcome.error.detail.held.remaining.length, 1)
})

test('mutation control: a recorder blind to source digests accepts a manual-mode tick that wrote a source; the real recorder refuses it', needsExchange, async (t) => {
  // A runtime whose fourth tick (the first manual-mode tick after the two multi-vault ticks) writes a source, as a broken engine would.
  const sabotage = (world) => (count) => { if (count === 4) fs.appendFileSync(path.join(world.workspaceDir, 'north-desk', 'plans', 'lantern-log.md'), '\nWritten by a tick.\n') }
  const honest = await ap05World(t, 'ap05-honest')
  honest.runtime = engineRuntime(honest.world, honest.world.env, { onTick: sabotage(honest.world) })
  const real = await runAp05({ ...honest, operator: 'op-synthetic', manualTicks: 1 })
  assert.ok(real.failures.includes('manual: a tick in manual mode changed a source'), real.failures.join('\n'))
  const blind = await ap05World(t, 'ap05-blind')
  blind.runtime = engineRuntime(blind.world, blind.world.env, { onTick: sabotage(blind.world) })
  const blindRun = await createAp05RunnerForOracleTests({ sourceDigests: () => ({}) })({ ...blind, operator: 'op-synthetic', manualTicks: 1 })
  assert.ok(!blindRun.failures.includes('manual: a tick in manual mode changed a source'), 'the blind recorder cannot see the written source')
  assert.deepEqual(guardErrors, [], 'nothing tried to start the app')
})

test('mutation control: a warm summary that reads the app series from the file member fails the pinned p95', () => {
  const changes = Array.from({ length: 30 }, (_, index) => ({ change: index + 1, sourceToFileMs: 100 + index * 10, sourceToAppMs: 9000 }))
  const real = warmChangeSummary(changes)
  assert.deepEqual({ file: real.sourceToFile.p95Ms, app: real.sourceToApp.p95Ms, met: real.targetsMet, claimed: real.usability.claimed }, { file: 380, app: 9000, met: { fileUpdateP95: true, sourceToAppP95: null }, claimed: false })
  const wrongSeries = createWarmChangeSummaryForOracleTests({ appOf: (sample) => sample.sourceToFileMs })(changes)
  assert.notEqual(wrongSeries.sourceToApp.p95Ms, 9000, 'the app p95 computed over the file series is not the app p95')
  assert.throws(() => assert.deepEqual({ file: wrongSeries.sourceToFile.p95Ms, app: wrongSeries.sourceToApp.p95Ms }, { file: 380, app: 9000 }), assert.AssertionError)
})

test('the per-vault adapter factory reaches the app that holds the vault through that app\'s HOME and refuses a vault nobody holds', (t) => {
  const dir = tempDir(t, 'per-vault')
  const vaults = ['full', 'scoped'].map((name) => { const vault = path.join(dir, name); fs.mkdirSync(vault); return vault })
  const made = []
  const factory = createPerVaultAdapterFactory(vaults.map((vaultRoot, index) => ({ vaultRoot, env: { HOME: `/private/home-${index}` } })), {
    createQualifiedAdapterFactory: ({ appProbe, createAdapter }) => Object.assign((input) => { appProbe.inspectSync(); return createAdapter(input) }, { lastQualification: () => 'q' }),
    createProductionAppProbe: ({ env }) => ({ inspectSync: () => made.push(`probe ${env.HOME}`) }),
    createObsidianCliAdapter: ({ env }) => ({ kind: 'cli', home: env.HOME }),
  })
  assert.deepEqual([factory({ store: { vaultRoot: vaults[1] } }).home, factory({ store: { vaultRoot: vaults[0] } }).home, made, factory.lastQualification()], ['/private/home-1', '/private/home-0', ['probe /private/home-1', 'probe /private/home-0'], ['q', 'q']])
  assert.throws(() => factory({ store: { vaultRoot: path.join(dir, 'other') } }), /no isolated app holds the vault/)
})

test('service world seams: the profile is bound to the engine vault, repositories ignore the proposal store, the audience is set, the launcher is spawned without a shell in tests', (t) => {
  const dir = tempDir(t, 'seams')
  const layout = { root: dir, home: path.join(dir, 'home'), profile: path.join(dir, 'profile'), vault: path.join(dir, 'vault') }
  fs.mkdirSync(layout.profile, { recursive: true })
  fs.writeFileSync(path.join(layout.profile, 'obsidian.json'), JSON.stringify({ vaults: { atelierg00synthetic: { path: layout.vault, ts: 1, open: true } }, cli: true, updateDisabled: true }))
  const bound = bindLayoutToVault(layout, path.join(dir, 'engine-vault'))
  const profile = JSON.parse(fs.readFileSync(path.join(layout.profile, 'obsidian.json'), 'utf8'))
  assert.deepEqual({ vault: bound.vault, registered: Object.values(profile.vaults).map((item) => item.path), cli: profile.cli, exists: fs.existsSync(bound.vault) }, { vault: path.join(dir, 'engine-vault'), registered: [path.join(dir, 'engine-vault')], cli: true, exists: true })
  const repo = path.join(dir, 'repo')
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
  const ran = []
  initialiseRepositories([repo], { run: (command, args, options) => { ran.push([command, ...args, options.cwd]); fs.mkdirSync(path.join(options.cwd, '.git'), { recursive: true }) } })
  assert.deepEqual({ ran, ignore: fs.readFileSync(path.join(repo, '.gitignore'), 'utf8') }, { ran: [['git', 'init', '-q', repo]], ignore: '.atelier-proposals/\n' })
  const { world } = serviceWorld(t, 'seams-world')
  assert.deepEqual({ audience: readMachineSettings({ workspaceRoot: world.workspaceRoot, workspaceId: world.workspaceId }).audienceAllow, workspaceId: world.workspaceId, vault: path.relative(world.workspaceRoot, world.vaultRootFor('scope-full')).split(path.sep) }, { audience: ['team'], workspaceId: WORKSPACE_ID, vault: ['vaults', 'scope-full'] })
  assert.deepEqual(guardErrors, [], 'nothing tried to start the app')
})

test('AP-03 and AP-05 receipts: G14 stays incomplete for the host sleep/wake, G15 and G17 are complete from automated roles alone; a failed run is a failed receipt', (t) => {
  const dir = tempDir(t, 'lifecycle-receipts')
  const roles = (gate, names) => names.map((role) => ({ role, name: evidenceFileName(gate, role, 'json'), bytes: Buffer.from(`{"role":"${role}"}\n`) }))
  const ap03 = recordProcedureReceipts({ plan: planProcedure('AP-03', { receiptDir: dir, operator: 'op-synthetic' }), receiptDir: dir, candidate: CANDIDATE, capabilities: CAPABILITIES, operator: 'op-synthetic', host: HOST, evidenceByGate: { G14: roles('G14', ['source-refresh-trace', 'dropped-event-recovery']), G15: roles('G15', ['ownership-health', 'terminal-closure']) }, passedByGate: { G14: true, G15: true }, wallClock: WALL, recordedAt: NOW })
  assert.deepEqual(ap03.map(({ receipt, validation }) => [receipt.gate, receipt.outcome, receipt.ext[DESKTOP_EXT_KEY].status, receipt.ext[DESKTOP_EXT_KEY].pendingRoles, validation.schemaValid, validation.missing.map((item) => item.code)]), [
    ['G14', 'blocked', 'incomplete', ['sleep-wake-clock'], true, ['evidence-role-missing']],
    ['G15', 'passed', 'complete', [], true, []],
  ])
  const ap05 = recordProcedureReceipts({ plan: planProcedure('AP-05', { receiptDir: dir, operator: 'op-synthetic' }), receiptDir: dir, candidate: CANDIDATE, capabilities: CAPABILITIES, operator: 'op-synthetic', host: HOST, evidenceByGate: { G17: roles('G17', ['multi-vault-edit-trace', 'manual-apply-trace', 'automatic-apply-trace', 'uninstall-retention']) }, passedByGate: { G17: true }, wallClock: WALL, recordedAt: NOW })
  assert.deepEqual(ap05.map(({ receipt, validation }) => [receipt.gate, receipt.outcome, receipt.ext[DESKTOP_EXT_KEY].status, receipt.ext[DESKTOP_EXT_KEY].closes, receipt.ext[DESKTOP_EXT_KEY].humanAcceptance, validation.schemaValid, validation.missing.map((item) => item.code)]), [['G17', 'passed', 'complete', false, null, true, ['acceptance-missing']]], 'complete from automation; the human acceptance is recorded separately by the closing owner')
  const failed = recordProcedureReceipts({ plan: planProcedure('AP-05', { receiptDir: path.join(dir, 'failed'), operator: 'op-synthetic' }), receiptDir: path.join(dir, 'failed'), candidate: CANDIDATE, capabilities: CAPABILITIES, operator: 'op-synthetic', host: HOST, evidenceByGate: { G17: roles('G17', ['multi-vault-edit-trace', 'manual-apply-trace', 'automatic-apply-trace', 'uninstall-retention']) }, passedByGate: { G17: false }, wallClock: WALL, recordedAt: NOW })
  assert.equal(failed[0].receipt.outcome, 'failed')
})

test('the AP-05 scope documents are valid scope contracts, so the real derivation accepts them', async () => {
  const { AP05_SCOPE_DOCUMENTS } = await import('../scripts/obsidian/lib/ap05.mjs')
  for (const scope of AP05_SCOPE_DOCUMENTS) assert.deepEqual(validateObsidianContract('scope', scope), [], scope.scopeId)
})

}
