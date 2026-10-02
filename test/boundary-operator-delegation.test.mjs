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
  policyDigest,
  repoRootCommit,
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
    git(repo, ['commit', '-q', '--allow-empty', '-m', `root of ${name} ${root}`])
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

function delegation(ws, privateKeyDoc, overrides = {}) {
  const { delegation: doc } = draftDelegation({
    policy: ws.policy,
    project: ws.project,
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
  const report = run(ws, { delegations: delegationsDoc(delegation(ws, privateKeyDoc)), ownerKeys: ownerKeysFromDocument(keysDoc(publicKeyDoc)) })
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
  const checkOnly = delegation(ws, privateKeyDoc, { operations: ['boundary-check'] })
  assert.equal(mismatch(run(ws, { delegations: delegationsDoc(checkOnly), ownerKeys })).details.delegationReason, 'delegation-scope')
  assert.equal(run(ws, { staged: false, stagedOnly: true, delegations: delegationsDoc(checkOnly), ownerKeys }).ok, true)
  const ws2 = workspace(t)
  ws2.policy.repos['example-second-private'] = { ...ws2.policy.repos[PRIVATE] }
  ws2.project.repos.push({ name: 'example-second-private', path: path.join(ws2.root, PRIVATE) })
  const report = run(ws2, { delegations: delegationsDoc(delegation(ws2, privateKeyDoc)), ownerKeys })
  const second = report.errors.find((item) => item.code === 'private-domain-actor-mismatch' && item.repo === 'example-second-private')
  assert.equal(second.details.delegationReason, 'delegation-scope')
})

test('T5 and T7 a delegation needs the host owner key and a valid signature', (t) => {
  const ws = workspace(t)
  const { privateKeyDoc, publicKeyDoc } = owner()
  const signed = delegation(ws, privateKeyDoc)
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
  const options = { delegations: delegationsDoc(delegation(ws, privateKeyDoc)), ownerKeys: ownerKeysFromDocument(keysDoc(publicKeyDoc)) }
  assert.equal(mismatch(run(ws, { ...options, now: Date.parse('2026-01-14T23:59:59Z') })).details.delegationReason, 'delegation-not-yet-valid')
  assert.equal(mismatch(run(ws, { ...options, now: Date.parse('2026-03-01T00:00:00Z') })).details.delegationReason, 'delegation-expired')
  const long = delegation(ws, privateKeyDoc, { expiresAt: '2026-04-15T00:00:01Z' })
  const report = run(ws, { delegations: delegationsDoc(long), ownerKeys: options.ownerKeys })
  assert.ok(report.errors.some((item) => item.code === 'boundary-delegations-invalid' && /at most 90 days/.test(item.message)))
  assert.equal(mismatch(report).details.delegationReason, 'delegation-missing')
})

test('T9 the host revokes a delegation, or removes the owner key', (t) => {
  const ws = workspace(t)
  const { privateKeyDoc, publicKeyDoc } = owner()
  const delegations = delegationsDoc(delegation(ws, privateKeyDoc))
  assert.equal(mismatch(run(ws, { delegations, ownerKeys: ownerKeysFromDocument(keysDoc(publicKeyDoc, { revokedDelegations: ['operator-b-commits'] })) })).details.delegationReason, 'delegation-revoked')
  assert.equal(mismatch(run(ws, { delegations, ownerKeys: ownerKeysFromDocument({ schema: OWNER_KEYS_SCHEMA, keys: [] }) })).details.delegationReason, 'delegation-owner-key-missing')
})

test('T10 any edit to the policy or the managed repositories voids the delegation', (t) => {
  const { privateKeyDoc, publicKeyDoc } = owner()
  const edits = [
    ['delegated repo audiences', (ws) => { ws.policy.repos[PRIVATE].allowedAudiences.push('public') }],
    ['sibling repo audiences', (ws) => { ws.policy.repos[SHARED].allowedAudiences.push('private') }],
    ['actors', (ws) => { ws.policy.actors['operator-b'].gitEmails.push('another@example.invalid') }],
    ['mode', (ws) => { ws.policy.mode = 'legacy-warning' }],
    ['forbidden paths', (ws) => { ws.policy.forbiddenPaths = ['notes/**'] }],
    ['content rule exceptions', (ws) => { ws.policy.contentRuleExceptions = [{ rule: 'private-key-block', repo: PRIVATE, paths: ['keys/**'], reason: 'invented' }] }],
    ['promotion', (ws) => { ws.policy.promotion.requiresGitPromote = false }],
    ['governance ledger', (ws) => { ws.policy.governanceLedgerPath = 'elsewhere.md' }],
    ['managed repository set', (ws) => { ws.project.repos = ws.project.repos.filter((repo) => repo.name !== SHARED) }],
  ]
  for (const [name, edit] of edits) {
    const ws = workspace(t)
    const delegations = delegationsDoc(delegation(ws, privateKeyDoc))
    edit(ws)
    const report = run(ws, { delegations, ownerKeys: ownerKeysFromDocument(keysDoc(publicKeyDoc)) })
    const refused = report.findings.find((item) => item.code === 'private-domain-actor-mismatch')
    assert.ok(refused, `${name}: the mismatch must remain`)
    assert.equal(refused.details.delegationReason, 'delegation-policy-changed', name)
  }
  const ws = workspace(t)
  const before = policyDigest(ws.policy, ws.project)
  ws.policy.repos[PRIVATE].ext = { 'example.note': 'ignored' }
  ws.policy.ext = { 'example.top': { ext: 'nested' } }
  assert.equal(policyDigest(ws.policy, ws.project), before, 'ext is never read, so it is outside the digest')
})

test('a signed delegation does not replay into another project with the same names and policy', (t) => {
  const { privateKeyDoc, publicKeyDoc } = owner()
  const first = workspace(t)
  const signed = delegation(first, privateKeyDoc)
  const second = workspace(t)
  assert.equal(policyDigest(second.policy, second.project), signed.policyDigest)
  assert.notEqual(repoRootCommit(path.join(second.root, PRIVATE)), signed.repoRoots[PRIVATE])
  const report = run(second, { delegations: delegationsDoc(signed), ownerKeys: ownerKeysFromDocument(keysDoc(publicKeyDoc)) })
  assert.equal(mismatch(report).details.delegationReason, 'delegation-repository-changed')
})

test('an operator key registered on the host cannot sign for the owner', (t) => {
  const ws = workspace(t)
  const ownerKey = owner()
  const operatorKey = generateKeyPair({ keyId: 'operator-b-key' })
  const forged = delegation(ws, operatorKey.privateKeyDoc)
  const keys = { schema: OWNER_KEYS_SCHEMA, keys: [
    { actorId: 'owner-a', keyId: ownerKey.publicKeyDoc.keyId, algorithm: 'ed25519', publicKeyJwk: ownerKey.publicKeyDoc.publicKeyJwk },
    { actorId: 'operator-b', keyId: operatorKey.publicKeyDoc.keyId, algorithm: 'ed25519', publicKeyJwk: operatorKey.publicKeyDoc.publicKeyJwk },
  ] }
  assert.equal(mismatch(run(ws, { delegations: delegationsDoc(forged), ownerKeys: ownerKeysFromDocument(keys) })).details.delegationReason, 'delegation-owner-key-missing')
})

test('a library host must pass a well-formed owner-keys value', (t) => {
  const ws = workspace(t)
  const { privateKeyDoc, publicKeyDoc } = owner()
  const delegations = delegationsDoc(delegation(ws, privateKeyDoc))
  const raw = keysDoc(publicKeyDoc)
  assert.equal(run(ws, { delegations, ownerKeys: raw }).ok, true, 'a raw document is validated and accepted')
  const forged = { ok: true, keys: [{ actorId: 'owner-a', keyId: 'owner-a-key', algorithm: 'ed25519', publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: 'not-a-key' } }], revoked: new Set() }
  assert.equal(mismatch(run(ws, { delegations, ownerKeys: forged })).details.delegationReason, 'delegation-owner-keys-invalid')
})

