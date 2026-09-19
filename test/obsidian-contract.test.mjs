import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { CONTRACT_CORPUS, CORPUS_ROOT, corpusInvalidFiles, corpusValidFiles } from '../src/contracts/corpus.mjs'
import { validateProjectConfigDoc } from '../src/project/config.mjs'
import {
  DECLARED_RELATION_TYPES,
  IMPLEMENTED_EDIT_CLASSES,
  OBSIDIAN_CONTRACTS,
  OBSIDIAN_EXT_KEY,
  ObsidianContractRefusal,
  RELATION_TYPES,
  allocateNotePaths,
  createScopeSelectorForOracleTests,
  readObsidianExtSettings,
  resolveTitleLink,
  selectScope,
  validateObsidianContract,
} from '../src/projection/obsidian/contracts.mjs'

// G01: closed-schema, eligibility and audience refusal.
// G02: selector algebra, canonical relation types and literal topology oracles.
//
// The oracles in fixtures/obsidian/contracts/oracles/scope-cases.json are
// literal node and edge sets. They are compared with the output of the real
// selectScope, and the mutation controls at the end prove the comparison fails
// when selection behaviour is broken.

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

const ORACLES = readJson(path.join(CORPUS_ROOT, 'fixtures/obsidian/contracts/oracles/scope-cases.json'))
const PROFILE = readJson(path.join(CORPUS_ROOT, ORACLES.profileFixture))
const SNAPSHOT = { nodes: ORACLES.nodes, edges: ORACLES.edges }
const sorted = (values) => [...values].sort()

function refusalCode(run) {
  try {
    run()
  } catch (error) {
    assert.ok(error instanceof ObsidianContractRefusal, `expected a typed refusal, got ${error}`)
    return error.code
  }
  return null
}

// ---------------------------------------------------------------------------
// G01: registration and fixture coverage
// ---------------------------------------------------------------------------

