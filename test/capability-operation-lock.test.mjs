import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import test from 'node:test'
import { capabilityWriteTest } from './helpers/capability-write.mjs'
import { inspectCapabilityRecovery, withOperationLock } from '../src/capabilities/adoption.mjs'
import { applyCapabilityAdoption, planCapabilityAdoption, readCapabilityEvents, recordCapabilityEvent } from '../src/capabilities/index.mjs'
import { appendHarness, EMPTY_HARNESS_HEAD, readHarness } from '../src/harnesses/index.mjs'
import { digest } from '../src/capabilities/files.mjs'

const lockRelative = '.atelier-local/skill-steward/.operation.lock'
const lockModule = new URL('../src/capabilities/adoption.mjs', import.meta.url).href
const records = JSON.parse(fs.readFileSync(new URL('../fixtures/harnesses/learning-cycle.json', import.meta.url))).knowledge
function workspace(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-operation-lock-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', root])
  fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n')
  return root
}
function seedLock(root, body) {
  const file = path.join(root, lockRelative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body))
  return file
}
function deadOwner() {
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
  assert.equal(child.status, 0)
  return { owner: 'capability-steward', operationId: randomUUID(), pid: child.pid }
}

for (const afterPublication of [false, true]) capabilityWriteTest(`journal-free harness interruption ${afterPublication ? 'after' : 'before'} publication permits the next append`, t => {
  const root = workspace(t), module = new URL('../src/harnesses/index.mjs', import.meta.url).href
  const input = { workspaceRoot: root, profile: 'knowledge', record: records[0], confirm: EMPTY_HARNESS_HEAD }
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs'; import { appendHarness } from ${JSON.stringify(module)};
    const afterPublication = ${afterPublication};
    const rename = fs.renameSync, unlink = fs.unlinkSync;
    fs.renameSync = (from, to) => { if (!afterPublication && String(to).endsWith('/ledger.json')) process.exit(75); return rename(from, to); };
    fs.unlinkSync = file => { if (afterPublication && String(file).endsWith('/.operation.lock')) process.exit(75); return unlink(file); };
    appendHarness(JSON.parse(process.argv[1]));
  `, JSON.stringify(input)], { encoding: 'utf8' })
  assert.equal(child.status, 75, child.stderr)
  assert.equal(inspectCapabilityRecovery({ workspaceRoot: root }).pending, false)
  assert.equal(fs.existsSync(path.join(root, lockRelative)), true)
  const before = readHarness({ workspaceRoot: root, profile: 'knowledge', run: records[0].run })
  assert.equal(before.records.length, afterPublication ? 1 : 0)
  const record = records[afterPublication ? 1 : 0]
  const appended = appendHarness({ ...input, record, confirm: before.head ?? EMPTY_HARNESS_HEAD })
  const after = readHarness({ workspaceRoot: root, profile: 'knowledge', run: record.run })
  assert.equal(after.head, appended.head)
  assert.deepEqual(after.records, records.slice(0, afterPublication ? 2 : 1))
  assert.equal(fs.existsSync(path.join(root, lockRelative)), false)
})

capabilityWriteTest('journal-free capability event interruption preserves the committed event and permits another event', t => {
  const root = workspace(t), packageRoot = fileURLToPath(new URL('../fixtures/capability-packages/evidence-review/', import.meta.url))
  const release = JSON.parse(fs.readFileSync(path.join(packageRoot, 'capability-release.json')))
  const settings = { workspaceRoot: root, sources: [packageRoot], adoption: {
    schema: 'mnstry.atelier-capability-adoption@v1', id: 'example-workspace', packages: [{ id: release.package.id, digest: release.digest, mode: 'managed',
      bindings: [{ skill: 'review', host: 'codex-repo-v1', alias: 'evidence-review' }], allowedTools: [], allowedEffects: ['read-workspace'] }],
  } }
  const plan = planCapabilityAdoption(settings)
  const { state } = applyCapabilityAdoption({ ...settings, confirm: plan.planDigest })
  const item = state.packages[0], binding = item.bindings[0]
  const event = { schema: 'mnstry.atelier-capability-event@v1', id: 'first-event', kind: 'exercise', package: item.id, releaseDigest: item.release.digest,
    generation: state.generation, binding: binding.target, bindingDigest: binding.digest, host: binding.host, session: 'example-session', observer: 'fixture',
    outcome: 'unknown', cause: 'unknown', evidenceDigest: digest('invented evidence'), at: '2026-01-01T00:00:00Z' }
  const module = new URL('../src/capabilities/evidence.mjs', import.meta.url).href
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs'; import { recordCapabilityEvent } from ${JSON.stringify(module)};
    const unlink = fs.unlinkSync;
    fs.unlinkSync = file => { if (String(file).endsWith('/.operation.lock')) process.exit(75); return unlink(file); };
    recordCapabilityEvent(JSON.parse(process.argv[1]));
  `, JSON.stringify({ workspaceRoot: root, event })], { encoding: 'utf8' })
  assert.equal(child.status, 75, child.stderr)
  assert.equal(inspectCapabilityRecovery({ workspaceRoot: root }).pending, false)
  assert.deepEqual(readCapabilityEvents({ workspaceRoot: root }), [event])
  recordCapabilityEvent({ workspaceRoot: root, event: { ...event, id: 'second-event' } })
  assert.equal(readCapabilityEvents({ workspaceRoot: root }).length, 2)
  assert.equal(fs.existsSync(path.join(root, lockRelative)), false)
})

