import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createProposalStore } from '../src/collaboration/proposals.mjs'
import { SOURCE_APPLY_PRIMITIVES, openObjectStore } from '../src/projection/obsidian/edits/index.mjs'
import {
  MAX_ROUTED_SOURCE_PATH, PROPOSAL_QUEUE_LIMITS, PROPOSAL_ROUTE_REFUSALS, PROPOSAL_ROUTER_PRIMITIVES, ProposalQueueRefusal, adapterOperationId, createProposalRouterForOracleTests, isAdapterOperationId, isProposalOperationRecord,
  openProposalQueue, proposalStoreId, resolveProposalRoute,
} from '../src/projection/obsidian/proposals/index.mjs'
import { protectedRoots } from '../src/runtime/obsidian/machine-settings.mjs'
import { digestOf, makeOperation } from './support/obsidian-edits/operations.mjs'
import { treeListing } from './support/obsidian-edits/apply-world.mjs'
import { REPOSITORIES, STORE_DIRECTORY, WORKSPACE_ID, makeProposalWorld, sourceState } from './support/obsidian-proposals/world.mjs'

// Structural edits made in a vault, routed as copy-only proposals.
//
// Every repository, ledger, store and vault below is invented and lives in a
// temporary directory the test made. The proposal store and its ledger are the
// real ones (src/collaboration), never a stand-in: what is asserted about one
// logical proposal is asserted over what that store persisted and reads back.

const isGitIgnored = SOURCE_APPLY_PRIMITIVES.isGitIgnored
const tempDir = (t, label) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), `atelier-proposals-${label}-`)))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
  return dir
}
// Every string anywhere in a parsed document. A path is looked for in these, never in JSON text, where a separator is escaped.
const stringsOf = (value) => (typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(stringsOf) : value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...stringsOf(item)]) : [])
const proposedOperation = (options) => makeOperation({ workspaceId: WORKSPACE_ID, state: 'proposed', kind: 'semantic-proposal', refusalCode: 'unsupported-structural-edit', ...options })

// ---------------------------------------------------------------------------
// Phase 1: repository routing and operation identity
// ---------------------------------------------------------------------------

test('routing: a structural edit goes to the one existing proposal store of the enrolled repository that owns its source, and two repositories with the same relative path and the same local node id stay separate', async (t) => {
  const world = makeProposalWorld(t)
  const project = world.loadProject()
  const before = { project: treeListing(world.projectDir), data: treeListing(world.dataRoot) }
  // The same local node id and the same relative path, in two repositories.
  const routeOf = (repoId, resolve = resolveProposalRoute) => resolve({ project, workspaceId: WORKSPACE_ID, identity: { workspaceId: WORKSPACE_ID, repoId, nodeId: 'guide' }, sourcePath: 'notes/guide.md', managedRoots: [world.workspaceRoot()], isVisible: () => true, isGitIgnored, env: world.env })
  const [east, west] = REPOSITORIES.map((name) => routeOf(name))
  assert.deepEqual([east.ok, west.ok], [true, true])
  assert.deepEqual(before, { project: treeListing(world.projectDir), data: treeListing(world.dataRoot) }, 'resolving a route writes nothing: no store is made by asking where it is')
  for (const [name, resolved] of [['east-wing', east], ['west-wing', west]]) {
    assert.equal(resolved.route.storeDirectory, path.join(world.repo(name), STORE_DIRECTORY))
    assert.equal(resolved.route.storeId, proposalStoreId({ workspaceId: WORKSPACE_ID, repoId: name }))
    assert.deepEqual([resolved.route.sourcePath, resolved.route.nodeId, resolved.route.storeExists], ['notes/guide.md', 'guide', false])
    // The store that already exists for a root is the one the route names: the default of the real store.
    assert.equal(createProposalStore({ workspaceRoot: world.repo(name), workspaceId: WORKSPACE_ID }).proposalsDir, resolved.route.storeDirectory)
  }
  assert.notEqual(east.route.storeDirectory, west.route.storeDirectory)
  assert.notEqual(east.route.storeId, west.route.storeId)
  assert.equal(routeOf('east-wing').route.storeExists, true, 'a store that is there is found, not made again')

  const key = proposedOperation({ repoId: 'east-wing', nodeId: 'guide', edited: 'a new link' }).idempotencyKey
  const ids = REPOSITORIES.map((repoId) => adapterOperationId({ workspaceId: WORKSPACE_ID, repoId, nodeId: 'guide', idempotencyKey: key }))
  assert.notEqual(ids[0], ids[1], 'the repository is part of the operation identity even when every other part is equal')
  assert.ok(ids.every(isAdapterOperationId))

  // Mutation control: a router that keys by the local node id alone sends both to one store and gives both one name.
  const broken = createProposalRouterForOracleTests({ ...PROPOSAL_ROUTER_PRIMITIVES, identityParts: ({ nodeId, idempotencyKey }) => [nodeId, idempotencyKey], repositoryOf: ({ project: loaded }) => [loaded.repos[0]] })
  assert.equal(routeOf('east-wing', broken.resolveProposalRoute).route.storeDirectory, routeOf('west-wing', broken.resolveProposalRoute).route.storeDirectory, 'the control merges the two repositories, which the assertions above would refuse')
  assert.equal(broken.adapterOperationId({ workspaceId: WORKSPACE_ID, repoId: 'east-wing', nodeId: 'guide', idempotencyKey: key }), broken.adapterOperationId({ workspaceId: WORKSPACE_ID, repoId: 'west-wing', nodeId: 'guide', idempotencyKey: key }))
})

test('routing refusals: a malformed, foreign, unenrolled, external, unreadable, withheld, unpreservable or unsafe route refuses with a typed code, writes nothing and loses nothing of the preserved edit', async (t) => {
  // Only the east repository ignores the store directory.
  const world = makeProposalWorld(t, { gitignore: { 'east-wing': `${STORE_DIRECTORY}/\n` } })
  world.addLink('east-wing:guide', 'east-wing:second')
  const [applied] = await world.observe()
  assert.deepEqual([applied.status, applied.code, applied.detail.cause], ['refused', 'edit-not-applicable', 'unsupported-structural-edit'])
  const edit = world.editOf('east-wing:guide')
  const preserved = path.join(world.workspaceRoot(), edit.objectRef)
  const objects = () => openObjectStore({ stateRoot: world.workspaceRoot(), workspaceId: WORKSPACE_ID, repositoryRoots: protectedRoots(world.loadProject()), clock: world.clock })
  const recorded = () => objects().stateOf({ repoId: 'east-wing', nodeId: 'east-wing:guide' }).operations.map(({ kind, state, idempotencyKey }) => [kind, state, idempotencyKey])
  assert.deepEqual(recorded().map(([kind, state]) => [kind, state]), [['semantic-proposal', 'proposed']])

  const project = world.loadProject()
  const identity = { workspaceId: WORKSPACE_ID, repoId: 'east-wing', nodeId: 'east-wing:guide' }
  const base = { project, workspaceId: WORKSPACE_ID, identity, sourcePath: 'notes/guide.md', managedRoots: [world.workspaceRoot()], isVisible: () => true, isGitIgnored, env: world.env }
  const withRepo = (change) => ({ ...project, repos: project.repos.map((repo) => (repo.name === 'east-wing' ? { ...repo, ...change } : repo)) })
  const cases = [
    ['malformed repository', { identity: { ...identity, repoId: 'not an identifier' } }, 'invalid-operation'],
    ['malformed node', { identity: { ...identity, nodeId: '' } }, 'invalid-operation'],
    ['no identity', { identity: null }, 'invalid-operation'],
    ['foreign workspace', { identity: { ...identity, workspaceId: 'ws-somebody-else' } }, 'foreign-workspace'],
    ['unenrolled', { identity: { ...identity, repoId: 'north-wing' } }, 'repository-not-enrolled'],
    ['enrolled twice', { project: { ...project, repos: [...project.repos, project.repos[0]] } }, 'repository-not-enrolled'],
    ['external', { project: withRepo({ external: true }) }, 'repository-external'],
    ['external without a root', { project: withRepo({ path: undefined }) }, 'repository-external'],
    ['root gone', { project: withRepo({ path: path.join(world.dir, 'no-such-repository') }) }, 'repository-root-unreadable'],
    ['path escapes', { sourcePath: '../west-wing/notes/guide.md' }, 'source-path-invalid'],
    ['path absolute', { sourcePath: path.join(world.repo('east-wing'), 'notes', 'guide.md') }, 'source-path-invalid'],
    ['path with a backslash', { sourcePath: 'notes\\guide.md' }, 'source-path-invalid'],
    ['path unknown', { sourcePath: null }, 'source-path-invalid'],
    ['path the store would trim', { sourcePath: 'notes/guide.md ' }, 'source-path-not-preservable'],
    ['path the store would cut', { sourcePath: `notes/${'n'.repeat(MAX_ROUTED_SOURCE_PATH)}.md` }, 'source-path-not-preservable'],
    ['withheld', { isVisible: () => false }, 'route-withheld'],
    ['visibility unknown', { isVisible: () => null }, 'route-visibility-unknown'],
    ['store inside private state', { managedRoots: [world.repo('east-wing')] }, 'proposal-store-inside-managed-root'],
    ['store would show in git', { identity: { ...identity, repoId: 'west-wing', nodeId: 'west-wing:guide' } }, 'proposal-store-not-ignored'],
    ['git cannot say', { isGitIgnored: () => null }, 'proposal-store-ignore-unknown'],
  ]
  const before = { source: sourceState(world), data: treeListing(world.dataRoot), project: treeListing(world.projectDir), operations: recorded(), bytes: digestOf(fs.readFileSync(preserved)) }
  for (const [name, change, code] of cases) {
    const resolved = resolveProposalRoute({ ...base, ...change })
    assert.deepEqual([resolved.ok, resolved.code], [false, code], name)
    assert.ok(PROPOSAL_ROUTE_REFUSALS.includes(resolved.code), `${name}: ${resolved.code} is a declared code`)
    assert.equal(resolved.transient, code === 'route-visibility-unknown', name)
  }
  // Something that is not a directory where the store would be.
  const unsafe = path.join(world.repo('east-wing'), STORE_DIRECTORY)
  fs.writeFileSync(unsafe, 'not a directory')
  assert.equal(resolveProposalRoute(base).code, 'proposal-store-unsafe')
  fs.rmSync(unsafe)
  if (process.platform !== 'win32') {
    const elsewhere = path.join(world.dir, 'elsewhere')
    fs.mkdirSync(elsewhere)
    fs.symlinkSync(elsewhere, unsafe)
    assert.equal(resolveProposalRoute(base).code, 'proposal-store-unsafe', 'a store directory that is a link leads out of the repository')
    fs.rmSync(unsafe)
  }
  assert.deepEqual({ source: sourceState(world), data: treeListing(world.dataRoot), project: treeListing(world.projectDir), operations: recorded(), bytes: digestOf(fs.readFileSync(preserved)) }, before,
    'no refusal wrote anything: the project, the private state, the record of the object and the preserved bytes are as they were')
  assert.ok(world.pendingEdits().some((item) => item.editId === edit.editId && item.closedAt === null), 'the pending edit stays')
  assert.equal(resolveProposalRoute(base).ok, true, 'and the same edit routes once nothing is wrong')
})