test('an entry named ext is ordinary policy and stays bound', (t) => {
  const { privateKeyDoc, publicKeyDoc } = owner()
  const ws = workspace(t)
  ws.policy.repos.ext = { kind: 'shared', readBoundary: 'team', allowedAudiences: ['team'], forbiddenAudiences: ['private', 'sensitive'], autoCommit: 'guarded' }
  const delegations = delegationsDoc(delegation(ws, privateKeyDoc))
  ws.policy.repos.ext.allowedAudiences.push('private')
  const report = run(ws, { delegations, ownerKeys: ownerKeysFromDocument(keysDoc(publicKeyDoc)) })
  assert.equal(report.findings.find((item) => item.code === 'private-domain-actor-mismatch').details.delegationReason, 'delegation-policy-changed')
})

test('owner and operator ids must be plain identifiers', (t) => {
  const ws = workspace(t)
  const { privateKeyDoc } = owner()
  for (const id of ['operator\u001b[8m-b', 'operator\nrepositories: none', 'operator‐b']) {
    ws.policy.actors[id] = { gitEmails: ['x@example.invalid'], privateDomainRepo: PRIVATE }
    const errors = validateDelegationsDocument(delegationsDoc(delegation(ws, privateKeyDoc, { operator: id })), ws.policy)
    assert.ok(errors.some((message) => /operator must be a declared actor with a plain identifier/.test(message)), JSON.stringify(id))
  }
})

