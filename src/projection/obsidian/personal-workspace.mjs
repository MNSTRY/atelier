import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { PersonalWorkspaceRefusal, composePersonalWorkspace } from '@mnstry/atelier/personal-workspace'
import { ensureLocalState, resolveProjectConfig, validateProjectConfigDoc } from '@mnstry/atelier/project'
import { refuse } from '../../runtime/obsidian/errors.mjs'
import { OBSIDIAN_EXT_KEY } from './contracts.mjs'

// The one personal-workspace route of the Obsidian projection.
//
// A person's private home holds the authored manifest and overlay, and the
// generations the personal-workspace module materialized from them. A binding
// names one home and one generation, both explicitly: nothing here discovers
// either from the environment or the working directory. The module's
// `composePersonalWorkspace` is the only authority on whether that generation
// may be used; it is asked when the binding is made and again every time a
// graph is built from it (`personalWorkspaceGraph`, which the pipeline's
// `buildGraph` calls), so the engine, view counts, source apply, the proposal
// adapter and the selection operation all read the composed graph and never
// build one of their own from the generation's configuration. A plain build
// would differ wherever a shared note's link names a private note.
//
// What a binding returns:
//   project      the generation's atelier.project.json, resolved, with the
//                Obsidian settings member built in memory from the overlay's
//                saved views (each a scope) plus an `everything` scope, and the
//                frozen binding under one symbol key. No generation file is
//                ever written.
//   binding      { personalHome, generationId, overlayRepoId }, frozen.
//   preferences  the overlay's preferences, read only. A theme is reported,
//                never written: the vault's appearance is the person's.
//   coverage     passed through as the module returned it. Nothing here reads
//                it: it describes what is not enforced, and is never permission.
//
// The project's own folder is the private home rather than the generation:
// the projection keeps its workspace pointer in `<folder>/.atelier-local/`,
// and a generation is a closed, verified inventory that any extra file
// invalidates. A home is outside every Git worktree, so its local state is
// ignored by construction.

const BINDING = Symbol('atelier.obsidian.personal-workspace-binding')
// The compose function each binding was made with, so a graph is always built
// by the same authority that admitted the binding.
const ROUTES = new WeakMap()
export const EVERYTHING_SCOPE_ID = 'everything'
const EXT_SCHEMA = 'atelier-obsidian-ext-settings/v1'
// The settings member of a bound project names its generation here. It survives any copy of the project (a structured
// clone, a JSON round trip) that drops the symbol-keyed binding, so such a copy is refused instead of being built as an
// ordinary project; and a rebound generation changes the member, which invalidates every view.
export const PERSONAL_MEMBER_KEY = 'mnstry.atelier.personal-workspace'
// The Obsidian settings contract's limits: at most 256 scopes, one of them `everything`, and at most 256 members in a
// selector's union.
const MAX_SAVED_VIEWS = 255
const MAX_VIEW_REPOSITORIES = 256

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const deepFreeze = (value) => { if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value) } return value }

