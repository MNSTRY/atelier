import { createHash } from 'node:crypto'
import {
  MIN_NAME_BYTES, ObsidianContractRefusal, QUALIFIER_STEM_BYTES, collisionKey, cutName, extensionOf, fileNameParts, fileStemOf, folderNameOf, identitySuffix,
  isReadableVaultPath, joinFileName, notePath, noteNameOf, qualifierIdOf, vaultName,
} from '../contracts.mjs'
import { refuse } from './byte-lens.mjs'

export { collisionKey }

// The persistent path registry: one vault path per canonical identity,
// allocated once per workspace and reused by every scope and generation. A
// path, once allocated, never changes: not because a source title changed,
// not because another file came or went.
//
// The registry is workspace-wide, not view-wide: preparing any view allocates
// for every visible node and embedded asset of the workspace and returns the
// whole grown registry to the caller, which holds it as machine-private
// trusted state. It therefore names visible nodes outside the view's
// selection. Allocation never runs over a withheld node. A view's manifest and
// notes carry only the paths of the files the view holds.
//
// Layout 2 (see "Vault layout" in docs/obsidian-contract.md):
//
//   <repository folder>/<source directory>/<title>.md           a Markdown note
//   <repository folder>/<source directory>/<file name>          a wrapped file
//   <repository folder>/<source directory>/<file name>.md       its note
//   <repository folder>/<source directory>/<file name>          an embedded asset
//
// The registry document is { schema, workspaceId, layout: 2, entries, assets }
// with entries { repoId, nodeId, path[, attachment][, provisional] } and
// assets { repoId, assetPath, path[, provisional] }. A registry without
// `layout: 2` is a layout 1 registry (`notes/<title>--<suffix>.md`); layout 2
// starts over without it.
//
// Three rules keep the registry true to what views published:
//
//   census       an identity that has left the census (deleted, or renamed
//                into a new identity) releases its paths; one that is only
//                withheld or unselected keeps them
//   provisional  a path allocated while the registry was lost is provisional
//                until a view's published generation confirms it; a view
//                whose generation recorded another path for its note takes
//                that path back when nothing confirmed holds it
//   parking      a node that cannot be laid out (a path too long for the file
//                system, a source folder named like an allocated file) gets no
//                path and is reported; nothing else is refused because of it

export const PATH_REGISTRY_SCHEMA = 'atelier-obsidian-path-registry/v1'
export const PATH_REGISTRY_LAYOUT = 2
export const DEFAULT_MAX_FULL_PATH_BYTES = 1024
const MAX_COMPONENT_BYTES = 255
const MAX_QUALIFIER_ID = 16

const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0)
export const identityKey = (repoId, nodeId) => `${repoId}\u0000${nodeId}`
const assetKey = (repoId, assetPath) => `${repoId}\u0000${assetPath}`
const bytesOf = (value) => Buffer.byteLength(value, 'utf8')
const parentOf = (filePath) => filePath.slice(0, filePath.lastIndexOf('/'))
const baseOf = (filePath) => filePath.slice(filePath.lastIndexOf('/') + 1)

export function emptyPathRegistry(workspaceId) {
  return { schema: PATH_REGISTRY_SCHEMA, workspaceId, layout: PATH_REGISTRY_LAYOUT, entries: [], assets: [] }
}

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
      refuse('invalid-path-registry', 'the path registry spells one folder two ways')
    }
  }
}

function claimFile(state, filePath, owner) {
  const key = collisionKey(filePath)
  if (state.files.has(key) || state.folders.has(key)) refuse('path-collision', 'the path registry allocates one path to more than one file')
  claimFolders(state, filePath)
  state.files.set(key, owner)
}

function claimRepositoryFolder(state, repoId, folder) {
  const known = state.repoFolders.get(repoId)
  if (known !== undefined) {
    if (known !== folder) refuse('invalid-path-registry', 'the path registry gives one repository two folders')
    return
  }
  if (state.repoFolderOwners.has(collisionKey(folder))) refuse('invalid-path-registry', 'the path registry gives two repositories one folder')
  state.repoFolders.set(repoId, folder)
  state.repoFolderOwners.set(collisionKey(folder), repoId)
}

