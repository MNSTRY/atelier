import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { canonicalize } from '../attestation/jcs.mjs'
import { verifyDocument } from '../attestation/sign.mjs'
import { sanitizedGitEnvironment } from '../runtime/git-adapter.mjs'

// Owner-signed delegation of the local boundary actor check (FD-BOUND-1).
// A delegation lets one declared operator pass the private-domain actor check
// for named repositories and operations. It never changes ownership, audiences,
// paths, content rules, promotion, push-content approval or publication.
//
// Guarantee: attribution integrity for a cooperating operator. The actor check
// itself stays attribution-grade: an operator can still declare another actor
// (--actor, MNSTRY_ATELIER_ACTOR), edit the policy or project configuration, or
// control the process that runs the check. A delegation adds that an owner's
// signed, current, host-anchored consent is recorded when someone else commits.
//
// Trust: the policy and the delegations document are operator-writable, so a
// delegation is authority only when its signature verifies against an owner key
// in the host file at a fixed path, owned by root in root-owned directories. That
// file is also the only source of revocation. Each delegation binds the whole
// policy (ext excluded), the managed repository set and each repository's root
// commit, so it cannot be loosened in place or replayed into an independently
// created repository. Forks sharing the root commit are not distinguished.
// `ext` is accepted and never read.

export const DELEGATION_SCHEMA = 'atelier-boundary-delegation@v1'
export const DELEGATIONS_DOCUMENT_SCHEMA = 'atelier-boundary-delegations@v1'
export const OWNER_KEYS_SCHEMA = 'atelier-boundary-owner-keys@v1'
export const DELEGATION_OPERATIONS = Object.freeze(['boundary-check', 'pre-commit'])
export const MAX_DELEGATION_SPAN_MS = 90 * 24 * 60 * 60 * 1000
export const HOST_OWNER_KEYS_PATH = '/etc/atelier/boundary-owner-keys.json'

const DELEGATION_KEYS = ['schema', 'id', 'owner', 'operator', 'repos', 'operations', 'notBefore', 'expiresAt', 'policyDigest', 'repoRoots', 'signature', 'ext']
const VERSION_RE = /^1\.[0-9]+\.[0-9]+$/
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const REPO_RE = /^[a-z0-9][a-z0-9._-]*$/
// Owner and operator ids are shown to the signing owner, so they are restricted
// to printable identifiers: no control characters, spaces or lookalikes.
export const DELEGATION_ACTOR_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/
const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const JWK_X_RE = /^[A-Za-z0-9_-]{43}$/
const OWNER_KEYS_MAX_BYTES = 64 * 1024
const MAX_DELEGATIONS = 64
const MAX_REPOS = 64
const MAX_KEYS = 64
const MAX_REVOKED = 1024

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const boundedString = (value, max = 128) => typeof value === 'string' && value.length > 0 && value.length <= max
// A time must be a real calendar instant that round-trips: 2026-02-31 is refused,
// never rolled over to March.
const timeOf = (value) => {
  if (typeof value !== 'string' || !UTC_RE.test(value)) return Number.NaN
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) return Number.NaN
  const iso = new Date(ms).toISOString()
  return iso === value || iso.replace(/\.000Z$/, 'Z') === value || iso.replace(/0*Z$/, 'Z').replace(/\.Z$/, 'Z') === value ? ms : Number.NaN
}

// `ext` is never read, so it is removed before hashing, but only at the
// extension positions the schema declares. A repository or actor that happens
// to be named `ext` is ordinary policy and stays bound.
const dropExt = (value) => {
  if (!isObject(value)) return value
  const { ext, ...rest } = value
  return rest
}
function withoutExt(policy) {
  if (!isObject(policy)) return policy ?? null
  const out = dropExt(policy)
  const each = (map) => (isObject(map) ? Object.fromEntries(Object.entries(map).map(([key, item]) => [key, dropExt(item)])) : map)
  if (Object.hasOwn(out, 'repos')) out.repos = each(out.repos)
  if (Object.hasOwn(out, 'actors')) out.actors = each(out.actors)
  if (Object.hasOwn(out, 'promotion')) out.promotion = dropExt(out.promotion)
  if (Array.isArray(out.contentRules)) out.contentRules = out.contentRules.map(dropExt)
  if (Array.isArray(out.contentRuleExceptions)) out.contentRuleExceptions = out.contentRuleExceptions.map(dropExt)
  return out
}

const managedRepoNames = (project) => (project?.repos ?? []).filter((repo) => !repo.external).map((repo) => repo.name).sort()

