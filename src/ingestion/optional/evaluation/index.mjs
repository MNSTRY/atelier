import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'

// Private Q02 execution/assessment sidecar. Existing intake and knowledge owners
// retain all authoritative records; this module grants no execution permission.
export const PRESENCE_PROFILES = Object.freeze(['vanilla', 'graphify', 'lightrag', 'jev',
  'graphify+lightrag', 'graphify+jev', 'lightrag+jev', 'graphify+lightrag+jev'])
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const phases = new Set(['cold', 'incremental', 'warm', 'recovery'])
const terminalStates = new Set(['completed', 'failed', 'unavailable', 'unsupported', 'not-run', 'uncertain'])
const numberOrNull = value => value === null || Number.isFinite(value) && value >= 0
const requiredPins = ['installedCandidate', 'corpusDigest', 'targetsDigest', 'routeDigest', 'questionOrderDigest']

export function validateExecutionPlan(plan) {
  if (!plan || requiredPins.some(key => typeof plan[key] !== 'string' || !plan[key]) ||
    !Array.isArray(plan.tasks) || !plan.tasks.length) throw new TypeError('Pinned installed target, frozen inputs and explicit task cohort required')
  const ids = new Set()
  for (const task of plan.tasks) {
    if (!task?.id || ids.has(task.id) || !PRESENCE_PROFILES.includes(task.profile) ||
      !phases.has(task.phase) || !task.routeId || !Number.isSafeInteger(task.repetition) || task.repetition < 1 ||
      !task.questionId || !task.cacheState) throw new TypeError('Unique tasks require profile, phase, route, repetition, question and cache state')
    ids.add(task.id)
  }
  return Object.freeze(structuredClone(plan))
}

// Host returns all attempted components, including failures and fallback. Unknown
// or omitted required charges remain unknown rather than becoming free work.
export function accountComponents(components) {
  if (!Array.isArray(components)) throw new TypeError('Explicit accounting components required')
  const currencies = new Set(), ids = new Set()
  let knownSubtotal = 0, unknown = false
  for (const item of components) {
    if (!item?.id || ids.has(item.id) || !item.kind || !numberOrNull(item.cost) ||
      !numberOrNull(item.elapsedMs) || typeof item.complete !== 'boolean') throw new TypeError('Unique valid attempted cost components required')
    ids.add(item.id)
    if (item.currency !== null && !/^[A-Z]{3}$/.test(item.currency ?? '')) throw new TypeError('Explicit currency or null required')
    if (item.cost === null || !item.complete) unknown = true
    else knownSubtotal += item.cost
    if (item.cost !== null && item.cost !== 0 && item.currency === null) unknown = true
    if (item.currency !== null) currencies.add(item.currency)
  }
  if (!components.length || currencies.size > 1) unknown = true
  return { totalCost: unknown ? null : knownSubtotal, knownSubtotal,
    currency: currencies.size === 1 ? [...currencies][0] : null,
    complete: !unknown, attemptedComponents: components.length,
    incompleteComponents: components.filter(x => x.cost === null || !x.complete).map(x => x.id),
    unknownOrMixedCurrency: currencies.size > 1 || components.some(x => x.cost !== null && x.cost !== 0 && x.currency === null) }
}

// Separate existing assessor receipts are verified by a trusted receiving host.
// Producer-supplied assessment fields never enter the useful-answer numerator.
export function assessmentBinding(record) {
  return { taskId: record.taskId, planDigest: record.planDigest, questionId: record.questionId,
    routeId: record.routeId, resultDigest: record.resultDigest }
}
function assessmentReceived(record, receipt, verifyAssessment) {
  if (record.outcome !== 'completed' || typeof verifyAssessment !== 'function' || !receipt) return false
  const binding = assessmentBinding(record)
  if (Object.values(binding).some(x => typeof x !== 'string' || !x) ||
    !receipt.receiptRef || !receipt.assessorRef || !receipt.rubricRef || receipt.bindingDigest !== digest(binding)) return false
  try {
    const verified = verifyAssessment(structuredClone(receipt), structuredClone(binding))
    if (typeof verified?.then === 'function') { Promise.resolve(verified).catch(() => {}); return false }
    return verified?.verified === true && verified?.current === true && !!verified.ownerRef &&
      verified.receiptRef === receipt.receiptRef && verified.bindingDigest === receipt.bindingDigest &&
      receipt.usefulAccepted === true && receipt.supportAccepted === true
  } catch { return false }
}