function indexRegistry(registry, workspaceId, census) {
  const state = newState()
  if (registry === undefined || registry === null) return state
  if (registry.schema !== PATH_REGISTRY_SCHEMA || !Array.isArray(registry.entries)) refuse('invalid-path-registry', 'path registry has an unknown shape')
  if (registry.workspaceId !== workspaceId) refuse('invalid-path-registry', 'path registry belongs to another workspace')
  // A layout 1 registry: its paths are the earlier layout's, and layout 2 allocates anew.
  if (registry.layout !== PATH_REGISTRY_LAYOUT) return state
  if (!Array.isArray(registry.assets)) refuse('invalid-path-registry', 'path registry has an unknown shape')
  const seen = new Set()
  for (const entry of registry.entries) {
    const wellFormed = typeof entry?.repoId === 'string' && entry.repoId !== '' && typeof entry.nodeId === 'string' && entry.nodeId !== ''
      && isReadableVaultPath(entry.path) && entry.path.endsWith('.md') && entry.path.includes('/')
      && (entry.attachment === undefined || (isReadableVaultPath(entry.attachment) && entry.path === `${entry.attachment}.md`))
      && (entry.provisional === undefined || entry.provisional === true)
    if (!wellFormed) refuse('invalid-path-registry', 'path registry entry is malformed')
    const key = identityKey(entry.repoId, entry.nodeId)
    if (seen.has(key)) refuse('duplicate-identity', 'path registry repeats a canonical identity')
    seen.add(key)
    if (census.nodes !== null && !census.nodes.has(key)) continue
    claimRepositoryFolder(state, entry.repoId, entry.path.split('/')[0])
    claimFile(state, entry.path, key)
    if (entry.attachment !== undefined) claimFile(state, entry.attachment, key)
    state.byIdentity.set(key, { path: entry.path, ...(entry.attachment === undefined ? {} : { attachment: entry.attachment }), provisional: entry.provisional === true })
  }
  const seenAssets = new Set()
  for (const asset of registry.assets) {
    const wellFormed = typeof asset?.repoId === 'string' && asset.repoId !== '' && typeof asset.assetPath === 'string' && asset.assetPath !== ''
      && isReadableVaultPath(asset.path) && asset.path.includes('/') && (asset.provisional === undefined || asset.provisional === true)
    if (!wellFormed) refuse('invalid-path-registry', 'path registry asset entry is malformed')
    const key = assetKey(asset.repoId, asset.assetPath)
    if (seenAssets.has(key)) refuse('duplicate-identity', 'path registry repeats an asset')
    seenAssets.add(key)
    if (census.assets !== null && !census.assets.has(key)) continue
    claimRepositoryFolder(state, asset.repoId, asset.path.split('/')[0])
    claimFile(state, asset.path, `asset\u0000${key}`)
    state.byAsset.set(key, { path: asset.path, provisional: asset.provisional === true })
  }
  return state
}

// Undoes the claims of one allocation. Folder spellings stay: other files may
// be in those folders.
function release(state, paths) {
  for (const filePath of paths) state.files.delete(collisionKey(filePath))
}

// Whether `filePath` can be claimed as it is spelled: free, every folder of
// it either unclaimed and not a file's name or claimed with this spelling, and
// its top folder the repository's own.
function claimable(state, repoId, filePath) {
  const key = collisionKey(filePath)
  if (state.files.has(key) || state.folders.has(key)) return false
  const parts = filePath.split('/').slice(0, -1)
  for (let index = 1; index <= parts.length; index += 1) {
    const folder = parts.slice(0, index).join('/')
    const spelled = state.folders.get(collisionKey(folder))
    if (spelled === undefined ? state.files.has(collisionKey(folder)) : spelled !== folder) return false
  }
  const known = state.repoFolders.get(repoId)
  const owner = state.repoFolderOwners.get(collisionKey(parts[0]))
  return known === undefined ? owner === undefined : known === parts[0]
}

// The folder of a repository: its identity made safe, or, when another
// repository already has that folder, the same with a short stable id.
function repositoryFolder(state, repoId) {
  const known = state.repoFolders.get(repoId)
  if (known !== undefined) return known
  const plain = folderNameOf(repoId)
  const hex = createHash('sha256').update(repoId).digest('hex')
  for (let length = 0; length <= MAX_QUALIFIER_ID; length += length === 0 ? 6 : 2) {
    const candidate = length === 0 ? plain : `${plain} (${hex.slice(0, length)})`
    const key = collisionKey(candidate)
    if (!state.repoFolderOwners.has(key) && !state.files.has(key)) return candidate
  }
  return refuse('path-collision', 'unable to allocate a distinct repository folder')
}

