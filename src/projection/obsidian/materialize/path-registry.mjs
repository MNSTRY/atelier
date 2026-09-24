import { createHash } from 'node:crypto'
import {
  FOLDER_NAME_BYTES, MIN_NAME_BYTES, QUALIFIER_STEM_BYTES, collisionKey, cutName, extensionOf, fileNameParts, fileStemOf, folderNameOf, identitySuffix,
  isReadableVaultPath, joinFileName, notePath, noteNameOf, qualifierIdOf, vaultName,
} from '../contracts.mjs'
import { refuse } from './byte-lens.mjs'

export { collisionKey }

// Vault paths of layout 2 (see "Vault layout" in docs/obsidian-contract.md):
//
//   <repository folder>/<source directory>/<title>.md           a Markdown note
//   <repository folder>/<source directory>/<file name>          a wrapped file
//   <repository folder>/<source directory>/<file name>.md       its note
//   <repository folder>/<source directory>/<file name>          an embedded asset
//
// Each view allocates among its own notes and embedded assets only, seeded
// from what its own prior generation published. A path stays while its note
// is in the view; a note that leaves the view releases its path there; a
// note of another view, or one that was never in this one, never causes a
// qualifier. One identity may have different paths in different views.
// Paths the caller names as occupied (files held for an edit, which stay in
// the vault) are never taken.
//
// A source that does not fit is laid out anyway, and reported: a folder chain
// too long for the path budget keeps a readable prefix and a short stable id,
// and a source folder that meets a file of the same name is qualified with
// one. Each is a diagnostic naming the note.
//
// The persistent path registry holds each view's last allocation, for a
// selection resolved without the view's generation: { schema, workspaceId,
// layout: 2, entries: [], assets: [], views: { <scopeId>: { entries, assets }
// } }, entries { repoId, nodeId, path[, attachment] }, assets { repoId,
// assetPath, path }. The top-level `entries` and `assets` stay empty; they
// held the workspace-wide allocation of an earlier revision. A registry
// without `layout: 2` is a layout 1 registry and holds no view.

export const PATH_REGISTRY_SCHEMA = 'atelier-obsidian-path-registry/v1'
export const PATH_REGISTRY_LAYOUT = 2
export const DEFAULT_MAX_FULL_PATH_BYTES = 1024
const MAX_COMPONENT_BYTES = 255
const MAX_QUALIFIER_ID = 16
// What a folder chain leaves for the name after it, beyond the separator,
// the shortest title and the extensions: nothing at first, and room for both
// qualifiers at their longest when the name had to be qualified.
const QUALIFIED_NAME_BYTES = (QUALIFIER_STEM_BYTES + 3) + (MAX_QUALIFIER_ID + 3)

const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0)
export const identityKey = (repoId, nodeId) => `${repoId}\u0000${nodeId}`
const assetKey = (repoId, assetPath) => `${repoId}\u0000${assetPath}`
const bytesOf = (value) => Buffer.byteLength(value, 'utf8')
const baseOf = (filePath) => filePath.slice(filePath.lastIndexOf('/') + 1)
const byIdentity = (left, right) => compare(left.repoId, right.repoId) || compare(left.nodeId, right.nodeId)
const byAsset = (left, right) => compare(left.repoId, right.repoId) || compare(left.assetPath, right.assetPath)

// ---------------------------------------------------------------------------
// The registry document
// ---------------------------------------------------------------------------

