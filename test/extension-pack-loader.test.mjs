import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  ATELIER_EXT_NAMESPACE,
  PROTOCOL_POSTURE_POINTS,
  computePackDigest,
  createProtocolRegistry,
  loadExtensionPacks,
} from '../src/extension-packs/loader.mjs'
import { resolveProjectConfig } from '../src/project/config.mjs'
import { makeSampleProject } from './helpers/sample-project.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACK_FIXTURES = path.join(ROOT, 'fixtures', 'atelier-extension-pack')
const VALID_PACK = path.join(PACK_FIXTURES, 'valid', 'sample-pack.v1.json')
const VALID_PROTOCOL = path.join(PACK_FIXTURES, 'valid', 'protocols', 'contract-gate.v1.json')

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function entryFor(id, overrides = {}) {
  return { id, version: 'v1', path: `packs/${id}.v1.json`, enabled: true, ...overrides }
}

// Builds a temp project whose tracked config declares extension packs. Files
// are either copied from committed fixtures ({ from, to }) or written from an
// in-memory document ({ to, doc }).
function packProject(t, { entries, files = [], overlay = null, lock = null } = {}) {
  const sample = makeSampleProject(t)
  for (const file of files) {
    const target = path.join(sample.dir, file.to)
    if (file.doc) {
      writeJson(target, file.doc)
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(file.from, target)
    }
  }
  const config = readJson(sample.config)
  config.ext = { [ATELIER_EXT_NAMESPACE]: { extensionPacks: entries } }
  writeJson(sample.config, config)
  if (overlay) writeJson(path.join(sample.dir, 'atelier.local.json'), overlay)
  if (lock) writeJson(path.join(sample.dir, 'atelier.lock.json'), lock)
  const project = resolveProjectConfig({ argv: [`--project=${sample.config}`], cwd: sample.dir })
  return { sample, project }
}

function validPackFiles() {
  return [
    { from: VALID_PACK, to: 'packs/sample.readiness.v1.json' },
    { from: VALID_PROTOCOL, to: 'packs/protocols/contract-gate.v1.json' },
  ]
}

function errorText(report) {
  return report.errors.map((item) => item.message).join('\n')
}

test('no declared packs yields an empty result', (t) => {
  const sample = makeSampleProject(t)
  const project = resolveProjectConfig({ argv: [`--project=${sample.config}`], cwd: sample.dir })
  const result = loadExtensionPacks(project)
  assert.deepEqual(result, { packs: [], protocols: [], errors: [], warnings: [], skipped: [] })
})

test('a non-array extensionPacks declaration fails closed', (t) => {
  const { project } = packProject(t, { entries: {} })
  const report = loadExtensionPacks(project, { report: true })
  assert.equal(report.errors.length, 1)
  assert.equal(report.errors[0].packId, null)
  assert.match(report.errors[0].message, /extensionPacks must be an array/)
  assert.throws(() => loadExtensionPacks(project), /extensionPacks must be an array/)
})

test('a valid pack loads with raw-byte digest, protocol records, and stored lenses', (t) => {
  const { sample, project } = packProject(t, { entries: [entryFor('sample.readiness')], files: validPackFiles() })
  const result = loadExtensionPacks(project)

  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.warnings, [])
  assert.deepEqual(result.skipped, [])
  assert.equal(result.packs.length, 1)

  const pack = result.packs[0]
  const rawBytes = fs.readFileSync(path.join(sample.dir, 'packs/sample.readiness.v1.json'))
  assert.equal(pack.digest, `sha256:${crypto.createHash('sha256').update(rawBytes).digest('hex')}`)
  assert.equal(pack.digest, computePackDigest(rawBytes))
  assert.equal(pack.id, 'sample.readiness')
  assert.equal(pack.version, 'v1')
  assert.equal(pack.lock, 'unlocked')
  assert.equal(pack.lenses.length, 1)

  assert.equal(result.protocols.length, 1)
  const record = result.protocols[0]
  assert.equal(record.id, 'sample.readiness:contract-gate')
  assert.equal(record.packId, 'sample.readiness')
  assert.equal(record.slug, 'contract-gate')
  assert.equal(record.gate, 'required')
  assert.equal(record.protocol.schema, 'atelier-readiness-protocol@v1')
})

