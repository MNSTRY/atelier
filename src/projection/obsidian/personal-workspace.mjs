import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { PersonalWorkspaceRefusal, composePersonalWorkspace, readPersonalSelectionHead } from '@mnstry/atelier/personal-workspace'
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
// confirmed: the key names the inputs a stat or a bounded read can see (see
// inputsDigest) and a digest of the built graph's facts. The inputs are read
// before composing, so a key is confirmed only when the composition accepted
// those inputs and composed a graph with exactly those facts, and a returned
// graph is always one the composition built too (a change and its exact undo
// during one composition is caught at the next full reconciliation). A key not yet confirmed is
// confirmed by composing: synchronously for a caller that builds once, and off
// the event loop, in a worker with a deadline, for the engine and the proposal
// adapter it runs (`validatePersonalWorkspace`). What no key names is asked of
// the composition at every full reconciliation.
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
// The selection record a binding was loaded under, when its loader followed the person's confirmed selection instead of
// naming a generation itself (runtime/obsidian/personal-selection.mjs): { sequence, head, observe }.
const SELECTED = new WeakMap()
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

// The facts of a graph every caller reads: nodes, edges, embeds, assets, resolved links and every finding.
const graphFactsDigest = (graph) => digestOf([graph.nodes, graph.edges, graph.embeds ?? [], graph.assets ?? [], graph.links ?? [], graph.linkDiagnostics ?? [], graph.diagnostics ?? []])

// The personal-workspace module's read limits: an authored input, and a generation file.
const AUTHORED_LIMIT = 1024 * 1024
const GENERATION_LIMIT = 8 * 1024 * 1024
const NONBLOCK = fs.constants.O_NONBLOCK ?? 0

// One regular file, opened without following a link and without waiting on it (a FIFO or a device never blocks the
// caller), and read up to `limit`. Anything else refuses `code`, as the composition would.
function regularFileBytes(file, limit, code, { follow = false } = {}) {
  let fd
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | (follow ? 0 : fs.constants.O_NOFOLLOW) | NONBLOCK) } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
    throw new PersonalWorkspaceRefusal(code)
  }
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > limit) throw new PersonalWorkspaceRefusal(code)
    return fs.readFileSync(fd)
  } finally { fs.closeSync(fd) }
}
const regularFileDigest = (file, limit, code) => { const bytes = regularFileBytes(file, limit, code); return bytes === null ? 'missing' : sha256(bytes) }
// A Git configuration file, which Git itself reads through a link (a managed dotfile): followed, but still only a
// regular file, bounded, and never waited on.
const configDigest = (file) => { try { const bytes = regularFileBytes(file, AUTHORED_LIMIT, 'malformed-input', { follow: true }); return bytes === null ? 'missing' : sha256(bytes) } catch { return 'not-regular' } }
// The configuration files of an enrolled repository: `.git/config` (through `.git` when it is a link to a directory),
// or, where `.git` is a file (a separate Git directory, a linked worktree, a submodule), the configuration of the
// directory it names and of its common directory. A root that cannot be looked at (a file, a link loop, no permission)
// is recorded as such, so the composition answers with its own code.
function repositoryConfigDigests(repoRoot) {
  const dotGit = path.join(repoRoot, '.git')
  let kind
  try { kind = fs.lstatSync(dotGit, { throwIfNoEntry: false }) } catch (error) { return [`unreadable:${error.code ?? 'error'}`] }
  if (kind === undefined) return ['missing']
  if (kind.isDirectory()) return [configDigest(path.join(dotGit, 'config'))]
  if (kind.isSymbolicLink()) {
    try { if (fs.statSync(dotGit).isDirectory()) return ['linked', fs.realpathSync(dotGit), configDigest(path.join(dotGit, 'config'))] } catch (error) { return [`unreadable:${error.code ?? 'error'}`] }
  }
  let pointer
  try { pointer = regularFileBytes(dotGit, AUTHORED_LIMIT, 'malformed-input', { follow: true }) } catch { return ['not-regular'] }
  const named = /^gitdir:\s*(.+?)\s*$/m.exec(pointer?.toString('utf8') ?? '')
  if (named === null) return ['unnamed']
  const gitDir = path.resolve(repoRoot, named[1])
  let commonDir = null
  try { const common = regularFileBytes(path.join(gitDir, 'commondir'), AUTHORED_LIMIT, 'malformed-input', { follow: true }); if (common !== null) commonDir = path.resolve(gitDir, common.toString('utf8').trim()) } catch { commonDir = 'not-regular' }
  return [gitDir, configDigest(path.join(gitDir, 'config')), commonDir, commonDir === null || commonDir === 'not-regular' ? null : configDigest(path.join(commonDir, 'config'))]
}

