import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { createLearningStore } from '../src/learning/store.mjs'
import { capabilityEventToLearningInput } from '../src/learning/adapters.mjs'
import { planInstructionAdoption, applyInstructionAdoption, inspectInstructionAdoption, consumeInstructionContext, recoverInstructionAdoption, abandonInstructionAdoption } from '../src/capabilities/instructions.mjs'

const scope = { project: 'invented-workshop', activity: 'summary' }, human = { id: 'fixture-owner', kind: 'human' }
const localTest = (name, fn) => test(name, { skip: process.platform === 'win32' ? 'Instruction writes require the qualified POSIX reference profile.' : false }, fn)
function workspace(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-instructions-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', root]); fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n')
  return root
}
function fixture(t) {
  const root = workspace(t), store = createLearningStore({ workspaceRoot: root, workspaceId: 'fixture' })
  const execute = (operation, input) => store.execute({ requestId: `op-${store.snapshot().revision}`, expectedRevision: store.snapshot().revision, operation, input }, { actor: human }).record
  execute('capture', { id: 'observation', signal: 'user-correction', text: 'The summary hid a known uncertainty.', interpretation: 'explicit', scope, source: { ref: 'manual-entry', digest: null } })
  const lesson = execute('propose', { id: 'preserve-uncertainty', title: 'Preserve material uncertainty', principle: 'Show what remains unknown.', rationale: 'Readers need it to judge the recommendation.', exceptions: ['Do not invent uncertainty when none is identified.'], evidenceIds: ['observation'], scope,
    artifact: { kind: 'instruction', name: 'uncertainty', content: 'When summarizing, retain material uncertainty beside the affected claim.' } })
  const decision = execute('decide', { lessonId: lesson.id, lessonDigest: lesson.digest, verdict: 'accepted', reason: 'Accept this scoped practice.' })
  execute('activate', { id: 'activation', lessonId: lesson.id, lessonDigest: lesson.digest, decisionId: decision.id, harnessId: 'local-summary' })
  const options = { workspaceRoot: root, workspaceId: 'fixture', scope, harnessId: 'local-summary', lessonId: lesson.id, target: 'AGENTS.md', slot: 'summary-uncertainty' }
  return { root, store, execute, options }
}
localTest('scoped practice reaches exact instruction bytes, survives restart and is returned to a consumer', t => {
  const { root, options } = fixture(t)
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Local rules\n\nKeep local terminology.\n')
  const plan = planInstructionAdoption(options)
  assert.ok(plan.after.startsWith('# Local rules\n\nKeep local terminology.\n'))
  assert.match(plan.after, /Do not invent uncertainty/)
  const receipt = applyInstructionAdoption({ ...options, confirm: plan.digest })
  assert.equal(receipt.hostLoaded, false)
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), plan.after)
  assert.equal(inspectInstructionAdoption({ workspaceRoot: root }).bindings[0].status, 'current')
  const consumed = consumeInstructionContext({ ...options, session: 'next-task' })
  assert.match(consumed.context.content, /retain material uncertainty/)
  assert.equal(consumed.receipt.delivery, 'returned-to-calling-consumer')
  assert.equal(consumed.receipt.behaviorVerified, false)
  assert.deepEqual(consumeInstructionContext({ ...options, session: 'next-task' }), consumed)
  assert.throws(() => consumeInstructionContext({ ...options, session: 'wrong-scope', scope: { ...scope, activity: 'inventory' } }), /scoped/)
  assert.equal(applyInstructionAdoption({ ...options, confirm: plan.digest }).duplicate, true)
  assert.throws(() => applyInstructionAdoption({ ...options, slot: 'another', confirm: plan.digest }), /retry input/)
})
localTest('local edits invalidate a prepared plan; unrelated text remains through adoption and withdrawal', t => {
  const { root, execute, options } = fixture(t)
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Local\n')
  const old = planInstructionAdoption(options)
  fs.appendFileSync(path.join(root, 'AGENTS.md'), '\nA concurrent local edit.\n')
  assert.throws(() => applyInstructionAdoption({ ...options, confirm: old.digest }), /exact current/)
  const current = planInstructionAdoption(options)
  applyInstructionAdoption({ ...options, confirm: current.digest })
  execute('withdraw', { activationId: 'activation', reason: 'Reconsider the guidance.' })
  assert.equal(inspectInstructionAdoption({ workspaceRoot: root }).bindings[0].status, 'reconsider')
  assert.throws(() => consumeInstructionContext({ ...options, session: 'after-withdrawal' }), /current scoped/)
  const retire = planInstructionAdoption({ ...options, mode: 'retire' })
  applyInstructionAdoption({ ...options, mode: 'retire', confirm: retire.digest })
  assert.match(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), /A concurrent local edit/)
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), /atelier:practice:/)
})
localTest('existing unmanaged or drifted slots cannot be adopted, and another repository has no adoption', t => {
  const { root, options } = fixture(t), other = workspace(t)
  const plan = planInstructionAdoption(options)
  fs.writeFileSync(path.join(root, 'AGENTS.md'), plan.after)
  assert.throws(() => planInstructionAdoption(options), /unmanaged/)
  fs.unlinkSync(path.join(root, 'AGENTS.md'))
  applyInstructionAdoption({ ...options, confirm: plan.digest })
  fs.writeFileSync(path.join(root, 'AGENTS.md'), plan.after.replace('retain material', 'omit material'))
  assert.throws(() => planInstructionAdoption(options), /drifted/)
  assert.deepEqual(inspectInstructionAdoption({ workspaceRoot: other }).bindings, [])
  assert.throws(() => planInstructionAdoption({ ...options, target: '../AGENTS.md' }), /profile/)
})
localTest('interrupted apply after durable intent resumes through the retained plan', t => {
  const { root, options } = fixture(t), plan = planInstructionAdoption(options)
  // Inject a filesystem failure at the first destination publication, after the
  // durable intent; no test-only production bypass is needed.
  const original = fs.linkSync
  fs.linkSync = (from, to, ...args) => {
    if (to === path.join(root, 'AGENTS.md')) throw Object.assign(new Error('fixture disk fault'), { code: 'ENOSPC' })
    return original(from, to, ...args)
  }
  try { assert.throws(() => applyInstructionAdoption({ ...options, confirm: plan.digest }), /fixture disk fault/) }
  finally { fs.linkSync = original }
  assert.equal(inspectInstructionAdoption({ workspaceRoot: root }).pending.digest, plan.digest)
  assert.equal(recoverInstructionAdoption({ workspaceRoot: root, confirm: plan.digest }).status, 'persisted-and-read-back')
  assert.equal(inspectInstructionAdoption({ workspaceRoot: root }).pending, null)
})
test('capability feedback preserves version pins and never fabricates causal certainty', () => {
  const event = JSON.parse(fs.readFileSync(new URL('../fixtures/atelier-capability-contract/event/valid/document.json', import.meta.url)))
  const input = capabilityEventToLearningInput({ event, scope })
  assert.match(input.text, new RegExp(event.releaseDigest))
  assert.match(input.text, /Original feedback text and causal verification are unavailable/)
  assert.equal(input.interpretation, 'tool')
  assert.equal(input.source.locator, event.evidenceDigest)
  assert.throws(() => capabilityEventToLearningInput({ event: { ...event, releaseDigest: 'wrong' }, scope }), /invalid/)
})

