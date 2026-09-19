import fs from 'node:fs'
import path from 'node:path'
import { atomicReplacePrivateText, ensureContainedPrivateDirectory, readRegularTextNoFollow } from '../../project/private-state.mjs'
import { PATH_REGISTRY_SCHEMA } from '../../projection/obsidian/materialize/path-registry.mjs'
import { canonicalJson, closedObject, compareText } from './documents.mjs'
import { refuse } from './errors.mjs'
import { APPLY_RESULT_STATUSES } from './extension-points.mjs'

// Private, versioned documents of the maintenance engine, under
//
//   <data>/obsidian/<workspace-id>/state/maintenance/
//     freshness.json      per-scope freshness, read by the opening commands
//     pending-edits.json  edits made in a vault, preserved and waiting
//     late-writers.json   writes that arrived in a displaced file after publication
//     path-registry.json  the workspace path registry prepareView grows
//
// None of the frozen contracts describes these, so each is a closed document
// of this module: an unknown key, state or schema refuses on read and on
// write. Files are owner-only and replaced atomically. A document is written
// only when its bytes change.

export const FRESHNESS_SCHEMA = 'atelier-obsidian-freshness/v1'
export const PENDING_EDITS_SCHEMA = 'atelier-obsidian-pending-edits/v1'
export const LATE_WRITERS_SCHEMA = 'atelier-obsidian-late-writers/v1'

export const FRESHNESS_STATES = Object.freeze(['current', 'updating', 'held-for-your-edit', 'stale', 'publisher-conflict', 'disabled'])
export const CHANGE_CLASSES = Object.freeze(['source-body', 'sidecar', 'asset', 'config', 'ext-settings', 'scope', 'eligibility', 'vault-note'])

// queued            waiting for a person (manual) or for the next dispatch (automatic)
// apply-unavailable dispatched, and no apply operation exists yet
// apply-failed      dispatched, and the operation refused, conflicted or failed
// retry-exhausted   the retry budget is spent; still pending, no longer dispatched
// applied           the operation reported the edit applied to source
// withdrawn         the note is back at the bytes it was generated with
// superseded        the note was edited again; a newer record carries the newer bytes
export const OPEN_EDIT_STATES = Object.freeze(['queued', 'apply-unavailable', 'apply-failed', 'retry-exhausted'])
export const CLOSED_EDIT_STATES = Object.freeze(['applied', 'withdrawn', 'superseded'])
export const EDIT_STATES = Object.freeze([...OPEN_EDIT_STATES, ...CLOSED_EDIT_STATES])

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const DIGEST = /^sha256:[0-9a-f]{64}$/
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const EDIT_ID = /^edit-[0-9a-f]{32}$/

const isIdentifier = (value) => typeof value === 'string' && IDENTIFIER.test(value)
const isDigest = (value) => typeof value === 'string' && DIGEST.test(value)
const isTimestamp = (value) => typeof value === 'string' && TIMESTAMP.test(value)
const isRelative = (value) => typeof value === 'string' && value !== '' && !value.startsWith('/') && !value.includes('\\') && !value.split('/').some((part) => part === '' || part === '.' || part === '..')
const isCount = (value) => Number.isInteger(value) && value >= 0