// Everything outside the graph that a composition's answer depends on and a stat or a bounded read can see: the authored
// inputs (regular files only), every file of the generation (an extra, missing or irregular one too), the private home's
// own state and any `.git` above it, each enrolled root's link status and Git configuration (its remote and its helpers),
// the user's Git configuration, and any ambient Git variable. A file that is not regular refuses here with the code the
// composition gives it, before anything waits on it.
function inputsDigest({ personalHome, generationId }) {
  const stat = (file) => { try { const s = fs.lstatSync(file); return [s.mode, s.uid, s.ino, s.isSymbolicLink()] } catch (error) { return `missing:${error.code ?? 'error'}` } }
  const authoredBytes = ['atelier.personal.json', 'atelier.overlay.json'].map((name) => regularFileBytes(path.join(personalHome, name), AUTHORED_LIMIT, 'malformed-input'))
  const authored = ['atelier.personal.json', 'atelier.overlay.json'].map((name, index) => [stat(path.join(personalHome, name)), authoredBytes[index] === null ? 'missing' : sha256(authoredBytes[index])])
  const generation = []
  const walk = (directory, prefix) => {
    let entries
    try { entries = fs.readdirSync(directory, { withFileTypes: true }) } catch (error) { generation.push([prefix, `unreadable:${error.code ?? 'error'}`]); return }
    for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) { generation.push([relative, stat(absolute)]); walk(absolute, relative) } else if (entry.isFile()) generation.push([relative, regularFileDigest(absolute, GENERATION_LIMIT, 'generation-corrupt')])
      else throw new PersonalWorkspaceRefusal('generation-corrupt')
    }
  }
  const root = generationRoot({ personalHome, generationId })
  walk(root, '')
  let realHome
  try { realHome = fs.realpathSync(personalHome) === personalHome } catch { realHome = false }
  const ancestorsWithGit = []
  for (let ancestor = personalHome; ; ancestor = path.dirname(ancestor)) {
    if (fs.lstatSync(path.join(ancestor, '.git'), { throwIfNoEntry: false }) !== undefined) ancestorsWithGit.push(ancestor)
    if (ancestor === path.dirname(ancestor)) break
  }
  let repos = []
  // The bytes read above, never the file again.
  try { repos = JSON.parse(authoredBytes[0]?.toString('utf8') ?? '{}').repos.filter((repo) => repo.enrolled).map((repo) => repo.root) } catch { repos = [] }
  const enrolled = repos.map((repoRoot) => {
    let real
    try { real = fs.realpathSync(repoRoot) === repoRoot } catch { real = false }
    return [repoRoot, stat(repoRoot), real, repositoryConfigDigests(repoRoot)]
  })
  const home = process.env.HOME
  const userGit = typeof home === 'string' && path.isAbsolute(home)
    ? [path.join(home, '.gitconfig'), path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'git', 'config')].map(configDigest)
    : ['no-home']
  return digestOf({
    authored,
    generation,
    roots: [stat(personalHome), realHome, stat(path.join(personalHome, 'generations')), stat(path.join(personalHome, 'generations', '.git')), stat(root), ancestorsWithGit],
    enrolled,
    userGit,
    ambientGit: Object.keys(process.env).filter((name) => /^GIT_/i.test(name)).sort(),
  })
}

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
// The inputs are digested BEFORE composing: a single change that lands while the composition runs then either is seen by
// it, or leaves the confirmed key behind, so the next build composes again. A change and its exact undo within one
// composition (A, then B, then A again) is not seen this way: it is caught at the next full reconciliation.
function composeHere(compose, binding) {
  const inputs = inputsDigest(binding)
  const composed = compose({ personalHome: binding.personalHome, generationId: binding.generationId })
  return { generation: composed.generation, preferences: composed.preferences, coverage: composed.coverage, key: { inputs, facts: graphFactsDigest(composed.graph) } }
}

// A composition in a worker thread, so the event loop of the caller stays free while it runs. Resolves to the summary, or
// to `{ code }` for a refusal; a worker that cannot run answers `personal-composition-unavailable`.
// A worker that does not answer within the deadline is terminated and let go of, and the composition refuses
// `personal-composition-unavailable`: the tick does not wait on it. A worker blocked in a system call (a FIFO opened
// for reading, say) cannot be stopped until that call returns: until then it keeps the process from exiting, and each
// such expiry leaves one thread behind. A service stopped in that state needs a kill.
export const WORKER_DEADLINE_MS = 120 * 1000
function composeInWorker({ personalHome, generationId }, { deadlineMs = WORKER_DEADLINE_MS, stallMs = 0 } = {}) {
  return new Promise((resolve) => {
    let settled = false
    let worker = null
    let timer = null
    const settle = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (value.code === 'personal-composition-unavailable' && worker !== null) { worker.unref(); worker.terminate().catch(() => {}) }
      resolve(value)
    }
    try { worker = new Worker(new URL(import.meta.url), { workerData: { kind: WORKER_KIND, personalHome, generationId, stallMs } }) } catch { settle({ code: 'personal-composition-unavailable' }); return }
    timer = setTimeout(() => settle({ code: 'personal-composition-unavailable' }), deadlineMs)
    timer.unref?.()
    worker.once('message', settle)
    worker.once('error', () => settle({ code: 'personal-composition-unavailable' }))
    worker.once('exit', () => settle({ code: 'personal-composition-unavailable' }))
  })
}

