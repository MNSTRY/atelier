import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { canonicalJson, parseReleaseBundle } from '../src/extensions/contracts.mjs'
import { createExtensionAdminClient, createHttpHostTransport } from '../src/extensions/client.mjs'
import { exportReleaseBundle, scaffoldSqlProject, sealProject } from '../src/extensions/project.mjs'

const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
async function fixture(t,profile='postgres-sql') {
  const root=await mkdtemp(path.join(tmpdir(),'atelier-extension-bundle-')),project=path.join(root,'custom')
  t.after(()=>rm(root,{recursive:true,force:true}))
  await scaffoldSqlProject({directory:project,profile})
  return {root,project}
}
for(const profile of ['postgres-sql','drizzle-db-first','drizzle-code-first','prisma-7-postgres'])test(`${profile} registration exports sealed bytes and migration identities`,async t=>{
  const {project}=await fixture(t,profile), bundle=await exportReleaseBundle(project)
  const combined=Object.fromEntries([...Object.entries(bundle.schemaFiles).map(([name,bytes])=>[name,hash(bytes)]),...Object.entries(bundle.migrationDigests)])
  assert.equal(hash(canonicalJson(combined)),bundle.manifest.deployment.schemaDigest)
  for(const [name,bytes] of Object.entries(bundle.schemaFiles))assert.equal(await readFile(path.join(project,name),'utf8'),bytes)
  for(const [name,digest] of Object.entries(bundle.migrationDigests))assert.equal(hash(await readFile(path.join(project,name))),digest)
  assert.deepEqual(parseReleaseBundle(bundle),bundle)
  assert.ok(!Object.hasOwn(bundle,'directory'));assert.ok(!Object.hasOwn(bundle,'qualified'))
})
test('CLI emits the complete bundle without applying a migration or changing project bytes',async t=>{
  const {project}=await fixture(t),before=await readFile(path.join(project,'extension.manifest.json'))
  const cli=fileURLToPath(new URL('../bin/atelier.mjs',import.meta.url))
  const result=spawnSync(process.execPath,[cli,'extension','bundle','--directory',project,'--json'],{encoding:'utf8'})
  assert.equal(result.status,0,result.stderr)
  assert.deepEqual(JSON.parse(result.stdout),await exportReleaseBundle(project))
  assert.deepEqual(await readFile(path.join(project,'extension.manifest.json')),before)
})
test('export refuses stale or linked schema bytes without exposing their source in CLI errors',async t=>{
  const {root,project}=await fixture(t),schema=path.join(project,'schemas/counter-set-input.json')
  const original=await readFile(schema,'utf8')
  await writeFile(schema,original+'\n');await assert.rejects(exportReleaseBundle(project),/stale/)
  await sealProject(project)
  const outside=path.join(root,'outside.json');await writeFile(outside,'{"private":"invented sentinel"}')
  await rm(schema);await symlink(outside,schema)
  await assert.rejects(exportReleaseBundle(project),/symlink/)
  const cli=fileURLToPath(new URL('../bin/atelier.mjs',import.meta.url))
  const result=spawnSync(process.execPath,[cli,'extension','bundle','--directory',project,'--json'],{encoding:'utf8'})
  assert.equal(result.status,1);assert.equal(result.stdout,'')
  assert.ok(!result.stderr.includes(project));assert.ok(!result.stderr.includes('invented sentinel'))
})
test('admin registration uses the injected host once and binds its returned release identity',async t=>{
  const {project}=await fixture(t),bundle=await exportReleaseBundle(project)
  let calls=0
  const admin=createExtensionAdminClient(createHttpHostTransport(async (url,request)=>{
    calls++;assert.equal(url,'/api/root-runtime/extensions/releases');assert.equal(request.redirect,'error')
    assert.deepEqual(JSON.parse(request.body),bundle)
    return Response.json({releaseId:'release_synthetic_12345',releaseDigest:bundle.manifest.releaseDigest})
  }))
  assert.equal((await admin.registerRelease(bundle)).releaseDigest,bundle.manifest.releaseDigest);assert.equal(calls,1)
  await assert.rejects(createExtensionAdminClient({}).registerRelease(bundle),{code:'unavailable'})
  await assert.rejects(createExtensionAdminClient({registerRelease:async()=>({releaseId:'release_synthetic_12345',releaseDigest:'f'.repeat(64)})}).registerRelease(bundle))
  const malformed=structuredClone(bundle);delete malformed.schemaFiles[malformed.manifest.actions[0].inputSchemaRef]
  await assert.rejects(admin.registerRelease(malformed),{code:'invalid-input'});assert.equal(calls,1)
  let read=false
  const accessor={...bundle,get schemaFiles(){read=true;return {}}}
  assert.throws(()=>parseReleaseBundle(accessor),{code:'invalid-input'});assert.equal(read,false)
})

test('registration replies refuse accessors without reading them and retain the original requested identity',async t=>{
  const {project}=await fixture(t),bundle=await exportReleaseBundle(project)
  let reads=0
  const reply={releaseId:'release_synthetic_12345',get releaseDigest(){reads++;return bundle.manifest.releaseDigest}}
  await assert.rejects(createExtensionAdminClient({registerRelease:async()=>reply}).registerRelease(bundle),{code:'invalid-input'})
  assert.equal(reads,0)
  const changed=createExtensionAdminClient({registerRelease:async input=>{
    input.manifest.releaseDigest='f'.repeat(64)
    return {releaseId:'release_synthetic_12345',releaseDigest:input.manifest.releaseDigest}
  }})
  await assert.rejects(changed.registerRelease(bundle),{code:'unavailable'})
  assert.notEqual(bundle.manifest.releaseDigest,'f'.repeat(64))
})
test('direct authenticated HTTP registration retains the original request identity across an awaited response',async t=>{
  const {project}=await fixture(t),bundle=await exportReleaseBundle(project),digest=bundle.manifest.releaseDigest
  const transport=createHttpHostTransport(async()=>{
    bundle.manifest.releaseDigest='f'.repeat(64)
    return Response.json({releaseId:'release_synthetic_12345',releaseDigest:bundle.manifest.releaseDigest})
  })
  await assert.rejects(transport.registerRelease(bundle),{code:'unavailable'})
  assert.notEqual(digest,bundle.manifest.releaseDigest)
})
test('an additional sealed BOM schema cannot silently change bytes during bundle export',async t=>{
  const {project}=await fixture(t)
  await writeFile(path.join(project,'schemas/additional.json'),Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from('{"type":"object"}')]))
  await sealProject(project)
  await assert.rejects(exportReleaseBundle(project),/encoding changes sealed bytes/)
  await writeFile(path.join(project,'schemas/additional.json'),'{"type":"object"}\n')
  await sealProject(project)
  const bundle=await exportReleaseBundle(project)
  assert.deepEqual(Buffer.from(bundle.schemaFiles['schemas/additional.json']),await readFile(path.join(project,'schemas/additional.json')))
})
test('registration bounds HTTP reply bytes before returning a typed receipt',async t=>{
  const {project}=await fixture(t),bundle=await exportReleaseBundle(project)
  await assert.rejects(createExtensionAdminClient(createHttpHostTransport(async()=>new Response(' '.repeat(131073)))).registerRelease(bundle),{code:'unavailable'})
})
