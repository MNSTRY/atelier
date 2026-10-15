import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import { parseManifest } from '../src/extensions/contracts.mjs'
import { loadExtensionPacks } from '../src/extension-packs/loader.mjs'
import { scaffoldPostgres, sealProject, validateProject } from '../src/extensions/project.mjs'

async function directory(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'atelier-extension-project-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return { root: dir, project: path.join(dir, 'custom') }
}
test('Postgres project is complete, sealed and generates a native backend without starting it', async t => {
  const { project } = await directory(t)
  const result = await scaffoldPostgres({ directory: project })
  assert.equal(result.qualified, false)
  assert.equal((await validateProject(project)).valid, true)
  const pkg = JSON.parse(await readFile(path.join(project, 'package.json')))
  assert.equal(pkg.dependencies.postgres, '3.4.7')
  assert.equal(pkg.scripts.typecheck, 'tsc --noEmit')
  const backend = await readFile(path.join(project, 'src/backend.ts'), 'utf8')
  assert.ok(backend.includes('createRootAdmissionConsumer'))
  assert.ok(!backend.includes('.listen('))
  const manifest = JSON.parse(await readFile(path.join(project, 'extension.manifest.json')))
  const contract = JSON.parse(await readFile(new URL('../contracts/atelier-extension-manifest.v1.schema.json', import.meta.url)))
  const validate = new Ajv2020({ strict: true }).compile(contract)
  assert.equal(validate(manifest), true, JSON.stringify(validate.errors))
  assert.equal(manifest.recovery.lookupActionId, 'counter.lookup')
  assert.equal(manifest.actions.length, 5)
  assert.deepEqual(manifest.compatibility.hosts, ['web'])
})
test('an existing destination is refused without replacing its data', async t => {
  const { project } = await directory(t)
  await scaffoldPostgres({ directory: project })
  const file = path.join(project, 'README.md'); await writeFile(file, 'existing owner data')
  await assert.rejects(scaffoldPostgres({ directory: project }))
  assert.equal(await readFile(file, 'utf8'), 'existing owner data')
})
test('source changes invalidate the seal and explicit resealing preserves the edited source', async t => {
  const { project } = await directory(t)
  await scaffoldPostgres({ directory: project })
  const before = await validateProject(project)
  const file = path.join(project, 'src/backend.ts'); const source = await readFile(file, 'utf8')
  await writeFile(file, source + '\n// Reviewed synthetic edit.\n')
  await assert.rejects(validateProject(project), /stale/)
  await sealProject(project)
  assert.notEqual((await validateProject(project)).releaseDigest, before.releaseDigest)
  assert.equal(await readFile(file, 'utf8'), source + '\n// Reviewed synthetic edit.\n')
})
test('symlinked source and manifest refuse without changing their external targets', async t => {
  const { root, project } = await directory(t)
  await scaffoldPostgres({ directory: project })
  const outside = path.join(root, 'outside.json'); await writeFile(outside, 'synthetic sentinel')
  await symlink(outside, path.join(project, 'src/external.json'))
  await assert.rejects(sealProject(project), /symlink/)
  await rm(path.join(project, 'src/external.json'))
  await rm(path.join(project, 'extension.manifest.json'))
  await symlink(outside, path.join(project, 'extension.manifest.json'))
  await assert.rejects(sealProject(project), /regular/)
  assert.equal(await readFile(outside, 'utf8'), 'synthetic sentinel')
})
test('CLI resolves the real extension command and keeps failures content-free', async t => {
  const { project } = await directory(t)
  const cli = fileURLToPath(new URL('../bin/atelier.mjs', import.meta.url))
  const run = args => spawnSync(process.execPath, [cli, 'extension', ...args], { encoding: 'utf8' })
  const created = run(['init', '--directory', project, '--id', 'sample.counter', '--json'])
  assert.equal(created.status, 0, created.stderr)
  assert.equal(JSON.parse(created.stdout).profile, 'postgres-sql')
  assert.equal(run(['validate', '--directory', project, '--json']).status, 0)
  const refused = run(['init', '--directory', project, '--profile', 'convex-native'])
  assert.equal(refused.status, 1)
  assert.ok(!refused.stderr.includes(project))
})


test('published manifest schema rejects all expressible runtime-invalid cases', async t => {
  const { project } = await directory(t); await scaffoldPostgres({ directory:project })
  const valid = JSON.parse(await readFile(path.join(project,'extension.manifest.json')))
  const schema = JSON.parse(await readFile(new URL('../contracts/atelier-extension-manifest.v1.schema.json',import.meta.url)))
  const validate = new Ajv2020({strict:true}).compile(schema)
  for (const change of [m => m.releaseVersion='not-semver',m => m.releaseVersion='01.0.0',m => m.releaseVersion='1.0.0-01',
    m => m.actions[0].id='extension.disable',m => m.actions[0].id='lifecycle.enable',
    m => m.actions[0].inputSchemaRef='../input.json',m => m.permissions.rootReads=['bad\u0000scope'],
    m => m.data.classes=['bad\u001fscope'],m => m.actions.push({...m.actions[0]})]) {
    const invalid = structuredClone(valid);change(invalid)
    assert.throws(() => parseManifest(invalid));assert.equal(validate(invalid),false,JSON.stringify(invalid))
  }
  for (const change of [m => m.actions[1].id=m.actions[0].id,m => m.recovery.lookupActionId='counter.set',
    m => m.surfaces=[{id:'sample.panel',compositionDigest:'a'.repeat(64),actionIds:['unknown.action']}],
    m => m.data.readableSchemaVersions=['other']]) {
    const invalid=structuredClone(valid);change(invalid);assert.throws(()=>parseManifest(invalid))
  }
})


