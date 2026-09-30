import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { validateJsonSchema } from '../src/export/atelier-export-contract.mjs'
import { validateIntakeDocument } from '../src/intake/store.mjs'

test('cached validation observes nested const and required-array edits without freezing callers', () => {
  const schema = { type: 'object', properties: { mode: { const: 'draft' } }, required: ['mode'] }
  const value = { mode: 'draft' }
  assert.deepEqual(validateJsonSchema(schema, value), [])
  assert.equal(Object.isFrozen(schema), false)
  assert.equal(Object.isFrozen(schema.properties.mode), false)
  schema.properties.mode.const = 'accepted'
  assert.deepEqual(validateJsonSchema(schema, value), ['/mode must be "accepted"'])
  schema.required.push('id')
  assert.deepEqual(validateJsonSchema(schema, value), [
    '/ must include required property id', '/mode must be "accepted"',
  ])
  schema.required.pop()
  delete schema.properties.mode.const
  assert.deepEqual(validateJsonSchema(schema, value), [])
  assert.deepEqual(value, { mode: 'draft' })
})

test('unchanged schemas compile once; each changed version compiles once', t => {
  const schema = { type: 'string', enum: ['draft'] }
  const compile = t.mock.method(Ajv2020.prototype, 'compile')
  assert.deepEqual(validateJsonSchema(schema, 'draft'), [])
  const errors = validateJsonSchema(schema, 'accepted')
  assert.deepEqual(errors, ['/ must be one of draft'])
  assert.deepEqual(validateJsonSchema(schema, 'draft'), [])
  assert.deepEqual(errors, ['/ must be one of draft'])
  assert.equal(compile.mock.callCount(), 1)
  schema.enum[0] = 'accepted'
  assert.deepEqual(validateJsonSchema(schema, 'draft'), ['/ must be one of accepted'])
  assert.deepEqual(validateJsonSchema(schema, 'accepted'), [])
  assert.equal(compile.mock.callCount(), 2)
})

test('referenced definitions and format constraints invalidate cached validators', () => {
  const schema = { $defs: { field: { type: 'string', format: 'date' } }, $ref: '#/$defs/field' }
  assert.deepEqual(validateJsonSchema(schema, '2026-01-01'), [])
  schema.$defs.field.format = 'email'
  assert.deepEqual(validateJsonSchema(schema, '2026-01-01'), ['/ must match format "email"'])
  assert.deepEqual(validateJsonSchema(schema, 'author@example.org'), [])
  schema.$defs.field = { type: 'integer' }
  assert.deepEqual(validateJsonSchema(schema, 'author@example.org'), ['/ must be integer'])
})

test('invalid schema edits throw and recovery does not reuse an incompatible version', () => {
  const schema = { type: 'string' }
  assert.deepEqual(validateJsonSchema(schema, 'draft'), [])
  schema.type = 'invented-invalid-type'
  assert.throws(() => validateJsonSchema(schema, 'draft'), /schema is invalid/)
  assert.throws(() => validateJsonSchema(schema, 'draft'), /schema is invalid/)
  schema.type = 'integer'
  assert.deepEqual(validateJsonSchema(schema, 'draft'), ['/ must be integer'])
  assert.deepEqual(validateJsonSchema(schema, 1), [])
})

test('schemas sharing an id stay independent and boolean schema errors remain unchanged', () => {
  const first = { $id: 'https://example.org/invented-schema', type: 'string' }
  const second = { $id: first.$id, type: 'integer' }
  assert.deepEqual(validateJsonSchema(first, 'draft'), [])
  assert.deepEqual(validateJsonSchema(second, 'draft'), ['/ must be integer'])
  assert.deepEqual(validateJsonSchema(true, {}), [])
  assert.deepEqual(validateJsonSchema(false, {}), ['/ boolean schema is false'])
})

test('accessor schemas retain fresh compilation without extra getter evaluation', t => {
  let current = 'string', reads = 0
  const schema = { get type() { reads++; return current } }
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  addFormats(ajv)
  assert.equal(ajv.compile(schema)('draft'), true)
  const expectedReads = reads
  reads = 0
  const compile = t.mock.method(Ajv2020.prototype, 'compile')
  assert.deepEqual(validateJsonSchema(schema, 'draft'), [])
  assert.equal(reads, expectedReads)
  current = 'integer'
  assert.deepEqual(validateJsonSchema(schema, 'draft'), ['/ must be integer'])
  assert.equal(compile.mock.callCount(), 2)
  assert.ok(expectedReads > 0)
})

test('reused intake validator preserves complete ordered errors and independent result arrays', () => {
  const schema = JSON.parse(readFileSync(new URL('../contracts/atelier-intake.v1.schema.json', import.meta.url)))
  const valid = { schema: 'mnstry.atelier-intake-source@v1', sourceRef: 'sample.md', blobId: 'a'.repeat(64), bytes: 0, originalMutation: false }
  const invalid = { ...valid, bytes: -1, originalMutation: true, extra: 'refused' }
  const expected = validateJsonSchema(schema, invalid)
  assert.ok(expected.length > 0)
  const actual = validateIntakeDocument(invalid)
  assert.deepEqual(actual, expected)
  assert.deepEqual(validateIntakeDocument(valid), [])
  assert.deepEqual(actual, expected)
  assert.deepEqual(validateIntakeDocument(invalid), expected)
})
