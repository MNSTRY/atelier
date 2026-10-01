import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ingestionDigest } from '../src/ingestion/contracts.mjs'
import { createIngestionStore } from '../src/ingestion/store.mjs'
import { SEMANTIC_CANDIDATE_VERSION, SemanticProposalError, prepareSemanticInput, prepareSemanticProposals, readSemanticProposals } from '../src/ingestion/semantic.mjs'

const fixture = JSON.parse(fs.readFileSync(new URL('../fixtures/atelier-ingestion/semantic-baseline.json', import.meta.url)))
const clone = value => structuredClone(value)
function reference(line) { return { sourceId: 'notes', sourceDigest: 'a'.repeat(64), attemptId: 'lines-attempt', locator: { kind: 'line', value: String(line) } } }
function sample() {
  const plan = { planId: 'plan-synthetic', planDigest: `sha256:${'b'.repeat(64)}` }
  const lines = fixture.sourceText.trimEnd().split('\n')
  const store = { getEvidence: request => ({ schema: 'mnstry.atelier-ingestion-evidence@v1', ...clone(request), ref: 'notes.txt', text: lines[Number(request.locator.value) - 1], freshness: 'current', integrity: 'verified', readScope: 'all-plan', semanticAcceptance: 'pending', synthesized: false }) }
  const input = prepareSemanticInput({ store, plan, domain: clone(fixture.domain), references: [1, 2, 3, 4].map(reference), identityCandidates: [] })
  const e = line => `span-${line}`
  const candidates = { schema: SEMANTIC_CANDIDATE_VERSION, inputDigest: input.digest,
    entities: [
      { id: 'nora', label: 'Nora', type: 'person', identity: { status: 'source-local', candidateIds: [] }, evidence: [e(1)] },
      { id: 'atlas-project', label: 'Atlas', type: 'project', identity: { status: 'source-local', candidateIds: [] }, evidence: [e(1)] },
      { id: 'atlas-organization', label: 'Atlas', type: 'organization', identity: { status: 'source-local', candidateIds: [] }, evidence: [e(3)] },
    ], assertions: [
      { id: 'management', subjectId: 'nora', predicate: 'manages', objectId: 'atlas-project', direction: 'subject-to-object', negated: false, modality: 'asserted', scope: fixture.domain.data.scope,
        time: { from: null, until: null, expression: 'through June', unknowns: ['year'] }, evidence: [{ id: e(1), quote: lines[0] }] },
      { id: 'nonownership', subjectId: 'nora', predicate: 'owns', objectId: 'atlas-project', direction: 'subject-to-object', negated: true, modality: 'asserted', scope: fixture.domain.data.scope,
        time: { from: null, until: null, expression: null, unknowns: [] }, evidence: [{ id: e(2), quote: lines[1] }] },
      { id: 'funding', subjectId: 'atlas-organization', predicate: 'funds', objectId: 'nora', direction: 'subject-to-object', negated: false, modality: 'asserted', scope: fixture.domain.data.scope,
        time: { from: null, until: null, expression: null, unknowns: [] }, evidence: [{ id: e(3), quote: lines[2] }] },
    ], unknowns: [{ id: 'unknown-role', relatedCandidateId: null, reason: 'Role meaning is not supplied.', evidence: [e(4)] }] }
  return { store, plan, input, candidates }
}
function refuses(change, code) {
  const s = sample(); change(s)
  assert.throws(() => prepareSemanticProposals(s), error => error instanceof SemanticProposalError && error.code === code && error.refusalCount === 1)
}
test('semantic proposals retain duplicate labels, directed parallel assertions, polarity, scope, partial time, and unknowns', () => {
  const s = sample(), before = clone(s.candidates)
  const p = prepareSemanticProposals(s)
  assert.equal(p.entities.filter(e => e.label === 'Atlas').length, 2)
  assert.equal(p.assertions[1].negated, true)
  assert.equal(p.assertions[2].subjectId, 'atlas-organization')
  assert.deepEqual(p.assertions[0].time.unknowns, ['year'])
  assert.equal(p.unknowns.length, 1); assert.equal(p.counts.abstentions, 1); assert.equal(p.counts.refusals, 0)
  assert.equal(p.authority, 'none'); assert.equal(p.semanticAcceptance, 'pending')
  assert.deepEqual(s.candidates, before)
  assert.equal(p.assertions[0].evidence[0].sourceDigest, 'a'.repeat(64))
})
const failures = [
  ['unique identity', s => { s.candidates.unknowns[0].id = 'nora' }, 'SEMANTIC_IDENTITY'],
  ['identity status', s => { s.candidates.entities[0].identity = { status: 'existing-candidate', candidateIds: [] } }, 'SEMANTIC_IDENTITY'],
  ['unsupported identity status', s => { s.candidates.entities[0].identity.status = 'unmodeled' }, 'SEMANTIC_IDENTITY'],
  ['identity candidate mapping', s => { s.candidates.entities[0].identity = { status: 'existing-candidate', candidateIds: ['unsupplied'] } }, 'SEMANTIC_IDENTITY'],
  ['type mapping', s => { s.candidates.entities[0].type = 'unmodeled' }, 'SEMANTIC_TYPE'],
  ['predicate mapping', s => { s.candidates.assertions[0].predicate = 'unmodeled' }, 'SEMANTIC_PREDICATE'],
  ['endpoint identity', s => { s.candidates.assertions[0].subjectId = 'missing' }, 'SEMANTIC_IDENTITY'],
  ['direction', s => { s.candidates.assertions[0].direction = 'object-to-subject' }, 'SEMANTIC_DIRECTION'],
  ['negation', s => { s.candidates.assertions[1].negated = 'false' }, 'SEMANTIC_NEGATION'],
  ['modality', s => { s.candidates.assertions[0].modality = 'definite' }, 'SEMANTIC_MODALITY'],
  ['scope', s => { s.candidates.assertions[0].scope = 'Another project' }, 'SEMANTIC_SCOPE'],
  ['calendar date', s => { s.candidates.assertions[0].time.from = '2026-02-30' }, 'SEMANTIC_TIME'],
  ['interval order', s => { s.candidates.assertions[0].time = { from: '2026-07-01', until: '2026-06-01', expression: null, unknowns: [] } }, 'SEMANTIC_TIME'],
  ['unstated temporal interpretation', s => { s.candidates.assertions[0].time.unknowns = [] }, 'SEMANTIC_TIME'],
  ['located temporal expression', s => { s.candidates.assertions[0].time.expression = 'December' }, 'SEMANTIC_TIME'],
  ['explicit unknown', s => { s.candidates.unknowns[0].reason = '' }, 'SEMANTIC_UNKNOWN'],
  ['unknown related identity', s => { s.candidates.unknowns[0].relatedCandidateId = 'missing' }, 'SEMANTIC_UNKNOWN'],
  ['request binding', s => { s.candidates.inputDigest = `sha256:${'c'.repeat(64)}` }, 'SEMANTIC_BINDING'],
  ['missing evidence', s => { s.candidates.assertions[0].evidence[0].id = 'span-absent' }, 'SEMANTIC_EVIDENCE'],
  ['empty entity support', s => { s.candidates.entities[0].evidence = [] }, 'SEMANTIC_EVIDENCE'],
  ['empty assertion support', s => { s.candidates.assertions[2].evidence = [] }, 'SEMANTIC_EVIDENCE'],
  ['empty unknown support', s => { s.candidates.unknowns[0].evidence = [] }, 'SEMANTIC_EVIDENCE'],
  ['duplicate support', s => { s.candidates.entities[0].evidence = ['span-1', 'span-1'] }, 'SEMANTIC_EVIDENCE'],
  ['unsupported quote', s => { s.candidates.assertions[0].evidence[0].quote = 'Unsupported invented text.' }, 'SEMANTIC_EVIDENCE'],
  ['unary direction', s => { s.candidates.assertions[0].direction = 'subject-only' }, 'SEMANTIC_DIRECTION'],
]
for (const [rule, mutation, code] of failures) test(`semantic refusal checks ${rule}`, () => refuses(mutation, code))
test('mutation controls prove each candidate refusal oracle detects a disabled rule', async () => {
  const source = fs.readFileSync(new URL('../src/ingestion/semantic.mjs', import.meta.url), 'utf8')
    .replace("'./contracts.mjs'", JSON.stringify(new URL('../src/ingestion/contracts.mjs', import.meta.url).href))
    .replace("'../harnesses/contracts.mjs'", JSON.stringify(new URL('../src/harnesses/contracts.mjs', import.meta.url).href))
  const guard = 'if (!condition) throw new SemanticProposalError(code, message)'
  assert.ok(source.includes(guard), 'Mutation must target the actual refusal guard')
  const original = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
  const messages = {
    'unique identity': 'Unique source-local candidate identities are required',
    'identity status': 'Identity status and candidates differ',
    'unsupported identity status': 'Explicit candidate identity status is required',
    'identity candidate mapping': 'Identity mappings must use supplied matching candidates',
    'type mapping': 'Entity type and label must fit the supplied domain',
    'predicate mapping': 'Unmodeled predicates must remain explicit findings',
    'endpoint identity': 'Assertion endpoints must resolve to supplied entities',
    direction: 'Unary or directed binary roles must match the supplied endpoints',
    negation: 'Explicit Boolean negation is required',
    modality: 'Explicit supported modality is required',
    scope: 'Assertion scope differs from its supplied domain',
    'calendar date': 'Valid ordered calendar dates are required',
    'interval order': 'Valid ordered calendar dates are required',
    'unstated temporal interpretation': 'Unresolved temporal expressions must preserve their unknowns',
    'located temporal expression': 'A temporal expression must be located in its cited passage',
    'explicit unknown': 'An explicit finding reason and valid optional subject are required',
    'unknown related identity': 'An explicit finding reason and valid optional subject are required',
    'request binding': 'Candidates must bind the exact extractor input',
    'missing evidence': 'Supporting evidence must resolve uniquely',
    'empty entity support': 'At least one bounded supporting span is required',
    'empty assertion support': 'At least one bounded supporting span is required',
    'empty unknown support': 'At least one bounded supporting span is required',
    'duplicate support': 'Supporting evidence must resolve uniquely',
    'unsupported quote': 'The quote must occur in the declared span',
    'unary direction': 'Unary or directed binary roles must match the supplied endpoints',
  }
  for (const [rule, change, code] of failures) {
    const message = messages[rule]
    assert.equal(source.split(JSON.stringify(message).replaceAll('"', "'")).length, 2, 'Target one existing rule, not all rules sharing a code')
    const modified = source.replace(guard, `if (!condition && message !== ${JSON.stringify(message)}) throw new SemanticProposalError(code, message)`)
    const mutant = await import(`data:text/javascript;base64,${Buffer.from(modified).toString('base64')}`)
    const s = sample(); change(s)
    assert.throws(() => original.prepareSemanticProposals(s), e => e instanceof original.SemanticProposalError && e.code === code, 'The original rule must satisfy the same oracle')
    const oracle = () => assert.throws(() => mutant.prepareSemanticProposals(s), e => e instanceof mutant.SemanticProposalError && e.code === code)
    assert.throws(oracle, e => e.code === 'ERR_ASSERTION', `Refusal oracle must fail when ${rule} is disabled`)
  }
})

