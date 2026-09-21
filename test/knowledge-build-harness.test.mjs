import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import * as harness from '../src/harnesses/index.mjs'
import * as knowledge from '../src/knowledge/index.mjs'
import { inspectBuild, prepareGitCandidate } from '../src/build/index.mjs'
import { createIntakeStore, intakeDigest } from '../src/intake/store.mjs'
import { buildKnowledgeGraph, REPO_ACCESS_SCHEMA } from '../src/graph/knowledge-graph.mjs'
import { validateJsonSchema } from '../src/export/atelier-export-contract.mjs'
import { CONTRACT_CORPUS } from '../src/contracts/corpus.mjs'
import * as capabilities from '../src/capabilities/index.mjs'
const example = JSON.parse(fs.readFileSync(new URL('../fixtures/harnesses/learning-cycle.json', import.meta.url)))
const { knowledge: K, build: B, lessons: L } = example
const clone = structuredClone, pin = harness.harnessRef, digest = harness.contentDigest
const CLI = new URL('../bin/atelier.mjs', import.meta.url).pathname
const get = (records, id) => clone(records.find(r => r.id === id))
const add = (records, id, kind, data) => [...clone(records), { ...records[0], id, kind, data }]
const snapshot = (profile, records) => ({ repository: records[0].data.repository, profile, records })
const dependencies = [snapshot('knowledge', K)]
const lessonDependencies = [...dependencies, snapshot('build', B)]
function transform(records, fn) {
  const known = new Map()
  function walk(value) {
    if (value && typeof value === 'object') {
      if (value.id && value.digest && Object.keys(value).length === 2 && known.has(value.id)) return pin(known.get(value.id))
      for (const key of Object.keys(value)) value[key] = walk(value[key])
    }
    return value
  }
  return clone(records).map(r => { fn(r); const result = walk(r); known.set(r.id, result); return result })
}
function workspace(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-harness-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', root]); fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n')
  return root
}
function append(root, profile, records) { return records.reduce((head, record) => harness.appendHarness({ workspaceRoot: root, profile, record, confirm: head }).head, harness.EMPTY_HARNESS_HEAD) }

for (const entry of CONTRACT_CORPUS.filter(e => /atelier-(knowledge|build|harness)-/.test(e.name))) test(`${entry.name} accepts its complete fixture and refuses authority fields and future versions`, () => {
  const profile = entry.name.split('-')[1], shape = entry.docPointer.split('/').at(-1)
  const read = validity => JSON.parse(fs.readFileSync(new URL(`../${entry.fixtureRoot}/${validity}/document.json`, import.meta.url)))
  assert.deepEqual(harness.validateHarnessDocument(read('valid'), profile, shape), [])
  assert.ok(harness.validateHarnessDocument(read('invalid'), profile, shape).length)
  assert.ok(harness.validateHarnessDocument({ ...read('valid'), schema: 'future@v2' }, profile, shape).length)
})

test('knowledge development records uncertainty independently from owner-reported acceptance', () => {
  const state = knowledge.inspectKnowledge(K)
  assert.ok(state.accepted.includes('trial-rationale'))
  assert.equal(state.evaluations['claim-evaluation'].judgment, 'uncertain')
  assert.equal(state.semanticTruthVerified, false)
  assert.equal(state.authority, 'none')
  assert.deepEqual(knowledge.inspectKnowledge(clone(K)), state)
})

test('source correction reaches the build and the returned learning through explicit snapshots', () => {
  assert.equal(harness.buildReadiness(B).readyReported, false)
  assert.equal(harness.buildReadiness(B, { dependencySnapshots: dependencies }).readyReported, true)
  assert.equal(knowledge.reconcileKnowledge(L, { dependencySnapshots: lessonDependencies }).reconsider.length, 0)
  const corrected = [...K, example.withdrawal], before = harness.harnessDigest(B)
  const changes = knowledge.inspectKnowledge(corrected).reconsider.map(r => r.id)
  for (const id of ['observation', 'trial-rationale', 'claim-review', 'graph-use']) assert.ok(changes.includes(id))
  const snapshots = [snapshot('knowledge', corrected), snapshot('build', B)]
  assert.equal(harness.buildReadiness(B, { dependencySnapshots: snapshots }).readyReported, false)
  assert.ok(knowledge.reconcileKnowledge(L, { dependencySnapshots: snapshots }).reconsider.some(r => r.id === 'lesson-use'))
  assert.throws(() => knowledge.knowledgeGraphProposal(L, { namespace: 'lessons', activationId: 'lesson-use', dependencySnapshots: snapshots }), /current activation/)
  assert.equal(harness.harnessDigest(B), before)
})

