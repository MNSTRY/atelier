import fs from 'node:fs'
import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { objectDigest } from '../capabilities/files.mjs'

const schema = JSON.parse(fs.readFileSync(new URL('../../contracts/atelier-inquiry.v1.schema.json', import.meta.url), 'utf8'))
const ajv = new Ajv({ allErrors: true, strict: true })
addFormats(ajv)
const validators = new Map()
export const INQUIRY_LIMITS = Object.freeze({ records: 256, bytes: 8 * 1024 * 1024 })
export const inquiryDigest = objectDigest
export const inquiryRef = record => ({ id: record.id, digest: inquiryDigest(record) })
export function validateInquiryDocument(document, shape = 'record') {
  if (!Object.hasOwn(schema.$defs, shape)) return ['unknown inquiry document shape']
  if (!validators.has(shape)) validators.set(shape, ajv.compile({ $schema: schema.$schema, $defs: schema.$defs, $ref: `#/$defs/${shape}` }))
  const validator = validators.get(shape)
  return validator(document) ? [] : validator.errors.map(e => `${e.instancePath || '/'}: ${e.message}`)
}
export function assertInquiry(document, shape = 'record') {
  const errors = validateInquiryDocument(document, shape)
  if (errors.length) throw new Error(`invalid inquiry ${shape}: ${errors.slice(0, 8).join('; ')}`)
  return document
}
