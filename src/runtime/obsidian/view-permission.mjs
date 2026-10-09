import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { readObsidianEnablement } from './enablement.mjs'
import { DEFAULT_FULL_RECONCILIATION_INTERVAL_MS, configFilesOf } from './engine.mjs'
import { readFileFacts } from './observation.mjs'

// Whether the project allows a view of this workspace right now.
//
// What the service stored about a view (its freshness, its pending edits) says
// what was true when it was written. A view can be turned off, or taken out of
// the project, or the project can point at another workspace, well before the
// next tick writes that down; and what a tick then writes still carries the
// view's generations and counts. So before a stored report is told to whoever
// holds the view open, `permits(scopeId)` asks the project as it is at that
// moment:
//
//   the view        the Obsidian settings are enabled and declare it
//   the workspace   the project's pointer names this workspace, and its
//                   private state is where this service keeps it
//
// Whatever cannot be established is "no": a project that does not load,
// settings that refuse, a pointer that cannot be read, a load that has not
// answered yet. Nothing is written. This is not about who may see a note; the
// audiences of machine-settings.mjs decide that when a view is prepared.
//
// Cost. Loading a project runs Git in child processes, and a plugin asks every
// two seconds for every vault it holds open. A project is therefore kept, and
// loaded again only when a file that decides what it is changed: the files the
// engine observes as configuration (configFilesOf), compared at every request
// by a digest of what they hold, never by their times. The pointer and the
// place of the workspace's private state are read at every request.
//
//   what a file holds   its bytes; for a link, the file it leads to and that
//                       file's bytes, as the loader reads through it, so a
//                       link pointed elsewhere is a change. Nothing there is
//                       a state like any other. A folder in a file's place, a
//                       link that leads nowhere or to anything but a regular
//                       file, and a file that does not read vouch for nothing
//   a project is kept   when two loads in a row, each started after the
//                       files were read and found to hold the same, returned
//                       the same project. One load is not enough: a file
//                       changed and changed back while it ran leaves the same
//                       bytes around a project read from other ones, and
//                       reading the files once more when it answers shows
//                       nothing. The second load reads the project again.
//                       The first load of all only tells which files decide
//                       the project, so three loads keep the first project
//                       and two keep one after a change
//   and used            only while the files hold what they held before
//                       those loads, read again at every request
//   and not for long    a kept project is loaded again once it is half as old
//                       as the engine's full reconciliations are apart, and
//                       is never used past that interval: whatever no file
//                       here names is seen by then
//
// While a file vouches for nothing no project is kept: a loader that answers
// at once is asked at every request, and its answer decides that request, as
// it does for the two requests that come before a project is kept.
//
// A loader may answer a promise (one that composes a personal workspace off
// the event loop). The answer to a request never waits for it: a plugin gives
// a request a second and a half, and takes an answer that does not come for a
// service that is gone. The load is started, one at a time, and a request is
// only ever decided from a kept project: until two loads agreed the view is
// not permitted, and while a kept project is loaded again it goes on deciding,
// within its time. A load that has not answered by its deadline is given up,
// and what it answers later is ignored.
//
// A load that fails (it throws, it is refused, it is given up, or it answers a
// promise while a file vouches for nothing) ends whatever was kept, and is not
// asked for again at once: after two seconds, then four, up to thirty, for as
// long as the files hold the same. A change to them, once they are known, is
// tried at once.

// A kept project is never used for longer than the engine goes without a full reconciliation.
export const DEFAULT_KEEP_FOR_MS = DEFAULT_FULL_RECONCILIATION_INTERVAL_MS
// Longer than the two minutes a composition in a worker is given, so one that runs out of its own time answers first.
export const DEFAULT_LOAD_DEADLINE_MS = 150 * 1000
export const DEFAULT_RETRY_AFTER_MS = 2 * 1000
export const DEFAULT_RETRY_AT_MOST_MS = 30 * 1000

// What one file holds, as [path, where a link leads, digest of the bytes]; undefined when it vouches for nothing.
function heldBy(file) {
  let facts
  try { facts = readFileFacts(file) } catch { return undefined }
  if (facts !== null) return [file, null, facts.digest]
  let stat
  try { stat = fs.lstatSync(file, { throwIfNoEntry: false }) } catch (error) { return error.code === 'ENOTDIR' ? [file, null, null] : undefined }
  if (stat === undefined) return [file, null, null]
  if (!stat.isSymbolicLink()) return undefined
  try {
    // As the loader reads it: through every link, to the file at the end. That file's bytes are read from where it is.
    const target = fs.realpathSync(file)
    const led = readFileFacts(target)
    return led === null ? undefined : [file, target, led.digest]
  } catch { return undefined }
}

