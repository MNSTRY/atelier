import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createVaultService, preparePublication, r2PrivateStorage, vercelPrivateStorage, vaultIdentity, VAULT_TABLE_SQL, d1VaultMetadata, postgresVaultMetadata, createCloudflareVault } from '../src/vault/index.mjs'
import { digest } from '../src/vault/service.mjs'

const owner = { issuer: 'https://identity.example', subject: 'author-one' }
const publication = (expectedRevision = 0, text = '<h1>Example</h1>') => ({ schema: 'atelier-vault-publication/v1', contractVersion: '1.0.0', expectedRevision, files: [{ path: 'report.html', base64: Buffer.from(text).toString('base64') }, { path: 'assets/style.css', base64: Buffer.from('body { color: green }').toString('base64') }] })
async function fixture(provider) {
  const sql = new DatabaseSync(':memory:')
  sql.exec(VAULT_TABLE_SQL)
  sql.prepare('INSERT INTO atelier_vaults (id, owner_issuer, owner_subject) VALUES (?, ?, ?)').run('sample-vault', owner.issuer, owner.subject)
  const db = { prepare(query) { return { bind(...args) { return { async first() { return sql.prepare(query).get(...args) }, async run() { return { success: true, meta: sql.prepare(query).run(...args) } } } } } } }
  const metadata = provider === 'r2' ? d1VaultMetadata(db) : postgresVaultMetadata({
    async query(query, args) {
      const statement = sql.prepare(query.replace(/\$\d+/g, '?'))
      if (query.startsWith('SELECT')) return { rows: statement.all(...args) }
      return { rowCount: statement.run(...args).changes }
    },
  })
  const objects = new Map()
  let failPut = false
  const put = async (key, bytes) => { if (failPut) throw new Error('offline'); objects.set(key, new Uint8Array(bytes)) }
  const storage = provider === 'r2' ? r2PrivateStorage({ put, async get(key) { return objects.has(key) ? { async arrayBuffer() { return objects.get(key).slice().buffer } } : null } }) : vercelPrivateStorage({
    async put(key, bytes, options) { assert.equal(options.access, 'private'); assert.equal(options.addRandomSuffix, false); await put(key, bytes) },
    async get(key, options) { assert.equal(options.access, 'private'); assert.equal(options.useCache, false); return objects.has(key) ? { statusCode: 200, stream: new Response(objects.get(key)).body } : null },
  })
  const machineCredential = randomBytes(32).toString('base64url')
  const hash = await digest(new TextEncoder().encode(machineCredential))
  const credential = { vault: 'sample-vault', owner, revoked: false, expiresAt: Date.now() + 60000 }
  let session = owner
  const identity = vaultIdentity({ verifySession: async () => session, lookupCredential: async candidate => candidate === hash ? credential : null })
  const handle = createVaultService({ identity, metadata, storage })
  const read = (path = 'sample-vault/report.html', method = 'GET') => handle(new Request(`https://artifacts.example/${path}`, { method }))
  const publish = (body = publication(), extraHeaders = {}) => handle(new Request('https://artifacts.example/_publish/sample-vault', { method: 'POST', headers: { authorization: `Bearer ${machineCredential}`, 'content-type': 'application/json', ...extraHeaders }, body: JSON.stringify(body) }))
  return { sql, objects, metadata, credential, read, publish, setSession(value) { session = value }, fail() { failPut = true } }
}
for (const provider of ['r2', 'vercel']) {
  test(`${provider}: owner reads stable HTML and assets; anonymous and different identities refused`, async t => {
    const f = await fixture(provider); t.after(() => f.sql.close())
    assert.equal((await f.publish()).status, 201)
    const result = await f.read()
    assert.equal(result.status, 200)
    assert.equal(await result.text(), '<h1>Example</h1>')
    assert.equal(result.headers.get('cache-control'), 'private, no-store')
    assert.match(result.headers.get('content-security-policy'), /sandbox;/)
    assert.equal((await f.read('sample-vault/assets/style.css')).status, 200)
    assert.equal(await (await f.read('sample-vault/report.html', 'HEAD')).text(), '')
    f.setSession(null)
    assert.equal((await f.read()).status, 401)
    assert.equal((await f.read('sample-vault/assets/style.css')).status, 401)
    f.setSession({ ...owner, subject: 'another-author' })
    assert.equal((await f.read()).status, 404)
    f.setSession({ ...owner, issuer: 'https://other.example' })
    assert.equal((await f.read()).status, 404)
  })
  test(`${provider}: invalid paths, unlisted files and executable formats refused`, async t => {
    const f = await fixture(provider); t.after(() => f.sql.close())
    await f.publish()
    for (const path of ['sample-vault/%2Freport.html', 'sample-vault/report.html?bypass=yes']) assert.equal((await f.read(path)).status, 400)
    for (const path of ['sample-vault/missing.html', 'other-vault/report.html', 'sample-vault//report.html']) assert.equal((await f.read(path)).status, 404)
    for (const path of ['../report.html', 'a/../report.html', 'app.js', 'image.svg']) {
      const input = publication(1); input.files[0].path = path
      assert.equal((await f.publish(input)).status, 400)
    }
    const duplicate = publication(1); duplicate.files.push(duplicate.files[0])
    assert.equal((await f.publish(duplicate)).status, 400)
  })
  test(`${provider}: failed uploads and stale/concurrent publishers retain last committed version`, async t => {
    const f = await fixture(provider); t.after(() => f.sql.close())
    await f.publish()
    assert.equal((await f.publish()).status, 409)
    const results = await Promise.all([f.publish(publication(1, 'revision a')), f.publish(publication(1, 'revision b'))])
    assert.deepEqual(results.map(r => r.status).sort(), [201, 409])
    const before = await (await f.read()).text()
    f.fail()
    assert.equal((await f.publish(publication(2, 'uncommitted'))).status, 503)
    assert.equal(await (await f.read()).text(), before)
  })
  test(`${provider}: scoped credential expiry/revocation and browser publication refusal`, async t => {
    const f = await fixture(provider); t.after(() => f.sql.close())
    assert.equal((await f.publish(publication(), { origin: 'https://artifacts.example' })).status, 403)
    assert.equal((await f.publish(publication(), { cookie: 'session=example' })).status, 403)
    f.credential.vault = 'different-vault'
    assert.equal((await f.publish()).status, 401)
    f.credential.vault = 'sample-vault'; f.credential.revoked = true
    assert.equal((await f.publish()).status, 401)
    f.credential.revoked = false; f.credential.expiresAt = 0
    assert.equal((await f.publish()).status, 401)
  })
  test(`${provider}: corrupt storage fails closed and owner change blocks stale commit`, async t => {
    const f = await fixture(provider); t.after(() => f.sql.close())
    await f.publish()
    const record = await f.metadata.get('sample-vault')
    f.objects.set(`sample-vault/${record.manifest.find(x => x.path === 'report.html').sha256}`, new Uint8Array([1]))
    assert.equal((await f.read()).status, 503)
    f.sql.prepare('UPDATE atelier_vaults SET owner_subject = ?').run('new-author')
    assert.equal(await f.metadata.commit('sample-vault', { owner, expectedRevision: 1, manifest: [], publication: 'example' }), false)
  })
}
test('publication manifest determinism and byte identity', async () => {
  const input = publication()
  const first = await preparePublication(input)
  input.files.reverse()
  assert.equal((await preparePublication(input)).publication, first.publication)
  input.files[0].base64 = Buffer.from('changed').toString('base64')
  assert.notEqual((await preparePublication(input)).publication, first.publication)
})
test('missing trust adapters refuse initialization', () => {
  assert.throws(() => createVaultService({}), /Incomplete/)
})
test('publication limits, invalid revisions and malformed base64 refuse before writes', async t => {
  const f = await fixture('r2'); t.after(() => f.sql.close())
  for (const expectedRevision of [-1, 0.5, '0', null]) assert.equal((await f.publish({ ...publication(), expectedRevision })).status, 400)
  const invalid = publication(); invalid.files[0].base64 = 'invalid!'
  assert.equal((await f.publish(invalid)).status, 400)
  const large = publication(); large.files[0].base64 = 'a'.repeat(4 * 1024 * 1024)
  assert.equal((await f.publish(large)).status, 413)
  assert.equal(f.objects.size, 0)
})
test('provider errors never expose storage details', async () => {
  const handle = createVaultService({ identity: { read() { throw new Error('private provider detail') }, publish() {} }, metadata: { get() {}, commit() {} }, storage: { get() {}, put() {} } })
  const response = await handle(new Request('https://artifacts.example/sample-vault/report.html'))
  assert.equal(response.status, 503)
  assert.equal(await response.text(), '')
})
test('Cloudflare starts a primary session per request and unauthenticated reads never touch storage', async () => {
  const sessions = []
  const worker = createCloudflareVault({ verifySession: async () => null, lookupCredential: async () => null })
  const env = { VAULT_DB: { withSession(mode) { sessions.push(mode); return {} } }, VAULT_OBJECTS: { get() { throw new Error('must not read') } } }
  for (let i = 0; i < 2; i++) assert.equal((await worker.fetch(new Request('https://artifacts.example/sample-vault/report.html'), env)).status, 401)
  assert.deepEqual(sessions, ['first-primary', 'first-primary'])
})