test('identity: the adapter operation identity survives the payload normalisation of the real proposal store byte for byte, with no truncation, no case folding and no collision between near-equal or maximum-length identities', async (t) => {
  const root = tempDir(t, 'identity')
  const longest = (seed) => `${seed}${'x'.repeat(128 - seed.length)}`
  const key = (label) => `op-${createHash('sha256').update(label).digest('hex')}`
  const inputs = [
    { workspaceId: 'ws-a', repoId: 'room', nodeId: 'room:guide', idempotencyKey: key('one') },
    { workspaceId: 'ws-a', repoId: 'room', nodeId: 'room:guide', idempotencyKey: key('two') },
    // A character moved from one part to the next.
    { workspaceId: 'ws-a', repoId: 'room:guide', nodeId: 'room', idempotencyKey: key('one') },
    { workspaceId: 'ws-a', repoId: 'roo', nodeId: 'mroom:guide', idempotencyKey: key('one') },
    { workspaceId: 'ws-aroom', repoId: 'room', nodeId: 'guide', idempotencyKey: key('one') },
    // Case, and the characters a file system or a normaliser might fold.
    { workspaceId: 'ws-a', repoId: 'Room', nodeId: 'room:guide', idempotencyKey: key('one') },
    { workspaceId: 'ws-a', repoId: 'ROOM', nodeId: 'room:guide', idempotencyKey: key('one') },
    { workspaceId: 'ws-a', repoId: 'room', nodeId: 'room:Guide', idempotencyKey: key('one') },
    { workspaceId: 'ws-a', repoId: 'room.', nodeId: 'room:guide', idempotencyKey: key('one') },
    { workspaceId: 'ws-a', repoId: 'room-', nodeId: 'room:guide', idempotencyKey: key('one') },
    { workspaceId: 'ws-a', repoId: 'room_', nodeId: 'room:guide', idempotencyKey: key('one') },
    { workspaceId: 'ws-a', repoId: 'room', nodeId: 'room:guide', idempotencyKey: key('one').toUpperCase() },
    // Maximum length in every part, equal but for the last character.
    { workspaceId: longest('ws-'), repoId: longest('r'), nodeId: longest('n'), idempotencyKey: longest('k') },
    { workspaceId: longest('ws-'), repoId: longest('r'), nodeId: longest('n'), idempotencyKey: `${longest('k').slice(0, 127)}y` },
    { workspaceId: longest('ws-'), repoId: longest('r'), nodeId: `${longest('n').slice(0, 127)}y`, idempotencyKey: longest('k') },
    { workspaceId: longest('ws-'), repoId: `${longest('r').slice(0, 127)}y`, nodeId: longest('n'), idempotencyKey: longest('k') },
    { workspaceId: `${longest('ws-').slice(0, 127)}y`, repoId: longest('r'), nodeId: longest('n'), idempotencyKey: longest('k') },
  ]
  const ids = inputs.map((input) => adapterOperationId(input))
  assert.equal(new Set(ids).size, inputs.length, 'every identity has its own name')
  assert.equal(new Set(ids.map((id) => id.toLowerCase())).size, inputs.length, 'and still has after case folding, since a name is lower case only')
  for (const id of ids) assert.match(id, /^pa-[0-9a-f]{64}$/)
  assert.deepEqual(ids, inputs.map((input) => adapterOperationId({ ...input })), 'the name is a function of the identity and of nothing else')
  for (const broken of [{ ...inputs[0], repoId: 'not an identifier' }, { ...inputs[0], idempotencyKey: 'short' }, { ...inputs[0], nodeId: undefined }]) assert.throws(() => adapterOperationId(broken), TypeError)

  // Against the real store: each name goes in inside the payload, the store normalises what it normalises, and a
  // store opened afresh reads every name back exactly. A path of the longest length the router lets through goes
  // with it and comes back whole.
  const longPath = `notes/${'p'.repeat(MAX_ROUTED_SOURCE_PATH - 'notes/.md'.length)}.md`
  assert.equal(longPath.length, MAX_ROUTED_SOURCE_PATH)
  const store = createProposalStore({ workspaceRoot: root, workspaceId: 'ws-a' })
  for (const [index, id] of ids.entries()) {
    const created = store.createProposal({ path: longPath, action: 'copy.agentPrompt', actor: 'synthetic adapter', intent: 'x'.repeat(900), proposal: { adapter: { id: 'synthetic', operationId: id }, index } })
    assert.equal(created.ok, true, created.error)
  }
  const readBack = createProposalStore({ workspaceRoot: root, workspaceId: 'ws-a' }).listProposals()
  assert.equal(readBack.ok, true)
  const byIndex = [...readBack.proposals].sort((left, right) => left.payload.index - right.payload.index)
  assert.deepEqual(byIndex.map((record) => record.payload.adapter.operationId), ids, 'byte for byte, in the ledger')
  assert.ok(byIndex.every((record) => record.proposal.path === longPath && record.proposal.intent.length === 500), 'the path is whole; the intent was cut by the store, which is why no identity is kept there')
  for (const record of byIndex) assert.equal(JSON.parse(fs.readFileSync(store.proposalPath(record.proposal.id), 'utf8')).payload.adapter.operationId, record.payload.adapter.operationId, 'and in the snapshot beside it')
  assert.equal(new Set(byIndex.map((record) => record.proposal.id)).size, ids.length)

  // Mutation control: an identity that is the parts themselves, carried in a member the store normalises, is cut at
  // 120 characters, and the maximum-length identities above become one.
  const control = createProposalStore({ workspaceRoot: tempDir(t, 'identity-control'), workspaceId: 'ws-a' })
  const spelled = inputs.map((input) => [input.workspaceId, input.repoId, input.nodeId, input.idempotencyKey].join('/'))
  assert.equal(new Set(spelled).size, inputs.length)
  const carried = spelled.map((value) => control.createProposal({ path: 'notes/guide.md', sessionId: value }).record.proposal.sessionId)
  assert.ok(new Set(carried).size < inputs.length, 'the control loses identities to truncation, which the oracle above would refuse')
})