/**
 * The digest a delegation binds: the whole boundary policy (ext excluded) and the
 * project's managed repository names. Any later edit to them voids every
 * delegation until the owner signs again. Other project configuration (repo
 * access, graph settings, repository paths) is not bound.
 */
export function policyDigest(policy, project) {
  const bound = { policy: withoutExt(policy), managedRepos: managedRepoNames(project) }
  return `sha256:${crypto.createHash('sha256').update(canonicalize(bound), 'utf8').digest('hex')}`
}

/**
 * The repository's identity: the lowest-sorting root commit of HEAD, ignoring
 * replace refs, or null when it has none. Forks and histories built on the same
 * root share it; independently created repositories do not.
 */
export function repoRootCommit(repoPath, { gitExecutable = 'git' } = {}) {
  if (!repoPath) return null
  const result = spawnSync(gitExecutable, ['--no-replace-objects', '-C', repoPath, 'rev-list', '--max-parents=0', 'HEAD', '--'], { encoding: 'utf8', env: sanitizedGitEnvironment() })
  if (result.status !== 0) return null
  const roots = result.stdout.split('\n').map((line) => line.trim()).filter((line) => COMMIT_RE.test(line)).sort()
  return roots[0] ?? null
}

function repoPathFor(project, name) {
  return (project?.repos ?? []).find((repo) => repo.name === name && !repo.external)?.path ?? null
}

function delegationErrors(item, at, { actors, repos }) {
  if (!isObject(item)) return [`${at} must be an object`]
  const errors = []
  for (const key of Object.keys(item)) {
    if (!DELEGATION_KEYS.includes(key)) errors.push(`${at} must not include additional property ${key}`)
  }
  if (item.ext != null && !isObject(item.ext)) errors.push(`${at}.ext must be an object`)
  if (item.schema !== DELEGATION_SCHEMA) errors.push(`${at}.schema must be ${DELEGATION_SCHEMA}`)
  if (typeof item.id !== 'string' || !ID_RE.test(item.id)) errors.push(`${at}.id is invalid`)
  if (typeof item.owner !== 'string' || !DELEGATION_ACTOR_RE.test(item.owner) || !Object.hasOwn(actors, item.owner)) errors.push(`${at}.owner must be a declared actor with a plain identifier`)
  if (typeof item.operator !== 'string' || !DELEGATION_ACTOR_RE.test(item.operator) || !Object.hasOwn(actors, item.operator)) errors.push(`${at}.operator must be a declared actor with a plain identifier`)
  if (item.owner === item.operator) errors.push(`${at}.operator must differ from the owner`)
  const repoNames = Array.isArray(item.repos) ? item.repos : []
  if (!repoNames.length || repoNames.length > MAX_REPOS || new Set(repoNames).size !== repoNames.length) {
    errors.push(`${at}.repos must be a non-empty list of at most ${MAX_REPOS} without duplicates`)
  }
  for (const name of repoNames) {
    const repo = typeof name === 'string' && REPO_RE.test(name) && Object.hasOwn(repos, name) ? repos[name] : null
    if (!repo || repo.kind !== 'private_domain') errors.push(`${at}.repos ${String(name)} must be a declared private_domain repo`)
    else if (repo.ownerActor !== item.owner) errors.push(`${at}.repos ${name} is not owned by ${String(item.owner)}`)
  }
  const operations = Array.isArray(item.operations) ? item.operations : []
  if (!operations.length || new Set(operations).size !== operations.length || operations.some((op) => !DELEGATION_OPERATIONS.includes(op))) {
    errors.push(`${at}.operations must be a non-empty list of ${DELEGATION_OPERATIONS.join(', ')}`)
  }
  const notBefore = timeOf(item.notBefore)
  const expiresAt = timeOf(item.expiresAt)
  if (Number.isNaN(notBefore)) errors.push(`${at}.notBefore must be an RFC 3339 UTC time`)
  if (Number.isNaN(expiresAt)) errors.push(`${at}.expiresAt must be an RFC 3339 UTC time`)
  if (!Number.isNaN(notBefore) && !Number.isNaN(expiresAt) && !(expiresAt > notBefore && expiresAt - notBefore <= MAX_DELEGATION_SPAN_MS)) {
    errors.push(`${at}.expiresAt must be after notBefore and at most 90 days later`)
  }
  if (typeof item.policyDigest !== 'string' || !DIGEST_RE.test(item.policyDigest)) errors.push(`${at}.policyDigest must be a sha256 digest`)
  const roots = item.repoRoots
  if (!isObject(roots) || Object.keys(roots).length !== repoNames.length ||
      !repoNames.every((name) => typeof name === 'string' && Object.hasOwn(roots, name) && typeof roots[name] === 'string' && COMMIT_RE.test(roots[name]))) {
    errors.push(`${at}.repoRoots must hold one root commit per listed repo`)
  }
  const signature = item.signature
  if (!isObject(signature) || signature.algorithm !== 'ed25519' || !boundedString(signature.keyId) || !boundedString(signature.value, 512) ||
      Object.keys(signature).some((key) => !['algorithm', 'keyId', 'value', 'ext'].includes(key))) {
    errors.push(`${at}.signature must be an ed25519 signature; an unsigned delegation grants nothing`)
  }
  return errors
}

