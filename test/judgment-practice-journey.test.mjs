import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { createIngestionStore } from '../src/ingestion/store.mjs'
import { createLocalEvidenceReader } from '../src/evidence-navigation/local.mjs'
import { contentDigest, harnessRef, EMPTY_HARNESS_HEAD } from '../src/harnesses/contracts.mjs'
import { appendHarness, readHarness } from '../src/harnesses/store.mjs'
import { inspectKnowledge } from '../src/knowledge/ledger.mjs'
import { decisionRequestDigest } from '../src/decisions/contracts.mjs'
import { evaluateDecisionPractice } from '../src/judgment/practice-evaluation.mjs'

const read = file => JSON.parse(fs.readFileSync(new URL(file, import.meta.url)))
test('invented changed source requires reconsideration and exact retrieval prepares a separate unaccepted draft', t => {
  const value = read('../fixtures/atelier-judgment/practice-reconsideration/scenario.json')
  const templates = read('../fixtures/harnesses/learning-cycle.json').knowledge
  const original = value.instance.evidence[0].text
  const changed = `${original} A new note says the bracket material needs another inspection.`
  const targetTemplate = value.records.find(record => record.id === 'repair-decision')
  value.records = value.records.slice(0, 5)
  const appendAccepted = (id, data) => {
    const contribution = { ...structuredClone(templates[1]), id, data }; value.records.push(contribution)
    const evaluationTemplate = templates.find(record => record.kind === 'evaluation')
    const evaluation = { ...structuredClone(evaluationTemplate), id: `${id}-evaluation`, data: { ...evaluationTemplate.data, contribution: harnessRef(contribution) } }; value.records.push(evaluation)
    const review = { ...structuredClone(templates.find(record => record.kind === 'review')), id: `${id}-review`, data: { target: harnessRef(contribution), disposition: 'accepted', basis: 'Invented simulated review.', evaluations: [harnessRef(evaluation)] } }; value.records.push(review)
    const activation = structuredClone(templates.find(record => record.kind === 'activation'))
    value.records.push({ ...activation, id: `${id}-activation`, data: { ...activation.data, reviews: [harnessRef(review)] } })
    return contribution
  }
  const sourceData = { ...structuredClone(targetTemplate.data), category: 'source', title: 'Invented source note', body: original,
    origin: { method: 'captured', locator: 'reading-room:source-note', contentDigest: contentDigest(original), rightsBasis: 'Invented conformance material.' } }
  const source = appendAccepted('source-note', sourceData)
  const decision = appendAccepted('repair-decision', { ...targetTemplate.data, basedOn: [{ contribution: harnessRef(source), quote: original }] })
  assert.equal(inspectKnowledge(value.records).accepted.includes(decision.id), true)

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-decision-practice-')))
  t.after(() => fs.rmSync(root, { force: true, recursive: true }))
  execFileSync('git', ['init', '-q', root]); fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n')
  fs.writeFileSync(path.join(root, 'source-note.md'), original)
  fs.writeFileSync(path.join(root, 'decision.md'), decision.data.body)
  const options = { workspaceRoot: root, workspaceId: 'invented-reading-room' }
  const store = createIngestionStore(options)
  const planInput = { sources: [{ id: 'source-note', ref: 'source-note.md' }, { id: 'decision', ref: 'decision.md' }],
    scope: { project: 'reading-room', activity: 'reconsideration' }, purpose: 'Read invented reconsideration evidence.',
    budget: { maxInputBytes: 65536, maxOutputBytes: 65536, maxAttempts: 2 } }
  const admit = () => ({ disposition: 'permit', revision: 'fixture-host-admission', readScope: 'all-plan' })
  const beforePlan = store.plan(planInput); store.run({ planId: beforePlan.planId, planDigest: beforePlan.planDigest })
  const beforeReader = createLocalEvidenceReader({ ...options, plan: { planId: beforePlan.planId, planDigest: beforePlan.planDigest }, admit })
  t.after(() => beforeReader.close())
  const old = beforeReader.search({ query: 'bracket', limit: 1 }); assert.equal(old.status, 'ok')
  fs.writeFileSync(path.join(root, 'source-note.md'), changed)
  assert.equal(beforeReader.get({ handle: old.items[0].handle }).status, 'refused')
  value.records.push({ ...source, id: 'source-note-revised', data: { ...sourceData, body: changed,
    origin: { ...sourceData.origin, contentDigest: contentDigest(changed) }, supersedes: harnessRef(source), revisionReason: 'Invented changed source.' } })
  const state = inspectKnowledge(value.records)
  assert.equal(state.reconsider.some(item => item.id === decision.id), true)
  assert.equal(state.accepted.includes(decision.id), false)

  const currentPlan = store.plan(planInput); store.run({ planId: currentPlan.planId, planDigest: currentPlan.planDigest })
  const reader = createLocalEvidenceReader({ ...options, plan: { planId: currentPlan.planId, planDigest: currentPlan.planDigest }, admit })
  t.after(() => reader.close())
  const queries = ['another inspection', 'repair decision']
  for (let index = 0; index < queries.length; index++) {
    const hit = reader.search({ query: queries[index], limit: 1 }); assert.equal(hit.status, 'ok')
    const exact = reader.get({ handle: hit.items[0].handle }); assert.equal(exact.status, 'ok'); assert.equal(exact.item.truncated, false)
    value.instance.evidence[index].text = exact.item.text
    value.instance.evidence[index].reference.revision = index === 0 ? 'two' : 'one'
    value.instance.evidence[index].reference.contentDigest = contentDigest(exact.item.text)
  }
  value.instance.snapshots = value.instance.evidence.map(item => ({ schema: 'atelier-evidence-snapshot@v1', reference: structuredClone(item.reference), currency: 'current', dependencies: [], validUntil: null }))
  value.instance.request.state = value.instance.evidence.map(item => `${item.requestId}: ${item.text}`).join('\n')
  value.instance.result.requestDigest = decisionRequestDigest(value.instance.request)
  value.instance.proposal.target = harnessRef(decision)
  const historyBefore = JSON.stringify(value.records), result = evaluateDecisionPractice(value)
  assert.equal(result.status, 'proceed'); assert.equal(JSON.stringify(value.records), historyBefore)
  assert.equal(result.proposal.semanticAcceptance, 'pending'); assert.equal(result.executionAuthorized, false)
  const payload = JSON.parse(result.proposal.data.body)
  assert.deepEqual(payload.target, harnessRef(decision))
  assert.equal(payload.evidence[0].reference.contentDigest, contentDigest(changed))
  // Windows completes the same portable journey but the existing store refuses
  // writes there. Verify that boundary without skipping retrieval/evaluation.
  if (process.platform === 'win32') {
    assert.throws(() => appendHarness({ workspaceRoot: root, profile: 'knowledge',
      record: value.records[0], confirm: EMPTY_HARNESS_HEAD }), /qualified POSIX filesystem/)
    assert.equal(fs.existsSync(path.join(root, '.atelier-local', 'harnesses')), false)
    assert.deepEqual(readHarness({ workspaceRoot: root, profile: 'knowledge',
      run: value.records[0].run }).records, [])
    return
  }
  // This simulated host explicitly appends a draft. Pure evaluation did not.
  let head
  for (const record of value.records) head = appendHarness({ workspaceRoot: root, profile: 'knowledge', record, confirm: head ?? EMPTY_HARNESS_HEAD }).head
  const draft = { ...templates[1], id: 'reconsideration-draft', data: result.proposal.data }
  appendHarness({ workspaceRoot: root, profile: 'knowledge', record: draft, confirm: head })
  const received = readHarness({ workspaceRoot: root, profile: 'knowledge', run: value.records[0].run })
  assert.equal(received.records.at(-1).id, draft.id)
  assert.equal(received.accepted.includes(draft.id), false)
  assert.equal(received.reconsider.some(item => item.id === decision.id), true)
})