test('identity: the adapter operation record is written to private state before anything else, owner-only, immutable, chained and bounded, and a full queue refuses without recording or dropping anything', async (t) => {
  const stateRoot = tempDir(t, 'queue')
  const repository = tempDir(t, 'queue-repository')
  let nowMs = Date.parse('2026-01-05T10:00:00.000Z')
  const clock = () => new Date(nowMs += 1000)
  const open = (options = {}) => openProposalQueue({ stateRoot, workspaceId: WORKSPACE_ID, repositoryRoots: [repository], clock, ...options })
  const fieldsOf = (operation, extra = {}) => ({ nodeId: operation.nodeId, editId: operation.editId, idempotencyKey: operation.idempotencyKey, scopeId: operation.origin.scopeId, generationId: operation.origin.generationId, storeId: proposalStoreId(operation), sourcePath: 'notes/guide.md', state: 'queued', ...extra })
  const operation = proposedOperation({ repoId: 'east-wing', nodeId: 'east-wing:guide', edited: 'a new link' })
  const id = adapterOperationId(operation)
  const queue = open()
  assert.deepEqual(treeListing(stateRoot), {}, 'opening the queue makes nothing')
  assert.equal(queue.read('east-wing', id), null)

  const first = queue.append('east-wing', id, fieldsOf(operation))
  assert.deepEqual([first.sequence, first.previous, first.state, first.attempts, first.proposalId, first.receipt], [1, null, 'queued', 0, null, null])
  assert.equal(isProposalOperationRecord(first), true)
  const directory = path.join(stateRoot, 'state', 'proposals', 'k-east-wing', 'operations')
  const file = path.join(directory, `${id}--000001.json`)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), first)
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'a record is owner-only')
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700)
  }
  assert.ok(stringsOf(first).every((value) => !path.isAbsolute(value) && !value.includes(path.basename(stateRoot))), 'a record names no path of this machine')

  const waiting = queue.append('east-wing', id, { state: 'backpressure', code: 'ledger-full', attempts: 1, lastAttemptAt: '2026-01-05T10:00:05.000Z', nextAttemptAt: '2026-01-05T10:01:05.000Z' })
  assert.deepEqual([waiting.sequence, waiting.state, waiting.code, waiting.sourcePath, typeof waiting.previous], [2, 'backpressure', 'ledger-full', 'notes/guide.md', 'string'])
  assert.deepEqual(open().read('east-wing', id).records.map((record) => record.state), ['queued', 'backpressure'], 'another process reads the same history')
  assert.deepEqual(open().heads().operations.map((record) => [record.adapterOperationId, record.state]), [[id, 'backpressure']])

  const refuses = (operate, code) => assert.throws(operate, (error) => error instanceof ProposalQueueRefusal && error.code === code, code)
  // No step backwards, no identity that changes, no record that is not one.
  refuses(() => queue.append('east-wing', id, { state: 'acknowledged' }), 'invalid-queue-record')
  refuses(() => queue.append('east-wing', id, { state: 'queued', editId: `edit-${'0'.repeat(32)}` }), 'invalid-queue-transition')
  refuses(() => queue.append('east-wing', id, { state: 'submitted', proposalId: 'proposal-abc', dedupe: 'new', surprise: true }), 'invalid-queue-record')
  refuses(() => queue.append('west-wing', id, fieldsOf(operation)), 'invalid-queue-record')
  // Immutable: the next name taken by other bytes is another writer, and is never written over.
  const taken = path.join(directory, `${id}--000003.json`)
  fs.writeFileSync(taken, '{"somebody":"else"}\n')
  refuses(() => open().append('east-wing', id, { state: 'queued', code: null, nextAttemptAt: null }), 'queue-record-malformed')
  assert.equal(fs.readFileSync(taken, 'utf8'), '{"somebody":"else"}\n')
  fs.rmSync(taken)
  // A record changed after it was written, a missing one, and a file nobody can account for.
  const original = fs.readFileSync(file)
  fs.writeFileSync(file, original.toString('utf8').replace('notes/guide.md', 'notes/other.md'))
  refuses(() => open().read('east-wing', id), 'queue-chain-broken')
  fs.writeFileSync(file, original.toString('utf8').replace('"queued"', '"QUEUED"'))
  refuses(() => open().read('east-wing', id), 'queue-record-malformed')
  fs.rmSync(file)
  refuses(() => open().read('east-wing', id), 'queue-record-gap')
  fs.writeFileSync(file, original)
  assert.equal(open().read('east-wing', id).head.state, 'backpressure')
  fs.writeFileSync(path.join(directory, 'notes.txt'), 'left here by somebody')
  refuses(() => open().read('east-wing', id), 'queue-foreign-file')
  assert.deepEqual(open().heads().unreadable.map((item) => item.code), ['queue-foreign-file'], 'listed as unreadable, and the operations beside it are still listed')
  fs.rmSync(path.join(directory, 'notes.txt'))

  // Bounds. Three operations, two of them open: the third open one and the fourth of any kind refuse, and write nothing.
  const bounded = open({ limits: { ...PROPOSAL_QUEUE_LIMITS, maxOperationsPerRepository: 3, maxOpenPerRepository: 2 } })
  const others = ['second', 'third', 'fourth'].map((label) => proposedOperation({ repoId: 'east-wing', nodeId: `east-wing:${label}`, edited: `edit of ${label}` }))
  bounded.append('east-wing', adapterOperationId(others[0]), fieldsOf(others[0]))
  const listing = treeListing(stateRoot)
  refuses(() => bounded.append('east-wing', adapterOperationId(others[1]), fieldsOf(others[1])), 'queue-full')
  assert.deepEqual(treeListing(stateRoot), listing, 'a full queue records nothing, and removes nothing to make room')
  assert.equal(bounded.append('west-wing', adapterOperationId({ ...others[1], repoId: 'west-wing' }), fieldsOf({ ...others[1], repoId: 'west-wing' })).state, 'queued', 'the queue of another repository has its own room')
  assert.deepEqual(PROPOSAL_QUEUE_LIMITS, { maxOperationsPerRepository: 4096, maxOpenPerRepository: 256, maxRecordsPerOperation: 64, maxRecordBytes: 16 * 1024 })
  // The adapter state may not be kept inside an enrolled repository.
  refuses(() => openProposalQueue({ stateRoot: path.join(repository, 'state'), workspaceId: WORKSPACE_ID, repositoryRoots: [repository], clock }), 'state-root-overlaps-repository')
})

// ---------------------------------------------------------------------------
// Phase 2: one logical proposal across append and acknowledgement
// ---------------------------------------------------------------------------

import childProcess from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assertObsidianContract } from '../src/projection/obsidian/contracts.mjs'
import {
  PROPOSAL_ADAPTER_CRASH_STEPS, PROPOSAL_ADAPTER_ID, PROPOSAL_ADAPTER_PRIMITIVES, PROPOSAL_PAYLOAD_KIND, PROPOSAL_PAYLOAD_SCHEMA, createProposalAdapter, createProposalAdapterForOracleTests,
} from '../src/projection/obsidian/proposals/index.mjs'
import { PRIVATE_TITLE, WEST_TITLE, crashAt, holderIsGoneProof } from './support/obsidian-proposals/world.mjs'

const RACE_CHILD = fileURLToPath(new URL('./support/obsidian-proposals/race-child.mjs', import.meta.url))
const adapterFor = (world, options = {}, primitives = PROPOSAL_ADAPTER_PRIMITIVES) => createProposalAdapterForOracleTests(primitives)({ clock: world.clock, env: world.env, ...options })
// Everything the adapter may write outside private state: the stores of both repositories, file by file.
const storeState = (world) => Object.fromEntries(REPOSITORIES.map((name) => [name, fs.existsSync(world.storeDir(name)) ? treeListing(world.storeDir(name)) : null]))
const queueState = (world) => (fs.existsSync(world.queueDir()) ? treeListing(world.queueDir()) : null)
const operationIdsIn = (world, name) => world.adapterProposals(name).map((record) => record.payload.adapter.operationId).sort()
// A store opened through this one counts what is asked of it.
function countingStore(counts) {
  return (options) => {
    const store = createProposalStore(options)
    counts.opened += 1
    const counted = (object, name, key) => (...args) => { counts[key] += 1; return object[name](...args) }
    return { ...store, listProposals: counted(store, 'listProposals', 'reads'), readProposal: counted(store, 'readProposal', 'reads'), createProposal: counted(store, 'createProposal', 'writes'), eventLedger: { ...store.eventLedger, readAll: counted(store.eventLedger, 'readAll', 'reads') } }
  }
}

test('dedupe: a structural edit observed through the real path becomes exactly one copy-only proposal with a receipt in the store of its repository, and unchanged ticks append zero ledger events and write nothing at all', async (t) => {
  const world = makeProposalWorld(t)
  world.addLink('east-wing:guide', 'east-wing:second')
  world.editFrontMatter('west-wing:guide', WEST_TITLE, 'Tide tables')
  world.editNote('east-wing:plain', 'Only the body', 'Nothing but the body')
  await world.observe()
  // Whatever became of the body edit (applied where an atomic exchange exists, refused where none does), it is not a proposal.
  const before = sourceState(world)
  const counts = { opened: 0, reads: 0, writes: 0 }
  const adapter = adapterFor(world, { openStore: countingStore(counts) })
  const report = await adapter.propose(world.context())
  assert.deepEqual(report.outcomes.map((item) => [item.repoId, item.status, item.dedupe, item.state]), [['east-wing', 'acknowledged', 'new', 'acknowledged'], ['west-wing', 'acknowledged', 'new', 'acknowledged']])
  assert.deepEqual(report.repositories, [])
  assert.deepEqual(counts.writes, 2, 'one creation per operation')

  for (const [name, nodeId, code, reason] of [['east-wing', 'east-wing:guide', 'unsupported-structural-edit', 'vault-link-changed'], ['west-wing', 'west-wing:guide', 'unsupported-frontmatter-edit', null]]) {
    const proposals = world.adapterProposals(name)
    assert.equal(proposals.length, 1, `${name}: one proposal`)
    const [record] = proposals
    const edit = world.editOf(nodeId)
    const outcome = report.outcomes.find((item) => item.repoId === name)
    assert.deepEqual([record.proposal.status, record.proposal.path, record.proposal.action, record.proposal.viewId, record.diff], ['proposed', 'notes/guide.md', 'copy.agentPrompt', 'scope-whole', ''])
    assert.deepEqual(record.proposal.authority, { action: 'copy.agentPrompt', capability: 'proposal.copy-only', copyOnly: true, directWrite: false, applyEndpoint: null })
    const { payload } = record
    assert.deepEqual([payload.schema, payload.kind, payload.adapter.id, payload.adapter.operationId], [PROPOSAL_PAYLOAD_SCHEMA, PROPOSAL_PAYLOAD_KIND, PROPOSAL_ADAPTER_ID, outcome.adapterOperationId])
    assert.deepEqual(payload.identity, { workspaceId: WORKSPACE_ID, repoId: name, nodeId })
    assert.deepEqual([payload.sourcePath, payload.editId, payload.change.code, payload.change.reason], ['notes/guide.md', edit.editId, code, reason])
    assert.deepEqual(payload.references.observed, { digest: edit.observedDigest, byteLength: fs.statSync(path.join(world.workspaceRoot(), edit.objectRef)).size, recoveryRef: edit.objectRef })
    assert.equal(payload.references.baseSourceDigest, `sha256:${createHash('sha256').update(fs.readFileSync(world.source(`${name}/notes/guide.md`))).digest('hex')}`, 'the base is the source as it is: nothing was written to it')
    if (code === 'unsupported-structural-edit') {
      assert.equal(payload.change.occurrenceCount, 1)
      const [{ noteStart, noteEnd }] = payload.change.occurrences
      assert.equal(fs.readFileSync(world.noteFile(nodeId)).subarray(noteStart, noteEnd).toString('utf8'), `[[${world.wikiOf('east-wing:second')}]]`, 'the offsets are where the link is in the edited note')
    } else assert.ok(Number.isInteger(payload.change.firstDifference))

    // The receipt binds the edit operation to the proposal, and is persisted with the record that acknowledges it.
    assertObsidianContract('proposal-receipt', outcome.receipt)
    assert.deepEqual([outcome.receipt.repoId, outcome.receipt.editId, outcome.receipt.proposalId, outcome.receipt.adapterOperationId, outcome.receipt.dedupe, outcome.receipt.backpressure], [name, edit.editId, record.proposal.id, outcome.adapterOperationId, 'new', 'accepted'])
    const persisted = adapter.show(world.context(), { adapterOperationId: outcome.adapterOperationId })
    assert.deepEqual(persisted.operation.receipt, outcome.receipt)
    assert.deepEqual([persisted.operation.state, persisted.operation.proposalId, persisted.review.status], ['acknowledged', record.proposal.id, 'proposed'])
  }
  assert.deepEqual(adapter.list(world.context()).map((item) => [item.repoId, item.state]), [['east-wing', 'acknowledged'], ['west-wing', 'acknowledged']])

  // The oracle over many ticks: the bytes of every ledger and of every file of both stores, the adapter queue, the
  // sources and what git says. The clock moves past every retry interval there is.
  async function manyTicks(ticking, ticks = 30) {
    const start = { stores: storeState(world), ledgers: REPOSITORIES.map((name) => digestOf(world.ledgerBytes(name))), queue: queueState(world), asked: { ...counts } }
    for (let tick = 0; tick < ticks; tick += 1) { world.advance(2 * 60 * 60 * 1000); await ticking.propose(world.context()) }
    return { start, end: { stores: storeState(world), ledgers: REPOSITORIES.map((name) => digestOf(world.ledgerBytes(name))), queue: queueState(world), asked: { ...counts } } }
  }
  const quiet = await manyTicks(adapter)
  assert.deepEqual(quiet.end, quiet.start, 'thirty unchanged ticks: zero ledger events, zero store writes, zero store reads, and no adapter record')
  const restarted = await manyTicks(adapterFor(world, { openStore: countingStore(counts) }))
  assert.deepEqual(restarted.end, restarted.start, 'and the same for an adapter that has just started and remembers nothing')
  assert.deepEqual(sourceState(world), before, 'no source byte and no git state changed, in either repository')

  // Mutation control: an adapter that hands every operation over again on every tick, and does not look first,
  // appends a proposal event per tick; the oracle above cannot pass for it.
  const chatty = await manyTicks(adapterFor(world, {}, { ...PROPOSAL_ADAPTER_PRIMITIVES, handOver: () => true, isSettled: () => false, lookBeforeCreate: false }), 3)
  assert.notDeepEqual(chatty.end.ledgers, chatty.start.ledgers)
  assert.equal(world.adapterProposals('east-wing').length, 4, 'one more per tick')
})

