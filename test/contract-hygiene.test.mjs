import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

// Contract-stability epoch hygiene. Walks contracts/ generically — every
// versioned contract file is checked, with no per-file exceptions:
// - every *.vN[.schema].json carries the canonical $id for its basename
// - every *.schema.json follows the epoch conventions: 2020-12 draft, title,
//   closed document roots that declare optional contractVersion, and an
//   optional ext container on every closed object subschema
// - versioned documents that are not schemas (the semantic profile) are held
//   to the $id rule only
// - unversioned support files (for example a compat baseline) are not
//   contract surfaces and are ignored

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CONTRACTS_DIR = path.join(ROOT, 'contracts')
const ID_BASE = 'https://mnstry.ai/schemas/atelier/'
const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema'
const ROOT_META_KEYS = new Set(['$schema', '$id', '$comment', 'title', 'description', '$defs'])
const DATA_KEYS = new Set(['enum', 'const', 'default', 'examples'])

const contractFiles = fs.readdirSync(CONTRACTS_DIR)
  .filter((name) => /\.v[0-9]+(\.schema)?\.json$/.test(name))
  .sort()

// The expected contractVersion major is the filename's .vN, so a future @v2
// contract satisfies both its filename and its version pattern.
function contractVersionPattern(basename) {
  const major = basename.match(/\.v([0-9]+)(\.schema)?\.json$/)[1]
  return `^${major}\\.[0-9]+\\.[0-9]+$`
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

// A contract file exposes one or more document roots: the root itself when it
// is a typed schema, the resolved branches when the root is a oneOf/anyOf of
// local $defs refs, or every top-level $def when the root is a pure
// definition bundle with no validation keywords of its own.
function effectiveRoots(schema) {
  if (schema.type !== undefined) return [{ label: '(root)', node: schema }]
  const union = schema.oneOf ?? schema.anyOf
  if (Array.isArray(union) && union.every((branch) => typeof branch?.$ref === 'string' && branch.$ref.startsWith('#/$defs/'))) {
    return union.map((branch) => {
      const key = branch.$ref.slice('#/$defs/'.length)
      return { label: `$defs/${key}`, node: schema.$defs?.[key] }
    })
  }
  if (Object.keys(schema).every((key) => ROOT_META_KEYS.has(key)) && schema.$defs) {
    return Object.entries(schema.$defs).map(([key, node]) => ({ label: `$defs/${key}`, node }))
  }
  return []
}

function collectClosedObjectViolations(node, pathLabel, violations) {
  if (Array.isArray(node)) {
    node.forEach((value, index) => collectClosedObjectViolations(value, `${pathLabel}/${index}`, violations))
    return
  }
  if (!node || typeof node !== 'object') return
  if (node.additionalProperties === false) {
    if (node.properties?.ext?.type !== 'object') {
      violations.push(`${pathLabel || '(root)'} is closed but does not declare an ext container of type object`)
    }
    for (const reserved of ['ext', 'contractVersion']) {
      if (Array.isArray(node.required) && node.required.includes(reserved)) {
        violations.push(`${pathLabel || '(root)'} must not require ${reserved}`)
      }
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (DATA_KEYS.has(key)) continue
    collectClosedObjectViolations(value, `${pathLabel}/${key}`, violations)
  }
}

test('contracts directory exposes versioned contract files', () => {
  assert.notEqual(contractFiles.length, 0, 'contracts/ must contain versioned contract files')
  assert.ok(contractFiles.some((name) => name.endsWith('.schema.json')), 'contracts/ must contain schema contracts')
})

for (const basename of contractFiles) {
  const file = path.join(CONTRACTS_DIR, basename)

  test(`${basename} carries the canonical $id`, () => {
    const doc = readJson(file)
    assert.equal(doc.$id, ID_BASE + basename, `$id must be ${ID_BASE}${basename}`)
  })

  if (!basename.endsWith('.schema.json')) continue

  test(`${basename} follows the epoch schema conventions`, () => {
    const schema = readJson(file)

    assert.equal(schema.$schema, DRAFT_2020_12, '$schema must be the 2020-12 draft URI')
    assert.ok(typeof schema.title === 'string' && schema.title.length > 0, 'title must be present')
    assert.match(
      schema.$comment ?? '',
      /^contract revision \d+\.\d+\.\d+/,
      '$comment must carry the machine-visible contract revision marker',
    )

    const roots = effectiveRoots(schema)
    assert.notEqual(roots.length, 0, 'schema must expose at least one effective document root')

    for (const { label, node } of roots) {
      assert.ok(node && typeof node === 'object', `${label} must resolve to a subschema`)
      if (node.type !== 'object') continue
      assert.equal(node.additionalProperties, false, `${label} must set additionalProperties false`)
      const contractVersion = node.properties?.contractVersion
      const versionPattern = contractVersionPattern(basename)
      assert.equal(contractVersion?.type, 'string', `${label} must declare contractVersion of type string`)
      assert.equal(contractVersion?.pattern, versionPattern, `${label} contractVersion must use pattern ${versionPattern}`)
    }

    const violations = []
    collectClosedObjectViolations(schema, '', violations)
    assert.deepEqual(violations, [], `closed-object hygiene violations:\n${violations.join('\n')}`)
  })

  test(`${basename} compiles as a standalone 2020-12 schema`, () => {
    const ajv = new Ajv2020({
      allErrors: true,
      strict: false,
    })
    addFormats(ajv)
    assert.doesNotThrow(() => ajv.compile(readJson(file)), `${basename} must compile without an external schema registry`)
  })
}