test('receipt binding, saved-proposal binding and search mutants defeat their respective oracles', async () => {
  const source = fs.readFileSync(new URL('../src/ingestion/semantic.mjs', import.meta.url), 'utf8')
    .replace("'./contracts.mjs'", JSON.stringify(new URL('../src/ingestion/contracts.mjs', import.meta.url).href))
    .replace("'../harnesses/contracts.mjs'", JSON.stringify(new URL('../src/harnesses/contracts.mjs', import.meta.url).href))
  const guard = 'if (!condition) throw new SemanticProposalError(code, message)'
  const load = modified => import(`data:text/javascript;base64,${Buffer.from(modified).toString('base64')}`)
  const binding = await load(source.replace(guard, 'if (!condition && message !== "Evidence differs from its requested binding") throw new SemanticProposalError(code, message)'))
  for (const changed of [{ planId: 'foreign-plan' }, { planDigest: `sha256:${'c'.repeat(64)}` }, { sourceId: 'foreign-source' },
    { sourceDigest: 'd'.repeat(64) }, { attemptId: 'foreign-attempt' }]) {
    const s = sample(), native = s.store.getEvidence
    s.store.getEvidence = request => ({ ...native(request), ...changed })
    const selected = { ...s, domain: fixture.domain, references: [reference(1)] }
    assert.throws(() => prepareSemanticInput(selected), e => e.code === 'SEMANTIC_BINDING')
    assert.throws(() => assert.throws(() => binding.prepareSemanticInput(selected), e => e.code === 'SEMANTIC_BINDING'), e => e.code === 'ERR_ASSERTION')
  }
  const locator = await load(source.replace(guard, 'if (!condition && message !== "Evidence locator differs from its requested binding") throw new SemanticProposalError(code, message)'))
  const s = sample(), native = s.store.getEvidence
  s.store.getEvidence = request => ({ ...native(request), locator: { kind: 'line', value: '2' } })
  const selected = { ...s, domain: fixture.domain, references: [reference(1)] }
  assert.throws(() => prepareSemanticInput(selected), e => e.code === 'SEMANTIC_BINDING')
  assert.throws(() => assert.throws(() => locator.prepareSemanticInput(selected), e => e.code === 'SEMANTIC_BINDING'), e => e.code === 'ERR_ASSERTION')
  const clean = sample(), proposals = prepareSemanticProposals(clean)
  proposals.assertions[0].negated = true
  const saved = await load(source.replace(guard, 'if (!condition && message !== "The proposal view differs from its validated candidates") throw new SemanticProposalError(code, message)'))
  assert.throws(() => readSemanticProposals({ ...clean, proposals, query: 'Nora' }), e => e.code === 'SEMANTIC_BINDING')
  assert.throws(() => assert.throws(() => saved.readSemanticProposals({ ...clean, proposals, query: 'Nora' }), e => e.code === 'SEMANTIC_BINDING'), e => e.code === 'ERR_ASSERTION')
  const filter = await load(source.replace('return terms.every(term => description.includes(term))', 'return true || terms.every(term => description.includes(term))'))
  const current = prepareSemanticProposals(clean)
  assert.deepEqual(readSemanticProposals({ ...clean, proposals: current, query: 'June' }).assertions.map(a => a.id), ['management'])
  assert.throws(() => assert.deepEqual(filter.readSemanticProposals({ ...clean, proposals: current, query: 'June' }).assertions.map(a => a.id), ['management']), e => e.code === 'ERR_ASSERTION')
})

