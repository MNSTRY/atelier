import fs from 'node:fs'
import path from 'node:path'
import { isPendingPrivateWrite, publishPrivateFile } from '../../../project/durable-state.mjs'
import { checkManagedRoots } from '../../../project/file-class.mjs'
import { ensureContainedPrivateDirectory, openRegularFileNoFollow } from '../../../project/private-state.mjs'
import { canonicalJson, closedObject, compareText, isoTime } from '../../../runtime/obsidian/documents.mjs'
import { validateObsidianContract } from '../contracts.mjs'
import { encodeIdentitySegment, isIdentifier } from '../edits/object-identity.mjs'
import { sha256Digest } from '../materialize/byte-lens.mjs'
import { adapterOperationId, isAdapterOperationId, isRoutableSourcePath, proposalStoreId } from './router.mjs'

// The memory of the proposal adapter: one record per adapter operation, in
// private workspace state, written BEFORE any proposal is created.
//
//   <stateRoot>/state/proposals/<repo>/operations/<operation>--000001.json
//   <stateRoot>/state/proposals/<repo>/lock/                 (adapter.mjs)
//
// <repo> is an encoded repository identifier (edits/object-identity.mjs), so
// two repositories never share a directory. A record is one complete,
// canonical JSON file, owner-only, published with a non-overwriting hard link
// and never rewritten or removed. Each step of an operation is the next
// numbered file; it repeats the whole record and names the digest of the file
// before it. The state of an operation is its highest file.
//
//   queued        recorded; no proposal has been asked for yet, or the last attempt is to be made again
//   submitted     a proposal that carries this operation identity exists in the store of the repository
//   acknowledged  that proposal was read back and a receipt binds it to the edit; final
//   backpressure  the store could not take it now; tried again after `nextAttemptAt`, a bounded number of times
//   refused       it cannot be routed or stored as it is; final until a person asks for it again
//
// Bounds. A repository holds at most 4096 operations, 256 of them open, and an
// operation at most 64 files of at most 16 KiB. Nothing is rotated, compacted
// or dropped: a full queue refuses `queue-full` and records nothing, and the
// edit stays where it was, preserved and recorded, to be offered again.
//
// No record holds note or source text: identifiers, digests, a
// repository-relative path, codes, numbers and timestamps only.

export const PROPOSAL_QUEUE_DIRECTORY = path.join('state', 'proposals')
export const PROPOSAL_OPERATION_SCHEMA = 'atelier-obsidian-proposal-operation/v1'
export const PROPOSAL_QUEUE_STATES = Object.freeze(['queued', 'submitted', 'acknowledged', 'backpressure', 'refused'])
export const OPEN_QUEUE_STATES = Object.freeze(['queued', 'submitted', 'backpressure'])
export const PROPOSAL_QUEUE_LIMITS = Object.freeze({ maxOperationsPerRepository: 4096, maxOpenPerRepository: 256, maxRecordsPerOperation: 64, maxRecordBytes: 16 * 1024 })
export const PROPOSAL_QUEUE_CRASH_STEPS = Object.freeze(['record-published'])

const TRANSITIONS = Object.freeze({
  queued: ['queued', 'submitted', 'backpressure', 'refused'],
  backpressure: ['backpressure', 'submitted', 'refused', 'queued'],
  // Back to `queued` only when the proposal it named is no longer in the store: it is then asked for again.
  submitted: ['acknowledged', 'queued', 'submitted'],
  refused: ['queued'],
  acknowledged: [],
})
const RECORD_NAME = /^(pa-[0-9a-f]{64})--(\d{6})\.json$/
const recordName = (operationId, sequence) => `${operationId}--${String(sequence).padStart(6, '0')}.json`
const DIGEST = /^sha256:[0-9a-f]{64}$/
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const CODE = /^[a-z][a-z0-9-]{0,63}$/
const EDIT_ID = /^edit-[0-9a-f]{32}$/
const PROPOSAL_ID = /^proposal-[a-z0-9]+(?:-[a-z0-9]+)*$/
const FIELDS = Object.freeze(['schema', 'adapterOperationId', 'sequence', 'previous', 'workspaceId', 'repoId', 'nodeId', 'editId', 'idempotencyKey', 'scopeId', 'generationId', 'sourcePath', 'storeId',
  'state', 'code', 'attempts', 'lastAttemptAt', 'nextAttemptAt', 'proposalId', 'dedupe', 'receipt', 'recordedAt'])
