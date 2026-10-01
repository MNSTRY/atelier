import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { commandProject } from '../src/project/config.mjs'
import { digest, inspectKnowledgePlan, validateKnowledgePlan } from '../src/knowledge/plan.mjs'
import { createKnowledgeContext, encodeKnowledgeOutput, evaluateKnowledgeQuestions } from '../src/knowledge/context.mjs'
import { knowledgeDashboard, loadKnowledgeWorkspace } from '../src/knowledge/workspace.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const cli = (cwd, args) => spawnSync(process.execPath, [path.join(root, 'bin/atelier.mjs'), ...args], { cwd, encoding: 'utf8' })
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-knowledge-evidence-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const initialized = cli(root, ['init', '--template', 'knowledge-workspace', '--target', dir])
  assert.equal(initialized.status, 0, initialized.stderr)
  const project = commandProject({ cwd: dir, argv: [], writeLocalState: false })
  return { dir, ...loadKnowledgeWorkspace(project) }
}
const context = (w, options = {}) => createKnowledgeContext({ ...w, question: w.plan.questions[0].question, ...options })

test('omitted matching evidence cannot pass an abstention case or advance the dashboard', t => {
  let w = setup(t)
  w.plan.questions.push({ ...w.plan.questions[2], id: 'omitted', question: 'Amber sundial' })
  fs.writeFileSync(path.join(w.dir, 'knowledge-plan.json'), JSON.stringify(w.plan))
  fs.writeFileSync(path.join(w.dir, 'records/sundial.md'), `---\ntitle: "Amber sundial"\nsummary: "An amber sundial observation"\nkg:\n  id: "sample:sundial"\n  type: "document"\n  status: "active"\n  audience: "private"\n---\n\n${'x'.repeat(w.plan.budget.maxSourceBytes)}\n`)
  w = { dir: w.dir, ...loadKnowledgeWorkspace(w.project) }
  const run = evaluateKnowledgeQuestions(w).cases[3].runs.graph
  assert.equal(run.expectedEvidencePresent, false)
  assert.equal(run.status, 'abstain-unverified')
  assert.ok(run.candidates > 0)
  assert.ok(run.omitted > 0)
  assert.equal(run.unreadable, 0)
  assert.ok(run.omissions.some(o => o.id === 'sample:sundial' && o.reason === 'source-over-budget'))
  assert.equal(cli(w.dir, ['knowledge', 'evaluate']).status, 1)
  assert.equal(knowledgeDashboard(w).next.stage, 'deepen')
  assert.match(knowledgeDashboard(w).next.reason, /Matching evidence was omitted; the abstention cannot be verified/)
})

test('context names omission reasons without returning exception paths or partial sources', async t => {
  for (const reason of ['changed-since-census', 'source-over-budget', 'unreadable', 'decode', 'redirected', 'document-limit', 'packet-budget']) {
    await t.test(reason, t => {
      let w = setup(t)
      const file = path.join(w.dir, 'records/inspection.md')
      const original = fs.readFileSync(file)
      if (reason === 'changed-since-census') fs.appendFileSync(file, '\nChanged after census.\n')
      if (reason === 'source-over-budget') fs.appendFileSync(file, 'x'.repeat(w.plan.budget.maxSourceBytes))
      if (reason === 'unreadable') fs.unlinkSync(file)
      if (reason === 'decode') {
        const invalid = Buffer.from([255, 254])
        fs.writeFileSync(file, invalid)
        w.cache.files.get('records\u0000inspection.md').digest = digest(invalid)
      }
      if (reason === 'redirected') {
        // Identical bytes isolate the no-follow check from the census digest check.
        const redirected = path.join(w.dir, 'identical.md')
        fs.writeFileSync(redirected, original)
        fs.unlinkSync(file)
        try { fs.symlinkSync(redirected, file) }
        catch (error) {
          if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('symlink creation unavailable')
          throw error
        }
      }
      if (reason === 'document-limit') w.plan.budget.maxDocuments = 1
      if (reason === 'packet-budget') {
        fs.appendFileSync(file, '\n' + 'x'.repeat(3500))
        fs.appendFileSync(path.join(w.dir, 'records/telescope.md'), '\n' + 'x'.repeat(3500))
        w = { dir: w.dir, ...loadKnowledgeWorkspace(w.project) }
      }
      const packet = context(w, { maxBytes: 8192 })
      assert.equal(packet.sources.some(s => s.id === 'loan:inspection'), false)
      assert.ok(packet.omissions.some(o => o.id === 'loan:inspection' && o.reason === reason), JSON.stringify(packet.omissions))
      assert.equal(packet.coverage.unreadable, ['unreadable', 'decode'].includes(reason) ? 1 : 0)
      assert.equal(encodeKnowledgeOutput(packet).includes(w.dir), false)
      assert.equal(packet.budget.payloadBytes, Buffer.byteLength(encodeKnowledgeOutput(packet)))
      assert.ok(packet.budget.payloadBytes <= 8192)
    })
  }
})

