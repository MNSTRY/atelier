import fs from 'node:fs';
import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { canonicalize } from '../attestation/jcs.mjs';

export const LEARNING_MAX_BYTES = 256 * 1024;
export const LEARNING_MAX_EVENTS = 10000;
export const LEARNING_MAX_JOURNAL_BYTES = 32 * 1024 * 1024;
// Minimum ordinary-write headroom; the store also reserves a complete event
// and one event slot for every active binding after each prospective write.
export const LEARNING_WITHDRAWAL_RESERVE_BYTES = 1024 * 1024;
export const LEARNING_WITHDRAWAL_RESERVE_EVENTS = 128;
export const learningSchema = JSON.parse(fs.readFileSync(new URL('../../contracts/atelier-learning.v1.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv); ajv.addSchema(learningSchema);
const validators = new Map();
const operations = new Set(['capture', 'propose', 'decide', 'activate', 'withdraw']);

// Canonical JSON, not a signature or evidence of the identity of the caller.
export function learningDigest(value) {
  return `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`;
}

export function boundedLearningValue(value) {
  const visited = new Set();
  function walk(item, depth) {
    if (depth > 24) throw new Error('learning value exceeds depth ceiling');
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'string') {
      if (item.includes('\u0000') || item.length > LEARNING_MAX_BYTES) throw new Error('invalid learning text');
      return;
    }
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || visited.has(item)) throw new Error('learning value must be JSON');
    if (!Array.isArray(item) && ![null, Object.prototype].includes(Object.getPrototypeOf(item))) throw new Error('learning value must be plain JSON');
    visited.add(item);
    const keys = Reflect.ownKeys(item);
    if (keys.length > 1024) throw new Error('learning value exceeds member ceiling');
    for (const key of keys) {
      if (typeof key !== 'string') throw new Error('learning value must be plain JSON');
      if (Array.isArray(item) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('learning value must be plain JSON');
      walk(descriptor.value, depth + 1);
    }
    if (Array.isArray(item) && Object.keys(item).length !== item.length) throw new Error('learning array must be dense');
    visited.delete(item);
  }
  walk(value, 0);
  if (Buffer.byteLength(canonicalize(value)) > LEARNING_MAX_BYTES) throw new Error('learning value exceeds byte ceiling');
  return structuredClone(value);
}

export function validateLearningValue(definition, value) {
  try { boundedLearningValue(value); } catch (error) { return [error.message]; }
  if (!Object.hasOwn(learningSchema.$defs, definition)) return ['unknown learning definition'];
  if (!validators.has(definition)) validators.set(definition, ajv.getSchema(`${learningSchema.$id}#/$defs/${definition}`));
  const validate = validators.get(definition);
  return validate(value) ? [] : ['learning document does not match the contract'];
}

export function validateLearningInput(operation, input) {
  return operations.has(operation) ? validateLearningValue(`${operation}Input`, input) : ['unknown learning operation'];
}
