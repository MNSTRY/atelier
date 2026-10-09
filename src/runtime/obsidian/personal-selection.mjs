import path from 'node:path'
import { PersonalWorkspaceRefusal, readPersonalSelectionHead } from '@mnstry/atelier/personal-workspace'
import { ensureLocalState } from '@mnstry/atelier/project'
import { assertPersonalSelection, loadBoundProject, loadBoundProjectOffThread, pinPersonalSelection } from '../../projection/obsidian/personal-workspace.mjs'
import { refuse } from './errors.mjs'

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
// Who may see a vault is not decided here: that stays the machine's setting.
//
// Where the workspace is does not wait for a load: a bound project's folder is
// its private home, so the home alone locates it (locatePersonalHome). A
// service resolves its workspace from that at once, and starts, whether or not
// a selection is confirmed; its engine then awaits the loader at each tick.

// The decisions the oracles in test/obsidian-personal-selection.test.mjs are
// sensitive to. Production always uses these; a test hands a loader a broken
// one (`rules`) to prove that its oracle can fail.
export const SELECTION_PRIMITIVES = Object.freeze({
  // The head is read again once the generation is loaded.
  readsHeadAgain: true,
  // What the loaded project is pinned for (pinPersonalSelection).
  pin: Object.freeze({ observe: true, recheck: true }),
})

const SOURCE = Object.freeze({ source: 'personal-workspace' })

// The record the history ends with. A history without one refuses.
function confirmedHead(personalHome) {
  let head
  try { head = readPersonalSelectionHead({ personalHome }) } catch (error) {
    if (!(error instanceof PersonalWorkspaceRefusal)) throw error
    refuse(error.code, 'the selection history of the personal workspace could not be read; nothing is loaded from it', SOURCE)
  }
  if (head.selected === null) refuse('nothing-selected', 'no generation of the personal workspace is confirmed; nothing is loaded until one is', SOURCE)
  return head
}

function pinned(project, head, rules) {
  pinPersonalSelection(project, head, rules.pin)
  if (rules.readsHeadAgain) assertPersonalSelection(project)
  return project
}

// What the workspace of a bound personal home is resolved from, without loading anything: a project that holds the home
// as its folder and nothing else, as a bound project's folder is. Its pointer is under the home, the data root is the
// pointer's or the caller's, and a home is outside every Git worktree. Synchronous; nothing is composed.
export function locatePersonalHome({ personalHome } = {}) {
  if (typeof personalHome !== 'string' || !path.isAbsolute(personalHome) || path.resolve(personalHome) !== personalHome) refuse('path-not-absolute', 'a personal home is named by its absolute path', SOURCE)
  const located = { configDir: personalHome }
  located.localState = ensureLocalState(located, { write: false, env: { PATH: process.env.PATH } })
  return located
}

// The project of the confirmed selection, for a loader that may block (a command run once). `bind` and `rules` are
// test seams.
export function loadSelectedProject({ personalHome } = {}, { bind, rules = SELECTION_PRIMITIVES } = {}) {
  const head = confirmedHead(personalHome)
  return pinned(loadBoundProject({ personalHome, generationId: head.selected }, { bind }), head, rules)
}

// The same, for a loader on a service's event loop: the composition runs in a worker, and the engine awaits it.
export async function loadSelectedProjectOffThread({ personalHome } = {}, { bind, rules = SELECTION_PRIMITIVES } = {}) {
  const head = confirmedHead(personalHome)
  return pinned(await loadBoundProjectOffThread({ personalHome, generationId: head.selected }, { bind }), head, rules)
}
