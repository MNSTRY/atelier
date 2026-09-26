import fs from 'node:fs'
import path from 'node:path'
import { isoTime } from '../../../runtime/obsidian/documents.mjs'
import { refuse } from '../../../runtime/obsidian/errors.mjs'
import { protectedRoots, readMachineSettings } from '../../../runtime/obsidian/machine-settings.mjs'
import { resolveScope } from '../../../runtime/obsidian/opening.mjs'
import { createProductionSeams, eligibilityFor } from '../../../runtime/obsidian/pipeline.mjs'
import { createMaintenanceStateStore } from '../../../runtime/obsidian/state-store.mjs'
import { readConflictView } from './conflict-view.mjs'
import { runPolicySetup } from './policy-setup.mjs'
import { listSelectionStates, readSelectionState, writeSelectionState } from './selection-state.mjs'
import { resolveSelection } from './selection.mjs'

// The `obsidian` command operations of selection, conflict state and policy
// setup, registered on the command's operation registry the way AOP-1 laid
// out: a contribution `{ id, register({ operations }) }`. Nothing in the
// command dispatcher is edited. The built-in `scope`, `policy` and `mode`
// names are reserved, so these are `selection`, `conflicts` and
// `apply-policy`.
//
// Every operation is noninteractive and read-only towards sources, vaults
// and the app: `selection persist` writes the workspace's private selection
// state, `apply-policy create|revoke` write the private policy files through
// AOP-1's installer and revocation, and nothing else writes at all.

export const SELECTION_CONTRIBUTION_ID = 'atelier.selection-ui'
const EXIT = Object.freeze({ ok: 0, notSuccess: 3 })
const MAX_REQUEST_BYTES = 64 * 1024

// The canonical snapshot selectScope reads, built exactly as the engine
// builds it: the canonical graph with the eligibility the machine settings
// decide (fail closed), and the declared relations whose both endpoints the
// census knows.
function snapshotNow({ project, seams, eligibility }) {
  const graph = seams.buildGraph({ project, eligibility })
  const known = new Set(graph.nodes.map((node) => node.id))
  return { nodes: graph.nodes, edges: graph.edges.filter((edge) => known.has(edge.source) && known.has(edge.target)) }
}

// FILE is resolved from the working directory of the process, as the built-in `policy install FILE` resolves its file.
function readRequest(value) {
  if (value === undefined) refuse('usage', 'apply-policy create FILE')
  const file = path.resolve(value)
  try {
    if (fs.statSync(file).size > MAX_REQUEST_BYTES) refuse('invalid-apply-policy', 'the request file is larger than a request can be')
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if (typeof error?.code === 'string' && error.name === 'ObsidianMaintenanceRefusal') throw error
    return refuse('invalid-apply-policy', 'the request file cannot be read as JSON', { cause: error.code ?? 'not-json' })
  }
}

export function createSelectionOperation({ seams = createProductionSeams(), eligibility: fixedEligibility = null } = {}) {
  return {
    name: 'selection',
    summary: 'resolve ID | persist ID [allow-empty] | show ID | list  The exact selected set of a declared view, its note paths and, for a focus, the graph query; persisted in Atelier state.',
    async run({ args, readable, writable, clock }) {
      const [sub = 'list', requested, option] = args
      if (option !== undefined && !(sub === 'persist' && option === 'allow-empty')) refuse('usage', 'selection persist ID [allow-empty]')
      if (sub === 'list') {
        const { workspace, workspaceId } = readable()
        const selections = workspace === null ? [] : listSelectionStates({ workspaceRoot: workspace.workspaceRoot, workspaceId })
        return { exit: EXIT.ok, document: { selections }, human: selections.length === 0 ? ['no persisted selection'] : selections.map((item) => `${item.scopeId}\t${item.mode}\t${item.updatedAt}${item.focus ? `\t${item.focus.paths.length} focused note(s)` : ''}`) }
      }
      if (!['resolve', 'persist', 'show'].includes(sub)) refuse('usage', 'selection resolve ID | persist ID | show ID | list')
      if (sub === 'show') {
        const { enablement, workspace, workspaceId } = readable()
        const scopeId = resolveScope(enablement, requested)
        const selection = workspace === null ? null : readSelectionState({ workspaceRoot: workspace.workspaceRoot, workspaceId, scopeId })
        return { exit: selection === null ? EXIT.notSuccess : EXIT.ok, document: { scopeId, persisted: selection !== null, selection }, human: [selection === null ? `no persisted selection for ${scopeId}` : JSON.stringify(selection, null, 2)] }
      }
      const { project, enablement, workspace, repositoryRoots, now } = sub === 'persist' ? writable() : { ...readable(), repositoryRoots: null, now: isoTime(clock) }
      const scopeId = resolveScope(enablement, requested)
      const scope = enablement.scopes.find((item) => item.scopeId === scopeId)
      const usable = workspace !== null && workspace.workspaceRoot !== null
      const machine = usable ? readMachineSettings(workspace) : null
      const profile = seams.profileFor({ project, workspaceId: workspace?.workspaceId ?? 'ws-unprepared', audienceAllow: machine?.audienceAllow ?? [] })
      const canonicalSnapshot = snapshotNow({ project, seams, eligibility: fixedEligibility ?? eligibilityFor({ machine, project }) })
      const pathRegistry = usable ? createMaintenanceStateStore(workspace).readPathRegistry() : null
      // Explicit empty is an honest answer of `resolve`; `persist` of an empty selection is refused and asks for it by name.
      const selection = resolveSelection({ canonicalSnapshot, profile, scope, pathRegistry, allowEmpty: sub === 'resolve' || option === 'allow-empty' })
      if (sub === 'resolve') {
        return { exit: EXIT.ok, document: { scopeId, selection, persisted: false }, human: [`${scopeId}: ${selection.mode}, ${selection.nodes.length} note(s), ${selection.edges.length} edge(s)${selection.truncated ? ', expansion truncated' : ''}${selection.focus ? `; focus query ${selection.focus.query}` : ''}`] }
      }
      const written = writeSelectionState({ workspaceRoot: workspace.workspaceRoot, workspaceId: workspace.workspaceId, repositoryRoots, selection, now })
      return { exit: EXIT.ok, document: { scopeId, selection, persisted: true, changed: written.changed, file: path.relative(workspace.workspaceRoot, written.file).split(path.sep).join('/') }, human: [`${scopeId}: persisted${written.changed ? '' : ' (unchanged)'}; ${selection.nodes.length} note(s)${selection.focus ? `; focus query ${selection.focus.query}` : ''}`, 'No file under .obsidian/ was written; apply a focus in the app.'] }
    },
  }
}

