import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { CONTRACT_CORPUS, CORPUS_ROOT, corpusValidFiles } from '../src/contracts/corpus.mjs'
import { checkCompat, diffSchemaWidenings } from '../scripts/check-contract-compat.mjs'

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

test('the widening differ catches an enum gaining a member', async () => {
  // Document validation cannot see this: every current document still passes
  // the widened schema. The differ must flag it as a rejection.
  const target = 'contracts/atelier-export.v1.schema.json'
  const widened = readWorkingTreeContract(target)
  widened.$defs.objectClass.enum = [...widened.$defs.objectClass.enum, 'smuggled_class']

  const direct = diffSchemaWidenings(readWorkingTreeContract(target), widened)
  assert.ok(
    direct.some((finding) => finding.pointer === '/$defs/objectClass' && /enum gained member/.test(finding.message)),
    `expected an enum-gained finding, got ${JSON.stringify(direct)}`,
  )

  const { failures } = await checkCompat({
    readOldContract: readWorkingTreeContract,
    readCurrentContract: (contractFile) => (contractFile === target ? widened : readWorkingTreeContract(contractFile)),
  })
  const widenings = failures.filter((failure) => failure.kind === 'widening')
  assert.notEqual(widenings.length, 0, 'the gate must reject a widened enum')
  for (const failure of widenings) assert.equal(failure.entry, 'atelier-export')
  assert.ok(widenings.some((failure) => /enum gained member/.test(failure.message)))
})

test('the widening differ catches a required member being removed', async () => {
  const target = 'contracts/atelier-export.v1.schema.json'
  const original = readWorkingTreeContract(target)
  assert.ok(Array.isArray(original.required) && original.required.length > 0, 'fixture assumption: export root declares required members')
  const widened = readWorkingTreeContract(target)
  const dropped = widened.required.pop()

  const direct = diffSchemaWidenings(original, widened)
  assert.ok(
    direct.some((finding) => finding.pointer === '/' && finding.message.includes(`required lost member(s): ${dropped}`)),
    `expected a required-lost finding, got ${JSON.stringify(direct)}`,
  )

  const { failures } = await checkCompat({
    readOldContract: readWorkingTreeContract,
    readCurrentContract: (contractFile) => (contractFile === target ? widened : readWorkingTreeContract(contractFile)),
  })
  assert.ok(
    failures.some((failure) => failure.kind === 'widening' && failure.entry === 'atelier-export' && /required lost member/.test(failure.message)),
    'the gate must reject a required-member removal',
  )
})

