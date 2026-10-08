import test from 'node:test'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import { PRESENCE_PROFILES, accountComponents, summarizeCohort, amortizedCosts, createQualificationExecutor, assessmentBinding } from '../../src/ingestion/optional/evaluation/index.mjs'
const hash = value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const verifiedReceipt = record=>({taskId:record.taskId,bindingDigest:hash(assessmentBinding(record)),receiptRef:'independent-receipt',assessorRef:'independent-assessor',rubricRef:'frozen-rubric',usefulAccepted:true,supportAccepted:true})
const verifyAssessment = (receipt,binding)=>({verified:true,current:true,ownerRef:'existing-assessor-owner',receiptRef:receipt.receiptRef,bindingDigest:hash(binding)})
const component = (id, cost, complete = true) => ({ id, kind: 'attempt', cost, currency: 'USD', elapsedMs: 1, complete })
const plan = () => ({ installedCandidate: 'synthetic-target', corpusDigest: 'invented', targetsDigest: 'frozen-target',
  routeDigest: 'selected', questionOrderDigest: 'predeclared', tasks: PRESENCE_PROFILES.map((profile, i) =>
    ({ id: `task-${i}`, profile, phase: 'warm', routeId: 'selected', repetition: 1, questionId: 'invented-q', cacheState: 'warm' })) })

