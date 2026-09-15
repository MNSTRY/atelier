// Opt-in experimental wire parser. No identity, URL resolution or execution.
export const MODES = Object.freeze(['synthetic', 'connected-read-only', 'sandbox-interactive']);
const REF = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/;
const HASH = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export function need(value, message = 'Invalid bounded composition data') { if (!value) throw new TypeError(message); }
export const isRef = value => typeof value === 'string' && REF.test(value);
export const isDigest = value => typeof value === 'string' && HASH.test(value);
export function closed(value, required, optional = []) {
  need(value && typeof value === 'object' && !Array.isArray(value));
  need(required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key)));
}

// JSON.parse alone accepts duplicate keys. This small JSON grammar refuses them
// at every depth, before schema validation; it never evaluates source text.
export function parseBoundedJSON(input) {
  need(typeof input === 'string' || input instanceof Uint8Array);
  const bytes = typeof input === 'string' ? encoder.encode(input) : input;
  need(bytes.byteLength <= 65536);
  let text = decoder.decode(bytes);
  if (typeof input === 'string') need(text === input, 'Lossy Unicode refused');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let i = 0;
  const ws = () => { while (/[\x20\t\r\n]/.test(text[i] || '\0')) i++; };
  const string = () => {
    const start = i++;
    while (i < text.length) {
      const c = text[i++];
      if (c === '\\') { i++; continue; }
      if (c === '"') {
        const value = JSON.parse(text.slice(start, i));
        need(decoder.decode(encoder.encode(value)) === value, 'Lossy Unicode refused');
        return value;
      }
    }
    throw new TypeError('Unterminated JSON string');
  };
  function value(depth) {
    need(depth <= 8); ws();
    if (text[i] === '"') return string();
    if (text[i] === '{') {
      i++; ws(); const result = Object.create(null);
      if (text[i] === '}') { i++; return result; }
      while (i < text.length) {
        ws(); need(text[i] === '"'); const key = string();
        need(!Object.hasOwn(result, key), 'Duplicate JSON key refused');
        ws(); need(text[i++] === ':'); result[key] = value(depth + 1); ws();
        if (text[i] === '}') { i++; return result; }
        need(text[i++] === ',');
      }
    } else if (text[i] === '[') {
      i++; ws(); const result = [];
      if (text[i] === ']') { i++; return result; }
      while (i < text.length) {
        result.push(value(depth + 1)); ws();
        if (text[i] === ']') { i++; return result; }
        need(text[i++] === ',');
      }
    } else {
      const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
      need(match); i += match[0].length;
      const result = JSON.parse(match[0]); need(typeof result !== 'number' || Number.isFinite(result)); return result;
    }
    throw new TypeError('Invalid JSON');
  }
  const result = value(0); ws(); need(i === text.length); return result;
}
export function scalarMap(value) {
  need(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length <= 64);
  for (const [key, v] of Object.entries(value)) {
    need(/^[a-z][a-zA-Z0-9_]{0,79}$/.test(key) && !forbidden.has(key));
    need(v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 4096));
  }
  return value;
}
function refs(values, maximum, allowed) {
  need(Array.isArray(values) && values.length <= maximum && new Set(values).size === values.length);
  need(values.every(v => allowed ? allowed.includes(v) : isRef(v)));
}
function version(v) { need(typeof v === 'string' && v.length <= 32 && VERSION.test(v)); }
export function parseDefinition(bytes) {
  const v = parseBoundedJSON(bytes);
  closed(v, ['schema', 'componentId', 'version', 'rendererRef', 'propsSchemaRef', 'dataContractRefs', 'projections', 'previewModes']);
  need(v.schema === 'atelier-component-definition/proposal-v1');
  for (const key of ['componentId', 'rendererRef', 'propsSchemaRef']) need(isRef(v[key]));
  version(v.version); refs(v.dataContractRefs, 16); refs(v.projections, 4, ['web', 'native', 'desktop', 'document']); refs(v.previewModes, 3, MODES);
  return v;
}
export function parsePlacement(bytes) {
  const v = parseBoundedJSON(bytes);
  closed(v, ['schema', 'placementId', 'componentId', 'componentVersion', 'slotRef', 'props', 'dataBindings']);
  need(v.schema === 'atelier-component-placement/proposal-v1');
  for (const key of ['placementId', 'componentId', 'slotRef']) need(isRef(v[key]));
  version(v.componentVersion); scalarMap(v.props);
  need(Array.isArray(v.dataBindings) && v.dataBindings.length <= 16);
  const seen = new Set();
  for (const binding of v.dataBindings) {
    closed(binding, ['contractRef', 'resourceRef']); need(isRef(binding.contractRef) && isRef(binding.resourceRef) && !seen.has(binding.contractRef)); seen.add(binding.contractRef);
  }
  return v;
}
export function parseRequest(bytes) {
  const v = parseBoundedJSON(bytes);
  const action = v?.schema === 'atelier-component-intent/proposal-v1';
  closed(v, ['schema', 'status', 'requestId', 'placementId', 'sourceDigest', 'mode', ...(action ? ['intentRef', 'payload'] : [])]);
  need(action || v.schema === 'atelier-preview-request/proposal-v1'); need(v.status === 'proposed' && MODES.includes(v.mode));
  need(isRef(v.requestId) && isRef(v.placementId) && isDigest(v.sourceDigest));
  if (action) { need(isRef(v.intentRef)); scalarMap(v.payload); need(v.mode === 'sandbox-interactive'); }
  return v;
}
export function deepFreeze(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); }
  return value;
}
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