test('the orphaned reserved-term fixture is rejected with the dedicated reserved-namespace error', (t) => {
  const files = [{ from: path.join(PACK_FIXTURES, 'invalid', 'redefines-runtime-term.v1.json'), to: 'packs/sample.invalid.v1.json' }]
  const { project } = packProject(t, { entries: [entryFor('sample.invalid')], files })

  const report = loadExtensionPacks(project, { report: true })
  assert.equal(report.packs.length, 0)
  assert.equal(report.errors.length, 1)
  assert.equal(report.errors[0].packId, 'sample.invalid')
  assert.match(report.errors[0].message, /terms\[0\]\.id mnstry\.runtime:visibility redefines reserved mnstry runtime term/)

  assert.throws(() => loadExtensionPacks(project), /redefines reserved mnstry runtime term/)
})

const INVALID_PACK_EXPECTATIONS = [
  {
    fixture: 'wrong-namespace.v1.json',
    files: [],
    expected: /pack namespace other must equal the pack id prefix sample/,
  },
  {
    fixture: 'bundled-slug-collision.v1.json',
    files: [{ from: path.join(PACK_FIXTURES, 'invalid', 'protocols', 'offer-map.v1.json'), to: 'packs/protocols/offer-map.v1.json' }],
    expected: /protocol slug offer-map collides with a bundled protocol slug/,
  },
  {
    fixture: 'posture-tampered.v1.json',
    files: [{ from: path.join(PACK_FIXTURES, 'invalid', 'protocols', 'autonomous-authority.v1.json'), to: 'packs/protocols/autonomous-authority.v1.json' }],
    expected: /safetyPosture\.authority must be "proposal-only"/,
  },
  {
    fixture: 'escapes-root.v1.json',
    files: [],
    expected: /\/protocols\/0\/path must match pattern/,
  },
]

for (const invalid of INVALID_PACK_EXPECTATIONS) {
  test(`invalid fixture ${invalid.fixture} is rejected for its registered reason`, (t) => {
    const files = [
      { from: path.join(PACK_FIXTURES, 'invalid', invalid.fixture), to: 'packs/sample.readiness.v1.json' },
      ...invalid.files,
    ]
    const { project } = packProject(t, { entries: [entryFor('sample.readiness')], files })
    const report = loadExtensionPacks(project, { report: true })

    assert.equal(report.packs.length, 0, `${invalid.fixture} unexpectedly loaded`)
    assert.equal(report.errors.length, 1, `${invalid.fixture} must fail for exactly its registered reason:\n${errorText(report)}`)
    assert.match(report.errors[0].message, invalid.expected, `${invalid.fixture} failed for the wrong reason`)
  })
}

test('pack entry paths are traversal-guarded before any file is read', (t) => {
  const { project } = packProject(t, {
    entries: [
      entryFor('sample.alpha', { path: '/elsewhere/pack.json' }),
      entryFor('sample.beta', { path: 'packs/../../outside.json' }),
      entryFor('sample.gamma', { path: 'packs/pack.txt' }),
    ],
  })
  const report = loadExtensionPacks(project, { report: true })

  assert.equal(report.packs.length, 0)
  assert.equal(report.errors.length, 3)
  assert.match(report.errors[0].message, /path must not be an absolute path/)
  assert.equal(report.errors[0].packId, 'sample.alpha')
  assert.match(report.errors[1].message, /path must not contain \.\. segments/)
  assert.match(report.errors[2].message, /path must end with \.json/)
})