test('failed and fallback attempts stay charged to the full assigned denominator', () => {
  const result = summarizeCohort({ assignedTaskIds: ['a', 'b'], sharedComponents: [component('ingest', 3)], records: [
    { taskId: 'a',planDigest:'p',questionId:'q',routeId:'r',resultDigest:'answer-pin', outcome: 'completed', components: [component('a-primary', 2), component('a-fallback', 1)],
      assessment: { usefulAccepted: true, supportAccepted: true, assessorRef: 'invented-assessor' } },
    { taskId: 'b', outcome: 'failed', components: [component('b-primary', 4)], elapsedMs: 17 } ],assessmentReceipts:[verifiedReceipt({taskId:'a',planDigest:'p',questionId:'q',routeId:'r',resultDigest:'answer-pin'})],verifyAssessment })
  assert.equal(result.assigned, 2); assert.equal(result.usefulAcceptedFraction, .5)
  assert.equal(result.accounting.totalCost, 10); assert.equal(result.costPerUsefulAcceptedAnswer, 10)
  assert.equal(result.elapsedObservations[1].elapsedMs, 17)
})
test('unknown, incomplete and mixed-currency costs never establish a total', () => {
  assert.equal(accountComponents([component('a', null)]).totalCost, null)
  assert.equal(accountComponents([component('a', 1, false)]).totalCost, null)
  assert.equal(accountComponents([component('a', 1), { ...component('b', 2), currency: 'EUR' }]).totalCost, null)
  assert.equal(accountComponents([]).totalCost, null)
})
test('missing tasks and zero useful outcomes cannot establish savings', () => {
  const result = summarizeCohort({ assignedTaskIds: ['a', 'b'], records: [{ taskId: 'a', outcome: 'failed', components: [component('a', 1)] }] })
  assert.deepEqual(result.missing, ['b']); assert.equal(result.accounting.totalCost, null)
  assert.equal(result.costPerUsefulAcceptedAnswer, null)
})
test('shared ingestion costs amortize once under predeclared workload assumptions', () => {
  const result = amortizedCosts({ ingestionComponents: [component('ingest', 10)], queryComponents: [component('query', 2)] })
  assert.deepEqual(result.map(x => x.totalCost), [12, 30, 210]); assert.deepEqual(result.map(x => x.costPerQuery), [12, 3, 2.1])
})
test('refused admission performs no native task or trial lifecycle effect', async () => {
  let effects = 0
  const executor = createQualificationExecutor({ admit: async () => ({ executionAllowed: false }), openTrial: async () => { effects++ },
    executeTask: async () => { effects++ }, closeTrial: async () => { effects++ }, appendSidecar: async () => {} })
  await assert.rejects(executor.run(plan()), /refused/); assert.equal(effects, 0)
})
test('all eight profile tasks execute in frozen order and close each trial', async () => {
  const calls = [], sidecars = [], closed = []
  const executor = createQualificationExecutor({ admit: async ({ planDigest }) => ({ planDigest, executionAllowed: true, ownerRef: 'invented-host', limitsRef: 'invented-limits' }),
    openTrial: async ({ task }) => ({ handle: task.id, components: [component(`${task.id}/shared`, 1)] }),
    executeTask: async ({ task }) => { calls.push(task.profile); return { outcome: 'completed', components: [component(`${task.id}/query`, 1)], answer: 'invented' } },
    closeTrial: async ({ trial }) => { closed.push(trial); return { verified: true } }, appendSidecar: async record => sidecars.push(record) })
  const result = await executor.run(plan())
  assert.deepEqual(calls, [...PRESENCE_PROFILES]); assert.equal(closed.length, 8)
  assert.equal(sidecars.length, 9); assert.equal(result.cohort.accounting.totalCost, 16)
  assert.equal(result.cohort.usefulAccepted, 0); assert.equal(result.benefitQualified, false)
})
test('uncertain native throw stops subsequent tasks, retains unknown costs and cleans up', async () => {
  let calls = 0, cleanup = 0
  const executor = createQualificationExecutor({ admit: async ({ planDigest }) => ({ planDigest, executionAllowed: true, ownerRef: 'invented', limitsRef: 'limits' }),
    openTrial: async () => ({ handle: 'invented', components: [component('open', 1)] }),
    executeTask: async () => { calls++; throw new Error('invented interrupted native call') },
    closeTrial: async () => { cleanup++; return { verified: true } }, appendSidecar: async () => {} })
  const result = await executor.run(plan())
  assert.equal(calls, 1); assert.equal(cleanup, 1); assert.equal(result.records[0].outcome, 'uncertain')
  assert.equal(result.cohort.missing.length, 7); assert.equal(result.cohort.accounting.totalCost, null)
})
test('cleanup failures remain visible and never become a native qualification', async () => {
  const single = plan(); single.tasks = single.tasks.slice(0, 1)
  const executor = createQualificationExecutor({ admit: async ({ planDigest }) => ({ planDigest, executionAllowed: true, ownerRef: 'invented', limitsRef: 'limits' }),
    openTrial: async () => ({ handle: 'invented', components: [component('open', 0)] }),
    executeTask: async () => ({ outcome: 'completed', components: [component('query', 0)] }),
    closeTrial: async () => { throw new Error('cleanup failed') }, appendSidecar: async () => {} })
  const result = await executor.run(single)
  assert.equal(result.cleanupVerified, false); assert.equal(result.nativeQualification, false)
})
test('interrupted trial opening records unknown costs and hands unresolved lifecycle to cleanup', async () => {
  let calls = 0, closed
  const executor = createQualificationExecutor({ admit: async ({ planDigest }) => ({ planDigest, executionAllowed: true, ownerRef: 'invented', limitsRef: 'limits' }),
    openTrial: async () => { throw new Error('allocated before losing receipt') },
    executeTask: async () => { calls++ },
    closeTrial: async request => { closed = request; return { verified: false, outcome: 'owner-reconciliation-needed' } },
    appendSidecar: async () => {} })
  const result = await executor.run(plan())
  assert.equal(calls, 0); assert.equal(closed.trial, null); assert.equal(closed.task.id, 'task-0')
  assert.equal(result.records[0].effectStage, 'trial-open'); assert.equal(result.cohort.accounting.totalCost, null)
  assert.equal(result.cleanupVerified, false); assert.equal(result.cohort.missing.length, 7)
})
test('malformed completion receipts stop further effects and keep costs unknown', async () => {
  let calls = 0
  const executor = createQualificationExecutor({ admit: async ({ planDigest }) => ({ planDigest, executionAllowed: true, ownerRef: 'invented', limitsRef: 'limits' }),
    openTrial: async () => ({ handle: 'invented', components: [component('open', 0)] }),
    executeTask: async () => { calls++; return { outcome: 'completed' } },
    closeTrial: async () => ({ verified: true }), appendSidecar: async () => {} })
  const result = await executor.run(plan())
  assert.equal(calls, 1); assert.equal(result.records[0].outcome, 'uncertain')
  assert.equal(result.cohort.accounting.totalCost, null)
})

test('self-reported useful assessment never counts without separately verified bound assessor receipt', () => {
  const record={taskId:'a',planDigest:'p',questionId:'q',routeId:'r',resultDigest:'original-answer',outcome:'completed',components:[component('a',1)],assessment:{usefulAccepted:true,supportAccepted:true,assessorRef:'claimed'}}
  const base={assignedTaskIds:['a'],records:[record]}
  assert.equal(summarizeCohort(base).usefulAccepted,0)
  const receipt=verifiedReceipt(record)
  assert.equal(summarizeCohort({...base,assessmentReceipts:[receipt]}).usefulAccepted,0)
  assert.equal(summarizeCohort({...base,assessmentReceipts:[receipt],verifyAssessment}).usefulAccepted,1)
  assert.equal(summarizeCohort({...base,assessmentReceipts:[receipt],verifyAssessment:()=>({verified:true})}).usefulAccepted,0)
  assert.equal(summarizeCohort({...base,records:[{...record,resultDigest:'changed-answer'}],assessmentReceipts:[receipt],verifyAssessment}).usefulAccepted,0)
  assert.equal(summarizeCohort({...base,assessmentReceipts:[receipt],verifyAssessment:async()=>({verified:true})}).usefulAccepted,0)
})
const owners=()=>({admit:async({planDigest})=>({planDigest,executionAllowed:true,ownerRef:'execution-host',limitsRef:'limits'}),
 openTrial:async({task})=>({handle:task.id,components:[component(task.id+'/open',1)]}),
 closeTrial:async()=>({verified:true}),appendSidecar:async()=>{}})