/** Errors for one delegation checked against a policy (used before signing). */
export function validateDelegation(item, policy) {
  return delegationErrors(item, 'delegation', { actors: isObject(policy?.actors) ? policy.actors : {}, repos: isObject(policy?.repos) ? policy.repos : {} })
}

/**
 * Errors for a delegations document, checked against the boundary policy it
 * delegates under. Delegations live in their own document beside the policy,
 * so the policy contract is not widened.
 */
export function validateDelegationsDocument(doc, policy) {
  if (!isObject(doc)) return ['delegations document must be a JSON object']
  const errors = []
  for (const key of Object.keys(doc)) {
    if (!['schema', 'contractVersion', 'delegations', 'ext'].includes(key)) errors.push(`delegations document must not include additional property ${key}`)
  }
  if (doc.schema !== DELEGATIONS_DOCUMENT_SCHEMA) errors.push(`delegations document schema must be ${DELEGATIONS_DOCUMENT_SCHEMA}`)
  if (doc.contractVersion != null && !(typeof doc.contractVersion === 'string' && VERSION_RE.test(doc.contractVersion))) errors.push('delegations document contractVersion must be a 1.x.y version')
  if (doc.ext != null && !isObject(doc.ext)) errors.push('delegations document ext must be an object')
  if (!Array.isArray(doc.delegations)) return [...errors, 'delegations document must list delegations']
  if (doc.delegations.length > MAX_DELEGATIONS) errors.push(`delegations document lists more than ${MAX_DELEGATIONS} delegations`)
  const context = { actors: isObject(policy?.actors) ? policy.actors : {}, repos: isObject(policy?.repos) ? policy.repos : {} }
  const seen = new Set()
  for (const [index, item] of doc.delegations.entries()) {
    const at = `delegations[${index}]`
    errors.push(...delegationErrors(item, at, context))
    if (isObject(item) && typeof item.id === 'string') {
      if (seen.has(item.id)) errors.push(`${at}.id ${item.id} is duplicated`)
      seen.add(item.id)
    }
  }
  return errors
}

function ownerKeysErrors(doc) {
  if (!isObject(doc)) return ['owner keys must be a JSON object']
  const errors = []
  for (const key of Object.keys(doc)) {
    if (!['schema', 'contractVersion', 'keys', 'revokedDelegations', 'ext'].includes(key)) errors.push(`owner keys must not include additional property ${key}`)
  }
  if (doc.schema !== OWNER_KEYS_SCHEMA) errors.push(`owner keys schema must be ${OWNER_KEYS_SCHEMA}`)
  if (doc.contractVersion != null && !(typeof doc.contractVersion === 'string' && VERSION_RE.test(doc.contractVersion))) errors.push('owner keys contractVersion must be a 1.x.y version')
  if (doc.ext != null && !isObject(doc.ext)) errors.push('owner keys ext must be an object')
  if (!Array.isArray(doc.keys) || doc.keys.length > MAX_KEYS) errors.push(`owner keys must list at most ${MAX_KEYS} keys`)
  const seen = new Set()
  for (const [index, key] of (Array.isArray(doc.keys) ? doc.keys : []).entries()) {
    if (!isObject(key) || Object.keys(key).some((name) => !['actorId', 'keyId', 'algorithm', 'publicKeyJwk', 'ext'].includes(name)) ||
        (key.ext != null && !isObject(key.ext)) || !boundedString(key.actorId) || !boundedString(key.keyId) || key.algorithm !== 'ed25519' ||
        !isObject(key.publicKeyJwk) || key.publicKeyJwk.kty !== 'OKP' || key.publicKeyJwk.crv !== 'Ed25519' ||
        typeof key.publicKeyJwk.x !== 'string' || !JWK_X_RE.test(key.publicKeyJwk.x) || Object.hasOwn(key.publicKeyJwk, 'd')) {
      errors.push(`owner keys keys[${index}] must be an ed25519 public key with actorId and keyId`)
      continue
    }
    const identity = `${key.actorId}\u0000${key.keyId}`
    if (seen.has(identity)) errors.push(`owner keys keys[${index}] duplicates ${key.actorId}/${key.keyId}`)
    seen.add(identity)
  }
  const revoked = doc.revokedDelegations
  if (revoked != null && (!Array.isArray(revoked) || revoked.length > MAX_REVOKED || new Set(revoked).size !== revoked.length ||
      revoked.some((id) => typeof id !== 'string' || !ID_RE.test(id)))) {
    errors.push('owner keys revokedDelegations must be a list of distinct delegation ids')
  }
  return errors
}

