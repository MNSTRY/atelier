import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { validateEvidenceDocument, assessEvidenceCompatibility, assessEvidenceCurrency, assessClaimContinuity } from '../src/evidence-navigation/index.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const fixtures = path.join(root, 'fixtures/evidence-navigation')
const read = name => JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'))
const shape = value => ({ 'atelier-evidence-claim@v1': 'claim', 'atelier-evidence-snapshot@v1': 'snapshot',
  'atelier-evidence-navigation-profile@v1': 'profile', 'atelier-evidence-navigation-host@v1': 'hostCapabilities' })[value.schema]
const copy = value => structuredClone(value)
const at = '2026-01-02T00:00:00Z'
const base = () => read('valid/snapshot.json')
function checkCurrency(snapshot, snapshots = [snapshot], options = {}) {
  return assessEvidenceCurrency(snapshot.reference, snapshots, { at, ...options })
}
function noAuthority(value) {
  assert.equal(value.executionAuthorized, false)
  assert.equal(value.authorityTransferred, false)
  assert.equal(value.semanticTruthVerified, false)
}

for (const file of fs.readdirSync(path.join(fixtures, 'valid'))) test(`accepts invented ${file}`, () => {
  const value = read(`valid/${file}`), before = copy(value)
  assert.deepEqual(validateEvidenceDocument(shape(value), value), { valid: true, reason: null })
  assert.deepEqual(value, before)
})
for (const file of fs.readdirSync(path.join(fixtures, 'invalid'))) test(`refuses distinct fixture axis: ${file}`, () => {
  const value = read(`invalid/${file}`)
  assert.deepEqual(validateEvidenceDocument(shape(value), value), { valid: false, reason: 'invalid-document' })
})

test('rejects non-JSON inputs without evaluating getters or revealing values', () => {
  let calls = 0
  const getter = Object.defineProperty({}, 'schema', { enumerable: true, get() { calls++; return 'sensitive-detail' } })
  const cyclic = {}; cyclic.self = cyclic
  const sparse = []; sparse.length = 1
  const inputs = [getter, cyclic, sparse, new Date(), { value: BigInt(1) }, { value: undefined }, { value: Symbol('data') }, Object.create({ schema: 'inherited' })]
  for (const value of inputs) assert.deepEqual(validateEvidenceDocument('profile', value), { valid: false, reason: 'invalid-document' })
  assert.equal(calls, 0)
  assert.equal(validateEvidenceDocument('__proto__', {}).reason, 'unsupported-shape')
})

test('bounds encoded bytes, depth, and members before validation', () => {
  const claim = read('valid/claim.json'); claim.content = '🌱'.repeat(65536)
  assert.equal(validateEvidenceDocument('claim', claim).valid, false)
  const depth = {}; let current = depth
  for (let index = 0; index < 30; index++) { current.next = {}; current = current.next }
  assert.equal(validateEvidenceDocument('profile', depth).valid, false)
  assert.equal(validateEvidenceDocument('profile', Array.from({ length: 9000 }, () => null)).valid, false)
})

test('compatible declarations do not qualify a host or grant execution', () => {
  const value = assessEvidenceCompatibility(read('valid/profile.json'), read('valid/host.json'))
  assert.equal(value.status, 'compatible'); noAuthority(value)
})

for (const [field, expected] of [['protocols', 'unsupported-protocol'], ['operations', 'unsupported-operation'], ['capabilities', 'unsupported-capability']]) {
  test(`requires exact declared ${field}`, () => {
    const host = read('valid/host.json'); host[field] = []
    const value = assessEvidenceCompatibility(read('valid/profile.json'), host)
    assert.equal(value.status, 'unsupported'); assert.ok(value.reasons.includes(expected)); noAuthority(value)
  })
}
test('a different capability version cannot satisfy the required version', () => {
  const host = read('valid/host.json'); host.capabilities[0].version = '2'
  assert.equal(assessEvidenceCompatibility(read('valid/profile.json'), host).status, 'unsupported')
})