test('a corpus where every contract skips refuses to pass', async () => {
  const { checked, failures } = await checkCompat({ readOldContract: () => null })
  assert.equal(checked.length, 0)
  assert.ok(
    failures.some((failure) => failure.kind === 'gate' && /checked nothing/.test(failure.message)),
    'an all-skip run must fail rather than print clean over zero documents',
  )
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

test('the widening differ catches deleted constraints, not just loosened ones', () => {
  const target = 'contracts/atelier-export.v1.schema.json'
  const base = readWorkingTreeContract(target)

  // Deleting the enum outright is the widest relaxation of a closed vocabulary.
  const enumDeleted = readWorkingTreeContract(target)
  delete enumDeleted.$defs.runtimeOwnerName.enum
  assert.ok(
    diffSchemaWidenings(base, enumDeleted).some(
      (finding) => finding.pointer === '/$defs/runtimeOwnerName' && /enum constraint removed/.test(finding.message),
    ),
    'deleting an enum must be flagged',
  )

  // Wrapping the old node in anyOf removes the enum at the original pointer.
  const anyOfWrapped = readWorkingTreeContract(target)
  anyOfWrapped.$defs.runtimeOwnerName = { anyOf: [base.$defs.runtimeOwnerName, { type: 'string' }] }
  assert.ok(
    diffSchemaWidenings(base, anyOfWrapped).some(
      (finding) => finding.pointer === '/$defs/runtimeOwnerName' && /enum constraint removed/.test(finding.message),
    ),
    'an anyOf escape hatch must be flagged',
  )

  // Deleting a combinator rule (the dirtyTree allOf) must be flagged.
  const allOfDeleted = readWorkingTreeContract(target)
  delete allOfDeleted.allOf
  assert.ok(
    diffSchemaWidenings(base, allOfDeleted).some((finding) => /allOf constraint removed/.test(finding.message)),
    'deleting allOf must be flagged',
  )

  // Changing the combinator rule count (insert or drop) must be flagged.
  const allOfPrepended = readWorkingTreeContract(target)
  allOfPrepended.allOf = [{ if: { properties: { forced: { const: true } } }, then: {} }, ...base.allOf]
  assert.ok(
    diffSchemaWidenings(base, allOfPrepended).some((finding) => /allOf rule count changed/.test(finding.message)),
    'a combinator rule-count change must be flagged',
  )

  // Replacing a subschema wholesale with {} must produce findings.
  const gutted = readWorkingTreeContract(target)
  gutted.$defs.runtimeOwner = {}
  assert.notEqual(
    diffSchemaWidenings(base, gutted).length,
    0,
    'gutting a subschema must be flagged',
  )
})

test('previousContractFiles maps a moved contract back to its baseline path instead of skipping', async () => {
  const entry = CONTRACT_CORPUS.find((item) => item.name === 'atelier-attestation')
  const movedEntry = {
    ...entry,
    contractFile: 'contracts/governance/atelier-attestation.v1.schema.json',
    previousContractFiles: [entry.contractFile],
  }
  const { checked, skipped, failures } = await checkCompat({
    corpus: [movedEntry],
    readOldContract: (contractFile) => (contractFile === entry.contractFile ? readWorkingTreeContract(entry.contractFile) : null),
    readCurrentContract: () => readWorkingTreeContract(entry.contractFile),
  })
  assert.deepEqual(failures, [])
  assert.deepEqual(skipped, [])
  assert.equal(checked.length, 1)
  assert.equal(checked[0].entry, 'atelier-attestation')
})

test('bidirectional check rejects a tightened current schema that breaks historical valid documents', async () => {
  const entry = CONTRACT_CORPUS.find((item) => item.name === 'atelier-attestation')
  const baseSchema = readWorkingTreeContract(entry.contractFile)
  const tightenedCurrent = {
    ...baseSchema,
    properties: {
      ...baseSchema.properties,
      signature: { type: 'boolean' },
    },
  }
  const sampleFile = corpusValidFiles(entry, CORPUS_ROOT)[0]
  const sampleValidDoc = JSON.parse(fs.readFileSync(sampleFile, 'utf8'))
  const { failures } = await checkCompat({
    corpus: [entry],
    readOldContract: () => baseSchema,
    readCurrentContract: () => tightenedCurrent,
    readOldValidDocs: () => [{ label: `v0.2.0-alpha.11:${path.relative(CORPUS_ROOT, sampleFile)}`, doc: sampleValidDoc }],
  })
  assert.ok(
    failures.some((failure) => failure.kind === 'historical-rejected' && failure.entry === 'atelier-attestation'),
    `expected historical-rejected failure, got ${JSON.stringify(failures)}`,
  )
})

test('the widening differ resolves retargeted local $ref pointers to a looser definition', () => {
  const oldSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      audience: { $ref: '#/$defs/strictAudience' },
    },
    $defs: {
      strictAudience: { type: 'string', enum: ['public', 'team'] },
      looseAudience: { type: 'string', enum: ['public', 'team', 'unrestricted'] },
    },
  }
  const newSchema = {
    ...oldSchema,
    properties: {
      audience: { $ref: '#/$defs/looseAudience' },
    },
  }
  const findings = diffSchemaWidenings(oldSchema, newSchema)
  assert.ok(
    findings.some((finding) => finding.pointer === '/properties/audience' && /enum gained member/.test(finding.message)),
    `expected retargeted $ref widening finding, got ${JSON.stringify(findings)}`,
  )
})