test('input source and unique reference controls discriminate their exact guards', async () => {
  const source = fs.readFileSync(new URL('../src/ingestion/semantic.mjs', import.meta.url), 'utf8')
    .replace("'./contracts.mjs'", JSON.stringify(new URL('../src/ingestion/contracts.mjs', import.meta.url).href))
    .replace("'../harnesses/contracts.mjs'", JSON.stringify(new URL('../src/harnesses/contracts.mjs', import.meta.url).href))
  const guard = 'if (!condition) throw new SemanticProposalError(code, message)'
  const cases = [
    [[reference(1), { ...reference(2), sourceId: 'another-source' }], 'SEMANTIC_SCOPE', 'The first semantic profile processes one source per input'],
    [[reference(1), reference(1)], 'SEMANTIC_EVIDENCE', 'Duplicate evidence references are refused'],
  ]
  for (const [references, code, message] of cases) {
    const selected = { ...sample(), domain: fixture.domain, references }
    assert.throws(() => prepareSemanticInput(selected), e => e instanceof SemanticProposalError && e.code === code)
    assert.equal(source.split(`'${message}'`).length, 2)
    const mutant = await import(`data:text/javascript;base64,${Buffer.from(source.replace(guard, `if (!condition && message !== ${JSON.stringify(message)}) throw new SemanticProposalError(code, message)`)).toString('base64')}`)
    assert.throws(() => assert.throws(() => mutant.prepareSemanticInput(selected), e => e.code === code), e => e.code === 'ERR_ASSERTION')
  }
})

