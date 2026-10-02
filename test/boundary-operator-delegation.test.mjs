import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { generateKeyPair, signDocument } from '../src/attestation/sign.mjs'
import {
  BOUNDARY_POLICY_SCHEMA,
  checkBoundaryPolicy,
  validateBoundaryPolicy,
} from '../src/boundary/policy.mjs'
import {
  DELEGATIONS_DOCUMENT_SCHEMA,
  OWNER_KEYS_SCHEMA,
  draftDelegation,
  loadOwnerKeysFile,
  ownerKeysFromDocument,
  repoPolicyBinding,
  validateDelegationsDocument,
} from '../src/boundary/delegation.mjs'
import { commandProject, writeJson } from '../src/project/config.mjs'

// Invented actors and repositories only. Keys are generated per run.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PRIVATE = 'example-private-workspace'
const SHARED = 'example-shared'
const NOW = Date.parse('2026-02-01T00:00:00Z')

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
}

function policyDoc() {
  return {
    schema: BOUNDARY_POLICY_SCHEMA,
    mode: 'strict',
    actors: {
      'owner-a': { gitEmails: ['owner-a@example.invalid'], privateDomainRepo: PRIVATE },
      'operator-b': { gitEmails: ['operator-b@example.invalid'], privateDomainRepo: PRIVATE },
    },
    repos: {
      [PRIVATE]: { kind: 'private_domain', ownerActor: 'owner-a', readBoundary: 'private', allowedAudiences: ['private', 'team'], forbiddenAudiences: [], autoCommit: 'guarded' },
      [SHARED]: { kind: 'shared', readBoundary: 'team', allowedAudiences: ['team', 'public'], forbiddenAudiences: ['private', 'sensitive'], autoCommit: 'guarded' },
    },
    promotion: { requiresGitPromote: true, recordsPath: 'governance/git-promote-events.jsonl' },
    governanceLedgerPath: 'governance/repo-boundary-ledger.md',
  }
}

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-delegation-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const name of [PRIVATE, SHARED]) {
    const repo = path.join(root, name)
    fs.mkdirSync(repo)
    git(repo, ['init', '-q'])
    git(repo, ['config', 'user.email', 'operator-b@example.invalid'])
    git(repo, ['config', 'user.name', 'Operator'])
  }
  writeJson(path.join(root, 'atelier.project.json'), {
    schema: 'mnstry.atelier-project-config@v1',
    name: 'delegation-fixture',
    roots: { workspace: '.', repoOps: '.' },
    graph: { repoAccessPath: 'repo-access.v1.json', outputPath: 'atelier-output/knowledge.graph.json' },
    projection: { outputRoot: 'atelier-output', readinessPath: 'atelier-output/atelier-readiness.json' },
    boundaries: { policyPath: 'boundary-policy.v1.json', governanceLedgerPath: 'governance/repo-boundary-ledger.md', strictNewRepos: true },
    repos: [
      { name: PRIVATE, path: PRIVATE, readBoundary: 'private' },
      { name: SHARED, path: SHARED, readBoundary: 'team' },
    ],
  })
  writeJson(path.join(root, 'repo-access.v1.json'), { schema: 'mnstry.atelier-repo-access@v1', defaultReadBoundary: 'team', repos: { [PRIVATE]: { readBoundary: 'private' }, [SHARED]: { readBoundary: 'team' } } })
  const policy = policyDoc()
  writeJson(path.join(root, 'boundary-policy.v1.json'), policy)
  const project = commandProject({ argv: ['--project', path.join(root, 'atelier.project.json')], cwd: root, env: {} })
  return { root, project, policy }
}

function owner() {
  const { privateKeyDoc, publicKeyDoc } = generateKeyPair({ keyId: 'owner-a-key' })
  return { privateKeyDoc, publicKeyDoc }
}

function sign(doc, privateKeyDoc) {
  return signDocument({ ...doc, signature: null }, { privateKey: privateKeyDoc.privateKeyJwk, keyId: privateKeyDoc.keyId, algorithm: privateKeyDoc.algorithm })
}