/** Normalize a host-supplied owner-keys document. The caller is the trusted host. */
export function ownerKeysFromDocument(doc) {
  const errors = ownerKeysErrors(doc)
  if (errors.length) return { ok: false, reason: 'delegation-owner-keys-invalid', errors }
  return { ok: true, keys: doc.keys, revoked: new Set(doc.revokedDelegations ?? []) }
}

/** The normalized form of a host `ownerKeys` value, re-validated. */
function normalizedOwnerKeys(ownerKeys) {
  if (!isObject(ownerKeys)) return null
  if (ownerKeys.ok === false) return ownerKeys
  if (ownerKeys.ok === true && Array.isArray(ownerKeys.keys) && ownerKeys.revoked instanceof Set) {
    return ownerKeysFromDocument({ schema: OWNER_KEYS_SCHEMA, keys: ownerKeys.keys, revokedDelegations: [...ownerKeys.revoked] })
  }
  return ownerKeysFromDocument(ownerKeys)
}

/**
 * Load the host owner-keys file. It is trusted only when it is a regular file
 * owned by the trusted account (root), not group- or world-writable, opened
 * without following links, and every directory above it is owned by that
 * account (or root) and not group- or world-writable. The checks run on the open
 * descriptor, which is also what is read. The current account must not be the
 * trusted one. Windows is refused until an owner and DACL check exists.
 */
export function loadOwnerKeysFile(file = HOST_OWNER_KEYS_PATH, { platform = process.platform, trustedUid = 0, currentUid = process.getuid?.() } = {}) {
  const untrusted = (detail) => ({ ok: false, reason: 'delegation-owner-keys-untrusted', errors: [detail] })
  if (platform === 'win32') return untrusted('owner keys are not supported on Windows')
  if (typeof currentUid !== 'number') return untrusted('the current account cannot be determined')
  if (currentUid === 0) return untrusted('owner keys cannot be trusted for the root account')
  if (currentUid === trustedUid) return untrusted('the current account must not own the owner keys')
  const resolved = path.resolve(file)
  let fd
  try {
    fd = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0))
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, reason: 'delegation-owner-key-missing', errors: ['owner keys file not found'] }
    if (error?.code === 'ELOOP') return untrusted('owner keys file must not be a symlink')
    return untrusted('owner keys file cannot be opened')
  }
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) return untrusted('owner keys file must be a regular file')
    if (stat.size > OWNER_KEYS_MAX_BYTES) return untrusted('owner keys file is too large')
    if (stat.uid !== trustedUid) return untrusted('owner keys file must be owned by the trusted account')
    if ((stat.mode & 0o022) !== 0) return untrusted('owner keys file must not be group- or world-writable')
    let real
    try {
      real = fs.realpathSync(resolved)
      const named = fs.lstatSync(real)
      if (named.dev !== stat.dev || named.ino !== stat.ino) return untrusted('owner keys file changed while it was checked')
    } catch {
      return untrusted('owner keys file changed while it was checked')
    }
    for (let dir = path.dirname(real); ; dir = path.dirname(dir)) {
      let info
      try {
        info = fs.statSync(dir)
      } catch {
        return untrusted('owner keys file directories changed while they were checked')
      }
      if ((info.uid !== trustedUid && info.uid !== 0) || (info.mode & 0o022) !== 0) {
        return untrusted('owner keys file must be in directories owned by the trusted account and not group- or world-writable')
      }
      if (path.dirname(dir) === dir) break
    }
    let doc
    try {
      doc = JSON.parse(fs.readFileSync(fd, 'utf8'))
    } catch {
      return { ok: false, reason: 'delegation-owner-keys-invalid', errors: ['owner keys file is not valid JSON'] }
    }
    return ownerKeysFromDocument(doc)
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Owner keys for a CLI check: only the host file at its fixed path. The command
 * line and environment cannot choose another file, so the host's keys and
 * revocations always apply. Returns null when the host has none.
 */
