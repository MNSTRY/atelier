import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const sha=value=>createHash('sha256').update(value).digest('hex');

// This receiving adapter calls the actual AW supplier signature after it is
// shipped. It never copies that supplier module or its examples into a consumer.
export async function checkInstalledWorkshop({pkg,root,profile,gap}){
  const binding=profile.awWorkshop;
  if(!binding||!pkg.exports[binding.exportSubpath])gap('aw-coherent-installed-entry','Foundation must first ship the received coherent AW exercise through an actual declared export. Supplier source qualification is not an installed entry.');
  const specifier=binding.exportSubpath==='.'?pkg.name:pkg.name+'/'+binding.exportSubpath.slice(2),api=await import(specifier);
  if(typeof api[binding.functionName]!=='function')gap('aw-coherent-installed-function','The actual installed export does not contain the received AW exercise function; return its exact version/entry to Foundation.');
  const exportedFile=fs.realpathSync(fileURLToPath(import.meta.resolve(specifier))),packageRoot=fs.realpathSync(path.join(root,'node_modules/@mnstry/atelier'));assert.ok(exportedFile.startsWith(packageRoot+path.sep));
  const graphAPI=await import('@mnstry/atelier/graph'),projectAPI=await import('@mnstry/atelier/project'),coauthorAPI=await import('@mnstry/atelier/coauthor/store'),rows=[];
  assert.deepEqual(binding.outcomes.slice().sort(),['revision','note','disagreement','perspective-only','pause'].sort());
  for(const outcome of binding.outcomes){
    const workspace=path.join(root,'aw-workshop-'+outcome);assert.equal(fs.existsSync(workspace),false);
    const output=await api[binding.functionName](workspace,{outcome});
    assert.equal(output.packageVersion,pkg.version);assert.equal(output.outcome,outcome);assert.equal(output.publicInventedOnly,true);assert.equal(output.participantChoice,'fixture');assert.equal(output.humanAcceptance,false);
    const actual=fs.realpathSync(workspace);assert.ok(actual.startsWith(fs.realpathSync(root)+path.sep));
    const sourceFile=fs.realpathSync(path.join(actual,'records/checklist.md'));assert.ok(sourceFile.startsWith(actual+path.sep));const sourceBytes=fs.readFileSync(sourceFile);assert.equal(sha(sourceBytes),output.sourceReadbackSha256);
    const store=coauthorAPI.createCoauthorStore({workspaceRoot:actual}),reopened=store.read('invented-workshop-'+outcome);
    if(typeof store.close==='function')store.close();
    assert.deepEqual(reopened.saved.map(s=>s.text),[output.originalWords,output.interpretation,outcome]);assert.notEqual(output.originalWords,output.interpretation);
    const independentProject=projectAPI.resolveProjectConfig({cwd:actual,argv:['--project',path.join(actual,'atelier.project.json')],env:{},writeLocalState:false}),graph=graphAPI.buildCanonicalGraph(independentProject);assert.equal(graph.ok,true);
    assert.equal(graph.nodes.length,output.afterGraph.nodes);assert.equal(graph.edges.length,output.afterGraph.edges);
    assert.equal(output.ownerCorrection,outcome==='revision');assert.equal(output.reopenedSame,true);assert.equal(output.pauseRecoveryPreserved,true);assert.equal(output.unconfirmedInterpretationSaveRefused,true);assert.equal(output.duplicateSaveNoAdditionalEffect,true);
    if(outcome==='revision'){assert.ok(sourceBytes.toString('utf8').includes('    supports: ["devday:workshop"]'));assert.ok(graph.edges.some(e=>e.source==='devday:checklist'&&e.type==='supports'&&e.target==='devday:workshop'));assert.equal(output.sourceDriftWriteRefused,true);}else assert.ok(sourceBytes.toString('utf8').includes('    supports: []'));
    // Source runner reports do not substitute for independent native UI,
    // same-check assessment and typed disposition evidence. Keep those gaps.
    rows.push({outcome,output,independent:{sourceSha256:sha(sourceBytes),reopened,graph},scope:'Actual installed fixture exercise and independent current source/coauthor/graph readback; not native UI or semantic/human acceptance'});
  }
  return {installedExport:{specifier,path:path.relative(packageRoot,exportedFile),sha256:sha(fs.readFileSync(exportedFile))},rows,fullInstalledKnowledgeHealthJourneyQualified:false,nativeTypedDispositionQualified:false,humanAcceptance:false,remaining:['Actual same-check assessment/current evidence with owner-bound typed reference','Normal shipped guided host/native caller and keyboard/recovery capture','Actual human observations'],sourceModuleInjected:false};
}
