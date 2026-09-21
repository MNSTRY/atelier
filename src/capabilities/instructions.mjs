import fs from 'node:fs'
import { createLearningStore } from '../learning/store.mjs'
import { boundedLearningValue, learningDigest } from '../learning/contracts.mjs'
import { bytesAt, digest, jsonAt, replaceJson, stat, within, workspaceRoot, writeNew } from './files.mjs'
import { syncPrivateDirectory } from '../project/private-state.mjs'
import { publishPrivateFile, withPrivateLock } from '../project/durable-state.mjs'
import { exchangeFiles, probeExchange } from '../projection/obsidian/publication/exchange.mjs'
import path from 'node:path'
import Ajv from 'ajv/dist/2020.js'

const instructionSchema = JSON.parse(fs.readFileSync(new URL('../../contracts/atelier-instruction-adoption.v1.schema.json', import.meta.url)))
const validateDocument = new Ajv({ strict: true, allErrors: true }).compile(instructionSchema)
export function validateInstructionAdoption(value) {
  try { boundedLearningValue(value) } catch (error) { return [error.message] }
  return validateDocument(value) ? [] : validateDocument.errors.map(e => `${e.instancePath || '/'}: ${e.message}`)
}
function assertDocument(value) {
  const errors = validateInstructionAdoption(value)
  if (errors.length) throw new Error(`invalid instruction document: ${errors.slice(0, 3).join('; ')}`)
  return value
}