// What a restart finds after a crash at each step, and what it does. `proposals` is how many proposals carry the
// operation identity in the real store when the crashed process is gone; there is exactly one after the restart.
const CRASH_TABLE = Object.freeze([
  { step: 'queued', node: 'east-wing:guide', proposals: 0, queue: 'queued', dedupe: 'new' },
  { step: 'before-append', node: 'east-wing:second', proposals: 0, queue: 'queued', dedupe: 'new' },
  { step: 'appended', node: 'east-wing:third', proposals: 1, queue: 'queued', dedupe: 'recovered' },
  { step: 'submitted', node: 'west-wing:guide', proposals: 1, queue: 'submitted', dedupe: 'new' },
  { step: 'acknowledged', node: 'west-wing:second', proposals: 1, queue: 'acknowledged', dedupe: 'new' },
])

test('crash and replay: a crash before the append, after the append and before the acknowledgement, and after it, each leave exactly one logical proposal; the lock of a crashed holder is taken over only with proof, never because time passed', async (t) => {
  assert.deepEqual(CRASH_TABLE.map((row) => row.step), [...PROPOSAL_ADAPTER_CRASH_STEPS])
  const world = makeProposalWorld(t)
  for (const row of CRASH_TABLE) world.addLink(row.node, row.node.startsWith('east') ? 'east-wing:plain' : 'west-wing:guide' === row.node ? 'west-wing:second' : 'west-wing:guide')
  await world.observe()
  const before = sourceState(world)
  const table = []
  for (const row of CRASH_TABLE) {
    const [repoId] = row.node.split(':')
    const edit = world.editOf(row.node)
    const context = () => world.context({ edits: world.pendingEdits().filter((item) => item.editId === edit.editId) })
    const mine = () => world.adapterProposals(repoId).filter((record) => record.payload.editId === edit.editId)
    await assert.rejects(adapterFor(world, { crash: crashAt(row.step) }).propose(context()), /crashed at/, row.step)
    const [head] = adapterFor(world).list(context()).filter((item) => item.editId === edit.editId)
    assert.deepEqual([mine().length, head.state], [row.proposals, row.queue], `${row.step}: what the crash left`)

    // The crashed process released nothing. Its lock is this process, which is alive: without proof nothing is taken,
    // however long ago that was, and nothing is written.
    const held = { stores: storeState(world), queue: queueState(world) }
    world.advance(400 * 24 * 60 * 60 * 1000)
    const waiting = await adapterFor(world).propose(context())
    if (row.step === 'acknowledged') assert.deepEqual(waiting, { adapterId: PROPOSAL_ADAPTER_ID, examined: 0, outcomes: [], repositories: [] }, 'an acknowledged operation is not handed over at all')
    else assert.deepEqual([waiting.outcomes, waiting.repositories], [[], [{ repoId, code: 'adapter-lock-held', reason: 'held-by-this-process' }]], `${row.step}: no takeover on a timeout`)
    assert.deepEqual({ stores: storeState(world), queue: queueState(world) }, held)

    // The restart, with the proof that the holder is gone.
    const restarted = adapterFor(world, { proveAbandoned: holderIsGoneProof() })
    const replay = await restarted.propose(context())
    if (row.step === 'acknowledged') assert.deepEqual(replay.outcomes, [])
    else assert.deepEqual(replay.outcomes.map((item) => [item.status, item.dedupe]), [['acknowledged', row.dedupe]], row.step)
    assert.equal(mine().length, 1, `${row.step}: exactly one logical proposal`)
    const shown = restarted.show(context(), { adapterOperationId: head.adapterOperationId })
    assert.deepEqual([shown.operation.state, shown.operation.proposalId, shown.operation.receipt.dedupe, shown.operation.receipt.backpressure], ['acknowledged', mine()[0].proposal.id, row.dedupe, 'accepted'], row.step)
    // Offered again, by the tick and directly: answered from the record, nothing created.
    const settled = { stores: storeState(world), queue: queueState(world) }
    assert.deepEqual((await restarted.propose(context())).outcomes, [])
    assert.deepEqual({ stores: storeState(world), queue: queueState(world) }, settled)
    table.push({ step: row.step, proposalsAfterCrash: row.proposals, queueAfterCrash: row.queue, proposalsAfterReplay: mine().length, dedupe: shown.operation.receipt.dedupe })
  }
  assert.deepEqual(REPOSITORIES.map((name) => world.adapterProposals(name).length), [3, 2])
  assert.deepEqual(sourceState(world), before)
  t.diagnostic(`crash table: ${JSON.stringify(table)}`)
})

test('mutation controls for dedupe: an adapter that retries without looking, and one that takes the proposal identifier or its timestamp for the dedupe authority, both create a second proposal after a lost acknowledgement', async (t) => {
  const world = makeProposalWorld(t)
  for (const node of ['east-wing:guide', 'east-wing:second', 'east-wing:third']) world.addLink(node, 'east-wing:plain')
  await world.observe()
  const run = async (node, primitives) => {
    const edit = world.editOf(node)
    const context = () => world.context({ edits: world.pendingEdits().filter((item) => item.editId === edit.editId) })
    await assert.rejects(adapterFor(world, { crash: crashAt('appended') }).propose(context()), /crashed at/)
    await adapterFor(world, { proveAbandoned: holderIsGoneProof() }, primitives).propose(context())
    return world.adapterProposals('east-wing').filter((record) => record.payload.editId === edit.editId).length
  }
  assert.equal(await run('east-wing:guide', PROPOSAL_ADAPTER_PRIMITIVES), 1, 'production: one')
  assert.equal(await run('east-wing:second', { ...PROPOSAL_ADAPTER_PRIMITIVES, lookBeforeCreate: false }), 2, 'retrying without looking: two')
  // The identifier a store would give the same body now is not the one it gave then: it is seeded with the time.
  const byTimestamp = ({ proposals, item }) => proposals.filter((record) => record.proposal.id === `proposal-${createHash('sha256').update([new Date().toISOString(), item.editId].join('\u0000')).digest('hex').slice(0, 32)}`)
  assert.equal(await run('east-wing:third', { ...PROPOSAL_ADAPTER_PRIMITIVES, existingFor: byTimestamp }), 2, 'looking for a proposal identifier: two')
})

