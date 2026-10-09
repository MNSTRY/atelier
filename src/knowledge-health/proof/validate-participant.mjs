import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const [input,output]=process.argv.slice(2);assert.ok(input&&output);assert.equal(fs.existsSync(output),false,'Retain original report');
const bytes=fs.readFileSync(input),record=JSON.parse(bytes),issues=[];
assert.ok(['not-observed','observed'].includes(record.status));assert.equal(record.acceptance,'not-established');
if(record.status==='observed'){
  for(const key of ['participantCode','recordingChoice','observedAt','packageVersion','packageIntegrity','exampleSourceBeforeSha256'])if(typeof record[key]!=='string'||!record[key].trim())issues.push('Missing actual '+key);
  if(!record.evidenceRefs?.length)issues.push('No actual observation evidence references');
  if(!record.baseline?.explanation)issues.push('Baseline explanation missing');
  if(!record.understandingAfter?.explanation)issues.push('After-task explanation missing');
  if(!record.contribution?.originalWords&&!record.contribution?.reason)issues.push('Contribution or refusal reason missing');
  if(!record.usefulness?.participantWords&&!record.usefulness?.reason)issues.push('Participant usefulness judgment or non-observation reason missing');
  if(record.reassessment?.observed&&!record.reassessment?.exactReadbackEvidence)issues.push('Reassessment marked observed without exact readback evidence');
}
const report={inputSha256:createHash('sha256').update(bytes).digest('hex'),status:record.status,result:issues.length?'incomplete':'record-shape-consistent',issues,humanAcceptance:'not-established',collectorAuthenticityVerified:false};
fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});process.stdout.write(JSON.stringify(report)+'\n');if(issues.length)process.exitCode=2;
