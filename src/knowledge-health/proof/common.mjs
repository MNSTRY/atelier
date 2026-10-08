import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
export const hash=(value,algorithm='sha256',format='hex')=>createHash(algorithm).update(value).digest(format);
export const readJson=p=>JSON.parse(fs.readFileSync(p,'utf8'));
export function pin(p){const b=fs.readFileSync(p);return {path:path.resolve(p),sha256:hash(b),bytes:b.length};}
export function cleanEnvironment(){
  const allowed=['PATH','TMPDIR','TMP','TEMP','LANG','LC_ALL','SystemRoot','COMSPEC'];
  const env=Object.fromEntries(allowed.filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
  return {...env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'};
}
export function run(command,args,{cwd,env=cleanEnvironment(),input,timeout=120000,accept=[0]}={}){
  const out=spawnSync(command,args,{cwd,env,input,encoding:'utf8',timeout,maxBuffer:4*1024*1024});
  const observation={command:path.basename(command),args,status:out.status,signal:out.signal,stdout:out.stdout??'',stderr:out.stderr??'',error:out.error?{code:out.error.code,message:out.error.message}:null};
  if(!accept.includes(out.status)){const e=Error('Consumer command failed: '+path.basename(command)+' '+args.join(' '));e.observation=observation;throw e;}
  return observation;
}
export function npm(args,root,extra={}){
  assert.notEqual(process.platform,'win32','This harness has not been qualified on Windows');
  return run('npm',[...args,'--registry=https://registry.npmjs.org','--userconfig='+path.join(root,'config/user.npmrc'),'--globalconfig='+path.join(root,'config/global.npmrc'),'--cache='+path.join(root,'cache'),'--fetch-retries=0','--fetch-timeout=20000'],{cwd:root,...extra});
}
export function files(root){const out=[];function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(e.isDirectory())walk(path.join(dir,e.name));else if(e.isFile())out.push(path.relative(root,path.join(dir,e.name)).replaceAll(path.sep,'/'));}}walk(root);return out.sort();}
