import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm,writeFile,mkdir,symlink,link} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {generateKeyPairSync,sign} from 'node:crypto'
import {canonicalJson} from '../src/extensions/contracts.mjs'
import {createExtensionHandler,defineAction,defineExtension,digest,releaseDigest} from '../src/extensions/server.mjs'
import {scaffoldSqlProject,sealProject,validateProject} from '../src/extensions/project.mjs'
import {withDrizzleScope,onceDrizzleOperation,lookupDrizzleOperation} from '../src/extensions/drizzle.mjs'
import {withPrismaScope,oncePrismaOperation,lookupPrismaOperation} from '../src/extensions/prisma.mjs'

test('all native SQL profiles generate and validate offline without optional dependencies',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'atelier-sql-profile-'));t.after(()=>rm(root,{recursive:true,force:true}))
  for(const profile of ['drizzle-db-first','drizzle-code-first','prisma-7-postgres']){
    const directory=path.join(root,profile);await scaffoldSqlProject({directory,profile})
    assert.equal((await validateProject(directory)).profile,profile)
    const pkg=JSON.parse(await readFile(path.join(directory,'package.json')))
    const backend=await readFile(path.join(directory,'src/backend.ts'),'utf8')
    assert.ok(backend.includes(profile.startsWith('drizzle')?'@mnstry/atelier/extensions/drizzle':'@mnstry/atelier/extensions/prisma'))
    if(profile.startsWith('drizzle'))assert.equal(pkg.dependencies['drizzle-orm'],'0.44.5')
    else assert.equal(pkg.dependencies['@prisma/client'],'7.10.0')
    assert.equal(pkg.dependencies['@mnstry/atelier'],'0.2.0-alpha.15')
  }
})

test('ORM adapters refuse fabricated effect scopes before opening transactions',async()=>{
  let calls=0
  const db={transaction:async()=>{calls++;throw new Error('unreachable')},$transaction:async()=>{calls++;throw new Error('unreachable')}}
  for(const run of [()=>withDrizzleScope(db,{},()=>{},async()=>null),()=>onceDrizzleOperation(db,{},null,()=>{},async()=>null),
    ()=>withPrismaScope(db,{},async()=>null),()=>oncePrismaOperation(db,{},null,async()=>null)]) {
    await assert.rejects(async()=>run(),error=>error.code==='unauthorized')
  }
  assert.equal(calls,0)
})


test('each ORM profile seals custom native configuration inputs declared in package files',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'atelier-sql-inputs-'));t.after(()=>rm(root,{recursive:true,force:true}))
  for(const profile of ['drizzle-db-first','drizzle-code-first','prisma-7-postgres']){
    const directory=path.join(root,profile);await scaffoldSqlProject({directory,profile})
    const file=path.join(directory,'package.json');const pkg=JSON.parse(await readFile(file))
    pkg.files.push('custom-native.config.mjs')
    await writeFile(file,JSON.stringify(pkg));await writeFile(path.join(directory,'custom-native.config.mjs'),'export default {}\n')
    await sealProject(directory);await validateProject(directory)
    await writeFile(path.join(directory,'custom-native.config.mjs'),'export default {changed:true}\n')
    await assert.rejects(validateProject(directory),/stale/)
  }
})

test('custom source input declarations refuse traversal, credentials and generated identity files',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'atelier-sql-input-refusal-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const directory=path.join(root,'custom');await scaffoldSqlProject({directory,profile:'prisma-7-postgres'})
  const file=path.join(directory,'package.json');const original=JSON.parse(await readFile(file))
  const manifest=await readFile(path.join(directory,'extension.manifest.json'),'utf8')
  for(const input of ['../outside','/outside','src/**/*.ts','.git','.env','node_modules','extension.manifest.json','atelier.extension-pack.json']){
    await writeFile(file,JSON.stringify({...original,files:[input]}))
    await assert.rejects(sealProject(directory),/literal project-relative/)
    assert.equal(await readFile(path.join(directory,'extension.manifest.json'),'utf8'),manifest)
  }
})


test('declared file and directory inputs refuse a symlinked ancestor before rewriting identity',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'atelier-input-parent-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const directory=path.join(root,'custom');await scaffoldSqlProject({directory,profile:'drizzle-db-first'})
  const outside=path.join(root,'invented-outside');await mkdir(path.join(outside,'sub'),{recursive:true})
  await writeFile(path.join(outside,'sub','source.json'),'{}')
  await symlink(outside,path.join(directory,'cfg'),process.platform==='win32'?'junction':'dir')
  const file=path.join(directory,'package.json');const pkg=JSON.parse(await readFile(file))
  const before=await readFile(path.join(directory,'extension.manifest.json'),'utf8')
  for(const input of ['cfg/sub/source.json','cfg/sub']){
    await writeFile(file,JSON.stringify({...pkg,files:[input]}))
    await assert.rejects(sealProject(directory),/symlinks/)
    assert.equal(await readFile(path.join(directory,'extension.manifest.json'),'utf8'),before)
  }
})

