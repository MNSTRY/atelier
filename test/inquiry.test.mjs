import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import test from 'node:test'
import * as inquiry from '../src/inquiry/index.mjs'
import * as capability from '../src/capabilities/index.mjs'
import { digest } from '../src/capabilities/files.mjs'
import { buildKnowledgeGraph, REPO_ACCESS_SCHEMA } from '../src/graph/knowledge-graph.mjs'
import { getBundledReadinessProtocol } from '../src/readiness-protocols/bundled-pack.mjs'
import { validateJsonSchema } from '../src/export/atelier-export-contract.mjs'

const CLI = new URL('../bin/atelier.mjs', import.meta.url).pathname
const specimen = JSON.parse(fs.readFileSync(new URL('../fixtures/inquiry/workshop.json', import.meta.url)))
const clone = v => structuredClone(v)
const record = id => clone(specimen.find(r => r.id === id))
const before = id => clone(specimen.slice(0, specimen.findIndex(r => r.id === id)))
const through = id => [...before(id), record(id)]
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} differs from ${b}`)
function workspace(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-inquiry-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', root]); fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n')
  return root
}
const appendAll = (root, records) => records.reduce((head, item) => inquiry.appendInquiry({ workspaceRoot: root, record: item, confirm: head }).head, inquiry.EMPTY_INQUIRY_HEAD)
// Re-pin a mutated fixture bottom-up, just as a new campaign must bind new bytes.
function transform(records, fn) {
  const known = new Map()
  function walk(value) {
    if (value && typeof value === 'object') {
      if (value.id && value.digest && Object.keys(value).length === 2 && known.has(value.id)) return inquiry.inquiryRef(known.get(value.id))
      for (const key of Object.keys(value)) value[key] = walk(value[key])
    }
    return value
  }
  return clone(records).map(item => { fn(item); const result = walk(item); known.set(item.id, result); return result })
}

for (const kind of new Set(specimen.map(r => r.kind))) test(`${kind} inquiry contract is closed and rejects an unknown schema version`, () => {
  const r = clone(specimen.find(r => r.kind === kind))
  assert.deepEqual(inquiry.validateInquiryDocument(r), [])
  assert.ok(inquiry.validateInquiryDocument({ ...r, authorityGranted: true }).length)
  assert.ok(inquiry.validateInquiryDocument({ ...r, schema: 'atelier-inquiry-record@v2' }).length)
})

test('full campaign deduplicates evidence, preserves contradictions, and replays withdrawal', () => {
  const state = inquiry.inspectInquiry(specimen)
  near(state.assessments['first-assessment'].probability, 2 / 3)
  near(state.assessments['duplicate-assessment'].probability, 2 / 3)
  assert.equal(state.assessments['duplicate-assessment'].duplicateKeys.length, 1)
  near(state.assessments['mixed-assessment'].probability, 0.5)
  near(state.assessments['revised-assessment'].probability, 0.25)
  const sensitivity = state.assessments['first-assessment'].sensitivity
  near(sensitivity[0].probability, 3 / 7); near(sensitivity[1].probability, 9 / 11)
  assert.equal(state.assessments.qualitative.probability, null)
  assert.equal(state.assessments['old-score'], undefined)
  assert.ok(state.reconsider.some(r => r.id === 'decision-before'))
  assert.ok(!state.reconsider.some(r => r.id === 'decision-after'))
  assert.deepEqual(state, inquiry.inspectInquiry(clone(specimen)))
})

test('rates describe a posterior distribution, not truth of the broad hypothesis', () => {
  const r = record('first-assessment')
  r.data.model = { kind: 'beta-binomial', alpha: 1, beta: 1, priorFamilies: [], assumptions: 'Five independent pre-defined synthetic trials with the same rate.', observations: [{ key: 'report/finding', successes: 3, failures: 2 }] }
  const result = inquiry.inspectInquiry([...before(r.id), r]).assessments[r.id]
  assert.equal(result.distribution, 'beta'); assert.equal(result.alpha, 4); assert.equal(result.beta, 3)
  near(result.mean, 4 / 7); near(result.variance, 12 / 392)
  assert.equal(result.probability, undefined); assert.equal(result.calibration, 'unverified')
  r.data.model.observations[0].successes = 1.5
  assert.throws(() => inquiry.inspectInquiry([...before(r.id), r]), /invalid inquiry/)
})

test('missing, repeated, inconsistent or prior-reused contributions refuse', () => {
  for (const edit of [
    r => { r.data.model.likelihoods = [] },
    r => { r.data.model.likelihoods.push(clone(r.data.model.likelihoods[0])) },
    r => { r.data.model.priorFamilies = ['study-family'] },
    r => { r.data.model.likelihoods[0].ratio = 0 },
    r => { r.data.model.prior = 1 },
  ]) {
    const r = record('first-assessment'); edit(r)
    assert.throws(() => inquiry.inspectInquiry([...before(r.id), r]))
  }
  const r = record('duplicate-assessment'); r.data.model.likelihoods[1].ratio = 4
  assert.throws(() => inquiry.inspectInquiry([...before(r.id), r]), /dependent evidence family/)
})

test('unverified, wrong-scope and unrelated-request assertions cannot support a numeric update', () => {
  const unverified = transform(through('first-assessment'), r => { if (r.id === 'report') r.data.assertions[0].verification = 'unverified' })
  assert.throws(() => inquiry.inspectInquiry(unverified), /verified evidence/)
  const r = record('first-assessment'), outside = record('outside-report')
  r.data.evidence = [{ bundle: inquiry.inquiryRef(outside), assertion: 'finding' }]
  r.data.model.likelihoods = [{ key: 'outside-report/finding', ratio: 3 }]
  assert.throws(() => inquiry.inspectInquiry([...before(r.id), r]), /scope differs/)
  const request = record('research'); request.data.hypothesis.digest = digest('wrong-revision')
  assert.throws(() => inquiry.inspectInquiry([...before(request.id), request]), /mismatched/)
})

test('the same source cannot be reintroduced under its withdrawn family', () => {
  const r = record('study'); r.id = 'later-summary'
  const state = inquiry.inspectInquiry([...specimen, r])
  assert.ok(state.reconsider.some(i => i.id === r.id))
  assert.ok(state.reconsider.some(i => i.id === 'repeat-report'))
})

test('a withdrawal invalidates prior evidence and stale returns cannot update a revised question', () => {
  const prior = record('revised-assessment'); prior.data.model.priorFamilies = ['study-family']
  assert.throws(() => inquiry.inspectInquiry([...before(prior.id), prior]), /prior evidence family/)
  const revised = record('reminder'); revised.id = 'new-question'; revised.data.supersedes = inquiry.inquiryRef(record('reminder'))
  const late = record('report'); late.id = 'late-report'; late.data.attempt = 'late'
  const state = inquiry.inspectInquiry([...through('counterstudy'), revised, late])
  assert.ok(state.reconsider.some(r => r.id === late.id))
  assert.throws(() => inquiry.researchHandoff(state.records, 'research'), /stale/)
})

test('capture bytes, exact quotations, report budget and attempt identities are checked', () => {
  const source = record('study'); source.data.content += ' Changed.'
  assert.throws(() => inquiry.inspectInquiry([...before(source.id), source]), /digest mismatch/)
  const bundle = record('report'); bundle.data.assertions[0].quote = 'not in source'
  assert.throws(() => inquiry.inspectInquiry([...before(bundle.id), bundle]), /quote is absent/)
  const repeated = record('report'); repeated.id = 'repeated'
  assert.throws(() => inquiry.inspectInquiry([...through('report'), repeated]), /attempt already captured/)
  const over = transform(through('report'), r => { if (r.id === 'research') r.data.maxReports = 1; if (r.id === 'report') r.data.reports.push(inquiry.inquiryRef(record('counterstudy'))) })
  assert.throws(() => inquiry.inspectInquiry(over), /budget exceeded/)
})

test('source readership cannot be widened through a campaign label', () => {
  const records = transform(through('study'), r => { if (r.kind === 'campaign') r.data.audience = 'public' })
  assert.throws(() => inquiry.inspectInquiry(records), /disclosure scope/)
})

test('handoff carries standalone context and versions without executing a provider', () => {
  const handoff = inquiry.researchHandoff(through('research'), 'research')
  assert.deepEqual(inquiry.validateInquiryDocument(handoff, 'handoff'), [])
  assert.equal(handoff.authority, 'none')
  assert.ok(handoff.prompt.includes('scheduling') || handoff.prompt.includes('Scheduling'))
  assert.ok(handoff.prompt.includes('at most 4 reports'))
  assert.equal(inquiry.INQUIRY_LENSES.lenses.length, 9)
})

test('graph proposal excludes superseded conclusions and produces valid relation claims', t => {
  const root = workspace(t), repo = path.join(root, 'corpus'); fs.mkdirSync(repo)
  const proposal = inquiry.inquiryGraphProposal(specimen, { namespace: 'corpus' })
  assert.equal(proposal.canonicalMutation, false)
  assert.ok(!proposal.files.some(f => f.path === 'decision-before.md'))
  assert.ok(proposal.files.some(f => f.path === 'decision-after.md'))
  const schema = JSON.parse(fs.readFileSync(new URL('../contracts/atelier-claim.v1.schema.json', import.meta.url)))
  for (const claim of proposal.claims) assert.deepEqual(validateJsonSchema(schema, claim), [])
  // Synthetic receiver explicitly accepts these edges in this disposable test.
  for (const file of proposal.files) {
    const id = /  id: "([^"]+)"/.exec(file.content)[1]
    const relations = {}
    for (const claim of proposal.claims.filter(c => c.subject === id)) (relations[claim.predicate] ??= []).push(claim.object)
    const yaml = Object.entries(relations).flatMap(([key, values]) => [`    ${key}:`, ...values.map(v => `      - ${JSON.stringify(v)}`)]).join('\n')
    fs.writeFileSync(path.join(repo, file.path), yaml ? file.content.replace('  relations: {}', `  relations:\n${yaml}`) : file.content)
  }
  const built = buildKnowledgeGraph({ workspaceRoot: root, repoRoots: [repo], repoAccessConfig: { schema: REPO_ACCESS_SCHEMA, defaultReadBoundary: 'private', repos: { corpus: { readBoundary: 'private' } } } })
  assert.equal(built.ok, true, built.errors.join('\n'))
  assert.ok(built.workspaceGraph.edges.length >= 4, JSON.stringify({nodes: built.workspaceGraph.nodes.map(n => n.id), edges: built.workspaceGraph.edges}))
  assert.throws(() => inquiry.inquiryGraphProposal(specimen, { namespace: 'a.b' }), /namespace/)
})

test('repository journal rejects stale writers and replays exact immutable content', t => {
  const root = workspace(t), head = appendAll(root, specimen)
  const read = inquiry.readInquiry({ workspaceRoot: root, campaign: 'workshop' })
  assert.equal(read.head, head); assert.deepEqual(read.records, specimen)
  const file = path.join(root, '.atelier-local/inquiry/workshop/ledger.json'), bytes = fs.readFileSync(file)
  assert.throws(() => inquiry.appendInquiry({ workspaceRoot: root, record: record('research-feedback'), confirm: inquiry.EMPTY_INQUIRY_HEAD }), /current history digest/)
  assert.deepEqual(fs.readFileSync(file), bytes)
  const tampered = JSON.parse(bytes); tampered.records[0].data.title = 'Changed'
  fs.writeFileSync(file, JSON.stringify(tampered))
  assert.throws(() => inquiry.readInquiry({ workspaceRoot: root, campaign: 'workshop' }), /integrity mismatch/)
})

test('interrupted atomic replacement preserves the previous complete ledger', t => {
  const root = workspace(t), head = appendAll(root, through('reminder')), rename = fs.renameSync
  fs.renameSync = () => { throw new Error('synthetic write interruption') }
  try { assert.throws(() => inquiry.appendInquiry({ workspaceRoot: root, record: record('research'), confirm: head }), /interruption/) }
  finally { fs.renameSync = rename }
  assert.equal(inquiry.readInquiry({ workspaceRoot: root, campaign: 'workshop' }).head, head)
  inquiry.appendInquiry({ workspaceRoot: root, record: record('research'), confirm: head })
})

test('campaign writes refuse redirected paths and nonignored state', t => {
  const root = workspace(t), external = path.join(root, 'elsewhere'); fs.mkdirSync(external)
  fs.mkdirSync(path.join(root, '.atelier-local'))
  fs.symlinkSync(external, path.join(root, '.atelier-local/inquiry'))
  assert.throws(() => appendAll(root, through('workshop')), /redirected/)
  assert.deepEqual(fs.readdirSync(external), [])
  fs.unlinkSync(path.join(root, '.atelier-local/inquiry')); fs.writeFileSync(path.join(root, '.gitignore'), '')
  assert.throws(() => appendAll(root, through('workshop')), /ignored/)
})

test('CLI exercises append, handoff, export, replay and graph without provider execution', t => {
  const root = workspace(t), file = path.join(root, 'record.json')
  const missing = spawnSync(process.execPath, [CLI, 'inquiry', 'export', '--campaign', 'missing'], { cwd: root, encoding: 'utf8' })
  assert.equal(missing.status, 1)
  assert.match(JSON.parse(missing.stdout).error, /does not exist/)
  let head = inquiry.EMPTY_INQUIRY_HEAD
  for (const r of specimen) {
    fs.writeFileSync(file, JSON.stringify(r))
    head = JSON.parse(execFileSync(process.execPath, [CLI, 'inquiry', 'append', '--record', file, '--confirm', head, '--workspace', root], { encoding: 'utf8' })).head
  }
  const cli = args => JSON.parse(execFileSync(process.execPath, [CLI, 'inquiry', ...args, '--workspace', root], { encoding: 'utf8' }))
  assert.equal(cli(['status', '--campaign', 'workshop']).head, head)
  const exported = cli(['export', '--campaign', 'workshop']); fs.writeFileSync(file, JSON.stringify(exported))
  assert.equal(cli(['inspect', '--history', file]).head, head)
  assert.equal(cli(['handoff', '--campaign', 'workshop', '--request', 'research']).request.id, 'research')
  assert.ok(cli(['graph', '--campaign', 'workshop', '--namespace', 'corpus']).files.length)
  const result = spawnSync(process.execPath, [CLI, 'inquiry', 'status', '--campaign', '../other'], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 1)
})

test('discovery display rename retains the persisted readiness identity', () => {
  const p = getBundledReadinessProtocol('discovery-engine')
  assert.equal(p.title, 'Discovery Harness'); assert.equal(p.id, 'mnstry.readiness:discovery-engine')
  assert.ok(p.questions.every(q => q.id.includes('discovery-engine')))
})

test('feedback preserves causes the older Steward vocabulary cannot represent', () => {
  for (const cause of ['context', 'provider']) {
    const records = transform(specimen, r => { if (r.id === 'research-feedback') r.data.cause = cause })
    const proposal = inquiry.inquiryStewardObservation(records, 'research-feedback')
    assert.equal(proposal.reportedCause, cause)
    assert.equal(proposal.event.cause, 'unknown')
    assert.equal(proposal.recorded, false)
  }
})

test('two repositories adopt both harnesses and feedback stays bound to the actual skill', t => {
  const first = workspace(t), second = workspace(t)
  const sources = ['discovery-harness', 'research-harness'].map(n => new URL(`../fixtures/inquiry-packages/${n}`, import.meta.url).pathname)
  for (const [index, root] of [first, second].entries()) {
    fs.mkdirSync(path.join(root, '.agents/skills/existing'), { recursive: true }); fs.writeFileSync(path.join(root, '.agents/skills/existing/SKILL.md'), 'Existing owner content')
    const host = index ? 'claude-repo-v1' : 'codex-repo-v1'
    const releases = sources.map(packageRoot => capability.verifyCapabilityRelease({ packageRoot }))
    const adoption = { schema: 'mnstry.atelier-capability-adoption@v1', id: `repo-${index}`, packages: releases.map(r => ({ id: r.package.id, digest: r.digest, mode: 'managed', bindings: [{ skill: 'harness', host, alias: r.package.skills[0].name }], allowedTools: ['atelier-inquiry-v1'], allowedEffects: ['read-workspace', 'write-workspace'] })) }
    const options = { workspaceRoot: root, sources, adoption, availableTools: ['atelier-inquiry-v1'] }
    const plan = capability.planCapabilityAdoption(options); assert.equal(plan.applyAllowed, true, plan.blockers.join(';'))
    const { state } = capability.applyCapabilityAdoption({ ...options, confirm: plan.planDigest })
    const pkg = state.packages.find(p => p.id.endsWith('/research-harness')), binding = pkg.bindings[0]
    const records = transform(specimen, r => { if (r.id === 'research') r.data.binding = { package: pkg.id, releaseDigest: pkg.release.digest, generation: state.generation, binding: binding.target, bindingDigest: binding.digest, host, session: 'consumer-session' } })
    appendAll(root, records)
    const observation = inquiry.inquiryStewardObservation(records, 'research-feedback')
    assert.equal(observation.recorded, false)
    capability.recordCapabilityEvent({ workspaceRoot: root, event: observation.event })
    const status = capability.capabilityEvidenceStatus({ workspaceRoot: root, session: 'consumer-session' })
    assert.equal(status.events[0].outcome, 'unknown')
    assert.equal(fs.readFileSync(path.join(root, '.agents/skills/existing/SKILL.md'), 'utf8'), 'Existing owner content')
    assert.throws(() => capability.recordCapabilityEvent({ workspaceRoot: root, event: { ...observation.event, id: 'bad-generation', generation: digest('wrong') } }), /current installed binding/)
  }
})