// Every invalid fixture must be refused at the registered layer for the
// registered reason, not merely refused.
const INVALID_EXPECTATIONS = {
  'corpus-profile': {
    'absolute-path-in-ext.v1.json': ['semantic', /absolute-path-in-portable-shape \/ext\/checkout/],
    'absolute-repository-root.v1.json': ['schema', /\/repositories\/0\/root must match pattern/],
    'duplicate-repository-id.v1.json': ['semantic', /duplicate-identity \/repositories/],
    'overlapping-managed-roots.v1.json': ['semantic', /overlapping-managed-roots \/repositories\/1\/root/],
    'unknown-enrollment.v1.json': ['schema', /\/repositories\/1\/enrollment must be one of/],
    'unknown-top-level-field.v1.json': ['schema', /\/ must not include additional property vaultRoot/],
  },
  scope: {
    'absolute-path-prefix.v1.json': ['schema', /\/selector\/pathPrefix must match pattern/],
    'duplicate-ids.v1.json': ['schema', /\/selector\/ids must NOT have duplicate items/],
    'expansion-without-node-budget.v1.json': ['schema', /\/expansion must include required property maxNodes/],
    'full-mode-with-subset.v1.json': ['schema', /\/selector must include required property all/],
    'unknown-mode.v1.json': ['schema', /\/mode must be one of/],
    'unknown-selector-key.v1.json': ['schema', /\/selector must not include additional property query/],
    'unknown-selector-operator.v1.json': ['schema', /\/selector must not include additional property run/],
    'unknown-top-level-field.v1.json': ['schema', /\/ must not include additional property fallback/],
  },
  'source-snapshot': {
    'absolute-file-path.v1.json': ['schema', /\/repositories\/0\/files\/0\/path must match pattern/],
    'duplicate-repository-id.v1.json': ['semantic', /duplicate-identity \/repositories/],
    'mixed-read.v1.json': ['schema', /\/readConsistency must be "single-read"/],
    'parent-traversal-path.v1.json': ['schema', /\/repositories\/0\/files\/0\/path must match pattern/],
    'unknown-file-field.v1.json': ['schema', /\/repositories\/0\/files\/0 must not include additional property content/],
  },
  'generation-manifest': {
    'absolute-note-path.v1.json': ['schema', /\/notes\/0\/path must match pattern/],
    'complete-with-unwritten-notes.v1.json': ['semantic', /incomplete-generation/],
    'derived-link-claimed-declared.v1.json': ['schema', /\/links\/0\/origin must be "markdown"/],
    'duplicate-note-identity.v1.json': ['semantic', /duplicate-identity \/notes/],
    'in-scope-endpoint-missing.v1.json': ['semantic', /unknown-edge-endpoint \/links\/2\/targetNodeId/],
    'title-only-note-path.v1.json': ['schema', /\/notes\/0\/path must match pattern/],
    'unknown-note-field.v1.json': ['schema', /\/notes\/0 must not include additional property body/],
    'unknown-relation-type.v1.json': ['schema', /\/links\/1\/type must be one of/],
    'withheld-endpoint.v1.json': ['schema', /\/links\/2\/targetState must be one of in-scope, outside-selection/],
  },
  'publication-journal': {
    'absolute-recovery-ref.v1.json': ['schema', /\/entries\/0\/recoveryRef must match pattern/],
    'duplicate-sequence.v1.json': ['semantic', /duplicate-identity \/entries/],
    'empty-protocol-id.v1.json': ['schema', /\/protocolId must NOT have fewer than 1 characters/],
    'missing-protocol-id.v1.json': ['schema', /\/ must include required property protocolId/],
    'unknown-entry-field.v1.json': ['schema', /\/entries\/0 must not include additional property bytes/],
    'unknown-state.v1.json': ['schema', /\/state must be one of/],
  },
  'service-state': {
    'hostname-instead-of-literal-loopback.v1.json': ['schema', /\/host must be one of 127\.0\.0\.1, ::1/],
    'missing-consent.v1.json': ['schema', /\/ must include required property consent/],
    'privileged-port.v1.json': ['schema', /\/port must be >= 1024/],
    'unknown-top-level-field.v1.json': ['schema', /\/ must not include additional property adoptedByPort/],
    'wildcard-bind.v1.json': ['schema', /\/host must be one of 127\.0\.0\.1, ::1/],
  },
  'edit-operation': {
    'absolute-recovery-ref.v1.json': ['schema', /\/observed\/recoveryRef must match pattern/],
    'inline-observed-bytes.v1.json': ['schema', /\/observed must not include additional property base64/],
    'missing-base-digest.v1.json': ['schema', /\/ must include required property baseSourceDigest/],
    'short-idempotency-key.v1.json': ['schema', /\/idempotencyKey must NOT have fewer than 16 characters/],
    'unknown-kind.v1.json': ['schema', /\/kind must be one of/],
  },
  'apply-policy': {
    'automatic-without-edit-class.v1.json': ['schema', /\/allowedEditClasses must contain at least 1 item/],
    'conflict-overwrite.v1.json': ['schema', /\/conflictDisposition must be "hold"/],
    'missing-policy-digest.v1.json': ['schema', /\/ must include required property digest/],
    'unbounded-batch.v1.json': ['schema', /\/maxBatchSize must be <= 1000/],
    'unimplemented-edit-class.v1.json': ['schema', /\/allowedEditClasses\/1 must be one of body-replacement/],
    'unknown-mode.v1.json': ['schema', /\/mode must be one of manual, automatic/],
    'unknown-selector-operator.v1.json': ['schema', /\/selector must not include additional property run/],
    'unknown-top-level-field.v1.json': ['schema', /\/ must not include additional property skipStaleSourceCheck/],
  },
  'proposal-receipt': {
    'accepted-without-proposal-id.v1.json': ['schema', /\/proposalId must be string/],
    'missing-adapter-operation-id.v1.json': ['schema', /\/ must include required property adapterOperationId/],
    'unknown-backpressure-outcome.v1.json': ['schema', /\/backpressure must be one of/],
    'unknown-top-level-field.v1.json': ['schema', /\/ must not include additional property sourceApplyAuthority/],
  },
  'acceptance-receipt': {
    'duplicate-evidence-name.v1.json': ['semantic', /duplicate-identity \/evidence/],
    'evidence-by-absolute-path.v1.json': ['schema', /\/evidence\/0\/name must match pattern/],
    'missing-candidate-tree.v1.json': ['schema', /\/candidate must include required property treeDigest/],
    'no-evidence.v1.json': ['schema', /\/evidence must contain at least 1 item/],
    'unknown-outcome.v1.json': ['schema', /\/outcome must be one of/],
    'unknown-top-level-field.v1.json': ['schema', /\/ must not include additional property waiver/],
  },
  'ext-settings': {
    'absolute-path-prefix.v1.json': ['schema', /\/scopes\/1\/selector\/pathPrefix must match pattern/],
    'apply-policy-in-portable-settings.v1.json': ['schema', /\/ must not include additional property applyPolicy/],
    'duplicate-scope-id.v1.json': ['semantic', /duplicate-identity \/scopes/],
    'machine-local-vault-path.v1.json': ['schema', /\/ must not include additional property vaultPath/],
    'service-port-in-portable-settings.v1.json': ['schema', /\/ must not include additional property port/],
    'unknown-default-scope.v1.json': ['semantic', /unknown-scope \/defaultScopeId/],
  },
}