test('identity case aliases, hardlink aliases and nested credential/dependency paths refuse portably',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'atelier-input-alias-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const directory=path.join(root,'custom');await scaffoldSqlProject({directory,profile:'prisma-7-postgres'})
  const file=path.join(directory,'package.json');const pkg=JSON.parse(await readFile(file))
  const before=await readFile(path.join(directory,'extension.manifest.json'),'utf8')
  for(const input of ['EXTENSION.MANIFEST.JSON','Atelier.Extension-Pack.json','Node_Modules','src/Node_Modules/file.js']){
    await writeFile(file,JSON.stringify({...pkg,files:[input]}));await assert.rejects(sealProject(directory))
    assert.equal(await readFile(path.join(directory,'extension.manifest.json'),'utf8'),before)
  }
  await writeFile(file,JSON.stringify(pkg))
  const alias=path.join(directory,'src','identity-copy.json');await link(path.join(directory,'extension.manifest.json'),alias)
  await assert.rejects(sealProject(directory),/identity files/);await rm(alias)
  for(const name of ['.env.local','Node_Modules']){
    const entry=path.join(directory,'src',name)
    if(name==='Node_Modules')await mkdir(entry);else await writeFile(entry,'invented fixture only')
    await assert.rejects(sealProject(directory),/hidden or dependency/);await rm(entry,{recursive:true})
    assert.equal(await readFile(path.join(directory,'extension.manifest.json'),'utf8'),before)
  }
})


test('source identity refuses literal backslashes, controls and overlapping input keys',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'atelier-input-literal-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const directory=path.join(root,'custom');await scaffoldSqlProject({directory,profile:'drizzle-code-first'})
  const manifest=path.join(directory,'extension.manifest.json');const before=await readFile(manifest,'utf8')
  await mkdir(path.join(directory,'src','x'));await writeFile(path.join(directory,'src','x','y.ts'),'export const y=1')
  if(process.platform!=='win32')for(const name of ['x\\y.ts','control\n.ts']){
    const entry=path.join(directory,'src',name);await writeFile(entry,'export const other=2')
    await assert.rejects(sealProject(directory),/filename/);await assert.rejects(validateProject(directory),/filename/)
    assert.equal(await readFile(manifest,'utf8'),before);await rm(entry)
  }
  const file=path.join(directory,'package.json');const pkg=JSON.parse(await readFile(file))
  await writeFile(file,JSON.stringify({...pkg,files:['src/x/y.ts']}))
  await assert.rejects(sealProject(directory),/duplicate path/)
  assert.equal(await readFile(manifest,'utf8'),before)
})

test('native SQL role checks refuse missing or transformed flags',async()=>{
  const {assertApplicationRole}=await import('../src/extensions/sql-scope.mjs')
  const safe={rolsuper:false,rolbypassrls:false,unsafe_membership:false,unsafe_tables:false}
  await assertApplicationRole(async()=>[safe])
  for(const key of Object.keys(safe))for(const value of [true,undefined,null,0]){
    await assert.rejects(assertApplicationRole(async()=>[{...safe,[key]:value}]),error=>error.code==='forbidden')
  }
  await assert.rejects(assertApplicationRole(async()=>[{rolsuper:false,rolbypassrls:false,unsafeMembership:false,unsafeTables:false}]),error=>error.code==='forbidden')
})


test('declared prototype-like top-level source names remain own digest entries',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'atelier-input-property-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const directory=path.join(root,'custom');await scaffoldSqlProject({directory,profile:'prisma-7-postgres'})
  const file=path.join(directory,'package.json');const pkg=JSON.parse(await readFile(file))
  for(const name of ['__proto__','constructor','toString','hasOwnProperty','prototype']){
    const input=path.join(directory,name);await writeFile(input,'first declared source')
    await writeFile(file,JSON.stringify({...pkg,files:[name]}));await sealProject(directory);await validateProject(directory)
    const manifest=await readFile(path.join(directory,'extension.manifest.json'),'utf8')
    await writeFile(input,'changed declared source')
    await assert.rejects(validateProject(directory),/stale/)
    assert.equal(await readFile(path.join(directory,'extension.manifest.json'),'utf8'),manifest)
    await rm(input)
  }
})


