import test from 'node:test'
import assert from 'node:assert/strict'
import { compileRoute, composeEvidence, createComposition } from '../../src/ingestion/optional/composition/index.mjs'
import { PRESENCE_PROFILES } from '../../src/ingestion/optional/evaluation/index.mjs'
const ref = { sourceId: 'invented-source', revision: 'r1', representationId: 'text-v1', locator: 'line:1' }
const hit = (quote = 'invented fact') => ({ evidenceRef: ref, quote, score: .8, scoreSemantics: 'native-relevance' })
const eligible = async () => ({ current: true, permitted: true, supported: true })
const bindings = { vanilla: { extract() {}, retrieve() {}, answer() {} }, graphify: { extract() {}, retrieve() {}, project() {} },
  lightrag: { extract() {}, retrieve() {}, project() {}, answer() {}, nativeAnswer() {} }, jev: { assess() {} } }

const operationRoles = { vanilla:{extract:'extract',retrieve:'retrieve',answer:'answer'}, graphify:{extract:'extract',retrieve:'retrieve',project:'project'}, lightrag:{extract:'extract',retrieve:'retrieve',project:'project',answer:'answer',nativeAnswer:'native-answer'}, jev:{assess:'assess'} }

test('all eight presence profiles retain a selected vanilla route', () => {
  for (const profile of PRESENCE_PROFILES) assert.equal(compileRoute({ profile, bindings, operationRoles,
    selected: { extractor: { provider: 'vanilla', operation: 'extract' }, retrievers: [{ provider: 'vanilla', operation: 'retrieve' }] } }).extractor.provider, 'vanilla')
})
test('optional selection refuses missing tools and Jev cannot be a generative extractor', () => {
  assert.throws(() => compileRoute({ profile: 'vanilla', bindings, operationRoles, selected: { extractor: { provider: 'graphify', operation: 'extract' } } }), /unavailable/)
  assert.throws(() => compileRoute({ profile: 'jev', bindings, operationRoles, selected: { extractor: { provider: 'jev', operation: 'assess' } } }), /bounded judgments/)
})
test('duplicate retrieval and unsupported native operations are refused before execution', () => {
  assert.throws(() => compileRoute({ profile: 'graphify', bindings, operationRoles, selected: { retrievers: Array(2).fill({ provider: 'graphify', operation: 'retrieve' }) } }), /Duplicate/)
  assert.throws(() => compileRoute({ profile: 'graphify', bindings, operationRoles, selected: { retrievers: [{ provider: 'graphify', operation: 'unsupported' }] } }), /unavailable/)
})
test('overlapping evidence preserves native attribution and typed scores without duplicate corroboration', async () => {
  const result = await composeEvidence([{ provider: 'graphify', hits: [hit()] }, { provider: 'lightrag', hits: [hit()] }], { eligible })
  assert.equal(result.hits.length, 1); assert.equal(result.hits[0].observations.length, 2)
  assert.equal(result.distinctSourceCount, 1); assert.equal(result.combinedScore, null)
})
test('contradictory observations survive and unsupported locations remain explicit gaps', async () => {
  const result = await composeEvidence([{ provider: 'graphify', hits: [hit('may occur'), hit('will not occur'), { quote: 'unlocated' }] }], { eligible })
  assert.equal(result.hits.length, 2); assert.equal(result.unresolved.length, 1)
})
test('current evidence owner excludes stale or withdrawn hits before answer generation', async () => {
  const result = await composeEvidence([{ provider: 'graphify', hits: [hit()] }], { eligible: async () => ({ current: false, permitted: true, reason: 'withdrawn' }) })
  assert.equal(result.hits.length, 0); assert.equal(result.excluded[0].reason, 'withdrawn')
})
test('combined route selects one extractor and one answerer with explicit richer operations', async () => {
  const calls = []
  const composition = createComposition({ bindings, operationRoles, eligible, readKnowledgeView: async () => ({ kind: 'native-exploration', ownerRef: 'invented-owner' }),
    invoke: async ({ step }) => { calls.push(`${step.provider}/${step.operation}`); return { receiptRef: `invented-${calls.length}`, hits: [hit()], usage: null } } })
  const route = { profile: 'graphify+lightrag+jev', extractor: { provider: 'graphify', operation: 'extract' },
    assessors: [{ provider: 'jev', operation: 'assess' }], projectors: [{ provider: 'lightrag', operation: 'project' }],
    retrievers: [{ provider: 'graphify', operation: 'retrieve' }, { provider: 'lightrag', operation: 'retrieve' }], answerer: { provider: 'vanilla', operation: 'answer' } }
  const result = await composition.execute({ route, input: 'invented', question: 'invented' })
  assert.deepEqual(calls, ['graphify/extract', 'jev/assess', 'lightrag/project', 'graphify/retrieve', 'lightrag/retrieve', 'vanilla/answer'])
  assert.equal(result.selectedExtractorCount, 1); assert.equal(result.selectedAnswererCount, 1)
  assert.equal(result.canonicalMutation, false); assert.equal(result.evidence.hits.length, 1)
})
test('native exploration cannot be relabeled as accepted knowledge by a caller', async () => {
  const composition = createComposition({ bindings, operationRoles, eligible, invoke: async () => { throw new Error('should not run') },
    readKnowledgeView: async () => ({ kind: 'native-exploration', ownerRef: 'invented' }) })
  await assert.rejects(composition.execute({ route: { profile: 'vanilla', view: 'accepted-knowledge' } }), /selected view/)
})
test('coupled LightRAG native answer runs once without separate retrieval or synthesis', async () => {
  const calls = []
  const composition = createComposition({ bindings, operationRoles, eligible, readKnowledgeView: async () => ({ kind: 'native-exploration', ownerRef: 'invented-owner' }),
    invoke: async ({ step }) => { calls.push(step.operation); return { receiptRef: 'invented-native-answer', hits: [hit()], answer: 'invented' } } })
  const route = { profile: 'lightrag', nativeAnswer: { provider: 'lightrag', operation: 'nativeAnswer' } }
  const result = await composition.execute({ route, question: 'invented' })
  assert.deepEqual(calls, ['nativeAnswer']); assert.equal(result.selectedAnswererCount, 1)
  assert.equal(result.nativeAnswerGroundingCurrent, true)
  assert.throws(() => compileRoute({ profile: 'lightrag', bindings, operationRoles, selected: { ...route, retrievers: [{ provider: 'lightrag', operation: 'retrieve' }] } }), /separate route/)
})

