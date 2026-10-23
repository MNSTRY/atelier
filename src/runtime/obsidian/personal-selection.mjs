import fs from 'node:fs'
import path from 'node:path'
import { PersonalWorkspaceRefusal } from '@mnstry/atelier/personal-workspace'
import { ensureLocalState } from '@mnstry/atelier/project'
import { assertPersonalSelection, loadBoundProject, loadBoundProjectOffThread, notePersonalSelectionHead, personalSelectionOf, pinPersonalSelection } from '../../projection/obsidian/personal-workspace.mjs'
import { refuse } from './errors.mjs'
import { readPersonalSelectionSnapshot } from '../../personal-workspace/selection.mjs'
import { assertOutsideRepositories, ensureWorkspaceIdentity, resolveDataRoot, workspaceStateRoot } from './machine-settings.mjs'
import { createSelectionContinuity } from './selection-continuity.mjs'

// A person's confirmed selection, bound to the maintenance runtime.
//
// A personal home keeps a history of the generations its person confirmed
// (`selectPersonalGeneration` of the personal-workspace module). The loaders
// here follow that history instead of naming a generation themselves:
//
//   read the head -> load the generation it names -> read the head again
//
// The head is read from the history alone, in the caller's thread: one
// directory listing and one bounded read per record. Whether the generation
// may be used is composition's to decide, as for any binding: in a worker for
// a service, in the calling thread for a command run once. A head that moved
// while the generation was loaded is another selection, and refuses
// `personal-selection-changed`.
//
// Nothing is confirmed here and nothing is chosen for the person. A history
// with no record, one that does not hold, a home that cannot be read and a
// generation its composition refuses each refuse as a maintenance refusal
// with the module's own code (`nothing-selected`, `selection-history-corrupt`,
// `personal-home-unavailable`, `root-missing`, `stale-generation` and the
// rest). There is no project to fall back to: an engine whose loader refuses
// publishes nothing, and every view it knows says why.
//
// A loaded project is pinned to the record it was loaded under
// (pinPersonalSelection), so the engine observes that record and the place of
// the next one, and loads again at the tick after a confirmation or after the
// history was cut short. At every full reconciliation the history is read
// again, and a project whose record it no longer ends with is refused.
//
// A history never gets shorter through the module: selections are appended and
// nothing removes one. So a history that ends at a lower record than this
// process has read it ending at was cut short by something else, and following
// it back could publish what nobody confirmed after the records removed. Every
// read of the history's end is noted (notePersonalSelectionHead): the first
// read here, the read once the generation is loaded, the recheck of a project
// already loaded, and a read the engine asks for when its guard stops a view
// because an observed file changed or could not be read (once for views
// stopped one after another). A
// history that ends earlier than the highest record noted requires a fresh confirmation or refuses
// `selection-history-shortened` at a load and at a recheck; the guard's read only notes, and
// its view says `mixed-read`. An engine whose project is pinned below the
// highest record noted loads it again at its next tick
// (personalSelectionBehind). A record added and removed between two of those
// reads was never read, and does not count.
//
// The highest number, accepted head and observed record identities are also kept in the workspace's private
// continuity state. A start of the service reads that evidence too. A shorter history remains refused until the
// removed records return or the person makes a fresh confirmation. New confirmations have a unique identity, so
// confirming the same generation against the same predecessor is distinct from restoring an old record's bytes.
//
// Who may see a vault stays the machine's setting: the engine initializes an undecided personal binding as owner only.
//
// Where the workspace is does not wait for a load: a bound project's folder is
// its private home, so the home alone locates it (locatePersonalHome). A
// service resolves its workspace from that at once, and starts, whether or not
// a selection is confirmed; its engine then awaits the loader at each tick.

// The decisions the oracles in test/obsidian-personal-selection.test.mjs are
// sensitive to. Production always uses these; a test hands a loader a broken
// one (`rules`) to prove that its oracle can fail.
export const SELECTION_PRIMITIVES = Object.freeze({
  // A history that ends at a lower record than this process has read is refused, at every read of it.
  refusesShortened: true,
  // The head is read again once the generation is loaded.
  readsHeadAgain: true,
  // What the loaded project is pinned for (pinPersonalSelection).
  pin: Object.freeze({ observe: true, recheck: true }),
})

const SOURCE = Object.freeze({ source: 'personal-workspace' })
const LOCATED = Symbol('atelier.obsidian.located-personal-home')

const CONTINUITY = new Map()