test('offline ORM ports preserve native transactions, stored results, conflicts and original lookup metadata',async t=>{
  for(const adapter of ['drizzle','prisma'])await t.test(adapter,async()=>{
    const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'})
    const manifest={schema:'mnstry.extension-manifest/v1',protocol:'mnstry.extension/v1',extensionId:'sample.counter',releaseVersion:'1.0.0',releaseDigest:'0'.repeat(64),
      deployment:{profile:adapter==='drizzle'?'drizzle-code-first':'prisma-7-postgres',bundleDigest:'a'.repeat(64),schemaDigest:'b'.repeat(64)},
      compatibility:{sdkMajor:1,rootContracts:[],hosts:['web']},permissions:{rootReads:[],rootWrites:[],egress:[]},surfaces:[],
      actions:['counter.set','counter.lookup'].map(id=>({id,effect:id==='counter.set'?'write':'read',scope:'member',timeoutMs:10000,inputSchemaRef:'schemas/input.json',outputSchemaRef:'schemas/output.json'})),
      recovery:{lookupActionId:'counter.lookup'},data:{classes:['sample.counter'],retention:'until-user-delete',exportVersion:1,schemaVersion:'1',readableSchemaVersions:['1']}}
    manifest.releaseDigest=releaseDigest(manifest)
    const original='operation_original_12345';let row,writes=0,transactions=0,serialized
    const base={iss:'https://root.synthetic.invalid',aud:'https://backend.synthetic.invalid',purpose:'extension.invoke/v1',installationId:'installation_synthetic_123',
      generation:'1',releaseDigest:manifest.releaseDigest,tenantRef:'studio_synthetic_12345',subjectRef:'subject_synthetic_12345',rootWrites:[]}
    const execute=async(parts,values)=>{
      const statement=parts.join(' ? ')
      if(statement.includes('FROM pg_roles r'))return [{rolsuper:false,rolbypassrls:false,unsafe_membership:false,unsafe_tables:false}]
      if(statement.includes('INSERT INTO extension_data.operations'))row??={operation_id:original,action_id:'counter.set',generation:'1',release_digest:manifest.releaseDigest,payload_digest:digest({value:4}),completed:false,result:null}
      if(statement.includes('UPDATE extension_data.operations')){serialized=values[0];row.completed=true;row.result=JSON.parse(serialized)}
      if(statement.includes('SELECT action_id')||statement.includes('SELECT operation_id'))return row?[{...row}]:[]
      return []
    }
    const native={execute:query=>execute(query.parts,query.values),$queryRaw:(parts,...values)=>execute(parts,values),$executeRaw:(parts,...values)=>execute(parts,values)}
    const database={transaction:async run=>{transactions++;return run(native)},$transaction:async run=>{transactions++;return run(native)}}
    const sqlTag=(parts,...values)=>({parts,values})
    const once=(scope,input,run)=>adapter==='drizzle'?onceDrizzleOperation(database,scope,input,sqlTag,run):oncePrismaOperation(database,scope,input,run)
    const lookup=(scope,id)=>adapter==='drizzle'?lookupDrizzleOperation(database,scope,sqlTag,id):lookupPrismaOperation(database,scope,id)
    const extension=defineExtension({manifest,verifier:{issuer:base.iss,audience:base.aud,installationId:base.installationId,releaseDigest:base.releaseDigest,keys:new Map([['synthetic-key',keys.publicKey]]),consume:async()=>true},actions:{
      'counter.set':defineAction({input:value=>value,output:value=>value,run:({scope},input)=>once(scope,input,async tx=>{assert.equal(tx,native);writes++;return {summary:{completed:4,total:10}}})}),
      'counter.lookup':defineAction({input:value=>value,output:value=>value,run:({scope},input)=>lookup(scope,input.operationId)})}})
    const handler=createExtensionHandler(extension)
    async function invoke(actionId,input,operationId=original){
      const now=Math.floor(Date.now()/1000);const claims={...base,actionId,operationId,payloadDigest:digest(input),jti:'invocation_synthetic_12345',iat:now,nbf:now,exp:now+60}
      const header=Buffer.from(canonicalJson({alg:'ES256',typ:'JWT',kid:'synthetic-key'})).toString('base64url');const payload=Buffer.from(canonicalJson(claims)).toString('base64url');const data=header+'.'+payload
      const delegation=data+'.'+sign('sha256',Buffer.from(data),{key:keys.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url')
      const response=await handler(new Request(base.aud,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+delegation},body:canonicalJson(input)}))
      return {status:response.status,body:await response.json()}
    }
    const first=await invoke('counter.set',{value:4});assert.equal(first.status,200);assert.equal(typeof serialized,'string');assert.deepEqual(JSON.parse(serialized),first.body.result)
    assert.deepEqual((await invoke('counter.set',{value:4})).body.result,first.body.result);assert.equal(writes,1)
    row.payload_digest='f'.repeat(64);assert.equal((await invoke('counter.set',{value:4})).status,409);assert.equal(writes,1);row.payload_digest=digest({value:4})
    const proof=await invoke('counter.lookup',{operationId:original},'operation_lookup_1234567')
    assert.equal(proof.status,200);assert.equal(proof.body.result.operationId,original);assert.equal(proof.body.result.actionId,'counter.set');assert.equal(proof.body.result.payloadDigest,digest({value:4}));assert.deepEqual(proof.body.result.result,first.body.result)
    assert.equal(transactions,4)
  })
})
