// Rule-boundary tests for the public Knowledge Health assessor. Every case
// runs the real assessor over a new disposable copy of the shipped example
// fixture; nothing here reimplements a graph or plan rule. The expected
// before/after states come from the shipped expected-summary fixture.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { resolveProjectConfig } from '../src/project/config.mjs'
import {
  PROJECTION_VERSION,
  assessKnowledgeHealth,
  assessKnowledgeHealthExample,
  assessmentDigest,
  initializeKnowledgeHealthExample,
} from '../src/knowledge-health/index.mjs'
import { ruleIdentity } from '../src/knowledge-health/rule-identity.mjs'
import { rehearseInstalledWorkshop } from '../src/knowledge/participatory/installed-workshop.mjs'

const fixtures = fileURLToPath(new URL('../fixtures/knowledge-health/', import.meta.url))
const expected = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected-summary.json'), 'utf8'))
const relationId = 'checklist-pilot'
const questionId = 'readiness'
const warning = `relation ${relationId} has no declared edge in the required direction`

function example(t) {
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'atelier-knowledge-health-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  return initializeKnowledgeHealthExample(path.join(temp, 'example'))
}

// The same inputs the shipped example builds, kept separate so that one field
// at a time can be changed. `range` selects which inline array the declaration
// byte range addresses.
function inputs(root, { range = /^    supports: (\[[^\r\n]*\])$/m, prefix = '    supports: ' } = {}) {
  const project = resolveProjectConfig({ cwd: root, argv: ['--project', path.join(root, 'atelier.project.json')],
    env: {}, writeLocalState: false })
  const records = path.join(root, 'records')
  const currentSourceBytes = fs.readFileSync(path.join(records, 'checklist.md'))
  const match = currentSourceBytes.toString('utf8').match(range)
  assert.ok(match, 'the example declaration must be present')
  const start = currentSourceBytes.indexOf(Buffer.from(match[0])) + Buffer.byteLength(prefix)
  const sourceRevisions = ['checklist.md', 'pilot.md'].map(sourcePath => ({ repo: 'records', path: sourcePath,
    revision: `content-sha256:${assessmentDigest(fs.readFileSync(path.join(records, sourcePath)))}` }))
  const binding = {
    source: { id: 'demo:checklist', repo: 'records', path: 'checklist.md',
      sha256: assessmentDigest(currentSourceBytes), revision: sourceRevisions[0].revision },
    field: { id: 'kg.relations.supports', pointer: '/kg/relations/supports', format: 'markdown-inline-array',
      start, end: start + Buffer.byteLength(match[1]), quote: match[1] },
    authoring: { storeId: 'invented-test-store', sourceId: 'demo:checklist', artifactId: 'invented-checklist',
      fieldId: 'kg.relations.supports', actorBindingId: 'invented-test-owner' },
  }
  return { project, relationId, questionId, sourceRevisions, binding, currentSourceBytes }
}

const graphRun = result => result.retrievalEvaluation.cases.find(c => c.id === questionId).runs.graph
const checkedRelation = result => result.assessment.original.report.relations.find(r => r.id === relationId)

function refused(result, code) {
  assert.equal(result.assessment.refusal?.code, code)
  assert.equal(result.assessment.status, 'uncertain')
  assert.deepEqual(result.assessment.findings, [], 'a refusal exposes no edit target')
  assert.equal(result.assessment.grantsAuthority, false)
}

