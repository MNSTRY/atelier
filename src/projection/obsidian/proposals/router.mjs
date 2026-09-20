import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { isIdentifier } from '../edits/object-identity.mjs'

// Routing: which existing proposal store a structural edit belongs to, and the
// name the adapter knows that edit by.
//
// A structural edit is an edit operation of kind `semantic-proposal`. It is a
// request about ONE source document of ONE enrolled repository, so it goes to
// the proposal store of that repository and to no other. The store of a
// repository is the one every other writer of proposals already uses for a
// root: `<repository root>/.atelier-proposals`, the default of
// createProposalStore for that root. Nothing here invents another place, and
// a store is never resolved inside a vault, inside private Obsidian state, or
// for a repository the project does not enrol.
//
// The routing key is the whole identity (workspaceId, repoId, nodeId). Two
// repositories that hold the same relative path and the same local node id
// have different repository identifiers, so they have different roots,
// different stores and different adapter operation identities.
//
// A route that cannot be resolved refuses with a code. A refusal reads and
// writes nothing of the edit: the preserved bytes and the record of the object
// stay exactly as they are.

export const PROPOSAL_STORE_DIRECTORY = '.atelier-proposals'
export const PROPOSAL_STORE_LEDGER = 'events.ndjson'
export const MAX_ROUTED_SOURCE_PATH = 500

export const PROPOSAL_ROUTE_REFUSALS = Object.freeze([
  'invalid-operation',
  'foreign-workspace',
  'repository-not-enrolled',
  'repository-external',
  'repository-root-unreadable',
  'route-withheld',
  'route-visibility-unknown',
  'source-path-invalid',
  'source-path-not-preservable',
  'proposal-store-unsafe',
  'proposal-store-inside-managed-root',
  'proposal-store-not-ignored',
  'proposal-store-ignore-unknown',
])
// Conditions of the machine at this moment rather than of the route: tried again later, within the retry bounds.
export const TRANSIENT_ROUTE_REFUSALS = Object.freeze(['route-visibility-unknown'])

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/
const OPERATION_IDENTITY = /^pa-[0-9a-f]{64}$/
const DOMAIN = 'atelier-obsidian-proposal-adapter/v1'

const hashOf = (parts) => createHash('sha256').update(parts.join('\u0000')).digest('hex')

// The decisions the oracles of test/obsidian-proposals.test.mjs are sensitive
// to. Production always uses these; the tests substitute deliberately broken
// ones through createProposalRouterForOracleTests to prove each oracle can fail.
export const PROPOSAL_ROUTER_PRIMITIVES = Object.freeze({
  // What an adapter operation identity is made from: the whole identity and the idempotency key, in this order.
  identityParts: ({ workspaceId, repoId, nodeId, idempotencyKey }) => [workspaceId, repoId, nodeId, idempotencyKey],
  // The enrolled repository a route goes to: the one the identity names, and no other.
  repositoryOf: ({ project, repoId }) => (project?.repos ?? []).filter((item) => item?.name === repoId),
})

function validIdentityInput({ workspaceId, repoId, nodeId, idempotencyKey }) {
  return [workspaceId, repoId, nodeId].every(isIdentifier) && typeof idempotencyKey === 'string' && IDEMPOTENCY_KEY.test(idempotencyKey)
}

// The adapter operation identity: a fixed-length, lower-case name derived from
// the whole identity and the idempotency key of the edit operation. The parts
// are joined by a character no identifier can hold, so moving a character from
// one part to the next gives another name. It holds only [a-z0-9-], is 67
// characters long, and is carried inside the payload object of a proposal,
// which the store writes and reads back as JSON without normalising it.
function operationIdWith(rules, input) {
  if (!validIdentityInput(input)) throw new TypeError('an adapter operation identity is made from a whole identity and an idempotency key')
  return `pa-${hashOf([DOMAIN, 'operation', ...rules.identityParts(input)])}`
}
export const adapterOperationId = (input) => operationIdWith(PROPOSAL_ROUTER_PRIMITIVES, input)

export const isAdapterOperationId = (value) => typeof value === 'string' && OPERATION_IDENTITY.test(value)

// The store of one repository as this workspace names it. No path is part of it.
export function proposalStoreId({ workspaceId, repoId }) {
  if (![workspaceId, repoId].every(isIdentifier)) throw new TypeError('a proposal store identity is made from a workspace and a repository')
  return `ps-${hashOf([DOMAIN, 'store', workspaceId, repoId, PROPOSAL_STORE_DIRECTORY])}`
}

const inside = (parent, candidate) => {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}
const lstatOrNull = (file) => { try { return fs.lstatSync(file) } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error } }
const realOrSelf = (directory) => { try { return fs.realpathSync.native(directory) } catch { return directory } }