function delegation(policy, privateKeyDoc, overrides = {}) {
  const { delegation: doc } = draftDelegation({
    policy,
    id: 'operator-b-commits',
    owner: 'owner-a',
    operator: 'operator-b',
    repos: [PRIVATE],
    operations: ['pre-commit'],
    notBefore: '2026-01-15T00:00:00Z',
    expiresAt: '2026-03-01T00:00:00Z',
  })
  return sign({ ...doc, ...overrides }, privateKeyDoc)
}

const delegationsDoc = (...items) => ({ schema: DELEGATIONS_DOCUMENT_SCHEMA, delegations: items })
const keysDoc = (publicKeyDoc, extra = {}) => ({ schema: OWNER_KEYS_SCHEMA, keys: [{ actorId: 'owner-a', keyId: publicKeyDoc.keyId, algorithm: 'ed25519', publicKeyJwk: publicKeyDoc.publicKeyJwk }], ...extra })

function run(ws, options = {}) {
  return checkBoundaryPolicy({ project: ws.project, policy: ws.policy, actor: 'operator-b', staged: true, now: NOW, allowNetworkActorResolution: false, ...options })
}

const codes = (report) => report.findings.map((item) => item.code)
const mismatch = (report) => report.errors.find((item) => item.code === 'private-domain-actor-mismatch')

test('T1 without a delegation the operator mismatch still refuses', (t) => {
  const ws = workspace(t)
  const report = run(ws)
  assert.equal(report.ok, false)
  assert.equal(mismatch(report).details.delegationReason, 'delegation-missing')
})

test('T2 a signed, current, in-scope delegation with a host key lets the operator commit', (t) => {
  const ws = workspace(t)
  const { privateKeyDoc, publicKeyDoc } = owner()
  const report = run(ws, { delegations: delegationsDoc(delegation(ws.policy, privateKeyDoc)), ownerKeys: ownerKeysFromDocument(keysDoc(publicKeyDoc)) })
  assert.equal(report.ok, true, JSON.stringify(report.errors))
  const notice = report.findings.find((item) => item.code === 'private-domain-delegated-operator')
  assert.deepEqual(notice.details, { actorId: 'operator-b', owner: 'owner-a', delegationId: 'operator-b-commits', expiresAt: '2026-03-01T00:00:00Z', operation: 'pre-commit' })
  assert.equal(notice.severity, 'info')
  assert.equal(ws.policy.repos[PRIVATE].ownerActor, 'owner-a')
})

test('T3 and T4 the operation and the repositories are limited to the signed scope', (t) => {
  const ws = workspace(t)
  const { privateKeyDoc, publicKeyDoc } = owner()
  const ownerKeys = ownerKeysFromDocument(keysDoc(publicKeyDoc))
  const checkOnly = delegation(ws.policy, privateKeyDoc, { operations: ['boundary-check'] })
  assert.equal(mismatch(run(ws, { delegations: delegationsDoc(checkOnly), ownerKeys })).details.delegationReason, 'delegation-scope')
  assert.equal(run(ws, { staged: false, stagedOnly: true, delegations: delegationsDoc(checkOnly), ownerKeys }).ok, true)
  const ws2 = workspace(t)
  ws2.policy.repos['example-second-private'] = { ...ws2.policy.repos[PRIVATE] }
  ws2.project.repos.push({ name: 'example-second-private', path: path.join(ws2.root, PRIVATE) })
  const report = run(ws2, { delegations: delegationsDoc(delegation(ws2.policy, privateKeyDoc)), ownerKeys })
  const second = report.errors.find((item) => item.code === 'private-domain-actor-mismatch' && item.repo === 'example-second-private')
  assert.equal(second.details.delegationReason, 'delegation-scope')
})