export function summarizeCohort({ assignedTaskIds, records, sharedComponents = [], assessmentReceipts = [], verifyAssessment }) {
  if (!Array.isArray(assignedTaskIds) || !assignedTaskIds.length || new Set(assignedTaskIds).size !== assignedTaskIds.length ||
    !Array.isArray(records) || !Array.isArray(assessmentReceipts)) throw new TypeError('Complete assigned denominator required')
  const assigned = new Set(assignedTaskIds), observed = new Set(), assessmentTasks = new Set()
  for (const record of records) {
    if (!assigned.has(record.taskId) || observed.has(record.taskId) || !terminalStates.has(record.outcome)) throw new TypeError('Records must uniquely match the assigned cohort')
    observed.add(record.taskId)
  }
  for (const receipt of assessmentReceipts) {
    if (!assigned.has(receipt?.taskId) || assessmentTasks.has(receipt.taskId)) throw new TypeError('Separate assessor receipts must uniquely match assigned tasks')
    assessmentTasks.add(receipt.taskId)
  }
  const useful = records.filter(record => assessmentReceived(record, assessmentReceipts.find(x => x.taskId === record.taskId), verifyAssessment))
  const costs = [...sharedComponents, ...records.flatMap(x => x.components ?? [])]
  let accounting
  try { accounting = accountComponents(costs) }
  catch (error) {
    // Retain malformed/colliding accounting for reconciliation without losing
    // already executed tasks or treating unverified charges as free work.
    accounting = { totalCost: null, knownSubtotal: null, currency: null, complete: false,
      attemptedComponents: costs.length, accountingIssue: error.message, retainedComponents: costs }
  }
  const missing = assignedTaskIds.filter(id => !observed.has(id))
  const complete = !missing.length && records.every(x => Array.isArray(x.components) && x.components.length)
  const totalCost = complete ? accounting.totalCost : null
  return { assigned: assigned.size, observed: observed.size, missing,
    usefulAccepted: useful.length, usefulAcceptedFraction: useful.length / assigned.size,
    failedOrUnavailable: assigned.size - useful.length, accounting: { ...accounting, complete: complete && accounting.complete, totalCost },
    costPerUsefulAcceptedAnswer: totalCost === null || !useful.length ? null : totalCost / useful.length,
    elapsedObservations: records.map(x => ({ taskId: x.taskId, outcome: x.outcome, elapsedMs: x.elapsedMs ?? null })),
    semanticQualityQualified: false, humanAuthorityVerified: false }
}

export function amortizedCosts({ ingestionComponents, queryComponents, queryCounts = [1, 10, 100] }) {
  const initial = accountComponents(ingestionComponents), query = accountComponents(queryComponents)
  return queryCounts.map(count => {
    if (!Number.isSafeInteger(count) || count < 1) throw new TypeError('Positive predeclared query counts required')
    const compatible = initial.currency === query.currency || initial.totalCost === 0 || query.totalCost === 0
    return { queryCount: count, totalCost: initial.totalCost === null || query.totalCost === null || !compatible ? null : initial.totalCost + count * query.totalCost,
      costPerQuery: initial.totalCost === null || query.totalCost === null || !compatible ? null : initial.totalCost / count + query.totalCost,
      assumedWorkload: true, observedDemand: false }
  })
}

/**
 * Admission, native effects, resource bounds and cleanup belong to injected
 * existing host owners. The host enforces per-call provider/CPU/deadline limits.
 * No automatic retry/fallback, provider construction or rubric loading occurs.
 */
