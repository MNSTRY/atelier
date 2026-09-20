import { ObsidianMaintenanceRefusal, refuse } from '../../../runtime/obsidian/errors.mjs'
import { authorizeAutomaticApply, installApplyPolicy, readInstalledApplyPolicy, readMachineSettings, revokeApplyPolicy } from '../../../runtime/obsidian/machine-settings.mjs'
import { IMPLEMENTED_EDIT_CLASSES, ObsidianContractRefusal, assertObsidianContract } from '../contracts.mjs'
import { APPLY_MODES, applyPolicyDigest, withApplyPolicyDigest } from '../edits/policy.mjs'

// Apply policy setup, noninteractive: a structured request in, a structured
// answer out. Three actions:
//
//   create   build a manual or automatic policy document from a request,
//            digest it, validate it against the frozen contract and install
//            it through AOP-1's installer. Only the implemented edit class
//            can be allowed; the conflict disposition is `hold`, the only
//            one that exists.
//   show     the installed policy, the reference machine settings hold, and
//            whether an automatic apply would be authorized right now.
//   revoke   AOP-1's revocation: the stored policy is written `revoked`
//            first, then maintenance goes back to manual. Every later
//            authorization read denies, and the engine reads authorization
//            again immediately before each queued dispatch, so a revocation
//            is durable and wins over anything queued behind it.
//
// Nothing here changes the maintenance mode to automatic: that is the
// person's separate `mode set automatic`, which itself checks that an active
// automatic policy is installed.

export const POLICY_SETUP_ACTIONS = Object.freeze(['create', 'show', 'revoke'])
export const POLICY_SETUP_SCHEMA = 'atelier-obsidian-policy-setup/v1'
export const DEFAULT_MAX_BATCH_SIZE = 10
export const DEFAULT_RETRY_BUDGET = 0
export const CONFLICT_DISPOSITION = 'hold'

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isTyped = (error) => error instanceof ObsidianMaintenanceRefusal || error instanceof ObsidianContractRefusal

// The policy document a request describes, with the digest of its content.
// `version` is taken from the request, else one above the installed policy of
// the same identity, else 1.
export function buildApplyPolicy({ workspaceId, policyId, mode, actor, selector, allowedEditClasses, maxBatchSize = DEFAULT_MAX_BATCH_SIZE, retryBudget = DEFAULT_RETRY_BUDGET, version = 1, status = 'active', ext } = {}) {
  if (!APPLY_MODES.includes(mode)) refuse('invalid-apply-policy', 'policy mode must be manual or automatic', { mode: String(mode).slice(0, 32) })
  if (!isPlainObject(actor) || !['user', 'agent'].includes(actor.kind) || typeof actor.id !== 'string' || !IDENTIFIER.test(actor.id)) refuse('invalid-apply-policy', 'the actor is { kind: user|agent, id }')
  const classes = allowedEditClasses === undefined ? (mode === 'automatic' ? [...IMPLEMENTED_EDIT_CLASSES] : []) : allowedEditClasses
  if (!Array.isArray(classes) || classes.some((item) => typeof item !== 'string')) refuse('invalid-apply-policy', 'allowedEditClasses is a list of edit classes')
  const unimplemented = classes.filter((item) => !IMPLEMENTED_EDIT_CLASSES.includes(item))
  if (unimplemented.length > 0) refuse('unimplemented-edit-class', 'only an edit class with an apply implementation can be allowed', { editClasses: unimplemented.map((item) => item.slice(0, 64)) })
  const content = {
    schema: 'atelier-obsidian-apply-policy/v1',
    policyId, workspaceId, mode, status,
    actor: { kind: actor.kind, id: actor.id },
    version, allowedEditClasses: classes, selector, maxBatchSize, retryBudget,
    conflictDisposition: CONFLICT_DISPOSITION,
    ...(ext === undefined ? {} : { ext }),
  }
  const policy = withApplyPolicyDigest(content)
  try { assertObsidianContract('apply-policy', policy) } catch (error) {
    if (error instanceof ObsidianContractRefusal) refuse('invalid-apply-policy', 'the policy does not satisfy its contract', { errors: error.detail?.errors ?? [] })
    throw error
  }
  return policy
}

const reference = (policy) => (policy === null ? null : { policyId: policy.policyId, version: policy.version, digest: policy.digest, mode: policy.mode, status: policy.status })
const authorizationOf = (workspace) => {
  const { authorized, reason } = authorizeAutomaticApply(workspace)
  return { authorized, reason }
}

// The authorization the engine reads before each queued dispatch, in the
// form a caller sees: read from disk now, never cached.
export function dispatchGate(workspace) {
  const authorization = authorizeAutomaticApply(workspace)
  return { authorized: authorization.authorized, reason: authorization.reason, policyDigest: authorization.policy?.digest ?? null }
}

function showDocument(workspace) {
  const policy = readInstalledApplyPolicy(workspace)
  let machine = null
  try { machine = readMachineSettings(workspace) } catch (error) { if (!isTyped(error)) throw error }
  return { installed: policy !== null, policy, reference: machine?.applyPolicy ?? null, maintenanceMode: machine?.maintenanceMode ?? null, automaticApply: authorizationOf(workspace) }
}

// `workspace` is { workspaceRoot, workspaceId }; `repositoryRoots` the roots
// private state may not overlap; `now` the timestamp to record.
export function runPolicySetup({ action, input = {}, workspace, repositoryRoots, now }) {
  const answer = (document) => ({ schema: POLICY_SETUP_SCHEMA, ok: true, action, ...document })
  try {
    if (!POLICY_SETUP_ACTIONS.includes(action)) refuse('usage', 'policy setup takes create, show or revoke', { action: String(action).slice(0, 32) })
    if (!isPlainObject(workspace) || typeof workspace.workspaceRoot !== 'string' || typeof workspace.workspaceId !== 'string') refuse('usage', 'policy setup needs the workspace')
    if (action === 'show') return answer(showDocument(workspace))
    if (action === 'revoke') {
      const result = revokeApplyPolicy({ ...workspace, repositoryRoots, updatedAt: now })
      return answer({ revoked: result.revoked, reason: result.reason, policy: reference(result.policy), maintenanceMode: 'manual', automaticApply: authorizationOf(workspace) })
    }
    if (!isPlainObject(input)) refuse('usage', 'create takes a request object')
    const installed = readInstalledApplyPolicy(workspace)
    const version = input.version ?? (installed !== null && installed.policyId === input.policyId ? installed.version + 1 : 1)
    if (installed !== null && installed.policyId === input.policyId && installed.version >= version) {
      refuse('policy-version-not-newer', 'a policy of this identity is installed with an equal or higher version', { installed: installed.version, requested: version })
    }
    const policy = buildApplyPolicy({ ...input, workspaceId: workspace.workspaceId, version })
    installApplyPolicy({ ...workspace, policy, repositoryRoots, updatedAt: now, digestOf: applyPolicyDigest })
    return answer({ installed: true, policy, reference: reference(policy), maintenanceMode: readMachineSettings(workspace)?.maintenanceMode ?? 'manual', automaticApply: authorizationOf(workspace) })
  } catch (error) {
    if (!isTyped(error)) throw error
    return { schema: POLICY_SETUP_SCHEMA, ok: false, action, refusal: { code: error.code, message: String(error.message).replace(`${error.code}: `, ''), detail: error.detail ?? {} } }
  }
}
