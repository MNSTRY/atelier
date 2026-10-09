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
//   what a file holds   where it really is and the bytes there: its path
//                       resolved as the system resolves it when the loader
//                       opens it (realpath(3), through a link anywhere on the
//                       way), so a link pointed elsewhere, its own or a
//                       folder's above it, is a change. Nothing there is a
//                       state like any other. A folder in a file's place, a
//                       link that leads nowhere or to anything but a regular
//                       file, and a file that does not read vouch for nothing.
//                       Where the system resolves no path for a regular file
//                       that is there and is not a link (some volumes on
//                       Windows; a C library that needs /proc and has none),
//                       the file holds its own path as given and its bytes: a
//                       link above it pointed elsewhere is not seen there
//   a project is kept   when two loads in a row, each started after the
//                       files were read and found to hold the same, returned
//                       the same project as far as this permission reads one:
//                       the views it enables, and what the service's
//                       workspace resolution reads of it, handed in as
//                       `workspaceInputsOf` (where its pointer
//                       is, the data root its local overlay prefers, the
//                       roots it protects). One load is not enough: a file
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
// whether a request or its own late answer is the first to see the deadline
// passed, and what it answers then is ignored.
//
// A load that fails (it throws, it is refused, it is given up, or it answers a
// promise while a file vouches for nothing) ends whatever was kept, and is not
// asked for again at once: after two seconds, then four, up to thirty, for as
// long as the files hold the same. A change to them is tried at once, once a
// load has named them: until a load has answered, a corrected configuration
// waits for the next try. And while one of them vouches for nothing there is
// no digest to change: under a loader that answers a promise, a change to
// another file waits for the next try as well.
//
// `onLoad({ durationMs, outcome, promised })` is told how long each load took
// and how it ended (`answered`, `failed` or `given-up`): times and codes only.
// createLoadReport, below, counts them and decides which are worth a log line.

// A kept project is never used for longer than the engine goes without a full reconciliation.
export const DEFAULT_KEEP_FOR_MS = DEFAULT_FULL_RECONCILIATION_INTERVAL_MS
// Longer than the two minutes a composition in a worker is given, so one that runs out of its own time answers first.
export const DEFAULT_LOAD_DEADLINE_MS = 150 * 1000
export const DEFAULT_RETRY_AFTER_MS = 2 * 1000
export const DEFAULT_RETRY_AT_MOST_MS = 30 * 1000

// What one file holds, as [path, its real path, digest of the bytes there], or [path, null, null] when it is absent;
// undefined when it vouches for nothing. The real path is the system's own (realpath(3)): JavaScript's realpathSync
// takes a `..` after a link away before following the link, and names a file the loader never opens.
function heldBy(file, realpath) {
  let real
  try { real = realpath(file) } catch {
    // Unresolved. Nothing there is absent. A regular file that is there, and is not a link, is read where it is given
    // (readFileFacts follows no link at its end). A link, resolved or not, never is: it leads nowhere, or nobody can say where.
    let stat
    try { stat = fs.lstatSync(file, { throwIfNoEntry: false }) } catch (inner) { return inner.code === 'ENOTDIR' ? [file, null, null] : undefined }
    if (stat === undefined) return [file, null, null]
    if (!stat.isFile()) return undefined
    real = file
  }
  let facts
  try { facts = readFileFacts(real) } catch { return undefined }
  return facts === null ? undefined : [file, real, facts.digest]
}

