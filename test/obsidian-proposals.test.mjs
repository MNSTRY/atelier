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