export function emptyPathRegistry(workspaceId) {
  return { schema: PATH_REGISTRY_SCHEMA, workspaceId, layout: PATH_REGISTRY_LAYOUT, entries: [], assets: [], views: {} }
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// The views of a registry document, or {} for none (no registry, a layout 1
// registry, or one written before views). A document of another shape or
// another workspace refuses.
export function viewsOfRegistry(registry, workspaceId) {
  if (registry === undefined || registry === null) return {}
  if (registry.schema !== PATH_REGISTRY_SCHEMA || !Array.isArray(registry.entries)) refuse('invalid-path-registry', 'path registry has an unknown shape')
  if (registry.workspaceId !== workspaceId) refuse('invalid-path-registry', 'path registry belongs to another workspace')
  if (registry.layout !== PATH_REGISTRY_LAYOUT || registry.views === undefined) return {}
  if (!isPlainObject(registry.views)) refuse('invalid-path-registry', 'path registry has an unknown shape')
  for (const section of Object.values(registry.views)) {
    if (!isPlainObject(section) || !Array.isArray(section.entries) || !Array.isArray(section.assets)) refuse('invalid-path-registry', 'path registry has an unknown shape')
  }
  return registry.views
}

// The registry document with one view's allocation replaced.
export function withViewSection(registry, { workspaceId, scopeId, section }) {
  return { ...emptyPathRegistry(workspaceId), views: { ...viewsOfRegistry(registry, workspaceId), [scopeId]: section } }
}

// ---------------------------------------------------------------------------
// Allocation of one view
// ---------------------------------------------------------------------------

// Everything allocated so far: files and folders by collision key, so a
// newcomer is compared the way a case- and normalization-insensitive file
// system compares, and the one spelling every folder has.
function newState() {
  return { byIdentity: new Map(), byAsset: new Map(), files: new Map(), folders: new Map(), repoFolders: new Map(), repoFolderOwners: new Map() }
}

function claimFolders(state, filePath) {
  const parts = filePath.split('/').slice(0, -1)
  for (let index = 1; index <= parts.length; index += 1) {
    const folder = parts.slice(0, index).join('/')
    const key = collisionKey(folder)
    const spelled = state.folders.get(key)
    if (spelled === undefined) {
      if (state.files.has(key)) refuse('path-collision', 'a folder would take the name of an allocated file')
      state.folders.set(key, folder)
    } else if (spelled !== folder) {
      refuse('invalid-path-registry', 'the published paths spell one folder two ways')
    }
  }
}

function claimFile(state, filePath, owner) {
  const key = collisionKey(filePath)
  if (state.files.has(key) || state.folders.has(key)) refuse('path-collision', 'the published paths give one path to more than one file')
  claimFolders(state, filePath)
  state.files.set(key, owner)
}

function claimRepositoryFolder(state, repoId, folder) {
  const known = state.repoFolders.get(repoId)
  if (known !== undefined) {
    if (known !== folder) refuse('invalid-path-registry', 'the published paths give one repository two folders')
    return
  }
  if (state.repoFolderOwners.has(collisionKey(folder))) refuse('invalid-path-registry', 'the published paths give two repositories one folder')
  state.repoFolders.set(repoId, folder)
  state.repoFolderOwners.set(collisionKey(folder), repoId)
}

// Whether `filePath` could be claimed as spelled, without claiming it.
function claimable(state, filePath) {
  const key = collisionKey(filePath)
  if (state.files.has(key) || state.folders.has(key)) return false
  const parts = filePath.split('/').slice(0, -1)
  for (let index = 1; index <= parts.length; index += 1) {
    const folder = parts.slice(0, index).join('/')
    const spelled = state.folders.get(collisionKey(folder))
    if (spelled === undefined ? state.files.has(collisionKey(folder)) : spelled !== folder) return false
  }
  return true
}

// How many bytes the longest of `paths` is over a limit: 255 bytes a name, and
// `maxFullPathBytes` with the vault root and its separator.
function overflowOf(paths, { vaultRootBytes, maxFullPathBytes }) {
  return Math.max(0, ...paths.map((filePath) => Math.max(bytesOf(baseOf(filePath)) - MAX_COMPONENT_BYTES, vaultRootBytes + 1 + bytesOf(filePath) - maxFullPathBytes)))
}

// What a view's prior generation published, taken as it is for every note and
// asset still in the view. A path that no longer fits the limits (a vault root
// that grew) is allocated again. `published.notes` are { repoId, nodeId, path[,
// attachment] }, `published.assets` { repoId, assetPath, path }.
function seed(state, published, { nodeKeys, assetKeys, limits }) {
  for (const note of [...published.notes].sort(byIdentity)) {
    const wellFormed = typeof note?.repoId === 'string' && note.repoId !== '' && typeof note.nodeId === 'string' && note.nodeId !== ''
      && isReadableVaultPath(note.path) && note.path.endsWith('.md') && note.path.includes('/')
      && (note.attachment === undefined || (isReadableVaultPath(note.attachment) && note.path === `${note.attachment}.md`))
    if (!wellFormed) refuse('invalid-path-registry', 'a published path is malformed')
    const key = identityKey(note.repoId, note.nodeId)
    if (state.byIdentity.has(key)) refuse('duplicate-identity', 'the published paths repeat a canonical identity')
    const paths = [note.path, ...(note.attachment === undefined ? [] : [note.attachment])]
    if (!nodeKeys.has(key) || overflowOf(paths, limits) > 0) continue
    claimRepositoryFolder(state, note.repoId, note.path.split('/')[0])
    for (const filePath of paths) claimFile(state, filePath, key)
    state.byIdentity.set(key, { path: note.path, ...(note.attachment === undefined ? {} : { attachment: note.attachment }) })
  }
  for (const asset of [...published.assets].sort(byAsset)) {
    const wellFormed = typeof asset?.repoId === 'string' && asset.repoId !== '' && typeof asset.assetPath === 'string' && asset.assetPath !== ''
      && isReadableVaultPath(asset.path) && asset.path.includes('/')
    if (!wellFormed) refuse('invalid-path-registry', 'a published path is malformed')
    const key = assetKey(asset.repoId, asset.assetPath)
    if (state.byAsset.has(key)) refuse('duplicate-identity', 'the published paths repeat an asset')
    if (!assetKeys.has(key) || overflowOf([asset.path], limits) > 0) continue
    claimRepositoryFolder(state, asset.repoId, asset.path.split('/')[0])
    claimFile(state, asset.path, `asset\u0000${key}`)
    state.byAsset.set(key, asset.path)
  }
}

// The folder of a repository: its identity made safe, or, when that name is
// taken (by another repository of the view, a file, or a folder spelled
// another way, such as the `notes` folder of a held layout 1 file), the same
// with a short stable id.
function repositoryFolder(state, repoId) {
  const known = state.repoFolders.get(repoId)
  if (known !== undefined) return known
  const plain = folderNameOf(repoId)
  const hex = createHash('sha256').update(repoId).digest('hex')
  for (let length = 0; length <= MAX_QUALIFIER_ID; length += length === 0 ? 6 : 2) {
    const candidate = length === 0 ? plain : `${plain} (${hex.slice(0, length)})`
    const key = collisionKey(candidate)
    if (!state.repoFolderOwners.has(key) && !state.files.has(key) && (state.folders.get(key) ?? candidate) === candidate) return candidate
  }
  return refuse('path-collision', 'unable to allocate a distinct repository folder')
}

// The short stable id of a source folder: hexadecimal characters of the
// SHA-256 of the repository identity and the folder's source path.
const folderIdOf = (repoId, sourceFolder, length = 6) => createHash('sha256').update(`${repoId}\u0000${sourceFolder}`).digest('hex').slice(0, length)

// The folder a source directory mirrors to. Each segment is the source
// folder's name made safe, spelled as a folder already allocated under the
// same parent is spelled when the two differ only in case or normalization; a
// segment that meets an allocated file carries the id of its source folder. A
// chain that leaves less than `reserve` bytes for the name keeps as many
// leading folders as fit, and its last kept folder, cut, carries the id of the
// whole source directory.
function mirroredFolder(state, { repoFolder, repoId, sourcePath, limits, reserve }) {
  const sourceSegments = sourcePath.split('/').slice(0, -1)
  const sourceOf = (count) => sourceSegments.slice(0, count).join('/')
  // One segment under `folder`: its spelling, qualified when it meets a file.
  const under = (folder, segment, source) => {
    let candidate = `${folder}/${segment}`
    let qualified = false
    for (let length = 6; state.files.has(collisionKey(candidate)); length += 2) {
      if (length > MAX_QUALIFIER_ID) refuse('path-collision', 'unable to allocate a distinct folder')
      qualified = true
      candidate = `${folder}/${cutName(segment, FOLDER_NAME_BYTES - (length + 3))} (${folderIdOf(repoId, source, length)})`
    }
    return { folder: state.folders.get(collisionKey(candidate)) ?? candidate, qualified }
  }
  const budget = limits.maxFullPathBytes - limits.vaultRootBytes - 1 - reserve
  let folder = repoFolder
  let qualified = false
  const walked = [repoFolder]
  sourceSegments.forEach((segment, index) => {
    const next = under(folder, folderNameOf(segment), sourceOf(index + 1))
    folder = next.folder
    qualified ||= next.qualified
    walked.push(folder)
  })
  if (bytesOf(folder) <= budget) return { folder, shortened: false, qualified }
  // Too long: the longest walked prefix that leaves room for a cut folder carrying the id of the whole directory.
  const suffix = ` (${folderIdOf(repoId, sourceOf(sourceSegments.length))})`
  for (let count = sourceSegments.length - 1; count >= 0; count -= 1) {
    const room = Math.min(budget - bytesOf(walked[count]) - 1, FOLDER_NAME_BYTES) - bytesOf(suffix)
    const head = room > 0 ? cutName(folderNameOf(sourceSegments[count]), room) : ''
    if (head === '' && count > 0) continue
    const tail = under(walked[count], `${head}${suffix}`.trim(), sourceOf(sourceSegments.length))
    if (bytesOf(tail.folder) <= budget) return { folder: tail.folder, shortened: true, qualified: qualified || tail.qualified }
  }
  return refuse('path-too-long', 'the vault root leaves no room for this folder')
}

// Fits a file name into the limits by cutting the title part `base` further,
// never below MIN_NAME_BYTES. `build(base)` returns the path(s) the name makes.
function fitted(base, build, limits) {
  const paths = build(base)
  const overflow = overflowOf(paths, limits)
  if (overflow === 0) return paths
  const budget = bytesOf(base) - overflow
  if (budget < MIN_NAME_BYTES) refuse('path-too-long', 'an allocated path exceeds the supported path length')
  const shorter = build(cutName(base, budget))
  if (overflowOf(shorter, limits) > 0) refuse('path-too-long', 'an allocated path exceeds the supported path length')
  return shorter
}

const isFree = (state, paths) => paths.every((filePath) => {
  const key = collisionKey(filePath)
  return !state.files.has(key) && !state.folders.has(key)
})

// The names a note tries in order: its title, then qualified by its source
// file stem, then by a short stable id lengthened until it is free.
function noteCandidates(node) {
  const base = noteNameOf(node)
  const stem = vaultName(fileStemOf(node.path), QUALIFIER_STEM_BYTES)
  const names = [(title) => title]
  if (stem !== '') names.push((title) => `${title} (${stem})`)
  for (let length = 6; length <= MAX_QUALIFIER_ID; length += 2) {
    const id = qualifierIdOf(node.repo, node.id, length)
    names.push(stem === '' ? (title) => `${title} (${id})` : (title) => `${title} (${stem}) (${id})`)
  }
  return { base, names }
}

// A file keeps its own name; a collision qualifies its stem with a short id.
function fileCandidates(sourcePath, repoId, identity) {
  const { stem, extension } = fileNameParts(sourcePath)
  const names = [(base) => joinFileName({ stem: base, extension })]
  for (let length = 6; length <= MAX_QUALIFIER_ID; length += 2) {
    const id = qualifierIdOf(repoId, identity, length)
    names.push((base) => joinFileName({ stem: `${base} (${id})`, extension }))
  }
  return { base: stem, names }
}

function allocate(state, { folder, candidates, build, limits }) {
  for (const name of candidates.names) {
    const paths = fitted(candidates.base, (base) => build(`${folder}/${name(base)}`), limits)
    if (isFree(state, paths)) return paths
  }
  return refuse('path-collision', 'unable to allocate a distinct vault path')
}

// The paths of one file (a note, a wrapped file and its note, or an asset),
// allocated fresh and claimed, and what was degraded to lay it out. The folder
// leaves room for the shortest name first; a name that then has to be
// qualified and no longer fits is laid out again under a shorter folder.
function place(state, { repoId, sourcePath, owner, candidates, build, nameBytes, limits }) {
  const repoFolder = repositoryFolder(state, repoId)
  let placed = null
  for (const reserve of [nameBytes, nameBytes + QUALIFIED_NAME_BYTES]) {
    const { folder, shortened, qualified } = mirroredFolder(state, { repoFolder, repoId, sourcePath, limits, reserve })
    try {
      placed = { paths: allocate(state, { folder, candidates, build, limits }), shortened, qualified }
      break
    } catch (error) {
      if (error?.code !== 'path-too-long' || reserve !== nameBytes) throw error
    }
  }
  claimRepositoryFolder(state, repoId, repoFolder)
  for (const filePath of placed.paths) claimFile(state, filePath, owner)
  return { paths: placed.paths, degraded: [...(placed.shortened ? ['folder-shortened'] : []), ...(placed.qualified ? ['folder-qualified'] : [])] }
}

// Allocates the paths of one view: `nodes` are the view's canonical nodes ({
// repo, id, path, title, extension }), `assets` the assets its notes embed ({
// repo, id, path }), `published` what the view's prior generation published (or
// null), `occupied` vault paths that must stay free (files held for an edit).
// Published paths come first, then new nodes and new assets, each in canonical
// identity order, so the result depends on the inputs alone and never on the
// order they are listed in. Returns the view's registry section, the lookups,
// and a diagnostic for every note or asset whose folder was degraded.
export function allocateViewPaths({ published = null, nodes, assets = [], occupied = [], vaultRootBytes = 0, maxFullPathBytes = DEFAULT_MAX_FULL_PATH_BYTES }) {
  const state = newState()
  const limits = { vaultRootBytes, maxFullPathBytes }
  const sortedNodes = [...nodes].sort((left, right) => compare(left.repo, right.repo) || compare(left.id, right.id))
  const nodeKeys = new Set()
  for (const node of sortedNodes) {
    const key = identityKey(node.repo, node.id)
    if (nodeKeys.has(key)) refuse('duplicate-identity', 'more than one node carries the same canonical identity')
    nodeKeys.add(key)
  }
  const sortedAssets = [...new Map(assets.map((asset) => [assetKey(asset.repo, asset.path), asset])).values()].sort((left, right) => compare(left.repo, right.repo) || compare(left.path, right.path))
  const assetKeys = new Set(sortedAssets.map((asset) => assetKey(asset.repo, asset.path)))
  seed(state, { notes: published?.notes ?? published?.entries ?? [], assets: published?.assets ?? [] }, { nodeKeys, assetKeys, limits })
  for (const filePath of [...new Set(occupied)].sort()) {
    if (typeof filePath !== 'string' || !isReadableVaultPath(filePath) || state.files.has(collisionKey(filePath)) || !claimable(state, filePath)) continue
    claimFile(state, filePath, 'occupied')
  }
  const diagnostics = []
  for (const node of sortedNodes) {
    const key = identityKey(node.repo, node.id)
    if (state.byIdentity.has(key)) continue
    const wrapped = extensionOf(node) !== 'md'
    const { paths, degraded } = place(state, {
      repoId: node.repo, sourcePath: node.path, owner: key, limits,
      candidates: wrapped ? fileCandidates(node.path, node.repo, node.id) : noteCandidates(node),
      build: wrapped ? (base) => [base, `${base}.md`] : (base) => [`${base}.md`],
      nameBytes: 1 + MIN_NAME_BYTES + (wrapped ? bytesOf(joinFileName({ stem: '', extension: fileNameParts(node.path).extension })) : 0) + '.md'.length,
    })
    // A wrapped file's paths are [file, note]; a Markdown note's [note].
    const allocated = wrapped ? { path: paths[1], attachment: paths[0] } : { path: paths[0] }
    state.byIdentity.set(key, allocated)
    for (const code of degraded) diagnostics.push({ code, repoId: node.repo, nodeId: node.id, notePath: allocated.path })
  }
  for (const asset of sortedAssets) {
    const key = assetKey(asset.repo, asset.path)
    if (state.byAsset.has(key)) continue
    const { paths, degraded } = place(state, {
      repoId: asset.repo, sourcePath: asset.path, owner: `asset\u0000${key}`, limits,
      candidates: fileCandidates(asset.path, asset.repo, asset.id ?? `${asset.repo}:asset:${asset.path}`), build: (base) => [base],
      nameBytes: 1 + MIN_NAME_BYTES + bytesOf(joinFileName({ stem: '', extension: fileNameParts(asset.path).extension })),
    })
    state.byAsset.set(key, paths[0])
    for (const code of degraded) diagnostics.push({ code, repoId: asset.repo, assetPath: asset.path, filePath: paths[0] })
  }

  const entries = [...state.byIdentity].map(([key, allocated]) => {
    const [repoId, nodeId] = key.split('\u0000')
    return { repoId, nodeId, path: allocated.path, ...(allocated.attachment === undefined ? {} : { attachment: allocated.attachment }) }
  }).sort(byIdentity)
  const assetEntries = [...state.byAsset].map(([key, allocatedPath]) => {
    const [repoId, assetPath] = key.split('\u0000')
    return { repoId, assetPath, path: allocatedPath }
  }).sort(byAsset)
  return {
    section: { entries, assets: assetEntries },
    pathOf: (repoId, nodeId) => state.byIdentity.get(identityKey(repoId, nodeId))?.path ?? null,
    attachmentOf: (repoId, nodeId) => state.byIdentity.get(identityKey(repoId, nodeId))?.attachment ?? null,
    assetPathOf: (repoId, assetPathValue) => state.byAsset.get(assetKey(repoId, assetPathValue)) ?? null,
    diagnostics,
  }
}

// ---------------------------------------------------------------------------
// Layout 1
// ---------------------------------------------------------------------------

const LEGACY_NOTE_PATH = /^notes\/([^/\\\u0000]+)--([0-9a-f]{12,64})\.md$/
const LEGACY_SUFFIX = 64
// Bytes left for the readable title once the longest suffix, the separator and
// the extension are reserved, so lengthening a suffix never overflows a name.
const LEGACY_TITLE_BYTE_BUDGET = MAX_COMPONENT_BYTES - '--'.length - LEGACY_SUFFIX - '.md'.length

export function titleWithinBudget(title, budget = LEGACY_TITLE_BYTE_BUDGET) {
  let kept = ''
  let bytes = 0
  for (const character of String(title ?? '').normalize('NFC')) {
    bytes += Buffer.byteLength(character, 'utf8')
    if (bytes > budget) break
    kept += character
  }
  return kept
}

// Layout 1 paths, as the earlier release allocated them: the paths a layout 1
// prior generation recorded, then `notes/<title>--<suffix>.md` for every other
// node in canonical identity order, the suffix lengthened on collision.
export function allocateLegacyPaths({ nodes, priorManifest = null, vaultRootBytes = 0, maxFullPathBytes = DEFAULT_MAX_FULL_PATH_BYTES }) {
  const byIdentity = new Map()
  const taken = new Set()
  for (const note of priorManifest?.notes ?? []) {
    const match = LEGACY_NOTE_PATH.exec(note.path)
    if (!match || identitySuffix(note.repoId, note.nodeId, LEGACY_SUFFIX).slice(0, match[2].length) !== match[2]) refuse('invalid-path-registry', 'a layout 1 manifest entry carries a suffix that is not derived from its identity')
    byIdentity.set(identityKey(note.repoId, note.nodeId), note.path)
    taken.add(collisionKey(note.path))
  }
  const seen = new Set()
  for (const node of [...nodes].sort((left, right) => compare(left.repo, right.repo) || compare(left.id, right.id))) {
    const key = identityKey(node.repo, node.id)
    if (seen.has(key)) refuse('duplicate-identity', 'more than one node carries the same canonical identity')
    seen.add(key)
    if (byIdentity.has(key)) continue
    const titled = { repo: node.repo, id: node.id, title: titleWithinBudget(node.title) }
    let length = 12
    let candidate = notePath(titled, length)
    while (taken.has(collisionKey(candidate))) {
      length += 4
      if (length > LEGACY_SUFFIX) refuse('path-collision', 'unable to allocate a distinct note path')
      candidate = notePath(titled, length)
    }
    byIdentity.set(key, candidate)
    taken.add(collisionKey(candidate))
  }
  for (const candidate of byIdentity.values()) {
    const name = candidate.slice('notes/'.length)
    if (Buffer.byteLength(name, 'utf8') > MAX_COMPONENT_BYTES || vaultRootBytes + 1 + Buffer.byteLength(candidate, 'utf8') > maxFullPathBytes) {
      refuse('path-too-long', 'an allocated note path exceeds the supported path length')
    }
  }
  return { pathOf: (repoId, nodeId) => byIdentity.get(identityKey(repoId, nodeId)) ?? null }
}