// Test seam only: `compose` replaces the module's composePersonalWorkspace for the binding and every validation of
// it, `build` the canonical build that serves its graph, and `worker` the worker's deadline (and a stall, so a worker that
// never answers can be shown). Production code uses bindPersonalWorkspace.
export function createPersonalWorkspaceBinderForOracleTests({ compose = composePersonalWorkspace, build = null, worker = {} } = {}) {
  const route = { compose, offThread: compose === composePersonalWorkspace, build, worker }
  const bind = ({ personalHome, generationId } = {}) => {
    // The validity authority first: a refusal propagates as the module's own typed refusal, and nothing is read or
    // written after it.
    const composed = composeHere(compose, { personalHome, generationId })
    return assemble({ personalHome, generationId }, composed, route)
  }
  // The same binding, with the composition off the event loop.
  bind.offThread = async ({ personalHome, generationId } = {}) => {
    const composed = route.offThread ? await composeInWorker({ personalHome, generationId }, route.worker) : composeHere(compose, { personalHome, generationId })
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
  let inputs
  try { inputs = inputsDigest(binding) } catch (error) { CONFIRMED.delete(binding); asMaintenanceRefusal(error, 'the personal workspace refused this generation; nothing is prepared from it') }
  if (confirmed?.inputs !== inputs) {
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
  if (route.offThread) composed = await composeInWorker(binding, route.worker)
  else {
    try { composed = composeHere(route.compose, binding) } catch (error) { if (!(error instanceof PersonalWorkspaceRefusal)) throw error; composed = { code: error.code } }
  }
  if (typeof composed.code === 'string') { CONFIRMED.delete(binding); return { ok: false, code: composed.code } }
  const previous = CONFIRMED.get(binding)
  CONFIRMED.set(binding, composed.key)
  return { ok: true, changed: previous?.inputs !== composed.key.inputs || previous?.facts !== composed.key.facts }
}

const selectionRecord = ({ personalHome }, sequence) => path.join(personalHome, 'selections', `${String(sequence).padStart(6, '0')}.json`)

// Pins a bound project to the selection record it was loaded under, and answers the project. From then on the engine
// observes that record and the place of the next one as configuration (personalWorkspaceInputs): a confirmation
// appended to the history, or a history cut short, is a change. `observe: false` is a test seam only, the mutation
// control of that observation.
export function pinPersonalSelection(project, { sequence, head }, { observe = true } = {}) {
  SELECTED.set(personalWorkspaceBindingOf(project), Object.freeze({ sequence, head, observe }))
  return project
}

// The selection a project is pinned to, as { personalHome, generationId, sequence, head }; null for any other project.
export function personalSelectionOf(project) {
  const binding = personalWorkspaceBindingOf(project)
  const pinned = binding === null ? undefined : SELECTED.get(binding)
  return pinned === undefined ? null : { personalHome: binding.personalHome, generationId: binding.generationId, sequence: pinned.sequence, head: pinned.head }
}

// Refuses `personal-selection-changed` unless the history still ends with the record this project is pinned to; a
// history that cannot be read refuses with the module's own code. Nothing for a project that is not pinned.
export function assertPersonalSelection(project) {
  const pinned = personalSelectionOf(project)
  if (pinned === null) return
  let now
  try { now = readPersonalSelectionHead({ personalHome: pinned.personalHome }) } catch (error) { asMaintenanceRefusal(error, 'the selection history of the personal workspace could not be read; nothing is used from it') }
  if (now.sequence !== pinned.sequence || now.head !== pinned.head) refuse('personal-selection-changed', 'the confirmed selection of the personal workspace is no longer the one this project was loaded under; nothing is used from it', { source: 'personal-workspace' })
}

// The authored and generation files whose change means the binding must be asked again: the manifest, the overlay and
// the bound generation's record; and, for a project pinned to a selection, that selection's record and the place of the
// next one. Observed as configuration by the engine. Empty for any other project.
export function personalWorkspaceInputs(project) {
  const binding = personalWorkspaceBindingOf(project)
  if (binding === null) return []
  const pinned = SELECTED.get(binding)
  return [
    path.join(binding.personalHome, 'atelier.personal.json'), path.join(binding.personalHome, 'atelier.overlay.json'), path.join(generationRoot(binding), 'generation.json'),
    ...(pinned?.observe ? [selectionRecord(binding, pinned.sequence), selectionRecord(binding, pinned.sequence + 1)] : []),
  ]
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
  // A worker that never answers, for the deadline test only: blocked as a system call would block it.
  if (workerData.stallMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.stallMs)
  try {
    parentPort.postMessage(composeHere(composePersonalWorkspace, binding))
  } catch (error) {
    parentPort.postMessage({ code: error instanceof PersonalWorkspaceRefusal ? error.code : 'personal-composition-unavailable' })
  }
}