test('omission details stay bounded, with an explicit count for details that do not fit', t => {
  let w = setup(t)
  for (let i = 0; i < 80; i++) {
    fs.writeFileSync(path.join(w.dir, 'records', `match-${i}.md`), `---\ntitle: "Blue telescope note ${i}"\nsummary: "Other blue telescope observations"\nkg:\n  id: "sample:match-${i}"\n  type: "document"\n  status: "active"\n  audience: "private"\n---\n\nAn invented observation.\n`)
  }
  w = { dir: w.dir, ...loadKnowledgeWorkspace(w.project) }
  w.plan.budget.maxDocuments = 1
  const packet = context(w, { maxBytes: 8192 })
  assert.ok(packet.omissions.length <= 20)
  assert.ok(packet.coverage.omissionsUnlisted > 0)
  assert.equal(packet.omissions.length + packet.coverage.omissionsUnlisted, packet.coverage.omitted)
  assert.equal(packet.budget.payloadBytes, Buffer.byteLength(encodeKnowledgeOutput(packet)))
  assert.ok(packet.budget.payloadBytes <= 8192)
})

test('source line locations describe real lines for LF, CRLF, and an unterminated last line', t => {
  let w = setup(t)
  const file = path.join(w.dir, 'records/inspection.md')
  const original = fs.readFileSync(file, 'utf8')
  const lines = original.trimEnd().split('\n').length
  for (const text of [original, original.replaceAll('\n', '\r\n'), original.trimEnd()]) {
    fs.writeFileSync(file, text)
    w = { dir: w.dir, ...loadKnowledgeWorkspace(w.project) }
    assert.deepEqual(context(w).sources.find(s => s.id === 'loan:inspection').lines, { start: 1, end: lines })
  }
})

test('ontology coverage distinguishes eligible evidence and rejects collapsed relation meanings', t => {
  const w = setup(t)
  for (const [key, value] of [['status', 'archived'], ['classification', 'unclassified'], ['extension', 'pdf']]) {
    const graph = structuredClone(w.graph)
    graph.nodes.find(n => n.id === 'loan:inspection')[key] = value
    const result = inspectKnowledgePlan(w.plan, graph)
    assert.equal(result.status, 'needs-attention')
    const concept = result.concepts.find(c => c.id === w.plan.relations[0].to)
    assert.equal(concept.records, 1)
    assert.equal(concept.eligibleRecords, 0)
    assert.equal(result.relations[0].matchingEdges, 1)
    assert.equal(result.relations[0].eligibleMatchingEdges, 0)
    assert.match(result.warnings.join('\n'), /no context-eligible/)
  }
  w.plan.relations.push({ ...w.plan.relations[0], id: 'different-meaning', meaning: 'A different assertion that cannot share this mapping.' })
  assert.match(validateKnowledgePlan(w.plan).join('\n'), /duplicate native relation mapping/)
})