test('answer payload contains only eligible located evidence and no rejected raw view content', async () => {
  let payload
  const good = hit('eligible text'), stale = {...hit('STALE_SECRET'),evidenceRef:{...ref,revision:'stale'}},
    refused = {...hit('REFUSED_SECRET'),evidenceRef:{...ref,revision:'refused'}}
  const composition = createComposition({bindings,operationRoles,
    eligible: async (r,{quote}) => ({current:r.revision!=='stale',permitted:r.revision!=='refused',supported:quote==='eligible text',reason:'REFUSED_SECRET'}),
    readKnowledgeView:async()=>({kind:'native-exploration',ownerRef:'owner',rawContent:'VIEW_SECRET'}),
    invoke:async({step,payload:p})=>{ if(step.role==='answer'){payload=p;return{receiptRef:'answer'}}
      return{receiptRef:'retrieval',hits:[good,stale,refused,{quote:'UNLOCATED_SECRET'}],artifactRef:'ARTIFACT_SECRET'} }})
  const result=await composition.execute({route:{profile:'vanilla',retrievers:[{provider:'vanilla',operation:'retrieve'}],answerer:{provider:'vanilla',operation:'answer'}},question:'question'})
  assert.deepEqual(payload.evidence.hits,[{evidenceRef:ref,quote:'eligible text'}])
  assert.deepEqual(payload.evidence.rejectionCounts,{unlocated:1,ineligible:2})
  assert.equal(/SECRET/.test(JSON.stringify(payload)),false)
  assert.equal(result.evidence.excluded.length,2);assert.equal(result.receipts.length,2)
})
test('misassigned generation, duplicate cross-role operation and inherited/accessor bindings refuse before effects', async () => {
  const plans=[{profile:'lightrag',retrievers:[{provider:'lightrag',operation:'nativeAnswer'}],answerer:{provider:'vanilla',operation:'answer'}},
    {profile:'graphify',extractor:{provider:'graphify',operation:'extract'},assessors:[{provider:'graphify',operation:'extract'}]},
    {profile:'vanilla',extractor:{provider:'vanilla',operation:'toString'}}]
  let effects=0
  const c=createComposition({bindings,operationRoles,eligible,invoke:async()=>{effects++},readKnowledgeView:async()=>{effects++}})
  for(const route of plans) await assert.rejects(c.execute({route}),/declared|Duplicate|unavailable/)
  let getterCalls=0
  const accessorBindings={vanilla:{get extract(){getterCalls++;return()=>{}}}}
  assert.throws(()=>compileRoute({profile:'vanilla',selected:{extractor:{provider:'vanilla',operation:'extract'}},bindings:accessorBindings,operationRoles}),/unavailable/)
  assert.equal(getterCalls,0);assert.equal(effects,0)
  const inheritedRoles={vanilla:Object.create({extract:'extract'})}
  assert.throws(()=>compileRoute({profile:'vanilla',selected:{extractor:{provider:'vanilla',operation:'extract'}},bindings,operationRoles:inheritedRoles}),/declared/)
})
test('native answer with stale, unlocated or empty grounding is withheld under original receipt', async () => {
  for(const hits of [[hit()],[{quote:'unlocated'}],[]]){
    const c=createComposition({bindings,operationRoles,eligible:async()=>({current:false,permitted:true}),
      readKnowledgeView:async()=>({kind:'native-exploration',ownerRef:'owner'}),
      invoke:async()=>({receiptRef:'original-native',hits,answer:'STALE_ANSWER',usage:{cost:3}})})
    const result=await c.execute({route:{profile:'lightrag',nativeAnswer:{provider:'lightrag',operation:'nativeAnswer'}}})
    assert.equal(result.answer,null);assert.equal(result.withheldNativeResult.answer,'STALE_ANSWER')
    assert.equal(result.receipts[0].receiptRef,'original-native');assert.equal(result.selectedAnswererCount,1)
  }
})
test('later thrown operation and malformed receipt preserve actual prior receipts and returned output', async () => {
  const route={profile:'graphify',extractor:{provider:'vanilla',operation:'extract'},retrievers:[{provider:'graphify',operation:'retrieve'}]}
  for(const malformed of [false,true]){
    const c=createComposition({bindings,operationRoles,eligible,readKnowledgeView:async()=>({kind:'native-exploration',ownerRef:'owner'}),
      invoke:async({step})=>{if(step.role==='extract')return{receiptRef:'actual-capture',usage:{cost:2}}
        if(malformed)return{hits:[hit()],usage:{cost:5},raw:'original-return'}
        throw new Error('native interrupted')}})
    await assert.rejects(c.execute({route}),error=>{
      assert.equal(error.receipts[0].receiptRef,'actual-capture');assert.equal(error.receipts[0].usage.cost,2)
      assert.equal(error.failedStep.role,'retrieve');assert.equal(error.effectUncertain,true)
      assert.equal(error.retryAuthorized,false)
      if(malformed)assert.equal(error.retainedResults[1].result.raw,'original-return')
      return true
    })
  }
})

