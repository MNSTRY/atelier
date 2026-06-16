import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const ATELIER_PROPOSAL_SCHEMA = 'atelier-proposal@v1'
export const ATELIER_PROPOSALS_SCHEMA = 'atelier-proposals@v1'
export const PROPOSAL_REVIEW_STATUSES = new Set(['reviewed', 'accepted', 'rejected', 'superseded'])

const DIRECT_WRITE_ACTION_RE = /(?:^|[._:-])(apply|write|commit|persist|mutate|db|database)(?:$|[._:-])/i

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

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(dir, 0o700)
  } catch {
    // Best effort on filesystems that do not support chmod.
  }
}

function secureWriteJson(file, payload) {
  ensurePrivateDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, file)
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    // Best effort on filesystems that do not support chmod.
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

export function actionIsCopyOnly(action) {
  const value = String(action || '')
  return Boolean(value) && !DIRECT_WRITE_ACTION_RE.test(value)
}

export function copyOnlyActionSummary(action) {
  return {
    action: String(action || ''),
    copyOnly: actionIsCopyOnly(action),
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
  proposalsDir = path.join(workspaceRoot, '.atelier-proposals'),
  workspaceId = null,
} = {}) {
  const workspaceRootReal = fs.realpathSync(workspaceRoot)
  ensurePrivateDir(proposalsDir)

  function proposalPath(id) {
    const clean = String(id || '').replace(/[^a-z0-9-]/gi, '')
    if (!clean) throw new Error('proposal id is required')
    const file = path.join(proposalsDir, `${clean}.json`)
    const candidateDir = fs.realpathSync(proposalsDir)
    if (!pathContainedBy(workspaceRootReal, candidateDir)) {
      throw new Error('proposal directory escapes workspace')
    }
    return file
  }

  function readProposal(id) {
    const file = proposalPath(id)
    if (!fs.existsSync(file)) return null
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  }

  function listProposals() {
    if (!fs.existsSync(proposalsDir)) return []
    return fs.readdirSync(proposalsDir)
      .filter((name) => name.endsWith('.json'))
      .sort(stableCompare)
      .map((name) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(proposalsDir, name), 'utf8'))
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .sort((left, right) => stableCompare(right.proposal?.updatedAt || '', left.proposal?.updatedAt || ''))
  }

  function createProposal(body = {}) {
    const action = cleanIdentity(body.action || body.proposal?.action || 'copy.repoPath', 120)
    if (!actionIsCopyOnly(action)) {
      return {
        ok: false,
        status: 409,
        error: 'direct-write proposal action refused',
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
      },
      diff: safeJsonText(body.diff || body.proposal?.diff || ''),
      payload: body.proposal && typeof body.proposal === 'object' ? body.proposal : {},
    }
    secureWriteJson(proposalPath(id), record)
    return { ok: true, status: 200, record }
  }

  function reviewProposal(id, body = {}) {
    const record = readProposal(id)
    if (!record) {
      return { ok: false, status: 404, error: 'proposal not found' }
    }
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
    record.proposal = {
      ...record.proposal,
      status: nextStatus,
      updatedAt,
      review: {
        reviewer: cleanIdentity(body.reviewer || 'unknown reviewer', 160),
        notes: cleanIdentity(body.notes, 2000),
        reviewedAt: updatedAt,
      },
    }
    if (nextStatus === 'accepted') {
      record.copyable = acceptedProposalCopy(record)
    } else {
      delete record.copyable
    }
    secureWriteJson(proposalPath(id), record)
    return { ok: true, status: 200, record }
  }

  return {
    proposalsDir,
    proposalPath,
    readProposal,
    listProposals,
    createProposal,
    reviewProposal,
  }
}