export function isRoutableSourcePath(value) {
  if (typeof value !== 'string' || value === '' || path.isAbsolute(value) || value.includes('\\') || value.includes('\u0000') || /^[A-Za-z]:/.test(value)) return false
  return !value.split('/').some((part) => part === '' || part === '.' || part === '..')
}

// What the existing store does to the `path` of a proposal: trimmed, and cut
// at 500 characters. A path that would not come back as it went in refuses
// before anything is created; it is never recorded cut short.
export const survivesStoreNormalisation = (sourcePath) => sourcePath.trim().slice(0, MAX_ROUTED_SOURCE_PATH) === sourcePath

const refusal = (code, detail = {}) => ({ ok: false, code, transient: TRANSIENT_ROUTE_REFUSALS.includes(code), detail })

// `identity` is { workspaceId, repoId, nodeId }; `sourcePath` is the path of
// the source inside its repository, as the manifest of the view records it.
// `managedRoots` are the private state root and every vault. `isVisible` says
// whether this machine may see the object now: true, false, or null when that
// cannot be decided. `isGitIgnored` answers true, false or null.
//
// { ok: true, route } or { ok: false, code, transient, detail }. Never throws
// for a route that is merely wrong, and writes nothing.
function resolveWith(rules, { project, workspaceId, identity, sourcePath, managedRoots = [], isVisible, isGitIgnored, env = process.env }) {
  if (identity === null || typeof identity !== 'object' || ![identity.workspaceId, identity.repoId, identity.nodeId].every(isIdentifier)) return refusal('invalid-operation', { member: 'identity' })
  if (identity.workspaceId !== workspaceId) return refusal('foreign-workspace')
  const { repoId, nodeId } = identity
  const named = rules.repositoryOf({ project, repoId, nodeId })
  if (named.length !== 1) return refusal('repository-not-enrolled')
  const [repo] = named
  if (repo.external || typeof repo.path !== 'string' || !path.isAbsolute(repo.path)) return refusal('repository-external')
  let repositoryRoot
  try {
    repositoryRoot = fs.realpathSync.native(repo.path)
    if (!fs.statSync(repositoryRoot).isDirectory()) return refusal('repository-root-unreadable')
  } catch { return refusal('repository-root-unreadable') }

  if (!isRoutableSourcePath(sourcePath)) return refusal('source-path-invalid')
  if (!survivesStoreNormalisation(sourcePath)) return refusal('source-path-not-preservable', { length: sourcePath.length, limit: MAX_ROUTED_SOURCE_PATH })

  const storeDirectory = path.join(repositoryRoot, PROPOSAL_STORE_DIRECTORY)
  const present = lstatOrNull(storeDirectory)
  if (present !== null && (present.isSymbolicLink() || !present.isDirectory())) return refusal('proposal-store-unsafe')
  for (const managedRoot of managedRoots) {
    const managed = realOrSelf(managedRoot)
    if (inside(managed, storeDirectory) || inside(storeDirectory, managed)) return refusal('proposal-store-inside-managed-root')
  }

  const visible = isVisible({ workspaceId, repoId, nodeId })
  if (visible === null || visible === undefined) return refusal('route-visibility-unknown')
  if (visible !== true) return refusal('route-withheld')

  // A store that is already there is whatever git already says it is. One that would be made here must not become
  // something git reports: a repository that does not ignore the directory refuses, and nothing is made.
  if (present === null) {
    const ignored = isGitIgnored({ repositoryRoot, relative: `${PROPOSAL_STORE_DIRECTORY}/${PROPOSAL_STORE_LEDGER}`, env })
    if (ignored === false) return refusal('proposal-store-not-ignored')
    if (ignored !== true && lstatOrNull(path.join(repositoryRoot, '.git')) !== null) return refusal('proposal-store-ignore-unknown')
  }

  return {
    ok: true,
    route: Object.freeze({
      workspaceId, repoId, nodeId, sourcePath, repositoryRoot, storeDirectory,
      storeExists: present !== null,
      storeId: proposalStoreId({ workspaceId, repoId }),
    }),
  }
}

export function createProposalRouterForOracleTests(primitives = PROPOSAL_ROUTER_PRIMITIVES) {
  const rules = { ...PROPOSAL_ROUTER_PRIMITIVES, ...primitives }
  return { adapterOperationId: (input) => operationIdWith(rules, input), resolveProposalRoute: (input) => resolveWith(rules, input) }
}

export const resolveProposalRoute = (input) => resolveWith(PROPOSAL_ROUTER_PRIMITIVES, input)