test('T5 and T7 a delegation needs the host owner key and a valid signature', (t) => {
  const ws = workspace(t)
  const { privateKeyDoc, publicKeyDoc } = owner()
  const signed = delegation(ws.policy, privateKeyDoc)
  assert.equal(mismatch(run(ws, { delegations: delegationsDoc(signed) })).details.delegationReason, 'delegation-owner-key-missing')
  const other = owner()
  assert.equal(mismatch(run(ws, { delegations: delegationsDoc(signed), ownerKeys: ownerKeysFromDocument(keysDoc(other.publicKeyDoc)) })).details.delegationReason, 'delegation-signature-invalid')
  const tampered = { ...signed, expiresAt: '2026-03-02T00:00:00Z' }
  assert.equal(mismatch(run(ws, { delegations: delegationsDoc(tampered), ownerKeys: ownerKeysFromDocument(keysDoc(publicKeyDoc)) })).details.delegationReason, 'delegation-signature-invalid')
  const renamedKey = { ...signed, signature: { ...signed.signature, keyId: 'another-key' } }
  assert.equal(mismatch(run(ws, { delegations: delegationsDoc(renamedKey), ownerKeys: ownerKeysFromDocument(keysDoc(publicKeyDoc)) })).details.delegationReason, 'delegation-owner-key-missing')
})

test('T8 a delegation applies only inside its validity window, at most 90 days', (t) => {
  const ws = workspace(t)
  const { privateKeyDoc, publicKeyDoc } = owner()
  const options = { delegations: delegationsDoc(delegation(ws.policy, privateKeyDoc)), ownerKeys: ownerKeysFromDocument(keysDoc(publicKeyDoc)) }
  assert.equal(mismatch(run(ws, { ...options, now: Date.parse('2026-01-14T23:59:59Z') })).details.delegationReason, 'delegation-not-yet-valid')
  assert.equal(mismatch(run(ws, { ...options, now: Date.parse('2026-03-01T00:00:00Z') })).details.delegationReason, 'delegation-expired')
  const long = delegation(ws.policy, privateKeyDoc, { expiresAt: '2026-04-15T00:00:01Z' })
  const report = run(ws, { delegations: delegationsDoc(long), ownerKeys: options.ownerKeys })
  assert.ok(report.errors.some((item) => item.code === 'boundary-delegations-invalid' && /at most 90 days/.test(item.message)))
  assert.equal(mismatch(report).details.delegationReason, 'delegation-missing')
})

test('T9 the host revokes a delegation, or removes the owner key', (t) => {
  const ws = workspace(t)
  const { privateKeyDoc, publicKeyDoc } = owner()
  const delegations = delegationsDoc(delegation(ws.policy, privateKeyDoc))
  assert.equal(mismatch(run(ws, { delegations, ownerKeys: ownerKeysFromDocument(keysDoc(publicKeyDoc, { revokedDelegations: ['operator-b-commits'] })) })).details.delegationReason, 'delegation-revoked')
  assert.equal(mismatch(run(ws, { delegations, ownerKeys: ownerKeysFromDocument({ schema: OWNER_KEYS_SCHEMA, keys: [] }) })).details.delegationReason, 'delegation-owner-key-missing')
})

test('T10 editing the delegated repository or a policy-wide protection voids the delegation', (t) => {
  const { privateKeyDoc, publicKeyDoc } = owner()
  const edits = [
    (policy) => { policy.repos[PRIVATE].allowedAudiences.push('public') },
    (policy) => { policy.mode = 'legacy-warning' },
    (policy) => { policy.forbiddenPaths = ['notes/**'] },
    (policy) => { policy.contentRuleExceptions = [{ rule: 'private-key-block', repo: PRIVATE, paths: ['keys/**'], reason: 'invented' }] },
    (policy) => { policy.promotion.requiresGitPromote = false },
  ]
  for (const edit of edits) {
    const ws = workspace(t)
    const delegations = delegationsDoc(delegation(ws.policy, privateKeyDoc))
    edit(ws.policy)
    const report = run(ws, { delegations, ownerKeys: ownerKeysFromDocument(keysDoc(publicKeyDoc)) })
    const refused = report.findings.find((item) => item.code === 'private-domain-actor-mismatch')
    assert.ok(refused, `edit ${edit} must leave the mismatch`)
    assert.equal(refused.details.delegationReason, 'delegation-policy-binding-changed')
  }
  const ws = workspace(t)
  const before = repoPolicyBinding(ws.policy, PRIVATE)
  ws.policy.repos[PRIVATE].ext = { 'example.note': 'ignored' }
  assert.equal(repoPolicyBinding(ws.policy, PRIVATE), before, 'ext is never read, so it is outside the binding')
})