test('an absolute protocol path passes the schema but fails the code guard', (t) => {
  const doc = readJson(VALID_PACK)
  doc.protocols[0].path = '/elsewhere/contract-gate.v1.json'
  const { project } = packProject(t, {
    entries: [entryFor('sample.readiness')],
    files: [{ to: 'packs/sample.readiness.v1.json', doc }],
  })
  const report = loadExtensionPacks(project, { report: true })

  assert.equal(report.packs.length, 0)
  assert.match(errorText(report), /protocols\[0\]\.path must not be an absolute path/)
})

test('fixture references are traversal-guarded and missing files only warn', (t) => {
  const escaping = readJson(VALID_PACK)
  escaping.fixtures = ['../outside.txt']
  const escapingProject = packProject(t, {
    entries: [entryFor('sample.readiness')],
    files: [
      { to: 'packs/sample.readiness.v1.json', doc: escaping },
      { from: VALID_PROTOCOL, to: 'packs/protocols/contract-gate.v1.json' },
    ],
  })
  const escapingReport = loadExtensionPacks(escapingProject.project, { report: true })
  assert.equal(escapingReport.packs.length, 0)
  assert.match(errorText(escapingReport), /fixtures\[0\] must not contain \.\. segments/)

  const missing = readJson(VALID_PACK)
  missing.fixtures = ['data/notes.md']
  const missingProject = packProject(t, {
    entries: [entryFor('sample.readiness')],
    files: [
      { to: 'packs/sample.readiness.v1.json', doc: missing },
      { from: VALID_PROTOCOL, to: 'packs/protocols/contract-gate.v1.json' },
    ],
  })
  const missingReport = loadExtensionPacks(missingProject.project, { report: true })
  assert.deepEqual(missingReport.errors, [])
  assert.equal(missingReport.packs.length, 1)
  assert.equal(missingReport.warnings.length, 1)
  assert.match(missingReport.warnings[0].message, /fixtures\[0\] reference not found/)
})

test('a pack id that does not match its declaration is rejected', (t) => {
  const { project } = packProject(t, {
    entries: [entryFor('sample.other')],
    files: [
      { from: VALID_PACK, to: 'packs/sample.other.v1.json' },
      { from: VALID_PROTOCOL, to: 'packs/protocols/contract-gate.v1.json' },
    ],
  })
  const report = loadExtensionPacks(project, { report: true })

  assert.equal(report.packs.length, 0)
  assert.match(errorText(report), /pack id sample\.readiness does not match the declared id sample\.other/)
})

test('lock digest mismatch fails closed with the write remedy', (t) => {
  const { project } = packProject(t, {
    entries: [entryFor('sample.readiness')],
    files: validPackFiles(),
    lock: { extensionPacks: [{ id: 'sample.readiness', version: 'v1', digest: `sha256:${'0'.repeat(64)}` }] },
  })
  assert.throws(
    () => loadExtensionPacks(project),
    /lock digest mismatch for extension pack sample\.readiness; review the pack and run atelier lock write/,
  )
})

test('lock version mismatch fails closed', (t) => {
  const { project } = packProject(t, {
    entries: [entryFor('sample.readiness')],
    files: validPackFiles(),
    lock: { extensionPacks: [{ id: 'sample.readiness', version: 'v2' }] },
  })
  assert.throws(() => loadExtensionPacks(project), /lock version mismatch for extension pack sample\.readiness/)
})

test('a matching lock entry pins the pack', (t) => {
  const digest = computePackDigest(fs.readFileSync(VALID_PACK))
  const { project } = packProject(t, {
    entries: [entryFor('sample.readiness')],
    files: validPackFiles(),
    lock: { extensionPacks: [{ id: 'sample.readiness', version: 'v1', digest }] },
  })
  const result = loadExtensionPacks(project)

  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.warnings, [])
  assert.equal(result.packs[0].lock, 'locked')
})

