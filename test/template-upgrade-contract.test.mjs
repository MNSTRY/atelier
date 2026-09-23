import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { CONTRACT_CORPUS, CORPUS_ROOT, corpusValidFiles, corpusInvalidFiles } from '../src/contracts/corpus.mjs'
import { validateJsonSchema } from '../src/export/atelier-export-contract.mjs'

// Invented shape-only examples keep the published contracts in the epoch
// corpus. Their placeholder digests cannot serve as saved executable plans.
for (const shape of ['adoption-policy.v2', 'migration.v3', 'template-adoption.v1', 'upgrade-plan.v3']) {
  test(`template ${shape} compatibility corpus accepts its shape and refuses an execution extension`, () => {
    const entry = CONTRACT_CORPUS.find(item => item.name === `atelier-template-${shape}`)
    assert.ok(entry)
    const schema = JSON.parse(fs.readFileSync(path.join(CORPUS_ROOT, entry.contractFile)))
    const valid = corpusValidFiles(entry), invalid = corpusInvalidFiles(entry)
    assert.ok(valid.length && invalid.length)
    for (const file of valid) assert.deepEqual(validateJsonSchema(schema, JSON.parse(fs.readFileSync(file))), [])
    for (const file of invalid) assert.ok(validateJsonSchema(schema, JSON.parse(fs.readFileSync(file))).length)
  })
}