test('T11 two matching delegations are ambiguous and grant nothing', (t) => {
  const ws = workspace(t)
  const { privateKeyDoc, publicKeyDoc } = owner()
  const first = delegation(ws.policy, privateKeyDoc)
  const second = delegation(ws.policy, privateKeyDoc, { id: 'operator-b-second' })
  assert.equal(mismatch(run(ws, { delegations: delegationsDoc(first, second), ownerKeys: ownerKeysFromDocument(keysDoc(publicKeyDoc)) })).details.delegationReason, 'delegation-ambiguous')
})

test('T12 malformed delegations are invalid documents and grant nothing', (t) => {
  const ws = workspace(t)
  const { privateKeyDoc } = owner()
  const cases = [
    [{ owner: 'operator-b' }, /not owned by operator-b/],
    [{ operator: 'owner-a' }, /must differ from the owner/],
    [{ operator: 'stranger' }, /operator must be a declared actor/],
    [{ repos: [SHARED], policyBinding: { [SHARED]: repoPolicyBinding(ws.policy, SHARED) } }, /must be a declared private_domain repo/],
    [{ operations: ['pre-push'] }, /operations must be/],
    [{ readBoundary: 'public' }, /must not include additional property readBoundary/],
  ]
  for (const [overrides, expected] of cases) {
    const item = delegation(ws.policy, privateKeyDoc, overrides)
    const errors = validateDelegationsDocument(delegationsDoc(item), ws.policy)
    assert.ok(errors.some((message) => expected.test(message)), `${JSON.stringify(overrides)}: ${errors.join('; ')}`)
  }
  const unsigned = { ...delegation(ws.policy, privateKeyDoc), signature: null }
  assert.ok(validateDelegationsDocument(delegationsDoc(unsigned), ws.policy).some((message) => /unsigned delegation grants nothing/.test(message)))
  const duplicate = delegation(ws.policy, privateKeyDoc)
  assert.ok(validateDelegationsDocument(delegationsDoc(duplicate, duplicate), ws.policy).some((message) => /is duplicated/.test(message)))
})

test('owner keys carry public keys only', () => {
  const { privateKeyDoc, publicKeyDoc } = owner()
  // Built at run time: a private member must never be accepted as an owner key.
  const withPrivate = { ...publicKeyDoc.publicKeyJwk, d: privateKeyDoc.privateKeyJwk.d }
  const result = ownerKeysFromDocument({ schema: OWNER_KEYS_SCHEMA, keys: [{ actorId: 'owner-a', keyId: 'k', algorithm: 'ed25519', publicKeyJwk: withPrivate }] })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'delegation-owner-keys-invalid')
})

test('T13 and T14 an unverified actor and the owner keep today\'s outcomes', (t) => {
  const ws = workspace(t)
  const { privateKeyDoc, publicKeyDoc } = owner()
  const options = { delegations: delegationsDoc(delegation(ws.policy, privateKeyDoc)), ownerKeys: ownerKeysFromDocument(keysDoc(publicKeyDoc)) }
  const unverified = run(ws, { ...options, actor: 'nobody-declared' })
  assert.ok(unverified.errors.some((item) => item.code === 'actor-resolution-refused'))
  const asOwner = run(ws, { ...options, actor: 'owner-a' })
  assert.equal(asOwner.ok, true)
  assert.equal(codes(asOwner).includes('private-domain-delegated-operator'), false)
})