test('the widening differ compares sibling keywords alongside a retargeted $ref', () => {
  const oldSchema = {
    type: 'object',
    properties: {
      slug: { $ref: '#/$defs/slugA', maxLength: 32 },
    },
    $defs: {
      slugA: { type: 'string', pattern: '^[a-z-]+$' },
      slugB: { type: 'string', pattern: '^[a-z-]+$' },
    },
  }
  const newSchema = {
    ...oldSchema,
    properties: {
      slug: { $ref: '#/$defs/slugB' },
    },
  }
  const findings = diffSchemaWidenings(oldSchema, newSchema)
  assert.ok(
    findings.some((finding) => finding.pointer === '/properties/slug' && /maxLength increased or removed/.test(finding.message)),
    `expected sibling maxLength removal finding, got ${JSON.stringify(findings)}`,
  )
})

test('the widening differ handles renamed recursive $defs without stack overflow', () => {
  const oldSchema = {
    $ref: '#/$defs/nodeV1',
    $defs: {
      nodeV1: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['a'] },
          child: { $ref: '#/$defs/nodeV1' },
        },
      },
    },
  }
  const newSchema = {
    $ref: '#/$defs/nodeV2',
    $defs: {
      nodeV2: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['a', 'b'] },
          child: { $ref: '#/$defs/nodeV2' },
        },
      },
    },
  }
  const findings = diffSchemaWidenings(oldSchema, newSchema)
  assert.ok(
    findings.some((finding) => /enum gained member/.test(finding.message)),
    `expected widening finding on renamed recursive $defs, got ${JSON.stringify(findings)}`,
  )
})

test('bidirectional check fails closed when a pre-existing entry yields zero historical valid docs', async () => {
  const entry = CONTRACT_CORPUS.find((item) => item.name === 'atelier-attestation')
  const baseSchema = readWorkingTreeContract(entry.contractFile)
  const { failures } = await checkCompat({
    corpus: [entry],
    readOldContract: () => baseSchema,
    readCurrentContract: () => baseSchema,
    readOldValidDocs: () => [],
  })
  assert.ok(
    failures.some((failure) => failure.kind === 'gate' && /no historical valid documents/.test(failure.message)),
    `expected zero-historical-docs gate failure, got ${JSON.stringify(failures)}`,
  )
})

test('the widening differ preserves intermediate chained $ref siblings and checks exclusive/property bounds', () => {
  const oldChained = {
    type: 'object',
    properties: {
      code: { $ref: '#/$defs/a' },
      score: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 10 },
      bag: { type: 'object', minProperties: 1, maxProperties: 5 },
    },
    $defs: {
      a: { $ref: '#/$defs/b', minLength: 10 },
      b: { type: 'string' },
    },
  }
  const newChained = {
    type: 'object',
    properties: {
      code: { $ref: '#/$defs/b' },
      score: { type: 'number' },
      bag: { type: 'object' },
    },
    $defs: oldChained.$defs,
  }
  const findings = diffSchemaWidenings(oldChained, newChained)
  assert.ok(findings.some((f) => f.pointer === '/properties/code' && /minLength decreased or removed/.test(f.message)))
  assert.ok(findings.some((f) => f.pointer === '/properties/score' && /exclusiveMinimum decreased or removed/.test(f.message)))
  assert.ok(findings.some((f) => f.pointer === '/properties/score' && /exclusiveMaximum increased or removed/.test(f.message)))
  assert.ok(findings.some((f) => f.pointer === '/properties/bag' && /minProperties decreased or removed/.test(f.message)))
  assert.ok(findings.some((f) => f.pointer === '/properties/bag' && /maxProperties increased or removed/.test(f.message)))
})
