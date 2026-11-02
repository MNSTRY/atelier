import { createHash } from 'node:crypto'
import { canonicalize } from '../src/attestation/jcs.mjs'

export const ref = (repoId, localId = 'note') => ({ repoId, localId })
export const source = (repoId, digest = 'bytes-1') => ({ repoId, path: 'notes/note.md', revision: 'revision-1', digest })
export const binding = key => ({ key: key ?? 'reader-scope-1', expiresAtMs: Date.now() + 60_000 })
export function seal(view) {
  const payload = structuredClone(view)
  delete payload.projectionDigest
  return { ...payload, projectionDigest: createHash('sha256').update(canonicalize(payload)).digest('hex') }
}
export function view(revision = 1) {
  return seal({
    schema: 'atelier.graph-view@v1', producerVersion: 'fixture',
    sourceSnapshot: { revision },
    accessContext: { proofRef: 'fixture-proof', authorizedRepoIds: ['repo-a', 'repo-b'], grantRevision: 'grant-1', policyRevision: 'policy-1', expiresAt: '2099-01-01T00:00:00Z', filter: {} },
    nodes: [
      { ref: ref('repo-a'), title: 'Shared title', sourceRef: source('repo-a', `bytes-${revision}`) },
      { ref: ref('repo-b'), title: 'Shared title', sourceRef: source('repo-b') },
      { ref: ref('repo-a', 'decision'), title: 'Decision', sourceRef: { ...source('repo-a'), path: 'notes/decision.md' } },
    ],
    edges: [
      { edgeId: 'edge-a-b', source: ref('repo-a'), target: ref('repo-b'), predicate: 'supports', family: 'reviewed', acceptanceState: 'active', supportRefs: ['evidence-a'] },
      { edgeId: 'edge-b-c', source: ref('repo-b'), target: ref('repo-a', 'decision'), predicate: 'related', family: 'ordinary-link', acceptanceState: 'active', supportRefs: [] },
    ],
    evidence: [{ evidenceId: 'evidence-a', sourceRef: source('repo-a', `bytes-${revision}`), verification: 'verified' }],
    questions: [{ questionId: 'question-1', nodeRefs: [ref('repo-a', 'decision')], evidenceRefs: [] }],
    diagnostics: [], capabilities: {},
  })
}
export function validate(value) { return value?.schema === 'atelier.graph-view@v1' && seal(value).projectionDigest === value.projectionDigest }
export function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