test('handoff remains valid after unrelated append but refuses divergence, changed pins and target substitution', () => {
  const extra = get(K, 'observation'); extra.id = 'other-observation'
  assert.equal(harness.verifyHarnessHandoff({ handoff: example.handoff, records: [...K, extra] }).current, true)
  const diverged = transform(K, r => { if (r.kind === 'domain') r.data.purpose = 'Changed purpose' })
  assert.throws(() => harness.verifyHarnessHandoff({ handoff: example.handoff, records: diverged }), /changed|diverged/)
  const bad = clone(example.handoff); bad.source.subject.digest = digest('wrong')
  assert.throws(() => harness.verifyHarnessHandoff({ handoff: bad, records: K }), /stale|differs/)
  const target = clone(example.buildHandoff); target.target.repository = 'other'
  assert.throws(() => knowledge.prepareKnowledgeImport({ records: [L[0]], handoff: target, sourceRecords: B, title: 'test', term: 'material', dependencySnapshots: dependencies }), /another receiver/)
  for (const [profile, records, subjectId] of [['knowledge', K, 'trial-rationale'], ['build', B, 'prototype']]) {
    assert.throws(() => harness.createHarnessHandoff({ profile, repository: 'wrong-origin', records, subjectId, target: example.handoff.target, dependencySnapshots: dependencies }), /repository differs/)
  }
})

test('knowledge refuses invalid lineage, scope, audience, quote, vocabulary and unreviewed evidence', () => {
  const cases = [
    [r => { if (r.id === 'observation') r.data.body += ' altered' }, /digest mismatch/],
    [r => { if (r.id === 'trial-rationale') r.data.basedOn[0].quote = 'not in source' }, /quote missing/],
    [r => { if (r.id === 'trial-rationale') r.data.scope = 'different population' }, /scope differs/],
    [r => { if (r.id === 'trial-rationale') r.data.term = 'unmapped' }, /vocabulary/],
    [r => { if (r.id === 'claim-evaluation') r.data.scope = 'different' }, /evaluation scope/],
    [r => { if (r.id === 'source-review') r.data.disposition = 'deferred' }, /current acceptance/],
    [r => { if (r.id === 'claim-review') r.data.evaluations = [] }, /needs an evaluation/],
    [r => { if (r.kind === 'domain') r.data.audience = 'public' }, /audience/],
    [r => { if (r.id === 'graph-use') r.data.questions = ['unknown'] }, /unknown domain question/],
  ]
  for (const [mutate, pattern] of cases) assert.throws(() => knowledge.inspectKnowledge(transform(K, mutate)), pattern)
})

test('exports retain the audience of included domain context even when source contributions are public', () => {
  for (const audience of ['public', 'team', 'operator', 'staff', 'private', 'sensitive']) {
    const records = transform(K, r => {
      if (r.kind === 'domain') r.data.audience = audience
      if (r.kind === 'contribution') r.data.audience = 'public'
    })
    const handoff = harness.createHarnessHandoff({ profile: 'knowledge', repository: records[0].data.repository, records, subjectId: 'trial-rationale', target: { ...example.handoff.target, profile: 'knowledge' } })
    assert.equal(handoff.audience, audience)
    assert.equal(handoff.source.repositoryBinding, 'establishment-record')
    const proposal = knowledge.knowledgeGraphProposal(records, { namespace: 'corpus', activationId: 'graph-use' })
    for (const file of proposal.files) assert.ok(file.content.includes(`  audience: "${audience}"`))
    const receiver = clone(K[0]); receiver.data.repository = handoff.target.repository; receiver.data.audience = 'public'
    if (audience !== 'public') assert.throws(() => knowledge.prepareKnowledgeImport({ records: [receiver], handoff, sourceRecords: records, title: 'Import', term: 'material' }), /audience/)
  }
  const sensitive = transform(K, r => { if (r.kind === 'contribution') r.data.audience = 'sensitive' })
  assert.throws(() => knowledge.inspectKnowledge(sensitive), /audience/)
})

