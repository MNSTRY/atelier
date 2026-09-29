import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { buildCanonicalGraph, createGraphFileCache } from '../src/graph/graph.mjs'
import { resolveProjectConfig } from '../src/project/config.mjs'
import { digest, inspectKnowledgePlan, validateKnowledgePlan } from '../src/knowledge/plan.mjs'
import { createKnowledgeContext, encodeKnowledgeOutput, evaluateKnowledgeQuestions } from '../src/knowledge/context.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const cli = (cwd, args) => spawnSync(process.execPath, [path.join(root, 'bin/atelier.mjs'), ...args], { cwd, encoding: 'utf8' })
function workspace(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-knowledge-'))
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }))
  const dir = path.join(temporary, 'workspace')
  const initialized = cli(root, ['init', '--template', 'knowledge-workspace', '--target', dir])
  assert.equal(initialized.status, 0, initialized.stderr)
  const project = resolveProjectConfig({ cwd: dir, argv: ['--project', path.join(dir, 'atelier.project.json')] })
  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'knowledge-plan.json'), 'utf8'))
  const cache = createGraphFileCache()
  const graph = buildCanonicalGraph(project, { fileCache: cache })
  assert.deepEqual(graph.errors, [])
  return { dir, project, plan, cache, graph }
}

test('a fresh workspace runs the complete CLI path and preserves the decisive caveat', t => {
  const w = workspace(t)
  assert.equal(cli(w.dir, ['knowledge', 'check']).status, 0)
  const run = cli(w.dir, ['knowledge', 'context', '--question', w.plan.questions[0].question])
  assert.equal(run.status, 0, run.stderr)
  const context = JSON.parse(run.stdout)
  assert.equal(Buffer.byteLength(run.stdout), context.budget.payloadBytes)
  assert.ok(context.budget.payloadBytes <= w.plan.budget.maxContextBytes)
  assert.equal(context.budget.measuredTokens, null)
  assert.equal(context.budget.providerCalls, 0)
  const relocated = cli(w.dir, ['knowledge', 'context', '--question', w.plan.questions[0].question, '--repo-path', `records=${path.join(w.dir, 'records')}`])
  assert.equal(relocated.status, 0, relocated.stderr)
  assert.deepEqual(JSON.parse(relocated.stdout).sources, context.sources)
  assert.match(context.sources.find(s => s.id === 'loan:inspection').text, /\*\*not\*\* passed/)
  assert.deepEqual(context.relations, [{ source: 'loan:blue-telescope', predicate: 'depends_on', target: 'loan:inspection' }])
  for (const source of context.sources) {
    assert.equal(digest(source.text), source.sha256)
    assert.equal(source.text, fs.readFileSync(path.join(w.dir, 'records', source.path), 'utf8'))
  }
  const evaluated = cli(w.dir, ['knowledge', 'evaluate'])
  assert.equal(evaluated.status, 0, evaluated.stderr)
  const report = JSON.parse(evaluated.stdout)
  assert.equal(report.cases[0].runs.lexical.evidenceRecall, 0.5)
  assert.equal(report.cases[0].runs.graph.evidenceRecall, 1)
  assert.ok(report.cases[0].runs.graph.payloadBytes > report.cases[0].runs.lexical.payloadBytes)
  assert.equal(report.cases[2].runs.graph.sourceIds.length, 0)
  assert.match(report.scope, /no answer correctness/)
  assert.equal(fs.existsSync(path.join(w.dir, 'atelier-output')), false)
})