// Resolve the existing workspace authority after the history verified its private home. This manifest read supplies
// exclusion roots only; composition remains the authority for the manifest and generation. Never wait on an irregular
// file or write continuity evidence into a repository while resolving the machine's private state.
function continuityFor({ personalHome, dataRoot, env = process.env, platform = process.platform }) {
  let manifest
  let descriptor
  try {
    descriptor = fs.openSync(path.join(personalHome, 'atelier.personal.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0))
    const stat = fs.fstatSync(descriptor)
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new PersonalWorkspaceRefusal('malformed-input')
    const bytes = fs.readFileSync(descriptor)
    if (bytes.length > 1024 * 1024) throw new PersonalWorkspaceRefusal('malformed-input')
    try { manifest = JSON.parse(bytes) } catch { throw new PersonalWorkspaceRefusal('malformed-input') }
    if (!Array.isArray(manifest?.repos) || manifest.repos.some((repo) => typeof repo?.root !== 'string' || !path.isAbsolute(repo.root) || repo.root.includes('\0'))) throw new PersonalWorkspaceRefusal('malformed-input')
  } catch (error) {
    refuse(error instanceof PersonalWorkspaceRefusal ? error.code : 'personal-home-unavailable', 'the personal workspace manifest could not be read; no selection is loaded', SOURCE)
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor) }
  const project = locatePersonalHome({ personalHome })
  const pointer = ensureWorkspaceIdentity({ project, ...(dataRoot === undefined ? {} : { dataRoot }) })
  const root = workspaceStateRoot(resolveDataRoot({ dataRoot, pointer, project, env, platform }), pointer.workspaceId)
  assertOutsideRepositories({ managedRoot: root, repositoryRoots: [personalHome, ...manifest.repos.map((repo) => repo.root)] })
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const workspaceRoot = fs.realpathSync(root)
  const key = `${personalHome}\0${workspaceRoot}`
  if (!CONTINUITY.has(key)) CONTINUITY.set(key, createSelectionContinuity({ workspaceRoot, workspaceId: pointer.workspaceId, personalHome }))
  return CONTINUITY.get(key)
}

function confirmedHead(options, rules) {
  const { personalHome } = options
  locatePersonalHome({ personalHome })
  let head
  try { head = readPersonalSelectionSnapshot({ personalHome }) } catch (error) {
    if (!(error instanceof PersonalWorkspaceRefusal)) throw error
    refuse(error.code, 'the selection history of the personal workspace could not be read; nothing is loaded from it', SOURCE)
  }
  const continuity = continuityFor(options)
  const note = (current) => { if (rules.refusesShortened) continuity.note(current) }
  notePersonalSelectionHead(personalHome, head, { ...rules, note })
  if (head.selected === null) refuse('nothing-selected', 'no generation of the personal workspace is confirmed; nothing is loaded until one is', SOURCE)
  return { head, note }
}

function pinned(project, { head, note }, rules) {
  pinPersonalSelection(project, head, { ...rules.pin, refusesShortened: rules.refusesShortened, note })
  if (rules.readsHeadAgain) assertPersonalSelection(project)
  return project
}

// What the workspace of a bound personal home is resolved from, without loading anything: a project that holds the home
// as its folder and nothing else, as a bound project's folder is. Its pointer is under the home, the data root is the
// pointer's or the caller's, and a home is outside every Git worktree. Synchronous; nothing is composed.
export function locatePersonalHome({ personalHome } = {}) {
  if (typeof personalHome !== 'string' || !path.isAbsolute(personalHome) || path.resolve(personalHome) !== personalHome) refuse('path-not-absolute', 'a personal home is named by its absolute path', SOURCE)
  const located = { configDir: personalHome, [LOCATED]: personalHome }
  located.localState = ensureLocalState(located, { write: false, env: { PATH: process.env.PATH } })
  return located
}

// The personal home a located or a loaded project follows, which a service it starts or a login item it installs is
// given instead of a project (--personal-home); null for any other project.
export const personalHomeOf = (project) => project?.[LOCATED] ?? personalSelectionOf(project)?.personalHome ?? null
export { personalSelectionOf }

// The project of the confirmed selection, for a loader that may block (a command run once). `bind` and `rules` are
// test seams.
export function loadSelectedProject(options = {}, { bind, rules = SELECTION_PRIMITIVES } = {}) {
  const { personalHome } = options
  const selected = confirmedHead(options, rules)
  return pinned(loadBoundProject({ personalHome, generationId: selected.head.selected }, { bind }), selected, rules)
}

// The same, for a loader on a service's event loop: the composition runs in a worker, and the engine awaits it.
export async function loadSelectedProjectOffThread(options = {}, { bind, rules = SELECTION_PRIMITIVES } = {}) {
  const { personalHome } = options
  const selected = confirmedHead(options, rules)
  return pinned(await loadBoundProjectOffThread({ personalHome, generationId: selected.head.selected }, { bind }), selected, rules)
}
