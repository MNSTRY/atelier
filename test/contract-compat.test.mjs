import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { CONTRACT_CORPUS, CORPUS_ROOT } from '../src/contracts/corpus.mjs'
import { checkCompat } from '../scripts/check-contract-compat.mjs'

// The compat gate is inert until the epoch tag exists, so its plumbing is kept
// honest here in self-consistency mode: the "baseline" schemas are read from the
// working tree instead of `git show <ref>:...`. Every current document must
// satisfy its own current contract, absent contracts must skip rather than fail,
// and a deliberately tightened baseline must be detected as a rejection.

function readWorkingTreeContract(contractFile) {
  return JSON.parse(fs.readFileSync(path.join(CORPUS_ROOT, contractFile), 'utf8'))
}

test('compat baseline document is the expected inert shape', () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(CORPUS_ROOT, 'contracts', 'compat-baseline.json'), 'utf8'))
  assert.equal(baseline.schema, 'atelier-compat-baseline@v1')
  assert.ok('baselineTag' in baseline, 'baselineTag must be present even when null')
  assert.ok(typeof baseline.note === 'string' && baseline.note.length > 0)
})

test('every corpus entry resolves a contract file and current documents', async () => {
  const { checked, skipped, failures } = await checkCompat({ readOldContract: readWorkingTreeContract })
  assert.deepEqual(failures, [], `self-consistency failures:\n${failures.map((f) => `${f.subject}: ${f.message}`).join('\n')}`)
  assert.deepEqual(skipped, [], 'no contract is missing from the working tree')
  assert.equal(checked.length, CONTRACT_CORPUS.length)
  for (const item of checked) assert.ok(item.documents > 0, `${item.entry} contributed no documents`)
})

test('generated readiness protocols are part of the checked corpus', async () => {
  const entry = CONTRACT_CORPUS.find((item) => item.name === 'atelier-readiness-protocol')
  assert.ok(entry?.loadGeneratedDocs, 'the readiness-protocol entry must contribute generated documents')
  const generated = await entry.loadGeneratedDocs()
  assert.ok(generated.length > 0)

  const { checked } = await checkCompat({ readOldContract: readWorkingTreeContract })
  const result = checked.find((item) => item.entry === entry.name)
  assert.ok(result.documents > generated.length, 'generated docs must be checked alongside the fixtures')
})

test('the attestation contract is registered in the corpus', () => {
  const entry = CONTRACT_CORPUS.find((item) => item.name === 'atelier-attestation')
  assert.ok(entry, 'attestation must be part of the compat corpus')
  assert.equal(entry.contractFile, 'contracts/atelier-attestation.v1.schema.json')
  assert.equal(entry.registry, false, 'attestation coverage lives in test/attestation-contract.test.mjs')
})

test('a contract absent at the baseline is reported as new, not as a failure', async () => {
  const target = 'contracts/atelier-attestation.v1.schema.json'
  const { skipped, failures } = await checkCompat({
    readOldContract: (contractFile) => (contractFile === target ? null : readWorkingTreeContract(contractFile)),
  })
  assert.deepEqual(failures, [])
  assert.deepEqual(skipped, [target])
})

test('a tightened baseline rejects the current corpus', async () => {
  const target = 'contracts/atelier-attestation.v1.schema.json'
  const { failures } = await checkCompat({
    readOldContract: (contractFile) => {
      const schema = readWorkingTreeContract(contractFile)
      if (contractFile !== target) return schema
      // The epoch under test forbids what the current contract allows.
      return { ...schema, properties: { ...schema.properties, signature: { type: 'boolean' } } }
    },
  })
  assert.notEqual(failures.length, 0, 'the gate must detect a document its baseline validator rejects')
  for (const failure of failures) assert.equal(failure.entry, 'atelier-attestation')
})

test('a baseline schema that fails to compile is a failure, not a crash', async () => {
  const target = 'contracts/atelier-claim.v1.schema.json'
  const { failures } = await checkCompat({
    readOldContract: (contractFile) => {
      const schema = readWorkingTreeContract(contractFile)
      if (contractFile !== target) return schema
      return { ...schema, $ref: '#/$defs/doesNotExist' }
    },
  })
  assert.equal(failures.length, 1)
  assert.equal(failures[0].entry, 'atelier-claim')
  assert.match(failures[0].message, /failed to compile/)
})
