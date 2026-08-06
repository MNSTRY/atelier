import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import {
  READINESS_PROTOCOL_IDS,
  READINESS_PROTOCOL_SLUGS,
  bundledReadinessProtocols,
  getBundledReadinessProtocol,
} from '../readiness-protocols/bundled-pack.mjs'

// Deterministic extension-pack loader. Packs are declared in the tracked
// project config under ext["mnstry.atelier"].extensionPacks and load through a
// fixed pipeline: entry shape, enablement, schema validation, identity,
// reserved-namespace rules, fixture and protocol path guards, the nine-point
// safety posture, collision rules against the bundled pack, and lock
// pin-and-verify. Every check fails closed: in the default (non-report) mode
// any error throws before a pack becomes visible to the runtime.

export const ATELIER_EXT_NAMESPACE = 'mnstry.atelier'
export const EXTENSION_PACK_SCHEMA = 'mnstry-atelier-extension-pack@v1'
export const RESERVED_NAMESPACE = 'mnstry'

// Mirrors LOCK_FILE in src/upgrade/upgrade.mjs. Declared locally because the
// upgrade module imports this loader (writeAtelierLock loads packs before
// pinning them); importing the constant back would create a module cycle.
const LOCK_FILE_NAME = 'atelier.lock.json'

const PACK_ID_PATTERN = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/
const PACK_VERSION_PATTERN = /^v\d+$/

// The nine-point safety posture every loaded protocol must carry, matching the
// properties the bundled-pack tests pin. The protocol contract keeps
// safetyPosture as a bare object on purpose (no schema tightening at v1), so
// points 1-7 are code-enforced here; points 8 and 9 are schema consts and this
// table backstops them in case the contract ever loosens.
export const PROTOCOL_POSTURE_POINTS = [
  { path: 'safetyPosture.runtimeMutation', expected: 'false', holds: (doc) => doc?.safetyPosture?.runtimeMutation === false },
  { path: 'safetyPosture.externalEgress', expected: 'false', holds: (doc) => doc?.safetyPosture?.externalEgress === false },
  { path: 'safetyPosture.defaultVisibility', expected: '"private"', holds: (doc) => doc?.safetyPosture?.defaultVisibility === 'private' },
  { path: 'safetyPosture.authority', expected: '"proposal-only"', holds: (doc) => doc?.safetyPosture?.authority === 'proposal-only' },
  { path: 'safetyPosture.reviewMode', expected: '"static-inspection"', holds: (doc) => doc?.safetyPosture?.reviewMode === 'static-inspection' },
  { path: 'safetyPosture.failClosedOnMissingEvidence', expected: 'true', holds: (doc) => doc?.safetyPosture?.failClosedOnMissingEvidence === true },
  { path: 'safetyPosture.refuses', expected: 'an array including "runtime writes"', holds: (doc) => Array.isArray(doc?.safetyPosture?.refuses) && doc.safetyPosture.refuses.includes('runtime writes') },
  { path: 'safety.runtimeMutation', expected: 'false', holds: (doc) => doc?.safety?.runtimeMutation === false },
  { path: 'outputs.runSchema', expected: '"atelier-readiness-run@v1"', holds: (doc) => doc?.outputs?.runSchema === 'atelier-readiness-run@v1' },
]

// Pack member arrays whose ids must live inside the pack's own namespace.
const MEMBER_ID_FIELDS = [
  ['terms', ['id']],
  ['protocols', ['id']],
  ['lenses', ['id']],
  ['readinessRules', ['id']],
  ['actionRules', ['id']],
  ['exportMappings', ['id', 'sourceTerm']],
]