test('the assertion quote cap has a discriminating oracle below the hydrated byte ceiling', async () => {
  const s = sample(), native = s.store.getEvidence, quote = 'x'.repeat(65537)
  s.store.getEvidence = request => ({ ...native(request), text: request.locator.value === '2' ? quote : 'Nora and Atlas.' })
  s.input = prepareSemanticInput({ ...s, domain: fixture.domain, references: [reference(1), reference(2)] })
  s.candidates.inputDigest = s.input.digest
  s.candidates.entities = [s.candidates.entities[0], s.candidates.entities[2]]
  s.candidates.entities.forEach(entity => { entity.evidence = ['span-1'] })
  s.candidates.assertions = [{ ...s.candidates.assertions[2], evidence: [{ id: 'span-2', quote }] }]
  s.candidates.unknowns = []
  assert.throws(() => prepareSemanticProposals(s), e => e.code === 'SEMANTIC_LIMIT')
  const source = fs.readFileSync(new URL('../src/ingestion/semantic.mjs', import.meta.url), 'utf8')
    .replace("'./contracts.mjs'", JSON.stringify(new URL('../src/ingestion/contracts.mjs', import.meta.url).href))
    .replace("'../harnesses/contracts.mjs'", JSON.stringify(new URL('../src/harnesses/contracts.mjs', import.meta.url).href))
  assert.equal(source.split('string(quote, 65536)').length, 2)
  const mutant = await import(`data:text/javascript;base64,${Buffer.from(source.replace('string(quote, 65536)', 'string(quote, 65537)')).toString('base64')}`)
  const admitted = mutant.prepareSemanticProposals(s)
  assert.ok(Buffer.byteLength(JSON.stringify(admitted)) < 256 * 1024)
  assert.throws(() => assert.throws(() => mutant.prepareSemanticProposals(s), e => e.code === 'SEMANTIC_LIMIT'), e => e.code === 'ERR_ASSERTION')
})

