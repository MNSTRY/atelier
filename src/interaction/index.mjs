import { assertInteraction, qualifyReflection, reflectionReference, validateInteraction } from '../reflection/index.mjs'
import { boundedLearningValue, learningDigest as digest } from '../learning/contracts.mjs'
export { validateInteraction }

// Host contexts contain current source records, not just self-reported hashes.
// Intention/preference owners provide exact revision pins after their own checks.
export function selectInteractionAct({ act, policy, context, state, at }) {
  assertInteraction(act, 'act'); assertInteraction(policy, 'policy')
  boundedLearningValue(context); boundedLearningValue(state)
  if (!Number.isFinite(Date.parse(at))) throw new Error('selection time required')
  const reasons = [], scope = policy.scope, purpose = policy.purpose
  if (act.scope !== scope || act.purpose !== purpose) reasons.push('scope-or-purpose-differs')
  if (Date.parse(act.expiresAt) <= Date.parse(at)) reasons.push('expired')
  if (act.origin === 'witness' && act.mode === 'ordinary') reasons.push('reflective-mode-required')
  if (act.origin === 'witness' && !policy.reflectionEnabled) reasons.push('reflection-disabled')
  if (act.mode === 'coaching' && (!policy.coachingEnabled || !act.dependencies.some(p => p.kind === 'intention'))) reasons.push('coaching-unavailable')
  if (act.kind === 'challenge' && !policy.challengeEnabled) reasons.push('challenge-disabled')
  if (act.origin === 'witness' && !act.dependencies.some(p => p.kind === 'assessment')) reasons.push('reflective-assessment-missing')
  if (act.origin === 'witness' && policy.initiative === 'responsive' && state.requestedReflection !== true) reasons.push('reflection-not-requested')
  if (!context || Object.keys(context).sort().join() !== 'assessments,observations,orientations' || !Array.isArray(context.observations) || !Array.isArray(context.assessments) || !Array.isArray(context.orientations) || context.observations.length > 128 || context.assessments.length > 64 || context.orientations.length > 64) throw new Error('bounded current interaction context required')
  const refs = []
  for (const observation of context.observations) {
    assertInteraction(observation, 'observation')
    if (observation.scope === scope && observation.purpose === purpose && observation.status === 'active') refs.push(reflectionReference(observation))
  }
  for (const assessment of context.assessments) if (qualifyReflection({ assessment, observations: context.observations, scope, purpose }).current) refs.push(reflectionReference(assessment))
  for (const orientation of context.orientations) {
    if (!orientation || Object.keys(orientation).sort().join() !== 'active,digest,id,kind,purpose,scope' || !['intention', 'preference'].includes(orientation.kind) || typeof orientation.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(orientation.id) || !/^sha256:[a-f0-9]{64}$/.test(orientation.digest) || typeof orientation.active !== 'boolean') throw new Error('invalid orientation reference')
    if (orientation.active && orientation.scope === scope && orientation.purpose === purpose) refs.push({ kind: orientation.kind, id: orientation.id, digest: orientation.digest })
  }
  if (new Set(refs.map(r => `${r.kind}:${r.id}`)).size !== refs.length) throw new Error('ambiguous current context identity')
  for (const pin of act.dependencies) if (!refs.some(r => digest(r) === digest(pin))) reasons.push(`dependency-not-current:${pin.kind}:${pin.id}`)
  const defer = state.paused === true || state.busy === true || state.floor !== 'assistant'
  return { actDigest: digest(act), policyDigest: digest(policy), contextDigest: digest(context),
    selection: reasons.length ? 'declined' : defer ? 'deferred' : 'selected', reasons: reasons.length ? reasons : defer ? ['conversation-floor-unavailable'] : [],
    qualityCriteria: [...policy.qualities], qualityEvaluated: false, executionAuthorized: false }
}

// One host owns floor, durable reservations and native delivery. This controller
// composes typed contributions; it never starts a second conversation or monitor.
export function createInteractionController({ authorityId, host }) {
  if (typeof authorityId !== 'string' || !authorityId || host?.authorityId !== authorityId || ['current', 'authorize', 'reserve', 'send', 'read', 'interrupt'].some(k => typeof host[k] !== 'function')) throw new Error('one complete conversation authority required')
  const active = new Map()
  function checked(receipt, key, act) {
    if (!receipt || receipt.key !== key || receipt.authorityId !== authorityId || receipt.actDigest !== digest(act) || !['reserved', 'begun', 'completed', 'interrupted', 'failed', 'unknown'].includes(receipt.status) || typeof receipt.deliveredText !== 'string' || !act.text.startsWith(receipt.deliveredText) || (receipt.status === 'completed' && receipt.deliveredText !== act.text)) throw new Error('native delivery readback does not match the intended act')
    return { ...structuredClone(receipt), understandingVerified: false, improvementVerified: false }
  }
  return Object.freeze({
    async deliver(act) {
      act = boundedLearningValue(act); assertInteraction(act, 'act')
      const key = digest({ authorityId, scope: act.scope, id: act.id })
      if (active.has(key)) throw new Error('delivery already active; inspect or interrupt it')
      const current = await host.current(), selection = selectInteractionAct({ act, ...current })
      if (selection.selection !== 'selected') return { selection, delivery: null }
      if (await host.authorize({ actDigest: digest(act), scope: act.scope, purpose: act.purpose, authorityId }) !== true) throw new Error('host did not authorize this interaction')
      const reservation = await host.reserve({ key, authorityId, actDigest: digest(act), selection })
      if (reservation?.created !== true) {
        // A previous attempt may already have emitted content. Read it instead
        // of turning uncertainty or a lost reply into duplicate guidance.
        return { selection, delivery: checked(await host.read(key), key, act), replayed: true }
      }
      const controller = new AbortController(); active.set(key, controller)
      try {
        const fresh = await host.current(), recheck = selectInteractionAct({ act, ...fresh })
        if (recheck.selection !== 'selected' || recheck.policyDigest !== selection.policyDigest || recheck.contextDigest !== selection.contextDigest) {
          await host.interrupt({ key, reason: 'context-changed-before-delivery', authorityId })
          return { selection: recheck, delivery: checked(await host.read(key), key, act) }
        }
        try { await host.send({ key, authorityId, act: structuredClone(act), signal: controller.signal }) }
        catch { /* Native readback determines failed, interrupted or unknown. */ }
        return { selection, delivery: checked(await host.read(key), key, act) }
      } finally { active.delete(key) }
    },
    async interrupt(act, reason) {
      assertInteraction(act, 'act')
      if (typeof reason !== 'string' || !reason || reason.length > 1024) throw new Error('bounded interruption reason required')
      const key = digest({ authorityId, scope: act.scope, id: act.id })
      active.get(key)?.abort()
      await host.interrupt({ key, reason, authorityId })
      return checked(await host.read(key), key, act)
    },
    async inspect(act) {
      assertInteraction(act, 'act')
      const key = digest({ authorityId, scope: act.scope, id: act.id })
      return checked(await host.read(key), key, act)
    },
  })
}
