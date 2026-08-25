import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createCollaborationEventLedger } from './event-ledger.mjs'
import {
  atomicReplacePrivateText,
  ensureContainedPrivateDirectory,
  readRegularTextNoFollow,
} from '../project/private-state.mjs'

export const ATELIER_PROPOSAL_SCHEMA = 'atelier-proposal@v1'
export const ATELIER_PROPOSALS_SCHEMA = 'atelier-proposals@v1'
export const PROPOSAL_REVIEW_STATUSES = new Set(['reviewed', 'accepted', 'rejected', 'superseded'])
export const COPY_ONLY_PROPOSAL_CAPABILITY = 'proposal.copy-only'
const PROPOSAL_ID_PATTERN = /^proposal-[a-z0-9]+(?:-[a-z0-9]+)*$/

function nowIso() {
  return new Date().toISOString()
}

function cleanIdentity(value, max = 160) {
  return String(value || '').trim().slice(0, max)
}

function stableCompare(left, right) {
  return String(left).localeCompare(String(right), 'en')
}

function safeJsonText(value, max = 50000) {
  if (value == null) return ''
  if (typeof value === 'string') return value.slice(0, max)
  try {
    return JSON.stringify(value, null, 2).slice(0, max)
  } catch {
    return String(value).slice(0, max)
  }
}

function secureWriteJson(file, payload) {
  atomicReplacePrivateText(file, `${JSON.stringify(payload, null, 2)}\n`)
}

function readRegularJson(file) {
  return JSON.parse(readRegularTextNoFollow(file))
}

function writeSnapshotProjectionWith(writer, file, payload) {
  try {
    writer(file, payload)
    return []
  } catch (error) {
    return [{ code: 'proposal-snapshot-write-failed', message: `compatibility snapshot was not updated: ${error.message}` }]
  }
}

function pathContainedBy(root, candidate) {
  const resolvedRoot = path.resolve(root)
  const resolvedCandidate = path.resolve(candidate)
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
}

function proposalId(seed = crypto.randomBytes(16).toString('hex')) {
  return `proposal-${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32)}`
}

export function validateCopyOnlyProposalAuthority(input = {}) {
  const authority = input.authority && typeof input.authority === 'object' ? input.authority : {}
  const capability = input.capability ?? authority.capability
  const directWrite = input.directWrite ?? authority.directWrite
  const applyEndpoint = input.applyEndpoint ?? authority.applyEndpoint
  const issues = []
  if (capability != null && capability !== COPY_ONLY_PROPOSAL_CAPABILITY) {
    issues.push(`capability must be ${COPY_ONLY_PROPOSAL_CAPABILITY}`)
  }
  if (directWrite != null && directWrite !== false) issues.push('direct-write capability must be false')
  if (applyEndpoint != null) issues.push('applyEndpoint must be null')
  return issues.length ? { ok: false, status: 409, issues } : { ok: true, status: 200 }
}

export function copyOnlyActionSummary(action) {
  return {
    action: String(action || ''),
    capability: COPY_ONLY_PROPOSAL_CAPABILITY,
    copyOnly: true,
    directWrite: false,
    applyEndpoint: null,
  }
}

export function canTransitionProposal(from, to) {
  if (from === to) return true
  if (from === 'proposed') return to === 'reviewed' || to === 'rejected' || to === 'superseded'
  if (from === 'reviewed') return to === 'accepted' || to === 'rejected' || to === 'superseded'
  if (from === 'accepted') return to === 'superseded'
  return false
}

export function acceptedProposalCopy(record) {
  const id = record?.proposal?.id || 'unknown-proposal'
  const targetPath = record?.proposal?.path || 'unknown target'
  const action = record?.proposal?.action || 'copy-only proposal'
  const diff = safeJsonText(record?.diff || record?.proposal?.diff || '')
  return {
    proposalId: id,
    targetPath,
    action,
    directWrite: false,
    applyEndpoint: null,
    diff,
    agentInstructions: [
      `Accepted Atelier proposal ${id}.`,
      'Use normal repo editing in the operator checkout if you choose to apply this handoff.',
      'There is no browser apply endpoint and this record does not grant direct write authority.',
      `Target: ${targetPath}`,
      `Action: ${action}`,
    ].join('\n'),
  }
}