// What never changes from the first file of an operation to its last.
const FIXED = Object.freeze(['adapterOperationId', 'workspaceId', 'repoId', 'nodeId', 'editId', 'idempotencyKey', 'scopeId', 'generationId', 'storeId'])

export class ProposalQueueRefusal extends Error {
  constructor(code, message, detail = {}) {
    super(`${code}: ${message}`)
    this.name = 'ProposalQueueRefusal'
    this.code = code
    this.detail = detail
  }
}
const refuse = (code, message, detail) => { throw new ProposalQueueRefusal(code, message, detail) }

const isCount = (value) => Number.isInteger(value) && value >= 0
const isTimestamp = (value) => typeof value === 'string' && TIMESTAMP.test(value)

export function isProposalOperationRecord(record) {
  try { closedObject(record, { required: FIELDS }, 'invalid', 'record') } catch { return false }
  const identityOk = record.schema === PROPOSAL_OPERATION_SCHEMA && [record.workspaceId, record.repoId, record.nodeId, record.scopeId, record.generationId].every(isIdentifier)
    && isAdapterOperationId(record.adapterOperationId) && typeof record.editId === 'string' && EDIT_ID.test(record.editId) && typeof record.idempotencyKey === 'string'
  if (!identityOk) return false
  let expected
  try { expected = adapterOperationId(record) } catch { return false }
  if (expected !== record.adapterOperationId || record.storeId !== proposalStoreId(record)) return false
  if (!Number.isInteger(record.sequence) || record.sequence < 1 || !(record.previous === null ? record.sequence === 1 : DIGEST.test(record.previous) && record.sequence > 1)) return false
  // The path a route refused for is unknown or unusable, and is then not recorded at all.
  if (!(record.sourcePath === null || isRoutableSourcePath(record.sourcePath))) return false
  if (!PROPOSAL_QUEUE_STATES.includes(record.state) || !(record.code === null || (typeof record.code === 'string' && CODE.test(record.code)))) return false
  if (!isCount(record.attempts) || !(record.lastAttemptAt === null || isTimestamp(record.lastAttemptAt)) || !(record.nextAttemptAt === null || isTimestamp(record.nextAttemptAt)) || !isTimestamp(record.recordedAt)) return false
  if (!(record.proposalId === null || (typeof record.proposalId === 'string' && record.proposalId.length <= 128 && PROPOSAL_ID.test(record.proposalId)))) return false
  if (!(record.dedupe === null || ['new', 'recovered'].includes(record.dedupe))) return false
  const settled = record.state === 'submitted' || record.state === 'acknowledged'
  if (settled !== (record.proposalId !== null) || settled !== (record.dedupe !== null)) return false
  if ((record.state === 'refused' || record.state === 'backpressure') && record.code === null) return false
  if (record.state === 'acknowledged' || record.state === 'refused') {
    const receipt = record.receipt
    if (validateObsidianContract('proposal-receipt', receipt).length > 0) return false
    if (receipt.adapterOperationId !== record.adapterOperationId || receipt.editId !== record.editId || receipt.repoId !== record.repoId || receipt.storeId !== record.storeId || receipt.proposalId !== record.proposalId) return false
    if (receipt.backpressure !== (record.state === 'acknowledged' ? 'accepted' : 'refused')) return false
  } else if (record.receipt !== null) return false
  return true
}

function readBytesNoFollow(file) {
  const descriptor = openRegularFileNoFollow(file)
  try { return fs.readFileSync(descriptor) } finally { fs.closeSync(descriptor) }
}