export function createConflictsOperation() {
  return {
    name: 'conflicts',
    summary: '[ID]  The shared conflict state of edited objects, read from the arbitration record: what is conflicted, pending or unreadable, and what a person does next. Read-only.',
    async run({ args, readable, clock }) {
      const [requested] = args
      const { project, enablement, workspace, workspaceId } = readable()
      const scopeId = requested === undefined ? undefined : resolveScope(enablement, requested)
      if (workspace === null) return { exit: EXIT.ok, document: { scopeId: scopeId ?? null, objects: [], summary: { total: 0 }, needsPerson: false, workspace: 'not-prepared' }, human: ['no private state yet: no edit was ever recorded'] }
      const view = readConflictView({ workspaceRoot: workspace.workspaceRoot, workspaceId, repositoryRoots: protectedRoots(project), clock, scopeId })
      return {
        exit: EXIT.ok, document: view,
        human: view.objects.length === 0 ? ['no recorded object'] : view.objects.map((object) => `${object.repoId}\t${object.nodeId}\t${object.state}${object.needsPerson ? '\tneeds a person' : ''}\t${object.next}`),
      }
    },
  }
}

export function createApplyPolicyOperation() {
  return {
    name: 'apply-policy',
    summary: 'create FILE | show | revoke  Build, digest and install a manual or automatic apply policy from a JSON request; show it; revoke it durably.',
    async run({ args, readable, writable }) {
      const [action, value] = args
      if (action === undefined || action === 'show') {
        const { workspace } = readable()
        if (workspace === null) return { exit: EXIT.ok, document: { ok: true, action: 'show', installed: false, policy: null, reference: null, automaticApply: { authorized: false, reason: 'machine-settings-absent' } }, human: ['no apply policy is installed'] }
        const result = runPolicySetup({ action: 'show', workspace })
        return { exit: result.ok ? EXIT.ok : EXIT.notSuccess, document: result, human: [result.ok ? (result.installed ? `${result.policy.policyId} v${result.policy.version} ${result.policy.mode} ${result.policy.status}; automatic apply ${result.automaticApply.authorized ? 'authorized' : `not authorized (${result.automaticApply.reason})`}` : 'no apply policy is installed') : `[${result.refusal.code}] ${result.refusal.message}`] }
      }
      if (action !== 'create' && action !== 'revoke') refuse('usage', 'apply-policy create FILE | show | revoke')
      const input = action === 'create' ? readRequest(value) : {}
      const { workspace, repositoryRoots, now } = writable()
      const result = runPolicySetup({ action, input, workspace, repositoryRoots, now })
      const human = result.ok
        ? [action === 'create' ? `installed ${result.policy.policyId} v${result.policy.version} (${result.policy.mode}, ${result.policy.status}); maintenance mode ${result.maintenanceMode}` : (result.revoked ? `revoked (${result.reason}); no queued edit is applied from now on, and the mode is manual` : 'no apply policy was installed')]
        : [`[${result.refusal.code}] ${result.refusal.message}`]
      return { exit: result.ok ? EXIT.ok : EXIT.notSuccess, document: result, human }
    },
  }
}

export function createSelectionContribution(options = {}) {
  return {
    id: SELECTION_CONTRIBUTION_ID,
    register({ operations }) {
      operations.register(createSelectionOperation(options))
      operations.register(createConflictsOperation())
      operations.register(createApplyPolicyOperation())
    },
  }
}