// One generation file, read without following a link, and checked against the
// digest the generation records for it (and compose verified a moment ago).
function generationFile(generation, final, relative) {
  const listed = generation.files.find((file) => file.path === relative)
  if (!listed) throw new PersonalWorkspaceRefusal('generation-corrupt')
  let bytes
  try {
    const fd = fs.openSync(path.join(final, ...relative.split('/')), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try { bytes = fs.readFileSync(fd) } finally { fs.closeSync(fd) }
  } catch { throw new PersonalWorkspaceRefusal('generation-corrupt') }
  if (sha256(bytes) !== listed.sha256) throw new PersonalWorkspaceRefusal('generation-corrupt')
  return bytes
}

function selectorFor(repoIds) {
  const repos = [...new Set(repoIds)]
  if (repos.length === 0) return { ids: [] }
  if (repos.length === 1) return { repo: repos[0] }
  return { union: repos.map((repo) => ({ repo })) }
}

// The Obsidian settings member of a personal binding: one scoped view per saved
// selection of repositories, in the overlay's order, and one full view of the
// whole composed graph. A preferred view that names a saved one is the default.
// Refused, typed, where the overlay allows more than a projection can declare.
export function personalWorkspaceScopes(overlay, generationId) {
  if (overlay.views.some((view) => view.id === EVERYTHING_SCOPE_ID)) {
    refuse('personal-view-id-reserved', `a saved view may not be named "${EVERYTHING_SCOPE_ID}"; that view is the whole personal workspace`)
  }
  if (overlay.views.length > MAX_SAVED_VIEWS) refuse('personal-views-exceed-settings-limit', `a personal workspace can show at most ${MAX_SAVED_VIEWS} saved views; nothing is bound`, { limit: MAX_SAVED_VIEWS, kind: 'views' })
  if (overlay.views.some((view) => new Set(view.repoIds).size > MAX_VIEW_REPOSITORIES)) {
    refuse('personal-views-exceed-settings-limit', `a saved view can name at most ${MAX_VIEW_REPOSITORIES} repositories; nothing is bound`, { limit: MAX_VIEW_REPOSITORIES, kind: 'repositories' })
  }
  const scopes = [
    ...overlay.views.map((view) => ({ scopeId: view.id, mode: 'scoped', selector: selectorFor(view.repoIds) })),
    { scopeId: EVERYTHING_SCOPE_ID, mode: 'full', selector: { all: true } },
  ]
  const preferred = overlay.preferences?.defaultView
  const defaultScopeId = typeof preferred === 'string' && overlay.views.some((view) => view.id === preferred) ? preferred : EVERYTHING_SCOPE_ID
  return { schema: EXT_SCHEMA, enabled: true, defaultScopeId, scopes, ext: { [PERSONAL_MEMBER_KEY]: { generationId } } }
}

const generationRoot = ({ personalHome, generationId }) => path.join(personalHome, 'generations', generationId)

// Test seam only: `compose` replaces the module's composePersonalWorkspace for
// both the binding and every graph built from it. Production code uses
// bindPersonalWorkspace.
export function createPersonalWorkspaceBinderForOracleTests({ compose = composePersonalWorkspace } = {}) {
  return function bind({ personalHome, generationId } = {}) {
    // The validity authority first: a refusal propagates as the module's own typed refusal, and nothing is read or
    // written after it.
    const composed = compose({ personalHome, generationId })
    const final = generationRoot({ personalHome, generationId })
    const projectBytes = generationFile(composed.generation, final, 'atelier.project.json')
    const inputs = JSON.parse(generationFile(composed.generation, final, 'inputs.json').toString('utf8'))
    const configPath = path.join(final, 'atelier.project.json')
    const resolved = resolveProjectConfig({ argv: [`--project-config=${configPath}`], cwd: final, env: { PATH: process.env.PATH }, writeLocalState: false })
    // The same pinned resolution compose made; anything else means the generation changed between the two reads.
    if (JSON.stringify(resolved.config) !== JSON.stringify(JSON.parse(projectBytes.toString('utf8')))) throw new PersonalWorkspaceRefusal('generation-corrupt')
    if (validateProjectConfigDoc(resolved.config).length > 0) throw new PersonalWorkspaceRefusal('generation-corrupt')
    if (resolved.localOverlay.paths.length > 0 || resolved.repos.some((repo) => repo.pathSource !== 'tracked-config')) throw new PersonalWorkspaceRefusal('ambient-overlay-present')
    const overlayRepoId = `personal-${inputs.manifest.workspaceId}`
    const overlayRepo = resolved.repos.find((repo) => repo.name === overlayRepoId)
    if (!overlayRepo || overlayRepo.path !== path.join(final, 'overlay')) throw new PersonalWorkspaceRefusal('generation-corrupt')

    const binding = Object.freeze({ personalHome, generationId, overlayRepoId })
    ROUTES.set(binding, compose)
    const member = deepFreeze(personalWorkspaceScopes(inputs.overlay, generationId))
    const project = {
      ...resolved,
      config: { ...resolved.config, ext: { ...(resolved.config.ext ?? {}), [OBSIDIAN_EXT_KEY]: member } },
      configDir: personalHome,
      [BINDING]: binding,
    }
    project.localState = ensureLocalState(project, { write: false, env: { PATH: process.env.PATH } })
    return Object.freeze({ project, binding, preferences: deepFreeze(structuredClone(composed.preferences ?? {})), coverage: composed.coverage })
  }
}

export const bindPersonalWorkspace = createPersonalWorkspaceBinderForOracleTests()

// The project of a binding, for a loader: a refusal of the personal-workspace module becomes the maintenance refusal
// with the same code, as at every build, so the engine and every command report it typed and no view stays current.
export function loadBoundProject({ personalHome, generationId } = {}, { bind = bindPersonalWorkspace } = {}) {
  try {
    return bind({ personalHome, generationId }).project
  } catch (error) {
    if (error instanceof PersonalWorkspaceRefusal) refuse(error.code, 'the personal workspace refused this generation; nothing is loaded from it', { source: 'personal-workspace' })
    throw error
  }
}

// The binding a project carries, or null for every other project.
export function personalWorkspaceBindingOf(project) {
  return project !== null && typeof project === 'object' && Object.hasOwn(project, BINDING) ? project[BINDING] : null
}

// The composed graph of a bound project, or null when the project carries no binding. Asked on every build: a
// generation that has gone stale, been edited or moved, or whose inputs no longer hold, refuses here, with the
// personal-workspace module's own code, as a maintenance refusal every caller already reports.
export function personalWorkspaceGraph(project) {
  const binding = personalWorkspaceBindingOf(project)
  if (binding === null) {
    if (project?.config?.ext?.[OBSIDIAN_EXT_KEY]?.ext?.[PERSONAL_MEMBER_KEY] !== undefined) refuse('personal-binding-lost', 'the project names a personal workspace but carries no binding (a copy of a bound project); nothing is prepared from it')
    return null
  }
  const compose = ROUTES.get(binding)
  if (compose === undefined) refuse('personal-binding-unrecognized', 'the project carries a personal-workspace binding this release did not make; nothing is prepared from it')
  if (project.configPath !== path.join(generationRoot(binding), 'atelier.project.json')) refuse('personal-binding-mismatch', 'the project is not the configuration of the generation it is bound to; nothing is prepared from it')
  try {
    return compose({ personalHome: binding.personalHome, generationId: binding.generationId }).graph
  } catch (error) {
    if (error instanceof PersonalWorkspaceRefusal) refuse(error.code, 'the personal workspace refused this generation; nothing is prepared from it', { source: 'personal-workspace' })
    throw error
  }
}

// The authored and generation files whose change means the binding must be asked again: the manifest, the overlay and
// the bound generation's record. Observed as configuration by the engine. Empty for any other project.
export function personalWorkspaceInputs(project) {
  const binding = personalWorkspaceBindingOf(project)
  if (binding === null) return []
  return [path.join(binding.personalHome, 'atelier.personal.json'), path.join(binding.personalHome, 'atelier.overlay.json'), path.join(generationRoot(binding), 'generation.json')]
}

// The repository of a bound project's private notes, or null. A vault edit to one of them is a proposal only: it is
// never applied into a module-owned generation.
export function personalOverlayRepoOf(project) {
  return personalWorkspaceBindingOf(project)?.overlayRepoId ?? null
}

// Settings that a personal binding takes from the overlay or does not have yet. A saved view is authored in the
// overlay, so `view add` would write a module-owned generation file; who may see and where vaults live wait for a
// stable per-person projection configuration. Refused before anything is resolved or written.
export function refuseOnPersonalBinding(project, operation) {
  if (personalWorkspaceBindingOf(project) === null) return
  if (operation === 'view add') refuse('views-from-personal-overlay', 'the views of a personal workspace come from its overlay; nothing was written', { operation })
  refuse('personal-binding-decision-unavailable', `${operation} is not available for a personal workspace yet; nothing was written`, { operation })
}
