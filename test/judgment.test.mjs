import { harnessDigest } from '../src/harnesses/contracts.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { inspectPracticalCase, validateJudgment, importArchitectureDecision, renderArchitectureDecision, prepareJudgmentContribution, createJudgmentDependency } from '../src/judgment/index.mjs'
const fixture = (name, status = 'valid') => JSON.parse(fs.readFileSync(new URL(`../fixtures/atelier-judgment/${name}/${status}/document.json`, import.meta.url)))
const sourceText = fs.readFileSync(new URL('../fixtures/atelier-judgment/native-decision.md', import.meta.url), 'utf8')
test('prospective judgment retains ends, contrasting cases and dissent without requiring a rule or decision', () => {
  const value = fixture('case'), result = inspectPracticalCase(value)
  assert.equal(result.disposition, 'open'); assert.equal(result.ruleRequired, false)
  assert.equal(result.unresolvedDissent.length, 1)
  assert.equal(result.case.cultivation.length, 1)
  value.disposition = { ...value.disposition, status: 'chosen', choice: 'missing' }
  assert.match(validateJudgment(value).join(), /alternative/)
  assert.ok(validateJudgment(fixture('case', 'invalid')).length)
})
test('ADR import retains native identity and separate decision, implementation and evidence states', () => {
  const decision = fixture('decision'), imported = importArchitectureDecision({ decision, sourceText })
  assert.equal(imported.authorityTransferred, false)
  assert.equal(imported.interpretationVerified, false)
  assert.match(renderArchitectureDecision(decision), /Decision: accepted\nImplementation: planned\nEvidence: unknown/)
  assert.throws(() => importArchitectureDecision({ decision, sourceText: sourceText + 'Changed' }), /source bytes/)
  decision.implementation.status = 'verified'
  assert.match(validateJudgment(decision, 'decision').join(), /receipt/)
  assert.ok(validateJudgment(fixture('decision', 'invalid'), 'decision').length)
})
test('typed judgment enters existing Knowledge review; an unreviewed case cannot become a Build dependency', () => {
  const fixtureRecords = JSON.parse(fs.readFileSync(new URL('../fixtures/harnesses/learning-cycle.json', import.meta.url))).knowledge
  const records = [fixtureRecords[0]]
  const prepared = prepareJudgmentContribution({ records, value: fixture('case'), profile: 'case', title: 'Opening judgment', term: 'material', rightsBasis: 'Invented fixture.' })
  const contribution = { ...fixtureRecords[1], data: prepared.data }
  records.push(contribution)
  assert.equal(prepared.semanticAcceptance, 'pending')
  assert.throws(() => createJudgmentDependency({ records, subjectId: contribution.id, target: { repository: 'sample-build', profile: 'build' } }), /accepted contribution/)
})
test('accepted native ADR crosses the existing Knowledge handoff with exact source bytes and independent implementation status', () => {
  const template = JSON.parse(fs.readFileSync(new URL('../fixtures/harnesses/learning-cycle.json', import.meta.url))).knowledge
  const records = [template[0]], decision = fixture('decision')
  const prepared = prepareJudgmentContribution({ records, value: decision, profile: 'decision', sourceText, title: decision.title, term: 'material', rightsBasis: 'Invented fixture.' })
  const contribution = { ...template[1], data: prepared.data }; records.push(contribution)
  const pin = value => ({ id: value.id, digest: harnessDigest(value) })
  const evaluation = { ...template.find(r => r.kind === 'evaluation'), data: { ...template.find(r => r.kind === 'evaluation').data, contribution: pin(contribution) } }; records.push(evaluation)
  const review = { ...template.find(r => r.kind === 'review'), data: { target: pin(contribution), disposition: 'accepted', basis: 'Retain the native choice and its stated limits.', evaluations: [pin(evaluation)] } }; records.push(review)
  const options = { records, subjectId: contribution.id, nativeSourceText: sourceText, target: { repository: 'sample-build', profile: 'build', purpose: 'Implement the accepted decision.' } }
  const handoff = createJudgmentDependency(options)
  assert.equal(handoff.nativeAuthorityTransferred, false)
  assert.match(handoff.handoff.payload, /planned/)
  assert.throws(() => createJudgmentDependency({ ...options, nativeSourceText: sourceText + 'Changed' }), /source bytes/)
})