function check(condition, code, message) {
  if (!condition) refuse(code, message)
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

export function validateFreshness(document, workspaceId) {
  const code = 'invalid-freshness-state'
  closedObject(document, { required: ['schema', 'workspaceId', 'enablement', 'maintenanceMode', 'lastTickAt', 'lastFullReconciliationAt', 'scopes'] }, code, 'the freshness document')
  check(document.schema === FRESHNESS_SCHEMA, code, 'the freshness document names an unknown schema')
  check(document.workspaceId === workspaceId, code, 'the freshness document belongs to another workspace')
  check(['enabled', 'disabled', 'refused'].includes(document.enablement), code, 'enablement is unknown')
  check(['manual', 'automatic'].includes(document.maintenanceMode), code, 'maintenanceMode is unknown')
  check(isTimestamp(document.lastTickAt) && (document.lastFullReconciliationAt === null || isTimestamp(document.lastFullReconciliationAt)), code, 'a tick time is not a UTC timestamp')
  check(Array.isArray(document.scopes), code, 'scopes must be a list')
  const seen = new Set()
  for (const scope of document.scopes) {
    closedObject(scope, { required: ['scopeId', 'state', 'reason', 'generationId', 'preparedGenerationId', 'verified', 'heldNotes', 'changeClasses', 'retainedEdits', 'checkedAt'] }, code, 'a scope freshness entry')
    check(isIdentifier(scope.scopeId) && !seen.has(scope.scopeId), code, 'a scope identity is malformed or repeated')
    seen.add(scope.scopeId)
    check(FRESHNESS_STATES.includes(scope.state), code, 'a scope carries an unknown freshness state')
    check(typeof scope.reason === 'string' && scope.reason !== '' && scope.reason.length <= 160, code, 'a scope reason must be a short code')
    check((scope.generationId === null || isIdentifier(scope.generationId)) && (scope.preparedGenerationId === null || isIdentifier(scope.preparedGenerationId)), code, 'a generation identity is malformed')
    check(typeof scope.verified === 'boolean', code, 'verified must be a boolean')
    check(Array.isArray(scope.heldNotes) && scope.heldNotes.every(isRelative), code, 'heldNotes must list vault-relative paths')
    // `current` is a claim about exact generations and verified bytes; a document that claims it otherwise refuses.
    check(scope.state !== 'current' || (scope.verified && scope.generationId !== null && scope.generationId === scope.preparedGenerationId && scope.heldNotes.length === 0), code, 'a scope claims current without an exact verified generation')
    check(Array.isArray(scope.changeClasses) && scope.changeClasses.every((item) => CHANGE_CLASSES.includes(item)), code, 'changeClasses names an unknown class')
    check(isCount(scope.retainedEdits) && isTimestamp(scope.checkedAt), code, 'a scope entry is malformed')
  }
  return document
}

export function validatePendingEdits(document, workspaceId) {
  const code = 'invalid-pending-edits'
  closedObject(document, { required: ['schema', 'workspaceId', 'edits'] }, code, 'the pending edit document')
  check(document.schema === PENDING_EDITS_SCHEMA, code, 'the pending edit document names an unknown schema')
  check(document.workspaceId === workspaceId, code, 'the pending edit document belongs to another workspace')
  check(Array.isArray(document.edits), code, 'edits must be a list')
  const seen = new Set()
  for (const edit of document.edits) {
    closedObject(edit, { required: ['editId', 'identity', 'scopeId', 'generationId', 'path', 'baseNoteDigest', 'observedDigest', 'objectRef', 'observedAt', 'state', 'attempts', 'retryBudget', 'lastAttemptAt', 'lastResult', 'closedAt'] }, code, 'a pending edit')
    check(typeof edit.editId === 'string' && EDIT_ID.test(edit.editId) && !seen.has(edit.editId), code, 'an edit identity is malformed or repeated')
    seen.add(edit.editId)
    closedObject(edit.identity, { required: ['workspaceId', 'repoId', 'nodeId'] }, code, 'a pending edit identity')
    check(edit.identity.workspaceId === workspaceId && isIdentifier(edit.identity.repoId) && isIdentifier(edit.identity.nodeId), code, 'a pending edit identity is malformed')
    check(isIdentifier(edit.scopeId) && isIdentifier(edit.generationId) && isRelative(edit.path), code, 'a pending edit origin is malformed')
    check(isDigest(edit.baseNoteDigest) && isDigest(edit.observedDigest) && edit.baseNoteDigest !== edit.observedDigest, code, 'a pending edit needs two different digests')
    // The edited bytes are preserved before an edit is recorded, so a record without its object refuses.
    check(edit.objectRef === `recovery/objects/${edit.observedDigest.slice('sha256:'.length)}.bin`, code, 'a pending edit must name the retained object of its observed bytes')
    check(isTimestamp(edit.observedAt) && EDIT_STATES.includes(edit.state) && isCount(edit.attempts), code, 'a pending edit is malformed')
    check(edit.retryBudget === null || (isCount(edit.retryBudget) && edit.retryBudget <= 16), code, 'retryBudget is out of range')
    check(edit.lastAttemptAt === null || isTimestamp(edit.lastAttemptAt), code, 'lastAttemptAt is malformed')
    if (edit.lastResult !== null) {
      closedObject(edit.lastResult, { required: ['status', 'code', 'operationId', 'policyDigest'] }, code, 'a pending edit result')
      check(APPLY_RESULT_STATUSES.includes(edit.lastResult.status) && typeof edit.lastResult.code === 'string' && typeof edit.lastResult.operationId === 'string' && isDigest(edit.lastResult.policyDigest), code, 'a pending edit result is malformed')
    }
    check(CLOSED_EDIT_STATES.includes(edit.state) ? isTimestamp(edit.closedAt) : edit.closedAt === null, code, 'closedAt must be set exactly when an edit is closed')
    check(edit.state !== 'applied' || edit.lastResult?.status === 'applied', code, 'an edit is applied only when the apply operation said so')
  }
  return document
}

export function validateLateWriters(document, workspaceId) {
  const code = 'invalid-late-writers'
  closedObject(document, { required: ['schema', 'workspaceId', 'findings'] }, code, 'the late writer document')
  check(document.schema === LATE_WRITERS_SCHEMA && document.workspaceId === workspaceId && Array.isArray(document.findings), code, 'the late writer document is malformed')
  for (const finding of document.findings) {
    closedObject(finding, { required: ['scopeId', 'journalId', 'unit', 'notePath', 'digestAtMove', 'observedDigest', 'objectRef', 'detectedAt'] }, code, 'a late writer finding')
    check(isIdentifier(finding.scopeId) && isIdentifier(finding.journalId) && isCount(finding.unit) && (finding.notePath === null || isRelative(finding.notePath)), code, 'a late writer finding is malformed')
    check((finding.digestAtMove === null || isDigest(finding.digestAtMove)) && isDigest(finding.observedDigest) && isRelative(finding.objectRef) && isTimestamp(finding.detectedAt), code, 'a late writer finding is malformed')
  }
  return document
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export function sortEdits(edits) {
  return [...edits].sort((left, right) => compareText(left.identity.repoId, right.identity.repoId) || compareText(left.identity.nodeId, right.identity.nodeId)
    || compareText(left.scopeId, right.scopeId) || compareText(left.observedAt, right.observedAt) || compareText(left.editId, right.editId))
}

export function createMaintenanceStateStore({ workspaceRoot, workspaceId }) {
  const directory = () => ensureContainedPrivateDirectory({ workspaceRoot, directory: path.join(workspaceRoot, 'state', 'maintenance'), label: 'Obsidian maintenance state' })
  const file = (name) => path.join(workspaceRoot, 'state', 'maintenance', name)

  function read(name, validate, code) {
    let text
    try { text = readRegularTextNoFollow(file(name)) } catch (error) {
      if (error.code === 'ENOENT') return null
      refuse(code, 'a maintenance state document cannot be read', { cause: error.code ?? String(error.message) })
    }
    let document
    try { document = JSON.parse(text) } catch { refuse(code, 'a maintenance state document is not JSON') }
    return validate(document, workspaceId)
  }

  function write(name, document, validate) {
    validate(document, workspaceId)
    const text = canonicalJson(document)
    let existing = null
    try { existing = fs.readFileSync(file(name), 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (existing === text) return false
    atomicReplacePrivateText(path.join(directory(), name), text)
    return true
  }

  const registryValidator = (document) => {
    if (document?.schema !== PATH_REGISTRY_SCHEMA || document.workspaceId !== workspaceId || !Array.isArray(document.entries)) refuse('invalid-path-registry', 'the persisted path registry is malformed')
    return document
  }

  return {
    workspaceRoot,
    workspaceId,
    exists: () => fs.existsSync(path.join(workspaceRoot, 'state', 'maintenance')),
    readFreshness: () => read('freshness.json', validateFreshness, 'invalid-freshness-state'),
    writeFreshness: (document) => write('freshness.json', { ...document, scopes: [...document.scopes].sort((left, right) => compareText(left.scopeId, right.scopeId)) }, validateFreshness),
    readPendingEdits: () => read('pending-edits.json', validatePendingEdits, 'invalid-pending-edits') ?? { schema: PENDING_EDITS_SCHEMA, workspaceId, edits: [] },
    writePendingEdits: (document) => write('pending-edits.json', { ...document, edits: sortEdits(document.edits) }, validatePendingEdits),
    readLateWriters: () => read('late-writers.json', validateLateWriters, 'invalid-late-writers') ?? { schema: LATE_WRITERS_SCHEMA, workspaceId, findings: [] },
    writeLateWriters: (document) => write('late-writers.json', document, validateLateWriters),
    readPathRegistry: () => read('path-registry.json', registryValidator, 'invalid-path-registry'),
    writePathRegistry: (document) => write('path-registry.json', document, registryValidator),
  }
}