test('malformed top-level collections retain shape codes instead of capacity codes', () => {
  for (const field of ['entities', 'assertions', 'unknowns']) for (const value of [null, {}, 'not-an-array']) {
    const s = sample(); s.candidates[field] = value
    assert.throws(() => prepareSemanticProposals(s), e => e.code === 'SEMANTIC_INVALID')
  }
  const s = sample(), options = { ...s, domain: fixture.domain, references: [reference(1)] }
  assert.throws(() => prepareSemanticInput({ ...options, references: null }), e => e.code === 'SEMANTIC_INVALID')
  assert.throws(() => prepareSemanticInput({ ...options, identityCandidates: null }), e => e.code === 'SEMANTIC_IDENTITY')
})

test('evidence reader cannot rewrite the requested locator and missing locators are typed refusals', () => {
  const s = sample(), native = s.store.getEvidence, options = { ...s, domain: fixture.domain, references: [reference(1)] }
  s.store.getEvidence = request => { request.locator.value = '2'; return native(request) }
  assert.throws(() => prepareSemanticInput(options), e => e.code === 'SEMANTIC_BINDING')
  assert.equal(options.references[0].locator.value, '1')
  s.store.getEvidence = request => { const result = native(request); delete result.locator; return result }
  assert.throws(() => prepareSemanticInput(options), e => e instanceof SemanticProposalError && e.code === 'SEMANTIC_EVIDENCE')
  for (const receipt of [null, [], 'not-a-receipt']) {
    s.store.getEvidence = () => receipt
    assert.throws(() => prepareSemanticInput(options), e => e instanceof SemanticProposalError && e.code === 'SEMANTIC_EVIDENCE')
  }
})
test('semantic input refuses a narrower read scope and foreign evidence bindings', () => {
  const s = sample(), native = s.store.getEvidence
  s.store.getEvidence = request => ({ ...native(request), readScope: 'subset' })
  assert.throws(() => prepareSemanticInput({ ...s, domain: fixture.domain, references: [reference(1)] }), e => e.code === 'SEMANTIC_READ_SCOPE')
  s.store.getEvidence = request => ({ ...native(request), sourceDigest: 'd'.repeat(64) })
  assert.throws(() => prepareSemanticInput({ ...s, domain: fixture.domain, references: [reference(1)] }), e => e.code === 'SEMANTIC_BINDING')
})

test('direct semantic input checks every returned plan, source, attempt and locator binding', () => {
  for (const changed of [{ planId: 'foreign-plan' }, { planDigest: `sha256:${'c'.repeat(64)}` },
    { sourceId: 'foreign-source' }, { sourceDigest: 'd'.repeat(64) }, { attemptId: 'foreign-attempt' },
    { locator: { kind: 'line', value: '2' } }]) {
    const s = sample(), native = s.store.getEvidence
    s.store.getEvidence = request => ({ ...native(request), ...changed })
    assert.throws(() => prepareSemanticInput({ ...s, domain: fixture.domain, references: [reference(1)] }), e => e.code === 'SEMANTIC_BINDING')
  }
})

test('semantic saved proposal tampering and null values produce typed refusals', () => {
  const s = sample(), proposals = prepareSemanticProposals(s)
  proposals.assertions[0].negated = true
  assert.throws(() => readSemanticProposals({ ...s, proposals, query: 'Nora' }), e => e.code === 'SEMANTIC_BINDING')
  assert.throws(() => readSemanticProposals({ ...s, proposals: null, query: 'Nora' }), e => e instanceof SemanticProposalError && e.code === 'SEMANTIC_INVALID')
})