test('every Obsidian contract file is registered in the contract corpus', () => {
  const onDisk = fs.readdirSync(path.join(CORPUS_ROOT, 'contracts')).filter((name) => name.startsWith('atelier-obsidian-')).sort()
  assert.equal(onDisk.length, 11)
  assert.deepEqual(sorted(OBSIDIAN_CONTRACTS.map((contract) => path.basename(contract.contractFile))), onDisk)
  for (const contract of OBSIDIAN_CONTRACTS) {
    const entry = CONTRACT_CORPUS.find((item) => item.name === contract.name)
    assert.ok(entry, `${contract.name} is missing from CONTRACT_CORPUS`)
    assert.equal(entry.contractFile, contract.contractFile)
    assert.equal(entry.fixtureRoot, contract.fixtureRoot)
    // Coverage lives here, so the generic registry test must not also claim it.
    assert.equal(entry.registry, false)
    const schema = readJson(path.join(CORPUS_ROOT, contract.contractFile))
    assert.equal(schema.properties.schema.const, contract.schemaConst)
    assert.equal(schema.additionalProperties, false)
  }
  assert.deepEqual(sorted(Object.keys(INVALID_EXPECTATIONS)), sorted(OBSIDIAN_CONTRACTS.map((contract) => contract.shape)))
})

for (const contract of OBSIDIAN_CONTRACTS) {
  const entry = CONTRACT_CORPUS.find((item) => item.name === contract.name)

  test(`${contract.name} accepts its valid fixtures`, () => {
    const files = corpusValidFiles(entry)
    assert.notEqual(files.length, 0, `${contract.name} needs at least one valid fixture`)
    // The compat gate compiles the bare schema, so check that path as well as
    // the shipped validator.
    const ajv = new Ajv2020({ allErrors: true, strict: false })
    addFormats(ajv)
    const validate = ajv.compile(readJson(path.join(CORPUS_ROOT, contract.contractFile)))
    for (const file of files) {
      const doc = readJson(file)
      assert.equal(validate(doc), true, `${path.basename(file)} rejected by the bare schema`)
      assert.deepEqual(validateObsidianContract(contract.shape, doc), [], `${path.basename(file)} refused`)
    }
  })

  test(`${contract.name} refuses each invalid fixture for the registered reason`, () => {
    const files = corpusInvalidFiles(entry)
    assert.notEqual(files.length, 0, `${contract.name} needs at least one invalid fixture`)
    const expectations = INVALID_EXPECTATIONS[contract.shape]
    assert.deepEqual(sorted(files.map((file) => path.basename(file))), sorted(Object.keys(expectations)), 'fixtures and expectations must match one to one')
    for (const file of files) {
      const basename = path.basename(file)
      const [layer, reason] = expectations[basename]
      const errors = validateObsidianContract(contract.shape, readJson(file))
      assert.notEqual(errors.length, 0, `${basename} unexpectedly accepted`)
      assert.ok(errors.every((error) => error.layer === layer), `${basename} refused at the wrong layer`)
      const rendered = errors.map((error) => (error.layer === 'schema' ? error.message : `${error.code} ${error.message}`)).join('\n')
      assert.match(rendered, reason, `${basename} refused for the wrong reason:\n${rendered}`)
    }
  })
}

test('portable fixtures carry no machine-local path; private shapes are where those live', () => {
  const absolute = /"(?:\/|~\/|[A-Za-z]:\\\\|file:)/
  for (const contract of OBSIDIAN_CONTRACTS) {
    const entry = CONTRACT_CORPUS.find((item) => item.name === contract.name)
    for (const file of corpusValidFiles(entry)) {
      const found = absolute.test(fs.readFileSync(file, 'utf8'))
      if (contract.portability === 'portable') assert.equal(found, false, `${path.basename(file)} is portable but carries an absolute path`)
    }
  }
  assert.deepEqual(
    OBSIDIAN_CONTRACTS.filter((contract) => contract.portability === 'private').map((contract) => contract.shape),
    ['publication-journal', 'service-state', 'apply-policy'],
  )
})