// One digest over what every file holds, in order. Null when one of them vouches for nothing.
function digestOver(files, realpath) {
  const hash = createHash('sha256')
  for (const file of files) {
    const held = heldBy(file, realpath)
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

export const STATUS_LOAD_EVENT = 'status-project-loaded'
// A second: most of the second and a half a plugin gives a request, spent on the listener's own event loop.
export const DEFAULT_SLOW_LOAD_MS = 1000

// Counts every load a permission is told about (onLoad), and writes a line for the ones somebody has to see:
//
//   failed, given up   the first in a row, then when the row is 2, 4, 8, ... long, so a loader that keeps failing
//                      writes a line less and less often, never one per try
//   answered           the first after a failure; and one that answered at once and held the event loop for `slowMs`
//                      or more, on the same doubling row while slow loads follow each other
//
// A load that answered in time after another that did writes nothing: that is every load of a healthy service. A
// line holds the event, milliseconds, the outcome and counts; never a path, a view or a message.
export function createLoadReport({ write, slowMs = DEFAULT_SLOW_LOAD_MS }) {
  if (typeof write !== 'function') throw new TypeError('a load report needs somewhere to write')
  const counts = { answered: 0, failed: 0, givenUp: 0, slow: 0, longestMs: 0 }
  const doubled = (row) => (row & (row - 1)) === 0
  let failedInARow = 0
  let slowInARow = 0
  return {
    onLoad({ durationMs, outcome, promised }) {
      const ms = Math.round(durationMs)
      counts.longestMs = Math.max(counts.longestMs, ms)
      if (outcome !== 'answered') {
        counts[outcome === 'given-up' ? 'givenUp' : 'failed'] += 1
        failedInARow += 1
        if (doubled(failedInARow)) write({ event: STATUS_LOAD_EVENT, durationMs: ms, outcome, promised, inARow: failedInARow })
        return
      }
      counts.answered += 1
      const afterFailures = failedInARow
      failedInARow = 0
      const slow = !promised && ms >= slowMs
      slowInARow = slow ? slowInARow + 1 : 0
      if (slow) counts.slow += 1
      if (afterFailures > 0 || (slow && doubled(slowInARow))) {
        write({ event: STATUS_LOAD_EVENT, durationMs: ms, outcome, promised, ...(afterFailures > 0 ? { afterFailures } : {}), ...(slow ? { slow: true, inARow: slowInARow } : {}) })
      }
    },
    // answered, failed, givenUp and slow loads so far, and the longest in milliseconds.
    counts: () => ({ ...counts }),
  }
}

// `resolveWorkspace(project)` answers { workspaceId, workspaceRoot } as the project names them now, or null, and
// `workspaceInputsOf(project)` what it reads of a project to do so, as JSON: the service hands in its own of both
// (resolveServiceWorkspace, serviceWorkspaceInputs), so what two loads are compared by is never a copy kept here.
// `now()` answers milliseconds that only go up; the times are this module's defaults unless a test gives its own.
// `realpath(file)` resolves a path as the system does; a test hands in one that fails.
export function createViewPermission({
  loadProject, resolveWorkspace, workspaceInputsOf, workspaceId, workspaceRoot, now = () => performance.now(),
  keepForMs = DEFAULT_KEEP_FOR_MS, loadDeadlineMs = DEFAULT_LOAD_DEADLINE_MS, retryAfterMs = DEFAULT_RETRY_AFTER_MS, retryAtMostMs = DEFAULT_RETRY_AT_MOST_MS,
  onLoad = () => {}, realpath = fs.realpathSync.native,
}) {
  if (typeof loadProject !== 'function') throw new TypeError('a view permission needs loadProject')
  if (typeof resolveWorkspace !== 'function') throw new TypeError('a view permission needs resolveWorkspace')
  if (typeof workspaceInputsOf !== 'function') throw new TypeError('a view permission needs workspaceInputsOf')
  const digestOf = (files) => digestOver(files, realpath)
  // What two loads have to agree on: the views, and what the workspace is resolved from. Nothing else of a project is
  // compared, so a field that differs from load to load (a time, a binding under a symbol key) does not keep a project
  // from being kept, and nothing a decision reads is left out.
  const decidedBy = (project, views) => JSON.stringify([[...views].sort(), workspaceInputsOf(project)])
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
  const told = (startedAt, outcome, promised) => { try { onLoad({ durationMs: Math.max(0, now() - startedAt), outcome, promised }) } catch { /* only told */ } }

  // What a load returned; `digest` was read before it started. A project that names other files than the ones read
  // is kept under a digest the next request cannot read again, so it is dropped there, before it decides anything.
  function answered(project, digest, since) {
    files = configFilesOf(project).map((file) => file.absolute)
    const views = viewsOf(project)
    const loaded = { project, views, digest, since }
    const shape = digest === null ? null : decidedBy(project, views)
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
        told(at, 'answered', false)
        return loaded
      }
    } catch (error) { fail(digest, at); told(at, 'failed', false); throw error }
    const id = (started += 1)
    underWay = { id, digest, startedAt: at }
    // Only the load under way is listened to: one given up answers nobody. An answer that comes once the deadline has
    // passed gives the load up itself, when no request was there to see the deadline pass first.
    const mine = () => {
      if (underWay?.id !== id) return false
      underWay = null
      if (now() - at < loadDeadlineMs) return true
      fail(digest, now())
      told(at, 'given-up', true)
      return false
    }
    Promise.resolve(answer).then((project) => {
      if (!mine()) return
      answered(project, digest, at)
      // While a file vouches for nothing, nothing can be kept from this answer, and no request is here to be decided by it.
      if (digestOf(files) === null) { fail(null, now()); told(at, 'failed', true) } else { failed = null; told(at, 'answered', true) }
    }, () => { if (mine()) { fail(digest, now()); told(at, 'failed', true) } }).catch(() => { fail(digest, now()); told(at, 'failed', true) })
    return null
  }

  // The project as it is now, or null while that is not known.
  function current() {
    const at = now()
    const digest = files === null ? null : digestOf(files)
    if (kept !== null && (digest !== kept.digest || at - kept.since >= keepForMs)) kept = null
    if (underWay !== null && at - underWay.startedAt >= loadDeadlineMs) { const given = underWay; underWay = null; fail(given.digest, at); told(given.startedAt, 'given-up', true) }
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