test('semantic count bounds refuse references, identity candidates, and every candidate collection', () => {
  const s = sample()
  for (const field of ['references', 'identityCandidates']) {
    const selected = { ...s, domain: fixture.domain, references: [reference(1)], identityCandidates: [] }
    selected[field] = Array.from({ length: 65 }, (_, i) => field === 'references' ? reference(i + 1) : { id: `person-${i}`, label: 'Nora', type: 'person' })
    assert.throws(() => prepareSemanticInput(selected), e => e.code === 'SEMANTIC_LIMIT')
  }
  for (const field of ['entities', 'assertions', 'unknowns']) {
    const selected = sample()
    selected.candidates[field] = Array.from({ length: 65 }, (_, i) => ({ ...clone(selected.candidates[field][0]), id: `candidate-${i}` }))
    assert.throws(() => prepareSemanticProposals(selected), e => e.code === 'SEMANTIC_LIMIT')
  }
})

test('semantic support, identity alternatives and temporal unknown bounds use SEMANTIC_LIMIT', () => {
  const changes = [
    s => { s.candidates.entities[0].evidence = Array.from({ length: 17 }, () => 'span-1') },
    s => { s.candidates.assertions[0].evidence = Array.from({ length: 17 }, () => clone(s.candidates.assertions[0].evidence[0])) },
    s => { s.candidates.unknowns[0].evidence = Array.from({ length: 17 }, () => 'span-1') },
    s => { s.candidates.entities[0].identity = { status: 'existing-candidate', candidateIds: Array.from({ length: 17 }, (_, i) => `person-${i}`) } },
    s => { s.candidates.assertions[0].time.unknowns = Array.from({ length: 17 }, () => 'year') },
  ]
  for (const change of changes) refuses(change, 'SEMANTIC_LIMIT')
})

test('semantic per-field text, depth, member, empty-input and locator bounds refuse', () => {
  for (const changed of [s => { s.candidates.unknowns[0].reason = 'x'.repeat(8193) },
    s => { s.candidates.assertions[0].time.expression = 'x'.repeat(8193) },
    s => { s.candidates.assertions[0].time.unknowns = ['x'.repeat(8193)] }]) refuses(changed, 'SEMANTIC_LIMIT')
  const s = sample(), options = { ...s, domain: fixture.domain, references: [reference(1)] }
  assert.throws(() => prepareSemanticInput({ ...options, references: [] }), e => e.code === 'SEMANTIC_EVIDENCE')
  for (const fields of [{ plan: { ...s.plan, planId: 'x'.repeat(257) } },
    { references: [{ ...reference(1), attemptId: 'x'.repeat(257) }] },
    { references: [{ ...reference(1), locator: { kind: 'line', value: 'x'.repeat(16385) } }] },
    { identityCandidates: [{ id: 'person-one', label: 'x'.repeat(8193), type: 'person' }] }]) {
    assert.throws(() => prepareSemanticInput({ ...options, ...fields }), e => e.code === 'SEMANTIC_LIMIT')
  }
  const native = s.store.getEvidence
  s.store.getEvidence = request => ({ ...native(request), ref: 'x'.repeat(16385) })
  assert.throws(() => prepareSemanticInput(options), e => e.code === 'SEMANTIC_LIMIT')
  const nested = sample(); let value = 'deep'
  for (let i = 0; i < 30; i++) value = { value }
  nested.candidates.extra = value
  assert.throws(() => prepareSemanticProposals(nested), e => e.code === 'SEMANTIC_LIMIT')
  const members = sample()
  members.candidates.extra = Object.fromEntries(Array.from({ length: 4097 }, (_, i) => [`entry-${i}`, i]))
  assert.throws(() => prepareSemanticProposals(members), e => e.code === 'SEMANTIC_LIMIT')
  assert.throws(() => prepareSemanticInput({ ...options, plan: { 'planDigest,planId': 'not-a-plan' } }), e => e.code === 'SEMANTIC_INVALID')
})