export function createProposalStore({
  workspaceRoot = process.cwd(),
  proposalsDir: requestedProposalsDir = path.join(workspaceRoot, '.atelier-proposals'),
  workspaceId = null,
  snapshotWriter = secureWriteJson,
} = {}) {
  const workspaceRootReal = fs.realpathSync(workspaceRoot)
  const proposalsDir = ensureContainedPrivateDirectory({
    workspaceRoot,
    directory: requestedProposalsDir,
    label: 'proposal state directory',
  })
  const eventLedger = createCollaborationEventLedger({
    workspaceRoot,
    ledgerPath: path.join(proposalsDir, 'events.ndjson'),
  })

  function proposalPath(id) {
    const clean = String(id || '')
    if (clean.length > 200 || !PROPOSAL_ID_PATTERN.test(clean)) throw new Error('proposal id is invalid')
    const file = path.join(proposalsDir, `${clean}.json`)
    const candidateDir = fs.realpathSync(proposalsDir)
    if (!pathContainedBy(workspaceRootReal, candidateDir)) {
      throw new Error('proposal directory escapes workspace')
    }
    return file
  }

  function reduceProposal(state, event) {
    if (event.type === 'proposal-created' || event.type === 'proposal-imported') {
      return event.payload.record
    }
    if (event.type === 'proposal-reviewed' && state) {
      const next = {
        ...state,
        proposal: {
          ...state.proposal,
          status: event.payload.status,
          updatedAt: event.at,
          review: event.payload.review,
          eventVersion: event.version,
        },
      }
      if (event.payload.copyable) next.copyable = event.payload.copyable
      else delete next.copyable
      return next
    }
    return state
  }

  function materializedProposal(id) {
    const result = eventLedger.materialize(id, reduceProposal, null)
    if (!result.ok) return { ...result, record: null }
    return result.value
      ? { ...result, record: result.value }
      : { ...result, ok: false, status: 404, error: 'proposal not found', record: null }
  }

  function readCompatibilitySnapshot(id) {
    let file
    try {
      file = proposalPath(id)
    } catch {
      return { ok: false, status: 404, error: 'proposal not found', record: null }
    }
    if (!fs.existsSync(file)) return { ok: false, status: 404, error: 'proposal not found', record: null }
    try {
      const resolved = fs.realpathSync(file)
      if (!pathContainedBy(fs.realpathSync(proposalsDir), resolved)) {
        throw new Error('proposal snapshot escapes workspace')
      }
      const record = readRegularJson(file)
      if (record?.proposal?.id !== id) throw new Error('proposal snapshot id does not match its filename')
      return { ok: true, status: 200, record, source: 'compatibility-snapshot' }
    } catch (error) {
      return { ok: false, status: 422, error: `proposal snapshot cannot be read: ${error.message}`, record: null }
    }
  }

  // Read is a lookup, not an assertion: an unusable id and an unreadable file
  // are both "no such proposal", never a throw. New records materialize from
  // the append-only ledger. Per-proposal JSON remains a compatibility snapshot.
  function readProposal(id) {
    if (String(id || '').length > 200 || !PROPOSAL_ID_PATTERN.test(String(id || ''))) {
      return { ok: false, status: 404, error: 'proposal not found', record: null }
    }
    const materialized = materializedProposal(id)
    if (materialized.ok) {
      if (materialized.record?.proposal?.id !== id) {
        return { ok: false, status: 422, error: 'proposal ledger identity mismatch', record: null }
      }
      return materialized
    }
    if (materialized.status !== 404) return materialized
    return readCompatibilitySnapshot(id)
  }

  function listProposals() {
    if (!fs.existsSync(proposalsDir)) return { ok: true, status: 200, proposals: [] }
    const ledger = eventLedger.readAll()
    if (!ledger.ok) return { ...ledger, proposals: [] }
    const ledgerRecords = new Map()
    for (const event of ledger.events) {
      if (!PROPOSAL_ID_PATTERN.test(event.aggregateId)) {
        return { ok: false, status: 422, error: 'proposal ledger contains an invalid identity', proposals: [] }
      }
      ledgerRecords.set(
        event.aggregateId,
        reduceProposal(ledgerRecords.get(event.aggregateId) ?? null, event),
      )
    }
    const ledgerIds = [...ledgerRecords.keys()]
    const snapshotEntries = fs.readdirSync(proposalsDir, { withFileTypes: true })
      .filter((entry) => entry.name.endsWith('.json'))
    const unsafeSnapshot = snapshotEntries.find((entry) => !entry.isFile())
    if (unsafeSnapshot) {
      return { ok: false, status: 422, error: 'proposal snapshot cannot be read: state leaf is not a regular file', proposals: [] }
    }
    const snapshotIds = snapshotEntries.map((entry) => entry.name.slice(0, -'.json'.length))
    const readIds = [...new Set([...ledgerIds, ...snapshotIds])].sort(stableCompare)
    const reads = readIds.map((id) => {
      const record = ledgerRecords.get(id)
      if (record) return { ok: true, status: 200, record, source: 'event-ledger' }
      return readCompatibilitySnapshot(id)
    })
    const failed = reads.find((result) => !result.ok)
    if (failed) return { ...failed, proposals: [] }
    if (reads.some((result, index) => result.record?.proposal?.id !== readIds[index])) {
      return { ok: false, status: 422, error: 'proposal identity does not match its state key', proposals: [] }
    }
    const proposals = reads
      .map((result) => result.record)
      .sort((left, right) => stableCompare(right.proposal?.updatedAt || '', left.proposal?.updatedAt || ''))
    return { ok: true, status: 200, proposals, diagnostics: ledger.diagnostics, stats: ledger.stats }
  }

  function ensureLedgerSeed(id, record) {
    const existing = eventLedger.eventsFor(id)
    if (!existing.ok) return existing
    if (existing.events.length > 0) return { ok: true, version: existing.currentVersion }
    const seeded = eventLedger.append({
      aggregateId: id,
      expectedVersion: 0,
      type: 'proposal-imported',
      actor: 'atelier compatibility importer',
      at: record.proposal?.createdAt || nowIso(),
      payload: { record },
    })
    if (!seeded.ok) return seeded
    return { ok: true, version: seeded.event.version }
  }

  function createProposal(body = {}) {
    const action = cleanIdentity(body.action || body.proposal?.action || 'copy.repoPath', 120)
    const authority = validateCopyOnlyProposalAuthority({
      ...(body.proposal && typeof body.proposal === 'object' ? body.proposal : {}),
      ...body,
    })
    if (!authority.ok) {
      return {
        ok: false,
        status: authority.status,
        error: `proposal authority refused: ${authority.issues.join('; ')}`,
      }
    }

    const createdAt = nowIso()
    const id = proposalId([
      createdAt,
      body.sessionId,
      body.viewId,
      body.path,
      action,
      safeJsonText(body.proposal || body.diff || ''),
    ].join('\0'))
    const record = {
      schema: ATELIER_PROPOSAL_SCHEMA,
      workspaceId,
      proposal: {
        id,
        status: 'proposed',
        createdAt,
        updatedAt: createdAt,
        sessionId: cleanIdentity(body.sessionId, 120),
        viewId: cleanIdentity(body.viewId, 120),
        path: cleanIdentity(body.path || body.rel, 500),
        action,
        intent: cleanIdentity(body.intent || body.proposal?.intent, 500),
        reason: cleanIdentity(body.proposal?.reason || body.reason, 1000),
        storage: {
          kind: 'local',
          ignored: true,
        },
        authority: copyOnlyActionSummary(action),
        eventVersion: 1,
      },
      diff: safeJsonText(body.diff || body.proposal?.diff || ''),
      payload: body.proposal && typeof body.proposal === 'object' ? body.proposal : {},
    }
    const appended = eventLedger.append({
      aggregateId: id,
      expectedVersion: 0,
      type: 'proposal-created',
      actor: cleanIdentity(body.actor || body.proposal?.createdBy || 'local contributor', 160),
      at: createdAt,
      payload: { record },
    })
    if (!appended.ok) {
      return { ok: false, status: appended.status, error: appended.error }
    }
    const diagnostics = writeSnapshotProjectionWith(snapshotWriter, proposalPath(id), record)
    return { ok: true, status: 200, record, diagnostics }
  }

  function reviewProposal(id, body = {}) {
    const read = readProposal(id)
    if (!read.ok) return read
    const record = read.record
    if (body.proposalId && body.proposalId !== id) {
      return { ok: false, status: 409, error: 'ambiguous proposal review refused' }
    }

    const nextStatus = cleanIdentity(body.status, 40)
    if (!PROPOSAL_REVIEW_STATUSES.has(nextStatus)) {
      return { ok: false, status: 400, error: 'unsupported proposal review status' }
    }
    if (body.expectedStatus && body.expectedStatus !== record.proposal.status) {
      return { ok: false, status: 409, error: 'stale proposal review refused: status changed' }
    }
    if (body.expectedUpdatedAt && body.expectedUpdatedAt !== record.proposal.updatedAt) {
      return { ok: false, status: 409, error: 'stale proposal review refused: timestamp changed' }
    }
    if (!canTransitionProposal(record.proposal.status, nextStatus)) {
      return {
        ok: false,
        status: 409,
        error: `invalid proposal review transition ${record.proposal.status} -> ${nextStatus}`,
      }
    }

    const updatedAt = nowIso()
    const review = {
      reviewer: cleanIdentity(body.reviewer || 'unknown reviewer', 160),
      notes: cleanIdentity(body.notes, 2000),
      reviewedAt: updatedAt,
    }
    const nextProposal = {
      ...record.proposal,
      status: nextStatus,
      updatedAt,
      review,
    }
    const nextRecord = { ...record, proposal: nextProposal }
    if (nextStatus === 'accepted') {
      nextRecord.copyable = acceptedProposalCopy(nextRecord)
    } else {
      delete nextRecord.copyable
    }
    const seeded = ensureLedgerSeed(id, record)
    if (!seeded.ok) return seeded
    const appended = eventLedger.append({
      aggregateId: id,
      expectedVersion: seeded.version,
      type: 'proposal-reviewed',
      actor: review.reviewer,
      at: updatedAt,
      payload: {
        status: nextStatus,
        review,
        ...(nextRecord.copyable ? { copyable: nextRecord.copyable } : {}),
      },
    })
    if (!appended.ok) {
      return { ok: false, status: appended.status, error: appended.error }
    }
    nextRecord.proposal.eventVersion = appended.event.version
    const diagnostics = writeSnapshotProjectionWith(snapshotWriter, proposalPath(id), nextRecord)
    return { ok: true, status: 200, record: nextRecord, diagnostics }
  }

  return {
    proposalsDir,
    eventLedger,
    proposalPath,
    readProposal,
    listProposals,
    createProposal,
    reviewProposal,
  }
}