localTest('a writer arriving immediately before exchange retains its bytes at the destination', t => {
  const { root, options } = fixture(t)
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Original\n')
  const plan = planInstructionAdoption(options), chmod = fs.chmodSync
  let injected = false
  fs.chmodSync = (file, mode) => {
    const result = chmod(file, mode)
    if (!injected && String(file).endsWith('/displaced.md')) {
      injected = true; fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Concurrent writer\n')
    }
    return result
  }
  try { assert.throws(() => applyInstructionAdoption({ ...options, confirm: plan.digest }), /concurrent instruction writer/) }
  finally { fs.chmodSync = chmod }
  assert.equal(injected, true)
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), '# Concurrent writer\n')
  assert.equal(inspectInstructionAdoption({ workspaceRoot: root }).pending.digest, plan.digest)
  assert.throws(() => recoverInstructionAdoption({ workspaceRoot: root, confirm: plan.digest }), /destination changed/)
  const inspection = inspectInstructionAdoption({ workspaceRoot: root })
  abandonInstructionAdoption({ workspaceRoot: root, confirm: plan.digest, destinationDigest: inspection.pendingDestinationDigest })
  const next = planInstructionAdoption(options)
  assert.match(next.before, /Concurrent writer/)
  applyInstructionAdoption({ ...options, confirm: next.digest })
  assert.match(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), /Concurrent writer/)
})

localTest('interruption after exchange reconciles durable readback without another destination mutation', t => {
  const { root, options } = fixture(t)
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Original\n')
  const plan = planInstructionAdoption(options), rename = fs.renameSync
  fs.renameSync = (from, to) => {
    if (String(to).endsWith('/instructions/state.json')) throw new Error('fixture state fault')
    return rename(from, to)
  }
  try { assert.throws(() => applyInstructionAdoption({ ...options, confirm: plan.digest }), /fixture state fault/) }
  finally { fs.renameSync = rename }
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), plan.after)
  const inode = fs.statSync(path.join(root, 'AGENTS.md')).ino
  recoverInstructionAdoption({ workspaceRoot: root, confirm: plan.digest })
  assert.equal(fs.statSync(path.join(root, 'AGENTS.md')).ino, inode)
  assert.equal(inspectInstructionAdoption({ workspaceRoot: root }).bindings[0].status, 'current')
})

localTest('a terminated writer is recovered through verified lock custody and destination readback', t => {
  const { root, options } = fixture(t)
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Original\n')
  const plan = planInstructionAdoption(options)
  const moduleUrl = new URL('../src/capabilities/instructions.mjs', import.meta.url).href
  const script = `import fs from 'node:fs'; import {applyInstructionAdoption} from ${JSON.stringify(moduleUrl)};
    const rename=fs.renameSync; fs.renameSync=(from,to)=>{if(String(to).endsWith('/instructions/state.json')) process.exit(73); return rename(from,to)};
    applyInstructionAdoption(JSON.parse(process.argv[1]));`
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify({ ...options, confirm: plan.digest })], { encoding: 'utf8' })
  assert.equal(child.status, 73, child.stderr)
  assert.equal(recoverInstructionAdoption({ workspaceRoot: root, confirm: plan.digest }).status, 'persisted-and-read-back')
  assert.equal(inspectInstructionAdoption({ workspaceRoot: root }).pending, null)
})