test('dead recognizable legacy capability owner is reclaimed without a journal', t => {
  const root = workspace(t), file = seedLock(root, deadOwner())
  assert.equal(withOperationLock(root, () => 'completed'), 'completed')
  assert.equal(fs.existsSync(file), false)
})

test('live, unknown and unreadable legacy owners remain untouched', t => {
  const root = workspace(t)
  for (const body of [
    { owner: 'capability-steward', operationId: randomUUID(), pid: process.pid },
    { ...deadOwner(), owner: 'unknown-steward' },
    { ...deadOwner(), operationId: 'unknown' },
    { ...deadOwner(), pid: 0 },
    'legacy operation',
  ]) {
    const file = seedLock(root, body), before = fs.readFileSync(file)
    assert.throws(() => withOperationLock(root, () => assert.fail('must not enter')), /EEXIST/)
    assert.deepEqual(fs.readFileSync(file), before)
  }
})

test('a reused PID or unavailable owner identity does not permit reclamation', t => {
  const root = workspace(t), owner = deadOwner(), file = seedLock(root, owner), before = fs.readFileSync(file)
  const kill = process.kill
  try {
    process.kill = () => true
    assert.throws(() => withOperationLock(root, () => assert.fail('must not enter')), /still alive/)
    process.kill = () => { throw Object.assign(new Error('identity unavailable'), { code: 'EPERM' }) }
    assert.throws(() => withOperationLock(root, () => assert.fail('must not enter')), /identity is unavailable/)
  } finally { process.kill = kill }
  assert.deepEqual(fs.readFileSync(file), before)
})

test('replacement during owner inspection is retained and prevents entry', t => {
  const root = workspace(t), owner = deadOwner(), file = seedLock(root, owner)
  const replacement = JSON.stringify({ owner: 'another-writer', pid: process.pid })
  const kill = process.kill
  let checks = 0
  try {
    process.kill = (pid, signal) => {
      if (pid === owner.pid && ++checks === 2) fs.writeFileSync(file, replacement)
      return kill(pid, signal)
    }
    assert.throws(() => withOperationLock(root, () => assert.fail('must not enter')), /changed before reclamation/)
  } finally { process.kill = kill }
  assert.equal(fs.readFileSync(file, 'utf8'), replacement)
})

test('cleanup preserves a replacement file even if it copies the prior owner bytes', t => {
  const root = workspace(t), file = path.join(root, lockRelative)
  withOperationLock(root, () => {
    const bytes = fs.readFileSync(file)
    fs.renameSync(file, `${file}.previous`)
    fs.writeFileSync(file, bytes)
  })
  assert.deepEqual(fs.readFileSync(file), fs.readFileSync(`${file}.previous`))
})