test('the shipped example reports one required-direction finding bound to exact source bytes', t => {
  const root = example(t)
  const checklist = path.join(root, 'records', 'checklist.md')
  const before = fs.readFileSync(checklist)
  const result = assessKnowledgeHealthExample(root)
  const { assessment } = result

  assert.equal(assessment.projectionVersion, PROJECTION_VERSION)
  assert.equal(assessment.status, expected.before.assessmentStatus)
  assert.equal(assessment.coverage, expected.before.coverage)
  assert.equal(assessment.currency, expected.before.currency)
  assert.equal(assessment.semanticQualification, expected.before.semanticQualification)
  assert.equal(assessment.grantsAuthority, false)
  assert.equal(assessment.refusal, null)
  assert.equal(assessment.findings.length, expected.before.selectedFindings)
  assert.equal(checkedRelation(result).matchingEdges, expected.before.matchingDeclaredEdges)

  // The finding is the checker's own warning, unchanged, with the checker's
  // pinned identity and the exact declaration bytes of the owning source.
  const [finding] = assessment.findings
  assert.equal(finding.referenceKey, `required-direction:${relationId}`)
  assert.equal(finding.originalMessage, warning)
  assert.ok(assessment.original.report.warnings.includes(warning))
  assert.equal(finding.check.version, ruleIdentity.commit)
  assert.equal(finding.check.sourceTree, ruleIdentity.tree)
  assert.equal(finding.source.sha256, assessmentDigest(before))
  assert.equal(finding.source.revision, `content-sha256:${assessmentDigest(before)}`)
  assert.equal(finding.declaration.quote, '[]')
  assert.equal(before.subarray(finding.declaration.start, finding.declaration.end).toString('utf8'), '[]')
  assert.equal(finding.actionable, true)
  assert.deepEqual(finding.action, { kind: 'review-source-declaration', sourceMutation: false, canonicalAcceptance: false })
  assert.ok(finding.uncertainty.includes('semantic-support-unassessed'))

  // The read set names both sources with their digests and owner revisions.
  assert.deepEqual(assessment.evidence.readSet.entries.map(e => e.path), ['checklist.md', 'pilot.md'])
  assert.equal(assessment.evidence.planSha256,
    assessmentDigest(fs.readFileSync(path.join(root, 'knowledge-plan.json'))))

  // Frozen expected evidence is current before any correction, and the
  // assessment wrote nothing.
  assert.deepEqual(graphRun(result).stale, [])
  assert.deepEqual(fs.readFileSync(checklist), before)

  // The test's own input builder binds the same read set as the shipped example.
  const rebuilt = assessKnowledgeHealth(inputs(root))
  assert.equal(rebuilt.assessment.evidence.readSetSha256, assessment.evidence.readSetSha256)
  assert.equal(rebuilt.assessment.findings.length, 1)
})

test('an owner correction clears the finding while frozen expected evidence stays stale', t => {
  const root = example(t)
  const planFile = path.join(root, 'knowledge-plan.json')
  const planBefore = fs.readFileSync(planFile)
  const first = assessKnowledgeHealthExample(root)
  fs.copyFileSync(path.join(fixtures, 'corrected', 'checklist.md'), path.join(root, 'records', 'checklist.md'))
  const result = assessKnowledgeHealthExample(root)
  const { assessment } = result

  assert.equal(assessment.status, expected.after.assessmentStatus)
  assert.equal(assessment.coverage, expected.after.coverage)
  assert.equal(assessment.currency, expected.after.currency)
  assert.equal(assessment.semanticQualification, expected.after.semanticQualification)
  assert.equal(assessment.findings.length, expected.after.selectedFindings)
  assert.equal(checkedRelation(result).matchingEdges, expected.after.matchingDeclaredEdges)
  assert.equal(assessment.refusal, null)
  assert.equal(assessment.grantsAuthority, false)

  // The current structural result and the retained baseline are separate
  // facts: the evaluation still reports the edited source as stale, and the
  // plan's expected pins were not rewritten to match the edit.
  assert.deepEqual(graphRun(result).stale, expected.afterFrozenExpectedEvidenceStale)
  assert.notEqual(graphRun(result).status, 'expected-evidence-present')
  assert.deepEqual(fs.readFileSync(planFile), planBefore)
  assert.equal(assessment.evidence.planSha256, first.assessment.evidence.planSha256)
  assert.notEqual(assessment.evidence.readSetSha256, first.assessment.evidence.readSetSha256)
  assert.equal(assessment.evidence.evaluationSha256, undefined)

  // The qualification in the source text survives the structural correction.
  assert.ok(fs.readFileSync(path.join(root, 'records', 'checklist.md'), 'utf8')
    .includes(expected.currentSourceQualificationRetained))
})

