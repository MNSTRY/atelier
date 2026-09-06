import path from 'node:path'
import { validReviewArtifact } from './review-contracts.mjs'
import { createCollaborationEventLedger } from './event-ledger.mjs'
import {
  loadBoundRun,
  currentRunEligibility,
  hashEvidence,
  readBoundedSource,
} from '../readiness-protocols/evidence.mjs'
import { buildGraph } from '../graph/graph.mjs'
import { readRegularTextNoFollow } from '../project/private-state.mjs'

const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,159}$/
const text = (value, max) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max
const invalid = (error, status = 400) => ({ ok: false, status, error })

export const contributionKey = (input) =>
  hashEvidence({
    kind: input.kind,
    targetId: input.targetId,
    runId: input.runId ?? null,
    repo: input.repo ?? null,
    path: input.path ?? null,
    reader: input.kind === 'position' ? input.reviewer : null,
  })
export function validContribution(record) {
  return (
    validReviewArtifact('record', record) &&
    record.inputDigest === hashEvidence(record.input) &&
    record.key === contributionKey(record.input) &&
    record.version === record.input.expectedVersion + 1 &&
    record.identity.name === record.input.reviewer
  )
}

export function createReviewStore(project) {
  const ledger = createCollaborationEventLedger({
    workspaceRoot: project.configDir,
    ledgerPath: path.join(
      project.configDir,
      '.atelier-local/review/contributions.ndjson',
    ),
  })
  function records() {
    const all = ledger.readAll()
    if (!all.ok) return all
    const result = all.events.map((event) => event.payload)
    const versions = new Map(),
      requests = new Set()
    for (let index = 0; index < result.length; index++) {
      const record = result[index],
        event = all.events[index]
      if (
        !validContribution(record) ||
        requests.has(record.input.requestId) ||
        event.aggregateId !== `contribution:${record.input.requestId}` ||
        event.type !== 'contribution-recorded' ||
        event.actor !== record.input.reviewer ||
        record.version !== (versions.get(record.key) ?? 0) + 1
      )
        return invalid('contribution history is invalid', 422)
      requests.add(record.input.requestId)
      versions.set(record.key, record.version)
    }
    return { ok: true, status: 200, records: result }
  }
  function contribution(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      return invalid('contribution must be an object')
    const keys = [
      'requestId',
      'kind',
      'targetId',
      'expectedVersion',
      'reviewer',
      'rationale',
      'runId',
      'evidenceDigest',
      'decision',
      'revision',
      'repo',
      'path',
      'documentDigest',
      'anchor',
      'responseType',
      'wording',
      'position',
      'ext',
    ]
    if (Object.keys(input).some((key) => !keys.includes(key)))
      return invalid('unknown contribution field')
    if (
      !idPattern.test(input.requestId ?? '') ||
      !idPattern.test(input.targetId ?? '') ||
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 0 ||
      !text(input.reviewer, 160) ||
      input.reviewer !== input.reviewer.trim()
    )
      return invalid(
        'request identity, expected version and reviewer are required',
      )
    if (!['decision', 'response', 'position'].includes(input.kind))
      return invalid('unsupported contribution kind')
    if (
      input.kind === 'decision' &&
      (!['accepted', 'rejected', 'revised'].includes(input.decision) ||
        !text(input.rationale, 8000) ||
        !text(input.runId, 160) ||
        !/^sha256:[a-f0-9]{64}$/.test(input.evidenceDigest ?? '') ||
        (input.decision === 'revised' && !text(input.revision, 8000)))
    )
      return invalid('decision, rationale and evidence identity are required')
    if (
      input.kind !== 'decision' &&
      (!text(input.repo, 160) ||
        !text(input.path, 2048) ||
        !/^sha256:[a-f0-9]{64}$/.test(input.documentDigest ?? '') ||
        !text(input.anchor, 8000))
    )
      return invalid('document identity and passage anchor are required')
    if (
      input.kind === 'response' &&
      (!['question', 'correction', 'discussion'].includes(input.responseType) ||
        !text(input.wording, 16000))
    )
      return invalid('response type and original wording are required')
    if (
      input.kind === 'position' &&
      (!Number.isSafeInteger(input.position) || input.position < 0)
    )
      return invalid('reading position is required')
    if (!validReviewArtifact('input', input))
      return invalid(
        'contribution contract invalid or contains fields for a different kind',
      )
    const inputDigest = hashEvidence(input)
    const history = records()
    if (!history.ok) return history
    const previous = history.records.find(
      (record) => record.input.requestId === input.requestId,
    )
    if (previous)
      return previous.inputDigest === inputDigest
        ? { ok: true, status: 200, record: previous, replayed: true }
        : invalid('request ID reused with different content', 409)
    const key = contributionKey(input)
    const payload = {
      schema: 'atelier-contribution@v1',
      input,
      inputDigest,
      key,
      version: input.expectedVersion + 1,
      identity: { kind: 'local-asserted', name: input.reviewer },
      recordedAt: new Date().toISOString(),
    }
    const appended = ledger.append({
      aggregateId: `contribution:${input.requestId}`,
      expectedVersion: 0,
      type: 'contribution-recorded',
      actor: input.reviewer,
      payload,
      precondition: () => {
        const current = records()
        if (!current.ok) return current
        const count = current.records.filter(
          (record) => record.key === key,
        ).length
        if (count !== input.expectedVersion)
          return invalid('stale contribution version', 409)
        if (input.kind === 'decision') {
          const bound = loadBoundRun(project, input.runId)
          if (!bound.ok) return bound
          if (
            input.decision === 'accepted' &&
            (bound.run.blockers.length ||
              bound.snapshot.claimEvidence[
                bound.run.claims.findIndex(
                  (claim) => claim.claimId === input.targetId,
                )
              ]?.status !== 'linked-source')
          )
            return invalid(
              'required input or mapped source evidence is incomplete; acceptance refused',
              409,
            )
          if (
            bound.snapshot.digest !== input.evidenceDigest ||
            !bound.run.claims.some(
              (claim) => claim.claimId === input.targetId,
            ) ||
            !currentRunEligibility(project, bound)
          )
            return invalid('claim evidence changed or is unavailable', 409)
        } else {
          const source = document(input.repo, input.path)
          if (!source.ok) return source
          if (
            source.digest !== input.documentDigest ||
            !source.text.includes(input.anchor)
          )
            return invalid(
              'document changed or anchor is missing; reassociation required',
              409,
            )
          if (
            input.kind === 'position' &&
            (input.position > source.text.length ||
              !source.text.slice(input.position).startsWith(input.anchor))
          )
            return invalid('position does not match the anchored passage')
        }
        return { ok: true }
      },
    })
    if (!appended.ok) {
      if (appended.status === 409) {
        const latest = records()
        const duplicate =
          latest.ok &&
          latest.records.find(
            (record) => record.input.requestId === input.requestId,
          )
        if (duplicate?.inputDigest === inputDigest)
          return { ok: true, status: 200, record: duplicate, replayed: true }
      }
      return appended
    }
    return { ok: true, status: 200, record: payload, replayed: false }
  }
  function document(repoName, relative) {
    const repo = project.repos.find(
      (entry) => entry.name === repoName && !entry.external,
    )
    if (
      !repo?.path ||
      !/\.(md|txt)$/i.test(relative ?? '') ||
      relative.split(/[\\/]/).some((segment) => segment.startsWith('.'))
    )
      return invalid('document is outside the review surface', 403)
    try {
      if (
        project.configPath &&
        hashEvidence(
          JSON.parse(readRegularTextNoFollow(project.configPath)),
        ) !== hashEvidence(project.config)
      )
        return invalid('project changed; restart review', 409)
      const graph = buildGraph(project)
      if (
        graph.errors.length ||
        !graph.nodes.some(
          (node) => node.repo === repoName && node.path === relative,
        )
      )
        return invalid('document is not in the valid source graph', 403)
      return {
        ok: true,
        status: 200,
        ...readBoundedSource(repo.path, relative),
      }
    } catch {
      return invalid('document unavailable or unsafe', 409)
    }
  }
  function handoff(requestId) {
    const all = records()
    if (!all.ok) return all
    const record = all.records.find(
      (entry) =>
        entry.input.requestId === requestId &&
        entry.input.kind === 'decision' &&
        entry.input.decision === 'accepted',
    )
    if (!record) return invalid('accepted decision unavailable', 404)
    const bound = loadBoundRun(project, record.input.runId)
    if (!bound.ok) return bound
    const latest = all.records
      .filter((entry) => entry.key === record.key)
      .at(-1)
    return {
      ok: true,
      status: 200,
      schema: 'atelier-owner-handoff@v1',
      decision: record,
      claim: bound.run.claims.find(
        (claim) => claim.claimId === record.input.targetId,
      ),
      requiredEvidenceDigest: bound.snapshot.digest,
      current:
        latest.input.requestId === requestId &&
        currentRunEligibility(project, bound),
      supersededBy:
        latest.input.requestId === requestId ? null : latest.input.requestId,
      sourceChangesApplied: false,
      promotion: 'not-established',
      instructions:
        'Source owner must review the intended edit against current source and record application separately.',
    }
  }
  // One immutable event per aggregate means generic compaction retains every
  // contribution. Per-target versions are checked inside the ledger write lock.
  return { records, contribute: contribution, document, handoff }
}