test('a replacement during lock publication prevents entry and is preserved', t => {
  const root = workspace(t), file = path.join(root, lockRelative), replacement = 'unknown replacement owner'
  const sync = fs.fsyncSync
  let replaced = false
  try {
    fs.fsyncSync = fd => {
      const result = sync(fd), opened = fs.fstatSync(fd)
      if (!replaced && opened.isFile() && fs.existsSync(file) && opened.ino === fs.lstatSync(file).ino) {
        replaced = true
        fs.renameSync(file, `${file}.previous`)
        fs.writeFileSync(file, replacement)
      }
      return result
    }
    assert.throws(() => withOperationLock(root, () => assert.fail('must not enter')), /changed before the operation/)
  } finally { fs.fsyncSync = sync }
  assert.equal(replaced, true)
  assert.equal(fs.readFileSync(file, 'utf8'), replacement)
})

test('missing lock cleanup preserves the callback error and permits a later acquisition', t => {
  const root = workspace(t), failure = new Error('original operation failure')
  assert.throws(() => withOperationLock(root, () => {
    fs.unlinkSync(path.join(root, lockRelative))
    throw failure
  }), error => error === failure)
  assert.equal(withOperationLock(root, () => 'continued'), 'continued')
})

test('a stale lock removed by a competing recoverer during inspection refuses as locked', t => {
  const root = workspace(t)
  const dead = spawnSync(process.execPath, ['-e', '']).pid
  const file = seedLock(root, { owner: 'capability-steward', pid: dead, operationId: randomUUID() })
  const open = fs.openSync
  let removed = false
  try {
    fs.openSync = (target, ...rest) => {
      if (!removed && target === file) { removed = true; fs.unlinkSync(file) }
      return open(target, ...rest)
    }
    assert.throws(() => withOperationLock(root, () => assert.fail('must not enter')),
      error => error.code === 'EEXIST' && /changed during inspection/.test(error.message))
  } finally { fs.openSync = open }
  assert.equal(removed, true)
})

test('a stale lock replaced by a competing recoverer during inspection refuses as locked and keeps the replacement', t => {
  const root = workspace(t)
  const dead = spawnSync(process.execPath, ['-e', '']).pid
  const file = seedLock(root, { owner: 'capability-steward', pid: dead, operationId: randomUUID() })
  const replacement = JSON.stringify({ owner: 'capability-steward', pid: process.pid, operationId: randomUUID() })
  const open = fs.openSync
  let replaced = false
  try {
    fs.openSync = (target, ...rest) => {
      if (!replaced && target === file) { replaced = true; fs.renameSync(file, `${file}.crashed`); fs.writeFileSync(file, replacement) }
      return open(target, ...rest)
    }
    assert.throws(() => withOperationLock(root, () => assert.fail('must not enter')),
      error => error.code === 'EEXIST' && /changed during inspection/.test(error.message))
  } finally { fs.openSync = open }
  assert.equal(replaced, true)
  assert.equal(fs.readFileSync(file, 'utf8'), replacement)
})