test('missing, blank and duplicate source revisions are refused', t => {
  const root = example(t)
  const base = inputs(root)
  const [checklist, pilot] = base.sourceRevisions

  assert.throws(() => assessKnowledgeHealth({ ...base, sourceRevisions: [checklist] }),
    { name: 'TypeError', message: /Missing exact source revision/ })
  assert.throws(() => assessKnowledgeHealth({ ...base, sourceRevisions: [checklist, { ...pilot, revision: '   ' }] }),
    { name: 'TypeError', message: /Missing exact source revision/ })
  assert.throws(() => assessKnowledgeHealth({ ...base, sourceRevisions: [checklist, pilot, { ...pilot }] }),
    { name: 'TypeError', message: /Duplicate source revision/ })
  assert.throws(() => assessKnowledgeHealth({ ...base, sourceRevisions: undefined }),
    { name: 'TypeError', message: /source revisions required/ })
})

test('a binding that does not match the read set or the declaration is refused without a finding', t => {
  const root = example(t)
  const base = inputs(root)
  const withBinding = change => {
    const binding = structuredClone(base.binding)
    change(binding)
    return assessKnowledgeHealth({ ...base, binding })
  }

  // A content digest alone does not stand in for the owner's revision.
  const otherRevision = withBinding(b => { b.source.revision = `content-sha256:${'0'.repeat(64)}` })
  refused(otherRevision, 'binding-stale')
  assert.equal(otherRevision.assessment.currency, 'changed')

  // Bytes that differ from the bound source are stale even when the file is unchanged.
  const corrected = fs.readFileSync(path.join(fixtures, 'corrected', 'checklist.md'))
  const otherBytes = assessKnowledgeHealth({ ...base, currentSourceBytes: corrected })
  refused(otherBytes, 'binding-stale')

  refused(assessKnowledgeHealth({ ...base, binding: null }), 'binding-missing')
  refused(withBinding(b => { b.field.quote = '["demo:pilot"]' }), 'binding-quote-mismatch')
  refused(withBinding(b => { b.field.format = 'markdown-block-array' }), 'unsupported-declaration-profile')
  refused(withBinding(b => { b.authoring.sourceId = 'demo:pilot' }), 'authoring-binding-mismatch')

  // A byte range that quotes another inline array exactly is still not the
  // selected typed declaration.
  const tags = inputs(root, { range: /^tags: (\[[^\r\n]*\])$/m, prefix: 'tags: ' })
  assert.equal(tags.binding.field.quote, '["concept:checklist"]')
  refused(assessKnowledgeHealth(tags), 'binding-not-declaration')

  // The selected relation must be one the selected question requires.
  assert.throws(() => assessKnowledgeHealth({ ...base, relationId: 'not-declared' }),
    { name: 'TypeError', message: /task-required declared relation/ })
  assert.throws(() => assessKnowledgeHealth({ ...base, questionId: 'unknown' }),
    { name: 'TypeError', message: /task-required declared relation/ })
})

test('a stale resolved project and a scope that changes during the read are refused', t => {
  const root = example(t)
  const base = inputs(root)
  const configFile = path.join(root, 'atelier.project.json')
  const config = fs.readFileSync(configFile)

  fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(config), name: 'renamed-after-resolution' }, null, 2))
  assert.throws(() => assessKnowledgeHealth(base), { name: 'TypeError', message: /Resolved project config is stale/ })
  fs.writeFileSync(configFile, config)
  assert.equal(assessKnowledgeHealth(base).assessment.findings.length, 1)

  // Stand in for a concurrent writer: the access file changes after the
  // assessor has pinned its scope and before it finishes. The caller-supplied
  // revision entry is read between those two points.
  let changed = false
  const [checklist, pilot] = base.sourceRevisions
  const duringRead = { path: checklist.path, revision: checklist.revision,
    get repo() {
      if (!changed) { changed = true; fs.appendFileSync(base.project.repoAccessPath, '\n') }
      return checklist.repo
    } }
  assert.throws(() => assessKnowledgeHealth({ ...base, sourceRevisions: [duringRead, pilot] }),
    { message: /Assessment scope changed during read/ })
  assert.equal(changed, true)
})