test('executor forwards execution to separate assessor receiving and verifies exact original answer binding', async () => {
  const single=plan();single.tasks=single.tasks.slice(0,1)
  const e=createQualificationExecutor({...owners(),executeTask:async()=>({outcome:'completed',answer:'original',components:[component('answer',2)],assessment:{usefulAccepted:true,supportAccepted:true,assessorRef:'self'}}),
    receiveAssessment:async({binding,result})=>{assert.equal(result.answer,'original');return verifiedReceipt(binding)},verifyAssessment})
  const result=await e.run(single)
  assert.equal(result.records[0].assessment,undefined);assert.equal(result.records[0].executionResult.assessment.assessorRef,'self')
  assert.equal(result.cohort.usefulAccepted,1);assert.equal(result.benefitQualified,false)
})
test('cross-task component collision stops before next native call and retains actual returned output/costs', async () => {
  let calls=0,closed=0
  const e=createQualificationExecutor({...owners(),executeTask:async()=>{calls++;return{outcome:'completed',receiptRef:'native-'+calls,answer:'actual-'+calls,components:[component('same-charge',calls)]}},closeTrial:async()=>{closed++;return{verified:true}}})
  const result=await e.run(plan())
  assert.equal(calls,2);assert.equal(closed,2);assert.equal(result.records.length,2)
  assert.equal(result.records[1].outcome,'uncertain');assert.equal(result.records[1].executionResult.attemptedResult.answer,'actual-2')
  assert.equal(result.records[1].executionResult.attemptedResult.components[0].cost,2)
  assert.equal(result.cohort.accounting.totalCost,null);assert.equal(result.cohort.missing.length,6)
})
test('shared accounting collision stops before task execution while retaining allocated handle and costs', async () => {
  let calls=0
  const e=createQualificationExecutor({...owners(),openTrial:async({task})=>({handle:task.id,components:[component('shared-charge',3)]}),
    executeTask:async({task})=>{calls++;return{outcome:'completed',components:[component(task.id,1)]}}})
  const result=await e.run(plan())
  assert.equal(calls,1);assert.equal(result.records[1].effectStage,'trial-open')
  assert.equal(result.records[1].executionResult.attemptedResult.handle,'task-1')
  assert.equal(result.terminalCleanup.length,2);assert.equal(result.cohort.accounting.totalCost,null)
})
test('sidecar failure retains already executed results and cleanup without native retry', async () => {
  const primary=new Error('execution sidecar unavailable'),cleanup=new Error('cleanup sidecar unavailable')
  const e=createQualificationExecutor({...owners(),executeTask:async()=>({outcome:'completed',answer:'retained',components:[component('actual',1)]}),appendSidecar:async record=>{throw record.kind==='trial-cleanup'?cleanup:primary}})
  await assert.rejects(e.run(plan()),error=>{assert.equal(error,primary);assert.equal(error.records[0].executionResult.answer,'retained');assert.equal(error.terminalCleanup.length,1);assert.equal(error.retryAuthorized,false);assert.equal(error.sidecarFailures[0].error,cleanup);assert.equal(error.sidecarFailures[0].stage,'trial-cleanup');return true})
})
test('standalone summary with colliding costs preserves records and reports unknown accounting', () => {
  const records=['a','b'].map(taskId=>({taskId,outcome:'completed',components:[component('collision',1)]}))
  const result=summarizeCohort({assignedTaskIds:['a','b'],records})
  assert.equal(result.observed,2);assert.equal(result.accounting.totalCost,null);assert.equal(result.accounting.retainedComponents.length,2)
})


test('empty trial accounting cannot silently turn an unknown allocation into free shared ingestion', async()=>{
 let calls=0
 const e=createQualificationExecutor({...owners(),openTrial:async()=>({handle:'allocated',components:[]}),executeTask:async()=>{calls++;return{outcome:'completed',components:[component('query',1)]}}})
 const result=await e.run(plan())
 assert.equal(calls,0);assert.equal(result.records[0].outcome,'uncertain')
 assert.equal(result.records[0].executionResult.attemptedResult.handle,'allocated')
 assert.equal(result.cohort.accounting.totalCost,null);assert.equal(result.terminalCleanup.length,1)
})
