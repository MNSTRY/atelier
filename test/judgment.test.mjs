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
