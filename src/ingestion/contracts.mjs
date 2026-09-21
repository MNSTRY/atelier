import fs from 'node:fs';
import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { canonicalize } from '../attestation/jcs.mjs';

export const INGESTION_MAX_PLAN_BYTES = 256 * 1024;
export const INGESTION_MAX_EVIDENCE_ITEMS = 2000;
export const ingestionSchema = JSON.parse(fs.readFileSync(new URL('../../contracts/atelier-ingestion.v1.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ allErrors: false, strict: false }); addFormats(ajv); ajv.addSchema(ingestionSchema);
const validators = new Map();
export function ingestionDigest(value) { return `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`; }
export function validateIngestionValue(definition, value) {
  if (!Object.hasOwn(ingestionSchema.$defs, definition)) return ['unknown ingestion definition'];
  if (!validators.has(definition)) validators.set(definition, ajv.getSchema(`${ingestionSchema.$id}#/$defs/${definition}`));
  return validators.get(definition)(value) ? [] : ['ingestion document does not match its contract'];
}
export function ingestionJson(value) {
  const seen = new Set();
  function visit(item, depth = 0) {
    if (depth > 24) throw new Error('ingestion JSON depth exceeded');
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'string') { if (item.includes('\u0000')) throw new Error('invalid ingestion text'); return; }
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || seen.has(item) || (!Array.isArray(item) && ![null, Object.prototype].includes(Object.getPrototypeOf(item)))) throw new Error('ingestion input must be plain JSON');
    seen.add(item);
    if (Reflect.ownKeys(item).length > 4096) throw new Error('ingestion member ceiling exceeded');
    for (const key of Reflect.ownKeys(item)) {
      if (Array.isArray(item) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('ingestion input must be plain JSON');
      visit(descriptor.value, depth + 1);
    }
    if (Array.isArray(item) && Object.keys(item).length !== item.length) throw new Error('ingestion arrays must be dense');
    seen.delete(item);
  }
  visit(value);
  const text = canonicalize(value);
  if (Buffer.byteLength(text) > INGESTION_MAX_PLAN_BYTES) throw new Error('ingestion document byte ceiling exceeded');
  return JSON.parse(text);
}
