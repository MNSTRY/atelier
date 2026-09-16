// Browser-only channel. Host/session/service authority never enters this module.
import { parseRequest, parseBoundedJSON, closed, need, isRef, isDigest, MODES } from '../composition/wire.mjs';
const HELLO = 'atelier.preview.mount/experimental-v1';
function origin(value) { const u = new URL(value); need(u.origin !== 'null' && u.protocol === 'https:' && u.origin === value); return value; }
function resultCheck(bytes, request, generation) {
  const result = parseBoundedJSON(bytes);
  closed(result, ['state'], ['projectedData']);
  const s = result.state;
  closed(s, ['schema', 'requestId', 'placementId', 'sourceDigest', 'mode', 'state', 'sessionGeneration', 'publicMessage']);
  need(s.schema === 'atelier-preview-state/proposal-v1' && s.requestId === request.requestId && s.placementId === request.placementId && s.sourceDigest === request.sourceDigest && s.mode === request.mode);
  need(s.sessionGeneration === generation && ['loading', 'ready', 'unauthenticated', 'forbidden', 'expired', 'unavailable', 'stale'].includes(s.state));
  need(typeof s.publicMessage === 'string' && s.publicMessage.length <= 160);
  need(s.state === 'ready' ? Object.hasOwn(result, 'projectedData') : !Object.hasOwn(result, 'projectedData'));
  return result;
}
function fail(request, generation) { return { state: { schema: 'atelier-preview-state/proposal-v1', requestId: request.requestId, placementId: request.placementId,
  sourceDigest: request.sourceDigest, mode: request.mode, state: 'unavailable', sessionGeneration: generation, publicMessage: 'Preview unavailable.' } }; }

export function mountPreview({ frame, previewOrigin, requestBytes, generation, handle, onState = () => {} }) {
  origin(previewOrigin); need(new URL(frame.src).origin === previewOrigin && previewOrigin !== window.location.origin);
  const template = parseRequest(requestBytes); need(!template.intentRef && Number.isSafeInteger(generation) && generation >= 0 && typeof handle === 'function');
  const nonce = crypto.randomUUID(), channel = new MessageChannel(), controller = new AbortController();
  let active = true, ready = false, sequence = 0, latest = 0;
  const invalidate = () => {
    if (!active) return; active = false; controller.abort();
    channel.port1.postMessage(JSON.stringify({type:'invalidate',nonce})); channel.port1.close(); frame.removeEventListener('load', invalidate);
    onState('stale');
  };
  frame.addEventListener('load', invalidate); // Future navigation invalidates this mount.
  channel.port1.onmessage = async event => {
    if (!active) return;
    try {
      const v = parseBoundedJSON(event.data);
      if (!ready) { closed(v, ['type', 'nonce']); need(v.type === 'ready' && v.nonce === nonce); ready = true; onState('connected'); return; }
      closed(v, ['type', 'nonce', 'sequence', 'request']);
      need(v.type === 'request' && v.nonce === nonce && Number.isSafeInteger(v.sequence) && v.sequence > sequence);
      const request = parseRequest(v.request);
      need(request.placementId === template.placementId && request.sourceDigest === template.sourceDigest && request.mode === template.mode);
      sequence = v.sequence; latest = sequence; const thisSequence = sequence;
      let result;
      try { result = resultCheck(JSON.stringify(await handle(v.request, controller.signal)), request, generation); }
      catch { result = fail(request, generation); }
      if (!active || controller.signal.aborted || thisSequence !== latest) return;
      channel.port1.postMessage(JSON.stringify({ type: 'result', nonce, sequence: thisSequence, result }));
    } catch { invalidate(); }
  };
  channel.port1.start();
  frame.contentWindow.postMessage(JSON.stringify({ type: HELLO, nonce, generation, request: requestBytes }), previewOrigin, [channel.port2]);
  return Object.freeze({ dispose: invalidate });
}

export function receivePreview({ shellOrigin, onMount, onResult, onInvalidate = () => {} }) {
  origin(shellOrigin); need(shellOrigin !== window.location.origin);
  let active = null;
  function clear() { active?.port.close(); active = null; onInvalidate(); }
  function receive(event) {
    if (event.origin !== shellOrigin || event.source !== window.parent) return;
    try {
      const v = parseBoundedJSON(event.data);
      closed(v, ['type', 'nonce', 'generation', 'request']);
      need(v.type === HELLO && isRef(v.nonce) && Number.isSafeInteger(v.generation) && v.generation >= 0 && event.ports.length === 1);
      const request = parseRequest(v.request); need(!request.intentRef && isDigest(request.sourceDigest) && MODES.includes(request.mode));
      clear();
      const mount = { port: event.ports[0], nonce: v.nonce, generation: v.generation, request, sequence: 0, settled: 0 };
      active = mount;
      mount.port.onmessage = e => {
        if (active !== mount) return;
        try {
          const packet = parseBoundedJSON(e.data);
          if (packet?.type === 'invalidate') { closed(packet, ['type','nonce']); need(packet.nonce === mount.nonce); clear(); return; }
          closed(packet, ['type', 'nonce', 'sequence', 'result']);
          need(packet.type === 'result' && packet.nonce === mount.nonce && packet.sequence === mount.sequence && packet.sequence > mount.settled);
          const result = resultCheck(JSON.stringify(packet.result), mount.pending, mount.generation);
          mount.settled = packet.sequence; onResult(result);
        } catch { clear(); }
      };
      mount.port.start(); mount.port.postMessage(JSON.stringify({ type: 'ready', nonce: mount.nonce }));
      onMount(request);
    } catch { clear(); }
  }
  window.addEventListener('message', receive);
  return Object.freeze({ request(intent) {
    if (!active) return false;
    const sequence = ++active.sequence;
    const request = { ...active.request, requestId: crypto.randomUUID(), ...(intent ? { schema: 'atelier-component-intent/proposal-v1', intentRef: intent.ref, payload: intent.payload } : {}) };
    parseRequest(JSON.stringify(request)); active.pending = request;
    active.port.postMessage(JSON.stringify({ type: 'request', nonce: active.nonce, sequence, request: JSON.stringify(request) })); return true;
  }, dispose() { clear(); window.removeEventListener('message', receive); } });
}