// Two real processes. Children are tracked by handle and their exit is awaited; a survivor is named by the test.
const liveChildren = new Set()
test.after(() => { for (const child of liveChildren) { child.kill('SIGKILL'); process.stderr.write(`obsidian-proposals: killed a surviving race-child ${child.pid}\n`) } })
function runRaceChild(input) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, [RACE_CHILD, JSON.stringify(input)], { stdio: ['ignore', 'pipe', 'pipe'] })
    liveChildren.add(child)
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      liveChildren.delete(child)
      if (code !== 0) reject(new Error(`race-child ${input.role} exited ${code ?? signal}: ${err.slice(0, 2000)}`))
      else resolve(JSON.parse(out))
    })
  })
}
async function race(t, { unlocked }) {
  const world = makeProposalWorld(t)
  const nodes = ['east-wing:guide', 'east-wing:second', 'east-wing:third', 'west-wing:guide', 'west-wing:second']
  for (const node of nodes) world.addLink(node, node.startsWith('east') ? 'east-wing:plain' : node === 'west-wing:guide' ? 'west-wing:second' : 'west-wing:guide')
  await world.observe()
  const before = sourceState(world)
  const startAt = Date.now() + 2500
  const input = { configPath: world.configPath, projectDir: world.projectDir, workspaceRoot: world.workspaceRoot(), workspaceId: WORKSPACE_ID, startAt, passes: 40, spinMs: unlocked ? 400 : 150, unlocked, fixedNow: '2026-01-05T10:00:00.000Z' }
  const reports = await Promise.all(['left', 'right'].map((role) => runRaceChild({ ...input, role })))
  assert.equal(liveChildren.size, 0, 'both children have exited')
  const perOperation = REPOSITORIES.flatMap((name) => Object.values(Object.groupBy(world.adapterProposals(name), (record) => record.payload.adapter.operationId)).map((records) => records.length))
  const tally = Object.fromEntries(reports.map((report) => [report.role, {
    created: report.seen.flatMap((pass) => pass.outcomes).filter((item) => item.status === 'acknowledged' && item.dedupe === 'new').length,
    lockHeld: report.seen.flatMap((pass) => pass.repositories).filter((item) => item.code === 'adapter-lock-held').length,
    failed: report.seen.flatMap((pass) => pass.outcomes).filter((item) => item.status === 'failed').map((item) => item.code),
  }]))
  return { world, before, perOperation, tally, nodes }
}

// Two processes that start at one instant usually meet, and now and then one is done before the other has loaded.
// A race in which they did not meet proves nothing either way, so it is run again, a bounded number of times.
async function raceUntil(t, options, met) {
  let last
  for (let attempt = 0; attempt < 4; attempt += 1) { last = await race(t, options); if (met(last)) break }
  return last
}

test('dedupe between two real processes: both offer the same structural edits to the same stores at the same instant, and every operation has exactly one proposal', async (t) => {
  const { world, before, perOperation, tally, nodes } = await raceUntil(t, { unlocked: false }, (result) => result.tally.left.lockHeld + result.tally.right.lockHeld > 0)
  assert.deepEqual(perOperation, nodes.map(() => 1), 'one proposal per operation, in the persisted stores')
  assert.equal(tally.left.created + tally.right.created, nodes.length, 'every proposal was created by exactly one of the two')
  assert.deepEqual([tally.left.failed, tally.right.failed], [[], []])
  assert.ok(tally.left.lockHeld + tally.right.lockHeld > 0, 'the two met: at least once one of them found the lock of a repository held')
  assert.deepEqual(adapterFor(world).list(world.context()).map((item) => item.state), nodes.map(() => 'acknowledged'))
  assert.deepEqual(sourceState(world), before)
  t.diagnostic(`two processes: ${JSON.stringify(tally)}`)
})

test('mutation control for the two-process dedupe: without the lock the same two processes both look, both find nothing and both create', async (t) => {
  const { perOperation, tally } = await raceUntil(t, { unlocked: true }, (result) => result.perOperation.some((count) => count > 1))
  assert.ok(perOperation.some((count) => count > 1), `without the lock an operation has two proposals: ${JSON.stringify(perOperation)}`)
  t.diagnostic(`two processes, no lock: ${JSON.stringify({ perOperation, tally })}`)
})

test('replay of an accepted proposal: accepting a proposal the adapter created changes no source byte, grants nothing, and the adapter never reads acceptance as authority', async (t) => {
  const world = makeProposalWorld(t)
  world.addLink('east-wing:guide', 'east-wing:second')
  await world.observe()
  const before = sourceState(world)
  const adapter = adapterFor(world)
  const [outcome] = (await adapter.propose(world.context())).outcomes
  const store = world.store('east-wing')
  assert.equal(store.reviewProposal(outcome.proposalId, { status: 'reviewed', reviewer: 'synthetic reviewer' }).ok, true)
  const accepted = store.reviewProposal(outcome.proposalId, { status: 'accepted', reviewer: 'synthetic reviewer', notes: 'go ahead' })
  assert.deepEqual([accepted.ok, accepted.record.proposal.status, accepted.record.copyable.directWrite, accepted.record.copyable.applyEndpoint, accepted.record.copyable.targetPath], [true, 'accepted', false, null, 'notes/guide.md'])
  assert.deepEqual(sourceState(world), before, 'acceptance in the store applies nothing')

  const ledger = digestOf(world.ledgerBytes('east-wing'))
  for (let tick = 0; tick < 5; tick += 1) { world.advance(60 * 60 * 1000); assert.deepEqual((await adapter.propose(world.context())).outcomes, []) }
  const shown = adapter.show(world.context(), { adapterOperationId: outcome.adapterOperationId })
  assert.deepEqual([shown.review.status, shown.operation.state], ['accepted', 'acknowledged'], 'the acceptance is shown')
  const again = await adapter.offer(world.context(), { operation: { ...proposedOperation({ repoId: 'east-wing', nodeId: 'east-wing:guide', edited: 'unused' }) }, sourcePath: 'notes/guide.md' })
  assert.equal(again.status, 'acknowledged', 'another operation of the same document is another proposal, and still only that')
  assert.deepEqual(sourceState(world), before, 'and changes nothing: no source byte, no git state')
  assert.notEqual(digestOf(world.ledgerBytes('east-wing')), ledger)
  assert.equal(world.pendingEdits().find((item) => item.editId === outcome.editId).state, 'queued', 'the pending edit is still what it was: a proposal never closes or applies it')

  // Mutation control: an adapter that takes an accepted proposal for permission writes the source, and the oracle sees it.
  const obedient = adapterFor(world, {}, { ...PROPOSAL_ADAPTER_PRIMITIVES, onReviewStatus: ({ status, head, repositoryRoot }) => { if (status === 'accepted') fs.appendFileSync(path.join(repositoryRoot, head.sourcePath), '\nApplied because a reviewer accepted.\n') } })
  obedient.show(world.context(), { adapterOperationId: outcome.adapterOperationId })
  assert.notDeepEqual(sourceState(world), before)
})

test('dedupe and disclosure: a proposal, its ledger, the adapter records and every report hold no text of any note, no title of another identity, no vault file name and no path of this machine; a withheld object refuses and creates no store', async (t) => {
  const world = makeProposalWorld(t)
  // A link to a document of ANOTHER repository, and one to a document that is about to be withheld: the text a person
  // typed carries the titles of both.
  world.editNote('east-wing:guide', 'Closing words.', `Closing words, typed by hand: [[${world.wikiOf('west-wing:guide')}]] and [[${world.wikiOf('east-wing:ledger')}]].`)
  world.editNote('east-wing:ledger', 'Kept for the keeper only.', `Kept for the keeper only, see [[${world.wikiOf('east-wing:guide')}]].`)
  await world.observe()
  world.configureMachine({ audienceAllow: ['team'] })
  const before = sourceState(world)
  const adapter = adapterFor(world)
  const report = await adapter.propose(world.context())
  assert.deepEqual(report.outcomes.map((item) => [item.nodeId, item.status, item.code]).sort(), [['east-wing:guide', 'acknowledged', null], ['east-wing:ledger', 'refused', 'route-withheld']])
  const refused = report.outcomes.find((item) => item.status === 'refused')
  assertObsidianContract('proposal-receipt', refused.receipt)
  assert.deepEqual([refused.receipt.proposalId, refused.receipt.backpressure], [null, 'refused'])
  assert.equal(fs.existsSync(path.join(world.workspaceRoot(), world.editOf('east-wing:ledger').objectRef)), true, 'the preserved bytes of the refused edit stay')
  assert.equal(world.adapterProposals('east-wing').length, 1, 'nothing about the withheld document reached the store')
  assert.deepEqual((await adapter.propose(world.context())).outcomes, [], 'a refused operation is not handed over again')

  const forbidden = [WEST_TITLE, PRIVATE_TITLE, 'Lantern guide', 'typed by hand', 'Closing words', world.wikiOf('west-wing:guide'), world.wikiOf('east-wing:ledger'), world.wikiOf('east-wing:guide'), path.basename(world.dir)]
  const disclosed = (documents) => stringsOf(documents).filter((value) => path.isAbsolute(value) || value.includes('vaults/') || /--[0-9a-f]{8,}/.test(value) || forbidden.some((text) => value.includes(text)))
  const ledgerEvents = world.ledgerBytes('east-wing').toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const snapshots = fs.readdirSync(world.storeDir('east-wing')).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(fs.readFileSync(path.join(world.storeDir('east-wing'), name), 'utf8')))
  const queueRecords = Object.keys(treeListing(world.queueDir())).filter((name) => name.endsWith('.json') && name.includes('/operations/')).map((name) => JSON.parse(fs.readFileSync(path.join(world.queueDir(), name), 'utf8')))
  assert.ok(ledgerEvents.length === 1 && snapshots.length === 1 && queueRecords.length >= 3)
  const everything = [ledgerEvents, snapshots, queueRecords, report, adapter.status(world.context()), adapter.list(world.context()), world.adapterProposals('east-wing')]
  assert.deepEqual(disclosed(everything), [], 'nothing of any note, of another identity or of this machine')
  const [record] = world.adapterProposals('east-wing')
  assert.deepEqual(Object.keys(record.payload).sort(), ['adapter', 'change', 'editId', 'idempotencyKey', 'identity', 'kind', 'origin', 'references', 'schema', 'sourcePath', 'summary'])
  assert.equal(record.payload.change.occurrenceCount, 2, 'both links are counted, by offset only')
  assert.equal(fs.existsSync(world.storeDir('west-wing')), false, 'the repository the link points INTO got nothing: the request belongs to the document that was edited')
  assert.deepEqual(sourceState(world), before)

  // Mutation control: an adapter that quotes what the person typed puts the title of another identity into the store.
  const quoting = adapterFor(world, {}, { ...PROPOSAL_ADAPTER_PRIMITIVES, content: (input) => { const body = PROPOSAL_ADAPTER_PRIMITIVES.content(input); return { ...body, proposal: { ...body.proposal, excerpt: fs.readFileSync(path.join(world.workspaceRoot(), input.item.observed.recoveryRef), 'utf8') } } } })
  world.addLink('east-wing:second', 'west-wing:guide')
  await world.observe()
  await quoting.propose(world.context())
  assert.ok(disclosed(world.adapterProposals('east-wing')).length > 0, 'the control discloses, and the oracle sees it')
})