test('T11 two matching delegations are ambiguous and grant nothing', (t) => {
  const ws = workspace(t)
  const { privateKeyDoc, publicKeyDoc } = owner()
  const first = delegation(ws, privateKeyDoc)
  const second = delegation(ws, privateKeyDoc, { id: 'operator-b-second' })
  assert.equal(mismatch(run(ws, { delegations: delegationsDoc(first, second), ownerKeys: ownerKeysFromDocument(keysDoc(publicKeyDoc)) })).details.delegationReason, 'delegation-ambiguous')
})

test('T12 malformed delegations are invalid documents and grant nothing', (t) => {
  const ws = workspace(t)
  const { privateKeyDoc } = owner()
  const cases = [
    [{ owner: 'operator-b' }, /not owned by operator-b/],
    [{ operator: 'owner-a' }, /must differ from the owner/],
    [{ operator: 'stranger' }, /operator must be a declared actor/],
    [{ repos: [SHARED], repoRoots: { [SHARED]: repoRootCommit(path.join(ws.root, SHARED)) } }, /must be a declared private_domain repo/],
    [{ operations: ['pre-push'] }, /operations must be/],
    [{ readBoundary: 'public' }, /must not include additional property readBoundary/],
  ]
  for (const [overrides, expected] of cases) {
    const item = delegation(ws, privateKeyDoc, overrides)
    const errors = validateDelegationsDocument(delegationsDoc(item), ws.policy)
    assert.ok(errors.some((message) => expected.test(message)), `${JSON.stringify(overrides)}: ${errors.join('; ')}`)
  }
  const unsigned = { ...delegation(ws, privateKeyDoc), signature: null }
  assert.ok(validateDelegationsDocument(delegationsDoc(unsigned), ws.policy).some((message) => /unsigned delegation grants nothing/.test(message)))
  const duplicate = delegation(ws, privateKeyDoc)
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
  const options = { delegations: delegationsDoc(delegation(ws, privateKeyDoc)), ownerKeys: ownerKeysFromDocument(keysDoc(publicKeyDoc)) }
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
  const report = run(ws, { delegations: delegationsDoc(delegation(ws, privateKeyDoc)), ownerKeys: ownerKeysFromDocument(keysDoc(publicKeyDoc)) })
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

test('T6 the host owner-keys file is trusted only when owned by the trusted account in trusted directories', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, (t) => {
  const { publicKeyDoc } = owner()
  const me = process.getuid()
  const someoneElse = me + 1
  // A directory under the home directory stands in for /etc/atelier: the test
  // treats the current account as the trusted owner and runs as someone else.
  const home = fs.realpathSync(os.homedir())
  const dirs = []
  for (let dir = home; ; dir = path.dirname(dir)) {
    dirs.push(fs.statSync(dir))
    if (path.dirname(dir) === dir) break
  }
  const homeIsTrustable = dirs.every((info) => (info.uid === me || info.uid === 0) && (info.mode & 0o022) === 0)
  const base = fs.mkdtempSync(path.join(home, '.atelier-owner-keys-test-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  fs.chmodSync(base, 0o755)
  const file = path.join(base, 'keys.json')
  writeJson(file, keysDoc(publicKeyDoc))
  fs.chmodSync(file, 0o644)
  const as = (options = {}) => loadOwnerKeysFile(file, { trustedUid: me, currentUid: someoneElse, ...options })
  if (homeIsTrustable) assert.equal(as().ok, true, JSON.stringify(as()))
  assert.equal(loadOwnerKeysFile(file, { trustedUid: 0, currentUid: someoneElse }).errors[0], 'owner keys file must be owned by the trusted account')
  assert.match(as({ currentUid: me }).errors[0], /current account must not own/)
  assert.match(as({ currentUid: 0 }).errors[0], /root account/)
  assert.match(as({ platform: 'win32' }).errors[0], /not supported on Windows/)
  fs.chmodSync(file, 0o664)
  assert.match(as().errors[0], /group- or world-writable/)
  fs.chmodSync(file, 0o644)
  fs.chmodSync(base, 0o775)
  assert.match(as().errors[0], /directories owned by the trusted account/)
  fs.chmodSync(base, 0o755)
  const link = path.join(base, 'link.json')
  fs.symlinkSync(file, link)
  assert.match(loadOwnerKeysFile(link, { trustedUid: me, currentUid: someoneElse }).errors[0], /symlink/)
  assert.match(loadOwnerKeysFile(base, { trustedUid: me, currentUid: someoneElse }).errors[0], /regular file/)
  assert.equal(loadOwnerKeysFile(path.join(base, 'absent.json'), { trustedUid: me, currentUid: someoneElse }).reason, 'delegation-owner-key-missing')
})

function inside(child, parent) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

test('T19 the owner drafts, signs against the current project and verifies; check reads the sidecar', (t) => {
  const ws = workspace(t)
  const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-owner-cli-'))
  t.after(() => fs.rmSync(keyDir, { recursive: true, force: true }))
  const bin = path.join(ROOT, 'bin/atelier.mjs')
  const projectArgs = ['--project', path.join(ws.root, 'atelier.project.json')]
  const cli = (args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', cwd: ws.root, env: { ...process.env, ATELIER_BOUNDARY_OWNER_KEYS: path.join(keyDir, 'keys.json') } })
  const keygen = cli(['attestation', 'keygen', '--key-id', 'owner-a-key', '--out', path.join(keyDir, 'owner.key.json')])
  assert.equal(keygen.status, 0, keygen.stderr)
  // An operator-editable field with a terminal escape must reach the owner neutralised.
  ws.policy.actors['operator-b'].githubLogin = 'op\u001b[8mhidden'
  writeJson(path.join(ws.root, 'boundary-policy.v1.json'), ws.policy)
  const draft = cli(['boundary', 'delegation', 'draft', ...projectArgs, '--id', 'operator-b-commits', '--owner', 'owner-a', '--operator', 'operator-b',
    '--repos', PRIVATE, '--operations', 'pre-commit', '--not-before', '2026-01-15T00:00:00Z', '--expires', '2026-03-01T00:00:00Z', '--out', path.join(keyDir, 'draft.json')])
  assert.equal(draft.status, 0, draft.stderr)
  const signed = cli(['boundary', 'delegation', 'sign', path.join(keyDir, 'draft.json'), ...projectArgs, '--key', path.join(keyDir, 'owner.key.json'), '--out', path.join(keyDir, 'signed.json')])
  assert.equal(signed.status, 0, signed.stderr)
  assert.match(signed.stderr, /operator operator-b may pass the actor check owned by owner-a/)
  assert.match(signed.stderr, /recognised by githubLogin op\?\[8mhidden and gitEmails operator-b@example\.invalid/)
  assert.match(signed.stderr, /policy and repository set stay sha256:[0-9a-f]{64}/)
  assert.equal(/[\u0000-\u0008\u000b-\u001f\u007f]/.test(signed.stderr), false)
  assert.equal(cli(['boundary', 'delegation', 'sign', path.join(keyDir, 'signed.json'), ...projectArgs, '--key', path.join(keyDir, 'owner.key.json')]).status, 2)
  // A draft whose bindings do not match the current project is refused before signing.
  const stale = JSON.parse(fs.readFileSync(path.join(keyDir, 'draft.json'), 'utf8'))
  writeJson(path.join(keyDir, 'stale.json'), { ...stale, policyDigest: `sha256:${'0'.repeat(64)}` })
  const refused = cli(['boundary', 'delegation', 'sign', path.join(keyDir, 'stale.json'), ...projectArgs, '--key', path.join(keyDir, 'owner.key.json')])
  assert.equal(refused.status, 2)
  assert.match(refused.stderr, /does not bind the current boundary policy/)
  const doc = JSON.parse(fs.readFileSync(path.join(keyDir, 'signed.json'), 'utf8'))
  assert.equal(doc.signature.keyId, 'owner-a-key')
  // A keys file the test account owns is never trusted, so verify reports it.
  writeJson(path.join(keyDir, 'keys.json'), keysDoc(JSON.parse(keygen.stdout)))
  const verify = cli(['boundary', 'delegation', 'verify', path.join(keyDir, 'signed.json'), '--owner-keys', path.join(keyDir, 'keys.json'), '--json'])
  assert.equal(verify.status, 1)
  const verified = JSON.parse(verify.stdout)
  assert.equal(verified.hostTrust.ok, false)
  assert.equal(verified.valid, false)
  // The check reads only the fixed host path: neither a flag nor the environment chooses the keys.
  writeJson(path.join(ws.root, 'boundary-delegations.v1.json'), delegationsDoc(doc))
  const check = cli(['boundary', 'check', '--staged', ...projectArgs, '--actor', 'operator-b', '--owner-keys', path.join(keyDir, 'keys.json'), '--json'])
  assert.equal(check.status, 1)
  const reason = JSON.parse(check.stdout).errors.find((item) => item.code === 'private-domain-actor-mismatch').details.delegationReason
  assert.ok(['delegation-owner-key-missing', 'delegation-owner-keys-untrusted'].includes(reason), reason)
  fs.writeFileSync(path.join(ws.root, 'boundary-delegations.v1.json'), 'null')
  assert.ok(JSON.parse(cli(['boundary', 'check', ...projectArgs, '--actor', 'operator-b', '--json']).stdout).errors.some((item) => item.code === 'boundary-delegations-invalid'))
  fs.writeFileSync(path.join(ws.root, 'boundary-delegations.v1.json'), '{')
  const broken = JSON.parse(cli(['boundary', 'check', ...projectArgs, '--actor', 'operator-b', '--json']).stdout)
  assert.ok(broken.errors.some((item) => item.code === 'boundary-delegations-invalid'))
})

test('T20 the boundary policy contract is not widened: delegations live in their own document', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts/atelier-boundary-policy.v1.schema.json'), 'utf8'))
  assert.equal(Object.hasOwn(schema.properties, 'delegations'), false)
  assert.match(schema.$comment, /^contract revision 1\.1\.0/)
  const policy = { ...policyDoc(), delegations: [] }
  assert.ok(validateBoundaryPolicy(policy).includes('/ must not include additional property delegations'))
})
