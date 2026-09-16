import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBoundedJSON, parsePlacement, parseDefinition, parseRequest, canonical } from '../src/composition/wire.mjs';
import { createRegistrySnapshot, digestBytes } from '../src/composition/registry.mjs';
import { createPreviewEnforcer } from '../src/access/preview-enforcer.mjs';
import { createFixtureHost, placementBytes, definitionBytes } from '../examples/connected-composition/fixture-host.mjs';

function request(host, edits = {}) {
  return JSON.stringify({ schema:'atelier-preview-request/proposal-v1',status:'proposed',requestId:'request.1',placementId:'sample.collection.1',sourceDigest:host.snapshot().sourceDigest,mode:'synthetic',...edits });
}
function action(host, edits = {}) { return request(host, {schema:'atelier-component-intent/proposal-v1',mode:'sandbox-interactive',intentRef:'sample.pin',payload:{pinned:true,expectedVersion:0},...edits}); }
const run = (host, bytes = request(host)) => host.handle(host.newChannel(), bytes, new AbortController().signal);
const mutate = (bytes, apply) => { const value = JSON.parse(bytes); apply(value); return JSON.stringify(value); };

test('closed parser accepts exact-byte BOM input, rejects object/accessor inputs and lossy text', () => {
  const bytes = placementBytes();
  assert.equal(parsePlacement('\ufeff'+bytes).props.heading, 'Workshop notes');
  assert.notEqual(digestBytes(bytes), digestBytes('\ufeff'+bytes));
  assert.notEqual(digestBytes(bytes), digestBytes(bytes.replaceAll('\n','\r\n')));
  for(const v of [{get schema(){throw new Error('accessor evaluated');}}, new Uint8Array([255]), '"\ud800"', '"\\ud800"']) assert.throws(()=>parseBoundedJSON(v), TypeError);
  assert.equal(Object.getPrototypeOf(parsePlacement(bytes).props), null);
});
for (const text of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"a":{"x":1,"x":2}}', '[1,]', '{"a":1,}', '1e999', '0 0', '[[[[[[[[[0]]]]]]]]]', '"'+ 'x'.repeat(65537)+'"']) test('refuses ambiguous or out-of-bounds JSON '+text.slice(0,35),()=>assert.throws(()=>parseBoundedJSON(text)));
test('JSON grammar handles escaped quotes, braces and control characters correctly',()=>{
  const sample = { a:'quote " slash \\ } {', b:[true,false,null,-0.1e2], c:'\n\t' };
  assert.equal(canonical(parseBoundedJSON(JSON.stringify(sample))),canonical(sample));
  assert.throws(()=>parseBoundedJSON('"raw\nnewline"'));
});
for(const key of ['__proto__','constructor','prototype','bad-key','a'.repeat(81)]) test('unsafe scalar property refused '+key,()=>{
  const p=JSON.parse(placementBytes()); p.props=Object.fromEntries([[key,null]]); assert.throws(()=>parsePlacement(JSON.stringify(p)));
});
for(const change of [p=>p.accessToken='no',p=>p.props.extra={},p=>p.props.heading='x'.repeat(4097),p=>p.props=Object.fromEntries(Array.from({length:65},(_,i)=>['p'+i,0])),p=>p.componentVersion='latest',p=>p.dataBindings.push({...p.dataBindings[0],resourceRef:'sample.other'})]) test('placement structural/semantic bound '+change.toString(),()=>assert.throws(()=>parsePlacement(mutate(placementBytes(),change))));
test('definitions and actions have executable closed validators',()=>{
  assert.equal(parseDefinition(definitionBytes).componentId,'sample.collection');
  assert.throws(()=>parseDefinition(mutate(definitionBytes,v=>v.projections=['web','web'])));
  const h=createFixtureHost(); assert.equal(parseRequest(action(h)).intentRef,'sample.pin');
  for(const change of [v=>v.mode='connected-read-only',v=>v.endpointUrl='https://invalid.example',v=>v.payload.deep={},v=>v.payload=JSON.parse('{"constructor":null}')]) assert.throws(()=>parseRequest(mutate(action(h),change)));
});
test('registry binds exact version, source, renderer and revision; lifecycle is explicit',()=>{
  const common={definitionBytes,rendererBytes:'one',revision:'r1',validateProps:()=>true,validateIntent:()=>true};
  const h=createFixtureHost(), args={sourceBytes:placementBytes(),sourceRef:'source',request:parseRequest(request(h)),operationRef:'read',serviceRef:'service'};
  const a=createRegistrySnapshot(common),b=createRegistrySnapshot({...common,rendererBytes:'two'});
  assert.notEqual(a.rendererDigest,b.rendererDigest); assert(Object.isFrozen(a.definition.previewModes));
  assert.equal(a.resolve(args).sourceDigest,digestBytes(placementBytes()));
  for(const lifecycle of ['withdrawn','revoked','deprecated']) assert.throws(()=>createRegistrySnapshot({...common,lifecycle}).resolve(args));
  assert.equal(createRegistrySnapshot({...common,lifecycle:'deprecated',allowDeprecated:true}).resolve(args).warning,'deprecated');
  assert.throws(()=>a.resolve({...args,sourceBytes:placementBytes()+' '}));
  assert.throws(()=>a.resolve({...args,sourceBytes:mutate(placementBytes(),v=>v.componentVersion='2.0.0')}));
});
for(const adapter of ['session-map','assertion-membership']) test(adapter+' read, action, idempotent retry and reversal use same enforcer',async()=>{
  const h=createFixtureHost(); h.setIdentity('human',adapter);
  const read=await run(h); assert.equal(read.state.state,'ready'); assert.equal(read.projectedData.heading,'Workshop notes');
  assert(!JSON.stringify(read).includes('fixture-private-canary')); assert(!JSON.stringify(read).includes('sample.tenant'));
  const first=await run(h,action(h)); assert.equal(first.state.state,'ready'); assert.equal(first.projectedData.pinned,true);
  assert.equal((await run(h,action(h))).state.state,'ready'); assert.equal(h.snapshot().effects,1);
  const altered=await run(h,action(h,{payload:{pinned:false,expectedVersion:1}})); assert.equal(altered.state.state,'forbidden'); assert.equal(h.snapshot().effects,1);
  const undo=await run(h,action(h,{requestId:'request.2',payload:{pinned:false,expectedVersion:1}})); assert.equal(undo.projectedData.pinned,false); assert.equal(h.snapshot().effects,2);
});
test('read-only and unknown payload actions refuse before service',async()=>{
  const h=createFixtureHost();
  for(const bytes of [action(h,{mode:'connected-read-only'}),action(h,{payload:{pinned:true,expectedVersion:0,extra:1}}),action(h,{intentRef:'sample.unknown'})]) assert.notEqual((await run(h,bytes)).state.state,'ready');
  assert.equal(h.snapshot().effects,0);
});
test('agent delegation admits bounded read but refuses action and other tenant',async()=>{
  const h=createFixtureHost();h.setIdentity('agent');
  assert.equal((await run(h,request(h,{mode:'connected-read-only'}))).state.state,'ready');
  assert.equal((await run(h,action(h))).state.state,'forbidden');assert.equal(h.snapshot().effects,0);
  h.setIdentity('other-tenant');assert.equal((await run(h)).state.state,'forbidden');
  h.setIdentity('signed-out');assert.equal((await run(h)).state.state,'unauthenticated');
});
test('forged channels cannot authenticate and old channels expire after adapter change',async()=>{
  const h=createFixtureHost(),old=h.newChannel();
  assert.equal((await h.handle({generation:1},request(h))).state.state,'stale');
  h.setIdentity('human','assertion-membership'); assert.equal((await h.handle(old,request(h))).state.state,'stale');
});
for(const field of ['mode','tenantRef','workspaceRef','audienceRef','requestDigest','delegationRevision','policyRevision','generation','principal','target','expiresAt']) test('decision substitution refused: '+field,async()=>{
  const h=createFixtureHost();const ports={...h.ports,authorize:async b=>({outcome:'allow',binding:{...b,[field]:'altered'}})};
  const enforcer=createPreviewEnforcer(ports);const result=await enforcer.handle(h.newChannel(),action(h));
  assert.equal(result.state.state,'unavailable');assert.equal(h.snapshot().effects,0);
});
test('delegation expiry, widening and actor mismatches refuse',async()=>{
  for(const patch of [d=>d.expiresAt=0,d=>d.redelegationAllowed=true,d=>d.actor={issuer:'other',subject:'other',kind:'agent'},d=>d.workspaceRef='other',d=>d.active=false]) {
    const h=createFixtureHost();h.setIdentity('agent');
    const ports={...h.ports,authenticate:async c=>{const s=await h.ports.authenticate(c);patch(s.delegation);return s;}};
    assert.notEqual((await createPreviewEnforcer(ports).handle(h.newChannel(),request(h))).state.state,'ready');
  }
});
test('expiry, abort, stale source and unavailable ports fail closed',async()=>{
  let now=1000;const h=createFixtureHost({clock:()=>now});const channel=h.newChannel();now+=60001;
  assert.equal((await h.handle(channel,request(h))).state.state,'expired');
  const abort=new AbortController();abort.abort();assert.equal((await h.handle(h.newChannel(),request(h),abort.signal)).state.state,'stale');
  const old=request(h);h.setSource(placementBytes('Changed'));assert.equal((await run(h,old)).state.state,'stale');
  const ports={...h.ports,authorize:async()=>{throw new Error('private credential detail');}};
  const result=await createPreviewEnforcer(ports,{now:()=>now}).handle(h.newChannel(),request(h));assert.equal(result.state.state,'unavailable');assert(!JSON.stringify(result).includes('credential'));
});
test('independent service check refuses identity changed after root revalidation',async()=>{
  let h;h=createFixtureHost({hooks:{beforeService:()=>h.setIdentity('signed-out')}});
  assert.equal((await run(h,action(h))).state.state,'forbidden');assert.equal(h.snapshot().effects,0);
});
for(const hook of ['project','afterEffect']) test('identity change during '+hook+' suppresses output without inventing rollback',async()=>{
  let h;h=createFixtureHost({hooks:{[hook]:async()=>{await Promise.resolve();h.setIdentity('signed-out');}}});
  const result=await run(h,action(h));assert.equal(result.state.state,'stale');assert.equal(result.projectedData,undefined);
  assert.equal(h.snapshot().effects,1);assert(h.events.some(e=>e.outcome==='uncertain'));
});
test('settlement audit cannot race identity change into protected output',async()=>{
  let h;h=createFixtureHost({hooks:{audit:async e=>{if(e.outcome==='prepared')h.setIdentity('signed-out');}}});
  const result=await run(h);assert.equal(result.state.state,'stale');assert.equal(result.projectedData,undefined);
  assert(!h.events.some(e=>e.outcome==='delivered'));
});
test('audit failures prevent service; post-effect audit failure reports unavailable and uncertain',async()=>{
  for(const phase of ['requested','authorized','settled']) {
    const h=createFixtureHost({hooks:{audit:e=>{if(e.phase===phase)throw new Error('fixture audit offline');}}});
    assert.equal((await run(h,action(h))).state.state,'unavailable');assert.equal(h.snapshot().effects,phase==='settled'?1:0);
  }
});
test('oversized or unfiltered metadata cannot enter result envelope',async()=>{
  const h=createFixtureHost();const ports={...h.ports,projectResult:async()=>({value:'x'.repeat(65536)})};
  const result=await createPreviewEnforcer(ports).handle(h.newChannel(),request(h));assert.equal(result.state.state,'unavailable');assert.equal(result.projectedData,undefined);
});
test('concurrent same-version actions settle exactly one effect',async()=>{
  const h=createFixtureHost();const results=await Promise.all([run(h,action(h)),run(h,action(h,{requestId:'request.2'}))]);
  assert.equal(results.filter(v=>v.state.state==='ready').length,1);assert.equal(h.snapshot().effects,1);
});