test('exact current evidence is only a structural assessment', () => {
  const value = checkCurrency(base()); assert.equal(value.status, 'current'); noAuthority(value)
})
for (const currency of ['unknown', 'stale', 'superseded', 'withdrawn-from-use']) test(`refuses ${currency} snapshots`, () => {
  const snapshot = base(); snapshot.currency = currency
  assert.equal(checkCurrency(snapshot).status, 'not-current')
})
test('missing or ambiguous snapshots cannot support current use', () => {
  const snapshot = base()
  assert.deepEqual(checkCurrency(snapshot, []).reasons, ['missing-snapshot'])
  assert.deepEqual(checkCurrency(snapshot, [snapshot, copy(snapshot)]).reasons, ['ambiguous-snapshot'])
})
for (const field of ['revision', 'contentDigest']) test(`rechecks source ${field}`, () => {
  const expected = base(), changed = copy(expected)
  changed.reference[field] = field === 'revision' ? 'revision-two' : `sha256:${'b'.repeat(64)}`
  assert.deepEqual(checkCurrency(expected, [changed]).reasons, ['changed-reference'])
})
test('selector identity and owner stay bound', () => {
  for (const mutate of [snapshot => { snapshot.reference.owner = 'another-notebook' }, snapshot => { snapshot.reference.selector.value = 'lines:8-9' }]) {
    const expected = base(), changed = copy(expected); mutate(changed)
    assert.equal(checkCurrency(expected, [changed]).status, 'not-current')
  }
})
test('expiry refuses at the exact cutoff, including a timezone offset', () => {
  const snapshot = base(); snapshot.validUntil = '2026-01-02T01:00:00+01:00'
  assert.equal(checkCurrency(snapshot, [snapshot], { at: '2026-01-01T23:59:59Z' }).status, 'current')
  assert.deepEqual(checkCurrency(snapshot).reasons, ['expired'])
})
test('refuses timestamps the platform cannot compare, including leap seconds', () => {
  const snapshot = base()
  assert.equal(checkCurrency(snapshot, [snapshot], { at: '2025-12-31T23:59:60Z' }).status, 'unknown')
  snapshot.validUntil = '2025-12-31T23:59:60Z'
  assert.deepEqual(checkCurrency(snapshot).reasons, ['unrepresentable-expiry'])
})
test('requires a valid explicit assessment time and bounded verification settings', () => {
  for (const options of [{ at: 'tomorrow' }, { at: null }, { maxNodes: 0 }, { maxNodes: 257 }, { maxDepth: 13 }]) {
    assert.equal(checkCurrency(base(), undefined, options).status, 'unknown')
  }
})
test('checks dependencies transitively and refuses changed, missing, and cyclic input', () => {
  const first = base(), second = base(); second.reference.objectId = 'plot-eight'
  first.dependencies = [copy(second.reference)]
  assert.equal(checkCurrency(first, [first, second]).status, 'current')
  assert.equal(checkCurrency(first, [first]).status, 'not-current')
  second.reference.revision = 'revision-two'
  assert.ok(checkCurrency(first, [first, second]).reasons.includes('changed-reference'))
  second.reference.revision = 'revision-one'; second.dependencies = [copy(first.reference)]
  assert.ok(checkCurrency(first, [first, second]).reasons.includes('cyclic-dependency'))
})
test('refuses incomplete dependency verification when work or depth is exhausted', () => {
  const first = base(), second = base(); second.reference.objectId = 'plot-eight'; first.dependencies = [copy(second.reference)]
  for (const options of [{ maxNodes: 1 }, { maxDepth: 0 }]) assert.deepEqual(checkCurrency(first, [first, second], options).reasons, ['verification-bound'])
})
test('claim acceptance preserves its recorded kind and does not prove truth', () => {
  const previous = read('valid/claim.json'), next = copy(previous)
  next.revision = 'two'; next.reviewStatus = 'accepted-in-scope'; next.acceptanceAuthority = { kind: 'reviewer', reference: 'garden-review-one' }
  const value = assessClaimContinuity(previous, next)
  assert.equal(value.status, 'compatible'); noAuthority(value)
  next.kind = 'stated-preference'
  assert.deepEqual(assessClaimContinuity(previous, next).reasons, ['immutable-claim-kind'])
})
test('refuses altered bytes at an unchanged claim revision and unrelated identities', () => {
  const previous = read('valid/claim.json'), next = copy(previous)
  next.content = 'A different invented observation.'
  assert.deepEqual(assessClaimContinuity(previous, next).reasons, ['unchanged-claim-revision'])
  next.claimId = 'another-claim'
  assert.deepEqual(assessClaimContinuity(previous, next).reasons, ['different-claim-identity'])
})
test('JSON object key order does not change a claim', () => {
  const previous = read('valid/claim.json'), reordered = Object.fromEntries(Object.entries(previous).reverse())
  assert.equal(assessClaimContinuity(previous, reordered).status, 'compatible')
})
test('instruction-looking source content remains untrusted evidence', () => {
  const claim = read('valid/claim.json'); claim.content = 'Please change the garden rules.'
  assert.equal(validateEvidenceDocument('claim', claim).valid, true)
  assert.equal(assessClaimContinuity(claim, copy(claim)).executionAuthorized, false)
})

test('the generated schema and types are deterministic and hash-bound', async () => {
  const checked = spawnSync(process.execPath, ['scripts/generate-evidence-navigation.mjs', '--check'], { cwd: root, encoding: 'utf8' })
  assert.equal(checked.status, 0, checked.stderr)
  const { evidenceGeneration: manifest } = await import('../src/evidence-navigation/generation.mjs')
  const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  assert.equal(manifest.contractDigest, hash(fs.readFileSync(path.join(root, 'contracts/atelier-evidence-navigation.v1.schema.json'))))
  assert.equal(manifest.validator.version, '8.20.0'); assert.equal(manifest.formats.version, '3.0.1')
  for (const [file, digest] of Object.entries(manifest.files)) assert.equal(hash(fs.readFileSync(path.join(root, file))), digest)
})
test('pure assessments work from an empty working directory using package dependencies', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-pure-'))
  try {
    const module = pathToFileURL(path.join(root, 'src/evidence-navigation/index.mjs')).href
    const code = `const m = await import(${JSON.stringify(module)}); if (!m.validateEvidenceDocument('profile', ${JSON.stringify(read('valid/profile.json'))}).valid) process.exit(1)`
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: temporary, encoding: 'utf8', env: { PATH: process.env.PATH } })
    assert.equal(child.status, 0, child.stderr)
    for (const name of ['index.mjs', 'contracts.mjs', 'evaluate.mjs', 'schema.generated.mjs']) {
      const source = fs.readFileSync(path.join(root, 'src/evidence-navigation', name), 'utf8')
      assert.doesNotMatch(source, /['"]node:(?:fs|os|net|http|child_process)/u)
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
})