// ---------------------------------------------------------------------------
// Phase 3: ledger refusal and backpressure
// ---------------------------------------------------------------------------

import { COLLABORATION_LEDGER_LIMITS } from '../src/collaboration/event-ledger.mjs'
import { runObsidianCommand } from '../src/commands/obsidian.mjs'
import {
  BACKPRESSURE_CODES, PROPOSAL_BACKPRESSURE, PROPOSAL_LEDGER_LIMITS, STORE_REFUSAL_CODES, classifyLedgerRead, createProposalAdapterContribution, estimateEventLineBytes, nextAttemptAt, preflightAppend,
} from '../src/projection/obsidian/proposals/index.mjs'
import { createObsidianRegistry } from '../src/runtime/obsidian/extension-points.mjs'
import { writeLedger } from './support/obsidian-proposals/world.mjs'

const SHAPES = JSON.parse(fs.readFileSync(new URL('../fixtures/obsidian/proposals/expected-shapes.json', import.meta.url), 'utf8'))
const KIB = 1024
const MIB = 1024 * 1024
const onlyEdit = (world, nodeId) => world.context({ edits: world.pendingEdits().filter((item) => item.identity.nodeId === nodeId) })

test('ledger limits are the limits of the existing ledger, and the preflight says what an append would meet before anything is appended', async () => {
  assert.deepEqual(PROPOSAL_LEDGER_LIMITS, { maxLineBytes: COLLABORATION_LEDGER_LIMITS.maxLineBytes, maxBytes: COLLABORATION_LEDGER_LIMITS.maxBytes, maxEvents: COLLABORATION_LEDGER_LIMITS.maxEvents })
  assert.deepEqual(PROPOSAL_LEDGER_LIMITS, SHAPES.ledgerLimits, '256 KiB a line, 16 MiB, 10,000 events: not widened here')
  assert.deepEqual([{ events: PROPOSAL_BACKPRESSURE.reserveEvents, bytes: PROPOSAL_BACKPRESSURE.reserveBytes }, [...BACKPRESSURE_CODES], [...STORE_REFUSAL_CODES]], [SHAPES.reserve, SHAPES.backpressureCodes, SHAPES.storeRefusalCodes])
  const { reserveEvents: _events, reserveBytes: _bytes, ...bounds } = PROPOSAL_BACKPRESSURE
  assert.deepEqual(bounds, SHAPES.bounds)
  const readable = (events, bytes) => classifyLedgerRead({ ok: true, status: 200, stats: { eventCount: events, bytes } })
  assert.deepEqual(preflightAppend({ ledger: readable(0, 0), lineBytes: 256 * KIB }), { ok: true })
  assert.equal(preflightAppend({ ledger: readable(0, 0), lineBytes: 256 * KIB + 1 }).code, 'proposal-too-large')
  assert.deepEqual(preflightAppend({ ledger: readable(10_000 - 33, 0), lineBytes: 3000 }), { ok: true })
  assert.equal(preflightAppend({ ledger: readable(10_000 - 32, 0), lineBytes: 3000 }).code, 'ledger-full')
  assert.deepEqual(preflightAppend({ ledger: readable(1, 16 * MIB - 512 * KIB - 3000), lineBytes: 3000 }), { ok: true })
  assert.equal(preflightAppend({ ledger: readable(1, 16 * MIB - 512 * KIB - 2999), lineBytes: 3000 }).code, 'ledger-full')
  assert.deepEqual([classifyLedgerRead({ ok: false, status: 413, stats: { bytes: 16 * MIB + 1, eventCount: 0 } }).code, classifyLedgerRead({ ok: false, status: 422, diagnostics: [{ code: 'ledger-json-invalid' }], stats: {} }).code,
    classifyLedgerRead({ ok: false, status: 422, diagnostics: [{ code: 'ledger-event-limit' }], stats: { eventCount: 10_000 } }).code, classifyLedgerRead({ ok: false, status: 500 }).code], ['ledger-full', 'ledger-corrupt', 'ledger-full', 'store-unavailable'])
  // Later each time, up to the maximum, and never sooner than the interval.
  const waits = [1, 2, 3, 4, 8, 20].map((attempts) => Date.parse(nextAttemptAt({ attempts, nowMs: 0 })))
  assert.deepEqual(waits, [60_000, 120_000, 240_000, 480_000, 3_600_000, 3_600_000])
})

test('the 256 KiB line limit with generated content: an event that would be too long is refused proposal-too-large before anything is appended, nothing is cut to fit, and a proposal that refers to the preserved bytes fits', async (t) => {
  const world = makeProposalWorld(t)
  for (const node of ['east-wing:guide', 'east-wing:second', 'east-wing:third']) world.addLink(node, 'east-wing:plain')
  await world.observe()
  const before = sourceState(world)
  // An adapter that embeds bytes instead of referring to them, with as many bytes as it takes to reach `target`.
  const embedding = (target) => ({ ...PROPOSAL_ADAPTER_PRIMITIVES, content: (input) => {
    const body = PROPOSAL_ADAPTER_PRIMITIVES.content(input)
    const bare = estimateEventLineBytes({ body: { ...body, proposal: { ...body.proposal, embedded: '' } }, workspaceId: WORKSPACE_ID })
    return { ...body, proposal: { ...body.proposal, embedded: 'e'.repeat(target - bare) } }
  } })
  const tooLong = await adapterFor(world, {}, embedding(256 * KIB + 1)).propose(onlyEdit(world, 'east-wing:guide'))
  assert.deepEqual(tooLong.outcomes.map((item) => [item.status, item.code, item.receipt.backpressure, item.receipt.proposalId]), [['refused', 'proposal-too-large', 'refused', null]])
  assert.equal(world.ledgerBytes('east-wing').length, 0, 'nothing was appended, whole or cut')
  assert.equal(fs.existsSync(path.join(world.workspaceRoot(), world.editOf('east-wing:guide').objectRef)), true)

  // The estimate is the line the real store writes, never less and at most the margin more; at the limit it still fits.
  const atLimit = await adapterFor(world, {}, embedding(256 * KIB)).propose(onlyEdit(world, 'east-wing:second'))
  assert.deepEqual(atLimit.outcomes.map((item) => [item.status, item.code]), [['acknowledged', null]])
  const written = world.ledgerBytes('east-wing').length
  assert.ok(written <= 256 * KIB && written >= 256 * KIB - PROPOSAL_BACKPRESSURE.lineMarginBytes - 64, `the line is ${written} bytes for an estimate of ${256 * KIB}`)
  // And the real store refuses the same length plus the margin: the threshold is its own.
  const body = embedding(256 * KIB + PROPOSAL_BACKPRESSURE.lineMarginBytes + 64).content({ item: { adapterOperationId: `pa-${'0'.repeat(64)}`, workspaceId: WORKSPACE_ID, repoId: 'east-wing', nodeId: 'east-wing:x', editId: `edit-${'0'.repeat(32)}`, idempotencyKey: 'k'.repeat(16), scopeId: 'scope-whole', generationId: 'gen-x', observed: { digest: digestOf('x'), byteLength: 1, recoveryRef: 'recovery/objects/x.bin' }, baseSourceDigest: digestOf('y') }, route: { sourcePath: 'notes/x.md' }, change: { code: 'unclassified', reason: null } })
  const direct = world.store('east-wing').createProposal(body)
  assert.deepEqual([direct.ok, direct.status], [false, 413])

  // Production refers to the preserved bytes, so its line is a few KiB whatever the size of the edit.
  const production = await adapterFor(world).propose(onlyEdit(world, 'east-wing:third'))
  assert.deepEqual(production.outcomes.map((item) => item.status), ['acknowledged'])
  assert.ok(world.ledgerBytes('east-wing').length - written < 8 * KIB)
  assert.deepEqual(sourceState(world), before)
})

// A ledger at a limit, generated in the on-disk format of the store, which must itself read it as valid.
function fillLedger(world, name, shape) {
  const made = writeLedger(world.storeDir(name), shape)
  const read = world.store(name).eventLedger.readAll()
  assert.deepEqual([read.ok, read.stats.eventCount, read.stats.bytes], [true, made.events, made.bytes], 'the real store reads the generated ledger as valid')
  return made
}