const PACKAGE_ROOT_URL = new URL('../../', import.meta.url)

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asObject(value) {
  return isPlainObject(value) ? value : {}
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

let cachedValidators = null

// Compiled once and cached at module scope; compiled validators are immutable.
function compiledValidators() {
  if (!cachedValidators) {
    const ajv = new Ajv2020({ allErrors: true, strict: false })
    addFormats(ajv)
    cachedValidators = {
      pack: ajv.compile(readJsonFile(fileURLToPath(new URL('contracts/atelier-extension-pack.v1.schema.json', PACKAGE_ROOT_URL)))),
      protocol: ajv.compile(readJsonFile(fileURLToPath(new URL('contracts/atelier-readiness-protocol.v1.schema.json', PACKAGE_ROOT_URL)))),
    }
  }
  return cachedValidators
}

function ajvMessages(validate) {
  return (validate.errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message}`)
}

// Digest of the exact file bytes, not re-serialized JSON. The bundled entry in
// buildAtelierLock digests JSON.stringify of an in-memory object instead; file
// packs always digest raw bytes so on-disk edits are visible byte-for-byte.
export function computePackDigest(rawBytes) {
  return `sha256:${crypto.createHash('sha256').update(rawBytes).digest('hex')}`
}

function relativePathError(value, { requireJsonSuffix }) {
  if (typeof value !== 'string' || !value.trim()) return 'must be a non-empty relative path'
  if (path.isAbsolute(value)) return 'must not be an absolute path'
  if (value.split(/[\\/]/).some((segment) => segment === '..')) return 'must not contain .. segments'
  if (requireJsonSuffix && !value.endsWith('.json')) return 'must end with .json'
  return null
}

function isUnder(baseDir, resolved) {
  return resolved === baseDir || resolved.startsWith(`${baseDir}${path.sep}`)
}

function entryShapeErrors(entry, label) {
  if (!isPlainObject(entry)) return [`${label} must be an object`]
  const errors = []
  if (typeof entry.id !== 'string' || !PACK_ID_PATTERN.test(entry.id)) {
    errors.push(`${label}.id must be a namespaced pack id matching ${PACK_ID_PATTERN}`)
  }
  if (typeof entry.version !== 'string' || !PACK_VERSION_PATTERN.test(entry.version)) {
    errors.push(`${label}.version must match ${PACK_VERSION_PATTERN}`)
  }
  if (typeof entry.enabled !== 'boolean') {
    errors.push(`${label}.enabled must be a boolean`)
  }
  const pathError = relativePathError(entry.path, { requireJsonSuffix: true })
  if (pathError) errors.push(`${label}.path ${pathError}`)
  return errors
}

function declaredEntries(project) {
  const container = asObject(asObject(asObject(project?.config).ext)[ATELIER_EXT_NAMESPACE])
  const value = container.extensionPacks
  if (value == null) return { entries: [], error: null }
  if (!Array.isArray(value)) {
    return { entries: [], error: `ext["${ATELIER_EXT_NAMESPACE}"].extensionPacks must be an array` }
  }
  return { entries: value, error: null }
}

function readLockState(configDir) {
  const lockPath = path.join(configDir, LOCK_FILE_NAME)
  if (!fs.existsSync(lockPath)) return { exists: false, entries: [], error: null }
  try {
    const doc = readJsonFile(lockPath)
    return { exists: true, entries: Array.isArray(doc?.extensionPacks) ? doc.extensionPacks : [], error: null }
  } catch {
    // Do not echo parser output: it can quote file content. Name the file only.
    return { exists: true, entries: [], error: `${LOCK_FILE_NAME} is not readable JSON; review it and run atelier lock write` }
  }
}

function reservedNamespaceErrors(doc) {
  const errors = []
  const prefix = `${doc.id}:`
  for (const [field, keys] of MEMBER_ID_FIELDS) {
    const items = Array.isArray(doc[field]) ? doc[field] : []
    items.forEach((item, index) => {
      for (const key of keys) {
        const value = item?.[key]
        if (typeof value !== 'string') continue
        if (value.startsWith(`${RESERVED_NAMESPACE}.`)) {
          errors.push(`${field}[${index}].${key} ${value} redefines reserved mnstry runtime term`)
        } else if (!value.startsWith(prefix)) {
          errors.push(`${field}[${index}].${key} ${value} does not belong to pack namespace ${doc.id}`)
        }
      }
    })
  }
  return errors
}

function loadProtocolRecords({ doc, packDir, seenProtocolIds, errors }) {
  const validators = compiledValidators()
  const records = []
  const refs = Array.isArray(doc.protocols) ? doc.protocols : []
  refs.forEach((ref, index) => {
    const label = `protocols[${index}]`
    const guard = relativePathError(ref.path, { requireJsonSuffix: true })
    if (guard) {
      errors.push(`${label}.path ${guard}`)
      return
    }
    const resolved = path.resolve(packDir, ref.path)
    if (!isUnder(packDir, resolved)) {
      errors.push(`${label}.path escapes the pack directory`)
      return
    }
    if (!fs.existsSync(resolved)) {
      errors.push(`${label} protocol file not found: ${ref.path}`)
      return
    }
    let protocolDoc
    try {
      protocolDoc = readJsonFile(resolved)
    } catch {
      errors.push(`${label} protocol file is not valid JSON: ${ref.path}`)
      return
    }
    if (!validators.protocol(protocolDoc)) {
      errors.push(...ajvMessages(validators.protocol).map((message) => `${label} protocol file fails atelier-readiness-protocol@v1: ${message}`))
      return
    }
    if (protocolDoc.id !== ref.id) {
      errors.push(`${label} protocol file id ${protocolDoc.id} does not match the pack entry id ${ref.id}`)
      return
    }
    let posture = true
    for (const point of PROTOCOL_POSTURE_POINTS) {
      if (!point.holds(protocolDoc)) {
        posture = false
        errors.push(`${label} protocol ${ref.id} violates the required safety posture: ${point.path} must be ${point.expected}`)
      }
    }
    const slug = String(ref.id).split(':').at(-1)
    let collision = false
    if (READINESS_PROTOCOL_IDS.includes(ref.id)) {
      collision = true
      errors.push(`${label} protocol id ${ref.id} collides with a bundled protocol id`)
    }
    if (READINESS_PROTOCOL_SLUGS.includes(slug)) {
      collision = true
      errors.push(`${label} protocol slug ${slug} collides with a bundled protocol slug`)
    }
    if (seenProtocolIds.has(ref.id)) {
      collision = true
      errors.push(`${label} duplicate protocol id ${ref.id} across loaded packs`)
    }
    seenProtocolIds.add(ref.id)
    if (!posture || collision) return
    records.push({
      id: ref.id,
      packId: doc.id,
      slug,
      gate: ref.gate,
      title: ref.title ?? protocolDoc.title,
      declaredPath: ref.path,
      path: resolved,
      protocol: protocolDoc,
    })
  })
  return records
}

function loadOnePack({ entry, configDir, lock, seenProtocolIds, errors, warnings }) {
  const validators = compiledValidators()
  const packPath = path.resolve(configDir, entry.path)
  if (!isUnder(configDir, packPath)) {
    errors.push(`pack path escapes the project config directory: ${entry.path}`)
    return null
  }
  if (!fs.existsSync(packPath)) {
    errors.push(`pack file not found: ${entry.path}`)
    return null
  }
  const rawBytes = fs.readFileSync(packPath)
  const digest = computePackDigest(rawBytes)
  let doc
  try {
    doc = JSON.parse(rawBytes.toString('utf8'))
  } catch {
    errors.push(`pack file is not valid JSON: ${entry.path}`)
    return null
  }
  if (!validators.pack(doc)) {
    errors.push(...ajvMessages(validators.pack).map((message) => `pack file fails ${EXTENSION_PACK_SCHEMA}: ${message}`))
    return null
  }

  if (doc.id !== entry.id) errors.push(`pack id ${doc.id} does not match the declared id ${entry.id}`)
  if (doc.version !== entry.version) errors.push(`pack version ${doc.version} does not match the declared version ${entry.version}`)
  const idPrefix = String(doc.id).split('.')[0]
  if (doc.namespace !== idPrefix) errors.push(`pack namespace ${doc.namespace} must equal the pack id prefix ${idPrefix}`)
  if (doc.namespace === RESERVED_NAMESPACE) errors.push(`pack namespace ${RESERVED_NAMESPACE} is reserved for the bundled runtime vocabulary`)
  errors.push(...reservedNamespaceErrors(doc))
  if (errors.length) return null

  const packDir = path.dirname(packPath)
  const fixtures = Array.isArray(doc.fixtures) ? doc.fixtures : []
  fixtures.forEach((fixtureRef, index) => {
    const guard = relativePathError(fixtureRef, { requireJsonSuffix: false })
    if (guard) {
      errors.push(`fixtures[${index}] ${guard}`)
      return
    }
    const resolved = path.resolve(packDir, fixtureRef)
    if (!isUnder(packDir, resolved)) {
      errors.push(`fixtures[${index}] escapes the pack directory`)
      return
    }
    // Fixtures are declarative references; a missing file is not a load error.
    if (!fs.existsSync(resolved)) warnings.push(`fixtures[${index}] reference not found: ${fixtureRef}`)
  })

  const protocolRecords = loadProtocolRecords({ doc, packDir, seenProtocolIds, errors })

  const lockEntry = lock.entries.find((item) => item?.id === entry.id) ?? null
  let lockStatus = 'unlocked'
  if (lockEntry) {
    let pinned = true
    if (lockEntry.version !== entry.version) {
      pinned = false
      errors.push(`lock version mismatch for extension pack ${entry.id}: locked ${lockEntry.version}, declared ${entry.version}; review the pack and run atelier lock write`)
    }
    if (typeof lockEntry.digest === 'string' && lockEntry.digest !== digest) {
      pinned = false
      errors.push(`lock digest mismatch for extension pack ${entry.id}; review the pack and run atelier lock write`)
    }
    if (pinned) lockStatus = 'locked'
  } else if (lock.exists) {
    warnings.push(`extension pack ${entry.id} is not recorded in ${LOCK_FILE_NAME}; run atelier lock write after review`)
  }

  if (errors.length) return null
  return {
    id: doc.id,
    version: doc.version,
    namespace: doc.namespace,
    declaredPath: entry.path,
    path: packPath,
    digest,
    lock: lockStatus,
    doc,
    // Lenses are validated and stored as write-only metadata; no lens runtime.
    lenses: Array.isArray(doc.lenses) ? doc.lenses : [],
    protocols: protocolRecords,
  }
}

function formatLoadFailure(errors) {
  const lines = errors.map((item) => (item.packId ? `${item.packId}: ${item.message}` : item.message))
  return ['extension pack loading failed:', ...lines].join('\n')
}

// Loads every declared pack in declaration order. With report: false (the
// default, used by runtime and lock paths) any error throws — fail closed.
// With report: true (used by extension-pack validate) errors are collected per
// pack as { packId, message } entries and the caller decides.
export function loadExtensionPacks(project, { report = false } = {}) {
  const errors = []
  const warnings = []
  const skipped = []
  const packs = []
  const protocols = []
  const configDir = project?.configDir ?? process.cwd()

  const declared = declaredEntries(project)
  if (declared.error) errors.push({ packId: null, message: declared.error })

  const lock = readLockState(configDir)
  if (lock.error) errors.push({ packId: null, message: lock.error })

  const overlayPacks = asObject(asObject(asObject(asObject(project?.localOverlay).overlay).preferences).extensionPacks)
  const declaredIds = new Set()
  const seenProtocolIds = new Set()

  declared.entries.forEach((entry, index) => {
    const label = `ext["${ATELIER_EXT_NAMESPACE}"].extensionPacks[${index}]`
    const packId = typeof entry?.id === 'string' && entry.id ? entry.id : null
    const entryErrors = entryShapeErrors(entry, label)
    if (entryErrors.length) {
      for (const message of entryErrors) errors.push({ packId, message })
      return
    }
    if (declaredIds.has(entry.id)) {
      errors.push({ packId: entry.id, message: `duplicate extension pack declaration for ${entry.id}` })
      return
    }
    declaredIds.add(entry.id)

    // Enablement is disable-only and decided before the file is read: the
    // tracked config can disable, the machine-local overlay can disable, and
    // neither the overlay nor anything else can enable an undeclared pack.
    if (entry.enabled === false) {
      skipped.push({ packId: entry.id, reason: 'disabled-in-config' })
      return
    }
    if (asObject(overlayPacks[entry.id]).enabled === false) {
      skipped.push({ packId: entry.id, reason: 'disabled-by-overlay' })
      return
    }

    const packErrors = []
    const packWarnings = []
    const record = loadOnePack({ entry, configDir, lock, seenProtocolIds, errors: packErrors, warnings: packWarnings })
    for (const message of packErrors) errors.push({ packId: entry.id, message })
    for (const message of packWarnings) warnings.push({ packId: entry.id, message })
    if (!record) return
    packs.push(record)
    protocols.push(...record.protocols)
  })

  for (const id of Object.keys(overlayPacks)) {
    if (!declaredIds.has(id)) {
      warnings.push({ packId: id, message: `overlay preference references undeclared extension pack ${id}; the overlay can only disable declared packs` })
    }
  }

  const result = { packs, protocols, errors, warnings, skipped }
  if (!report && errors.length) throw new Error(formatLoadFailure(errors))
  return result
}

// Explicit registry object, no global state. Bundled resolution keeps its
// existing id | slug | namespaced affordance; pack protocols resolve by full
// namespaced id only, so a pack can never shadow or squat a bundled slug.
export function createProtocolRegistry({ packs = [] } = {}) {
  const packProtocols = new Map()
  for (const pack of packs) {
    for (const record of pack.protocols ?? []) packProtocols.set(record.id, record)
  }
  return {
    packs,
    protocolById(id) {
      const bundled = getBundledReadinessProtocol(id)
      if (bundled) return bundled
      const record = packProtocols.get(id)
      return record ? record.protocol : null
    },
    listProtocols() {
      return [
        ...bundledReadinessProtocols,
        ...[...packProtocols.values()].map((record) => record.protocol),
      ]
    },
  }
}
