import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm,writeFile,mkdir,symlink,link} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {scaffoldSqlProject,sealProject,validateProject} from '../src/extensions/project.mjs'
import {withDrizzleScope,onceDrizzleOperation} from '../src/extensions/drizzle.mjs'
import {withPrismaScope,oncePrismaOperation} from '../src/extensions/prisma.mjs'

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