for(const profile of PRESENCE_PROFILES) test(`selected ${profile} route composes present tools once and never invokes absent tools`,async()=>{
  const present=new Set(profile==='vanilla'?[]:profile.split('+')),calls=[]
  const provider=present.has('graphify')?'graphify':present.has('lightrag')?'lightrag':'vanilla'
  const retrievers=['graphify','lightrag'].filter(x=>present.has(x));if(!retrievers.length)retrievers.push('vanilla')
  const route={profile,extractor:{provider,operation:'extract'},
    assessors:present.has('jev')?[{provider:'jev',operation:'assess'}]:[],
    projectors:['graphify','lightrag'].filter(x=>present.has(x)).map(provider=>({provider,operation:'project'})),
    retrievers:retrievers.map(provider=>({provider,operation:'retrieve'})),answerer:{provider:'vanilla',operation:'answer'}}
  const c=createComposition({bindings,operationRoles,eligible,readKnowledgeView:async()=>({kind:'native-exploration',ownerRef:'fixture-existing-owner'}),
    invoke:async({step,payload})=>{assert.ok(step.provider==='vanilla'||present.has(step.provider));calls.push(step)
      if(step.role==='answer'){assert.equal(payload.evidence.hits.length,1);assert.equal(payload.evidence.hits[0].quote,'invented fact')}
      return{receiptRef:`fixture-receipt-${calls.length}`,hits:[hit()],nativeArtifact:{provider:step.provider},usage:null}}})
  const result=await c.execute({route,input:'invented input',question:'invented question'})
  assert.equal(calls.filter(x=>x.role==='extract').length,1);assert.equal(calls.filter(x=>x.role==='answer').length,1)
  assert.equal(calls.filter(x=>x.role==='assess').length,present.has('jev')?1:0)
  assert.equal(new Set(calls.map(x=>x.provider+'/'+x.operation)).size,calls.length)
  assert.equal(result.evidence.distinctSourceCount,1);assert.equal(result.evidence.hits[0].observations.length,retrievers.length)
  assert.equal(result.receipts.length,calls.length);assert.equal(result.nativeQualification,false)
})


