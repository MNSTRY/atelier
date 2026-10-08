import fs from 'node:fs';
import assert from 'node:assert/strict';
import {readJson,pin,run} from './common.mjs';
// Separate native receiving check; not a clean-consumer package import or a driver.
// Reuses the existing Authoring journey verifier at an exact supplied source hash.
const [bindingPath,output]=process.argv.slice(2);assert.ok(bindingPath&&output);assert.equal(fs.existsSync(output),false);
const b=readJson(bindingPath);assert.equal(pin(b.verifier.path).sha256,b.verifier.sha256);assert.equal(pin(b.capture.path).sha256,b.capture.sha256);
const capture=readJson(b.capture.path);assert.equal(capture.mode,'integrated-capture');assert.equal(capture.candidate.commit,b.candidate.commit);assert.equal(capture.candidate.tree,b.candidate.tree);assert.equal(capture.admission.installedCommit,b.candidate.commit);assert.equal(capture.admission.installedTree,b.candidate.tree);
assert.equal(capture.humanObservation.status,'not-observed','Automated rehearsal does not create human judgments');
const verifierReport=output+'.authoring-report.json';
let command,report,error;
try{command=run(process.execPath,[b.verifier.path,'--scenario',capture.scenario,'--candidate',b.candidate.commit,'--input',b.capture.path,'--report',verifierReport],{cwd:process.cwd(),accept:[0,1,2]});if(fs.existsSync(verifierReport))report=readJson(verifierReport);}catch(e){error=e.observation??{message:e.message};}
const out={binding:pin(bindingPath),verifier:b.verifier,capture:b.capture,candidate:b.candidate,package:b.package,command,error,verifierReport:report,checksConsistent:command?.status===0,productAcceptance:'not-established',humanAcceptance:'not-established',actualCollectorHonestyCertified:false};
fs.writeFileSync(output,JSON.stringify(out,null,2)+'\n',{flag:'wx'});process.stdout.write(JSON.stringify({output,checksConsistent:out.checksConsistent,productAcceptance:out.productAcceptance})+'\n');if(!out.checksConsistent)process.exitCode=2;
