import { readObsidianEnablement } from './enablement.mjs'
import { ObsidianMaintenanceRefusal } from './errors.mjs'
import { readServiceRecord } from './service-record.mjs'
import { resolveServiceWorkspace } from './service.mjs'
import { createMaintenanceStateStore } from './state-store.mjs'

// What Git synchronization may say about Obsidian maintenance: a report, read
// from persisted state, and a hint. Null when the project does not declare
// the integration or has it switched off, so the output of `sync` is then
// exactly what it always was. Nothing here starts or asks a service, ticks an
// engine, publishes a view or writes a file.
export function maintenanceNoticeFor(project, { dataRoot, env = process.env, platform = process.platform } = {}) {
  let enablement
  try { enablement = readObsidianEnablement(project) } catch (error) {
    if (!(error instanceof ObsidianMaintenanceRefusal)) throw error
    return { state: 'refused', code: error.code, hint: 'atelier obsidian status' }
  }
  if (enablement.state !== 'enabled') return null
  const notice = { state: 'enabled', maintainedBy: 'the Obsidian maintenance service, not by sync', hint: 'atelier obsidian status' }
  try {
    const workspace = resolveServiceWorkspace({ project, dataRoot, env, platform })
    if (!workspace?.workspaceRoot) return { ...notice, service: 'never-started', scopes: [] }
    const freshness = createMaintenanceStateStore(workspace).readFreshness()
    // A record is not proof that a service runs; only `obsidian service status` proves that.
    return {
      ...notice, service: readServiceRecord(workspace) === null ? 'no-record' : 'recorded-not-verified', lastTickAt: freshness?.lastTickAt ?? null,
      scopes: (freshness?.scopes ?? []).map(({ scopeId, state, reason, checkedAt }) => ({ scopeId, lastKnownState: state, reason, checkedAt })),
    }
  } catch (error) {
    if (!(error instanceof ObsidianMaintenanceRefusal)) throw error
    return { ...notice, service: 'unknown', code: error.code, scopes: [] }
  }
}
