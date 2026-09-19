import { identitySuffix, notePath } from '../contracts.mjs'
import { refuse } from './byte-lens.mjs'

// The persistent path registry: one readable note path per canonical identity,
// allocated once per workspace and reused by every scope and generation. A
// path, once allocated, never changes because a source title changed.
//
// The registry is workspace-wide, not view-wide: preparing any view allocates
// for every visible node of the workspace and returns the whole grown registry
// to the caller, which holds it as machine-private trusted state. It therefore
// names visible nodes outside the view's selection. It never includes a
// withheld node: allocation runs over the visible nodes only. A view's
// manifest and notes carry only the paths of the notes the view holds.

export const PATH_REGISTRY_SCHEMA = 'atelier-obsidian-path-registry/v1'

const NOTE_PATH = /^notes\/([^/\\\u0000]+)--([0-9a-f]{12,64})\.md$/
const MAX_COMPONENT_BYTES = 255
const MAX_SUFFIX = 64
// Bytes left for the readable title once the longest suffix, the separator and
// the extension are reserved, so lengthening a suffix never overflows a name.
const TITLE_BYTE_BUDGET = MAX_COMPONENT_BYTES - '--'.length - MAX_SUFFIX - '.md'.length
export const DEFAULT_MAX_FULL_PATH_BYTES = 1024

const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0)
export const identityKey = (repoId, nodeId) => `${repoId}\u0000${nodeId}`

// Two paths that a case-insensitive or normalization-insensitive filesystem
// would treat as one share a collision key.
export function collisionKey(value) {
  return value.normalize('NFKC').toUpperCase().toLowerCase().normalize('NFKC')
}

function titleWithinBudget(title) {
  let kept = ''
  let bytes = 0
  for (const character of String(title ?? '').normalize('NFC')) {
    bytes += Buffer.byteLength(character, 'utf8')
    if (bytes > TITLE_BYTE_BUDGET) break
    kept += character
  }
  return kept
}

export function emptyPathRegistry(workspaceId) {
  return { schema: PATH_REGISTRY_SCHEMA, workspaceId, entries: [] }
}

function indexRegistry(registry, workspaceId) {
  if (registry === undefined || registry === null) return { byIdentity: new Map(), taken: new Map() }
  if (registry.schema !== PATH_REGISTRY_SCHEMA || !Array.isArray(registry.entries)) refuse('invalid-path-registry', 'path registry has an unknown shape')
  if (registry.workspaceId !== workspaceId) refuse('invalid-path-registry', 'path registry belongs to another workspace')
  const byIdentity = new Map()
  const taken = new Map()
  for (const entry of registry.entries) {
    const match = typeof entry?.path === 'string' ? entry.path.match(NOTE_PATH) : null
    if (!match || typeof entry.repoId !== 'string' || typeof entry.nodeId !== 'string') refuse('invalid-path-registry', 'path registry entry is malformed')
    if (identitySuffix(entry.repoId, entry.nodeId, 64).slice(0, match[2].length) !== match[2]) {
      refuse('invalid-path-registry', 'path registry entry carries a suffix that is not derived from its identity')
    }
    const key = identityKey(entry.repoId, entry.nodeId)
    if (byIdentity.has(key)) refuse('duplicate-identity', 'path registry repeats a canonical identity')
    if (taken.has(collisionKey(entry.path))) refuse('path-collision', 'path registry allocates one path to more than one identity')
    byIdentity.set(key, entry.path)
    taken.set(collisionKey(entry.path), key)
  }
  return { byIdentity, taken }
}

// Allocates a path for every node that lacks one and returns the grown
// registry. `nodes` are canonical nodes ({ repo, id, title }); allocation order
// is canonical-identity order, so the result depends on the inputs alone.
export function allocateWorkspacePaths({ registry, workspaceId, nodes, vaultRootBytes = 0, maxFullPathBytes = DEFAULT_MAX_FULL_PATH_BYTES }) {
  const { byIdentity, taken } = indexRegistry(registry, workspaceId)
  const seen = new Set()
  const ordered = [...nodes].sort((left, right) => compare(left.repo, right.repo) || compare(left.id, right.id))
  for (const node of ordered) {
    const key = identityKey(node.repo, node.id)
    if (seen.has(key)) refuse('duplicate-identity', 'more than one node carries the same canonical identity')
    seen.add(key)
    if (byIdentity.has(key)) continue
    const titled = { repo: node.repo, id: node.id, title: titleWithinBudget(node.title) }
    let length = 12
    let candidate = notePath(titled, length)
    while (taken.has(collisionKey(candidate))) {
      length += 4
      if (length > MAX_SUFFIX) refuse('path-collision', 'unable to allocate a distinct note path')
      candidate = notePath(titled, length)
    }
    byIdentity.set(key, candidate)
    taken.set(collisionKey(candidate), key)
  }
  for (const candidate of byIdentity.values()) {
    const name = candidate.slice('notes/'.length)
    if (Buffer.byteLength(name, 'utf8') > MAX_COMPONENT_BYTES || vaultRootBytes + 1 + Buffer.byteLength(candidate, 'utf8') > maxFullPathBytes) {
      refuse('path-too-long', 'an allocated note path exceeds the supported path length')
    }
  }
  const entries = [...byIdentity].map(([key, allocated]) => {
    const [repoId, nodeId] = key.split('\u0000')
    return { repoId, nodeId, path: allocated }
  })
  entries.sort((left, right) => compare(left.repoId, right.repoId) || compare(left.nodeId, right.nodeId))
  return { registry: { schema: PATH_REGISTRY_SCHEMA, workspaceId, entries }, pathOf: (repoId, nodeId) => byIdentity.get(identityKey(repoId, nodeId)) ?? null }
}
