import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
// These are the already received Drafts v1 command/v2 disposition identities.
// The release owner must expose the actual native supplier as a declared export.
// This verifier adds no store, model, application route or accepted canonical.
export function verifyNativeReadback(draft,capture,consumerRoot){
  assert.equal(draft.DISPOSITION_VERSION,'authoring-workbench.contribution-disposition/v2');
  assert.ok(capture&&capture.workspaceRelative&&capture.sourceRelative);
  assert.equal(path.isAbsolute(capture.workspaceRelative),false);assert.equal(path.isAbsolute(capture.sourceRelative),false);
  const root=fs.realpathSync(path.resolve(consumerRoot,capture.workspaceRelative));assert.ok(root.startsWith(fs.realpathSync(consumerRoot)+path.sep));
  const source=fs.realpathSync(path.resolve(root,capture.sourceRelative));assert.ok(source.startsWith(root+path.sep));
  const q=capture.contribution,record=capture.disposition;assert.deepEqual(record.contribution,q);assert.equal(record.schema,draft.DISPOSITION_VERSION);
  assert.deepEqual(Object.keys(record.context.findingReference).sort(),['id','checkId','checkVersion','planSha256','readSetSha256','comparisonSha256'].sort());
  const store=draft.createDraftStore({workspaceRoot:root,storeId:q.binding.storeId,actorBindingId:q.binding.actorBindingId,sourceReader:()=>({revision:capture.currentSourceRevision,digest:sha(fs.readFileSync(source))})});
  try{
    const original=store.readContribution(q.binding,q.id,q.revision),context=store.lookupDisposition(q.binding,record.id);
    assert.deepEqual(original.contribution,q);assert.equal(context.status,'committed');assert.deepEqual(context.readback.record,record);
    assert.equal(context.receipt.recordDigest,draft.commandDigest(record));assert.equal(context.receipt.contributionDigest,draft.commandDigest(q));assert.deepEqual(context.receipt.binding,q.binding);
    assert.equal(context.readback.findingReferenceCoverage,'supplied-fingerprints');assert.deepEqual(context.readback.contributionReadback,original);
    assert.equal(original.ledgerReadback.actor,q.binding.actorBindingId);assert.deepEqual(original.ledgerReadback.record,q);assert.notEqual(original.ledgerReadback.eventId,context.receipt.eventId);
    assert.equal(original.draftReadback.draftRevision,q.draftRevision);assert.equal(original.draftReadback.value.digest,q.valueDigest);assert.equal(sha(original.draftReadback.value.text),q.valueDigest);assert.deepEqual(original.draftReadback.sourceBase,q.sourceBase);
    const saves=[];
    for(const operation of capture.operations??[]){
      const command=operation.command,found=store.lookupOperation(q.binding,command.operationId);assert.equal(found.status,'committed');
      assert.equal(found.receipt.commandDigest,draft.commandDigest(command));assert.equal(found.receipt.operationId,command.operationId);assert.equal(found.receipt.previousDraftRevision,command.expectedDraftRevision);assert.deepEqual(found.receipt.editor,command.editor);assert.deepEqual(found.receipt.sourceBase,command.sourceBase);
      const readback=store.readRevision(q.binding,found.receipt.draftRevision);assert.equal(readback.value.text,command.value.text);assert.equal(readback.value.digest,sha(command.value.text));assert.equal(found.receipt.valueDigest,readback.value.digest);saves.push({command,found,readback});
    }
    assert.ok(saves.length,'Actual installed draft operation and independent original-ID readback required');
    assert.ok(capture.sourceApply?.owningRoute,'Existing source-owning route must be identified');assert.equal(capture.sourceApply.participantAssertion,'fixture');assert.equal(sha(fs.readFileSync(source)),capture.sourceApply.afterSha256);
    assert.equal(sha(capture.sourceApply.beforeBytes),capture.sourceApply.beforeSha256);assert.notEqual(capture.sourceApply.beforeSha256,capture.sourceApply.afterSha256);
    assert.equal(capture.sourceApply.beforeSha256,q.sourceBase.digest);
    return {result:'native-readback-consistent',original,context,saves,actualCurrentSourceSha256:sha(fs.readFileSync(source)),owningRoute:capture.sourceApply.owningRoute,scope:'Independent installed native API/file readback on this disposable consumer; does not certify rendered input, source applicability or participant acceptance.',humanAcceptance:false};
  }finally{store.close();}
}
