import test from 'node:test'
import assert from 'node:assert/strict'
import { createGraphifyCompositionBinding } from '../../src/ingestion/optional/graphify/composition-binding.mjs'

// Invented transport shape only. This test does not authenticate these labels.
function fixture() {
  const artifact = name => ({ path: `/invented/${name}.json`, sha256: '1'.repeat(64), bytes: 12 })
  const sourceBindings = { 'invented-source': { sourceId: 'invented-source', path: 'service.py', sourceDigest: '2'.repeat(64) } }
  const receiptRef = { id: 'invented-host-step', digest: `sha256:${'3'.repeat(64)}` }
  const bridgeReceipt = { id: 'invented-host-bridge', digest: `sha256:${'4'.repeat(64)}` }
  const supplierQueryReceipt = artifact('query-receipt'), supplierReceivingReceipt = artifact('receiving'), artifactRef = artifact('native-result')
  const envelope = { provider:'graphify',generation:'invented-generation',nativeOperation:'query',hits:[],unresolved:[],
    sourceBindings,receiptRef,bridgeReceipt,receiptAssurance:'explicit-verified-existing-host-bridge',supplierQueryReceipt,supplierReceivingReceipt,artifactRef,
    usage:{bridge:{usage:null}} }
  return {operation:'receive-composition',outcome:'composition-envelope-received',generationId:'invented-generation',envelope,
    supplierQueryReceipt,supplierReceivingReceipt,compositionArtifact:artifact('composition'),receiptBridgeOriginal:{receiptRef,bridgeReceipt,usage:null},
    hostVerificationOriginal:{verified:true,current:true,binding:{provider:'graphify',generation:'invented-generation',sourceBindings,
      queryArtifact:artifactRef,queryReceiptArtifact:supplierQueryReceipt,receivingArtifact:supplierReceivingReceipt,receiptRef,bridgeReceipt,bridgeUsage:null}}}
}

test('complete invented transport shape returns detached own-data retrieve output', async () => {
  const received=fixture(), binding=createGraphifyCompositionBinding({dispatch:async()=>received})
  const result=await binding.bindings.retrieve({})
  assert.deepEqual(result,received.envelope);assert.notEqual(result,received.envelope)
  assert.equal(binding.operationRoles.retrieve,'retrieve')
})

test('missing paired descriptors cannot pass undefined equality and originals remain custody', async () => {
  const mutations=[
    x=>{delete x.supplierQueryReceipt;delete x.envelope.supplierQueryReceipt;delete x.hostVerificationOriginal.binding.queryReceiptArtifact},
    x=>{delete x.supplierReceivingReceipt;delete x.envelope.supplierReceivingReceipt;delete x.hostVerificationOriginal.binding.receivingArtifact},
    x=>{delete x.envelope.sourceBindings;delete x.hostVerificationOriginal.binding.sourceBindings},
    x=>{delete x.envelope.artifactRef;delete x.hostVerificationOriginal.binding.queryArtifact},
    x=>{delete x.compositionArtifact},
  ]
  for(const mutate of mutations){const received=fixture();mutate(received)
    await assert.rejects(createGraphifyCompositionBinding({dispatch:async()=>received}).bindings.retrieve({}),error=>{
      assert.deepEqual(error.supplierResult,received);assert.equal(error.retryAuthorized,false);return true
    })
  }
})

test('null and malformed artifact/source descriptors refuse before equality', async () => {
  for(const bad of [null,{},[],{path:'x',sha256:'not-sha256',bytes:12},{path:'x',sha256:'1'.repeat(64),bytes:-1}]){
    for(const field of ['compositionArtifact','artifactRef','supplierQueryReceipt','supplierReceivingReceipt']){
      const received=fixture()
      if(field==='compositionArtifact')received[field]=bad
      else if(field==='artifactRef'){received.envelope[field]=bad;received.hostVerificationOriginal.binding.queryArtifact=bad}
      else{received[field]=bad;received.envelope[field]=bad;received.hostVerificationOriginal.binding[field==='supplierQueryReceipt'?'queryReceiptArtifact':'receivingArtifact']=bad}
      await assert.rejects(createGraphifyCompositionBinding({dispatch:async()=>received}).bindings.retrieve({}))
    }
  }
  for(const bad of [null,[],{'source':{}},{'source':{sourceId:'other',sourceDigest:'2'.repeat(64),path:'x'}}]){
    const received=fixture();received.envelope.sourceBindings=bad;received.hostVerificationOriginal.binding.sourceBindings=bad
    await assert.rejects(createGraphifyCompositionBinding({dispatch:async()=>received}).bindings.retrieve({}))
  }
})

test('bridge usage must be present and equal to original independently verified usage', async () => {
  for(const mutate of [x=>delete x.hostVerificationOriginal.binding.bridgeUsage,x=>delete x.receiptBridgeOriginal.usage,
    x=>delete x.envelope.usage.bridge.usage,x=>{x.hostVerificationOriginal.binding.bridgeUsage={tokens:999}}]){
    const received=fixture();mutate(received)
    await assert.rejects(createGraphifyCompositionBinding({dispatch:async()=>received}).bindings.retrieve({}))
  }
})

test('ordinary dispatch failure preserves actual original receipt cause and unknown costs', async () => {
  const cause=new Error('invented host failure');cause.receipt={operation:'query',status:'failed',usage:null}
  await assert.rejects(createGraphifyCompositionBinding({dispatch:async()=>{throw cause}}).bindings.retrieve({}),error=>{
    assert.equal(error.cause,cause);assert.deepEqual(error.supplierResult,cause.receipt);return true
  })
})