test('dependency fan-out reuses inspected histories and stops at a named finite work budget', () => {
  const width = 8
  function layer(source, level, snapshots) {
    const domain = get(K, 'workshop-knowledge'); domain.id = domain.run = `layer-${level}`; domain.data.repository = domain.id
    const make = (id, kind, data) => ({ ...domain, id, kind, data })
    const subject = source.findLast(r => r.kind === 'contribution')
    const handoff = harness.createHarnessHandoff({ profile: 'knowledge', repository: source[0].data.repository, records: source, subjectId: subject.id, target: { repository: domain.data.repository, profile: 'knowledge', purpose: 'Evaluate imported evidence.' }, dependencySnapshots: snapshots })
    const data = knowledge.prepareKnowledgeImport({ records: [domain], handoff, sourceRecords: source, title: 'Imported evidence', term: 'material', dependencySnapshots: snapshots }).data
    const records = [domain], imported = []
    const evaluate = c => {
      const evaluation = make(`${c.id}-evaluation`, 'evaluation', { ...get(K, 'source-evaluation').data, contribution: pin(c) })
      records.push(c, evaluation, make(`${c.id}-review`, 'review', { ...get(K, 'source-review').data, target: pin(c), evaluations: [pin(evaluation)] }))
    }
    for (let i = 0; i < width; i++) { const c = make(`input-${i}`, 'contribution', clone(data)); imported.push(c); evaluate(c) }
    evaluate(make('aggregate', 'contribution', { ...get(K, 'trial-rationale').data, domain: pin(domain), basedOn: imported.map(c => ({ contribution: pin(c), quote: '{"subject":' })) }))
    return records
  }
  const first = layer(K, 1, dependencies), snapshots = [...dependencies, snapshot('knowledge', first)]
  const second = layer(first, 2, snapshots)
  const result = knowledge.reconcileKnowledge(second, { dependencySnapshots: snapshots })
  assert.equal(result.reconsider.length, 0)
  assert.ok(result.dependencyWork.historyReplays <= 3, 'each distinct history is inspected once')
  assert.ok(result.dependencyWork.verificationCalls < width * width, 'shared upstream handoffs are memoized')
  const bounded = knowledge.reconcileKnowledge(second, { dependencySnapshots: snapshots, verificationLimit: 5 })
  assert.equal(bounded.dependencyWork.verificationCalls, 5)
  assert.equal(bounded.dependencyWork.exhausted, true)
  assert.ok(bounded.reconsider.some(r => r.id === 'aggregate' && r.reasons.includes('import-source-verification-budget-exhausted')))
  const corrected = [snapshot('knowledge', [...K, example.withdrawal]), snapshot('knowledge', first)]
  assert.ok(knowledge.reconcileKnowledge(second, { dependencySnapshots: corrected }).reconsider.some(r => r.id === 'aggregate'))
  const build = transform(B, r => { if (r.kind === 'objective') r.data.dependencies = Array.from({ length: width }, (_, i) => ({ ...r.data.dependencies[0], id: `need-${i}` })) })
  const readiness = harness.buildReadiness(build, { dependencySnapshots: dependencies, verificationLimit: 5 })
  assert.equal(readiness.readyReported, false)
  assert.ok(readiness.blockers.some(b => b.startsWith('dependency-verification-budget-exhausted:')))
  assert.throws(() => harness.buildReadiness(B, { verificationLimit: harness.HARNESS_LIMITS.dependencyVerifications + 1 }), /verification limit/)
})

