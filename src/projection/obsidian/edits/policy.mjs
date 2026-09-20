import { createHash } from 'node:crypto'
import { canonicalJson } from '../../../runtime/obsidian/documents.mjs'
import { authorizeAutomaticApply } from '../../../runtime/obsidian/machine-settings.mjs'
import { IMPLEMENTED_EDIT_CLASSES, ObsidianContractRefusal, selectScope, validateObsidianContract } from '../contracts.mjs'
import { isIdentifier } from './object-identity.mjs'

// Who may apply an edit to a source file, decided by one function for both
// modes. The only difference between the modes is who authorises:
//
//   manual     an explicit request that names the edit: a person, or an agent
//              acting for them, through the command or the API. No policy is
//              needed beyond the integration being enabled.
//   automatic  the engine (or a noninteractive agent call) under the INSTALLED,
//              ACTIVE policy of the workspace, read from private state at the
//              moment of the decision. There is no ambient agent mode: without
//              a matching active policy an automatic apply is a refusal.
//
// Either way the object must be visible (eligible, enrolled, audience allowed)
// in the canonical graph as it is now, and the edit class must be one an apply
// implementation exists for. A policy can narrow what is applied; it can never
// widen it, and nothing here can override a stale source or a conflict.
//
// The digest of a policy is recomputed here and compared with the one it
// carries. The canonical form is the policy document WITHOUT its `digest`
// member, keys sorted at every depth, two-space indentation, one final
// newline, UTF-8; the digest is `sha256:` and the hex SHA-256 of those bytes.

export const APPLY_MODES = Object.freeze(['manual', 'automatic'])
export const DEFAULT_MANUAL_ACTOR = 'manual-request'

export const APPLY_POLICY_REFUSALS = Object.freeze([
  'invalid-apply-request',
  'object-not-visible',
  'edit-class-not-allowed',
  'policy-digest-mismatch',
  'policy-changed-since-dispatch',
  'policy-selector-invalid',
  'outside-policy-selection',
  'retry-budget-exhausted',
  'conflict-disposition-unsupported',
])

export function canonicalApplyPolicy(policy) {
  const { digest: _digest, ...content } = policy
  return canonicalJson(content)
}

export function applyPolicyDigest(policy) {
  return `sha256:${createHash('sha256').update(canonicalApplyPolicy(policy), 'utf8').digest('hex')}`
}

// The same policy with the digest of its content.
export const withApplyPolicyDigest = (policy) => ({ ...policy, digest: applyPolicyDigest(policy) })

export const APPLY_POLICY_PRIMITIVES = Object.freeze({
  // Read from disk on every call: a revocation or a pause made a moment ago denies.
  authorize: authorizeAutomaticApply,
  digestOf: applyPolicyDigest,
  select: selectScope,
})

const allow = (actor, policy, retryBudget = null) => ({ allowed: true, actor, policy, retryBudget })
const deny = (code, detail = {}) => ({ allowed: false, code, detail })

function selectedIds({ select, graph, profile, selector }) {
  const known = new Set(graph.nodes.map((node) => node.id))
  const canonicalSnapshot = { nodes: graph.nodes, edges: graph.edges.filter((edge) => known.has(edge.source) && known.has(edge.target)) }
  return new Set(select({ canonicalSnapshot, profile, selector, mode: 'scoped' }).nodes)
}

// `request`   { mode, editId, actor?, policyDigest? }: what was asked. `policyDigest` is the digest an automatic
//             dispatch was queued under, when the caller has one.
// `workspace` { workspaceRoot, workspaceId }: where the installed policy is read from.
// `graph`     the canonical graph as it is now, with eligibility; `profile` the corpus profile of this machine.
// `object`    { repoId, nodeId }; `editClass` the class of the operation; `attempts` the refusals already recorded
//             for this operation, each { policyDigest }.
//
// Returns { allowed: true, actor, policy, retryBudget } where `policy` is what the object store records
// ({ mode: 'manual' } or { mode: 'automatic', policyDigest, policyId }), or { allowed: false, code, detail }.
export function createApplyPolicyForOracleTests(primitives = APPLY_POLICY_PRIMITIVES) {
  const { authorize, digestOf, select } = { ...APPLY_POLICY_PRIMITIVES, ...primitives }
  return function decideApply({ request, workspace, graph, profile, object, editClass, attempts = [] }) {
    if (request === null || typeof request !== 'object' || !APPLY_MODES.includes(request.mode) || typeof request.editId !== 'string' || request.editId === '') {
      return deny('invalid-apply-request')
    }
    if (!IMPLEMENTED_EDIT_CLASSES.includes(editClass)) return deny('edit-class-not-allowed', { editClass: String(editClass).slice(0, 64) })
    let visible
    try { visible = selectedIds({ select, graph, profile, selector: { all: true } }) } catch (error) {
      if (!(error instanceof ObsidianContractRefusal)) throw error
      return deny('object-not-visible', { cause: error.code })
    }
    // Absent and withheld are one answer, so the answer confirms nothing about a withheld object.
    if (!visible.has(object.nodeId)) return deny('object-not-visible')

    if (request.mode === 'manual') {
      const actor = request.actor ?? DEFAULT_MANUAL_ACTOR
      if (!isIdentifier(actor)) return deny('invalid-apply-request', { member: 'actor' })
      return allow(actor, { mode: 'manual' })
    }

    const authorization = authorize(workspace)
    if (!authorization.authorized) return deny(authorization.reason)
    const { policy } = authorization
    if (validateObsidianContract('apply-policy', policy).length > 0) return deny('apply-policy-invalid')
    if (digestOf(policy) !== policy.digest) return deny('policy-digest-mismatch')
    if (request.policyDigest !== undefined && request.policyDigest !== policy.digest) return deny('policy-changed-since-dispatch')
    if (policy.conflictDisposition !== 'hold') return deny('conflict-disposition-unsupported')
    if (!policy.allowedEditClasses.includes(editClass)) return deny('edit-class-not-allowed', { editClass })
    let selected
    try { selected = selectedIds({ select, graph, profile, selector: policy.selector }) } catch (error) {
      if (!(error instanceof ObsidianContractRefusal)) throw error
      return deny('policy-selector-invalid', { cause: error.code })
    }
    if (!selected.has(object.nodeId)) return deny('outside-policy-selection')
    // One first attempt and `retryBudget` retries, counted per operation under this revision of the policy. What is
    // counted is on disk, in the events of the object, so a restart does not refill it.
    const spent = attempts.filter((attempt) => attempt.policyDigest === policy.digest).length
    if (spent >= policy.retryBudget + 1) return deny('retry-budget-exhausted', { attempts: spent, retryBudget: policy.retryBudget })
    return allow(policy.actor.id, { mode: 'automatic', policyDigest: policy.digest, policyId: policy.policyId }, policy.retryBudget)
  }
}

export const decideApply = createApplyPolicyForOracleTests()
