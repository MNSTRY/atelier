import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { canonicalize } from '../attestation/jcs.mjs'
import { verifyDocument } from '../attestation/sign.mjs'

// Owner-signed delegation of the local boundary actor check (FD-BOUND-1).
// A delegation lets one declared operator pass the private-domain actor check
// for named repositories and operations. It never changes ownership, audiences,
// paths, content rules, promotion, push-content approval or publication.
//
// Trust: the policy and the delegations document beside it are operator-writable,
// so a delegation is authority only when its signature verifies against an owner
// key the host supplies from outside them. Revocation also comes from the host: a
// revocation kept in an operator-writable file could be deleted by the operator it
// restrains. `ext` is accepted and never read.

export const DELEGATION_SCHEMA = 'atelier-boundary-delegation@v1'
export const DELEGATIONS_DOCUMENT_SCHEMA = 'atelier-boundary-delegations@v1'
export const OWNER_KEYS_SCHEMA = 'atelier-boundary-owner-keys@v1'
export const DELEGATION_OPERATIONS = Object.freeze(['boundary-check', 'pre-commit'])
export const MAX_DELEGATION_SPAN_MS = 90 * 24 * 60 * 60 * 1000

const DELEGATION_KEYS = ['schema', 'id', 'owner', 'operator', 'repos', 'operations', 'notBefore', 'expiresAt', 'policyBinding', 'signature', 'ext']
const VERSION_RE = /^1\.[0-9]+\.[0-9]+$/
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const BINDING_RE = /^sha256:[0-9a-f]{64}$/
const OWNER_KEYS_MAX_BYTES = 64 * 1024

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonEmptyString = (value) => typeof value === 'string' && value.length > 0
const timeOf = (value) => (typeof value === 'string' && UTC_RE.test(value) ? Date.parse(value) : Number.NaN)

const withoutExt = (value) => {
  if (!isObject(value)) return value ?? null
  const { ext, ...rest } = value
  return rest
}

/**
 * The digest a delegation binds for one repository: its policy entry plus the
 * policy-wide protections that apply to it (mode, forbidden paths, content rules,
 * their exceptions and promotion). Any later edit to those voids the delegation
 * until the owner re-signs, so a delegated operator cannot loosen them. `ext` is
 * excluded because it is never read.
 */