test('semantic query, result, text and byte bounds are typed limits', () => {
  const s = sample(), proposals = prepareSemanticProposals(s)
  assert.throws(() => readSemanticProposals({ ...s, proposals, query: 'x'.repeat(513) }), e => e.code === 'SEMANTIC_LIMIT')
  for (const limit of [0, 65]) assert.throws(() => readSemanticProposals({ ...s, proposals, query: 'Nora', limit }), e => e.code === 'SEMANTIC_LIMIT')
  for (const limit of [1.5, null, '5']) assert.throws(() => readSemanticProposals({ ...s, proposals, query: 'Nora', limit }), e => e.code === 'SEMANTIC_INVALID')
  refuses(s => { s.candidates.entities[0].label = 'x'.repeat(8193) }, 'SEMANTIC_LIMIT')
  refuses(s => { s.candidates.unknowns[0].reason = 'x'.repeat(256 * 1024) }, 'SEMANTIC_LIMIT')
  const native = s.store.getEvidence
  s.store.getEvidence = request => ({ ...native(request), text: 'x'.repeat(256 * 1024) })
  assert.throws(() => prepareSemanticInput({ ...s, domain: fixture.domain, references: [reference(1)] }), e => e.code === 'SEMANTIC_LIMIT')
})

test('semantic assembled input and hydrated proposal byte ceilings are checked', () => {
  const s = sample(), native = s.store.getEvidence
  s.store.getEvidence = request => ({ ...native(request), text: 'x'.repeat(5000) })
  assert.throws(() => prepareSemanticInput({ ...s, domain: fixture.domain,
    references: Array.from({ length: 64 }, (_, i) => reference(i + 1)) }), e => e.code === 'SEMANTIC_LIMIT')
  s.input = prepareSemanticInput({ ...s, domain: fixture.domain, references: [reference(1)] })
  s.candidates = { schema: SEMANTIC_CANDIDATE_VERSION, inputDigest: s.input.digest,
    entities: Array.from({ length: 64 }, (_, i) => ({ id: `person-${i}`, label: 'Nora', type: 'person', identity: { status: 'source-local', candidateIds: [] }, evidence: ['span-1'] })), assertions: [], unknowns: [] }
  assert.throws(() => prepareSemanticProposals(s), e => e.code === 'SEMANTIC_LIMIT')
})

test('semantic literal search excludes metadata and endpoint evidence from other assertions', () => {
  const s = sample(), proposals = prepareSemanticProposals(s)
  const matches = query => readSemanticProposals({ ...s, proposals, query }).assertions.map(a => a.id)
  assert.deepEqual(matches('funds'), ['funding'])
  assert.deepEqual(matches('June'), ['management'])
  assert.deepEqual(matches('manages'), ['management'])
  assert.deepEqual(matches('invented'), [])
  assert.deepEqual(matches('proposalAcceptance'), [])
  assert.deepEqual(matches('a'.repeat(64)), [])
  assert.equal(readSemanticProposals({ ...s, proposals, query: 'unmatched' }).entities.length, 3)
  assert.equal(readSemanticProposals({ ...s, proposals, query: 'unmatched' }).unknowns.length, 1)
})

