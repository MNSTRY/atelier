import { createIntakeStore, intakeDigest } from '../intake/store.mjs'
import { bytesAt, workspaceRoot } from '../capabilities/files.mjs'
import { harnessRef, assertAudience } from '../harnesses/contracts.mjs'
import { inspectKnowledge } from './ledger.mjs'
import { verifyHarnessHandoff } from '../harnesses/exchange.mjs'

function domainFor(records) {
  const domain = inspectKnowledge(records).domain
  if (!domain) throw new Error('establish a knowledge domain first')
  return domain
}
// Reads existing verified extractor output; never chooses or invokes an extractor.
export function prepareIntakeContribution({ workspaceRoot: input, records, attemptId, title, term }) {
  const domain = domainFor(records), root = workspaceRoot(input)
  const receipt = createIntakeStore({ workspaceRoot: root }).readCompletion(attemptId)
  const base = `.atelier-local/intake/attempts/${attemptId}`
  const bytes = bytesAt(root, `${base}/attempt.json`), output = bytesAt(root, `${base}/output.txt`)
  if (intakeDigest(bytes) !== receipt.attemptDigest || intakeDigest(output) !== receipt.outputDigest) throw new Error('intake changed during contribution preparation')
  const attempt = JSON.parse(bytes)
  const data = { domain: harnessRef(domain), category: 'source', term, title, body: new TextDecoder('utf-8', { fatal: true }).decode(output), audience: domain.data.audience, scope: domain.data.scope,
    origin: { method: 'extracted', locator: `intake:${attemptId}`, blobDigest: `sha256:${attempt.blobId}`, attemptId,
      attemptDigest: `sha256:${receipt.attemptDigest}`, outputDigest: `sha256:${receipt.outputDigest}`, completionDigest: `sha256:${intakeDigest(JSON.stringify(receipt))}`,
      extractor: { id: attempt.extractorId, version: attempt.extractorVersion, configurationDigest: `sha256:${attempt.configurationDigest}` } }, basedOn: [] }
  return { data, semanticAcceptance: 'pending', authority: 'none' }
}
export function prepareKnowledgeImport({ records, handoff, sourceRecords, title, term, category = 'interpretation', dependencySnapshots = [] }) {
  const domain = domainFor(records)
  verifyHarnessHandoff({ handoff, records: sourceRecords, dependencySnapshots })
  if (handoff.target.repository !== domain.data.repository || handoff.target.profile !== 'knowledge') throw new Error('handoff targets another receiver')
  assertAudience(domain.data.audience, handoff.audience)
  return { data: { domain: harnessRef(domain), category, term, title, body: handoff.payload,
    audience: domain.data.audience, scope: domain.data.scope, origin: { method: 'exchange', handoff }, basedOn: [] }, semanticAcceptance: 'pending', authority: 'none' }
}