export function repoPolicyBinding(policy, repoName) {
  const repos = isObject(policy?.repos) ? policy.repos : {}
  const bound = {
    repo: repoName,
    entry: withoutExt(Object.hasOwn(repos, repoName) ? repos[repoName] : null),
    mode: policy?.mode ?? null,
    forbiddenPaths: policy?.forbiddenPaths ?? null,
    contentRules: Array.isArray(policy?.contentRules) ? policy.contentRules.map(withoutExt) : policy?.contentRules ?? null,
    contentRuleExceptions: Array.isArray(policy?.contentRuleExceptions) ? policy.contentRuleExceptions.map(withoutExt) : policy?.contentRuleExceptions ?? null,
    promotion: withoutExt(policy?.promotion),
  }
  return `sha256:${crypto.createHash('sha256').update(canonicalize(bound), 'utf8').digest('hex')}`
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
  if (!nonEmptyString(item.owner) || !Object.hasOwn(actors, item.owner)) errors.push(`${at}.owner must be a declared actor`)
  if (!nonEmptyString(item.operator) || !Object.hasOwn(actors, item.operator)) errors.push(`${at}.operator must be a declared actor`)
  if (item.owner === item.operator) errors.push(`${at}.operator must differ from the owner`)
  const repoNames = Array.isArray(item.repos) ? item.repos : []
  if (!repoNames.length || new Set(repoNames).size !== repoNames.length) errors.push(`${at}.repos must be a non-empty list without duplicates`)
  for (const name of repoNames) {
    const repo = typeof name === 'string' && Object.hasOwn(repos, name) ? repos[name] : null
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
  const binding = item.policyBinding
  if (!isObject(binding) || Object.keys(binding).length !== repoNames.length ||
      !repoNames.every((name) => typeof name === 'string' && Object.hasOwn(binding, name) && typeof binding[name] === 'string' && BINDING_RE.test(binding[name]))) {
    errors.push(`${at}.policyBinding must hold one sha256 digest per listed repo`)
  }
  const signature = item.signature
  if (!isObject(signature) || signature.algorithm !== 'ed25519' || !nonEmptyString(signature.keyId) || !nonEmptyString(signature.value) ||
      Object.keys(signature).some((key) => !['algorithm', 'keyId', 'value', 'ext'].includes(key))) {
    errors.push(`${at}.signature must be an ed25519 signature; an unsigned delegation grants nothing`)
  }
  return errors
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
  if (!Array.isArray(doc.keys)) errors.push('owner keys must list keys')
  const seen = new Set()
  for (const [index, key] of (Array.isArray(doc.keys) ? doc.keys : []).entries()) {
    if (!isObject(key) || Object.keys(key).some((name) => !['actorId', 'keyId', 'algorithm', 'publicKeyJwk', 'ext'].includes(name)) ||
        (key.ext != null && !isObject(key.ext)) ||
        !nonEmptyString(key.actorId) || !nonEmptyString(key.keyId) || key.algorithm !== 'ed25519' ||
        !isObject(key.publicKeyJwk) || key.publicKeyJwk.kty !== 'OKP' || key.publicKeyJwk.crv !== 'Ed25519' || Object.hasOwn(key.publicKeyJwk, 'd')) {
      errors.push(`owner keys keys[${index}] must be an ed25519 public key with actorId and keyId`)
      continue
    }
    const identity = `${key.actorId}\u0000${key.keyId}`
    if (seen.has(identity)) errors.push(`owner keys keys[${index}] duplicates ${key.actorId}/${key.keyId}`)
    seen.add(identity)
  }
  if (doc.revokedDelegations != null && (!Array.isArray(doc.revokedDelegations) || doc.revokedDelegations.some((id) => typeof id !== 'string'))) {
    errors.push('owner keys revokedDelegations must be a list of delegation ids')
  }
  return errors
}

/** Normalize a host-supplied owner-keys document. The caller is the trusted host. */
export function ownerKeysFromDocument(doc) {
  const errors = ownerKeysErrors(doc)
  if (errors.length) return { ok: false, reason: 'delegation-owner-keys-invalid', errors }
  return { ok: true, keys: doc.keys, revoked: new Set(doc.revokedDelegations ?? []) }
}

function inside(child, parent) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function realOrResolved(value) {
  try {
    return fs.realpathSync(value)
  } catch {
    return path.resolve(value)
  }
}

/** The host location the CLI reads when no path is given. */
export function defaultOwnerKeysPath({ env = process.env, platform = process.platform } = {}) {
  if (platform === 'win32') return path.join(env.ProgramData || 'C:\\ProgramData', 'atelier', 'boundary-owner-keys.json')
  return '/etc/atelier/boundary-owner-keys.json'
}

/**
 * Load an owner-keys file for the CLI. On POSIX the file must be one the current
 * user can neither write nor replace: a regular file outside the project and its
 * repositories, not a symlink, not owned by the current user, not group- or
 * world-writable, not writable by this process, and under directories the user
 * cannot write (a sticky directory counts only when the user does not own it).
 * The current user's root account is refused, because it can replace anything.
 * On Windows only location, link, regular-file and writability checks apply.
 */
export function loadOwnerKeysFile(file, { project = null, access = fs.accessSync, uid = process.getuid?.(), platform = process.platform } = {}) {
  const untrusted = (detail) => ({ ok: false, reason: 'delegation-owner-keys-untrusted', errors: [detail] })
  const resolved = path.resolve(file)
  let stat
  try {
    stat = fs.lstatSync(resolved)
  } catch {
    return { ok: false, reason: 'delegation-owner-key-missing', errors: ['owner keys file not found'] }
  }
  if (stat.isSymbolicLink()) return untrusted('owner keys file must not be a symlink')
  if (!stat.isFile()) return untrusted('owner keys file must be a regular file')
  if (stat.size > OWNER_KEYS_MAX_BYTES) return untrusted('owner keys file is too large')
  const real = realOrResolved(resolved)
  const roots = [project?.configDir, project?.workspaceRoot, project?.repoOpsRoot, ...(project?.repos ?? []).map((repo) => repo.path)]
    .filter((root) => typeof root === 'string' && root)
    .map(realOrResolved)
  if (roots.some((root) => inside(real, root))) return untrusted('owner keys file must be outside the project and its repositories')
  const writable = (target) => {
    try {
      access(target, fs.constants.W_OK)
      return true
    } catch {
      return false
    }
  }
  if (platform !== 'win32') {
    if (uid === 0) return untrusted('owner keys cannot be trusted for the root account')
    if (typeof uid === 'number' && stat.uid === uid) return untrusted('owner keys file must not be owned by the current user')
    if ((stat.mode & 0o022) !== 0) return untrusted('owner keys file must not be group- or world-writable')
    for (let dir = path.dirname(real); ; dir = path.dirname(dir)) {
      const info = fs.statSync(dir)
      const sticky = (info.mode & 0o1000) !== 0
      if (writable(dir) && !(sticky && info.uid !== uid)) return untrusted('owner keys file must not be in a directory the current user can write')
      if (typeof uid === 'number' && info.uid === uid) return untrusted('owner keys file must not be in a directory the current user owns')
      if (path.dirname(dir) === dir) break
    }
  }
  if (writable(real)) return untrusted('owner keys file must not be writable by the current user')
  let doc
  try {
    doc = JSON.parse(fs.readFileSync(real, 'utf8'))
  } catch {
    return { ok: false, reason: 'delegation-owner-keys-invalid', errors: ['owner keys file is not valid JSON'] }
  }
  return ownerKeysFromDocument(doc)
}

/**
 * Owner keys for a CLI run: `--owner-keys FILE`, else `ATELIER_BOUNDARY_OWNER_KEYS`,
 * else the host default when it exists. Returns null when none is present. A path
 * from the environment is only a location; trust comes from the file itself.
 */
export function ownerKeysForCommand(project, args = {}, { env = process.env } = {}) {
  const explicit = typeof args['owner-keys'] === 'string' && args['owner-keys'].trim() ? args['owner-keys'].trim() : null
  const fromEnv = typeof env.ATELIER_BOUNDARY_OWNER_KEYS === 'string' && env.ATELIER_BOUNDARY_OWNER_KEYS.trim() ? env.ATELIER_BOUNDARY_OWNER_KEYS.trim() : null
  const file = explicit || fromEnv
  if (file) return loadOwnerKeysFile(file, { project })
  const fallback = defaultOwnerKeysPath({ env })
  return fs.existsSync(fallback) ? loadOwnerKeysFile(fallback, { project }) : null
}

/** The delegations document beside a boundary policy file. */
export function delegationsPathFor(policyPath) {
  return path.join(path.dirname(policyPath), 'boundary-delegations.v1.json')
}

/** Read the delegations document beside the policy, if one exists. */
export function loadDelegationsFile(file) {
  if (!fs.existsSync(file)) return { present: false, document: null, errors: [] }
  try {
    return { present: true, document: JSON.parse(fs.readFileSync(file, 'utf8')), errors: [] }
  } catch {
    return { present: true, document: null, errors: ['delegations document is not valid JSON'] }
  }
}

/**
 * Decide whether a delegation lets `actorId` pass the actor check for one
 * repository and operation. Returns `{ applies: true, delegation }` or
 * `{ applies: false, reason }`; it never widens anything else.
 */
export function resolveDelegation({ policy, delegations = [], repoName, repo, actorId, operation, ownerKeys = null, now = Date.now() }) {
  const deny = (reason) => ({ applies: false, reason })
  const all = Array.isArray(delegations) ? delegations.filter(isObject) : []
  const forOperator = all.filter((item) => item.operator === actorId)
  if (!forOperator.length) return deny('delegation-missing')
  const forRepo = forOperator.filter((item) => Array.isArray(item.repos) && item.repos.includes(repoName))
  const inScope = forRepo.filter((item) => Array.isArray(item.operations) && item.operations.includes(operation))
  if (!inScope.length) return deny('delegation-scope')
  if (inScope.length > 1) return deny('delegation-ambiguous')
  const [delegation] = inScope
  if (delegationErrors(delegation, 'delegation', { actors: isObject(policy?.actors) ? policy.actors : {}, repos: isObject(policy?.repos) ? policy.repos : {} }).length ||
      delegation.owner !== repo?.ownerActor) return deny('delegation-malformed')
  if (!ownerKeys) return deny('delegation-owner-key-missing')
  if (!ownerKeys.ok) return deny(ownerKeys.reason)
  const key = ownerKeys.keys.find((item) => item.actorId === delegation.owner && item.keyId === delegation.signature.keyId)
  if (!key) return deny('delegation-owner-key-missing')
  if (!verifyDocument(delegation, { publicKey: key }).valid) return deny('delegation-signature-invalid')
  if (ownerKeys.revoked.has(delegation.id)) return deny('delegation-revoked')
  if (now < Date.parse(delegation.notBefore)) return deny('delegation-not-yet-valid')
  if (now >= Date.parse(delegation.expiresAt)) return deny('delegation-expired')
  if (delegation.policyBinding[repoName] !== repoPolicyBinding(policy, repoName)) return deny('delegation-policy-binding-changed')
  return { applies: true, delegation }
}

/** Errors for one delegation checked against a policy (used before signing). */
export function validateDelegation(item, policy) {
  return delegationErrors(item, 'delegation', { actors: isObject(policy?.actors) ? policy.actors : {}, repos: isObject(policy?.repos) ? policy.repos : {} })
}

/** An unsigned delegation document for the owner to read and sign. */
export function draftDelegation({ policy, id, owner, operator, repos, operations, notBefore, expiresAt }) {
  const doc = {
    schema: DELEGATION_SCHEMA,
    id,
    owner,
    operator,
    repos,
    operations,
    notBefore,
    expiresAt,
    policyBinding: Object.fromEntries((Array.isArray(repos) ? repos : []).map((name) => [name, repoPolicyBinding(policy, name)])),
    signature: null,
  }
  const errors = delegationErrors({ ...doc, signature: { algorithm: 'ed25519', keyId: 'unsigned', value: 'unsigned' } }, 'delegation', { actors: isObject(policy?.actors) ? policy.actors : {}, repos: isObject(policy?.repos) ? policy.repos : {} })
  return { ok: errors.length === 0, delegation: doc, errors }
}