test('domain migration and contribution revision preserve history and invalidate prior meaning', () => {
  const migrated = [...K, example.domainRevision]
  assert.equal(knowledge.inspectKnowledge(migrated).accepted.length, 0)
  const next = get(K, 'observation'); next.id = 'new-source'
  assert.throws(() => knowledge.inspectKnowledge([...migrated, next]), /reconsideration/)
  next.data.domain = pin(example.domainRevision); next.data.supersedes = pin(K[1]); next.data.revisionReason = 'Reclassified under new vocabulary.'
  assert.equal(knowledge.inspectKnowledge([...migrated, next]).records.length, migrated.length + 1)
  const revision = get(K, 'trial-rationale'); revision.id = 'rationale-next'; revision.data.supersedes = pin(get(K, 'trial-rationale')); revision.data.revisionReason = 'Narrow the rationale.'
  const revised = knowledge.inspectKnowledge([...K, revision])
  assert.ok(revised.reconsider.some(r => r.id === 'graph-use'))
  assert.equal(revised.records.find(r => r.id === 'trial-rationale').data.body, get(K, 'trial-rationale').data.body)
})

test('new contradictory evaluation reopens acceptance and cannot be omitted from the next review', () => {
  const evaluation = get(K, 'claim-evaluation'); evaluation.id = 'counterevaluation'; evaluation.data.judgment = 'contested'
  const updated = [...K, evaluation]
  assert.ok(!knowledge.inspectKnowledge(updated).accepted.includes('trial-rationale'))
  assert.equal(harness.buildReadiness(B, { dependencySnapshots: [snapshot('knowledge', updated)] }).readyReported, false)
  const review = get(K, 'claim-review'); review.id = 'reconsidered-review'
  assert.throws(() => knowledge.inspectKnowledge([...updated, review]), /every current evaluation/)
  review.data.evaluations.push(pin(evaluation))
  const revised = [...updated, review]
  assert.ok(knowledge.inspectKnowledge(revised).accepted.includes('trial-rationale'))
  const handoff = harness.createHarnessHandoff({ profile: 'knowledge', repository: K[0].data.repository, records: revised, subjectId: 'trial-rationale', target: example.handoff.target })
  assert.ok(handoff.payload.includes('counterevaluation'))
  assert.throws(() => harness.verifyHarnessHandoff({ handoff: example.handoff, records: revised }), /stale|differs/)
})

test('build records never turn attempt completion into a gate or authenticated acceptance', () => {
  const state = inspectBuild(B.slice(0, 5))
  assert.equal(state.attempts['test-attempt'].state, 'completed')
  assert.equal(state.gates.length, 0); assert.equal(state.reportedAccepted, false)
  const full = inspectBuild(B)
  assert.equal(full.reportedAccepted, true); assert.equal(full.authenticatedAcceptance, false); assert.equal(full.executionAuthorized, false)
  assert.equal(harness.buildCoordinationProposal(B, { dependencySnapshots: dependencies }).acceptedByCoordinator, false)
})