test('partially mapped native citation gaps survive receiving and withhold the coupled answer',async()=>{
 for(const field of ['unresolved','unresolvedReferences']){
  const native={receiptRef:'actual-original-query',hits:[hit()],answer:'partially unlocated answer',[field]:[{nativeReference:'UNMAPPED_SECRET',reason:'no canonical mapping'}]}
  const c=createComposition({bindings,operationRoles,eligible,readKnowledgeView:async()=>({kind:'native-exploration',ownerRef:'owner'}),invoke:async()=>native})
  const result=await c.execute({route:{profile:'lightrag',nativeAnswer:{provider:'lightrag',operation:'nativeAnswer'}}})
  assert.equal(result.answer,null);assert.equal(result.nativeAnswerGroundingCurrent,false)
  assert.equal(result.evidence.hits.length,1);assert.equal(result.evidence.unresolved.length,1)
  assert.equal(result.withheldNativeResult.receiptRef,'actual-original-query')
 }
})

test('exact quote support and a narrowed reference prevent unverified native text from reaching generation',async()=>{
 let payload;const canonical='owner-read exact quote',extra={...ref,nativeSecret:'REFERENCE_SECRET'}
 const good={evidenceRef:extra,quote:canonical},bad={evidenceRef:ref,quote:'MISMATCHED_SECRET'},malformed={evidenceRef:{...ref,locator:{kind:'line',value:'1',extra:'LOCATOR_SECRET'}},quote:canonical}
 const c=createComposition({bindings,operationRoles,
  eligible:async(r,{quote})=>{assert.deepEqual(r,ref);return{current:true,permitted:true,supported:quote===canonical}},
  readKnowledgeView:async()=>({kind:'native-exploration',ownerRef:'owner'}),
  invoke:async({step,payload:p})=>{if(step.role==='answer'){payload=p;return{receiptRef:'answer'}}return{receiptRef:'query',hits:[good,bad,malformed]}}})
 const result=await c.execute({route:{profile:'vanilla',retrievers:[{provider:'vanilla',operation:'retrieve'}],answerer:{provider:'vanilla',operation:'answer'}}})
 assert.deepEqual(payload.evidence.hits,[{evidenceRef:ref,quote:canonical}]);assert.equal(JSON.stringify(payload).includes('SECRET'),false)
 assert.equal(result.evidence.excluded.length,1);assert.equal(result.evidence.unresolved.length,1)
 assert.equal(result.evidence.hits[0].observations[0].nativeHit.evidenceRef.nativeSecret,'REFERENCE_SECRET')
})
test('eligibility without explicit support withholds native answers and async receiving cannot change the inspected quote',async()=>{
 const native={receiptRef:'query',hits:[hit()],answer:'native answer'}
 const owners={bindings,operationRoles,readKnowledgeView:async()=>({kind:'native-exploration',ownerRef:'owner'}),invoke:async()=>native}
 const c=createComposition({...owners,eligible:async()=>({current:true,permitted:true})})
 const result=await c.execute({route:{profile:'lightrag',nativeAnswer:{provider:'lightrag',operation:'nativeAnswer'}}})
 assert.equal(result.answer,null);assert.deepEqual(result.withheldNativeResult,native);assert.notEqual(result.withheldNativeResult,native)
 const bundle={provider:'graphify',hits:[hit('original exact quote')]}
 const received=await composeEvidence([bundle],{eligible:async(r,{quote})=>{bundle.hits[0].quote='LATE_SECRET';r.revision='mutated';return{current:true,permitted:true,supported:quote==='original exact quote'}}})
 assert.equal(received.hits[0].quote,'original exact quote');assert.equal(received.hits[0].evidenceRef.revision,'r1')
})
test('dispatch uses the exact callable validated before an asynchronous owner can mutate bindings',async()=>{
 const calls=[],original=async()=>{calls.push('original');return{receiptRef:'original',hits:[hit()]}}
 const local={vanilla:{retrieve:original}},roles={vanilla:{retrieve:'retrieve'}}
 const c=createComposition({bindings:local,operationRoles:roles,eligible,
  readKnowledgeView:async()=>{Object.defineProperty(local.vanilla,'retrieve',{get(){throw new Error('late accessor invoked')}});return{kind:'native-exploration',ownerRef:'owner'}},
  invoke:async({callable,payload})=>callable(payload)})
 const result=await c.execute({route:{profile:'vanilla',retrievers:[{provider:'vanilla',operation:'retrieve'}]}})
 assert.deepEqual(calls,['original']);assert.equal(result.receipts[0].receiptRef,'original')
})