export function ownerKeysForCommand() {
  return fs.existsSync(HOST_OWNER_KEYS_PATH) || isSymlink(HOST_OWNER_KEYS_PATH) ? loadOwnerKeysFile(HOST_OWNER_KEYS_PATH) : null
}

function isSymlink(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink()
  } catch {
    return false
  }
}

/** The delegations document beside a boundary policy file. */
export function delegationsPathFor(policyPath) {
  return path.join(path.dirname(policyPath), 'boundary-delegations.v1.json')
}

/** Read the delegations document beside the policy, if one exists. */
export function loadDelegationsFile(file) {
  if (!fs.existsSync(file)) return { present: false, document: null, errors: [] }
  let document
  try {
    document = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return { present: true, document: null, errors: ['delegations document is not valid JSON'] }
  }
  if (!isObject(document)) return { present: true, document: null, errors: ['delegations document must be a JSON object'] }
  return { present: true, document, errors: [] }
}

/**
 * Decide whether a delegation lets `actorId` pass the actor check for one
 * repository and operation. Returns `{ applies: true, delegation }` or
 * `{ applies: false, reason }`; it never widens anything else.
 */
export function resolveDelegation({ policy, project, delegations = [], repoName, repo, actorId, operation, ownerKeys = null, now = Date.now(), rootCommitOf = repoRootCommit }) {
  const deny = (reason) => ({ applies: false, reason })
  const all = Array.isArray(delegations) ? delegations.filter(isObject) : []
  const forOperator = all.filter((item) => item.operator === actorId)
  if (!forOperator.length) return deny('delegation-missing')
  const forRepo = forOperator.filter((item) => Array.isArray(item.repos) && item.repos.includes(repoName))
  const inScope = forRepo.filter((item) => Array.isArray(item.operations) && item.operations.includes(operation))
  if (!inScope.length) return deny('delegation-scope')
  if (inScope.length > 1) return deny('delegation-ambiguous')
  const [delegation] = inScope
  if (validateDelegation(delegation, policy).length || delegation.owner !== repo?.ownerActor) return deny('delegation-malformed')
  const keys = normalizedOwnerKeys(ownerKeys)
  if (!keys) return deny('delegation-owner-key-missing')
  if (!keys.ok) return deny(keys.reason)
  // The key must be registered for the delegation's owner, not merely present.
  const key = keys.keys.find((item) => item.actorId === delegation.owner && item.keyId === delegation.signature.keyId)
  if (!key) return deny('delegation-owner-key-missing')
  if (!verifyDocument(delegation, { publicKey: key }).valid) return deny('delegation-signature-invalid')
  if (keys.revoked.has(delegation.id)) return deny('delegation-revoked')
  if (now < Date.parse(delegation.notBefore)) return deny('delegation-not-yet-valid')
  if (now >= Date.parse(delegation.expiresAt)) return deny('delegation-expired')
  if (delegation.policyDigest !== policyDigest(policy, project)) return deny('delegation-policy-changed')
  for (const name of delegation.repos) {
    if (rootCommitOf(repoPathFor(project, name)) !== delegation.repoRoots[name]) return deny('delegation-repository-changed')
  }
  return { applies: true, delegation }
}

/** The bound values a delegation must carry for this policy and project. */
export function delegationBindings({ policy, project, repos, rootCommitOf = repoRootCommit }) {
  return {
    policyDigest: policyDigest(policy, project),
    repoRoots: Object.fromEntries((Array.isArray(repos) ? repos : []).map((name) => [name, rootCommitOf(repoPathFor(project, name))])),
  }
}

/** An unsigned delegation document for the owner to read and sign. */
export function draftDelegation({ policy, project, id, owner, operator, repos, operations, notBefore, expiresAt, rootCommitOf = repoRootCommit }) {
  const doc = {
    schema: DELEGATION_SCHEMA,
    id,
    owner,
    operator,
    repos,
    operations,
    notBefore,
    expiresAt,
    ...delegationBindings({ policy, project, repos, rootCommitOf }),
    signature: null,
  }
  const errors = validateDelegation({ ...doc, signature: { algorithm: 'ed25519', keyId: 'unsigned', value: 'unsigned' } }, policy)
  return { ok: errors.length === 0, delegation: doc, errors }
}
