import { refuse } from '../../../runtime/obsidian/errors.mjs'
import { protectedRoots } from '../../../runtime/obsidian/machine-settings.mjs'
import { createProposalAdapter } from './adapter.mjs'
import { ProposalQueueRefusal } from './queue.mjs'
import { isAdapterOperationId } from './router.mjs'

// Binds the proposal adapter to the two places that reach it: the maintenance
// engine, which hands it the pending edits on a tick, and `atelier obsidian
// proposals`, which is how a person or an agent reads what became of them.
// The command reads; it creates, accepts and applies nothing.

export const PROPOSAL_ADAPTER_CONTRIBUTION_ID = 'atelier.proposal-adapter'
const EXIT = Object.freeze({ ok: 0 })
const SUMMARY = 'list | show OPERATION  Structural edits routed as copy-only proposals: per repository what is queued, submitted, acknowledged, waiting or refused, and the room its ledger has. Read-only.'

export function createProposalsCommandOperation({ create = createProposalAdapter } = {}) {
  return {
    name: 'proposals',
    summary: SUMMARY,
    async run({ args, env, clock, readable }) {
      const [sub = 'list', operationId, ...extra] = args
      const { project, workspace, workspaceId } = readable()
      if (workspace === null) refuse('workspace-not-prepared', 'this workspace has no private state yet; nothing was ever routed')
      const context = { project, workspaceRoot: workspace.workspaceRoot, workspaceId, repositoryRoots: protectedRoots(project) }
      const adapter = create({ env, clock })
      // An adapter queue that cannot be read is an answer with a code, never an internal error.
      const typed = (operation) => { try { return operation() } catch (error) { if (error instanceof ProposalQueueRefusal) refuse(error.code, 'the record of the proposal adapter cannot be read; nothing was changed'); throw error } }
      if (sub === 'list' && operationId === undefined) {
        const status = typed(() => adapter.status(context))
        const operations = typed(() => adapter.list(context))
        return {
          exit: EXIT.ok, document: { status, operations },
          human: status.repositories.length === 0 ? ['no enrolled repository'] : status.repositories.map((item) => `${item.repoId}\tqueued ${item.queued}\tsubmitted ${item.submitted}\tacknowledged ${item.acknowledged}\twaiting ${item.backpressure}\trefused ${item.refused}\tledger ${item.ledger.state}${item.ledger.headroom ? ` (${item.ledger.headroom.events} events, ${item.ledger.headroom.bytes} bytes free)` : ''}`),
        }
      }
      if (sub === 'show' && extra.length === 0) {
        if (!isAdapterOperationId(operationId)) refuse('usage', 'name the operation: an identifier that `obsidian proposals list` printed')
        const shown = typed(() => adapter.show(context, { adapterOperationId: operationId }))
        if (shown === null) refuse('unknown-operation', 'the proposal adapter holds no operation of that name')
        return { exit: EXIT.ok, document: shown, human: [JSON.stringify(shown, null, 2)] }
      }
      return refuse('usage', 'proposals takes list or show OPERATION')
    },
  }
}

export function createProposalAdapterContribution(options = {}) {
  return {
    id: PROPOSAL_ADAPTER_CONTRIBUTION_ID,
    register({ extensions, operations }) {
      extensions.register('proposal-adapter', (options.create ?? createProposalAdapter)(options.adapter ?? {}))
      operations.register(createProposalsCommandOperation(options))
    },
  }
}