test('equivalent canonical locator member order combines observations once', async () => {
 const first={...ref,locator:{kind:'line',value:'1'}}, second={...ref,locator:{value:'1',kind:'line'}}
 const received=await composeEvidence([{provider:'graphify',hits:[{evidenceRef:first,quote:'exact quote'}]},
  {provider:'lightrag',hits:[{evidenceRef:second,quote:'exact quote'}]}],{eligible})
 assert.equal(received.hits.length,1)
 assert.equal(received.hits[0].observations.length,2)
 assert.equal(received.distinctSourceCount,1)
 assert.deepEqual(received.hits[0].evidenceRef.locator,{kind:'line',value:'1'})
 assert.deepEqual(Object.keys(received.hits[0].evidenceRef.locator),['kind','value'])
 assert.deepEqual(received.hits[0].observations[1].nativeHit.evidenceRef.locator,second.locator)
 assert.deepEqual(Object.keys(received.hits[0].observations[1].nativeHit.evidenceRef.locator),['value','kind'])
})


test('coupled native grounding and answer retain detached returned snapshot', async () => {
 const returned={receiptRef:'original-native-step',hits:[hit('original exact quote')],answerText:'original answer',usage:{tokens:4}}
 const c=createComposition({bindings:{vanilla:{},lightrag:{native:async()=>{}}},operationRoles:{lightrag:{native:'native-answer'}},
  readKnowledgeView:async()=>({kind:'native-exploration',ownerRef:'owner'}),invoke:async()=>returned,
  eligible:async()=>{returned.answerText='LATE_MUTATED_ANSWER';returned.hits[0].quote='LATE_MUTATED_QUOTE';returned.usage.tokens=999;return{current:true,permitted:true,supported:true}}})
 const result=await c.execute({route:{profile:'lightrag',nativeAnswer:{provider:'lightrag',operation:'native'},view:'native-exploration'},input:{},question:'invented'})
 assert.notEqual(result.answer,returned)
 assert.equal(result.answer.answerText,'original answer')
 assert.equal(result.answer.hits[0].quote,'original exact quote')
 assert.equal(result.evidence.hits[0].quote,'original exact quote')
 assert.equal(result.receipts[0].usage.tokens,4)
})

