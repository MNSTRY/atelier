import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { readObsidianEnablement } from './enablement.mjs'
import { configFilesOf } from './engine.mjs'
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
// two seconds for every vault it holds open. The project is therefore kept,
// and loaded again only when a file that decides what it is changed: the
// files the engine observes as configuration (configFilesOf), compared at
// every request by a digest of their bytes, never by their times. That digest
// is read before the load it vouches for, so a change that lands during a load
// is seen by the next request; a project is first kept by the second load,
// once the files that decide it are known. A file that is there and does not
// read as a regular file (a link, a folder in its place) vouches for nothing:
// the project is then loaded at every request. The pointer and the place of
// the workspace's private state are read at every request.
//
// A loader may answer a promise (one that composes a personal workspace off
// the event loop). The answer to a request never waits for it: a plugin gives
// a request a second and a half, and takes an answer that does not come for a
// service that is gone. The load is started, one at a time, and until it has
// answered the view is not permitted; a later request is decided from what it
// loaded, under the same digest. A load that fails is asked for again by the
// next request. With such a loader, a file that vouches for nothing permits
// nothing: no request is there when its load answers.

const absent = (file) => { try { return fs.lstatSync(file, { throwIfNoEntry: false }) === undefined } catch (error) { return error.code === 'ENOTDIR' } }

// One digest over the bytes of every file, in order. Null when one of them cannot vouch.
function digestOf(files) {
  const hash = createHash('sha256')
  for (const file of files) {
    let facts
    try { facts = readFileFacts(file) } catch { return null }
    if (facts === null && !absent(file)) return null
    hash.update(`${JSON.stringify([file, facts?.digest ?? null])}\n`)
  }
  return hash.digest('hex')
}

const sameFiles = (left, right) => left.length === right.length && left.every((file, index) => file === right[index])

// The views the project enables. Settings that refuse enable none.
function viewsOf(project) {
  try {
    const enablement = readObsidianEnablement(project)
    return new Set(enablement.state === 'enabled' ? enablement.scopes.map((scope) => scope.scopeId) : [])
  } catch { return new Set() }
}

// `resolveWorkspace(project)` answers { workspaceId, workspaceRoot } as the project names them now, or null.
export function createViewPermission({ loadProject, resolveWorkspace, workspaceId, workspaceRoot }) {
  if (typeof loadProject !== 'function') throw new TypeError('a view permission needs loadProject')
  if (typeof resolveWorkspace !== 'function') throw new TypeError('a view permission needs resolveWorkspace')
  // The files that decided the project last loaded; that project, while their bytes are the ones read before it was
  // loaded; and whether a load that answered a promise is still under way.
  let files = null
  let kept = null
  let loading = false

  function keep(project, digest) {
    const decided = configFilesOf(project).map((file) => file.absolute)
    const loaded = { project, views: viewsOf(project), digest }
    kept = digest !== null && files !== null && sameFiles(decided, files) ? loaded : null
    files = decided
    return loaded
  }

  // The project as it is now, or null while that is not known.
  function current() {
    const digest = files === null ? null : digestOf(files)
    if (kept !== null && digest !== null && digest === kept.digest) return kept
    kept = null
    if (loading) return null
    const answer = loadProject()
    if (typeof answer?.then !== 'function') return keep(answer, digest)
    loading = true
    Promise.resolve(answer).then((project) => { keep(project, digest) }).catch(() => {}).then(() => { loading = false })
    return null
  }

  return function permits(scopeId) {
    try {
      const now = current()
      if (now === null || !now.views.has(scopeId)) return false
      const workspace = resolveWorkspace(now.project)
      return workspace?.workspaceId === workspaceId && workspace.workspaceRoot === workspaceRoot
    } catch { return false }
  }
}
