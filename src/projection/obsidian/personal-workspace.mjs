import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { PersonalWorkspaceRefusal, composePersonalWorkspace } from '@mnstry/atelier/personal-workspace'
import { ensureLocalState, resolveProjectConfig, validateProjectConfigDoc } from '@mnstry/atelier/project'
import { buildCanonicalGraph } from '../../graph/graph.mjs'
import { refuse } from '../../runtime/obsidian/errors.mjs'
import { OBSIDIAN_EXT_KEY } from './contracts.mjs'

// The one personal-workspace route of the Obsidian projection.
//
// A person's private home holds the authored manifest and overlay, and the
// generations the personal-workspace module materialized from them. A binding
// names one home and one generation, both explicitly: nothing here discovers
// either from the environment or the working directory. The module's
// `composePersonalWorkspace` is the only authority on whether that generation
// may be used.
//
// One graph. Every caller (the engine, view counts, source apply, the proposal
// adapter and the selection operation) builds through the pipeline's
// `buildGraph`, which builds a bound project here: the canonical graph of the
// generation's configuration, with the composition's own rule that no private
// note is a link target, and the caller's file cache. A plain build would
// differ wherever a shared note's link names a private note.
//
// Validity. A graph is returned only under a validity key the composition has
// confirmed: the key names the authored inputs, every file of the generation,
// the private home's own state, any ambient Git variable, and a digest of the
// built graph's facts. A key is confirmed only when the composition accepted
// those inputs and composed a graph with exactly those facts, so a returned
// graph is always one the composition built too. A key not yet confirmed is
// confirmed by composing: synchronously for a caller that builds once, and off
// the event loop, in a worker, for the engine (`validatePersonalWorkspace`).
// What no key can see (an enrolled repository's remote or Git settings) is
// asked of the composition at every full reconciliation.
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
// What each binding was made with: the composition that admitted it, the build that serves its graph, and whether the
// composition can run in a worker (only the module's own can).
const ROUTES = new WeakMap()
// The last validity key the composition confirmed for each binding: { inputs, facts }.
const CONFIRMED = new WeakMap()
export const EVERYTHING_SCOPE_ID = 'everything'
const EXT_SCHEMA = 'atelier-obsidian-ext-settings/v1'
// The settings member of a bound project names its generation here. It survives any copy of the project (a structured
// clone, a JSON round trip) that drops the symbol-keyed binding, so such a copy is refused instead of being built as an
// ordinary project; and a rebound generation changes the member, which invalidates every view. An ordinary project's
// settings may not use this key.
export const PERSONAL_MEMBER_KEY = 'mnstry.atelier.personal-workspace'
// The Obsidian settings contract's limits: at most 256 scopes, one of them `everything`, and at most 256 members in a
// selector's union.
const MAX_SAVED_VIEWS = 255
const MAX_VIEW_REPOSITORIES = 256
// A build that found its validity key unconfirmed, for a caller that confirms it off the event loop and builds again.
export const PERSONAL_VALIDATION_PENDING = 'personal-validation-pending'
const WORKER_KIND = 'atelier-obsidian-personal-composition'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const deepFreeze = (value) => { if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value) } return value }
const sortKeys = (value) => (Array.isArray(value) ? value.map(sortKeys)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])])) : value)
const digestOf = (value) => sha256(JSON.stringify(sortKeys(value)))
const generationRoot = ({ personalHome, generationId }) => path.join(personalHome, 'generations', generationId)
const linkTargetRule = (overlayRepoId) => (node) => node.repo !== overlayRepoId

// The facts of a graph every caller reads: nodes, edges, embeds, assets and link findings.
const graphFactsDigest = (graph) => digestOf([graph.nodes, graph.edges, graph.embeds ?? [], graph.assets ?? [], graph.linkDiagnostics ?? []])

// Everything outside the graph that a composition's answer depends on and a stat or a read can see: the authored inputs,
// every file of the generation (an extra or a missing one too), the private home's own state, and any ambient Git
// variable. Cheap: small files, a few lstat calls.
function inputsDigest({ personalHome, generationId }) {
  const fileDigest = (file) => { try { return sha256(fs.readFileSync(file)) } catch (error) { return `unreadable:${error.code ?? 'error'}` } }
  const stat = (file) => { try { const s = fs.lstatSync(file); return [s.mode, s.uid, s.ino, s.isSymbolicLink()] } catch (error) { return `missing:${error.code ?? 'error'}` } }
  const generation = []
  const walk = (directory, prefix) => {
    let entries
    try { entries = fs.readdirSync(directory, { withFileTypes: true }) } catch (error) { generation.push([prefix, `unreadable:${error.code ?? 'error'}`]); return }
    for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const absolute = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) generation.push([relative, 'link'])
      else if (entry.isDirectory()) { generation.push([relative, stat(absolute)]); walk(absolute, relative) } else generation.push([relative, fileDigest(absolute)])
    }
  }
  const root = generationRoot({ personalHome, generationId })
  walk(root, '')
  let realHome
  try { realHome = fs.realpathSync(personalHome) === personalHome } catch { realHome = false }
  return digestOf({
    authored: ['atelier.personal.json', 'atelier.overlay.json'].map((name) => fileDigest(path.join(personalHome, name))),
    generation,
    roots: [stat(personalHome), realHome, stat(path.join(personalHome, 'generations')), stat(root)],
    ambientGit: Object.keys(process.env).filter((name) => /^GIT_/i.test(name)).sort(),
  })
}