test('the 16 MiB and 10,000 event limits and an invalid line, with generated ledgers: a ledger with room takes the proposal, one at or near a limit defers ledger-full with the edit retained, a corrupt one refuses for that repository only, and nothing is ever compacted', async (t) => {
  const world = makeProposalWorld(t)
  for (const node of ['east-wing:guide', 'east-wing:second', 'east-wing:third', 'west-wing:guide', 'west-wing:second']) world.addLink(node, node.startsWith('east') ? 'east-wing:plain' : node === 'west-wing:guide' ? 'west-wing:second' : 'west-wing:guide')
  await world.observe()
  const before = sourceState(world)
  const started = Date.now()
  const timings = {}
  const timed = async (label, operate) => { const at = Date.now(); const value = await operate(); timings[label] = Date.now() - at; return value }
  const statusOf = (name) => adapterFor(world).status(world.context()).repositories.find((item) => item.repoId === name)
  const deferredFull = (report, label) => {
    assert.deepEqual(report.outcomes.map((item) => [item.status, item.code, item.state, item.receipt.backpressure, item.receipt.proposalId]), [['deferred', 'ledger-full', 'backpressure', 'deferred', null]], label)
    assertObsidianContract('proposal-receipt', report.outcomes[0].receipt)
  }

  // --- bytes. Just under the limit with the reserve free: accepted.
  await timed('16MiB-with-room', async () => {
    fillLedger(world, 'east-wing', { events: 90, bytes: 16 * MIB - PROPOSAL_BACKPRESSURE.reserveBytes - 8 * KIB })
    assert.deepEqual((await adapterFor(world).propose(onlyEdit(world, 'east-wing:guide'))).outcomes.map((item) => item.status), ['acknowledged'])
  })
  // Near the limit: the room left is the reviewers', and the adapter waits.
  await timed('16MiB-near', async () => {
    fillLedger(world, 'east-wing', { events: 90, bytes: 16 * MIB - 100 * KIB })
    const ledger = digestOf(world.ledgerBytes('east-wing'))
    deferredFull(await adapterFor(world).propose(onlyEdit(world, 'east-wing:second')), 'near 16 MiB')
    assert.equal(digestOf(world.ledgerBytes('east-wing')), ledger)
    assert.deepEqual([statusOf('east-wing').ledger.state, statusOf('east-wing').ledger.headroom.bytes, statusOf('east-wing').backpressureCodes], ['readable', 100 * KIB, { 'ledger-full': 1 }])
  })
  // Exactly at the limit: the real store refuses an append of its own, and the adapter never gets that far.
  await timed('16MiB-at', async () => {
    fillLedger(world, 'east-wing', { events: 90, bytes: 16 * MIB })
    const own = world.store('east-wing').createProposal({ path: 'notes/guide.md' })
    assert.deepEqual([own.ok, own.status], [false, 413], 'the threshold is the one of the store')
    const ledger = digestOf(world.ledgerBytes('east-wing'))
    deferredFull(await adapterFor(world).propose(onlyEdit(world, 'east-wing:third')), 'at 16 MiB')
    assert.equal(digestOf(world.ledgerBytes('east-wing')), ledger)
    // One byte over: the store cannot even be read, and that is still a full ledger, not a repair job.
    fs.appendFileSync(world.ledgerFile('east-wing'), '\n')
    assert.deepEqual([statusOf('east-wing').ledger.state, statusOf('east-wing').ledger.headroom], ['full', { events: 0, bytes: 0 }])
  })

  // --- events. 10,000 less the reserve and one: accepted, and that was the last the adapter takes.
  await timed('10000-events', async () => {
    fillLedger(world, 'west-wing', { events: 10_000 - PROPOSAL_BACKPRESSURE.reserveEvents - 1 })
    assert.deepEqual((await adapterFor(world).propose(onlyEdit(world, 'west-wing:guide'))).outcomes.map((item) => item.status), ['acknowledged'])
    assert.equal(statusOf('west-wing').ledger.headroom.events, PROPOSAL_BACKPRESSURE.reserveEvents)
    const ledger = digestOf(world.ledgerBytes('west-wing'))
    deferredFull(await adapterFor(world).propose(onlyEdit(world, 'west-wing:second')), 'near 10,000 events')
    assert.equal(digestOf(world.ledgerBytes('west-wing')), ledger)
    fillLedger(world, 'west-wing', { events: 10_000 })
    const own = world.store('west-wing').createProposal({ path: 'notes/guide.md' })
    assert.deepEqual([own.ok, own.status], [false, 413], 'at 10,000 events the real store refuses an append of its own')
    assert.deepEqual([statusOf('west-wing').ledger.state, statusOf('west-wing').ledger.headroom.events], ['readable', 0])
  })

  // Every deferred edit is retained: open, its bytes kept, its operation waiting in the queue.
  const waiting = adapterFor(world).list(world.context()).filter((item) => item.state === 'backpressure')
  assert.deepEqual(waiting.map((item) => [item.nodeId, item.code, item.attempts]).sort(), [['east-wing:second', 'ledger-full', 1], ['east-wing:third', 'ledger-full', 1], ['west-wing:second', 'ledger-full', 1]])
  for (const item of waiting) {
    const edit = world.pendingEdits().find((candidate) => candidate.editId === item.editId)
    assert.deepEqual([edit.closedAt, fs.existsSync(path.join(world.workspaceRoot(), edit.objectRef))], [null, true])
  }

  // Mutation control: an adapter that makes room by compacting rewrites the ledger of somebody else's store.
  const full = digestOf(world.ledgerBytes('west-wing'))
  world.advance(2 * 60 * 60 * 1000)
  await adapterFor(world).propose(onlyEdit(world, 'west-wing:second'))
  assert.equal(digestOf(world.ledgerBytes('west-wing')), full, 'production leaves a full ledger exactly as it is')
  world.advance(2 * 60 * 60 * 1000)
  await adapterFor(world, {}, { ...PROPOSAL_ADAPTER_PRIMITIVES, relieve: ({ store }) => store.eventLedger.compact() }).propose(onlyEdit(world, 'west-wing:second'))
  assert.notEqual(digestOf(world.ledgerBytes('west-wing')), full, 'the control rewrote it, and the oracle sees that')

  // --- an invalid line. The repository whose ledger cannot be read refuses; the other one goes on in the same tick.
  await timed('invalid-line', async () => {
    fs.rmSync(world.ledgerFile('east-wing'))
    fs.rmSync(world.ledgerFile('west-wing'))
    assert.equal(world.store('west-wing').createProposal({ path: 'notes/guide.md', intent: 'somebody else uses this store too' }).ok, true)
    fs.writeFileSync(world.ledgerFile('east-wing'), '{"not":"an event"}\n')
    const corrupt = digestOf(world.ledgerBytes('east-wing'))
    assert.equal(world.store('east-wing').createProposal({ path: 'notes/guide.md' }).status, 422, 'the real store refuses every append to it')
    world.advance(2 * 60 * 60 * 1000)
    const report = await adapterFor(world).propose(world.context())
    assert.deepEqual(report.outcomes.map((item) => [item.nodeId, item.status, item.code]).sort(), [['east-wing:second', 'refused', 'ledger-corrupt'], ['east-wing:third', 'refused', 'ledger-corrupt'], ['west-wing:second', 'acknowledged', null]])
    assert.equal(digestOf(world.ledgerBytes('east-wing')), corrupt, 'a corrupt ledger is not repaired, rotated or removed')
    assert.deepEqual([statusOf('east-wing').ledger.state, statusOf('east-wing').refusedCodes, statusOf('west-wing').acknowledged], ['corrupt', { 'ledger-corrupt': 2 }, 2])
  })
  assert.deepEqual(sourceState(world), before)
  timings.total = Date.now() - started
  t.diagnostic(`threshold exercise, milliseconds: ${JSON.stringify(timings)}`)
})

