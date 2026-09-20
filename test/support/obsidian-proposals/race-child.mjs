import { resolveProjectConfig } from '../../../src/project/config.mjs'
import { PROPOSAL_ADAPTER_PRIMITIVES, createProposalAdapterForOracleTests } from '../../../src/projection/obsidian/proposals/index.mjs'
import { protectedRoots } from '../../../src/runtime/obsidian/machine-settings.mjs'
import { createMaintenanceStateStore } from '../../../src/runtime/obsidian/state-store.mjs'

// One of two real processes that offer the same structural edits to the same
// proposal stores at an agreed instant. Each pass is one tick of the adapter;
// a process ticks until the queue has nothing open or its passes are spent.
// Between the look in the store and the creation it holds still for `spinMs`,
// which makes the window two processes could both create in as wide as it can
// be. It prints what it saw as one JSON document and exits.
//
// `unlocked` is the mutation control: a lock that is always granted, and one
// clock instant for both processes so that their queue records are the same
// bytes. Production never runs that way.

const { configPath, projectDir, workspaceRoot, workspaceId, role, startAt, passes, spinMs, unlocked, fixedNow } = JSON.parse(process.argv[2])
const { MNSTRY_ATELIER_PROJECT_CONFIG: _config, MNSTRY_ATELIER_LOCAL_CONFIG: _overlay, ...env } = process.env
const loadProject = () => resolveProjectConfig({ argv: [`--project=${configPath}`], cwd: projectDir, env, writeLocalState: false })
const spinUntil = (instant) => { while (Date.now() < instant) { /* held still on purpose */ } }

const primitives = unlocked ? { ...PROPOSAL_ADAPTER_PRIMITIVES, acquireLock: async () => ({ acquired: true, release() {} }) } : PROPOSAL_ADAPTER_PRIMITIVES
const adapter = createProposalAdapterForOracleTests(primitives)({
  env, clock: unlocked ? () => new Date(fixedNow) : () => new Date(),
  crash: (step) => { if (step === 'before-append') spinUntil(Date.now() + spinMs) },
})
const context = () => {
  const project = loadProject()
  return { project, workspaceRoot, workspaceId, repositoryRoots: protectedRoots(project), edits: createMaintenanceStateStore({ workspaceRoot, workspaceId }).readPendingEdits().edits }
}

const early = startAt - Date.now() - 3
if (early > 0) await new Promise((resolve) => { setTimeout(resolve, early) })
spinUntil(startAt)
const seen = []
for (let pass = 0; pass < passes; pass += 1) {
  const report = await adapter.propose(context())
  seen.push({ pass, outcomes: report.outcomes.map(({ status, code, editId, repoId, dedupe, proposalId }) => ({ status, code, editId, repoId, dedupe: dedupe ?? null, proposalId })), repositories: report.repositories })
  const open = adapter.list(context()).filter((item) => !['acknowledged', 'refused'].includes(item.state)).length
  if (report.outcomes.length === 0 && report.repositories.length === 0 && open === 0) break
  await new Promise((resolve) => { setTimeout(resolve, 5 + Math.floor(Math.random() * 10)) })
}
process.stdout.write(`${JSON.stringify({ role, pid: process.pid, seen })}\n`)