test('a loaded pack absent from an existing lock warns without failing', (t) => {
  const { project } = packProject(t, {
    entries: [entryFor('sample.readiness')],
    files: validPackFiles(),
    lock: { extensionPacks: [{ id: 'mnstry-readiness-pack', version: 'v1' }] },
  })
  const result = loadExtensionPacks(project)

  assert.deepEqual(result.errors, [])
  assert.equal(result.packs[0].lock, 'unlocked')
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0].message, /not recorded in atelier\.lock\.json; run atelier lock write after review/)
})

test('a config-disabled pack is skipped without reading its file', (t) => {
  // The declared path does not exist; a read attempt would fail loudly.
  const { project } = packProject(t, {
    entries: [entryFor('sample.readiness', { enabled: false, path: 'packs/missing.v1.json' })],
  })
  const result = loadExtensionPacks(project)

  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.packs, [])
  assert.deepEqual(result.skipped, [{ packId: 'sample.readiness', reason: 'disabled-in-config' }])
})

test('an overlay disable skips without reading the file', (t) => {
  const { project } = packProject(t, {
    entries: [entryFor('sample.readiness', { path: 'packs/missing.v1.json' })],
    overlay: {
      schema: 'mnstry.atelier-local-overlay@v1',
      preferences: { extensionPacks: { 'sample.readiness': { enabled: false } } },
    },
  })
  const result = loadExtensionPacks(project)

  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.skipped, [{ packId: 'sample.readiness', reason: 'disabled-by-overlay' }])
})

test('the overlay is disable-only and cannot enable packs', (t) => {
  const { project } = packProject(t, {
    entries: [entryFor('sample.readiness', { enabled: false, path: 'packs/missing.v1.json' })],
    overlay: {
      schema: 'mnstry.atelier-local-overlay@v1',
      preferences: {
        extensionPacks: {
          'sample.readiness': { enabled: true },
          'sample.other': { enabled: true },
        },
      },
    },
  })
  const result = loadExtensionPacks(project)

  // The config disable wins; the overlay cannot flip it back on.
  assert.deepEqual(result.skipped, [{ packId: 'sample.readiness', reason: 'disabled-in-config' }])
  assert.deepEqual(result.packs, [])
  assert.deepEqual(result.errors, [])
  // The undeclared pack never loads and the reference is called out.
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0].message, /undeclared extension pack sample\.other/)
})

test('duplicate pack declarations are rejected', (t) => {
  const { project } = packProject(t, {
    entries: [entryFor('sample.readiness'), entryFor('sample.readiness')],
    files: validPackFiles(),
  })
  const report = loadExtensionPacks(project, { report: true })

  assert.equal(report.packs.length, 1)
  assert.equal(report.errors.length, 1)
  assert.match(report.errors[0].message, /duplicate extension pack declaration for sample\.readiness/)
  assert.throws(() => loadExtensionPacks(project), /duplicate extension pack declaration/)
})

test('duplicate protocol ids within a pack are rejected', (t) => {
  const doc = readJson(VALID_PACK)
  doc.protocols = [
    { ...doc.protocols[0] },
    { ...doc.protocols[0], title: 'Second declaration of the same protocol' },
  ]
  const { project } = packProject(t, {
    entries: [entryFor('sample.readiness')],
    files: [
      { to: 'packs/sample.readiness.v1.json', doc },
      { from: VALID_PROTOCOL, to: 'packs/protocols/contract-gate.v1.json' },
    ],
  })
  const report = loadExtensionPacks(project, { report: true })

  assert.equal(report.packs.length, 0)
  assert.match(errorText(report), /duplicate protocol id sample\.readiness:contract-gate/)
})

test('the registry resolves pack protocols by namespaced id only', (t) => {
  const { project } = packProject(t, { entries: [entryFor('sample.readiness')], files: validPackFiles() })
  const { packs } = loadExtensionPacks(project)
  const registry = createProtocolRegistry({ packs })

  assert.equal(registry.protocolById('sample.readiness:contract-gate')?.id, 'sample.readiness:contract-gate')
  // Bare-slug lookup stays a bundled-only affordance; a pack protocol slug
  // resolves to null, so bundled-slug shadowing is structurally closed.
  assert.equal(registry.protocolById('contract-gate'), null)
  assert.equal(registry.protocolById('offer-map')?.id, 'mnstry.readiness:offer-map')
  assert.equal(registry.listProtocols().length, 13)
  assert.equal(registry.packs.length, 1)
})