test('backpressure: a waiting operation is retried a bounded number of times at growing intervals with every attempt recorded, ticks in between read and write nothing, a healthy repository keeps progressing, batches are bounded, and a person can ask again once there is room', async (t) => {
  const world = makeProposalWorld(t)
  for (const node of ['east-wing:guide', 'east-wing:second', 'east-wing:third', 'west-wing:guide']) world.addLink(node, node.startsWith('east') ? 'east-wing:plain' : 'west-wing:second')
  await world.observe()
  const before = sourceState(world)
  // The real limits are exercised above with ledgers of their size. What is looked at here is what the adapter does
  // while it waits, over hundreds of ticks, so the ledger is a small one and the event limit it is held to is lowered
  // to match: thirty events of forty leave less than the reserve.
  const limits = { ...PROPOSAL_LEDGER_LIMITS, maxEvents: 40 }
  writeLedger(world.storeDir('east-wing'), { events: 30 })
  const fullLedger = digestOf(world.ledgerBytes('east-wing'))
  const counts = { opened: 0, reads: 0, writes: 0 }
  const bounds = { maxBatchPerRepository: 2 }
  const adapter = adapterFor(world, { openStore: countingStore(counts), bounds, limits })

  // Tick one: two of the three east operations (the batch bound) wait; the healthy repository is served in the same tick.
  const first = await adapter.propose(world.context())
  assert.deepEqual(first.outcomes.map((item) => [item.repoId, item.status, item.code]), [['east-wing', 'deferred', 'ledger-full'], ['east-wing', 'deferred', 'ledger-full'], ['west-wing', 'acknowledged', null]])
  assert.deepEqual(adapter.list(world.context()).map((item) => [item.repoId, item.state, item.attempts]), [['east-wing', 'backpressure', 1], ['east-wing', 'backpressure', 1], ['west-wing', 'acknowledged', 1]])
  // Tick two takes the third; it is not starved by the two that wait.
  assert.deepEqual((await adapter.propose(world.context())).outcomes.map((item) => [item.repoId, item.status]), [['east-wing', 'deferred']])

  // No busy loop. Twenty ticks inside the retry interval: nothing is asked of any store and nothing is written anywhere.
  const still = { asked: { ...counts }, queue: queueState(world), stores: storeState(world) }
  // The project and the pending edits do not change while the adapter waits, so they are read once for the loops.
  const unchanged = world.context()
  for (let tick = 0; tick < 20; tick += 1) { world.advance(2000); assert.deepEqual((await adapter.propose(unchanged)).outcomes, []) }
  assert.deepEqual({ asked: { ...counts }, queue: queueState(world), stores: storeState(world) }, still)

  // Four hundred ticks, a minute apart: every operation is tried at most maxAttempts times in all, then never again.
  const ticks = 400
  for (let tick = 0; tick < ticks; tick += 1) { world.advance(60 * 1000); await adapter.propose(unchanged) }
  const waiting = adapter.list(world.context()).filter((item) => item.repoId === 'east-wing')
  assert.deepEqual(waiting.map((item) => [item.state, item.code, item.attempts, item.exhausted]), [1, 2, 3].map(() => ['backpressure', 'ledger-full', PROPOSAL_BACKPRESSURE.maxAttempts, true]))
  const attempts = 3 * PROPOSAL_BACKPRESSURE.maxAttempts
  // An attempt reads the ledger once to see what room it has and, when it can be read, once more to look for the proposal.
  assert.ok(counts.reads - still.asked.reads <= 2 * attempts && counts.writes === 1, `${counts.reads - still.asked.reads} store reads for ${ticks} ticks is bounded by twice the attempts (${attempts}), and the only creation is the healthy one`)
  const spent = { ...counts }
  for (let tick = 0; tick < 50; tick += 1) { world.advance(24 * 60 * 60 * 1000); await adapter.propose(unchanged) }
  assert.deepEqual(counts, spent, 'an exhausted operation is never tried again by itself')
  assert.equal(digestOf(world.ledgerBytes('east-wing')), fullLedger)
  const status = adapter.status(world.context()).repositories.find((item) => item.repoId === 'east-wing')
  assert.deepEqual([status.backpressure, status.exhausted, status.backpressureCodes, status.ledger.headroom.events], [3, 3, { 'ledger-full': 3 }, 10])
  // The attempts are in the record: eight waits each, each later than the one before.
  const history = openProposalQueue({ stateRoot: world.workspaceRoot(), workspaceId: WORKSPACE_ID, repositoryRoots: protectedRoots(world.loadProject()), clock: world.clock }).read('east-wing', waiting[0].adapterOperationId).records
  assert.deepEqual(history.map((record) => record.state), ['queued', ...Array.from({ length: PROPOSAL_BACKPRESSURE.maxAttempts }, () => 'backpressure')])
  const gaps = history.slice(1).map((record) => Date.parse(record.nextAttemptAt) - Date.parse(record.lastAttemptAt))
  assert.deepEqual(gaps, [60, 120, 240, 480, 960, 1920, 3600, 3600].map((seconds) => seconds * 1000))
  for (const item of waiting) assert.equal(world.pendingEdits().find((edit) => edit.editId === item.editId).closedAt, null, 'the edit is retained throughout')

  // Mutation control: an adapter that hands a waiting operation over on every tick asks the store on every tick.
  const eager = { opened: 0, reads: 0, writes: 0 }
  const busy = adapterFor(world, { openStore: countingStore(eager), bounds: { ...bounds, maxAttempts: 1000 }, limits }, { ...PROPOSAL_ADAPTER_PRIMITIVES, handOver: () => true })
  await busy.requeue(world.context(), { repoId: 'east-wing', adapterOperationId: waiting[2].adapterOperationId })
  const third = onlyEdit(world, waiting[2].nodeId)
  for (let tick = 0; tick < 40; tick += 1) { world.advance(1000); await busy.propose(third) }
  assert.ok(eager.reads >= 40, 'the control reads the full ledger on every tick, which the bound above would refuse')

  // A person makes room (the adapter never does), and asks for the waiting operations again.
  assert.deepEqual(await adapter.requeue(world.context(), { repoId: 'east-wing', adapterOperationId: adapterFor(world).list(world.context()).find((item) => item.state === 'acknowledged').adapterOperationId }), { requeued: false, code: 'unknown-operation' })
  fs.rmSync(world.ledgerFile('east-wing'))
  for (const item of waiting.slice(0, 2)) assert.equal((await adapter.requeue(world.context(), { repoId: 'east-wing', adapterOperationId: item.adapterOperationId })).requeued, true)
  world.advance(24 * 60 * 60 * 1000)
  const served = await adapter.propose(world.context())
  assert.deepEqual(served.outcomes.map((item) => [item.repoId, item.status, item.dedupe]), [['east-wing', 'acknowledged', 'new'], ['east-wing', 'acknowledged', 'new']])
  assert.equal(world.adapterProposals('east-wing').length, 2)
  assert.deepEqual(sourceState(world), before)
})

test('status for a person or an agent: a read-only structured listing per repository through the contribution and the obsidian command, with counts, codes and ledger headroom and no note or source text', async (t) => {
  const world = makeProposalWorld(t)
  world.addLink('east-wing:guide', 'west-wing:guide')
  await world.observe()
  const registry = createObsidianRegistry({ contributions: [createProposalAdapterContribution()] })
  assert.deepEqual([registry.extensions.get('proposal-adapter').id, registry.operations.describe().map((item) => item.name), registry.contributions], [PROPOSAL_ADAPTER_ID, ['proposals'], ['atelier.proposal-adapter']])
  const run = async (argv) => {
    const out = []
    const exit = await runObsidianCommand({ argv: [...argv, '--json'], seams: {}, loadProject: world.loadProject, dataRoot: world.dataRoot, env: world.env, clock: world.clock, stdout: (text) => out.push(text), stderr: (text) => out.push(text), contributions: [createProposalAdapterContribution()] })
    return { exit, json: JSON.parse(out.join('\n')) }
  }
  // Before anything was routed: asking makes nothing, neither a store nor adapter state.
  const untouched = { project: treeListing(world.projectDir), data: treeListing(world.dataRoot) }
  const empty = await run(['proposals', 'list'])
  assert.deepEqual([empty.exit, empty.json.operations, empty.json.status.repositories.map((item) => [item.repoId, item.ledger.state, item.ledger.headroom])], [0, [], REPOSITORIES.map((name) => [name, 'absent', { events: 10_000, bytes: 16 * MIB }])])
  assert.deepEqual({ project: treeListing(world.projectDir), data: treeListing(world.dataRoot) }, untouched, 'the listing is read-only')

  await adapterFor(world).propose(world.context())
  const before = { project: treeListing(world.projectDir), data: treeListing(world.dataRoot) }
  const listed = await run(['proposals', 'list'])
  assert.equal(listed.exit, 0)
  const [east, west] = listed.json.status.repositories
  assert.deepEqual(Object.keys(east).sort(), SHAPES.statusRepositoryKeys)
  assert.deepEqual([east.repoId, east.enrolled, east.acknowledged, east.queued + east.submitted + east.backpressure + east.refused, east.ledger.state, east.ledger.events, east.ledger.headroom.events], ['east-wing', true, 1, 0, 'readable', 1, 9_999])
  assert.deepEqual([west.repoId, west.acknowledged, west.ledger.state], ['west-wing', 0, 'absent'])
  assert.deepEqual(listed.json.operations.map((item) => Object.keys(item).sort()), [SHAPES.listKeys])
  const shown = await run(['proposals', 'show', listed.json.operations[0].adapterOperationId])
  assert.deepEqual([shown.exit, shown.json.operation.state, shown.json.review.status, shown.json.operation.receipt.backpressure], [0, 'acknowledged', 'proposed', 'accepted'])
  assert.deepEqual({ project: treeListing(world.projectDir), data: treeListing(world.dataRoot) }, before, 'list and show write nothing')
  const forbidden = [WEST_TITLE, 'Lantern guide', 'Closing words', world.wikiOf('west-wing:guide'), path.basename(world.dir)]
  assert.deepEqual(stringsOf([listed.json, shown.json]).filter((value) => path.isAbsolute(value) || forbidden.some((text) => value.includes(text))), [])
  // The payload shape the disclosure oracle pins, from the data fixture.
  const [record] = world.adapterProposals('east-wing')
  assert.deepEqual(Object.keys(record.payload).sort(), SHAPES.payloadKeys)
  assert.ok(Object.keys(record.payload.change).every((key) => SHAPES.changeKeys.includes(key)))

  for (const [argv, code] of [[['proposals', 'show', 'not-an-operation'], 'usage'], [['proposals', 'show', `pa-${'0'.repeat(64)}`], 'unknown-operation'], [['proposals', 'accept'], 'usage'], [['proposals', 'list', 'extra'], 'usage']]) {
    const refused = await run(argv)
    assert.deepEqual([refused.exit !== 0, refused.json.error.code], [true, code], argv.join(' '))
  }
})

test('backpressure and a change of mind: an edit the person took back, or wrote over, while its operation waited is refused as withdrawn or superseded and never becomes a proposal', async (t) => {
  const world = makeProposalWorld(t)
  const original = fs.readFileSync(world.noteFile('east-wing:guide'))
  world.addLink('east-wing:guide', 'east-wing:plain')
  world.addLink('east-wing:second', 'east-wing:plain')
  await world.observe()
  writeLedger(world.storeDir('east-wing'), { events: 90, bytes: 16 * MIB })
  const adapter = adapterFor(world)
  assert.deepEqual((await adapter.propose(world.context())).outcomes.map((item) => [item.status, item.code]), [['deferred', 'ledger-full'], ['deferred', 'ledger-full']])
  // The first note goes back to what it was generated as; the second is edited again.
  fs.writeFileSync(world.noteFile('east-wing:guide'), original)
  world.editNote('east-wing:second', 'A second sheet.', 'A second sheet, reworded.')
  world.queueDirectly()
  fs.rmSync(world.ledgerFile('east-wing'))
  world.advance(2 * 60 * 60 * 1000)
  const report = await adapter.propose(world.context())
  assert.deepEqual(report.outcomes.map((item) => [item.nodeId, item.status, item.code]).sort(), [['east-wing:guide', 'refused', 'edit-withdrawn'], ['east-wing:second', 'refused', 'edit-superseded']])
  assert.deepEqual(world.adapterProposals('east-wing'), [], 'there was room by then, and still nothing was proposed for an edit nobody stands behind')
})
