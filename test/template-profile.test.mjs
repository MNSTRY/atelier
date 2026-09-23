import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { templateReference, validateTemplateDefinition, validateTemplateBinding,
  validateTemplateRelease, validateTemplateHost, validateTemplateDecision } from '../src/templates/profile.mjs'
import { decisionRequestDigest } from '../src/decisions/contracts.mjs'

const sample = JSON.parse(fs.readFileSync(new URL('../fixtures/templates/local-library.v1.json', import.meta.url), 'utf8'))
const clone = value => structuredClone(value)
const makeRef = (kind, id, document) => templateReference(kind, id, '1.0.0', document)
function fixture() {
  const profile = clone(sample), records = []
  const record = (kind, id, document) => {
    const ref = makeRef(kind, id, document)
    records.push({ ref, document }); return ref
  }
  const sources = [record('SourceRef', 'source.a', { text: 'An invented red kite.' }), record('SourceRef', 'source.b', { text: 'An invented blue boat.' })]
  const templateRef = makeRef('TemplateRef', profile.id, profile)
  const binding = { schema: 'atelier-template-binding@v1', id: 'sample.binding', version: '1.0.0', templateRef, projectRef: 'sample.project', roles: [{ roleRef: 'items', sourceRefs: sources }] }
  const bindingRef = makeRef('BindingRef', binding.id, binding)
  const policyRef = record('PolicyRef', 'policy.synthetic', { posture: 'synthetic-only' })
  const authorityRef = record('AuthorityDecisionRef', 'decision.synthetic', { authority: 'no-real-approval' })
  const capabilityRef = record('CapabilityRef', 'capability.synthetic', { proof: 'synthetic-declaration-only' })
  const projections = ['web', 'documents'].map(carrier => {
    const projection = { schema: 'atelier-template-projection@v1', id: `projection.${carrier}`, version: '1.0.0', templateRef, bindingRef, carrier, sourceRefs: sources, policyRefs: [policyRef], authorityDecisionRefs: [authorityRef], capabilityRef,
      payloadRef: record('PayloadRef', `payload.${carrier}`, { text: 'Synthetic preview' }) }
    return record('ProjectionRef', projection.id, projection)
  })
  const release = { schema: 'atelier-template-release@v1', id: 'release.synthetic', version: '1.0.0', templateRef, bindingRef, projectionRefs: projections }
  const host = { schema: 'atelier-template-host@v1', templateRef, carrier: 'web', atelierVersion: '0.2.0-alpha.7', packRefs: [], semanticPrimitives: ['Resource', 'Collection'], surfacePrimitives: ['CollectionView', 'StatusView'], runtimeProfileRef: null, optionalDecisions: [] }
  return { profile, binding, release, host, records, record }
}
const releaseCheck = f => validateTemplateRelease(f.profile, f.binding, f.release, f.records)
const bindingCheck = f => validateTemplateBinding(f.profile, f.binding, f.records)
const hostCheck = f => validateTemplateHost(f.profile, f.host)
function refused(result, message) {
  assert.equal(result.ok, false, JSON.stringify(result))
  if (message) assert.ok(result.errors.includes(message), JSON.stringify(result))
  assert.equal(result.executionAuthority, false)
  assert.equal(result.publicationAuthority, false)
}

test('four stages remain distinct and cannot confer execution or publication authority', () => {
  const f = fixture()
  for (const result of [validateTemplateDefinition(f.profile), bindingCheck(f), releaseCheck(f), hostCheck(f)]) {
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.authority, 'structural-only')
    assert.equal(result.executionAuthority, false)
    assert.equal(result.publicationAuthority, false)
  }
  assert.equal(validateTemplateDefinition(sample).ok, true)
  refused(validateTemplateBinding(sample, {}))
  assert.deepEqual(hostCheck(f).diagnostics, [{ id: 'reading-priority', status: 'absent', fallback: 'deterministic-or-manual', invocationAuthorized: false }])
})