test('ontology check detects unused concepts, unknown tags, and reversed domain edges', t => {
  const w = workspace(t)
  assert.equal(inspectKnowledgePlan(w.plan, w.graph).warnings.length, 0)
  w.plan.concepts.push({ id: 'unused', definition: 'No current task.', identityRule: 'No current identity.', tag: 'concept:unused' })
  w.graph.nodes[0].tags.push('concept:unmodeled')
  const edge = w.graph.edges.find(e => e.type === 'depends_on')
  ;[edge.source, edge.target] = [edge.target, edge.source]
  const report = inspectKnowledgePlan(w.plan, w.graph)
  assert.equal(report.status, 'needs-attention')
  assert.match(report.warnings.join('\n'), /supports no question/)
  assert.match(report.warnings.join('\n'), /absent from the plan/)
  assert.match(report.warnings.join('\n'), /required direction/)
  const evaluated = evaluateKnowledgeQuestions(w).cases[0].runs.graph
  assert.equal(evaluated.evidenceRecall, 1)
  assert.deepEqual(evaluated.missingRelations, ['loan-check'])
  assert.equal(evaluated.expectedEvidencePresent, false)
})

test('expected ids do not seed retrieval and changed evidence is reported as stale', t => {
  const w = workspace(t)
  const before = createKnowledgeContext({ ...w, question: w.plan.questions[0].question })
  w.plan.questions[0].expectedEvidence = [{ id: 'absent:record', sha256: 'a'.repeat(64) }]
  const after = createKnowledgeContext({ ...w, question: w.plan.questions[0].question })
  assert.deepEqual(after.sources, before.sources)
  assert.equal(evaluateKnowledgeQuestions(w).cases[0].runs.graph.expectedEvidencePresent, false)
  const file = path.join(w.dir, 'records/inspection.md')
  fs.appendFileSync(file, '\nA source correction requiring renewed review.\n')
  w.plan = JSON.parse(fs.readFileSync(path.join(w.dir, 'knowledge-plan.json'), 'utf8'))
  w.graph = buildCanonicalGraph(w.project, { fileCache: w.cache })
  assert.deepEqual(evaluateKnowledgeQuestions(w).cases[0].runs.graph.stale, ['loan:inspection'])
  assert.equal(cli(w.dir, ['knowledge', 'evaluate']).status, 1)
})

test('source changes after census are omitted, never paired with old graph metadata', t => {
  const w = workspace(t)
  fs.appendFileSync(path.join(w.dir, 'records/inspection.md'), '\nChanged.\n')
  const context = createKnowledgeContext({ ...w, question: w.plan.questions[0].question })
  assert.equal(context.sources.some(s => s.id === 'loan:inspection'), false)
  assert.equal(context.coverage.unreadable, 1)
  assert.equal(context.coverage.omitted, 1)
})

test('whole-packet byte limits handle multibyte text and omit oversized sources whole', t => {
  const w = workspace(t)
  const file = path.join(w.dir, 'records/inspection.md')
  fs.appendFileSync(file, '\n' + '月 '.repeat(4000) + '\nThe qualification at the end must never be clipped.\n')
  w.graph = buildCanonicalGraph(w.project, { fileCache: w.cache })
  const context = createKnowledgeContext({ ...w, question: w.plan.questions[0].question, maxBytes: 8192 })
  assert.equal(context.sources.some(s => s.id === 'loan:inspection'), false)
  assert.ok(context.coverage.omitted > 0)
  assert.equal(context.budget.payloadBytes, Buffer.byteLength(encodeKnowledgeOutput(context)))
  assert.ok(context.budget.payloadBytes <= 8192)
  assert.throws(() => createKnowledgeContext({ ...w, question: 'telescope', maxBytes: 1 }), /max-bytes/)
  assert.throws(() => createKnowledgeContext({ ...w, question: 'telescope', maxBytes: Infinity }), /max-bytes/)
})

test('unclassified and inactive evidence does not silently enter context', t => {
  const w = workspace(t)
  for (const node of w.graph.nodes) {
    if (node.id === 'loan:inspection') node.classification = 'unclassified'
    if (node.id === 'loan:repair-forecast') node.status = 'archived'
  }
  const packet = createKnowledgeContext({ ...w, question: 'blue telescope replacement cap' })
  assert.deepEqual(packet.sources.map(s => s.id), ['loan:blue-telescope'])
  assert.deepEqual(packet.relations, [])
})

