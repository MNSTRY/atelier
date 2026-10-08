import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { canonicalize } from '../attestation/jcs.mjs'
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
export const WORKSHOP_HANDOFF_RETENTION_KIND = 'workshop-handoff'
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

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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
      if (event.payload.record) return event.payload.record
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

  function reduceProposalEvents(id, events) {
    if (events.length === 0) {
      return { ok: false, status: 404, error: 'proposal not found', record: null }
    }
    let state = null
    let previousVersion = 0
    for (const event of events) {
      if (state === null) {
        if (event.version !== 1 || !['proposal-created', 'proposal-imported'].includes(event.type)) {
          return { ok: false, status: 422, error: 'proposal ledger does not begin with a canonical record', record: null }
        }
        const record = event.payload?.record
        if (
          !isRecord(record) || record.schema !== ATELIER_PROPOSAL_SCHEMA ||
          !isRecord(record.proposal) || record.proposal.id !== id ||
          !['proposed', ...PROPOSAL_REVIEW_STATUSES].includes(record.proposal.status)
        ) {
          return { ok: false, status: 422, error: 'proposal ledger record is invalid', record: null }
        }
      } else {
        const checkpoint = event.payload?.record
        const checkpointValid = (
          isRecord(checkpoint) && checkpoint.schema === ATELIER_PROPOSAL_SCHEMA &&
          isRecord(checkpoint.proposal) && checkpoint.proposal.id === id &&
          checkpoint.proposal.status === event.payload?.status &&
          checkpoint.proposal.eventVersion === event.version
        )
        const hasCompactionGap = event.version > previousVersion + 1
        if (
          event.type !== 'proposal-reviewed' || !PROPOSAL_REVIEW_STATUSES.has(event.payload?.status) ||
          !isRecord(event.payload?.review) ||
          (checkpoint !== undefined && !checkpointValid) ||
          (hasCompactionGap && !checkpointValid) ||
          (!hasCompactionGap && !canTransitionProposal(state.proposal.status, event.payload.status))
        ) {
          return { ok: false, status: 422, error: 'proposal ledger review sequence is invalid', record: null }
        }
      }
      state = reduceProposal(state, event)
      previousVersion = event.version
    }
    return { ok: true, status: 200, record: state }
  }

  function materializedProposal(id) {
    const result = eventLedger.eventsFor(id)
    if (!result.ok) return { ...result, record: null }
    return { ...result, ...reduceProposalEvents(id, result.events) }
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
    const ledgerEvents = new Map()
    for (const event of ledger.events) {
      if (!PROPOSAL_ID_PATTERN.test(event.aggregateId)) {
        return { ok: false, status: 422, error: 'proposal ledger contains an invalid identity', proposals: [] }
      }
      const events = ledgerEvents.get(event.aggregateId) ?? []
      events.push(event)
      ledgerEvents.set(event.aggregateId, events)
    }
    const ledgerRecords = new Map()
    for (const [id, events] of ledgerEvents) {
      const reduced = reduceProposalEvents(id, events)
      if (!reduced.ok) return { ...reduced, proposals: [] }
      ledgerRecords.set(id, reduced.record)
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

  const RETAINED_FIELD_LIMITS = { sessionId: 120, viewId: 120, path: 500, action: 120, intent: 500, actor: 160 }
  const sha256Hex = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')

  // The original saved receipt that names one retained handoff. Nothing is
  // trimmed: a value that is not already usable is not an identity.
  function retentionIdentity(receipt) {
    if (!isRecord(receipt)) return null
    const { sessionId, requestId, valueDigest } = receipt
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 120) return null
    if (typeof requestId !== 'string' || !requestId || requestId.length > 200) return null
    if (typeof valueDigest !== 'string' || !/^[a-f0-9]{64}$/.test(valueDigest)) return null
    return { kind: WORKSHOP_HANDOFF_RETENTION_KIND, sessionId, requestId, valueDigest }
  }

  // The value digest is not part of the id, so another value saved under the
  // same original request meets the first record and is refused.
  function retainedProposalId(identity) {
    return proposalId(canonicalize({ kind: identity.kind, sessionId: identity.sessionId, requestId: identity.requestId }))
  }

  // The digest covers exactly what the record holds, so a lookup recomputes it.
  function retainedDigest(record) {
    const proposal = record.proposal
    return sha256Hex(canonicalize({
      sessionId: proposal.sessionId,
      viewId: proposal.viewId,
      path: proposal.path,
      action: proposal.action,
      intent: proposal.intent,
      actor: record.retention.actor,
      diff: record.diff,
      payload: record.payload,
    }))
  }

  // Lookup by the original saved receipt. Only the ledger answers: a
  // compatibility snapshot is never a retained outcome, and a ledger that
  // cannot be read is unknown, not absent.
  function lookupRetainedProposal(receipt) {
    const identity = retentionIdentity(receipt)
    if (!identity) {
      return { ok: false, status: 422, outcome: 'refused', error: 'selected draft receipt is not usable as a retention identity' }
    }
    const id = retainedProposalId(identity)
    const found = materializedProposal(id)
    if (!found.ok && found.status === 404) {
      return fs.existsSync(proposalPath(id))
        ? { ok: false, status: 409, outcome: 'unknown', id, error: 'a snapshot exists for this receipt without a ledger record; inspect it before retrying' }
        : { ok: true, status: 200, outcome: 'not-found', id, record: null }
    }
    if (!found.ok) return { ok: false, status: found.status, outcome: 'unknown', id, error: found.error }
    const kept = found.record?.retention
    let digest = null
    try {
      digest = isRecord(kept) ? retainedDigest(found.record) : null
    } catch {
      digest = null
    }
    if (
      !isRecord(kept) || kept.kind !== identity.kind || kept.sessionId !== identity.sessionId ||
      kept.requestId !== identity.requestId || digest === null || digest !== kept.payloadDigest
    ) {
      return { ok: false, status: 422, outcome: 'unknown', id, error: 'the retained proposal does not match its own receipt identity or digest' }
    }
    if (kept.valueDigest !== identity.valueDigest) {
      return { ok: false, status: 409, outcome: 'conflict', id, error: 'a different value is already retained for this original receipt' }
    }
    return { ok: true, status: 200, outcome: 'retained', id, record: found.record }
  }

  // The handoff as it was retained, for readback after a lost reply or a
  // source change.
  function retainedHandoff(record) {
    const proposal = record.proposal
    return {
      sessionId: proposal.sessionId,
      viewId: proposal.viewId,
      path: proposal.path,
      action: proposal.action,
      actor: record.retention.actor,
      intent: proposal.intent,
      directWrite: false,
      applyEndpoint: null,
      diff: JSON.parse(record.diff),
      proposal: record.payload,
    }
  }

  // Retain one server-derived handoff once, keyed by its original saved
  // receipt. The caller derives the handoff; this store never trims or cuts
  // it. A field that would not fit is refused, and the ledger's own line
  // ceiling refuses the rest. A retained record is `proposed`: it is neither a
  // review decision nor a source change.
  function retainProposal(handoff = {}) {
    if (!isRecord(handoff) || !isRecord(handoff.proposal) || !isRecord(handoff.diff)) {
      return { ok: false, status: 422, outcome: 'refused', error: 'handoff shape is not supported' }
    }
    const authority = validateCopyOnlyProposalAuthority({ ...handoff.proposal, ...handoff })
    if (!authority.ok || handoff.directWrite !== false || handoff.applyEndpoint !== null) {
      return { ok: false, status: 409, outcome: 'refused', error: 'proposal authority refused: a retained handoff is copy-only' }
    }
    for (const [field, max] of Object.entries(RETAINED_FIELD_LIMITS)) {
      const value = handoff[field]
      if (typeof value !== 'string' || !value || value !== value.trim() || value.length > max) {
        return { ok: false, status: 413, outcome: 'refused', error: `handoff ${field} cannot be retained without changing it` }
      }
    }
    const identity = retentionIdentity(handoff.proposal.selectedDraftReceipt)
    if (!identity || identity.sessionId !== handoff.sessionId) {
      return { ok: false, status: 422, outcome: 'refused', error: 'selected draft receipt is not usable as a retention identity' }
    }
    let record
    try {
      const diffText = JSON.stringify(handoff.diff, null, 2)
      if (diffText.length > 50000) {
        return { ok: false, status: 413, outcome: 'refused', error: 'handoff diff cannot be retained without truncation' }
      }
      const createdAt = nowIso()
      record = {
        schema: ATELIER_PROPOSAL_SCHEMA,
        workspaceId,
        proposal: {
          id: retainedProposalId(identity),
          status: 'proposed',
          createdAt,
          updatedAt: createdAt,
          sessionId: handoff.sessionId,
          viewId: handoff.viewId,
          path: handoff.path,
          action: handoff.action,
          intent: handoff.intent,
          reason: '',
          storage: {
            kind: 'local',
            ignored: true,
          },
          authority: copyOnlyActionSummary(handoff.action),
          eventVersion: 1,
        },
        diff: diffText,
        payload: handoff.proposal,
        retention: { ...identity, actor: handoff.actor, receipt: handoff.proposal.selectedDraftReceipt },
      }
      record.retention.payloadDigest = retainedDigest(record)
    } catch {
      return { ok: false, status: 422, outcome: 'refused', error: 'handoff cannot be canonicalized' }
    }
    const unknown = (error) => ({ ok: false, status: 409, outcome: 'unknown', error })
    const settle = (known) => {
      if (known.outcome !== 'retained') return known
      return known.record.retention.payloadDigest === record.retention.payloadDigest
        ? { ok: true, status: 200, outcome: 'existing', record: known.record, diagnostics: [] }
        : { ok: false, status: 409, outcome: 'conflict', error: 'a different handoff is already retained for this original receipt' }
    }
    const known = lookupRetainedProposal(identity)
    if (known.outcome !== 'not-found') return settle(known)
    const appended = eventLedger.append({
      aggregateId: record.proposal.id,
      expectedVersion: 0,
      type: 'proposal-created',
      actor: handoff.actor,
      at: record.proposal.createdAt,
      payload: { record },
    })
    if (!appended.ok) {
      // A version conflict means another writer appended first. Read back the
      // original identity; never append again.
      if (appended.status === 409) {
        const again = lookupRetainedProposal(identity)
        return again.outcome === 'retained'
          ? settle(again)
          : unknown('the append conflicted and the original receipt could not be read back; repeat the same request')
      }
      return { ok: false, status: appended.status, outcome: appended.status === 413 ? 'refused' : 'unknown', error: appended.error }
    }
    // Retention is acknowledged only from the ledger's own readback.
    const back = lookupRetainedProposal(identity)
    if (back.outcome !== 'retained' || back.record.retention.payloadDigest !== record.retention.payloadDigest) {
      return unknown('the retained proposal could not be read back after its append; repeat the same request')
    }
    const diagnostics = writeSnapshotProjectionWith(snapshotWriter, proposalPath(record.proposal.id), back.record)
    return { ok: true, status: 200, outcome: 'created', record: back.record, diagnostics }
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
    nextRecord.proposal.eventVersion = seeded.version + 1
    const appended = eventLedger.append({
      aggregateId: id,
      expectedVersion: seeded.version,
      type: 'proposal-reviewed',
      actor: review.reviewer,
      at: updatedAt,
      payload: {
        status: nextStatus,
        review,
        record: nextRecord,
        ...(nextRecord.copyable ? { copyable: nextRecord.copyable } : {}),
      },
    })
    if (!appended.ok) {
      return { ok: false, status: appended.status, error: appended.error }
    }
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
    lookupRetainedProposal,
    retainedHandoff,
    retainProposal,
    reviewProposal,
  }
}