export function openProposalQueue({ stateRoot, workspaceId, repositoryRoots, clock, crash = () => {}, limits = PROPOSAL_QUEUE_LIMITS } = {}) {
  if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot)) throw new TypeError('stateRoot must be an absolute path')
  if (!isIdentifier(workspaceId)) throw new TypeError('workspaceId must be a contract identifier')
  if (typeof clock !== 'function') throw new TypeError('a clock must be injected')
  if (!Array.isArray(repositoryRoots) || repositoryRoots.some((item) => typeof item !== 'string' || !path.isAbsolute(item))) throw new TypeError('repositoryRoots must list the absolute root of every enrolled repository')
  const guard = checkManagedRoots({ managedRoots: [stateRoot], repositoryRoots })
  if (!guard.ok) refuse('state-root-overlaps-repository', 'the adapter queue may not overlap an enrolled repository', { codes: guard.refusals.map((item) => item.code) })
  const root = fs.realpathSync.native(stateRoot)
  const queueRoot = path.join(root, PROPOSAL_QUEUE_DIRECTORY)
  // Two processes may create the same directory at once; the one that loses the mkdir finds it made.
  const privateDir = (...parts) => {
    for (let attempt = 0; ; attempt += 1) {
      try { return ensureContainedPrivateDirectory({ workspaceRoot: root, directory: path.join(queueRoot, ...parts), label: 'proposal adapter state' }) } catch (error) {
        if (error.code !== 'EEXIST' || attempt >= 8) throw error
      }
    }
  }
  const repositoryDirectory = (repoId) => path.join(queueRoot, encodeIdentitySegment(repoId))
  const operationsDirectory = (repoId) => path.join(repositoryDirectory(repoId), 'operations')
  // Records are immutable, so one that was read and verified stays verified under its name.
  const verified = new Map()

  function readRecord(directory, name) {
    const file = path.join(directory, name)
    const cached = verified.get(file)
    if (cached) return cached
    const [, operationId, digits] = RECORD_NAME.exec(name)
    const corrupt = (code, message) => refuse(code, message, { adapterOperationId: operationId, sequence: Number(digits) })
    let bytes
    try {
      if (fs.lstatSync(file).size > limits.maxRecordBytes) corrupt('queue-record-too-large', 'a record of the adapter queue is larger than a record can be')
      bytes = readBytesNoFollow(file)
    } catch (error) {
      if (error instanceof ProposalQueueRefusal) throw error
      return corrupt('queue-record-unreadable', 'a record of the adapter queue cannot be read')
    }
    let record
    try { record = JSON.parse(bytes.toString('utf8')) } catch { return corrupt('queue-record-malformed', 'a record of the adapter queue is not a document') }
    if (!isProposalOperationRecord(record) || canonicalJson(record) !== bytes.toString('utf8')) corrupt('queue-record-malformed', 'a record of the adapter queue is not a valid canonical record')
    if (record.adapterOperationId !== operationId || record.sequence !== Number(digits) || record.workspaceId !== workspaceId) corrupt('queue-record-foreign', 'a record of the adapter queue is not where it belongs')
    const entry = { record, digest: sha256Digest(bytes) }
    verified.set(file, entry)
    return entry
  }

  // Every operation of one repository by its files: Map(operationId -> highest sequence). Refuses a directory that
  // holds anything this module did not write, since nothing may be decided over files nobody can account for.
  function listNames(repoId) {
    const directory = operationsDirectory(repoId)
    let names
    try { names = fs.readdirSync(directory) } catch (error) { if (error.code === 'ENOENT') return { directory, highest: new Map() }; throw error }
    const highest = new Map()
    for (const name of names) {
      if (isPendingPrivateWrite(name)) continue
      const match = RECORD_NAME.exec(name)
      if (!match || Number(match[2]) < 1) refuse('queue-foreign-file', 'the adapter queue holds a file that is not a record; nothing is decided until a person has looked', { repoId })
      highest.set(match[1], Math.max(highest.get(match[1]) ?? 0, Number(match[2])))
    }
    return { directory, highest }
  }

  // The whole, verified history of one operation, or null.
  function readOperation(repoId, operationId) {
    const { directory, highest } = listNames(repoId)
    const last = highest.get(operationId) ?? 0
    if (last === 0) return null
    const records = []
    let previous = null
    for (let sequence = 1; sequence <= last; sequence += 1) {
      let entry
      try { entry = readRecord(directory, recordName(operationId, sequence)) } catch (error) {
        if (error instanceof ProposalQueueRefusal && error.code === 'queue-record-unreadable') refuse('queue-record-gap', 'a record of the operation is missing', { adapterOperationId: operationId, sequence })
        throw error
      }
      const before = records.at(-1)
      if (entry.record.previous !== previous || entry.record.repoId !== repoId) refuse('queue-chain-broken', 'a record of the operation does not follow the one before it', { adapterOperationId: operationId, sequence })
      if (before && (FIXED.some((field) => before[field] !== entry.record[field]) || !TRANSITIONS[before.state].includes(entry.record.state))) {
        refuse('queue-history-invalid', 'the records of the operation are not a history this adapter could have written', { adapterOperationId: operationId, sequence })
      }
      records.push(entry.record)
      previous = entry.digest
    }
    return { records, head: records.at(-1), headDigest: previous }
  }

  function publish(directory, record) {
    const bytes = Buffer.from(canonicalJson(record), 'utf8')
    if (bytes.length > limits.maxRecordBytes) refuse('queue-record-too-large', 'the record is larger than a record can be', { bytes: bytes.length })
    const file = path.join(directory, recordName(record.adapterOperationId, record.sequence))
    const context = { adapterOperationId: record.adapterOperationId, sequence: record.sequence, state: record.state }
    // Non-overwriting: of two writers of one name exactly one succeeds, and the other is told.
    try { publishPrivateFile(file, bytes) } catch (error) {
      if (error.code === 'EEXIST') refuse('queue-record-taken', 'another writer recorded this step of the operation first', context)
      throw error
    }
    crash('record-published', context)
  }

  return {
    workspaceId,
    stateRoot: root,
    queueRoot,
    lockDirectory: (repoId) => path.join(repositoryDirectory(repoId), 'lock'),
    // Made on demand: a workspace that never sees a structural edit holds no adapter state at all.
    ensureRepository(repoId) { privateDir(encodeIdentitySegment(repoId)); return privateDir(encodeIdentitySegment(repoId), 'operations') },

    read: (repoId, operationId) => readOperation(repoId, operationId),

    // The head of every operation of every repository. An operation (or a repository) that cannot be read is listed
    // as such, with its code, and hides nothing else. { operations, unreadable }
    heads({ repoId: only } = {}) {
      const operations = []
      const unreadable = []
      let segments
      try { segments = fs.readdirSync(queueRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort() } catch (error) { if (error.code === 'ENOENT') return { operations, unreadable }; throw error }
      for (const segment of segments) {
        if (only !== undefined && segment !== encodeIdentitySegment(only)) continue
        const directory = path.join(queueRoot, segment, 'operations')
        let names
        try { names = fs.readdirSync(directory) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
        const highest = new Map()
        let foreign = false
        for (const name of names) {
          if (isPendingPrivateWrite(name)) continue
          const match = RECORD_NAME.exec(name)
          if (!match) { foreign = true; continue }
          highest.set(match[1], Math.max(highest.get(match[1]) ?? 0, Number(match[2])))
        }
        if (foreign) unreadable.push({ segment, adapterOperationId: null, code: 'queue-foreign-file' })
        for (const [operationId, sequence] of [...highest].sort(([left], [right]) => compareText(left, right))) {
          try {
            const { record } = readRecord(directory, recordName(operationId, sequence))
            if (encodeIdentitySegment(record.repoId) !== segment) refuse('queue-record-foreign', 'a record is kept under another repository', { adapterOperationId: operationId })
            operations.push(record)
          } catch (error) {
            if (!(error instanceof ProposalQueueRefusal)) throw error
            unreadable.push({ segment, adapterOperationId: operationId, code: error.code })
          }
        }
      }
      return { operations, unreadable }
    },

    // Records the next step of an operation. `fields` are the members that change; the first step names the whole
    // operation. Returns the record written. Refuses `queue-full` before the first step of an operation the
    // repository has no room for, and `queue-operation-full` when an operation holds as many files as it may.
    append(repoId, operationId, fields) {
      const existing = readOperation(repoId, operationId)
      if (existing === null) {
        const { highest } = listNames(repoId)
        if (highest.size >= limits.maxOperationsPerRepository) refuse('queue-full', 'the adapter queue of the repository holds as many operations as it may; nothing is rotated or dropped', { repoId, operations: highest.size })
        const open = this.heads({ repoId }).operations.filter((record) => OPEN_QUEUE_STATES.includes(record.state)).length
        if (open >= limits.maxOpenPerRepository) refuse('queue-full', 'the adapter queue of the repository holds as many open operations as it may', { repoId, open })
      } else if (existing.records.length >= limits.maxRecordsPerOperation) {
        refuse('queue-operation-full', 'the operation holds as many records as an operation may', { adapterOperationId: operationId })
      }
      const base = existing?.head ?? { schema: PROPOSAL_OPERATION_SCHEMA, adapterOperationId: operationId, workspaceId, repoId, code: null, attempts: 0, lastAttemptAt: null, nextAttemptAt: null, proposalId: null, dedupe: null, receipt: null }
      const record = { ...base, ...fields, sequence: (existing?.records.length ?? 0) + 1, previous: existing?.headDigest ?? null, recordedAt: isoTime(clock) }
      if (!isProposalOperationRecord(record)) refuse('invalid-queue-record', 'the record is not one this adapter writes', { adapterOperationId: operationId, state: String(fields?.state) })
      if (existing && (FIXED.some((field) => existing.head[field] !== record[field]) || !TRANSITIONS[existing.head.state].includes(record.state))) {
        refuse('invalid-queue-transition', 'the operation cannot go from where it is to there', { adapterOperationId: operationId, from: existing.head.state, to: record.state })
      }
      publish(this.ensureRepository(repoId), record)
      return record
    },
  }
}