test('competing recoverers admit one writer after a journal-free process crash', async t => {
  const root = workspace(t)
  const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { withOperationLock } from ${JSON.stringify(lockModule)};
    withOperationLock(process.argv[1], () => process.exit(75));
  `, root])
  assert.equal(crashed.status, 75)
  const script = `import fs from 'node:fs'; import { withOperationLock } from ${JSON.stringify(lockModule)};
    process.on('message', () => { try {
      withOperationLock(process.argv[1], () => {
        fs.appendFileSync(process.argv[2], 'one writer\\n');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      }); process.exit(0);
    } catch (error) { process.exit(error.code === 'EEXIST' ? 23 : 24); } });
    process.send('ready');`
  const effect = path.join(root, 'effects.txt')
  const children = [0, 1].map(() => spawn(process.execPath, ['--input-type=module', '-e', script, root, effect], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }))
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill() })
  const exits = children.map(child => new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }))
  await Promise.all(children.map(child => new Promise(resolve => child.once('message', resolve))))
  for (const child of children) child.send('go')
  assert.deepEqual((await Promise.all(exits)).sort((a, b) => a - b), [0, 23])
  assert.equal(fs.readFileSync(effect, 'utf8'), 'one writer\n')
  assert.equal(fs.existsSync(path.join(root, lockRelative)), false)
})

// Replace the lock when a named caller opens it for reading, as a competing
// writer would between that caller's stat and its read. Write opens (flags with
// an access mode other than read-only) are never intercepted.
const READ_ACCESS = 3
function replaceOnRead(t, file, caller, replacement, { remove = false } = {}) {
  const open = fs.openSync
  let replaced = false
  fs.openSync = (target, flags, ...rest) => {
    if (!replaced && target === file && ((flags ?? 0) & READ_ACCESS) === 0 && fs.existsSync(file) && caller(new Error().stack)) {
      replaced = true
      if (remove) fs.unlinkSync(file)
      else { fs.renameSync(file, `${file}.displaced`); fs.writeFileSync(file, replacement) }
    }
    return open(target, flags, ...rest)
  }
  const restore = () => { fs.openSync = open }
  t.after(restore)
  return { restore, replaced: () => replaced }
}
const inRemoval = stack => /removeOperationLock/.test(stack)
const inReadback = stack => /readOperationLock/.test(stack) && !/removeOperationLock/.test(stack) && /withOperationLock/.test(stack)
const liveReplacement = () => JSON.stringify({ owner: 'another-writer', pid: process.pid, operationId: randomUUID() })
function assertReleasedAfterRemoving(root, file) {
  fs.rmSync(file, { force: true })
  assert.equal(withOperationLock(root, () => 'acquired again'), 'acquired again')
}

test('a replacement while reclaiming a dead owner prevents entry, survives and releases the ticket', t => {
  const root = workspace(t), file = seedLock(root, deadOwner()), replacement = liveReplacement()
  const hook = replaceOnRead(t, file, inRemoval, replacement)
  let entered = false
  assert.throws(() => withOperationLock(root, () => { entered = true }), error => error.code === 'EEXIST' && /changed/.test(error.message))
  hook.restore()
  assert.equal(hook.replaced(), true)
  assert.equal(entered, false)
  assert.equal(fs.readFileSync(file, 'utf8'), replacement)
  assertReleasedAfterRemoving(root, file)
})

test('a replacement during the post-install readback prevents entry, survives and releases the ticket', t => {
  const root = workspace(t), file = path.join(root, lockRelative), replacement = liveReplacement()
  // Only the readback sees this process's own freshly installed lock.
  const ownLock = stack => inReadback(stack) && JSON.parse(fs.readFileSync(file, 'utf8')).owner === 'capability-steward'
  const hook = replaceOnRead(t, file, ownLock, replacement)
  let entered = false
  assert.throws(() => withOperationLock(root, () => { entered = true }), error => error.code === 'EEXIST' && /changed/.test(error.message))
  hook.restore()
  assert.equal(hook.replaced(), true)
  assert.equal(entered, false)
  assert.equal(fs.readFileSync(file, 'utf8'), replacement)
  assertReleasedAfterRemoving(root, file)
})

test('a replacement during cleanup after a committed callback is preserved and does not report the operation as not entered', t => {
  const root = workspace(t), file = path.join(root, lockRelative), replacement = liveReplacement()
  let hook
  // The callback commits, then a competing writer replaces the lock while
  // cleanup inspects it. EEXIST means "not entered"; it must not follow a commit.
  const result = withOperationLock(root, () => { hook = replaceOnRead(t, file, inRemoval, replacement); return 'committed' })
  hook.restore()
  assert.equal(result, 'committed')
  assert.equal(hook.replaced(), true)
  assert.equal(fs.readFileSync(file, 'utf8'), replacement)
  assertReleasedAfterRemoving(root, file)
})

test('a lock removed during cleanup after a committed callback still returns the committed result', t => {
  const root = workspace(t), file = path.join(root, lockRelative)
  let hook
  const result = withOperationLock(root, () => { hook = replaceOnRead(t, file, inRemoval, null, { remove: true }); return 'committed' })
  hook.restore()
  assert.equal(result, 'committed')
  assert.equal(hook.replaced(), true)
  assert.equal(fs.existsSync(file), false)
  assert.equal(withOperationLock(root, () => 'acquired again'), 'acquired again')
})