test('late owner failure preserves preceding returned snapshot and usage', async () => {
 const returned={receiptRef:'extraction-original',candidates:[{id:'original'}],usage:{tokens:4}},cause=new Error('later existing owner failure')
 const c=createComposition({bindings:{vanilla:{extract:async()=>{}}},operationRoles:{vanilla:{extract:'extract'}},eligible,
  invoke:async()=>returned,readKnowledgeView:async()=>{returned.candidates[0].id='LATE_MUTATION';returned.usage.tokens=999;throw cause}})
 await assert.rejects(c.execute({route:{profile:'vanilla',extractor:{provider:'vanilla',operation:'extract'},view:'native-exploration'},input:{}}),err=>{
  assert.equal(err.cause,cause);assert.equal(err.retainedResults[0].result.candidates[0].id,'original');assert.equal(err.retainedResults[0].result.usage.tokens,4)
  assert.equal(err.receipts[0].usage.tokens,4);assert.equal(err.retryAuthorized,false);return true
 })
})

test('unsnapshotable returned producer data stays explicitly in reconciliation custody', async () => {
 const returned={receiptRef:'original-step',usage:{tokens:7},unsupported:()=>{}}
 const c=createComposition({bindings:{vanilla:{extract:async()=>{}}},operationRoles:{vanilla:{extract:'extract'}},eligible,
  invoke:async()=>returned,readKnowledgeView:async()=>{throw new Error('must not continue')}})
 await assert.rejects(c.execute({route:{profile:'vanilla',extractor:{provider:'vanilla',operation:'extract'},view:'native-exploration'},input:{}}),err=>{
  assert.equal(err.cause.name,'DataCloneError');assert.equal(err.retainedResults[0].result,returned)
  assert.equal(err.retainedResults[0].snapshotState,'failed');assert.equal(err.retainedResults[0].snapshotError,err.cause)
  assert.equal(err.retainedResults[0].result.usage.tokens,7);assert.equal(err.effectUncertain,true);assert.equal(err.retryAuthorized,false);return true
 })
})

