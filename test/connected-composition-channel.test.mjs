import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { MessageChannel } from 'node:worker_threads';
import { mountPreview, receivePreview } from '../src/preview/channel.mjs';

const request={schema:'atelier-preview-request/proposal-v1',status:'proposed',requestId:'request.1',placementId:'placement.1',sourceDigest:'1'.repeat(64),mode:'synthetic'};
function response(r=request,generation=1){return{state:{schema:'atelier-preview-state/proposal-v1',requestId:r.requestId,placementId:r.placementId,sourceDigest:r.sourceDigest,mode:r.mode,state:'ready',sessionGeneration:generation,publicMessage:'Preview ready.'},projectedData:{heading:'Fixture'}};}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function shellHarness(handle=async()=>response()) {
  const old=globalThis.window, listeners=new Map(), states=[];
  globalThis.window={location:{origin:'https://127.0.0.1:4180'}};
  let hello,port;
  const frame={src:'https://127.0.0.1:4181/preview/',addEventListener:(type,fn)=>listeners.set(type,fn),removeEventListener:(type,fn)=>{if(listeners.get(type)===fn)listeners.delete(type);},
    contentWindow:{postMessage:(bytes,target,ports)=>{assert.equal(target,'https://127.0.0.1:4181');hello=JSON.parse(bytes);port=ports[0];}}};
  const mount=mountPreview({frame,previewOrigin:'https://127.0.0.1:4181',requestBytes:JSON.stringify(request),generation:1,handle,onState:value=>states.push(value)});
  port.start();
  return {mount,states,hello,port,listeners,
    ack(nonce=hello.nonce){port.postMessage(JSON.stringify({type:'ready',nonce}));},
    send(sequence=1,changes={}){port.postMessage(JSON.stringify({type:'request',nonce:hello.nonce,sequence,request:JSON.stringify({...request,...changes})}));},
    close(){mount.dispose();port.close();globalThis.window=old;},
  };
}
test('mount refuses invalid handshake and does not invoke trusted handler',async()=>{
  let calls=0;const h=shellHarness(async()=>{calls++;return response();});
  try{const invalidated=once(h.port,'message');h.ack('wrong');assert.equal(JSON.parse((await invalidated)[0]).type,'invalidate');assert.equal(calls,0);assert.deepEqual(h.states,['stale']);}finally{h.close();}
});
test('source and mode drift invalidate a mount before invoking host',async()=>{
  for(const changes of [{sourceDigest:'2'.repeat(64)},{placementId:'other'},{mode:'connected-read-only'}]){
    let calls=0;const h=shellHarness(async()=>{calls++;return response();});
    try{h.ack();h.send(1,changes);const [bytes]=await once(h.port,'message');assert.equal(JSON.parse(bytes).type,'invalidate');assert.equal(calls,0);}finally{h.close();}
  }
});
test('same-sequence replay refuses and does not repeat service call',async()=>{
  let calls=0;const h=shellHarness(async()=>{calls++;return response();});
  try{h.ack();h.send();assert.equal(JSON.parse((await once(h.port,'message'))[0]).type,'result');h.send();assert.equal(JSON.parse((await once(h.port,'message'))[0]).type,'invalidate');assert.equal(calls,1);}finally{h.close();}
});
test('superseded slow response cannot replace a newer result',async()=>{
  let release,started;const first=new Promise(resolve=>{started=resolve;});
  const h=shellHarness(async bytes=>{const r=JSON.parse(bytes);if(r.requestId==='request.1'){started();await new Promise(resolve=>{release=resolve;});}return response(r);});
  try{h.ack();h.send();await first;h.send(2,{requestId:'request.2'});const result=JSON.parse((await once(h.port,'message'))[0]);assert.equal(result.result.state.requestId,'request.2');
    let extra=0;h.port.on('message',()=>extra++);release();await tick();await tick();assert.equal(extra,0);
  }finally{h.close();}
});
test('disposing pending mount aborts its handler and suppresses protected data',async()=>{
  let release,started,observed;const first=new Promise(resolve=>{started=resolve;});
  const h=shellHarness(async(bytes,signal)=>{observed=signal;started();await new Promise(resolve=>{release=resolve;});return response();});
  try{h.ack();h.send();await first;const message=once(h.port,'message');h.mount.dispose();assert(observed.aborted);release();assert.equal(JSON.parse((await message)[0]).type,'invalidate');assert(h.states.includes('stale'));}finally{h.close();}
});
test('host result metadata substitution produces generic unavailable envelope',async()=>{
  const h=shellHarness(async()=>response(request,42));
  try{h.ack();h.send();const packet=JSON.parse((await once(h.port,'message'))[0]);assert.equal(packet.result.state.state,'unavailable');assert.equal(packet.result.projectedData,undefined);}finally{h.close();}
});
test('future frame navigation invalidates even an idle mount',()=>{
  const h=shellHarness();try{h.listeners.get('load')();assert.deepEqual(h.states,['stale']);assert.equal(h.listeners.has('load'),false);}finally{h.close();}
});
test('receiver ignores wrong window/origin and closes duplicate results',async()=>{
  const old=globalThis.window,listeners=new Map(),parent={},results=[],invalidations=[];
  globalThis.window={location:{origin:'https://127.0.0.1:4181'},parent,addEventListener:(type,fn)=>listeners.set(type,fn),removeEventListener:type=>listeners.delete(type)};
  let receiver;const channel=new MessageChannel();
  try{
    receiver=receivePreview({shellOrigin:'https://127.0.0.1:4180',onMount:()=>receiver.request(),onResult:r=>results.push(r),onInvalidate:()=>invalidations.push(1)});
    const send=(origin,source)=>listeners.get('message')({origin,source,data:JSON.stringify({type:'atelier.preview.mount/experimental-v1',nonce:'mount.1',generation:1,request:JSON.stringify(request)}),ports:[channel.port2]});
    send('null',parent);send('https://127.0.0.1:4180',{});assert.equal(invalidations.length,0);
    const messages=[];channel.port1.on('message',bytes=>messages.push(JSON.parse(bytes)));channel.port1.start();
    send('https://127.0.0.1:4180',parent);
    while(messages.length<2)await tick();
    const r=JSON.parse(messages[1].request),packet={type:'result',nonce:'mount.1',sequence:1,result:response(r)};
    channel.port1.postMessage(JSON.stringify(packet));while(!results.length)await tick();assert.equal(results.length,1);
    const before=invalidations.length;channel.port1.postMessage(JSON.stringify(packet));while(invalidations.length===before)await tick();assert.equal(results.length,1);assert.equal(receiver.request(),false);
  }finally{receiver?.dispose();channel.port1.close();channel.port2.close();globalThis.window=old;}
});