test('Git adapter binds actual candidate and artifact bytes and refuses dirty sources', t => {
  const root = workspace(t), git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  fs.writeFileSync(path.join(root, 'prototype.txt'), 'Disposable prototype bytes')
  git(['add', '.']); git(['-c', 'user.name=Synthetic Owner', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Synthetic candidate'])
  const proposal = prepareGitCandidate({ workspaceRoot: root, records: [B[0]], artifact: 'prototype.txt', writer: get(B, 'prototype').data.writer })
  assert.equal(proposal.data.commit, git(['rev-parse', 'HEAD'])); assert.equal(proposal.data.tree, git(['rev-parse', 'HEAD^{tree}']))
  assert.equal(proposal.data.artifactDigest, digest('Disposable prototype bytes'))
  assert.equal(proposal.authority, 'none')
  fs.appendFileSync(path.join(root, 'prototype.txt'), ' edited')
  assert.throws(() => prepareGitCandidate({ workspaceRoot: root, records: [B[0]], artifact: 'prototype.txt', writer: get(B, 'prototype').data.writer }), /clean repository/)
})

test('unsettled attempts refuse retry and candidate replacement; effects and budgets stay bounded', () => {
  const retry = get(B, 'test-attempt'); retry.id = 'retry'
  assert.throws(() => inspectBuild([...B.slice(0, 4), retry]), /unsettled/)
  const candidate = get(B, 'prototype'); candidate.id = 'next'; candidate.data.supersedes = pin(get(B, 'prototype'))
  assert.throws(() => inspectBuild([...B.slice(0, 4), candidate]), /unsettled/)
  const effect = transform(B, r => { if (r.kind === 'attempt') r.data.effects = ['network'] })
  assert.throws(() => inspectBuild(effect), /declared scope/)
  const failed = transform(B.slice(0, 5), r => { if (r.kind === 'objective') r.data.maxAttempts = 1; if (r.id === 'test-completion') r.data.state = 'failed' })
  retry.data.candidate = pin(failed[1])
  assert.throws(() => inspectBuild([...failed, retry]), /budget/)
  const extra = get(B, 'test-completion'); extra.id = 'again'
  assert.throws(() => inspectBuild([...B, extra]), /terminal attempt/)
})

test('candidate replacement and late failed gates invalidate downstream acceptance and delivery', () => {
  const candidate = get(B, 'prototype'); candidate.id = 'next'; candidate.data.supersedes = pin(get(B, 'prototype')); candidate.data.commit = '3'.repeat(40)
  const next = inspectBuild([...B, candidate])
  assert.equal(next.reportedAccepted, false)
  assert.ok(next.reconsider.some(r => r.id === 'delivery-report'))
  const failed = get(B, 'ci-gate'); failed.id = 'ci-correction'; failed.data.status = 'failed'
  const changed = inspectBuild([...B, failed]); assert.equal(changed.reportedAccepted, false)
  const decision = get(B, 'candidate-review'); decision.id = 'wrong-acceptance'; decision.data.gates[2] = pin(failed)
  assert.throws(() => inspectBuild([...B, failed, decision]), /required gates/)
  const request = get(B, 'candidate-review'); request.id = 'request-changes'; request.data.disposition = 'changes-requested'
  assert.ok(inspectBuild([...B, request]).reconsider.some(r => r.id === 'delivery-report'))
})

test('real intake preserves original bytes and prepares a pinned source without semantic acceptance', t => {
  const root = workspace(t), text = 'A synthetic transcript with an explicit gap: [unclear].'
  fs.writeFileSync(path.join(root, 'transcript.txt'), text)
  const intake = createIntakeStore({ workspaceRoot: root })
  const source = intake.ingest({ ref: 'transcript.txt', expectedDigest: intakeDigest(text) })
  intake.beginAttempt({ attemptId: 'text-pass', blobId: source.blobId, extractorId: 'manual-text', extractorVersion: '1.0.0', configurationDigest: intakeDigest('preserve gaps') })
  intake.completeAttempt({ attemptId: 'text-pass', output: text, expectedOutputDigest: intakeDigest(text) })
  const proposal = knowledge.prepareIntakeContribution({ workspaceRoot: root, records: [K[0]], attemptId: 'text-pass', title: 'Transcript', term: 'material' })
  assert.equal(proposal.semanticAcceptance, 'pending'); assert.equal(proposal.data.body, text)
  assert.equal(knowledge.inspectKnowledge(add([K[0]], 'transcript', 'contribution', proposal.data)).accepted.length, 0)
  assert.equal(fs.readFileSync(path.join(root, 'transcript.txt'), 'utf8'), text)
  fs.writeFileSync(path.join(root, '.atelier-local/intake/attempts/text-pass/output.txt'), 'changed')
  assert.throws(() => knowledge.prepareIntakeContribution({ workspaceRoot: root, records: [K[0]], attemptId: 'text-pass', title: 'Transcript', term: 'material' }), /digest|integrity/)
})

test('inquiry handoff preserves the conclusion and assumptions; importing does not accept it', () => {
  const inquiry = JSON.parse(fs.readFileSync(new URL('../fixtures/inquiry/workshop.json', import.meta.url)))
  const handoff = harness.createHarnessHandoff({ profile: 'inquiry', repository: 'research-notes', records: inquiry, subjectId: 'decision-after', target: { repository: K[0].data.repository, profile: 'knowledge', purpose: 'Review applicability to the knowledge domain.' } })
  assert.equal(handoff.source.repositoryBinding, 'caller-declared')
  const verification = harness.verifyHarnessHandoff({ handoff, records: inquiry })
  assert.equal(verification.sourceRepositoryBinding, 'caller-declared')
  assert.equal(verification.sourceAuthenticity, 'unverified')
  const mislabeled = clone(handoff); mislabeled.source.repositoryBinding = 'establishment-record'
  assert.throws(() => harness.verifyHarnessHandoff({ handoff: mislabeled, records: inquiry }), /stale|differs/)
  const proposal = knowledge.prepareKnowledgeImport({ records: [K[0]], handoff, sourceRecords: inquiry, title: 'Research conclusion', term: 'material' })
  assert.ok(proposal.data.body.includes('assumptions')); assert.equal(proposal.semanticAcceptance, 'pending')
  const records = add([K[0]], 'research-result', 'contribution', proposal.data)
  assert.equal(knowledge.inspectKnowledge(records).accepted.length, 0)
  assert.ok(knowledge.reconcileKnowledge(records).reconsider.some(r => r.id === 'research-result'))
  assert.equal(knowledge.reconcileKnowledge(records, { dependencySnapshots: [{ repository: 'research-notes', profile: 'inquiry', records: inquiry }] }).reconsider.length, 0)
})

test('graph proposal traverses source to rationale through the real graph after explicit fixture admission', t => {
  const root = workspace(t), repo = path.join(root, 'corpus'); fs.mkdirSync(repo)
  const proposal = knowledge.knowledgeGraphProposal(K, { namespace: 'corpus', activationId: 'graph-use' })
  const schema = JSON.parse(fs.readFileSync(new URL('../contracts/atelier-claim.v1.schema.json', import.meta.url)))
  assert.equal(proposal.canonicalMutation, false)
  for (const claim of proposal.claims) { assert.deepEqual(validateJsonSchema(schema, claim), []); assert.equal(claim.promoted, false) }
  for (const file of proposal.files) {
    const id = /  id: "([^"]+)"/.exec(file.content)[1], relations = {}
    for (const claim of proposal.claims.filter(c => c.subject === id)) (relations[claim.predicate] ??= []).push(claim.object)
    const yaml = Object.entries(relations).flatMap(([key, values]) => [`    ${key}:`, ...values.map(v => `      - ${JSON.stringify(v)}`)]).join('\n')
    fs.writeFileSync(path.join(repo, file.path), yaml ? file.content.replace('  relations: {}', `  relations:\n${yaml}`) : file.content)
  }
  const built = buildKnowledgeGraph({ workspaceRoot: root, repoRoots: [repo], repoAccessConfig: { schema: REPO_ACCESS_SCHEMA, defaultReadBoundary: 'private', repos: { corpus: { readBoundary: 'private' } } } })
  assert.equal(built.ok, true, built.errors.join('\n'))
  const sourceId = 'corpus:knowledge-workshop-knowledge-observation', rationaleId = 'corpus:knowledge-workshop-knowledge-trial-rationale'
  assert.ok(built.workspaceGraph.edges.some(e => e.source === sourceId && e.type === 'evidences' && e.target === rationaleId))
  assert.ok(!built.workspaceGraph.edges.some(e => e.source === rationaleId && e.target === sourceId))
  assert.throws(() => knowledge.knowledgeGraphProposal([...K, example.withdrawal], { namespace: 'corpus', activationId: 'graph-use' }), /current activation/)
})