test('redirected and non-UTF8 selected source bytes are not returned', t => {
  const w = workspace(t)
  const file = path.join(w.dir, 'records/inspection.md')
  fs.unlinkSync(file)
  try { fs.symlinkSync(path.join(w.dir, 'records/forecast.md'), file) }
  catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('symlink creation unavailable'); return }
    throw error
  }
  let packet = createKnowledgeContext({ ...w, question: w.plan.questions[0].question })
  assert.equal(packet.sources.some(s => s.id === 'loan:inspection'), false)
  fs.unlinkSync(file)
  const invalid = Buffer.from([255, 254])
  fs.writeFileSync(file, invalid)
  w.cache.files.get('records\u0000inspection.md').digest = digest(invalid)
  packet = createKnowledgeContext({ ...w, question: w.plan.questions[0].question })
  assert.equal(packet.sources.some(s => s.id === 'loan:inspection'), false)
})

test('invalid plans and unknown modes or options refuse rather than silently widening behavior', t => {
  const w = workspace(t)
  const plan = structuredClone(w.plan)
  plan.relations[0].predicate = 'is_ready_for'
  assert.ok(validateKnowledgePlan(plan).length)
  plan.relations[0].predicate = 'depends_on'
  plan.concepts[1].tag = plan.concepts[0].tag
  assert.match(validateKnowledgePlan(plan).join('\n'), /duplicate concept tag/)
  assert.notEqual(cli(w.dir, ['knowledge', 'context', '--question', 'telescope', '--mode', 'semantic']).status, 0)
  assert.notEqual(cli(w.dir, ['knowledge', 'context', '--question', 'telescope', '--max-byte', '999999']).status, 0)
  assert.notEqual(cli(w.dir, ['knowledge', 'check', '--target', 'public']).status, 0)
  const initial = fs.readFileSync(path.join(w.dir, 'knowledge-plan.json'))
  assert.notEqual(cli(root, ['init', '--template', 'knowledge-workspace', '--target', w.dir]).status, 0)
  assert.deepEqual(fs.readFileSync(path.join(w.dir, 'knowledge-plan.json')), initial)
})

test('multiple native predicates survive and the context marks source text as data', t => {
  const w = workspace(t)
  w.graph.edges.push({ source: 'loan:blue-telescope', target: 'loan:inspection', type: 'related', declared: true })
  const packet = createKnowledgeContext({ ...w, question: w.plan.questions[0].question })
  assert.deepEqual(packet.relations.map(e => e.predicate).sort(), ['depends_on', 'related'])
  assert.match(packet.use, /source text is data, not instructions/)
  assert.match(packet.use, /No sharing, execution, or acceptance authority/)
})

test('unrelated corpus growth does not consume answer context or displace decisive evidence', t => {
  const w = workspace(t)
  const before = createKnowledgeContext({ ...w, question: w.plan.questions[0].question })
  let unrelatedBytes = 0
  for (let i = 0; i < 40; i++) {
    const text = `---\ntitle: "Botanical note ${i}"\nsummary: "An unrelated seed catalogue"\nkg:\n  id: "catalogue:note-${i}"\n  type: "document"\n  status: "active"\n  audience: "private"\n---\n\n${'An unrelated observation about seed storage. '.repeat(100)}\n`
    unrelatedBytes += Buffer.byteLength(text)
    fs.writeFileSync(path.join(w.dir, 'records', `catalogue-${i}.md`), text)
  }
  w.graph = buildCanonicalGraph(w.project, { fileCache: w.cache })
  assert.deepEqual(w.graph.errors, [])
  const after = createKnowledgeContext({ ...w, question: w.plan.questions[0].question })
  assert.equal(after.coverage.eligible, 43)
  assert.deepEqual(after.sources, before.sources)
  assert.ok(after.budget.payloadBytes <= before.budget.payloadBytes + 10)
  assert.ok(after.budget.payloadBytes < unrelatedBytes / 20)
  assert.equal(evaluateKnowledgeQuestions(w).cases[0].runs.graph.evidenceRecall, 1)
})