const BASE = '.atelier-local/capabilities/instructions'
const STATE = `${BASE}/state.json`, ACTIVE = `${BASE}/active.json`
function withOperationLock(root, operation) {
  within(root, BASE, { directory: true, create: true })
  return withPrivateLock(within(root, `${BASE}/operation.lock`), operation)
}
const identifier = /^[a-z][a-z0-9-]{0,63}$/
const clone = value => structuredClone(value)
const seal = value => assertDocument({ ...value, digest: learningDigest(value) })
function verified(value, label) {
  assertDocument(value)
  const { digest: actual, ...body } = boundedLearningValue(value)
  if (actual !== learningDigest(body)) throw new Error(`${label} integrity mismatch`)
  return value
}
function readText(root, target) {
  const file = within(root, target)
  return stat(file) ? new TextDecoder('utf-8', { fatal: true }).decode(bytesAt(root, target)) : null
}
function stateAt(root) {
  const state = stat(within(root, STATE)) ? verified(jsonAt(root, STATE), 'instruction state') : seal({ schema: 'atelier-instruction-state@v1', workspace: digest(root), revision: 0, bindings: [] })
  if (state.schema !== 'atelier-instruction-state@v1' || state.workspace !== digest(root) || !Array.isArray(state.bindings) || !Number.isSafeInteger(state.revision)) throw new Error('invalid instruction state')
  return state
}
function activeAt(root) {
  return stat(within(root, ACTIVE)) ? verified(jsonAt(root, ACTIVE), 'instruction transaction') : null
}
function inputOf(options) {
  const { workspaceId, scope, harnessId, lessonId, target, slot, mode = 'adopt' } = options
  const input = boundedLearningValue({ workspaceId, scope, harnessId, lessonId, target, slot, mode })
  if (!identifier.test(slot) || !['adopt', 'retire'].includes(mode) || typeof target !== 'string' ||
    !/^(?:[A-Za-z0-9_-]+\/)*(?:AGENTS|CLAUDE)\.md$/.test(target)) throw new Error('instruction profile requires a scoped AGENTS.md or CLAUDE.md and stable slot')
  return input
}
function markers(slot) { return [`<!-- atelier:practice:${slot}:start -->`, `<!-- atelier:practice:${slot}:end -->`] }
function blockOf(text, slot) {
  const [start, end] = markers(slot), a = text?.indexOf(start) ?? -1, b = text?.indexOf(end) ?? -1
  if (a === -1 && b === -1) return null
  if (a === -1 || b === -1 || b < a || text.indexOf(start, a + 1) !== -1 || text.indexOf(end, b + 1) !== -1) throw new Error('instruction markers are ambiguous')
  return text.slice(a, b + end.length)
}
function selected(root, input) {
  const store = createLearningStore({ workspaceRoot: root, workspaceId: input.workspaceId })
  const context = store.context({ scope: input.scope, harnessId: input.harnessId })
  const lesson = context.lessons.find(item => item.id === input.lessonId)
  if (!lesson || lesson.artifact.kind !== 'instruction') throw new Error('instruction requires current, scoped, explicitly activated learning')
  if ([lesson.artifact.content, ...lesson.exceptions].some(text => text.includes('<!-- atelier:practice:'))) throw new Error('reserved instruction marker in guidance')
  return { context, lesson }
}
function prepare(root, options) {
  const input = inputOf(options), state = stateAt(root)
  if (activeAt(root)) throw new Error('unfinished instruction adoption; recover first')
  const previous = state.bindings.find(b => b.target.toLowerCase() === input.target.toLowerCase() && b.slot === input.slot)
  if (previous && (previous.target !== input.target || previous.workspaceId !== input.workspaceId || previous.harnessId !== input.harnessId || learningDigest(previous.scope) !== learningDigest(input.scope))) throw new Error('instruction slot has another owner or scope')
  if (state.bindings.length >= 128 && !previous) throw new Error('instruction binding ceiling reached')
  const before = readText(root, input.target), oldBlock = blockOf(before, input.slot)
  if ((previous?.block ?? null) !== oldBlock) throw new Error('instruction slot is unmanaged or drifted')
  let pin = previous?.pin ?? null, block = null, learningRevision = null
  if (input.mode === 'adopt') {
    const { context, lesson } = selected(root, input)
    learningRevision = context.revision
    pin = { lessonId: lesson.id, lessonDigest: lesson.lessonDigest, artifactDigest: lesson.artifact.digest, activationId: lesson.activationId, decisionId: lesson.decisionId }
    const [start, end] = markers(input.slot)
    block = [start, `Scope: project ${input.scope.project}; activity ${input.scope.activity}; harness ${input.harnessId}.`,
      `Practice: ${lesson.id} (${lesson.lessonDigest}). Apply only in this scope; host instructions and tool permissions retain their precedence.`, '',
      lesson.artifact.content, '', 'Exceptions:', ...lesson.exceptions.map(e => `- ${e}`), end].join('\n')
  } else if (!previous || previous.pin.lessonId !== input.lessonId) throw new Error('retirement requires the exact owned lesson')
  const after = oldBlock ? before.replace(oldBlock, block ?? '') : `${before ?? ''}${before && !before.endsWith('\n') ? '\n' : ''}${block}\n`
  const binding = { ...input, pin, block, blockDigest: block === null ? null : digest(block) }
  const bindings = state.bindings.filter(b => !(b.target === input.target && b.slot === input.slot))
  if (block !== null) bindings.push(binding)
  const { digest: ignoredDigest, ...stateBody } = state
  const next = seal({ ...stateBody, revision: state.revision + 1, bindings })
  return seal({ schema: 'atelier-instruction-plan@v1', workspace: digest(root), input, previousState: state.digest, nextState: next,
    learningRevision, pin, before, beforeDigest: before === null ? null : digest(before), after, afterDigest: digest(after),
    effect: 'write-scoped-instruction-guidance', precedence: 'host-owned', authenticated: false })
}
export function planInstructionAdoption(options) {
  return prepare(workspaceRoot(options.workspaceRoot, { write: true }), options)
}
function assertCurrentLearning(root, plan) {
  if (plan.input.mode === 'retire') return
  const { lesson } = selected(root, plan.input)
  if (lesson.lessonDigest !== plan.pin.lessonDigest || lesson.activationId !== plan.pin.activationId || lesson.decisionId !== plan.pin.decisionId) throw new Error('instruction practice is no longer eligible')
}
function finish(root, plan) {
  verified(plan, 'instruction plan'); inputOf(plan.input)
  if (plan.workspace !== digest(root)) throw new Error('instruction plan belongs to another workspace')
  const current = readText(root, plan.input.target), state = stateAt(root)
  if (![plan.previousState, plan.nextState.digest].includes(state.digest)) throw new Error('instruction state changed during recovery')
  if (current !== plan.before && current !== plan.after) throw new Error('instruction destination changed; preserve edits and reconcile')
  if (current === plan.after && plan.before !== null && readText(root, `${BASE}/recovery/${plan.digest.slice(7)}/displaced.md`) !== plan.before) throw new Error('displaced instruction source requires reconciliation')
  // A completed write can be recorded even after withdrawal; inspection then
  // reports reconsideration and an explicit retirement reconciles the file.
  if (current !== plan.after) {
    assertCurrentLearning(root, plan)
    const target = within(root, plan.input.target)
    const parent = plan.input.target.split('/').slice(0, -1).join('/')
    if (parent) within(root, parent, { directory: true, create: true })
    if (readText(root, plan.input.target) !== plan.before) throw new Error('instruction destination changed before write')
    if (plan.before === null) {
      // Non-overwriting publication: a concurrent create refuses.
      publishPrivateFile(target, plan.after)
    } else {
      const recovery = `${BASE}/recovery/${plan.digest.slice(7)}`
      const directory = within(root, recovery, { directory: true, create: true })
      const candidatePath = within(root, `${recovery}/displaced.md`)
      const probe = probeExchange({ directory })
      if (!probe.supported || fs.statSync(directory).dev !== fs.statSync(path.dirname(target)).dev) throw new Error('instruction atomic exchange unavailable on this volume')
      if (fs.lstatSync(target).nlink !== 1) throw new Error('hard-linked instruction destination refused')
      if (!stat(candidatePath)) writeNew(root, `${recovery}/displaced.md`, plan.after)
      if (readText(root, `${recovery}/displaced.md`) !== plan.after) throw new Error('retained displaced source requires reconciliation')
      fs.chmodSync(candidatePath, fs.statSync(target).mode & 0o777)
      exchangeFiles(candidatePath, target)
      syncPrivateDirectory(directory); syncPrivateDirectory(path.dirname(target))
      const displaced = readText(root, `${recovery}/displaced.md`)
      if (displaced !== plan.before) {
        // Retain the displaced writer before exchanging back. Further writers
        // can change either path; both sides remain in the recovery directory.
        writeNew(root, `${recovery}/concurrent-${digest(displaced).slice(7)}.md`, displaced)
        if (readText(root, plan.input.target) === plan.after) {
          exchangeFiles(candidatePath, target)
          syncPrivateDirectory(directory); syncPrivateDirectory(path.dirname(target))
        }
        throw new Error('concurrent instruction writer; retained bytes require reconciliation')
      }
    }
  }
  if (readText(root, plan.input.target) !== plan.after) throw new Error('instruction readback mismatch')
  if (state.digest !== plan.nextState.digest) replaceJson(root, STATE, plan.nextState)
  const receipt = seal({ schema: 'atelier-instruction-receipt@v1', workspace: digest(root), planDigest: plan.digest,
    target: plan.input.target, slot: plan.input.slot, pin: plan.pin, mode: plan.input.mode, resultDigest: plan.afterDigest,
    stateDigest: plan.nextState.digest, status: 'persisted-and-read-back', hostLoaded: false, behaviorVerified: false })
  const receiptPath = `${BASE}/receipts/${plan.digest.slice(7)}.json`
  if (stat(within(root, receiptPath))) {
    if (learningDigest(jsonAt(root, receiptPath)) !== learningDigest(receipt)) throw new Error('instruction receipt differs')
  } else writeNew(root, receiptPath, JSON.stringify(receipt, null, 2) + '\n')
  fs.unlinkSync(within(root, ACTIVE)); syncPrivateDirectory(path.dirname(within(root, ACTIVE)))
  return receipt
}
export function applyInstructionAdoption(options) {
  const root = workspaceRoot(options.workspaceRoot, { write: true })
  return withOperationLock(root, () => {
    const pending = activeAt(root)
    if (pending) {
      if (pending.digest !== options.confirm || learningDigest(inputOf(options)) !== learningDigest(pending.input)) throw new Error('another instruction transaction requires recovery')
      return finish(root, pending)
    }
    if (/^sha256:[a-f0-9]{64}$/.test(options.confirm ?? '')) {
      const receiptPath = `${BASE}/receipts/${options.confirm.slice(7)}.json`
      if (stat(within(root, receiptPath))) {
        const receipt = verified(jsonAt(root, receiptPath), 'instruction receipt')
        const recordedPlan = verified(jsonAt(root, `${BASE}/plans/${options.confirm.slice(7)}.json`), 'instruction plan')
        if (learningDigest(inputOf(options)) !== learningDigest(recordedPlan.input)) throw new Error('instruction retry input differs')
        return { ...receipt, duplicate: true, currentDestinationDigest: readText(root, receipt.target) === null ? null : digest(readText(root, receipt.target)) }
      }
    }
    const plan = prepare(root, options)
    if (plan.digest !== options.confirm) throw new Error('instruction adoption requires the exact current plan digest')
    const planFile = `${BASE}/plans/${plan.digest.slice(7)}.json`
    if (stat(within(root, planFile))) {
      if (learningDigest(jsonAt(root, planFile)) !== learningDigest(plan)) throw new Error('retained plan differs')
    } else writeNew(root, planFile, JSON.stringify(plan, null, 2) + '\n')
    replaceJson(root, ACTIVE, plan)
    return finish(root, plan)
  })
}
export function recoverInstructionAdoption({ workspaceRoot: input, confirm }) {
  const root = workspaceRoot(input, { write: true })
  return withOperationLock(root, () => {
    const plan = activeAt(root)
    if (!plan || plan.digest !== confirm) throw new Error('recovery requires the exact pending instruction plan digest')
    return finish(root, plan)
  })
}
export function abandonInstructionAdoption({ workspaceRoot: input, confirm, destinationDigest }) {
  const root = workspaceRoot(input, { write: true })
  return withOperationLock(root, () => {
    const plan = activeAt(root)
    if (!plan || plan.digest !== confirm) throw new Error('abandonment requires the exact pending instruction plan digest')
    const current = readText(root, plan.input.target), actual = current === null ? null : digest(current)
    if (actual !== destinationDigest) throw new Error('destination changed since abandonment inspection')
    if (current === plan.after || stateAt(root).digest !== plan.previousState) throw new Error('reconcile the applied instruction before retirement')
    const record = { schema: 'atelier-instruction-abandonment@v1', planDigest: plan.digest, destinationDigest: actual,
      stateDigest: plan.previousState, sourceMutation: false, retainedRecovery: `${BASE}/recovery/${plan.digest.slice(7)}` }
    const file = `${BASE}/abandoned/${plan.digest.slice(7)}.json`
    if (stat(within(root, file))) {
      if (learningDigest(jsonAt(root, file)) !== learningDigest(record)) throw new Error('prior abandonment has a different destination')
    } else writeNew(root, file, JSON.stringify(record, null, 2) + '\n')
    fs.unlinkSync(within(root, ACTIVE)); syncPrivateDirectory(path.dirname(within(root, ACTIVE)))
    return record
  })
}
export function inspectInstructionAdoption({ workspaceRoot: input }) {
  const root = workspaceRoot(input), state = stateAt(root)
  const bindings = state.bindings.map(binding => {
    let status = 'current', reason = null
    try {
      if (blockOf(readText(root, binding.target), binding.slot) !== binding.block) throw new Error('destination drift')
      const { lesson } = selected(root, binding)
      if (lesson.lessonDigest !== binding.pin.lessonDigest || lesson.activationId !== binding.pin.activationId) throw new Error('practice revised')
    } catch (error) { status = 'reconsider'; reason = error.message }
    return { ...clone(binding), status, reason, hostLoaded: 'unverified' }
  })
  const pending = activeAt(root)
  const text = pending ? readText(root, pending.input.target) : null
  return { schema: 'atelier-instruction-status@v1', revision: state.revision, pending, pendingDestinationDigest: text === null ? null : digest(text), bindings }
}
// Host integration seam. This returns verified selected guidance and records what
// the consumer actually received. It cannot prove that an agent obeyed the text.
export function consumeInstructionContext({ workspaceRoot: input, target, slot, session, scope, harnessId }) {
  if (!identifier.test(session)) throw new Error('bounded session identity required')
  const root = workspaceRoot(input, { write: true })
  return withOperationLock(root, () => {
    if (activeAt(root)) throw new Error('instruction adoption is unsettled')
    const binding = inspectInstructionAdoption({ workspaceRoot: root }).bindings.find(b => b.target === target && b.slot === slot)
    if (!binding || binding.status !== 'current' || binding.harnessId !== harnessId || learningDigest(scope) !== learningDigest(binding.scope)) throw new Error('current scoped instruction binding required')
    const { lesson } = selected(root, binding)
    const context = { content: lesson.artifact.content, exceptions: lesson.exceptions, scope: binding.scope, pin: binding.pin }
    const receipt = seal({ schema: 'atelier-instruction-context-receipt@v1', session, target, slot, pin: binding.pin,
      contextDigest: learningDigest(context), delivery: 'returned-to-calling-consumer', behaviorVerified: false })
    const file = `${BASE}/use/${receipt.digest.slice(7)}.json`
    if (!stat(within(root, file))) writeNew(root, file, JSON.stringify(receipt, null, 2) + '\n')
    return { context, receipt }
  })
}
