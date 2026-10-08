#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {hash,readJson,pin,run,npm,files} from './common.mjs';
const [inputPath,outputPath]=process.argv.slice(2);assert.ok(inputPath&&outputPath,'Usage: node tools/rehearse.mjs EXACT_INPUT.json NEW_RESULT.json');
assert.equal(fs.existsSync(outputPath),false,'A prior result may not be overwritten');
const profile=readJson(inputPath),source=profile.source;
assert.ok(['baseline','delivery'].includes(profile.purpose));assert.equal(source.name,'@mnstry/atelier');assert.match(source.version,/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
assert.ok(['tarball','registry'].includes(source.kind));assert.match(source.integrity,/^sha512-[A-Za-z0-9+/]+={0,2}$/);
if(profile.captureTarball&&source.kind==='registry'){
  const destination=path.join(path.dirname(path.resolve(outputPath)),'tarballs'),filename=source.name.replace(/^@/,'').replace('/','-')+'-'+source.version+'.tgz';
  assert.equal(fs.existsSync(path.join(destination,filename)),false,'Retained tarball may not be overwritten; use a new result directory');
}
if(profile.purpose==='delivery'){assert.ok(profile.candidate?.commit&&profile.candidate?.tree,'Release owner candidate required');assert.match(profile.candidate.commit,/^[a-f0-9]{40}$/);assert.match(profile.candidate.tree,/^[a-f0-9]{40}$/);}
const toolHome=path.dirname(fileURLToPath(import.meta.url)),snapshot=path.resolve(outputPath)+'.harness-source';
assert.equal(fs.existsSync(snapshot),false,'A prior source snapshot may not be overwritten');fs.mkdirSync(snapshot,{recursive:true});
const harnessFiles=['rehearse.mjs','common.mjs','installed-check.mjs','native-readback.mjs','workshop-check.mjs'].map(name=>{const original=path.join(toolHome,name),retained=path.join(snapshot,name);fs.copyFileSync(original,retained);return {originalPath:original,...pin(retained)};});
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'atelier-devday-consumer-')),ownerMark=randomUUID(),observations=[];
fs.writeFileSync(path.join(root,'.devday-owner'),ownerMark);fs.mkdirSync(path.join(root,'config'));fs.mkdirSync(path.join(root,'cache'));
fs.writeFileSync(path.join(root,'config/user.npmrc'),'# Empty consumer configuration\n');fs.writeFileSync(path.join(root,'config/global.npmrc'),'# Empty consumer configuration\n');
fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'atelier-public-devday-consumer',private:true,type:'module'})+'\n');
const result={startedAt:new Date().toISOString(),input:pin(inputPath),harnessFiles,purpose:profile.purpose,source,host:{platform:process.platform,arch:process.arch,node:process.version},cacheInitiallyEmpty:files(path.join(root,'cache')).length===0,noPublisherNpmConfig:true,observations,claims:{registryInstall:false,tarballInstall:false,installedJourney:false,nativeInput:false,humanAcceptance:false,allPlatforms:false},deliveryQualified:false};
let retainedTarball=null;
try{
  let target;
  if(source.kind==='registry'){
    assert.equal(source.registry,'https://registry.npmjs.org');
    const viewed=npm(['view',source.name+'@'+source.version,'name','version','engines','bin','exports','dist','gitHead','--json'],root);observations.push({step:'registry-metadata',...viewed});
    const metadata=JSON.parse(viewed.stdout);assert.equal(metadata.name,source.name);assert.equal(metadata.version,source.version);assert.equal(metadata.dist.integrity,source.integrity);
    result.registryMetadata=metadata;result.registryMetadataSha256=hash(viewed.stdout);result.sourceIdentity={registryGitHead:metadata.gitHead??null,candidate:profile.candidate??null};
    target=source.name+'@'+source.version;
  }else{
    assert.ok(source.path);assert.match(source.sha256,/^[a-f0-9]{64}$/);target=path.resolve(path.dirname(path.resolve(inputPath)),source.path);const b=fs.readFileSync(target);assert.equal(hash(b),source.sha256);assert.equal('sha512-'+hash(b,'sha512','base64'),source.integrity);
    result.tarball=pin(target);result.sourceIdentity={candidate:profile.candidate??null};
  }
  const install=npm(['install',target,'--ignore-scripts','--no-audit','--no-fund','--save-exact','--prefer-online'],root);observations.push({step:'install',...install});
  const installedRoot=path.join(root,'node_modules/@mnstry/atelier'),installed=readJson(path.join(installedRoot,'package.json')),consumer=readJson(path.join(root,'package.json')),lock=readJson(path.join(root,'package-lock.json'));
  assert.equal(installed.name,source.name);assert.equal(installed.version,source.version);assert.equal('overrides' in consumer,false);assert.equal(lock.packages['node_modules/@mnstry/atelier'].integrity,source.integrity);
  const tree=npm(['ls','--all','--json'],root);observations.push({step:'dependency-tree',...tree});assert.equal(JSON.parse(tree.stdout).problems?.length??0,0);
  result.claims.registryInstall=source.kind==='registry';result.claims.tarballInstall=source.kind==='tarball';
  result.installation={packageJson:pin(path.join(installedRoot,'package.json')),packageLock:pin(path.join(root,'package-lock.json')),exports:installed.exports,bin:installed.bin,engines:installed.engines,files:files(installedRoot),noOverrides:true,installScriptsRun:false};
  fs.copyFileSync(path.join(snapshot,'installed-check.mjs'),path.join(root,'installed-check.mjs'));
  fs.copyFileSync(path.join(snapshot,'native-readback.mjs'),path.join(root,'native-readback.mjs'));
  fs.copyFileSync(path.join(snapshot,'workshop-check.mjs'),path.join(root,'workshop-check.mjs'));
  fs.writeFileSync(path.join(root,'profile.json'),JSON.stringify(profile)+'\n');
  const check=run(process.execPath,[path.join(root,'installed-check.mjs'),path.join(root,'profile.json')],{cwd:root,timeout:120000,accept:[0,1]});observations.push({step:'installed-check',...check});
  result.installedChecks=JSON.parse(check.stdout);
  assert.equal(check.status,0,'An actual installed check failed; see installedChecks and raw command output');
  result.claims.registryInstall=source.kind==='registry';result.claims.tarballInstall=source.kind==='tarball';
  if(profile.captureTarball&&source.kind==='registry'){
    const destination=path.join(path.dirname(path.resolve(outputPath)),'tarballs');fs.mkdirSync(destination,{recursive:true});
    const packed=npm(['pack',source.name+'@'+source.version,'--ignore-scripts','--json','--pack-destination='+destination],root);observations.push({step:'retain-published-tarball',...packed});
    const packedRow=JSON.parse(packed.stdout)[0],p=path.join(destination,packedRow.filename),b=fs.readFileSync(p);assert.equal('sha512-'+hash(b,'sha512','base64'),source.integrity);
    retainedTarball={...pin(p),integrity:source.integrity,origin:'Published registry baseline; not source-owner Dev Day candidate'};result.retainedTarball=retainedTarball;
  }
  result.deliveryQualified=profile.purpose==='delivery'&&result.installedChecks.deliveryQualified===true;
  result.result='completed-with-gaps';if(result.deliveryQualified)result.result='delivery-qualified';
}catch(error){result.result='failed';result.error={name:error.name,message:error.message,observation:error.observation??null,stack:error.stack};}
finally{
  assert.equal(fs.readFileSync(path.join(root,'.devday-owner'),'utf8'),ownerMark);fs.rmSync(root,{recursive:true});result.cleanup={root,removed:!fs.existsSync(root),scope:'Only marker-owned clean consumer and cache'};result.finishedAt=new Date().toISOString();
  fs.mkdirSync(path.dirname(path.resolve(outputPath)),{recursive:true});fs.writeFileSync(outputPath,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
}
process.stdout.write(JSON.stringify({output:path.resolve(outputPath),result:result.result,purpose:result.purpose,registryInstall:result.claims.registryInstall,tarballInstall:result.claims.tarballInstall,deliveryQualified:result.deliveryQualified,cleanup:result.cleanup,retainedTarball,error:result.error?.message??null},null,2)+'\n');
if(result.result==='failed')process.exitCode=1;