test('reserved extension containers remain empty and optional contract version binds major one', async t => {
  const {project}=await directory(t);await scaffoldPostgres({directory:project})
  const manifest=JSON.parse(await readFile(path.join(project,'extension.manifest.json')))
  const schema=JSON.parse(await readFile(new URL('../contracts/atelier-extension-manifest.v1.schema.json',import.meta.url)))
  const validate=new Ajv2020({strict:true}).compile(schema)
  manifest.contractVersion='1.0.0';manifest.ext={};manifest.actions[0].ext={};manifest.data.ext={}
  manifest.permissions.ext={};manifest.compatibility.ext={};manifest.deployment.ext={};manifest.recovery.ext={}
  assert.equal(validate(manifest),true);assert.deepEqual(parseManifest(manifest),manifest)
  for(const change of [m=>m.ext={authority:true},m=>m.actions[0].ext={authority:true},m=>m.contractVersion='2.0.0',m=>m.contractVersion='1.bad']) {
    const invalid=structuredClone(manifest);change(invalid);assert.equal(validate(invalid),false);assert.throws(()=>parseManifest(invalid))
  }
})


test('generated runtime component reuses the existing non-executing pack identity and loader', async t => {
  const {project}=await directory(t);await scaffoldPostgres({directory:project})
  const file=path.join(project,'atelier.extension-pack.json');const pack=JSON.parse(await readFile(file))
  assert.equal(pack.schema,'mnstry-atelier-extension-pack@v1');assert.equal(pack.id,'sample.counter')
  const loaded=loadExtensionPacks({configDir:project,config:{ext:{'mnstry.atelier':{extensionPacks:[{id:pack.id,version:pack.version,path:'atelier.extension-pack.json',enabled:true}]}}}},{verifyLock:false})
  assert.equal(loaded.packs.length,1);assert.equal(loaded.protocols.length,0)
  assert.equal((await validateProject(project)).packAdoption,'pending')
  pack.ext['mnstry.atelier'].runtimeManifest.releaseDigest='f'.repeat(64)
  pack.terms.push({id:'sample.counter:custom',label:'Invented custom concept',kind:'concept'})
  await writeFile(file,JSON.stringify(pack));await assert.rejects(validateProject(project),/stale/)
  await sealProject(project);assert.equal((await validateProject(project)).valid,true)
  assert.equal(JSON.parse(await readFile(file)).terms[0].id,'sample.counter:custom')
})


test('schema and runtime measure manifest string limits in Unicode code points', async t => {
  const {project}=await directory(t);await scaffoldPostgres({directory:project})
  const base=JSON.parse(await readFile(path.join(project,'extension.manifest.json')))
  const schema=JSON.parse(await readFile(new URL('../contracts/atelier-extension-manifest.v1.schema.json',import.meta.url)))
  const validate=new Ajv2020({strict:true}).compile(schema)
  for (const [limit,assign] of [
    [256,(m,v)=>{m.data.classes=[v]}],
    [256,(m,v)=>{m.compatibility.rootContracts=[v]}],
    ...['rootReads','rootWrites','egress'].map(key=>[256,(m,v)=>{m.permissions[key]=[v]}]),
    [128,(m,v)=>{m.data.schemaVersion=v;m.data.readableSchemaVersions=[v]}],
    [256,(m,v)=>{m.data.readableSchemaVersions.push(v)}],
  ]) {
    const valid=structuredClone(base);assign(valid,'😀'.repeat(limit))
    assert.equal(validate(valid),true,JSON.stringify(validate.errors));assert.deepEqual(parseManifest(valid),valid)
    const invalid=structuredClone(base);assign(invalid,'😀'.repeat(limit+1))
    assert.equal(validate(invalid),false);assert.throws(()=>parseManifest(invalid))
  }
})


test('seals include compiler configuration and present dependency lockfiles', async t=>{
  const {project}=await directory(t);await scaffoldPostgres({directory:project})
  const file=path.join(project,'tsconfig.json');const original=await readFile(file,'utf8')
  await writeFile(file,original+'\n');await assert.rejects(validateProject(project),/stale/)
  await sealProject(project);await validateProject(project)
  await writeFile(path.join(project,'package-lock.json'),'{}\n')
  await assert.rejects(validateProject(project),/stale/);await sealProject(project);await validateProject(project)
  await writeFile(path.join(project,'package-lock.json'),'{"lockfileVersion":3}\n')
  await assert.rejects(validateProject(project),/stale/)
})

test('deterministic pack failures leave the prior manifest bytes intact', async t=>{
  const {root,project}=await directory(t);await scaffoldPostgres({directory:project})
  const manifest=path.join(project,'extension.manifest.json');const before=await readFile(manifest,'utf8')
  const backend=path.join(project,'src/backend.ts');await writeFile(backend,(await readFile(backend,'utf8'))+'\n// owned edit\n')
  const file=path.join(project,'atelier.extension-pack.json');const pack=JSON.parse(await readFile(file))
  pack.id='another.component';await writeFile(file,JSON.stringify(pack))
  await assert.rejects(sealProject(project));assert.equal(await readFile(manifest,'utf8'),before)
  await rm(file);await assert.rejects(sealProject(project));assert.equal(await readFile(manifest,'utf8'),before)
  const external=path.join(root,'external.json');await writeFile(external,'{}');await symlink(external,file)
  await assert.rejects(sealProject(project));assert.equal(await readFile(manifest,'utf8'),before)
})