test('plan bytes are bounded, decoded strictly and read only from a regular file', t => {
  const root = example(t)
  const base = inputs(root)
  const planFile = path.join(root, 'knowledge-plan.json')
  const plan = fs.readFileSync(planFile)
  const ceiling = 65536

  // Exactly at the ceiling is accepted and pinned as the bytes that were read.
  const atCeiling = Buffer.concat([plan, Buffer.alloc(ceiling - plan.length, 0x20)])
  fs.writeFileSync(planFile, atCeiling)
  const accepted = assessKnowledgeHealth(base)
  assert.equal(accepted.assessment.evidence.planSha256, assessmentDigest(atCeiling))
  assert.equal(accepted.assessment.findings.length, 1)

  fs.writeFileSync(planFile, Buffer.concat([atCeiling, Buffer.from(' ')]))
  assert.throws(() => assessKnowledgeHealth(base), { message: /exceeds byte ceiling/ })

  fs.writeFileSync(planFile, Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]))
  assert.throws(() => assessKnowledgeHealth(base), { name: 'TypeError', code: 'ERR_ENCODING_INVALID_ENCODED_DATA' })

  fs.rmSync(planFile)
  fs.mkdirSync(planFile)
  assert.throws(() => assessKnowledgeHealth(base), { message: /not a regular file/ })
  fs.rmdirSync(planFile)

  if (process.platform !== 'win32') {
    const elsewhere = path.join(root, 'plan-elsewhere.json')
    fs.writeFileSync(elsewhere, plan)
    fs.symlinkSync(elsewhere, planFile)
    assert.throws(() => assessKnowledgeHealth(base), { message: /not a regular file/ })
    fs.rmSync(planFile)
  }

  fs.writeFileSync(planFile, plan)
  assert.equal(assessKnowledgeHealth(base).assessment.evidence.planSha256, assessmentDigest(plan))
})