// The mirrored folder of a source directory. Each segment takes the spelling a
// folder already allocated under the same parent has, when the two differ only
// in case or normalization, so the vault spells every folder one way.
function mirroredFolder(state, repoFolder, sourcePath) {
  let folder = repoFolder
  for (const segment of sourcePath.split('/').slice(0, -1)) {
    const candidate = `${folder}/${folderNameOf(segment)}`
    folder = state.folders.get(collisionKey(candidate)) ?? candidate
  }
  return folder
}

// How many bytes the longest of `paths` is over a limit: 255 bytes a name, and
// `maxFullPathBytes` with the vault root and its separator.
function overflowOf(paths, { vaultRootBytes, maxFullPathBytes }) {
  return Math.max(0, ...paths.map((filePath) => Math.max(bytesOf(baseOf(filePath)) - MAX_COMPONENT_BYTES, vaultRootBytes + 1 + bytesOf(filePath) - maxFullPathBytes)))
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

// Refusals that concern one node's path, not the registry: the node is parked.
const PARKABLE = new Set(['path-too-long', 'path-collision'])
const parkable = (error) => error instanceof ObsidianContractRefusal && PARKABLE.has(error.code)
const sortedNodes = (nodes) => [...nodes].sort((left, right) => compare(left.repo, right.repo) || compare(left.id, right.id))

// The paths one node would take, without claiming anything: every refusal
// happens before the state changes.
function candidatePaths(state, node, limits) {
  const repoFolder = repositoryFolder(state, node.repo)
  const folder = mirroredFolder(state, repoFolder, node.path)
  if (!claimable(state, node.repo, `${folder}/_`)) refuse('path-collision', 'a source folder takes the name of an allocated file')
  if (extensionOf(node) === 'md') return { repoFolder, paths: allocate(state, { folder, candidates: noteCandidates(node), build: (base) => [`${base}.md`], limits }) }
  return { repoFolder, paths: allocate(state, { folder, candidates: fileCandidates(node.path, node.repo, node.id), build: (base) => [base, `${base}.md`], limits }) }
}

// A view's published allocations, taken back where the registry lost them or
// holds only a provisional allocation instead, and confirmed where it agrees.
// A confirmed allocation elsewhere stands: that note moves, and nothing is
// refused. `published.notes` are { repoId, nodeId, path[, attachment] },
// `published.assets` { repoId, assetPath, path }.
function adoptPublished(state, published, census) {
  const claims = []
  for (const note of [...published.notes].sort((left, right) => compare(left.repoId, right.repoId) || compare(left.nodeId, right.nodeId))) {
    const wellFormed = isReadableVaultPath(note.path) && note.path.endsWith('.md') && note.path.includes('/')
      && (note.attachment === undefined || (isReadableVaultPath(note.attachment) && note.path === `${note.attachment}.md`))
    if (!wellFormed) refuse('invalid-path-registry', 'the prior generation records a malformed path')
    const key = identityKey(note.repoId, note.nodeId)
    if (census.nodes !== null && !census.nodes.has(key)) continue
    const paths = [note.path, ...(note.attachment === undefined ? [] : [note.attachment])]
    const current = state.byIdentity.get(key)
    if (current && current.path === note.path && current.attachment === note.attachment) { current.provisional = false; continue }
    if (current && !current.provisional) continue
    claims.push({ key, repoId: note.repoId, paths, current })
  }
  for (const claim of claims) if (claim.current) { release(state, [claim.current.path, ...(claim.current.attachment ? [claim.current.attachment] : [])]); state.byIdentity.delete(claim.key) }
  const provisionalHolders = new Map([...state.byIdentity].filter(([, allocated]) => allocated.provisional).flatMap(([key, allocated]) => [allocated.path, ...(allocated.attachment ? [allocated.attachment] : [])].map((filePath) => [collisionKey(filePath), key])))
  const displaced = new Set()
  for (const claim of claims) {
    // A provisional allocation of an identity this view did not publish there gives way.
    for (const filePath of claim.paths) {
      const holder = provisionalHolders.get(collisionKey(filePath))
      if (holder === undefined || holder === claim.key || !state.byIdentity.has(holder)) continue
      const allocated = state.byIdentity.get(holder)
      release(state, [allocated.path, ...(allocated.attachment ? [allocated.attachment] : [])])
      state.byIdentity.delete(holder)
      displaced.add(holder)
    }
    if (!claim.paths.every((filePath) => claimable(state, claim.repoId, filePath))) { if (claim.current?.provisional) displaced.add(claim.key); continue }
    claimRepositoryFolder(state, claim.repoId, claim.paths[0].split('/')[0])
    for (const filePath of claim.paths) claimFile(state, filePath, claim.key)
    state.byIdentity.set(claim.key, { path: claim.paths[0], ...(claim.paths.length > 1 ? { attachment: claim.paths[1] } : {}), provisional: false })
  }
  for (const asset of [...published.assets].sort((left, right) => compare(left.repoId, right.repoId) || compare(left.assetPath, right.assetPath))) {
    if (!isReadableVaultPath(asset.path) || !asset.path.includes('/')) refuse('invalid-path-registry', 'the prior generation records a malformed path')
    const key = assetKey(asset.repoId, asset.assetPath)
    if (census.assets !== null && !census.assets.has(key)) continue
    const current = state.byAsset.get(key)
    if (current && current.path === asset.path) { current.provisional = false; continue }
    if (current && !current.provisional) continue
    if (current) { release(state, [current.path]); state.byAsset.delete(key) }
    if (!claimable(state, asset.repoId, asset.path)) { if (current) displaced.add(`asset\u0000${key}`); continue }
    claimRepositoryFolder(state, asset.repoId, asset.path.split('/')[0])
    claimFile(state, asset.path, `asset\u0000${key}`)
    state.byAsset.set(key, { path: asset.path, provisional: false })
  }
  return displaced
}

const censusOf = (census) => ({
  nodes: Array.isArray(census?.nodes) ? new Set(census.nodes.map((item) => identityKey(item.repo, item.id))) : null,
  assets: Array.isArray(census?.assets) ? new Set(census.assets.map((item) => assetKey(item.repo, item.path))) : null,
})

// Allocates a path for every node and embedded asset that lacks one and
// returns the grown registry. `nodes` are canonical nodes ({ repo, id, path,
// title, extension }), `assets` canonical assets ({ repo, id, path }).
// `census`, when given, is every node and asset of the workspace ({ nodes:
// [{ repo, id }], assets: [{ repo, path }] }), withheld ones included: an
// allocation of anything else is released. `published`, when given, is what
// the prior generation of the view being prepared allocated (see
// adoptPublished). Published allocations come first, then new nodes and then
// new assets, each in canonical identity order, so the result depends on the
// inputs alone and never on the order they are listed in. A node or asset
// that cannot be laid out is parked: `parked` names it and why, `pathOf` and
// `assetPathOf` answer null for it, and the rest is allocated.
export function allocateWorkspacePaths({ registry, workspaceId, nodes, assets = [], census = null, published = null, vaultRootBytes = 0, maxFullPathBytes = DEFAULT_MAX_FULL_PATH_BYTES }) {
  const known = censusOf(census)
  const state = indexRegistry(registry, workspaceId, known)
  const limits = { vaultRootBytes, maxFullPathBytes }
  // Allocated while the registry was lost: provisional until a published generation confirms it.
  const lost = registry === undefined || registry === null || registry.layout !== PATH_REGISTRY_LAYOUT
  const displaced = published ? adoptPublished(state, { notes: published.notes ?? [], assets: published.assets ?? [] }, known) : new Set()
  const parked = []
  const seen = new Set()
  for (const node of sortedNodes(nodes)) {
    const key = identityKey(node.repo, node.id)
    if (seen.has(key)) refuse('duplicate-identity', 'more than one node carries the same canonical identity')
    seen.add(key)
    if (state.byIdentity.has(key)) continue
    let allocated
    try { allocated = candidatePaths(state, node, limits) } catch (error) {
      if (!parkable(error)) throw error
      parked.push({ repoId: node.repo, nodeId: node.id, reason: error.code })
      continue
    }
    claimRepositoryFolder(state, node.repo, allocated.repoFolder)
    for (const filePath of allocated.paths) claimFile(state, filePath, key)
    const provisional = lost || displaced.has(key)
    // A wrapped file's paths are [file, note]; a Markdown note's [note].
    state.byIdentity.set(key, allocated.paths.length === 1 ? { path: allocated.paths[0], provisional } : { path: allocated.paths[1], attachment: allocated.paths[0], provisional })
  }
  const parkedAssets = new Set()
  const seenAssets = new Set()
  for (const asset of [...assets].sort((left, right) => compare(left.repo, right.repo) || compare(left.path, right.path))) {
    const key = assetKey(asset.repo, asset.path)
    if (seenAssets.has(key)) continue
    seenAssets.add(key)
    if (state.byAsset.has(key)) continue
    let allocated
    try {
      const repoFolder = repositoryFolder(state, asset.repo)
      const folder = mirroredFolder(state, repoFolder, asset.path)
      if (!claimable(state, asset.repo, `${folder}/_`)) refuse('path-collision', 'a source folder takes the name of an allocated file')
      const [assetPathValue] = allocate(state, { folder, candidates: fileCandidates(asset.path, asset.repo, asset.id ?? `${asset.repo}:asset:${asset.path}`), build: (base) => [base], limits })
      allocated = { repoFolder, assetPathValue }
    } catch (error) {
      if (!parkable(error)) throw error
      parkedAssets.add(key)
      continue
    }
    claimRepositoryFolder(state, asset.repo, allocated.repoFolder)
    claimFile(state, allocated.assetPathValue, `asset\u0000${key}`)
    state.byAsset.set(key, { path: allocated.assetPathValue, provisional: lost || displaced.has(`asset\u0000${key}`) })
  }
  // An allocation made under another vault root is checked against this one: what does not fit here is parked here
  // and keeps its allocation.
  const unavailable = new Set()
  for (const [key, allocated] of state.byIdentity) {
    if (overflowOf([allocated.path, ...(allocated.attachment ? [allocated.attachment] : [])], limits) === 0) continue
    unavailable.add(key)
    if (seen.has(key) && !parked.some((item) => identityKey(item.repoId, item.nodeId) === key)) {
      const [repoId, nodeId] = key.split('\u0000')
      parked.push({ repoId, nodeId, reason: 'path-too-long' })
    }
  }
  for (const [key, allocated] of state.byAsset) if (overflowOf([allocated.path], limits) > 0) parkedAssets.add(key)

  const entries = [...state.byIdentity].map(([key, allocated]) => {
    const [repoId, nodeId] = key.split('\u0000')
    return { repoId, nodeId, path: allocated.path, ...(allocated.attachment === undefined ? {} : { attachment: allocated.attachment }), ...(allocated.provisional ? { provisional: true } : {}) }
  }).sort((left, right) => compare(left.repoId, right.repoId) || compare(left.nodeId, right.nodeId))
  const assetEntries = [...state.byAsset].map(([key, allocated]) => {
    const [repoId, assetPath] = key.split('\u0000')
    return { repoId, assetPath, path: allocated.path, ...(allocated.provisional ? { provisional: true } : {}) }
  }).sort((left, right) => compare(left.repoId, right.repoId) || compare(left.assetPath, right.assetPath))
  const available = (key) => (unavailable.has(key) ? null : state.byIdentity.get(key) ?? null)
  return {
    registry: { schema: PATH_REGISTRY_SCHEMA, workspaceId, layout: PATH_REGISTRY_LAYOUT, entries, assets: assetEntries },
    pathOf: (repoId, nodeId) => available(identityKey(repoId, nodeId))?.path ?? null,
    attachmentOf: (repoId, nodeId) => available(identityKey(repoId, nodeId))?.attachment ?? null,
    assetPathOf: (repoId, assetPathValue) => {
      const key = assetKey(repoId, assetPathValue)
      return parkedAssets.has(key) ? null : state.byAsset.get(key)?.path ?? null
    },
    parked: parked.sort((left, right) => compare(left.repoId, right.repoId) || compare(left.nodeId, right.nodeId)),
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