test('graph export preserves relation rationale, review and domain alongside a deduplicated edge', () => {
  const relation = get(K, 'justification'), review = K.find(r => r.kind === 'review' && r.data.target.id === relation.id)
  const proposal = knowledge.knowledgeGraphProposal(K, { namespace: 'corpus', activationId: 'graph-use' })
  const file = proposal.files.find(f => f.path === `${relation.id}.md`)
  assert.ok(file, 'accepted relation needs a durable evidence document')
  const evidence = JSON.parse(file.content.split(/`{3,}text\n/)[1].split(/\n`{3,}/)[0])
  assert.deepEqual(evidence.relation, relation)
  assert.deepEqual(evidence.review, review)
  assert.deepEqual(evidence.domain, K[0])
  const claim = proposal.claims.find(c => c.claimId === evidence.claimId)
  assert.ok(claim.evidence.includes(harness.harnessDigest(relation)))
  assert.ok(claim.evidence.includes(harness.harnessDigest(review)))
  assert.equal(proposal.claims.filter(c => c.subject === claim.subject && c.predicate === claim.predicate && c.object === claim.object).length, 1)
  assert.equal(claim.promoted, false)
})

test('local history refuses stale heads, tampering, interrupted replacement and redirected state', t => {
  const root = workspace(t), head = append(root, 'knowledge', K)
  const file = path.join(root, '.atelier-local/harnesses/knowledge/workshop-knowledge/ledger.json'), bytes = fs.readFileSync(file)
  assert.throws(() => harness.appendHarness({ workspaceRoot: root, profile: 'knowledge', record: example.withdrawal, confirm: harness.EMPTY_HARNESS_HEAD }), /current.*digest/)
  const rename = fs.renameSync; fs.renameSync = () => { throw new Error('synthetic interruption') }
  try { assert.throws(() => harness.appendHarness({ workspaceRoot: root, profile: 'knowledge', record: example.withdrawal, confirm: head }), /interruption/) } finally { fs.renameSync = rename }
  assert.deepEqual(fs.readFileSync(file), bytes)
  const altered = JSON.parse(bytes); altered.records[0].data.purpose += ' changed'; fs.writeFileSync(file, JSON.stringify(altered))
  assert.throws(() => harness.readHarness({ workspaceRoot: root, profile: 'knowledge', run: K[0].id }), /reference|integrity/)
  const other = workspace(t), external = workspace(t)
  fs.mkdirSync(path.join(other, '.atelier-local')); fs.symlinkSync(external, path.join(other, '.atelier-local/harnesses'))
  assert.throws(() => append(other, 'knowledge', [K[0]]), /redirected/)
  assert.equal(fs.existsSync(path.join(external, 'knowledge')), false)
})