for (const [name, mutate, reason] of [
  ['renderer in semantic grammar', p => { p.semanticRoles[0].renderer = 'custom' }],
  ['command in runtime declaration', p => { p.commands = ['execute'] }],
  ['embedded project content', p => { p.semanticRoles[0].content = 'text' }],
  ['unknown primitive', p => { p.semanticRoles[0].primitive = 'CulturalAuthority' }],
  ['duplicate semantic role', p => { p.semanticRoles.push({ ...p.semanticRoles[0], primitive: 'Facet' }) }, 'duplicate semantic role'],
  ['dangling surface role', p => { p.surfaceRoles[0].semanticRoleRefs = ['missing'] }, 'dangling surface semantic role'],
  ['duplicate carrier', p => { p.carriers.push({ id: 'web', required: false }) }, 'duplicate carrier'],
  ['required decision provider', p => { p.optionalDecisions[0].required = true }],
  ['vendor-specific decision selector', p => { p.optionalDecisions[0].provider = 'vendor' }],
  ['content release confused with template', p => { p.runtimeProfileRef = makeRef('ReleaseRef', 'x', {}) }],
]) test(`definition refuses ${name}`, () => { const p = clone(sample); mutate(p); refused(validateTemplateDefinition(p), reason) })

test('unknown required extension refuses; optional opaque extension remains inert and digest-bound', () => {
  const f = fixture()
  f.profile.extensions.push({ namespace: 'sample.notes', required: true, schemaRef: f.record('SchemaRef', 'sample.schema', { type: 'string' }), payloadRef: f.record('PayloadRef', 'sample.notes', 'annotation') })
  refused(validateTemplateDefinition(f.profile), 'required extension unsupported')
  f.profile.extensions[0].required = false
  assert.equal(validateTemplateDefinition(f.profile).ok, true)
  f.binding.templateRef = makeRef('TemplateRef', f.profile.id, f.profile)
  assert.equal(bindingCheck(f).ok, true)
  f.records.pop()
  refused(bindingCheck(f), 'dangling exact reference')
})

for (const [name, mutate, reason] of [
  ['stale template', f => { f.profile.purpose = 'Changed' }, 'template binding mismatch'],
  ['unknown role', f => { f.binding.roles[0].roleRef = 'unknown' }, 'unknown semantic role'],
  ['missing required role', f => { f.binding.roles = [{ roleRef: 'shelf', sourceRefs: [f.records[0].ref] }] }, 'required semantic role unbound'],
  ['plural singular role', f => { f.binding.roles.push({ roleRef: 'shelf', sourceRefs: f.binding.roles[0].sourceRefs }) }, 'plural singular role binding'],
  ['duplicate binding', f => { f.binding.roles.push({ roleRef: 'items', sourceRefs: [f.records[0].ref] }) }, 'duplicate role binding'],
  ['dangling source', f => { f.records.shift() }, 'dangling exact reference'],
  ['changed source bytes', f => { f.records[0].document.text = 'Changed' }, 'reference digest mismatch'],
  ['ambiguous source inventory', f => { f.records.push(clone(f.records[0])) }, 'ambiguous reference inventory'],
  ['source reference type confusion', f => { f.binding.roles[0].sourceRefs[0] = f.record('PolicyRef', 'policy.other', {}) }],
]) test(`binding refuses ${name}`, () => { const f = fixture(); mutate(f); refused(bindingCheck(f), reason) })

for (const [name, mutate, reason] of [
  ['required carrier missing', f => { f.release.projectionRefs.pop() }, 'required carrier missing'],
  ['release from other binding', f => { f.release.bindingRef = makeRef('BindingRef', 'other', {}) }, 'release binding mismatch'],
  ['dangling authority decision', f => { f.records = f.records.filter(x => x.ref.kind !== 'AuthorityDecisionRef') }, 'dangling exact reference'],
  ['changed projection bytes', f => { f.records.find(x => x.ref.kind === 'ProjectionRef').document.carrier = 'chat' }, 'reference digest mismatch'],
  ['false accepted release status', f => { f.release.accepted = true }],
]) test(`release refuses ${name}`, () => { const f = fixture(); mutate(f); refused(releaseCheck(f), reason) })

test('rehashing a projection cannot conceal a wrong source or swapped template', () => {
  for (const mutate of [p => { p.templateRef = makeRef('TemplateRef', 'other', {}) }, p => { p.sourceRefs = [makeRef('SourceRef', 'unbound', {})] }]) {
    const f = fixture(), r = f.records.find(x => x.ref.kind === 'ProjectionRef')
    mutate(r.document)
    r.ref = makeRef('ProjectionRef', r.document.id, r.document)
    f.release.projectionRefs[0] = r.ref
    refused(releaseCheck(f))
  }
})