test('later selected assessor and knowledge owner cannot rewrite extraction or receipts', async () => {
 const input={sourceId:'original-source'}, extraction={receiptRef:{id:'original-extract'},usage:{tokens:4},operationBinding:{operationId:'original-operation'}}
 const assessment={receiptRef:{id:'original-assess'},usage:{tokens:2},judgment:'original-judgment'}
 const c=createComposition({bindings,operationRoles,eligible,
  invoke:async({step,payload})=>{
   if(step.role==='extract')return extraction
   payload.input.sourceId='ASSESSOR_MUTATION';payload.extraction.operationBinding.operationId='ASSESSOR_MUTATION'
   payload.extraction.usage.tokens=999;payload.extraction.receiptRef.id='ASSESSOR_MUTATION';return assessment
  },readKnowledgeView:async request=>{
   assert.equal(request.input.sourceId,'original-source');assert.equal(request.extraction.operationBinding.operationId,'original-operation')
   assert.equal(request.extraction.usage.tokens,4);request.extraction.usage.tokens=777;request.assessments[0].judgment='KNOWLEDGE_MUTATION'
   request.assessments[0].usage.tokens=777;return{kind:'native-exploration',ownerRef:'owner'}
  }})
 const result=await c.execute({route:{profile:'jev',extractor:{provider:'vanilla',operation:'extract'},assessors:[{provider:'jev',operation:'assess'}]},input})
 assert.equal(input.sourceId,'original-source');assert.equal(result.extraction.operationBinding.operationId,'original-operation')
 assert.equal(result.extraction.usage.tokens,4);assert.equal(result.assessments[0].judgment,'original-judgment')
 assert.equal(result.receipts[0].receiptRef.id,'original-extract');assert.equal(result.receipts[0].usage.tokens,4);assert.equal(result.receipts[1].usage.tokens,2)
})

test('later selected retriever cannot rewrite projection failure custody or original costs', async () => {
 const cause=new Error('original later retrieval failure')
 const c=createComposition({bindings,operationRoles,eligible,readKnowledgeView:async()=>({kind:'native-exploration',ownerRef:'owner'}),
  invoke:async({step,payload})=>{
   if(step.role==='project')return{receiptRef:{id:'original-project'},usage:{tokens:4},nativeArtifact:{qualifier:'may'}}
   payload.projections[0].usage.tokens=999;payload.projections[0].receiptRef.id='RETRIEVER_MUTATION'
   payload.projections[0].nativeArtifact.qualifier='must';throw cause
  }})
 await assert.rejects(c.execute({route:{profile:'lightrag',projectors:[{provider:'lightrag',operation:'project'}],retrievers:[{provider:'lightrag',operation:'retrieve'}]},input:{}}),err=>{
  assert.equal(err.cause,cause);assert.equal(err.retainedResults[0].result.usage.tokens,4)
  assert.equal(err.retainedResults[0].result.receiptRef.id,'original-project');assert.equal(err.retainedResults[0].result.nativeArtifact.qualifier,'may')
  assert.equal(err.receipts[0].receiptRef.id,'original-project');assert.equal(err.receipts[0].usage.tokens,4)
  assert.equal(err.effectUncertain,true);assert.equal(err.retryAuthorized,false);return true
 })
})

test('returned projection edits cannot rewrite independently detached receipt fields', async () => {
 const c=createComposition({bindings,operationRoles,eligible,readKnowledgeView:async()=>({kind:'native-exploration',ownerRef:'owner'}),
  invoke:async()=>({receiptRef:{id:'original-project'},usage:{tokens:4}})})
 const result=await c.execute({route:{profile:'lightrag',projectors:[{provider:'lightrag',operation:'project'}]},input:{}})
 result.projections[0].usage.tokens=999;result.projections[0].receiptRef.id='CALLER_MUTATION'
 assert.equal(result.receipts[0].usage.tokens,4);assert.equal(result.receipts[0].receiptRef.id,'original-project')
})

test('knowledge owner view and later selected input remain separate snapshots', async () => {
 const originalView={kind:'native-exploration',ownerRef:{id:'original-owner'},generation:'original-generation'}
 const c=createComposition({bindings,operationRoles,eligible,readKnowledgeView:async()=>originalView,
  invoke:async({payload})=>{
   originalView.generation='OWNER_LATE_MUTATION';payload.view.ownerRef.id='RETRIEVER_MUTATION';return{receiptRef:'retrieve',hits:[hit()]}
  }})
 const result=await c.execute({route:{profile:'vanilla',retrievers:[{provider:'vanilla',operation:'retrieve'}]},input:{},question:'invented'})
 assert.equal(result.view.ownerRef.id,'original-owner');assert.equal(result.view.generation,'original-generation')
})