test('CLI persists both workflows and preserves the existing build projection alias', t => {
  const root = workspace(t), file = path.join(root, 'input.json')
  const cli = args => spawnSync(process.execPath, [CLI, 'harness', ...args], { cwd: root, encoding: 'utf8' })
  for (const [profile, records] of [['knowledge', K], ['build', B]]) {
    let head = harness.EMPTY_HARNESS_HEAD
    for (const record of records) {
      fs.writeFileSync(file, JSON.stringify(record)); const r = cli([profile, 'append', '--record', file, '--confirm', head])
      assert.equal(r.status, 0, r.stdout + r.stderr); head = JSON.parse(r.stdout).head
    }
    const exported = cli([profile, 'export', '--run', records[0].id]); assert.equal(exported.status, 0)
    fs.writeFileSync(file, exported.stdout); assert.equal(cli(['inspect', '--profile', profile, '--history', file]).status, 0)
  }
  assert.equal(cli(['knowledge', 'export', '--run', 'missing']).status, 1)
  fs.writeFileSync(file, JSON.stringify(dependencies))
  const result = cli(['build', 'readiness', '--run', B[0].id, '--dependencies', file]); assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).readyReported, true)
  const code = "import {commandMap} from './src/cli/run.mjs'; if(commandMap.get('build')[0] !== 'src/commands/project.mjs') process.exit(1)"
  assert.equal(spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: new URL('..', import.meta.url).pathname }).status, 0)
})