test('only the implemented edit class is accepted', () => {
  assert.deepEqual(IMPLEMENTED_EDIT_CLASSES, ['body-replacement'])
  const schema = readJson(path.join(CORPUS_ROOT, 'contracts/atelier-obsidian-apply-policy.v1.schema.json'))
  assert.deepEqual(schema.$defs.editClass.enum, IMPLEMENTED_EDIT_CLASSES)
})

test('the journal requires a protocol ID without pinning the prototype value', () => {
  const schema = readJson(path.join(CORPUS_ROOT, 'contracts/atelier-obsidian-publication-journal.v1.schema.json'))
  assert.ok(schema.required.includes('protocolId'))
  assert.equal(schema.properties.protocolId.const, undefined)
  assert.equal(schema.properties.protocolId.enum, undefined)
})

test('project ext settings validate in the adapter while the project v1 contract stays closed and unchanged', () => {
  const settings = readJson(path.join(CORPUS_ROOT, 'fixtures/obsidian/contracts/ext-settings/valid/enabled-with-scopes.v1.json'))
  const project = readJson(path.join(CORPUS_ROOT, 'fixtures/atelier-project-config/valid', fs.readdirSync(path.join(CORPUS_ROOT, 'fixtures/atelier-project-config/valid')).sort()[0]))
  assert.equal(readObsidianExtSettings(project), null)

  const configured = { ...project, ext: { ...(project.ext ?? {}), [OBSIDIAN_EXT_KEY]: settings } }
  assert.deepEqual(validateProjectConfigDoc(configured), [])
  assert.deepEqual(readObsidianExtSettings(configured), settings)

  const unknownKey = { ...project, ext: { [OBSIDIAN_EXT_KEY]: { ...settings, vaultPath: 'vaults/main' } } }
  assert.deepEqual(validateProjectConfigDoc(unknownKey), [], 'the project contract does not inspect ext')
  assert.equal(refusalCode(() => readObsidianExtSettings(unknownKey)), 'invalid-ext-settings')
})

// ---------------------------------------------------------------------------
// G02: literal topology oracles against the real selector
// ---------------------------------------------------------------------------

function runCase(select, oracle) {
  return select({
    canonicalSnapshot: SNAPSHOT,
    profile: PROFILE,
    selector: oracle.selector,
    expansion: oracle.expansion,
    mode: oracle.mode ?? 'scoped',
  })
}

