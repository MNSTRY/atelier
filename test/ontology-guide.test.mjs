import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { createOntologyGuide } from '../src/knowledge/ontology-guide.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const load = name => import(pathToFileURL(path.join(root, name)))
const { commandProject } = await load('src/project/config.mjs')
const { loadKnowledgeWorkspace, knowledgeQuestionContext, knowledgeDashboard } = await load('src/knowledge/workspace.mjs')
const { validateKnowledgePlan } = await load('src/knowledge/plan.mjs')
const { createKnowledgeSessions } = await load('src/knowledge/sessions.mjs')
const { createProposalStore } = await load('src/collaboration/proposals.mjs')
const guide = createOntologyGuide()

function setup(t, blank = false) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ontology-guide-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const init = spawnSync(process.execPath, [path.join(root, 'bin/atelier.mjs'), 'init', '--template', 'knowledge-workspace', '--target', dir], { encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  assert.equal(spawnSync('git', ['init', '--quiet', dir]).status, 0)
  const file = path.join(dir, 'knowledge-plan.json')
  if (blank) {
    fs.rmSync(path.join(dir, 'records'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'records'))
    const plan = JSON.parse(fs.readFileSync(file, 'utf8'))
    plan.questions = [{ id: 'loan', question: 'What observation should we collect next?', work: 'Decide which observation would resolve the unknown.', concepts: ['equipment'], relations: [], expect: 'abstain', expectedEvidence: [] }]
    fs.writeFileSync(file, JSON.stringify(plan, null, 2) + '\n')
  }
  const project = commandProject({ cwd: dir, argv: [] })
  const workspace = loadKnowledgeWorkspace(project)
  return { dir, file, project, workspace }
}

function draftFor(workspace, blank = false) {
  const question = workspace.plan.questions.find(q => q.id === 'loan')
  const context = knowledgeQuestionContext(workspace, 'loan')
  return {
    snapshot: workspace.snapshot, basePlanSha256: workspace.sha256, entry: blank ? 'blank' : 'corpus', decision: question.work,
    concepts: question.concepts.map(id => ({ id, example: `One observed ${id}`, counterexample: `A similar but separately identified ${id}`, identityBasis: workspace.plan.concepts.find(c => c.id === id).identityRule })),
    relations: question.relations.map(id => ({ id, forward: 'The decision depends on an inspected observation.', reverse: 'The observation is a prerequisite for the decision; it does not establish success.' })),
    evidence: blank ? [] : context.sources.map(s => ({ id: s.id, sha256: s.sha256, start: 1, end: s.lines.end, quote: s.text.replace(/\n$/, '') })),
    answer: { status: blank ? 'abstain' : 'supported', text: blank ? 'There is no observation yet; collect one before deciding.' : 'The inspected sources support withholding the loan until a completed inspection.', certainty: 'qualified', limits: 'Current sources only; human review must judge qualifications and any contradictory observation.' },
    wouldChangeMind: 'A later dated inspection with an explicit completed result; inspect and review it before changing the decision.',
  }
}

const codes = result => result.diagnostics.map(x => x.code)

test('v1 plan, five views and seven prompts preserve current authoring fields', t => {
  const { workspace } = setup(t)
  assert.deepEqual(validateKnowledgePlan(workspace.plan), [])
  assert.deepEqual(knowledgeDashboard(workspace).flows.map(f => f.id), ['onboard', 'model', 'deepen', 'apply', 'learn'])
  const prompts = guide.prompts(workspace, 'loan')
  assert.deepEqual(prompts.map(p => p.id), ['decision', 'concept', 'identity', 'counterexample', 'evidence', 'relation', 'change'])
  assert.deepEqual([...new Set(prompts.map(p => p.field))].sort(), ['concept', 'identity', 'relation', 'test'])
  assert.throws(() => guide.prompts(workspace, 'absent'), /unknown knowledge question/)
})

test('corpus draft retains exact evidence and reviewable v1 plan changes without edits', t => {
  const { file, workspace } = setup(t)
  const before = fs.readFileSync(file, 'utf8')
  const draft = draftFor(workspace)
  draft.proposedPlan = structuredClone(workspace.plan)
  draft.proposedPlan.concepts[0].definition += ' Corrections preserve its stable asset identity.'
  const result = guide.prepareReview(workspace, 'loan', draft, { basePlanText: before })
  assert.equal(result.ok, true)
  assert.equal(result.status, 'proposed')
  assert.equal(result.sourceEditsApplied, false)
  assert.deepEqual(validateKnowledgePlan(JSON.parse(result.body.proposal.proposedText)), [])
  assert.equal(result.body.proposal.beforeText, before)
  assert.deepEqual(result.body.proposal.changes.map(x => x.path), ['/concepts'])
  assert.equal(result.body.proposal.canonicalAdmission, false)
  assert.ok(result.body.proposal.evidence.some(e => e.id === 'loan:inspection' && /not/.test(e.quote)))
  assert.equal(fs.readFileSync(file, 'utf8'), before)
  assert.deepEqual(guide.prepareReview(workspace, 'loan', draft, { basePlanText: before }), result)
})

test('blank workspace reaches an honest draft abstention without invented evidence', t => {
  const { file, workspace } = setup(t, true)
  const draft = draftFor(workspace, true)
  const result = guide.prepareReview(workspace, 'loan', draft, { basePlanText: fs.readFileSync(file, 'utf8') })
  assert.equal(result.ok, true)
  assert.deepEqual(result.body.proposal.evidence, [])
  assert.deepEqual(result.body.proposal.changes, [])
  assert.equal(result.body.proposal.guidance.answer.status, 'abstain')
  assert.equal(guide.inspect(workspace, 'loan', draft).status, 'ready-for-human-review')
  assert.match(guide.prompts(workspace, 'loan', 'blank')[4].hint, /unknown/)
})

test('ambiguous identity and unsupported certainty give specific next actions', t => {
  const { workspace } = setup(t)
  const draft = draftFor(workspace)
  draft.proposedPlan = structuredClone(workspace.plan)
  draft.proposedPlan.concepts[1].identityRule = draft.proposedPlan.concepts[0].identityRule
  draft.concepts[0].counterexample = draft.concepts[0].example
  draft.answer.certainty = 'certain'
  draft.evidence = []
  const result = guide.inspect(workspace, 'loan', draft)
  for (const code of ['ambiguous-identity', 'unsupported-certainty', 'unsupported-answer', 'indistinguishable-example']) assert.ok(codes(result).includes(code), code)
  assert.ok(result.diagnostics.every(d => d.next.length > 20))
  assert.equal(result.status, 'needs-guidance')
})

test('changed bytes, invented passages, unavailable source and missing reverse meaning cannot become review-ready', t => {
  const { workspace } = setup(t)
  const draft = draftFor(workspace)
  draft.snapshot = 'old'
  draft.evidence[0].quote += ' Invented completion.'
  draft.evidence[1].sha256 = '0'.repeat(64)
  draft.evidence.push({ id: 'source-that-was-not-read' })
  draft.relations[0].reverse = ''
  const result = guide.inspect(workspace, 'loan', draft)
  for (const code of ['changed-source', 'changed-passage', 'stale-evidence', 'unavailable-or-ambiguous-source', 'directed-meaning-required']) assert.ok(codes(result).includes(code), code)
  assert.equal(guide.prepareReview(workspace, 'loan', draft, { basePlanText: 'unused' }).ok, false)
})

test('closed v1 schema rejects aliases inside the plan; draft metadata remains separate', t => {
  const { workspace } = setup(t)
  const draft = draftFor(workspace)
  draft.proposedPlan = structuredClone(workspace.plan)
  draft.proposedPlan.concepts[0].aliases = ['similar item']
  assert.ok(codes(guide.inspect(workspace, 'loan', draft)).includes('invalid-proposed-plan'))
})

test('proposal goes through existing copy-only store and coauthor ledger; source remains untouched', t => {
  const { dir, file, project, workspace } = setup(t)
  const before = fs.readFileSync(file, 'utf8')
  const result = guide.prepareReview(workspace, 'loan', draftFor(workspace), { basePlanText: before })
  assert.equal(result.ok, true)
  const proposals = createProposalStore({ workspaceRoot: dir, workspaceId: 'synthetic-workspace' })
  const created = proposals.createProposal({ ...result.body, actor: 'Synthetic reviewer' })
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.equal(created.record.proposal.status, 'proposed')
  assert.equal(created.record.proposal.authority.directWrite, false)
  assert.equal(created.record.payload.beforeText, before)
  const sessions = createKnowledgeSessions(project)
  let session = sessions.start({ requestId: randomUUID(), flow: 'model', questionId: 'loan', snapshot: workspace.snapshot, author: 'Synthetic participant' })
  assert.deepEqual(session.record.config.fields.map(f => f.id), ['concept', 'identity', 'relation', 'test'])
  for (const type of ['answer', 'save']) {
    session = sessions.event({ sessionId: session.record.id, event: { id: randomUUID(), type, expectedRevision: session.state.revision, ...(type === 'answer' ? { text: result.body.proposal.coauthor.fields.concept } : {}) } })
  }
  assert.equal(session.savedMeaning, 'private-draft-only')
  const reopened = createKnowledgeSessions(project).read(session.record.id)
  assert.equal(reopened.state.saved.length, 1)
  assert.equal(fs.readFileSync(file, 'utf8'), before)
})

test('raw plan and copy-only payload bounds refuse drift or truncation', t => {
  const { file, workspace } = setup(t)
  const before = fs.readFileSync(file, 'utf8')
  const draft = draftFor(workspace)
  assert.throws(() => guide.prepareReview(workspace, 'loan', draft, { basePlanText: before + '\n' }), /raw plan bytes/)
  assert.throws(() => guide.prepareReview(workspace, 'loan', draft, { basePlanText: before, planRef: '../plan.json' }), /workspace-relative/)
  draft.answer.text = 'x'.repeat(50000)
  assert.throws(() => guide.prepareReview(workspace, 'loan', draft, { basePlanText: before }), /store bound/)
})


test('omitted evidence stays explicit in the review handoff for a proposed abstention', t => {
  const { project, file } = setup(t)
  const plan = JSON.parse(fs.readFileSync(file, 'utf8'))
  plan.budget.maxDocuments = 1
  fs.writeFileSync(file, JSON.stringify(plan, null, 2) + '\n')
  const workspace = loadKnowledgeWorkspace(project)
  const draft = draftFor(workspace)
  draft.answer.status = 'abstain'
  draft.answer.text = 'The bounded view omits relevant sources; inspect them before deciding.'
  draft.evidence = []
  const result = guide.prepareReview(workspace, 'loan', draft, { basePlanText: fs.readFileSync(file, 'utf8') })
  assert.equal(result.ok, true)
  assert.equal(result.body.proposal.retrieval.abstention, 'unverified-omissions')
  assert.ok(result.body.proposal.retrieval.coverage.omitted > 0)
})

test('a later actual source edit requires a new binding and retains old pin history', t => {
  const { workspace, project, dir } = setup(t)
  const draft = draftFor(workspace)
  const oldPin = structuredClone(draft.evidence[0])
  fs.appendFileSync(path.join(dir, 'records/inspection.md'), '\nA later observation awaits review.\n')
  const current = loadKnowledgeWorkspace(project)
  const result = guide.inspect(current, 'loan', draft)
  assert.ok(codes(result).includes('changed-source'))
  assert.ok(codes(result).includes('stale-evidence'))
  assert.deepEqual(draft.evidence[0], oldPin)
})


test('malformed draft choices return actionable guidance instead of resolving a name or crashing', t => {
  const { workspace } = setup(t)
  assert.deepEqual(codes(guide.inspect(workspace, 'loan', null)), ['draft-required'])
  const draft = draftFor(workspace)
  draft.concepts = [null, { id: 'Equipment by its display name' }]
  draft.relations = {}
  draft.evidence = [null]
  const result = guide.inspect(workspace, 'loan', draft)
  for (const code of ['invalid-concept-choice', 'unknown-concept', 'invalid-evidence-pin', 'directed-meaning-required']) assert.ok(codes(result).includes(code), code)
})