const POSTURE_TAMPERS = [
  { point: 'safetyPosture.runtimeMutation', mutate: (doc) => { doc.safetyPosture.runtimeMutation = true }, expected: /safetyPosture\.runtimeMutation must be false/ },
  { point: 'safetyPosture.externalEgress', mutate: (doc) => { doc.safetyPosture.externalEgress = true }, expected: /safetyPosture\.externalEgress must be false/ },
  { point: 'safetyPosture.defaultVisibility', mutate: (doc) => { doc.safetyPosture.defaultVisibility = 'public' }, expected: /safetyPosture\.defaultVisibility must be "private"/ },
  { point: 'safetyPosture.authority', mutate: (doc) => { doc.safetyPosture.authority = 'autonomous' }, expected: /safetyPosture\.authority must be "proposal-only"/ },
  { point: 'safetyPosture.reviewMode', mutate: (doc) => { doc.safetyPosture.reviewMode = 'auto-apply' }, expected: /safetyPosture\.reviewMode must be "static-inspection"/ },
  { point: 'safetyPosture.failClosedOnMissingEvidence', mutate: (doc) => { doc.safetyPosture.failClosedOnMissingEvidence = false }, expected: /safetyPosture\.failClosedOnMissingEvidence must be true/ },
  { point: 'safetyPosture.refuses', mutate: (doc) => { doc.safetyPosture.refuses = ['telemetry'] }, expected: /safetyPosture\.refuses must be an array including "runtime writes"/ },
  // Points 8 and 9 are also schema consts, so tampering trips the contract
  // first; the loader fails closed either way and keeps the code check as a
  // backstop should the contract ever loosen.
  { point: 'safety.runtimeMutation', mutate: (doc) => { doc.safety.runtimeMutation = true }, expected: /\/safety\/runtimeMutation must be equal to constant/ },
  { point: 'outputs.runSchema', mutate: (doc) => { doc.outputs.runSchema = 'atelier-readiness-run@v2' }, expected: /\/outputs\/runSchema must be equal to constant/ },
]

test('each of the nine posture points is individually enforced', (t) => {
  assert.equal(PROTOCOL_POSTURE_POINTS.length, 9)
  assert.equal(POSTURE_TAMPERS.length, 9)

  for (const tamper of POSTURE_TAMPERS) {
    const protocolDoc = readJson(VALID_PROTOCOL)
    tamper.mutate(protocolDoc)
    const { project } = packProject(t, {
      entries: [entryFor('sample.readiness')],
      files: [
        { from: VALID_PACK, to: 'packs/sample.readiness.v1.json' },
        { to: 'packs/protocols/contract-gate.v1.json', doc: protocolDoc },
      ],
    })
    const report = loadExtensionPacks(project, { report: true })

    assert.equal(report.packs.length, 0, `${tamper.point} tamper must fail the pack`)
    assert.match(errorText(report), tamper.expected, `${tamper.point} tamper failed for the wrong reason:\n${errorText(report)}`)
  }
})

test('a protocol without any safety posture fails every code-enforced point', (t) => {
  const protocolDoc = readJson(VALID_PROTOCOL)
  delete protocolDoc.safetyPosture
  const { project } = packProject(t, {
    entries: [entryFor('sample.readiness')],
    files: [
      { from: VALID_PACK, to: 'packs/sample.readiness.v1.json' },
      { to: 'packs/protocols/contract-gate.v1.json', doc: protocolDoc },
    ],
  })
  const report = loadExtensionPacks(project, { report: true })

  assert.equal(report.packs.length, 0)
  const postureErrors = report.errors.filter((item) => item.message.includes('violates the required safety posture'))
  assert.equal(postureErrors.length, 7)
})
