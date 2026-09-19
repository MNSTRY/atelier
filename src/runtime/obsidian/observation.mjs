import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DOC_EXTENSIONS } from '../../graph/knowledge-graph.mjs'
import { localOverlayCandidatePaths } from '../../project/config.mjs'
import { openRegularFileNoFollow } from '../../project/private-state.mjs'
import { compareText } from './documents.mjs'

// Observation by digest. The git-based observation of the synchronization
// loop sees only what git tracks inside a repository; a vault is outside every
// repository and ignored by design, so this module looks at files directly and
// never asks git anything.
//
// Three layers, each only ever an accelerator for the next:
//
//   watcher event   names a path to look at now. Events may be lost, repeated
//                   or late on every platform; nothing is decided from one.
//   stat hint       size, modification time, change time and inode. A
//                   difference means "hash this file"; equality means "skip it
//                   on this tick". A hint never reports a change by itself.
//   digest          the only thing that decides. A full reconciliation hashes
//                   every observed file whatever its stat says, so a change
//                   the first two layers missed converges there.

export const sha256Digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

const SKIPPED_DIRECTORIES = new Set(['node_modules'])
const SIDECAR_SUFFIX = '.kg.json'

export const sourceKey = (repoId, relative) => `source\u0000${repoId}\u0000${relative}`
export const configKey = (absolute) => `config\u0000${absolute}`
export const vaultKey = (scopeId, relative) => `vault\u0000${scopeId}\u0000${relative}`

function walk(root, relative, found) {
  let entries
  try { entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true }) } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return found
    throw error
  }
  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) continue
    const child = relative === '' ? entry.name : `${relative}/${entry.name}`
    // Links are not followed: a link could lead outside the repository.
    if (entry.isDirectory()) walk(root, child, found)
    else if (entry.isFile()) found.push(child)
  }
  return found
}

function sourceClass(relative, names) {
  if (relative.endsWith(SIDECAR_SUFFIX)) return 'sidecar'
  const extension = path.posix.extname(relative).toLowerCase()
  if (extension === '.md') return 'source-body'
  // Any other file is a source only when the census could enrol it: a document
  // extension, or a file with a sidecar beside it.
  return DOC_EXTENSIONS.has(extension) || names.has(`${relative}${SIDECAR_SUFFIX}`) ? 'asset' : null
}

// Every file whose bytes can change a view: source bodies, sidecars and the
// assets they enrol, in every enrolled repository. Deliberately a superset of
// the census (it does not apply ignore rules): observing one file too many
// costs a rebuild that produces the same generation, observing one too few
// would leave a view stale.
export function listSourceFiles(project, { assets = [] } = {}) {
  const files = []
  const roots = new Map()
  for (const repo of project.repos ?? []) {
    if (repo.external || typeof repo.path !== 'string' || typeof repo.name !== 'string') continue
    roots.set(repo.name, repo.path)
    const relatives = walk(repo.path, '', [])
    const names = new Set(relatives)
    for (const relative of relatives) {
      const changeClass = sourceClass(relative, names)
      if (changeClass) files.push({ key: sourceKey(repo.name, relative), changeClass, absolute: path.join(repo.path, relative), repoId: repo.name, relative })
    }
  }
  // Embedded assets of the last built graph. The resolver accepts a file in a
  // dot-directory, which the walk skips, and an image has no sidecar, so these
  // are listed by name. Only assets a view may copy are passed in.
  const listed = new Set(files.map((file) => file.key))
  for (const asset of assets) {
    const key = sourceKey(asset.repo, asset.path)
    if (!roots.has(asset.repo) || listed.has(key)) continue
    listed.add(key)
    files.push({ key, changeClass: 'asset', absolute: path.join(roots.get(asset.repo), ...asset.path.split('/')), repoId: asset.repo, relative: asset.path })
  }
  return files
}

// The files that decide what a project is: its configuration, its repository
// access file and every place a local overlay may appear. A path that does
// not exist yet is observed too, so its appearance is a change.
export function listConfigFiles(project) {
  const paths = new Set([project.configPath, project.repoAccessPath, ...localOverlayCandidatePaths({ configDir: project.configDir, env: {} }), ...(project.localOverlay?.paths ?? [])].filter((item) => typeof item === 'string'))
  return [...paths].sort().map((absolute) => ({ key: configKey(absolute), changeClass: 'config', absolute }))
}

export function listVaultNotes({ scopeId, vaultRoot, manifest }) {
  return (manifest?.notes ?? []).map((note) => ({ key: vaultKey(scopeId, note.path), changeClass: 'vault-note', absolute: path.join(vaultRoot, ...note.path.split('/')), scopeId, relative: note.path }))
}

function statHint(file, lstat) {
  let stat
  try { stat = lstat(file) } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
    throw error
  }
  return stat.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino } : null
}

// One read: the digest and the length are of the same bytes.
export function readFileFacts(file) {
  let descriptor
  try { descriptor = openRegularFileNoFollow(file) } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'ELOOP' || error.message === 'state leaf is not a regular file') return null
    throw error
  }
  try {
    const bytes = fs.readFileSync(descriptor)
    return { digest: sha256Digest(bytes), byteLength: bytes.length }
  } finally { fs.closeSync(descriptor) }
}

const sameHint = (left, right) => left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.ino === right.ino

// Reconciles `files` against `index` (a Map owned by the caller) and returns
// the changes, decided by digest alone. `full` hashes everything; otherwise a
// file is hashed when it is new, when its stat hint differs or when a watcher
// named it. Entries under `prefix` that are no longer listed are removals.
export function reconcile({ index, files, prefix, full, hinted = () => false, lstat = fs.lstatSync }) {
  const changes = []
  const present = new Set()
  let hashed = 0
  for (const file of files) {
    present.add(file.key)
    const previous = index.get(file.key)
    const hint = statHint(file.absolute, lstat)
    if (hint === null) {
      if (previous && previous.digest !== null) changes.push({ key: file.key, changeClass: previous.changeClass, kind: 'removed' })
      index.set(file.key, { changeClass: file.changeClass, hint: null, digest: null, byteLength: null })
      continue
    }
    if (!full && previous && previous.digest !== null && previous.hint && sameHint(previous.hint, hint) && !hinted(file.key)) continue
    const facts = readFileFacts(file.absolute)
    const digest = facts?.digest ?? null
    hashed += 1
    if (!previous || previous.digest !== digest || previous.changeClass !== file.changeClass) {
      if (digest !== null || (previous && previous.digest !== null)) changes.push({ key: file.key, changeClass: file.changeClass, kind: !previous || previous.digest === null ? 'added' : digest === null ? 'removed' : 'changed' })
    }
    index.set(file.key, { changeClass: file.changeClass, hint: digest === null ? null : hint, digest, byteLength: facts?.byteLength ?? null })
  }
  for (const [key, previous] of index) {
    if (!key.startsWith(prefix) || present.has(key)) continue
    if (previous.digest !== null) changes.push({ key, changeClass: previous.changeClass, kind: 'removed' })
    index.delete(key)
  }
  return { changes, hashed }
}