// One digest over what every file holds, in order. Null when one of them vouches for nothing.
function digestOf(files) {
  const hash = createHash('sha256')
  for (const file of files) {
    const held = heldBy(file)
    if (held === undefined) return null
    hash.update(`${JSON.stringify(held)}\n`)
  }
  return hash.digest('hex')
}

// The views the project enables. Settings that refuse enable none.
function viewsOf(project) {
  try {
    const enablement = readObsidianEnablement(project)
    return new Set(enablement.state === 'enabled' ? enablement.scopes.map((scope) => scope.scopeId) : [])
  } catch { return new Set() }
}

// `resolveWorkspace(project)` answers { workspaceId, workspaceRoot } as the project names them now, or null.
// `now()` answers milliseconds that only go up; the times are this module's defaults unless a test gives its own.
export function createViewPermission({
  loadProject, resolveWorkspace, workspaceId, workspaceRoot, now = () => performance.now(),
  keepForMs = DEFAULT_KEEP_FOR_MS, loadDeadlineMs = DEFAULT_LOAD_DEADLINE_MS, retryAfterMs = DEFAULT_RETRY_AFTER_MS, retryAtMostMs = DEFAULT_RETRY_AT_MOST_MS,
}) {
  if (typeof loadProject !== 'function') throw new TypeError('a view permission needs loadProject')
  if (typeof resolveWorkspace !== 'function') throw new TypeError('a view permission needs resolveWorkspace')
  // The files that decided the project last loaded.
  let files = null
  // What the last load returned that was started over files that vouched: { digest, shape }.
  let seen = null
  // The project two such loads agreed on: { project, views, digest, since }, `since` the start of the second.
  let kept = null
  // A load that answered a promise and has not answered yet: { id, digest, startedAt }.
  let underWay = null
  // Loads that failed in a row while the files held the same: { digest, times, at }.
  let failed = null
  let started = 0

  function fail(digest, at) {
    kept = null
    failed = { digest, times: failed !== null && failed.digest === digest ? failed.times + 1 : 1, at }
  }
  const tooSoon = (digest, at) => failed !== null && failed.digest === digest && at - failed.at < Math.min(retryAtMostMs, retryAfterMs * 2 ** (failed.times - 1))

  // What a load returned; `digest` was read before it started. A project that names other files than the ones read
  // is kept under a digest the next request cannot read again, so it is dropped there, before it decides anything.
  function answered(project, digest, since) {
    files = configFilesOf(project).map((file) => file.absolute)
    const loaded = { project, views: viewsOf(project), digest, since }
    const shape = digest === null ? null : JSON.stringify(project)
    kept = digest !== null && seen !== null && seen.digest === digest && seen.shape === shape ? loaded : null
    seen = digest === null ? null : { digest, shape }
    return loaded
  }

  // Asks the loader. What it returned, when it answers at once; null when it answers a promise.
  function load(digest, at) {
    let answer
    try {
      answer = loadProject()
      if (typeof answer?.then !== 'function') {
        const loaded = answered(answer, digest, at)
        failed = null
        return loaded
      }
    } catch (error) { fail(digest, at); throw error }
    const id = (started += 1)
    underWay = { id, digest, startedAt: at }
    // Only the load under way is listened to: one given up answers nobody.
    const mine = () => { if (underWay?.id !== id) return false; underWay = null; return true }
    Promise.resolve(answer).then((project) => {
      if (!mine()) return
      answered(project, digest, at)
      // While a file vouches for nothing, nothing can be kept from this answer, and no request is here to be decided by it.
      if (digestOf(files) === null) fail(null, now())
      else failed = null
    }, () => { if (mine()) fail(digest, now()) }).catch(() => { fail(digest, now()) })
    return null
  }

  // The project as it is now, or null while that is not known.
  function current() {
    const at = now()
    const digest = files === null ? null : digestOf(files)
    if (kept !== null && (digest !== kept.digest || at - kept.since >= keepForMs)) kept = null
    if (underWay !== null && at - underWay.startedAt >= loadDeadlineMs) { const given = underWay; underWay = null; fail(given.digest, at) }
    if (kept !== null && at - kept.since < keepForMs / 2) return kept
    if (underWay === null && !tooSoon(digest, at)) {
      const loaded = load(digest, at)
      if (loaded !== null) return loaded
    }
    return kept
  }

  return function permits(scopeId) {
    try {
      const known = current()
      if (known === null || !known.views.has(scopeId)) return false
      const workspace = resolveWorkspace(known.project)
      return workspace?.workspaceId === workspaceId && workspace.workspaceRoot === workspaceRoot
    } catch { return false }
  }
}