// Compares one literal oracle with a selector's output and returns every
// difference. Shared by the real assertions and the mutation controls so both
// exercise exactly the same comparison.
function oracleDifferences(select, oracle) {
  const differences = []
  const expect = (label, actual, expected) => {
    try {
      assert.deepEqual(actual, expected)
    } catch {
      differences.push(`${oracle.name}: ${label} ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
    }
  }
  let result
  try {
    result = runCase(select, oracle)
  } catch (error) {
    return [`${oracle.name}: threw ${error.code ?? error.message}`]
  }
  expect('nodes', result.nodes, sorted(oracle.expectedNodes))
  expect('edges', result.edges, sorted(oracle.expectedEdges))
  expect('truncated', result.truncated, oracle.truncated === true)
  expect('diagnostic', result.diagnostics.filter((code) => code.startsWith('selection-')), oracle.diagnostic ? [oracle.diagnostic] : [])
  if (oracle.expectedVaultNodes) expect('vaultNodes', result.vaultNodes, sorted(oracle.expectedVaultNodes))
  if (oracle.expectedFilterPaths) {
    const allocated = allocateNotePaths(ORACLES.nodes.filter((node) => result.vaultNodes.includes(node.id)))
    expect('filterPaths', result.nodes.map((id) => allocated[id]), oracle.expectedFilterPaths)
  }
  if (oracle.expectedDistinctPaths) {
    const allocated = allocateNotePaths(ORACLES.nodes.filter((node) => result.nodes.includes(node.id)))
    expect('distinctPaths', new Set(Object.values(allocated)).size, result.nodes.length)
  }
  return differences
}

const failingCases = (select) => ORACLES.cases.filter((oracle) => oracleDifferences(select, oracle).length > 0).map((oracle) => oracle.name)

test('the oracle file carries the fourteen literal cases and four refusals', () => {
  assert.deepEqual(ORACLES.cases.map((oracle) => oracle.name), [
    'full', 'explicit-cross-repository', 'repo', 'path', 'tag', 'type', 'union', 'intersection', 'exclude', 'empty',
    'withheld', 'focus', 'bounded-expand', 'duplicate-titles-allowed',
  ])
  assert.deepEqual(ORACLES.refusals.map((oracle) => oracle.name), [
    'duplicate-identity', 'ambiguous-title-link', 'unknown-selector', 'unbounded-expansion',
  ])
  assert.deepEqual(validateObsidianContract('corpus-profile', PROFILE), [])
})

for (const oracle of ORACLES.cases) {
  test(`selectScope matches the literal oracle: ${oracle.name}`, () => {
    assert.deepEqual(oracleDifferences(selectScope, oracle), [])
  })
}

test('the oracle graph exercises all eight declared relation types and derived links_to', () => {
  const full = runCase(selectScope, ORACLES.cases[0])
  const types = full.edges.map((id) => ORACLES.edges.find((edge) => edge.id === id).type)
  assert.deepEqual(sorted(new Set(types)), sorted(RELATION_TYPES))
  assert.equal(DECLARED_RELATION_TYPES.length, 8)
  for (const id of full.edges) {
    const edge = ORACLES.edges.find((item) => item.id === id)
    assert.equal(edge.origin === 'declared', edge.type !== 'links_to')
  }
})

test('stable note paths reproduce the literal path registry for every view', () => {
  const visible = ORACLES.nodes.filter((node) => node.eligible)
  assert.deepEqual(allocateNotePaths(visible), ORACLES.pathRegistry)
  // The same identity keeps the same path in a scoped view.
  const scoped = allocateNotePaths(visible.filter((node) => ['a', 'd'].includes(node.id)))
  assert.deepEqual(scoped, { a: ORACLES.pathRegistry.a, d: ORACLES.pathRegistry.d })
})

test('refusal: duplicate canonical identity', () => {
  const canonicalSnapshot = { nodes: [...ORACLES.nodes, { ...ORACLES.nodes[0], title: 'Another title' }], edges: ORACLES.edges }
  const code = refusalCode(() => selectScope({ canonicalSnapshot, profile: PROFILE, selector: { all: true } }))
  assert.equal(code, ORACLES.refusals[0].expectedError)
  assert.equal(code, 'duplicate-identity')
})

test('refusal: ambiguous title-only link', () => {
  const oracle = ORACLES.refusals[1]
  const code = refusalCode(() => resolveTitleLink({ canonicalSnapshot: SNAPSHOT, profile: PROFILE, input: oracle.input }))
  assert.equal(code, oracle.expectedError)
  assert.equal(code, 'ambiguous-target')
  assert.equal(resolveTitleLink({ canonicalSnapshot: SNAPSHOT, profile: PROFILE, input: '[[Second concept]]' }), 'b')
  // A withheld title resolves exactly like a title that does not exist.
  assert.equal(refusalCode(() => resolveTitleLink({ canonicalSnapshot: SNAPSHOT, profile: PROFILE, input: '[[Withheld]]' })), 'unresolved-target')
  assert.equal(refusalCode(() => resolveTitleLink({ canonicalSnapshot: SNAPSHOT, profile: PROFILE, input: '[[No such title]]' })), 'unresolved-target')
})

test('refusal: unknown selector', () => {
  const oracle = ORACLES.refusals[2]
  assert.equal(refusalCode(() => runCase(selectScope, oracle)), oracle.expectedError)
  assert.equal(oracle.expectedError, 'unknown-selector')
  for (const selector of [{}, { tag: 'topic', type: 'md' }, { pathPrefix: 'plans/' }, { union: [{ run: 'x' }] }, 'all', null]) {
    assert.equal(refusalCode(() => selectScope({ canonicalSnapshot: SNAPSHOT, profile: PROFILE, selector })), 'unknown-selector')
  }
})

test('refusal: expansion without a node budget', () => {
  const oracle = ORACLES.refusals[3]
  assert.equal(refusalCode(() => runCase(selectScope, oracle)), oracle.expectedError)
  assert.equal(oracle.expectedError, 'missing-expansion-budget')
  assert.equal(refusalCode(() => runCase(selectScope, { selector: { ids: ['a'] }, expansion: { maxNodes: 3 } })), 'missing-expansion-budget')
  assert.equal(refusalCode(() => runCase(selectScope, { selector: { ids: ['a'] }, expansion: { depth: 99, maxNodes: 3 } })), 'invalid-expansion')
})

test('further typed refusals: unknown repository, relation type, mode and full-mode subset', () => {
  assert.equal(refusalCode(() => runCase(selectScope, { selector: { repo: 'east' } })), 'unknown-repo')
  assert.equal(refusalCode(() => runCase(selectScope, { selector: { repo: 'north' }, mode: 'full' })), 'full-mode-requires-all')
  assert.equal(refusalCode(() => runCase(selectScope, { selector: { all: true }, mode: 'everything' })), 'unknown-mode')
  assert.equal(refusalCode(() => runCase(selectScope, { selector: { ids: ['a', 'a'] } })), 'duplicate-identity')
  const mentions = { nodes: ORACLES.nodes, edges: [...ORACLES.edges, { id: 'e11', source: 'a', target: 'b', type: 'mentions', origin: 'declared' }] }
  assert.equal(refusalCode(() => selectScope({ canonicalSnapshot: mentions, profile: PROFILE, selector: { all: true } })), 'unknown-relation-type')
  const dangling = { nodes: ORACLES.nodes, edges: [{ id: 'e11', source: 'a', target: 'nowhere', type: 'related', origin: 'declared' }] }
  assert.equal(refusalCode(() => selectScope({ canonicalSnapshot: dangling, profile: PROFILE, selector: { all: true } })), 'unknown-edge-endpoint')
})

test('withheld nodes and edges to withheld endpoints never leak', () => {
  const withheld = ORACLES.nodes.find((node) => node.eligible === false)
  for (const oracle of ORACLES.cases) {
    for (const direction of ['outgoing', 'incoming', 'both']) {
      const result = runCase(selectScope, { ...oracle, expansion: { depth: 3, maxNodes: 50, direction, order: 'canonical-id' } })
      const listed = [...result.nodes, ...result.vaultNodes]
      assert.equal(listed.includes(withheld.id), false, `${oracle.name} lists the withheld node`)
      for (const edges of [result.edges, result.vaultEdges, result.outsideSelectionEdges]) {
        assert.equal(edges.includes('e10'), false, `${oracle.name} lists an edge to a withheld endpoint`)
      }
      assert.equal(JSON.stringify(result).includes(withheld.title), false)
    }
  }
  // A withheld identity and an absent identity are indistinguishable.
  const asWithheld = runCase(selectScope, { selector: { ids: ['x'] } })
  const withoutIt = { nodes: ORACLES.nodes.filter((node) => node.id !== 'x'), edges: ORACLES.edges.filter((edge) => edge.target !== 'x') }
  const asAbsent = selectScope({ canonicalSnapshot: withoutIt, profile: PROFILE, selector: { ids: ['x'] } })
  assert.deepEqual(asWithheld, asAbsent)
  assert.deepEqual(asWithheld.unresolvedIds, ['x'])
})

test('eligibility fails closed and audience and enrollment withhold', () => {
  const select = (nodes, profile = PROFILE) => selectScope({ canonicalSnapshot: { nodes, edges: [] }, profile, selector: { all: true } }).nodes
  const base = ORACLES.nodes[0]
  assert.deepEqual(select([base]), ['a'])
  const { eligible, ...unstated } = base
  assert.equal(eligible, true)
  assert.deepEqual(select([unstated]), [], 'a node without an explicit eligibility is withheld')
  assert.deepEqual(select([{ ...base, eligible: 'true' }]), [])
  assert.deepEqual(select([{ ...base, audience: 'team' }]), ['a'])
  assert.deepEqual(select([{ ...base, audience: 'restricted' }]), [])
  assert.deepEqual(select([{ ...base, repo: 'elsewhere' }]), [], 'a node outside every enrolled repository is withheld')

  const paused = structuredClone(PROFILE)
  paused.repositories[0].enrollment = 'paused'
  assert.deepEqual(select([base], paused), [])
  const repositoryAudience = structuredClone(PROFILE)
  repositoryAudience.repositories[0].audience = 'restricted'
  assert.deepEqual(select([base], repositoryAudience), [])
  assert.deepEqual(select([{ ...base, audience: 'team' }], repositoryAudience), ['a'], 'a node audience overrides its repository default')
})

test('output order is deterministic and independent of input order', () => {
  const reversed = { nodes: [...ORACLES.nodes].reverse(), edges: [...ORACLES.edges].reverse() }
  for (const oracle of ORACLES.cases) {
    const forward = runCase(selectScope, oracle)
    const backward = selectScope({ canonicalSnapshot: reversed, profile: PROFILE, selector: oracle.selector, expansion: oracle.expansion, mode: oracle.mode ?? 'scoped' })
    assert.deepEqual(backward, forward, oracle.name)
    assert.deepEqual(forward.nodes, sorted(forward.nodes))
    assert.deepEqual(forward.edges, sorted(forward.edges))
  }
})

test('exact duplicate edges are deduplicated and expansion follows its direction', () => {
  const twin = { nodes: ORACLES.nodes, edges: [...ORACLES.edges, { ...ORACLES.edges[0], id: 'e0-twin' }] }
  const result = selectScope({ canonicalSnapshot: twin, profile: PROFILE, selector: { ids: ['a', 'b'] } })
  assert.deepEqual(result.edges, ['e0-twin'], 'one edge survives, chosen by canonical id')

  const expansion = { depth: 1, maxNodes: 10, order: 'canonical-id' }
  assert.deepEqual(runCase(selectScope, { selector: { ids: ['b'] }, expansion: { ...expansion, direction: 'outgoing' } }).nodes, ['b', 'c', 'd'])
  assert.deepEqual(runCase(selectScope, { selector: { ids: ['b'] }, expansion: { ...expansion, direction: 'incoming' } }).nodes, ['a', 'b', 'd'])
  assert.deepEqual(runCase(selectScope, { selector: { ids: ['c'] }, expansion: { ...expansion, direction: 'incoming' } }).nodes, ['a', 'b', 'c'])
  const roomy = runCase(selectScope, { selector: { ids: ['a'] }, expansion: { ...expansion, direction: 'outgoing' } })
  assert.deepEqual(roomy.nodes, ['a', 'b', 'c', 'd'])
  assert.equal(roomy.truncated, false)
  assert.deepEqual(runCase(selectScope, { selector: { ids: ['a'] } }).outsideSelectionEdges, ['e1', 'e3', 'e4', 'e5', 'e6'])
})

// ---------------------------------------------------------------------------
// Mutation controls: the oracle comparison must fail for broken selectors
// ---------------------------------------------------------------------------

test('control: the real selector fails no oracle', () => {
  assert.deepEqual(failingCases(selectScope), [])
})

test('mutation: ignoring exclusion fails the exclude oracle', () => {
  const broken = createScopeSelectorForOracleTests({ difference: (base) => base })
  assert.deepEqual(failingCases(broken), ['exclude'])
})

test('mutation: unbounded expansion fails the bounded-expand oracle', () => {
  const broken = createScopeSelectorForOracleTests({ hasBudget: () => true })
  assert.deepEqual(failingCases(broken), ['bounded-expand'])
})

test('mutation: removing the withheld filter fails every oracle the withheld node can reach', () => {
  const broken = createScopeSelectorForOracleTests({ isVisible: () => true })
  assert.deepEqual(failingCases(broken), ['full', 'repo', 'tag', 'union', 'intersection', 'withheld', 'focus'])
})

test('mutation: wrapped selectors that change the algebra or topology fail their oracles', () => {
  const rewrite = (selector) => (selector.union ? { intersection: selector.union } : selector)
  const unionAsIntersection = (input) => selectScope({ ...input, selector: rewrite(input.selector) })
  assert.deepEqual(failingCases(unionAsIntersection), ['union'])

  const intersectionAsUnion = (input) => selectScope({ ...input, selector: input.selector.intersection ? { union: input.selector.intersection } : input.selector })
  assert.deepEqual(failingCases(intersectionAsUnion), ['intersection'])

  const vaultWideEdges = (input) => {
    const result = selectScope(input)
    return { ...result, edges: selectScope({ ...input, selector: { all: true }, expansion: undefined }).edges }
  }
  assert.ok(failingCases(vaultWideEdges).length >= 10)

  const ignoresSelector = (input) => selectScope({ ...input, selector: { all: true }, mode: input.mode })
  assert.deepEqual(failingCases(ignoresSelector), ORACLES.cases.map((oracle) => oracle.name).filter((name) => name !== 'full'))
})