const keyOfComposed = (binding, graph) => ({ inputs: inputsDigest(binding), facts: graphFactsDigest(graph) })

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

// The bound project, from a composition the caller just made: `composed` carries the generation's record, the
// preferences and the coverage, and the validity key that composition confirmed.
function assemble({ personalHome, generationId }, composed, route) {
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
  ROUTES.set(binding, route)
  CONFIRMED.set(binding, composed.key)
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

// A composition in this thread, as the summary a worker sends back.
function composeHere(compose, binding) {
  const composed = compose({ personalHome: binding.personalHome, generationId: binding.generationId })
  return { generation: composed.generation, preferences: composed.preferences, coverage: composed.coverage, key: keyOfComposed(binding, composed.graph) }
}

// A composition in a worker thread, so the event loop of the caller stays free while it runs. Resolves to the summary, or
// to `{ code }` for a refusal; a worker that cannot run answers `personal-composition-unavailable`.
function composeInWorker({ personalHome, generationId }) {
  return new Promise((resolve) => {
    let settled = false
    const settle = (value) => { if (!settled) { settled = true; resolve(value) } }
    let worker
    try { worker = new Worker(new URL(import.meta.url), { workerData: { kind: WORKER_KIND, personalHome, generationId } }) } catch { settle({ code: 'personal-composition-unavailable' }); return }
    worker.once('message', settle)
    worker.once('error', () => settle({ code: 'personal-composition-unavailable' }))
    worker.once('exit', () => settle({ code: 'personal-composition-unavailable' }))
  })
}

// Test seam only: `compose` replaces the module's composePersonalWorkspace for the binding and every validation of
// it, and `build` the canonical build that serves its graph. Production code uses bindPersonalWorkspace.
export function createPersonalWorkspaceBinderForOracleTests({ compose = composePersonalWorkspace, build = null } = {}) {
  const route = { compose, offThread: compose === composePersonalWorkspace, build }
  const bind = ({ personalHome, generationId } = {}) => {
    // The validity authority first: a refusal propagates as the module's own typed refusal, and nothing is read or
    // written after it.
    const composed = composeHere(compose, { personalHome, generationId })
    return assemble({ personalHome, generationId }, composed, route)
  }
  // The same binding, with the composition off the event loop.
  bind.offThread = async ({ personalHome, generationId } = {}) => {
    const composed = route.offThread ? await composeInWorker({ personalHome, generationId }) : composeHere(compose, { personalHome, generationId })
    if (typeof composed.code === 'string') {
      if (composed.code === 'personal-composition-unavailable') refuse(composed.code, 'the personal workspace could not be composed off the event loop; nothing is bound')
      throw new PersonalWorkspaceRefusal(composed.code)
    }
    return assemble({ personalHome, generationId }, composed, route)
  }
  return bind
}

export const bindPersonalWorkspace = createPersonalWorkspaceBinderForOracleTests()

// A refusal of the personal-workspace module becomes the maintenance refusal with the same code, as at every build, so
// the engine and every command report it typed and no view stays current.
const asMaintenanceRefusal = (error, message) => {
  if (error instanceof PersonalWorkspaceRefusal) refuse(error.code, message, { source: 'personal-workspace' })
  throw error
}

// The project of a binding, for a loader that may block (a command run once).
export function loadBoundProject({ personalHome, generationId } = {}, { bind = bindPersonalWorkspace } = {}) {
  try { return bind({ personalHome, generationId }).project } catch (error) { return asMaintenanceRefusal(error, 'the personal workspace refused this generation; nothing is loaded from it') }
}

// The project of a binding, for a loader on a service's event loop: the composition runs in a worker. The engine
// awaits its loader, so this is the loader a service uses.
export async function loadBoundProjectOffThread({ personalHome, generationId } = {}, { bind = bindPersonalWorkspace } = {}) {
  try { return (await bind.offThread({ personalHome, generationId })).project } catch (error) { return asMaintenanceRefusal(error, 'the personal workspace refused this generation; nothing is loaded from it') }
}

// The binding a project carries, or null for every other project.
export function personalWorkspaceBindingOf(project) {
  return project !== null && typeof project === 'object' && Object.hasOwn(project, BINDING) ? project[BINDING] : null
}

// The graph of a bound project, or null when the project carries no binding. `fileCache` and `observedDigest` are the
// caller's, as for any build. With `defer`, a key the composition has not confirmed is not confirmed here: the build
// refuses `personal-validation-pending`, and the caller confirms it off the event loop (validatePersonalWorkspace) and
// builds again.
export function personalWorkspaceGraph(project, { fileCache = null, observedDigest = null, defer = false } = {}) {
  const binding = personalWorkspaceBindingOf(project)
  if (binding === null) {
    if (project?.config?.ext?.[OBSIDIAN_EXT_KEY]?.ext?.[PERSONAL_MEMBER_KEY] !== undefined) {
      refuse('personal-binding-lost', `the project's Obsidian settings use the reserved key ext["${PERSONAL_MEMBER_KEY}"], which only a personal-workspace binding sets, and the project carries no binding; nothing is prepared from it`)
    }
    return null
  }
  const route = ROUTES.get(binding)
  if (route === undefined) refuse('personal-binding-unrecognized', 'the project carries a personal-workspace binding this release did not make; nothing is prepared from it')
  if (project.configPath !== path.join(generationRoot(binding), 'atelier.project.json')) refuse('personal-binding-mismatch', 'the project is not the configuration of the generation it is bound to; nothing is prepared from it')
  const pending = () => refuse(PERSONAL_VALIDATION_PENDING, 'the personal workspace has changed since it was last composed; it is composed again before a graph is used', { source: 'personal-workspace-pending' })
  const confirmed = CONFIRMED.get(binding)
  // Inputs that changed are composed before anything is built from them.
  if (confirmed?.inputs !== inputsDigest(binding)) {
    if (defer) pending()
    confirmHere(route, binding)
  }
  const build = route.build ?? ((target, options) => buildCanonicalGraph(target, { ...options, isLinkTargetEligible: linkTargetRule(binding.overlayRepoId) }))
  const graph = build(project, { fileCache, observedDigest })
  if (CONFIRMED.get(binding)?.facts === graphFactsDigest(graph)) return graph
  if (defer) pending()
  confirmHere(route, binding)
  if (CONFIRMED.get(binding)?.facts === graphFactsDigest(graph)) return graph
  // Composed just now, and still another graph: the sources moved between the two reads, or the build is not the
  // composition's. Nothing is prepared from it.
  return refuse('personal-graph-unconfirmed', 'the graph built for the personal workspace is not the one its composition built; nothing is prepared from it', { source: 'personal-workspace' })
}

function confirmHere(route, binding) {
  try { CONFIRMED.set(binding, composeHere(route.compose, binding).key) } catch (error) { CONFIRMED.delete(binding); asMaintenanceRefusal(error, 'the personal workspace refused this generation; nothing is prepared from it') }
}

// Asks the composition again, off the event loop when it can: `{ ok: true, changed }` when it accepts the generation
// (`changed` when its key differs from the one last confirmed), `{ ok: false, code }` when it refuses. Null for a project
// without a binding. The engine asks this before a build that found its key unconfirmed, and at every full
// reconciliation of a bound project.
export async function validatePersonalWorkspace(project) {
  const binding = personalWorkspaceBindingOf(project)
  if (binding === null) return null
  const route = ROUTES.get(binding)
  if (route === undefined) return { ok: false, code: 'personal-binding-unrecognized' }
  let composed
  if (route.offThread) composed = await composeInWorker(binding)
  else {
    try { composed = composeHere(route.compose, binding) } catch (error) { if (!(error instanceof PersonalWorkspaceRefusal)) throw error; composed = { code: error.code } }
  }
  if (typeof composed.code === 'string') { CONFIRMED.delete(binding); return { ok: false, code: composed.code } }
  const previous = CONFIRMED.get(binding)
  CONFIRMED.set(binding, composed.key)
  return { ok: true, changed: previous?.inputs !== composed.key.inputs || previous?.facts !== composed.key.facts }
}

// The authored and generation files whose change means the binding must be asked again: the manifest, the overlay and
// the bound generation's record. Observed as configuration by the engine. Empty for any other project.
export function personalWorkspaceInputs(project) {
  const binding = personalWorkspaceBindingOf(project)
  if (binding === null) return []
  return [path.join(binding.personalHome, 'atelier.personal.json'), path.join(binding.personalHome, 'atelier.overlay.json'), path.join(generationRoot(binding), 'generation.json')]
}

// The repository of a bound project's private notes, or null. A vault edit to one of them is never applied into a
// module-owned generation, and is not proposed yet: it stays held in the vault.
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

// The worker side of composeInWorker: one composition, its summary, and exit.
if (!isMainThread && workerData?.kind === WORKER_KIND) {
  const binding = { personalHome: workerData.personalHome, generationId: workerData.generationId }
  try {
    parentPort.postMessage(composeHere(composePersonalWorkspace, binding))
  } catch (error) {
    parentPort.postMessage({ code: error instanceof PersonalWorkspaceRefusal ? error.code : 'personal-composition-unavailable' })
  }
}
