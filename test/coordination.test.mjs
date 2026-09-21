import test from 'node:test'
import assert from 'node:assert/strict'
import { coordinationReference, coordinationView, validateCoordination } from '../src/coordination/index.mjs'
import { learningDigest as digest } from '../src/learning/contracts.mjs'
const pin = `sha256:${'1'.repeat(64)}`, receipt = { ref: 'native:receipt', digest: pin }
const candidate = { commit: 'a'.repeat(40), tree: 'b'.repeat(40), artifactDigest: pin }
const record = (kind, repository, id, body) => ({ schema: 'atelier-coordination-record@v1', kind, repository, id, revision: 1, scope: ['workshop'], observedAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-03T00:00:00Z', source: receipt, body })
const outcome = (repo, id) => record('outcome', repo, id, { owner: 'owner', purpose: 'Deliver a synthetic artifact.', priority: null, candidate, gates: [{ id: 'source', status: 'passed', candidateDigest: digest(candidate), evidence: receipt }], lifecycle: 'active' })
const a = outcome('alpha', 'producer'), b = outcome('beta', 'consumer')
const dep = record('dependency', 'beta', 'needs-artifact', { producer: coordinationReference(a), consumer: { repository: 'beta', id: 'consumer' }, artifactDigest: pin, need: 'Receive the exact source artifact.', receiving: { status: 'accepted', receipt } })
const view = records => coordinationView({ records, at: '2026-01-01T12:00:00Z' })
test('two repositories retain independent source, receiving and gate evidence; missing/stale/changed inputs stay visible', () => {
  const current = view([a, b, dep]); assert.deepEqual(current.dependencies[0].reasons, [])
  assert.equal(current.dependencies[0].nativeReceiptVerified, false); assert.equal(current.completionVerified, false)
  assert.equal(current.outcomes[0].gates[0].candidateCurrent, true)
  assert.ok(view([b, dep]).dependencies[0].reasons.includes('producer-missing-stale-or-changed'))
  assert.ok(view([{ ...a, revision: 2 }, b, dep]).dependencies[0].reasons.includes('producer-missing-stale-or-changed'))
  const expired = coordinationView({ records: [a, b, dep], at: '2026-01-04T00:00:00Z' })
  assert.equal(expired.outcomes[0].freshness, 'stale')
  assert.equal(view([{ ...a, body: { ...a.body, gates: [{ ...a.body.gates[0], candidateDigest: `sha256:${'2'.repeat(64)}` }] } }]).outcomes[0].gates[0].candidateCurrent, false)
})
test('cycles, directive stages, receiver scope and retained successor state remain explicit', () => {
  const back = record('dependency', 'alpha', 'needs-back', { ...dep.body, producer: coordinationReference(b), consumer: { repository: 'alpha', id: 'producer' } })
  assert.ok(view([a, b, dep, back]).dependencies.every(d => d.reasons.includes('dependency-cycle')))
  const directive = record('directive', 'alpha', 'use-artifact', { target: { repository: 'beta', id: 'consumer' }, instruction: 'Inspect the exact artifact.', supersedes: null })
  const sent = record('disposition', 'beta', 'sent-report', { directive: coordinationReference(directive), recipient: directive.body.target, stage: 'sent', evidence: receipt, detail: 'Reported sent.' })
  let projected = view([a, b, directive, sent]).directives[0]
  assert.deepEqual(projected.reports.map(r => r.stage), ['sent']); assert.equal(projected.executionAuthorized, false)
  const wrong = { ...sent, repository: 'another-repository' }
  assert.equal(view([directive, wrong]).directives[0].reports[0].applicable, false)
  const recovery = record('recovery', 'alpha', 'retirement', { prior: coordinationReference(a), successor: { repository: 'beta', id: 'consumer' }, status: 'retained', reason: 'Retain source and continue through the receiver.', evidence: receipt })
  projected = view([a, b, recovery]).recovery[0]
  assert.equal(projected.priorPresent, true); assert.equal(projected.successorPresent, true); assert.equal(projected.executionAuthorized, false)
  assert.ok(validateCoordination({ ...sent, body: { ...sent.body, stage: 'verified', evidence: null } }).length)
  assert.throws(() => view([a, a]), /ambiguous/)
})

test('same-owner supersession withholds an old directive; another repository cannot supersede it', () => {
  const original = record('directive', 'alpha', 'old', { target: { repository: 'beta', id: 'consumer' }, instruction: 'Inspect version one.', supersedes: null })
  const replacement = record('directive', 'alpha', 'new', { ...original.body, instruction: 'Inspect version two.', supersedes: coordinationReference(original) })
  const oldRead = record('disposition', 'beta', 'old-read', { directive: coordinationReference(original), recipient: original.body.target, stage: 'read', evidence: receipt, detail: 'Read before replacement.' })
  const result = view([original, replacement, oldRead]).directives[0]
  assert.equal(result.activeReported, false); assert.equal(result.reports[0].applicable, false)
  assert.equal(result.supersededBy[0].id, 'new')
  assert.equal(view([original, { ...replacement, repository: 'outsider' }]).directives[0].activeReported, true)
})