export function createQualificationExecutor({ admit, openTrial, executeTask, closeTrial, appendSidecar,
  receiveAssessment, verifyAssessment,
  monotonic = () => performance.now(), now = () => new Date().toISOString() }) {
  for (const fn of [admit, openTrial, executeTask, closeTrial, appendSidecar]) if (typeof fn !== 'function') throw new TypeError('Actual admission, execution, sidecar and cleanup owners required')
  if ((receiveAssessment !== undefined || verifyAssessment !== undefined) &&
    (typeof receiveAssessment !== 'function' || typeof verifyAssessment !== 'function')) throw new TypeError('Separate assessment receiving and receipt verification owners required together')
  return Object.freeze({ async run(planInput, { signal } = {}) {
    const plan = validateExecutionPlan(planInput), planDigest = digest(plan)
    const admission = await admit({ plan: structuredClone(plan), planDigest, signal })
    if (admission?.planDigest !== planDigest || admission?.executionAllowed !== true ||
      !admission?.ownerRef || !admission?.limitsRef) throw new Error('Existing owner refused or did not bind actual execution admission')
    const records = [], trials = new Map(), sharedComponents = [], terminalCleanup = [], assessmentReceipts = [], componentIds = new Set(), sidecarFailures = []
    const retainComponents = components => {
      accountComponents(components)
      if (components.some(x => componentIds.has(x.id))) throw new Error('Duplicate attempted accounting component across the cohort')
      for (const x of components) componentIds.add(x.id)
    }
    const unknownAttempt = (task, stage, attemptedResult, error) => {
      let id = `${task.id}/${stage}/unreported-attempt`
      while (componentIds.has(id)) id += '/unreported'
      componentIds.add(id)
      return { outcome: 'uncertain', effectStage: stage, attemptedResult,
        reconciliationReason: error?.message ?? 'actual result unreceived',
        components: [{ id, kind: 'unreported-native-attempt', cost: null, currency: null, elapsedMs: null, complete: false }] }
    }
    const save = async (task, result, started, startedAt) => {
      const record = { outcome: result.outcome, components: result.components, effectStage: result.effectStage,
        reconciliationReason: result.reconciliationReason, executionResult: result, resultDigest: null,
        taskId: task.id, profile: task.profile, phase: task.phase, routeId: task.routeId, repetition: task.repetition,
        questionId: task.questionId, cacheState: task.cacheState, planDigest, startedAt, endedAt: now(), elapsedMs: Math.max(0, monotonic() - started),
        qualification: 'unscored-execution-sidecar', admissionOwnerRef: admission.ownerRef }
      // Retain execution before invoking a separate assessor or sidecar sink.
      records.push(record)
      record.executionResult = structuredClone(result)
      record.resultDigest = digest(record.executionResult)
      if (record.outcome === 'completed' && receiveAssessment) {
        try {
          const receipt = await receiveAssessment({ binding: assessmentBinding(record), result: structuredClone(result), plan: structuredClone(plan), signal })
          if (receipt) {
            record.assessmentReceiving = structuredClone(receipt)
            if (receipt.taskId === task.id && receipt.bindingDigest === digest(assessmentBinding(record)) &&
              receipt.receiptRef && receipt.assessorRef && receipt.rubricRef) assessmentReceipts.push(structuredClone(receipt))
          }
        } catch (error) { record.assessmentReceivingError = error.message }
      }
      await appendSidecar(structuredClone(record))
    }
    let failure
    try {
      for (const task of plan.tasks) {
        if (signal?.aborted) break
        const trialKey = `${task.profile}/${task.routeId}/${task.phase}/${task.repetition}`
        if (!trials.has(trialKey)) {
          const started = monotonic(), startedAt = now(), entry = { handle: null, task: structuredClone(task) }
          trials.set(trialKey, entry)
          let opened
          try {
            opened = await openTrial({ task: structuredClone(task), trialKey, planDigest, admission, signal })
            if (opened?.handle) entry.handle = opened.handle
            if (!entry.handle || !Array.isArray(opened.components) || !opened.components.length) throw new Error('Trial owner must return an actual handle and explicit shared accounting')
            retainComponents(opened.components)
            sharedComponents.push(...opened.components)
          } catch (error) {
            await save(task, unknownAttempt(task, 'trial-open', opened ?? error.attemptedResult, error), started, startedAt)
            break
          }
        }
        const started = monotonic(), startedAt = now()
        let result
        try {
          result = await executeTask({ task: structuredClone(task), trial: trials.get(trialKey).handle, planDigest, admission, signal })
          if (!terminalStates.has(result?.outcome) || !Array.isArray(result.components) || !result.components.length) throw new Error('Incomplete host task receipt')
          retainComponents(result.components)
        } catch (error) {
          result = unknownAttempt(task, 'task-execution', result ?? error.attemptedResult, error)
        }
        await save(task, result, started, startedAt)
        if (result.outcome === 'uncertain') break
      }
    } catch (error) { failure = error }
    finally {
      for (const [trialKey, entry] of [...trials].reverse()) {
        let cleanup
        try { cleanup = await closeTrial({ trial: entry.handle, task: entry.task, trialKey, planDigest, admission }) }
        catch (error) { cleanup = { verified: false, outcome: 'cleanup-uncertain', reason: error.message } }
        terminalCleanup.push({ trialKey, ...cleanup })
      }
      try { await appendSidecar({ kind: 'trial-cleanup', planDigest, terminalCleanup, qualification: 'host-reported-not-independently-verified' }) }
      catch (error) { sidecarFailures.push({ stage: 'trial-cleanup', error }); failure ??= error }
    }
    if (failure) {
      // Original sidecar/cleanup failure retains all executed output and custody.
      Object.assign(failure, { records, sharedComponents, assessmentReceipts, terminalCleanup, sidecarFailures, planDigest, retryAuthorized: false })
      throw failure
    }
    return { planDigest, records, sharedComponents, assessmentReceipts, terminalCleanup,
      cohort: summarizeCohort({ assignedTaskIds: plan.tasks.map(x => x.id), records, sharedComponents, assessmentReceipts, verifyAssessment }),
      cleanupVerified: terminalCleanup.every(x => x.verified === true), nativeQualification: false, benefitQualified: false }
  } })
}