test('T15 content and placement checks still apply under a delegation', (t) => {
  const ws = workspace(t)
  const { privateKeyDoc, publicKeyDoc } = owner()
  const repo = path.join(ws.root, PRIVATE)
  fs.mkdirSync(path.join(repo, '.atelier-local'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.atelier-local/state.json'), '{}\n')
  git(repo, ['add', '.'])
  const report = run(ws, { delegations: delegationsDoc(delegation(ws.policy, privateKeyDoc)), ownerKeys: ownerKeysFromDocument(keysDoc(publicKeyDoc)) })
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((item) => item.code === 'forbidden-path-staged'))
  assert.ok(codes(report).includes('private-domain-delegated-operator'))
})

test('T16 push-content checks and promotion are outside the delegation path', () => {
  // Structural guard: only the actor check consults delegations. Push-content
  // approval and promotion take no delegation input at all.
  const source = fs.readFileSync(path.join(ROOT, 'src/boundary/policy.mjs'), 'utf8')
  const pushBody = source.slice(source.indexOf('export function checkPushContent'), source.indexOf('export function auditContentRules'))
  const pushCommand = source.slice(source.indexOf('export function runBoundaryPushCheckCommand'), source.indexOf('export function resolveBoundaryAuditSource'))
  const promoteBody = source.slice(source.indexOf('export function createPromoteEvent'))
  for (const body of [pushBody, pushCommand, promoteBody]) {
    assert.ok(body.length > 100)
    assert.equal(/delegat|ownerKeys/i.test(body), false)
  }
  assert.equal((source.match(/resolveDelegation\(/g) ?? []).length, 1)
})

test('T17 ext and contractVersion validate as the schema declares and never grant authority', (t) => {
  const ws = workspace(t)
  const policy = { ...ws.policy, contractVersion: '1.1.0', ext: { 'example.delegations': [{ operator: 'operator-b' }] } }
  policy.repos = { ...policy.repos, [PRIVATE]: { ...policy.repos[PRIVATE], ext: { 'example.operators': ['operator-b'] } } }
  policy.actors = { ...policy.actors, 'operator-b': { ...policy.actors['operator-b'], ext: { 'example.actsFor': 'owner-a' } } }
  policy.promotion = { ...policy.promotion, ext: {} }
  assert.deepEqual(validateBoundaryPolicy(policy, ws.project), [])
  const report = checkBoundaryPolicy({ project: ws.project, policy, actor: 'operator-b', staged: true, now: NOW, allowNetworkActorResolution: false })
  assert.equal(report.ok, false)
  assert.equal(mismatch(report).details.delegationReason, 'delegation-missing')
  assert.ok(validateBoundaryPolicy({ ...policy, ext: 'not-an-object' }).includes('/.ext must be an object'))
  assert.ok(validateBoundaryPolicy({ ...policy, contractVersion: '2.0.0' }).includes('contractVersion must be a 1.x.y version'))
})

test('T18 legacy-warning mode keeps its severity rule', (t) => {
  const ws = workspace(t)
  ws.policy.mode = 'legacy-warning'
  const report = run(ws)
  assert.equal(report.ok, true)
  assert.equal(report.warnings.find((item) => item.code === 'private-domain-actor-mismatch').severity, 'warning')
})

test('T6 the CLI trusts only an owner-keys file the user can neither write nor replace', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, (t) => {
  const ws = workspace(t)
  const { publicKeyDoc } = owner()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-owner-keys-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  const file = path.join(outside, 'keys.json')
  writeJson(file, keysDoc(publicKeyDoc))
  fs.chmodSync(file, 0o444)
  assert.match(loadOwnerKeysFile(file, { project: ws.project }).errors[0], /owned by the current user/)
  const inProject = path.join(ws.root, 'keys.json')
  writeJson(inProject, keysDoc(publicKeyDoc))
  assert.match(loadOwnerKeysFile(inProject, { project: ws.project }).errors[0], /outside the project/)
  const link = path.join(outside, 'link.json')
  fs.symlinkSync(file, link)
  assert.match(loadOwnerKeysFile(link, { project: ws.project }).errors[0], /symlink/)
  assert.match(loadOwnerKeysFile(file, { project: ws.project, uid: 0 }).errors[0], /root account/)
  // Simulate a host-owned file in host-owned, read-only directories.
  const notMine = 4294967294
  const nothingWritable = () => { throw new Error('EACCES') }
  assert.equal(loadOwnerKeysFile(file, { project: ws.project, uid: notMine, access: nothingWritable }).ok, true)
  fs.chmodSync(file, 0o664)
  assert.match(loadOwnerKeysFile(file, { project: ws.project, uid: notMine, access: nothingWritable }).errors[0], /group- or world-writable/)
  fs.chmodSync(file, 0o444)
  assert.match(loadOwnerKeysFile(file, { project: ws.project, uid: notMine }).errors[0], /directory the current user/)
})

function inside(child, parent) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

test('T19 the owner drafts, signs and verifies with the CLI; check reads the sidecar', (t) => {
  const ws = workspace(t)
  const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-owner-cli-'))
  t.after(() => fs.rmSync(keyDir, { recursive: true, force: true }))
  const bin = path.join(ROOT, 'bin/atelier.mjs')
  const cli = (args, options = {}) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', cwd: ws.root, env: { ...process.env, ATELIER_BOUNDARY_OWNER_KEYS: '' }, ...options })
  const keygen = cli(['attestation', 'keygen', '--key-id', 'owner-a-key', '--out', path.join(keyDir, 'owner.key.json')])
  assert.equal(keygen.status, 0, keygen.stderr)
  const draft = cli(['boundary', 'delegation', 'draft', '--project', path.join(ws.root, 'atelier.project.json'), '--id', 'operator-b-commits', '--owner', 'owner-a', '--operator', 'operator-b',
    '--repos', PRIVATE, '--operations', 'pre-commit', '--not-before', '2026-01-15T00:00:00Z', '--expires', '2026-03-01T00:00:00Z', '--out', path.join(keyDir, 'draft.json')])
  assert.equal(draft.status, 0, draft.stderr)
  const signed = cli(['boundary', 'delegation', 'sign', path.join(keyDir, 'draft.json'), '--key', path.join(keyDir, 'owner.key.json'), '--out', path.join(keyDir, 'signed.json')])
  assert.equal(signed.status, 0, signed.stderr)
  const again = cli(['boundary', 'delegation', 'sign', path.join(keyDir, 'signed.json'), '--key', path.join(keyDir, 'owner.key.json')])
  assert.equal(again.status, 2)
  const doc = JSON.parse(fs.readFileSync(path.join(keyDir, 'signed.json'), 'utf8'))
  assert.equal(doc.signature.keyId, 'owner-a-key')
  // The owner-keys file the test can write is refused, so verify reports untrusted.
  const publicKey = JSON.parse(keygen.stdout)
  writeJson(path.join(keyDir, 'keys.json'), keysDoc(publicKey))
  const verify = cli(['boundary', 'delegation', 'verify', path.join(keyDir, 'signed.json'), '--owner-keys', path.join(keyDir, 'keys.json'), '--json'])
  assert.equal(verify.status, 1)
  assert.equal(JSON.parse(verify.stdout).reasons[0].code, 'delegation-owner-keys-untrusted')
  // With the sidecar in place and no trusted keys, the check still refuses the operator.
  writeJson(path.join(ws.root, 'boundary-delegations.v1.json'), delegationsDoc(doc))
  const check = cli(['boundary', 'check', '--staged', '--project', path.join(ws.root, 'atelier.project.json'), '--actor', 'operator-b', '--owner-keys', path.join(keyDir, 'keys.json'), '--json'])
  assert.equal(check.status, 1)
  const report = JSON.parse(check.stdout)
  assert.equal(report.errors.find((item) => item.code === 'private-domain-actor-mismatch').details.delegationReason, 'delegation-owner-keys-untrusted')
  // A malformed sidecar is an error of its own.
  fs.writeFileSync(path.join(ws.root, 'boundary-delegations.v1.json'), '{')
  const broken = JSON.parse(cli(['boundary', 'check', '--project', path.join(ws.root, 'atelier.project.json'), '--actor', 'operator-b', '--json']).stdout)
  assert.ok(broken.errors.some((item) => item.code === 'boundary-delegations-invalid'))
})

test('T20 the boundary policy contract is not widened: delegations live in their own document', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts/atelier-boundary-policy.v1.schema.json'), 'utf8'))
  assert.equal(Object.hasOwn(schema.properties, 'delegations'), false)
  assert.match(schema.$comment, /^contract revision 1\.1\.0/)
  const policy = { ...policyDoc(), delegations: [] }
  assert.ok(validateBoundaryPolicy(policy).includes('/ must not include additional property delegations'))
})