test('example command runs from an installed path with spaces, hashes, percent signs and Unicode', t => {
  const root = workspace(t), installed = path.join(root, 'Atelier path # 100% café')
  fs.mkdirSync(installed)
  const source = new URL('..', import.meta.url)
  for (const directory of ['src', 'bin', 'contracts']) fs.cpSync(new URL(`${directory}/`, source), path.join(installed, directory), { recursive: true })
  fs.cpSync(new URL('fixtures/harnesses/', source), path.join(installed, 'fixtures/harnesses'), { recursive: true })
  fs.copyFileSync(new URL('package.json', source), path.join(installed, 'package.json'))
  fs.symlinkSync(fs.realpathSync(new URL('node_modules/', source)), path.join(installed, 'node_modules'))
  const result = JSON.parse(execFileSync(process.execPath, [path.join(installed, 'bin/atelier.mjs'), 'harness', 'example'], { encoding: 'utf8' }))
  assert.deepEqual(result.knowledge, K)
})

test('two host profiles adopt independent harness packages beside existing skills and retain exact feedback attribution', t => {
  const sources = ['knowledge-harness', 'build-harness'].map(n => new URL(`../fixtures/harness-packages/${n}`, import.meta.url).pathname)
  for (const [index, host] of ['codex-repo-v1', 'claude-repo-v1'].entries()) {
    const root = workspace(t)
    fs.mkdirSync(path.join(root, '.agents/skills/existing'), { recursive: true }); fs.writeFileSync(path.join(root, '.agents/skills/existing/SKILL.md'), 'Existing owner content')
    const releases = sources.map(packageRoot => capabilities.verifyCapabilityRelease({ packageRoot }))
    const adoption = { schema: 'mnstry.atelier-capability-adoption@v1', id: `consumer-${index}`, packages: releases.map(r => ({ id: r.package.id, digest: r.digest, mode: 'managed', bindings: [{ skill: 'harness', host, alias: r.package.skills[0].name }], allowedTools: ['atelier-harness-v1'], allowedEffects: ['read-workspace', 'write-workspace'] })) }
    const options = { workspaceRoot: root, adoption, sources, availableTools: ['atelier-harness-v1'] }
    const plan = capabilities.planCapabilityAdoption(options); assert.equal(plan.applyAllowed, true)
    const { state } = capabilities.applyCapabilityAdoption({ ...options, confirm: plan.planDigest })
    const pkg = state.packages.find(p => p.id.endsWith('/knowledge-harness')), binding = pkg.bindings[0]
    const provenance = { package: pkg.id, releaseDigest: pkg.release.digest, generation: state.generation, binding: binding.target, bindingDigest: binding.digest, host, session: 'fixture-session' }
    const records = transform(K, r => { if (r.kind === 'domain') r.data.binding = provenance })
    append(root, 'knowledge', records)
    const revision = clone(example.domainRevision); revision.data.supersedes = pin(records[0]); revision.data.binding = { ...provenance, generation: digest('later-generation') }
    const feedback = harness.prepareHarnessFeedback({ profile: 'knowledge', records: [...records, revision], subjectId: 'trial-rationale', id: 'feedback', outcome: 'unknown', cause: 'context', evidenceDigest: digest('fixture evidence'), at: records[0].at, by: 'synthetic-owner' })
    assert.equal(feedback.event.generation, provenance.generation)
    assert.equal(feedback.reportedCause, 'context'); assert.equal(feedback.event.cause, 'unknown'); assert.equal(feedback.recorded, false)
    capabilities.recordCapabilityEvent({ workspaceRoot: root, event: feedback.event })
    assert.throws(() => capabilities.recordCapabilityEvent({ workspaceRoot: root, event: { ...feedback.event, id: 'bad-generation', generation: digest('wrong') } }), /current installed binding/)
    assert.equal(fs.readFileSync(path.join(root, '.agents/skills/existing/SKILL.md'), 'utf8'), 'Existing owner content')
  }
})