test('plan digests bind exact raw bytes and census digests include unselected source bodies', t => {
  let w = setup(t)
  const first = context(w)
  const file = path.join(w.dir, 'knowledge-plan.json')
  const raw = fs.readFileSync(file)
  assert.equal(first.planSha256, digest(raw))
  assert.equal(evaluateKnowledgeQuestions(w).planSha256, digest(raw))
  assert.equal(JSON.parse(cli(w.dir, ['knowledge', 'context', '--question', w.plan.questions[0].question]).stdout).planSha256, digest(raw))
  fs.writeFileSync(file, '\n' + raw.toString('utf8') + '\n')
  w = { dir: w.dir, ...loadKnowledgeWorkspace(w.project) }
  const reformatted = context(w)
  assert.notEqual(reformatted.planSha256, first.planSha256)
  assert.deepEqual(reformatted.sources, first.sources)
  assert.equal(reformatted.censusSha256, first.censusSha256)
  fs.appendFileSync(path.join(w.dir, 'records/forecast.md'), '\nA body-only change to an unselected record.\n')
  w = { dir: w.dir, ...loadKnowledgeWorkspace(w.project) }
  const changed = context(w)
  assert.deepEqual(changed.sources, first.sources)
  assert.notEqual(changed.censusSha256, first.censusSha256)
})

test('an expected abstention with selected evidence explains what needs review', t => {
  let w = setup(t)
  w.plan.questions.push({ ...w.plan.questions[2], id: 'unexpected-match', question: 'Violet instrument' })
  fs.writeFileSync(path.join(w.dir, 'knowledge-plan.json'), JSON.stringify(w.plan))
  fs.writeFileSync(path.join(w.dir, 'records/violet.md'), `---\ntitle: "Violet instrument"\nsummary: "An invented instrument"\nkg:\n  id: "sample:violet"\n  type: "document"\n  status: "active"\n  audience: "private"\n---\n\nAn invented observation.\n`)
  w = { dir: w.dir, ...loadKnowledgeWorkspace(w.project) }
  const run = evaluateKnowledgeQuestions(w).cases[3].runs.graph
  assert.deepEqual(run.sourceIds, ['sample:violet'])
  assert.equal(run.expectedEvidencePresent, false)
  assert.equal(knowledgeDashboard(w).next.stage, 'deepen')
  assert.match(knowledgeDashboard(w).next.reason, /Matching evidence was retrieved for an expected abstention/)
})

test('a heavily linked seed cannot crowd out an equally relevant lexical seed', t => {
  let w = setup(t)
  const write = (name, title, relations = '') => fs.writeFileSync(path.join(w.dir, 'records', name + '.md'), `---\ntitle: "${title}"\nsummary: "An invented observation"\nkg:\n  id: "sample:${name}"\n  type: "document"\n  status: "active"\n  audience: "private"\n${relations}---\n\nAn invented observation.\n`)
  write('alpha', 'Violet instrument')
  write('beta', 'Violet instrument')
  for (let i = 0; i < 6; i++) write('neighbor-' + i, 'Inspection memorandum ' + i, '  relations:\n    depends_on:\n      - "sample:alpha"\n')
  w = { dir: w.dir, ...loadKnowledgeWorkspace(w.project) }
  assert.deepEqual(w.graph.errors, [])
  for (const maxDocuments of [2, 6]) {
    w.plan.budget.maxDocuments = maxDocuments
    const lexical = context(w, { question: 'Violet instrument', mode: 'lexical' })
    assert.deepEqual(lexical.sources.map(s => s.id), ['sample:alpha', 'sample:beta'])
    const packet = context(w, { question: 'Violet instrument' })
    const selected = packet.sources.map(s => s.id)
    const secondSeed = selected.indexOf('sample:beta')
    assert.ok(secondSeed >= 1, JSON.stringify(selected))
    assert.ok(selected.slice(0, secondSeed).filter(id => id.startsWith('sample:neighbor-')).length <= 1)
    if (maxDocuments === 2) assert.deepEqual(selected, ['sample:alpha', 'sample:beta'])
    assert.equal(packet.sources.length, maxDocuments)
    assert.equal(new Set(packet.sources.map(s => s.id)).size, maxDocuments)
    assert.equal(packet.coverage.omitted, 8 - maxDocuments)
    assert.ok(packet.budget.payloadBytes <= w.plan.budget.maxContextBytes)
    if (maxDocuments > 2) assert.deepEqual(packet.relations[0], { source: 'sample:neighbor-0', predicate: 'depends_on', target: 'sample:alpha' })
  }
})