test('context, suggestions and repository evidence stay projections bound to the assessment', t => {
  const root = example(t)
  const base = inputs(root)
  const first = assessKnowledgeHealth(base)
  const { evidence } = first.assessment

  assert.equal(first.context.schema, 'atelier-knowledge-health-context@v0')
  assert.equal(first.context.projection, 'existing-output-view')
  assert.equal(first.context.grantsAuthority, false)
  assert.deepEqual(first.context.assessment, first.assessment)
  assert.equal(first.context.reproducibility.planSha256, evidence.planSha256)
  assert.equal(first.context.reproducibility.readSetSha256, evidence.readSetSha256)
  assert.equal(first.context.semantic.providerCalls, 0)
  assert.equal(first.context.semantic.humanAcceptance, 'unobserved')
  assert.deepEqual(first.context.agentSuggestions, [])
  assert.equal(first.context.repository.state, 'unobserved')

  // The context byte budget is the native one: within the plan budget only.
  const bounded = assessKnowledgeHealth({ ...base, maxContextBytes: 8192 })
  assert.equal(bounded.context.coverage.budget.maxBytes, 8192)
  assert.throws(() => assessKnowledgeHealth({ ...base, maxContextBytes: 8191 }), { message: /max-bytes must be between/ })
  assert.throws(() => assessKnowledgeHealth({ ...base, maxContextBytes: 32769 }), { message: /max-bytes must be between/ })

  const sources = first.assessment.original.context.sources
  assert.ok(sources.length > 0, 'the example context selects at least one source')
  const suggestion = {
    text: 'Invented suggestion: review the checklist declaration with its owner.',
    citations: [{ id: sources[0].id, sha256: sources[0].sha256 }],
    provenance: { actorId: 'invented-agent', method: 'invented-method', version: '1', recordId: 'invented-record-1',
      planSha256: evidence.planSha256, readSetSha256: evidence.readSetSha256 },
  }
  const repositoryEvidence = { note: 'Invented caller note.' }
  const second = assessKnowledgeHealth({ ...base, agentSuggestions: [suggestion], repositoryEvidence })

  // A supplied suggestion is carried as unreviewed caller text. It changes
  // neither the assessment nor any authority.
  assert.deepEqual(second.assessment, first.assessment)
  assert.deepEqual(second.context.agentSuggestions, [{ text: suggestion.text, citations: suggestion.citations,
    provenance: suggestion.provenance, status: 'caller-supplied-unreviewed', semanticSupport: 'unknown',
    grantsAuthority: false }])
  assert.equal(second.context.repository.state, 'caller-supplied-unverified')
  assert.deepEqual(second.context.repository.evidence, repositoryEvidence)
  for (const key of ['declared', 'adopted', 'consumed', 'executed']) {
    assert.equal(second.context.repository[key], 'unobserved')
  }

  const withSuggestion = change => {
    const altered = structuredClone(suggestion)
    change(altered)
    return () => assessKnowledgeHealth({ ...base, agentSuggestions: [altered] })
  }
  assert.throws(withSuggestion(s => { s.citations[0].sha256 = 'f'.repeat(64) }),
    { name: 'TypeError', message: /citation is absent or stale/ })
  assert.throws(withSuggestion(s => { s.citations[0].id = 'demo:not-selected' }),
    { name: 'TypeError', message: /citation is absent or stale/ })
  assert.throws(withSuggestion(s => { s.provenance.planSha256 = '0'.repeat(64) }),
    { name: 'TypeError', message: /provenance must bind this assessment/ })
  assert.throws(withSuggestion(s => { s.provenance.readSetSha256 = '0'.repeat(64) }),
    { name: 'TypeError', message: /provenance must bind this assessment/ })
  assert.throws(withSuggestion(s => { s.citations = [] }),
    { name: 'TypeError', message: /Bounded suggestion and citations required/ })
  assert.throws(() => assessKnowledgeHealth({ ...base, agentSuggestions: Array.from({ length: 21 }, () => suggestion) }),
    { name: 'TypeError', message: /At most 20 supplied suggestions/ })
})


test('installed workshop revision preserves containment under a linked ancestor', async t => {
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'atelier-knowledge-health-linked-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const owned = path.join(temp, 'owned')
  const alias = path.join(temp, 'alias')
  fs.mkdirSync(owned)
  fs.symlinkSync(owned, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const destination = path.join(alias, 'workshop')

  const result = await rehearseInstalledWorkshop(destination, { outcome: 'revision' })
  assert.notEqual(fs.realpathSync(destination), destination, 'the test must reach the real linked-ancestor path')
  assert.equal(fs.realpathSync(path.join(destination, 'records')),
    path.join(fs.realpathSync(destination), 'records'))
  assert.equal(result.outcome, 'revision')
  assert.equal(result.ownerCorrection, true)
  assert.deepEqual(result.beforeGraph, { ok: true, nodes: 2, edges: 0 })
  assert.equal(result.afterGraph.ok, true)
  assert.equal(result.afterGraph.nodes, 2)
  assert.ok(result.afterGraph.edges > 0)
  assert.match(fs.readFileSync(path.join(destination, 'records/checklist.md'), 'utf8'),
    /supports: \["devday:workshop"\]/)
  assert.equal(result.reopenedSame, true)
  assert.equal(result.pauseRecoveryPreserved, true)
  assert.equal(result.unconfirmedInterpretationSaveRefused, true)
  assert.equal(result.duplicateSaveNoAdditionalEffect, true)
  assert.equal(result.sourceDriftWriteRefused, true)
  assert.equal(result.baselinePlanPreserved, true)
  assert.equal(result.fullKnowledgeHealthJourneyQualified, false)
  assert.equal(result.humanAcceptance, false)
})
