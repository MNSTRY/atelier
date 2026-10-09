import path from 'node:path'
import { resolveProjectConfig } from '../project/config.mjs'
import { createKnowledgeSessions } from '../knowledge/sessions.mjs'
import { inspectPublicWorkshop, publicWorkshopProfile, preparePublicWorkshopHandoff } from './workshop-profile.mjs'

// A callable default over the same session/store used by /knowledge. No new
// ledger, model, receipt algorithm, source writer, editor or server is opened.
export function createPublicWorkshopComposition({ workspaceRoot }) {
  const project = resolveProjectConfig({ cwd: workspaceRoot,
    argv: ['--project', path.join(workspaceRoot, 'atelier.project.json')], env: {}, writeLocalState: false })
  const sessions = createKnowledgeSessions(project)
  return { ...sessions,
    inspect: () => inspectPublicWorkshop({ workspaceRoot }),
    profile: () => sessions.workshopProfile(),
    prepareHandoff: id => preparePublicWorkshopHandoff(sessions.read(id)),
    authority: Object.freeze({ savedMeaning: 'private-draft-only', directWrite: false,
      typedFindingDisposition: false, sourceEditsApplied: false }) }
}
export { inspectPublicWorkshop, publicWorkshopProfile, preparePublicWorkshopHandoff }
