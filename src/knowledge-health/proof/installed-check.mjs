import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {verifyNativeReadback} from './native-readback.mjs';
import {checkInstalledWorkshop} from './workshop-check.mjs';
const root=process.cwd(),packageRoot=path.join(root,'node_modules/@mnstry/atelier'),pkg=JSON.parse(fs.readFileSync(path.join(packageRoot,'package.json'),'utf8')),profile=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const digest=b=>createHash('sha256').update(b).digest('hex'),cases=[],commands=[],gaps=[];
function cli(args,{cwd=root,input,accept=[0]}={}){
  const bin=typeof pkg.bin==='string'?pkg.bin:pkg.bin.atelier;assert.ok(bin,'Declared atelier bin required');const full=path.resolve(packageRoot,bin);assert.ok(full.startsWith(packageRoot+path.sep));
  const o=spawnSync(process.execPath,[full,...args],{cwd,input,encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024});const observed={args,status:o.status,signal:o.signal,stdout:o.stdout??'',stderr:o.stderr??''};commands.push(observed);assert.ok(accept.includes(o.status),JSON.stringify(observed));return observed;
}
function gap(id,action){const e=Error(action);e.actionableGap=true;e.gap={id,owner:'Foundation through Reliability and existing KH/AW source owners',action};throw e;}
async function scenario(id,fn){if(profile.onlyChecks&&!profile.onlyChecks.includes(id))return;try{cases.push({id,status:'passed',observations:await fn()});}catch(e){if(e.actionableGap){gaps.push(e.gap);cases.push({id,status:'actionable-gap',gap:e.gap});}else cases.push({id,status:'failed',error:{name:e.name,message:e.message,stack:e.stack}});}}
await scenario('declared-exports',async()=>{
  const resolved=[];
  for(const [subpath] of Object.entries(pkg.exports)){
    if(subpath.includes('*')){gaps.push({id:'wildcard-export-enumeration',owner:'Foundation',action:'Provide exact wildcard sample subpaths in release receiving'});continue;}
    const specifier=subpath==='.'?pkg.name:pkg.name+'/'+subpath.slice(2),url=import.meta.resolve(specifier),file=fileURLToPath(url);assert.ok(fs.realpathSync(file).startsWith(fs.realpathSync(packageRoot)+path.sep));
    const b=fs.readFileSync(file);if(file.endsWith('.json'))JSON.parse(b);else await import(specifier);resolved.push({specifier,relativePath:path.relative(packageRoot,file),sha256:digest(b)});
  }
  return {resolved,count:resolved.length};
});
await scenario('declared-bin-and-help',async()=>{assert.equal(cli(['--version']).stdout.trim(),pkg.version);return {version:pkg.version,help:cli(['--help']).stdout};});
await scenario('public-quickstart',async()=>{
  assert.equal(process.platform,'darwin','The published shell sequence is qualified here only on macOS');
  const bin=path.join(root,'node_modules/.bin/atelier');assert.equal(fs.realpathSync(bin),fs.realpathSync(path.resolve(packageRoot,pkg.bin.atelier)));
  const shellBin=(args,cwd=root)=>{const o=spawnSync(bin,args,{cwd,encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024});const observed={invocation:'installed npm bin symlink',args,status:o.status,signal:o.signal,stdout:o.stdout??'',stderr:o.stderr??''};commands.push(observed);assert.equal(o.status,0,JSON.stringify(observed));return observed;};
  assert.equal(shellBin(['--version']).stdout.trim(),pkg.version);
  const init=shellBin(['init','--template','sample-workspace','--target','example']),workspace=path.join(root,'example');
  return {init,graph:shellBin(['graph'],workspace),project:shellBin(['project'],workspace),scope:'Exact macOS public quickstart command sequence, supported baseline only'};
});
await scenario('installed-document-references',async()=>{
  const references=['README.md','docs/knowledge-graph.md','docs/coauthor-session.md'];
  const documents=references.map(relativePath=>{const file=fs.realpathSync(path.join(packageRoot,relativePath));assert.ok(file.startsWith(fs.realpathSync(packageRoot)+path.sep));const bytes=fs.readFileSync(file);return {relativePath,bytes:bytes.length,sha256:digest(bytes)};});
  for(const subpath of ['./graph','./project','./coauthor']){assert.ok(pkg.exports[subpath]);await import(pkg.name+'/'+subpath.slice(2));}
  return {documents,apiReferences:['@mnstry/atelier/graph','@mnstry/atelier/project','@mnstry/atelier/coauthor'],scope:'Public quickstart references resolve in the actual installed package'};
});
await scenario('public-export-fixture',async()=>{const api=await import('@mnstry/atelier'),file=fileURLToPath(import.meta.resolve('@mnstry/atelier/fixtures/atelier-export/sample-studio-offer.v1.json')),value=JSON.parse(fs.readFileSync(file));const report=api.validateAtelierExportDryRun(value);assert.equal(report.accepted,true);assert.equal(report.importable,false);return {fixturePath:path.relative(packageRoot,file),report};});
await scenario('installed-coauthor-save-reopen-and-drift',async()=>{
  // Reuses the established Foundation coauthor consumer smoke's CLI sequence,
  // with only the declared bin and public invented consumer source.
  const workspace=path.join(root,'coauthor-example');fs.mkdirSync(workspace);assert.equal(spawnSync('git',['init','--quiet',workspace]).status,0);fs.writeFileSync(path.join(workspace,'.gitignore'),'.atelier-local/\n');
  const source='An invented authoring packet.\n',sourceFile=path.join(workspace,'packet.md');fs.writeFileSync(sourceFile,source);
  const good=(op,input)=>JSON.parse(cli(['coauthor',op],{cwd:workspace,input:JSON.stringify(input)}).stdout).state;
  const config={id:'public-devday-baseline',fields:[{id:'example-answer',source:{ref:'packet.md',digest:digest(source)}}]};
  const initial=good('start',{config}),answer=good('event',{sessionId:config.id,event:{id:'original-answer',expectedRevision:0,type:'answer',text:'Fixture participant: please preserve these original words.'}}),saved=good('event',{sessionId:config.id,event:{id:'save-original',expectedRevision:1,type:'save'}});assert.equal(saved.phase,'saved');
  const reopened=good('read',{sessionId:config.id});assert.deepEqual(reopened,saved);assert.equal(fs.readFileSync(sourceFile,'utf8'),source);
  const stale=cli(['coauthor','event'],{cwd:workspace,input:JSON.stringify({sessionId:config.id,event:{id:'stale',expectedRevision:0,type:'advance'}}),accept:[1]});
  fs.writeFileSync(sourceFile,'Fixture revised source.\n');const drift=cli(['coauthor','event'],{cwd:workspace,input:JSON.stringify({sessionId:config.id,event:{id:'drift',expectedRevision:saved.revision,type:'advance'}}),accept:[1]});assert.deepEqual(good('read',{sessionId:config.id}),saved);
  return {initial,answer,saved,reopened,stale,drift,sourceOwnerApplication:false,nativeWorkbench:false};
});
await scenario('installed-knowledge-example-and-agent-output',async()=>{
  if(!pkg.exports['./knowledge']||!profile.knowledgeExample)gap('installed-knowledge-health-example','Published package lacks the required declared knowledge API or source-owner-bound normal example entry. Supply exact Dev Day release and knowledgeExample template/command bindings.');
  const workspace=path.join(root,'knowledge-example'),init=cli(['init','--template',profile.knowledgeExample.template,'--target',workspace]);
  const binding=profile.knowledgeExample;
  for(const key of ['graphArgs','checkArgs','contextArgs'])assert.ok(Array.isArray(binding[key])&&binding[key].length,'Source owner must bind actual installed CLI arguments: '+key);
  const graph=cli(binding.graphArgs,{cwd:workspace}),check=cli(binding.checkArgs,{cwd:workspace}),context=cli(binding.contextArgs,{cwd:workspace});
  // Results are raw real package observations. Semantic applicability and human
  // understanding are not inferred from successful subprocess exits.
  assert.ok(graph.stdout.length+graph.stderr.length>0);assert.ok(check.stdout.length+check.stderr.length>0);assert.ok(context.stdout.length+context.stderr.length>0);
  return {init,graph,check,context,scope:'Actual published invented template and installed CLI; raw statuses retained, no Dev Day guided-journey pass inferred.'};
});
await scenario('installed-public-graph-project-baseline',async()=>{
  const workspace=path.join(root,'public-graph-example'),init=cli(['init','--template','sample-workspace','--target',workspace]);
  const graphCommand=cli(['graph'],{cwd:workspace}),projectCommand=cli(['project'],{cwd:workspace});
  const graphApi=await import('@mnstry/atelier/graph'),projectApi=await import('@mnstry/atelier/project');
  if(typeof graphApi.buildCanonicalGraph!=='function'||typeof projectApi.resolveProjectConfig!=='function')gap('graph-agent-api-binding','Source owner must bind actual declared graph/project API names for this version.');
  const project=projectApi.resolveProjectConfig({cwd:workspace,argv:['--project',path.join(workspace,'atelier.project.json')]}),graph=graphApi.buildCanonicalGraph(project);
  assert.ok(Array.isArray(graph.nodes));assert.ok(Array.isArray(graph.edges));assert.ok(Array.isArray(graph.errors));assert.equal(graph.errors.length,0);
  return {init,graphCommand,projectCommand,graph,agentCIOutput:'Actual machine-readable canonical graph; structural evidence only, no model/provider or semantic acceptance.'};
});
const docs=[];for(const candidate of ['README.md','docs/knowledge.md','docs/coauthor.md','docs/coauthor-session.md','docs/upgrade.md','docs/graph.md','docs/knowledge-graph.md','docs/release-engineering.md']){const full=path.join(packageRoot,candidate);if(fs.existsSync(full)){const b=fs.readFileSync(full);docs.push({path:candidate,sha256:digest(b),bytes:b.length});}}
for(const id of ['assessment-to-guided-authoring','full-native-finding-reference','preview-owning-source-correction-readback-reassessment','keyboard-focus-undo','native-withdrawal-recovery','participant-usefulness'])gaps.push({id,owner:id==='participant-usefulness'?'Facilitator/participant':'Foundation and existing AW Integration/Journey',action:'Receive exact public Dev Day installed entry/bindings and native allocation; inherited native or fixture proof cannot satisfy installed or human evidence.'});
const bindings=profile.deliveryBindings;
if(bindings){
  await scenario('owner-installed-journey',async()=>{
    assert.ok(pkg.exports[bindings.exportSubpath],'Journey must use a declared package export');const specifier=bindings.exportSubpath==='.'?pkg.name:pkg.name+'/'+bindings.exportSubpath.slice(2),api=await import(specifier);assert.equal(typeof api[bindings.functionName],'function');
    const output=await api[bindings.functionName]({...bindings.publicInput,consumerRoot:root,publicInventedOnly:true,participantAssertions:'fixture'});
    assert.equal(output.packageVersion,pkg.version);assert.ok(Array.isArray(output.steps));
    const required=['assessment','evidence-orientation','original-contribution','interpretation-disagreement-perspective-pause','preview','owner-correction','exact-readback','reopen-reassessment'];
    for(const id of required){const step=output.steps.find(s=>s.id===id);assert.ok(step,'Missing installed step '+id);assert.equal(step.status,'passed');assert.ok(step.evidence,'Independent command/readback evidence required for '+id);}
    assert.equal(output.humanAcceptance,false);
    if(!bindings.nativeExportSubpath||!pkg.exports[bindings.nativeExportSubpath])gap('installed-native-draft-export','Source owner must expose the actual received native Drafts API as a declared export for independent readback.');
    const nativeSpecifier=bindings.nativeExportSubpath==='.'?pkg.name:pkg.name+'/'+bindings.nativeExportSubpath.slice(2),draft=await import(nativeSpecifier);
    const nativeReadback=verifyNativeReadback(draft,output.nativeCapture,root);
    if(!bindings.reassessmentExportSubpath||!pkg.exports[bindings.reassessmentExportSubpath])gap('independent-installed-reassessment','Source owner must bind an actual declared reassessment export for independent current-source evaluation.');
    const reassessmentSpecifier=bindings.reassessmentExportSubpath==='.'?pkg.name:pkg.name+'/'+bindings.reassessmentExportSubpath.slice(2),assessor=await import(reassessmentSpecifier);assert.equal(typeof assessor[bindings.reassessmentFunctionName],'function');
    const reassessed=await assessor[bindings.reassessmentFunctionName]({...bindings.publicInput,consumerRoot:root,workspaceRelative:output.nativeCapture.workspaceRelative,publicInventedOnly:true});
    assert.deepEqual(reassessed,output.reassessment);assert.equal(reassessed.currency,'current');
    return {output,nativeReadback,independentReassessment:reassessed,scope:'Installed runner plus independent native API/file readback and reassessment; rendered collector/verifier and human protocol remain separate'};
  });
}
await scenario('aw-installed-workshop',()=>checkInstalledWorkshop({pkg,root,profile,gap}));
const deliveryQualified=false; // Never promote an installed runner's own claims to native/human acceptance.
const installedMachineJourneyQualified=cases.some(c=>c.id==='owner-installed-journey'&&c.status==='passed');
process.stdout.write(JSON.stringify({package:{name:pkg.name,version:pkg.version},selectedChecks:profile.onlyChecks??'all',cases,commands,docs,gaps,counts:{passed:cases.filter(c=>c.status==='passed').length,failed:cases.filter(c=>c.status==='failed').length,actionableGaps:cases.filter(c=>c.status==='actionable-gap').length},installedMachineJourneyQualified,deliveryQualified,humanAcceptance:false,nativeCaptureRequired:true,ownerBindingsSupplied:!!bindings})+'\n');
if(cases.some(c=>c.status==='failed'))process.exitCode=1;