test('semantic search matches literal quotes and backslashes without JSON escaping', () => {
  const s = sample()
  s.candidates.entities[0].label = 'Nora "N" \\ reader'
  const proposals = prepareSemanticProposals(s)
  assert.equal(readSemanticProposals({ ...s, proposals, query: '"N" \\' }).assertions.length, 3)
})
test('semantic input refuses ambiguous vocabulary IDs and unqualified evidence receipts', () => {
  const s = sample(), domain = clone(fixture.domain)
  domain.data.vocabulary.types.push(clone(domain.data.vocabulary.types[0]))
  assert.throws(() => prepareSemanticInput({ ...s, domain, references: [reference(1)] }), e => e.code === 'SEMANTIC_PROFILE')
  const relations = clone(fixture.domain)
  relations.data.vocabulary.relations.push(clone(relations.data.vocabulary.relations[0]))
  assert.throws(() => prepareSemanticInput({ ...s, domain: relations, references: [reference(1)] }), e => e.code === 'SEMANTIC_PROFILE')
  const native = s.store.getEvidence
  for (const change of [{ ref: '' }, { semanticAcceptance: 'accepted' }]) {
    s.store.getEvidence = request => ({ ...native(request), ...change })
    assert.throws(() => prepareSemanticProposals(s), e => e.code === 'SEMANTIC_EVIDENCE')
  }
})
test('semantic proposals preserve a negative unary assertion and possible modality without fabricating an object', () => {
  const s = sample(), candidates = s.candidates
  s.input = prepareSemanticInput({ ...s, domain: fixture.domain, references: [1, 2, 3, 4, 5, 6].map(reference) })
  candidates.inputDigest = s.input.digest
  candidates.assertions[1].predicate = 'available'; candidates.assertions[1].objectId = null; candidates.assertions[1].direction = 'subject-only'
  candidates.assertions[1].evidence = [{ id: 'span-5', quote: 'Nora is not available on Friday.' }]
  candidates.assertions[1].time = { from: null, until: null, expression: 'Friday', unknowns: ['calendar-date'] }
  candidates.assertions[2].modality = 'possible'; candidates.assertions[2].evidence = [{ id: 'span-6', quote: 'The Atlas organization may fund Nora.' }]
  const proposals = prepareSemanticProposals(s)
  assert.equal(proposals.assertions[1].objectId, null)
  assert.equal(proposals.assertions[1].negated, true)
  assert.deepEqual(proposals.assertions[1].time.unknowns, ['calendar-date'])
  assert.equal(proposals.assertions[2].modality, 'possible')
  assert.equal(readSemanticProposals({ ...s, proposals, query: 'Nora' }).assertions.length, 3)
})
test('semantic input refuses accessors and stale input rather than admitting partial output', () => {
  const s = sample(), bad = {}; let calls = 0
  Object.defineProperty(bad, 'schema', { enumerable: true, get() { calls++; return SEMANTIC_CANDIDATE_VERSION } })
  assert.throws(() => prepareSemanticProposals({ ...s, candidates: bad }), e => e.code === 'SEMANTIC_INVALID')
  assert.equal(calls, 0)
  s.store.getEvidence = () => { throw Object.assign(new Error('Changed source'), { code: 'INGESTION_STALE' }) }
  assert.throws(() => prepareSemanticProposals(s), e => e.code === 'SEMANTIC_STALE')
})
test('semantic read model keeps qualifications and rechecks current source before returning a view', () => {
  const s = sample(), proposals = prepareSemanticProposals(s)
  const view = readSemanticProposals({ ...s, proposals, query: 'Nora Atlas', limit: 2 })
  assert.equal(view.assertions.length, 2); assert.equal(view.totalMatched, 3); assert.equal(view.omitted, 1)
  assert.equal(view.synthesized, false); assert.equal(view.authority, 'none')
  s.store.getEvidence = () => { throw Object.assign(new Error('Changed source'), { code: 'INGESTION_STALE' }) }
  assert.throws(() => readSemanticProposals({ ...s, proposals, query: 'Atlas' }), e => e.code === 'SEMANTIC_STALE')
})
test('semantic input and proposals consume real all-plan getEvidence and refuse an edited original', { skip: process.platform === 'win32' ? 'Durable intake uses the qualified POSIX reference profile.' : false }, t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-semantic-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', root]); fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n'); fs.writeFileSync(path.join(root, 'notes.txt'), fixture.sourceText)
  const store = createIngestionStore({ workspaceRoot: root, workspaceId: 'components' })
  const plan = store.plan({ sources: [{ id: 'notes', ref: 'notes.txt' }], scope: { project: 'components', activity: 'research' }, purpose: 'Inspect invented component support.', budget: { maxInputBytes: 10000, maxOutputBytes: 20000, maxAttempts: 1 } })
  store.run({ planId: plan.planId, planDigest: plan.planDigest })
  const item = store.status({ planId: plan.planId, planDigest: plan.planDigest }).items[0]
  const references = [1, 2, 3, 4].map(line => ({ sourceId: item.id, sourceDigest: item.sourceDigest, attemptId: item.attemptId, locator: { kind: 'line', value: String(line) } }))
  const input = prepareSemanticInput({ store, plan: { planId: plan.planId, planDigest: plan.planDigest }, domain: fixture.domain, references })
  const candidates = sample().candidates; candidates.inputDigest = input.digest
  assert.equal(prepareSemanticProposals({ store, input, candidates }).assertions.length, 3)
  fs.writeFileSync(path.join(root, 'notes.txt'), fixture.sourceText.replace('June', 'July'))
  assert.throws(() => prepareSemanticProposals({ store, input, candidates }), e => e.code === 'SEMANTIC_STALE')
})