for (const [name, mutate, reason] of [
  ['missing surface support', f => { f.host.surfacePrimitives.pop() }, 'unsupported surface primitive'],
  ['wrong installed version', f => { f.host.atelierVersion = '0.0.0' }, 'incompatible host version'],
  ['missing runtime profile', f => { f.profile.runtimeProfileRef = makeRef('RuntimeProfileRef', 'sample.runtime', {}); f.host.templateRef = makeRef('TemplateRef', f.profile.id, f.profile) }, 'runtime profile missing or mismatched'],
  ['false available capability', f => { f.host.optionalDecisions = [{ id: 'reading-priority', status: 'available', capabilityRef: null }] }, 'available decision needs exact capability reference'],
  ['unknown decision', f => { f.host.optionalDecisions = [{ id: 'unknown', status: 'absent', capabilityRef: null }] }, 'undeclared optional decision'],
]) test(`host refuses ${name}`, () => { const f = fixture(); mutate(f); refused(hostCheck(f), reason) })

test('absent, disabled and unqualified optional decisions never block local authoring', () => {
  for (const status of ['absent', 'disabled', 'unqualified', 'available']) {
    const f = fixture()
    f.host.optionalDecisions = [{ id: 'reading-priority', status, capabilityRef: status === 'absent' ? null : makeRef('CapabilityRef', 'sample.decision', { status }) }]
    const result = hostCheck(f)
    assert.equal(result.ok, true)
    assert.equal(result.diagnostics[0].status, status)
    assert.equal(result.diagnostics[0].invocationAuthorized, false)
    assert.equal(bindingCheck(f).ok, true)
  }
})

test('decision results reuse the existing provider-neutral validator and stay advisory', () => {
  const request = { schema: 'atelier-decision-request@v1', id: 'sample', task: 'reading-priority', rubricVersion: 'v1', scope: { workspaceId: 'sample', authorizationRef: 'scope-synthetic' }, state: 'Synthetic text', evidence: [{ id: 'a', sourceRef: 'source:a' }], questions: { relevant: { type: 'boolean', instructions: 'Is it relevant?', criteria: { true: 'Relevant', false: 'Unrelated' }, evidenceIds: ['a'] } } }
  const result = { schema: 'atelier-decision-result@v1', requestId: request.id, requestDigest: decisionRequestDigest(request), task: request.task, rubricVersion: request.rubricVersion, scope: request.scope, provider: { id: 'synthetic', model: 'synthetic' }, authority: 'proposal-only', mode: 'advisory', elapsedMs: 0, usage: null, status: 'abstained', reason: 'provider-unavailable', answers: {} }
  const valid = validateTemplateDecision(sample, 'reading-priority', request, result)
  assert.equal(valid.ok, true, JSON.stringify(valid))
  result.authority = 'accepted'
  refused(validateTemplateDecision(sample, 'reading-priority', request, result), 'invalid decision result')
})

test('digest domains bind kind, identity, version and all bytes, with canonical key ordering', () => {
  assert.deepEqual(makeRef('SourceRef', 'sample', { a: 1, b: 2 }), makeRef('SourceRef', 'sample', { b: 2, a: 1 }))
  assert.notEqual(makeRef('SourceRef', 'sample', {}).digest, makeRef('PolicyRef', 'sample', {}).digest)
  assert.notEqual(makeRef('SourceRef', 'sample', {}).digest, makeRef('SourceRef', 'other', {}).digest)
  assert.throws(() => makeRef('UnknownRef', 'sample', {}))
})

test('bounded JSON refuses accessors, symbols, cycles, sparse arrays and exotic objects without invoking getters', () => {
  let invoked = false
  const getter = { get purpose() { invoked = true; return 'text' } }
  const cycle = {}; cycle.self = cycle
  for (const value of [getter, cycle, new Date(), [,,], { x: undefined }, { x: NaN }, { [Symbol('x')]: 'x' }, { x: 'x'.repeat(1048577) }, Object.create({ x: 1 })]) {
    refused(validateTemplateDefinition(value))
    assert.throws(() => makeRef('SourceRef', 'sample', value))
  }
  assert.equal(invoked, false)
})

test('epoch metadata is optional and reserved ext never admits required semantics', () => {
  const p = clone(sample)
  p.contractVersion = '1.0.0'
  p.ext = {}
  assert.equal(validateTemplateDefinition(p).ok, true)
  p.ext.requiredBehavior = true
  refused(validateTemplateDefinition(p))
})

test('validation does not mutate inputs or widen existing extension-pack v1', () => {
  const f = fixture(), before = JSON.stringify(f)
  releaseCheck(f); hostCheck(f)
  assert.equal(JSON.stringify(f), before)
  const packSchema = JSON.parse(fs.readFileSync(new URL('../contracts/atelier-extension-pack.v1.schema.json', import.meta.url), 'utf8'))
  assert.equal(packSchema.additionalProperties, false)
  assert.equal(Object.hasOwn(packSchema.properties, 'templateProfile'), false)
})
