import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import {
  DISTRIBUTED_RUNTIME_COPY,
  GENERATED_PROJECTION,
  KIT_FILE_CLASSES,
  SOURCE,
  classifyPath,
  createPathClassifier,
  generatedProjectionBasenames,
  validateFileClasses,
} from '../src/project/file-class.mjs'
import { matchesPathPattern } from '../src/project/path-match.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'))

// The classification that burned Client zero: the builder script is canonical in the ops
// repo and a rederivable copy in every consumer. A list keyed on filename alone
// cannot express that, and folding it into a plain "generated" list makes the sync
// loop discard canonical source in the repo that owns it.
const RUNTIME_COPY_CLASSES = [
  ...KIT_FILE_CLASSES,
  { pattern: 'scripts/build-atelier.mjs', class: DISTRIBUTED_RUNTIME_COPY, canonicalRepoRole: 'repo-ops' },
]

test('a distributed runtime copy is source in its canonical repo and a copy elsewhere', () => {
  const inOps = classifyPath('scripts/build-atelier.mjs', { repoRole: 'repo-ops', fileClasses: RUNTIME_COPY_CLASSES })
  assert.equal(inOps.class, SOURCE)
  assert.equal(inOps.canonicalHere, true)
  assert.equal(inOps.handling.discardable, false, 'a sync loop must never discard the canonical copy')
  assert.equal(inOps.handling.conflictsNeedHuman, true)

  const inConsumer = classifyPath('scripts/build-atelier.mjs', { repoRole: 'website', fileClasses: RUNTIME_COPY_CLASSES })
  assert.equal(inConsumer.class, DISTRIBUTED_RUNTIME_COPY)
  assert.equal(inConsumer.canonicalHere, false)
  assert.equal(inConsumer.handling.rederivable, true, 'self-repair must be allowed to rederive the consumer copy')
})

test('unclassified paths default to source', () => {
  const verdict = classifyPath('docs/notes.md', { repoRole: 'website' })
  assert.equal(verdict.class, SOURCE)
  assert.equal(verdict.declared, false)
  assert.equal(verdict.handling.discardable, false, 'an undeclared path must never be discardable')
})

test('generated projections are discardable in every repo role', () => {
  for (const repoRole of ['repo-ops', 'website', null]) {
    const classify = createPathClassifier({ repoRole })
    assert.equal(classify('atelier-output/index.html').class, GENERATED_PROJECTION)
    assert.equal(classify('some/nested/knowledge.graph.json').handling.discardable, true)
  }
})

test('later entries win, so an adopter can narrow a kit default', () => {
  const classes = [
    { pattern: 'atelier-output/**', class: GENERATED_PROJECTION },
    { pattern: 'atelier-output/AUTHORED.md', class: SOURCE },
  ]
  assert.equal(classifyPath('atelier-output/index.html', { fileClasses: classes }).class, GENERATED_PROJECTION)
  assert.equal(classifyPath('atelier-output/AUTHORED.md', { fileClasses: classes }).class, SOURCE)
})

test('a runtime copy must declare where it is canonical', () => {
  assert.match(
    validateFileClasses([{ pattern: 'scripts/x.mjs', class: DISTRIBUTED_RUNTIME_COPY }]).join('\n'),
    /canonicalRepoRole is required for distributed-runtime-copy/,
  )
  assert.deepEqual(validateFileClasses([{ pattern: 'scripts/x.mjs', class: DISTRIBUTED_RUNTIME_COPY, canonicalRepoRole: 'repo-ops' }]), [])
  assert.match(
    validateFileClasses([{ pattern: 'a.md', class: SOURCE, canonicalRepoRole: 'repo-ops' }]).join('\n'),
    /canonicalRepoRole is only meaningful/,
  )
  assert.match(validateFileClasses([{ pattern: 'a.md', class: 'made-up' }]).join('\n'), /class must be one of/)
  assert.match(
    validateFileClasses([{ pattern: 'a.md', class: SOURCE }, { pattern: 'a.md', class: GENERATED_PROJECTION }]).join('\n'),
    /duplicates an earlier entry/,
  )
  assert.deepEqual(validateFileClasses(KIT_FILE_CLASSES), [])
})

test('the kit keeps no second copy of the classification', () => {
  // The graph walker used to restate the generated filenames inline. Whatever it
  // skips must come from the declaration, or the two drift and a sync wedge follows.
  const walkerSource = fs.readFileSync(path.join(ROOT, 'src/graph/knowledge-graph.mjs'), 'utf8')
  const generatedFilesLine = walkerSource.match(/const GENERATED_FILES = .*/)[0]
  assert.match(generatedFilesLine, /generatedProjectionBasenames\(\)/)

  const derived = generatedProjectionBasenames()
  for (const name of ['atelier.manifest.json', 'atelier-ledger.html', 'atelier-shell.js', 'knowledge.graph.json']) {
    assert.ok(derived.has(name), `${name} must be reachable from the declaration, not a shadow list`)
  }

  // The glob dialect lives in one place too.
  const policySource = fs.readFileSync(path.join(ROOT, 'src/boundary/policy.mjs'), 'utf8')
  assert.doesNotMatch(policySource, /function patternMatches\(/, 'boundary policy must consume the shared matcher')
  assert.ok(matchesPathPattern('atelier-output/**', 'atelier-output/index.html'))
})

test('kit manifest fixtures agree with the file-class contract', () => {
  const schema = readJson('contracts/atelier-kit-manifest.v1.schema.json')
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema)

  const valid = readJson('fixtures/atelier-kit-manifest/valid/mnstry-atelier.valid.v1.json')
  assert.equal(validate(valid), true, JSON.stringify(validate.errors, null, 2))
  assert.deepEqual(validateFileClasses(valid.fileClasses), [], 'schema and resolver must agree on the same fixture')

  const invalid = readJson('fixtures/atelier-kit-manifest/invalid/runtime-copy-without-canonical-role.v1.json')
  assert.equal(validate(invalid), false, 'a runtime copy with no canonical role must fail the schema')
  assert.match(validateFileClasses(invalid.fileClasses).join('\n'), /canonicalRepoRole is required/)

  const { fileClasses, ...withoutClasses } = valid
  assert.equal(validate(withoutClasses), false, 'fileClasses is required: an unclassified kit fails validation')
})
