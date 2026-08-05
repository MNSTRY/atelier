#!/usr/bin/env node

// Contract compatibility gate. Compiles every corpus contract as it stood at a
// baseline ref and validates the CURRENT corpus documents against it: a document
// the epoch's validator would reject is a breaking contract change.
//
// Usage:
//   node scripts/check-contract-compat.mjs [--baseline <ref>]
//
// Baseline precedence: --baseline <ref> -> contracts/compat-baseline.json
// baselineTag -> null. A null baseline means the contract-stability epoch has no
// tag yet; the gate prints an inert notice and exits 0. Cutting the epoch tag
// sets baselineTag in the release commit (see docs/contract-stability.md).
//
// Contracts absent at the baseline are new since it and are skipped, which
// covers both the first run and every future contract addition.
//
// Exit codes: 0 clean or inert, 1 rejections, 2 config or usage error.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { CONTRACT_CORPUS, CORPUS_ROOT, corpusValidFiles } from '../src/contracts/corpus.mjs'

const BASELINE_FILE = path.join(CORPUS_ROOT, 'contracts', 'compat-baseline.json')

export function compileContract(schema, docPointer) {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
  })
  addFormats(ajv)
  if (!docPointer) return ajv.compile(schema)
  // Validate a $defs subschema by re-rooting it in a wrapper; the contract's
  // internal refs are all '#/$defs/...' so they resolve against the wrapper.
  // (A urn:-style addSchema key is not an option — ajv 8.18's fast-uri rejects it.)
  return ajv.compile({ $schema: schema.$schema, $defs: schema.$defs, $ref: docPointer })
}

function formatErrors(validate) {
  return (validate.errors ?? [])
    .map((error) => `  ${error.instancePath || '/'} ${error.message}`)
    .join('\n')
}

// Schema-vs-schema widening differ. Document validation alone cannot see a
// contract WIDENING (the current documents still satisfy the widened schema),
// so every baseline/current schema pair is also compared structurally and any
// loosening is a rejection. These are public schemas, so member names in the
// findings are fine; document content never appears here.
const DIFF_DATA_KEYWORDS = new Set(['enum', 'const', 'default', 'examples', 'required'])
const DIFF_MAP_KEYWORDS = new Set(['properties', 'patternProperties', '$defs', 'definitions'])
const DIFF_MIN_KEYWORDS = ['minLength', 'minItems', 'minimum']
const DIFF_MAX_KEYWORDS = ['maxLength', 'maxItems', 'maximum']
const DIFF_ABSENCE_KEYWORDS = [
  'enum', 'not', 'allOf', 'anyOf', 'oneOf', 'if', 'then', 'else', 'items',
  'prefixItems', 'propertyNames', 'uniqueItems', 'multipleOf', 'format',
  'contains', 'dependentRequired',
]
const DIFF_COMBINATOR_KEYWORDS = ['allOf', 'anyOf', 'oneOf']

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function diffPointer(parts) {
  return `/${parts.map((part) => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`
}

export function diffSchemaWidenings(oldSchema, newSchema) {
  const findings = []
  walkSchemaPair(oldSchema, newSchema, [], findings)
  return findings
}

function walkSchemaPair(oldNode, newNode, parts, findings) {
  if (!isPlainObject(oldNode) || !isPlainObject(newNode)) return
  const at = parts.length === 0 ? '/' : diffPointer(parts)
  const flag = (message) => findings.push({ pointer: at, message })

  if (Array.isArray(oldNode.enum) && Array.isArray(newNode.enum)) {
    const oldMembers = new Set(oldNode.enum.map((member) => JSON.stringify(member)))
    const gained = newNode.enum.filter((member) => !oldMembers.has(JSON.stringify(member)))
    if (gained.length > 0) flag(`enum gained member(s): ${gained.map((member) => JSON.stringify(member)).join(', ')}`)
  }
  // Deleting a constraint outright is the widest widening of all. Keywords with
  // their own specific absence handling above/below (const, pattern, min*/max*,
  // additionalProperties, required) are excluded here.
  for (const keyword of DIFF_ABSENCE_KEYWORDS) {
    if (oldNode[keyword] !== undefined && newNode[keyword] === undefined) {
      flag(`${keyword} constraint removed`)
    }
  }
  // Combinator arrays: pairwise comparison is only meaningful when the rule
  // count is unchanged; any count change (dropped OR inserted rules) shifts
  // indices and must be reviewed rather than silently mis-paired.
  for (const keyword of DIFF_COMBINATOR_KEYWORDS) {
    if (Array.isArray(oldNode[keyword]) && Array.isArray(newNode[keyword]) && oldNode[keyword].length !== newNode[keyword].length) {
      flag(`${keyword} rule count changed (${oldNode[keyword].length} -> ${newNode[keyword].length}) — combinator changes require review`)
    }
  }
  if (Array.isArray(oldNode.required)) {
    const newRequired = new Set(Array.isArray(newNode.required) ? newNode.required : [])
    const lost = oldNode.required.filter((name) => !newRequired.has(name))
    if (lost.length > 0) flag(`required lost member(s): ${lost.join(', ')}`)
  }
  if (oldNode.additionalProperties === false && newNode.additionalProperties !== false) {
    flag(`additionalProperties weakened (false -> ${newNode.additionalProperties === undefined ? 'absent' : JSON.stringify(newNode.additionalProperties)})`)
  }
  if (oldNode.type !== undefined && JSON.stringify(oldNode.type) !== JSON.stringify(newNode.type)) {
    flag(`type changed (${JSON.stringify(oldNode.type)} -> ${newNode.type === undefined ? 'absent' : JSON.stringify(newNode.type)})`)
  }
  if (oldNode.const !== undefined && JSON.stringify(oldNode.const) !== JSON.stringify(newNode.const)) {
    flag(`const changed or removed (${JSON.stringify(oldNode.const)} -> ${newNode.const === undefined ? 'absent' : JSON.stringify(newNode.const)})`)
  }
  if (oldNode.pattern !== undefined && oldNode.pattern !== newNode.pattern) {
    flag(`pattern changed (${JSON.stringify(oldNode.pattern)} -> ${newNode.pattern === undefined ? 'absent' : JSON.stringify(newNode.pattern)})`)
  }
  for (const keyword of DIFF_MIN_KEYWORDS) {
    if (typeof oldNode[keyword] !== 'number') continue
    if (typeof newNode[keyword] !== 'number' || newNode[keyword] < oldNode[keyword]) {
      flag(`${keyword} decreased or removed (${oldNode[keyword]} -> ${typeof newNode[keyword] === 'number' ? newNode[keyword] : 'absent'})`)
    }
  }
  for (const keyword of DIFF_MAX_KEYWORDS) {
    if (typeof oldNode[keyword] !== 'number') continue
    if (typeof newNode[keyword] !== 'number' || newNode[keyword] > oldNode[keyword]) {
      flag(`${keyword} increased or removed (${oldNode[keyword]} -> ${typeof newNode[keyword] === 'number' ? newNode[keyword] : 'absent'})`)
    }
  }
  if (oldNode.additionalProperties === false && isPlainObject(oldNode.properties) && isPlainObject(newNode.properties)) {
    // No exemptions: even the sanctioned epoch additions (ext, contractVersion)
    // are reported, so the alpha.2 negative control shows the epoch honestly.
    for (const key of Object.keys(newNode.properties)) {
      if (!Object.hasOwn(oldNode.properties, key)) {
        findings.push({ pointer: diffPointer([...parts, 'properties', key]), message: 'new property key added to a closed object' })
      }
    }
  }

  for (const [key, oldChild] of Object.entries(oldNode)) {
    if (DIFF_DATA_KEYWORDS.has(key)) continue
    const newChild = newNode[key]
    if (DIFF_MAP_KEYWORDS.has(key)) {
      if (!isPlainObject(oldChild) || !isPlainObject(newChild)) continue
      for (const [mapKey, oldEntry] of Object.entries(oldChild)) {
        walkSchemaPair(oldEntry, newChild[mapKey], [...parts, key, mapKey], findings)
      }
      continue
    }
    if (Array.isArray(oldChild) && Array.isArray(newChild)) {
      const shared = Math.min(oldChild.length, newChild.length)
      for (let index = 0; index < shared; index += 1) {
        walkSchemaPair(oldChild[index], newChild[index], [...parts, key, index], findings)
      }
      continue
    }
    walkSchemaPair(oldChild, newChild, [...parts, key], findings)
  }
}

// readOldContract(contractFile) -> schema object, or null when the contract did
// not exist at the baseline. Injected so test/contract-compat.test.mjs can run
// the same plumbing in self-consistency mode (baseline = the working tree).
// readCurrentContract is injectable for the same reason: the widening-differ
// positive controls substitute a deliberately widened current schema.
export async function checkCompat({ readOldContract, readCurrentContract, corpus = CONTRACT_CORPUS, root = CORPUS_ROOT }) {
  const checked = []
  const skipped = []
  const failures = []
  const readCurrent =
    readCurrentContract ?? ((contractFile) => JSON.parse(fs.readFileSync(path.join(root, contractFile), 'utf8')))

  for (const entry of corpus) {
    let oldSchema
    try {
      oldSchema = await readOldContract(entry.contractFile)
    } catch (error) {
      failures.push({ entry: entry.name, subject: entry.contractFile, message: `unreadable at baseline: ${error.message}` })
      continue
    }
    if (oldSchema === null) {
      skipped.push(entry.contractFile)
      continue
    }

    let currentSchema
    try {
      currentSchema = await readCurrent(entry.contractFile)
    } catch (error) {
      failures.push({ entry: entry.name, subject: entry.contractFile, message: `current contract unreadable: ${error.message}` })
      continue
    }
    for (const widening of diffSchemaWidenings(oldSchema, currentSchema)) {
      failures.push({
        entry: entry.name,
        subject: entry.contractFile,
        kind: 'widening',
        message: `  ${widening.pointer} ${widening.message}`,
      })
    }

    let validate
    try {
      validate = compileContract(oldSchema, entry.docPointer)
    } catch (error) {
      failures.push({ entry: entry.name, subject: entry.contractFile, message: `baseline schema failed to compile: ${error.message}` })
      continue
    }

    const documents = corpusValidFiles(entry, root).map((file) => ({
      label: path.relative(root, file),
      doc: JSON.parse(fs.readFileSync(file, 'utf8')),
    }))
    if (entry.loadGeneratedDocs) {
      const generated = await entry.loadGeneratedDocs()
      generated.forEach((doc, index) => {
        documents.push({ label: `${entry.name} generated document #${index}`, doc })
      })
    }
    if (documents.length === 0) {
      failures.push({ entry: entry.name, subject: entry.contractFile, message: 'no current documents to check' })
      continue
    }

    for (const { label, doc } of documents) {
      if (validate(doc)) continue
      failures.push({ entry: entry.name, subject: label, message: formatErrors(validate) })
    }
    checked.push({ entry: entry.name, documents: documents.length })
  }

  if (checked.length === 0 && corpus.length > 0) {
    // Every entry skipping (for example after a path move the baseline ref
    // cannot see) would otherwise print clean over zero documents.
    failures.push({ entry: '(gate)', subject: '(corpus)', kind: 'gate', message: 'compat gate checked nothing — refusing to pass' })
  }

  return { checked, skipped, failures }
}

function usageError(message) {
  console.error(`[contract:compat] ${message}`)
  process.exit(2)
}

async function main() {
  const args = process.argv.slice(2)
  let baselineOverride = null
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--baseline') {
      i += 1
      if (!args[i]) usageError('--baseline requires a ref')
      baselineOverride = args[i]
    } else {
      usageError(`unknown argument: ${args[i]}`)
    }
  }

  let baselineDoc
  try {
    baselineDoc = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'))
  } catch (error) {
    usageError(`unable to read contracts/compat-baseline.json: ${error.message}`)
  }
  if (baselineDoc.schema !== 'atelier-compat-baseline@v1') {
    usageError(`unexpected baseline document schema: ${baselineDoc.schema}`)
  }

  const git = (gitArgs) =>
    execFileSync('git', ['-C', CORPUS_ROOT, ...gitArgs], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    })

  const ref = baselineOverride ?? baselineDoc.baselineTag
  if (ref === null || ref === undefined) {
    // Inert is only legitimate while no post-epoch tag exists. The moment a
    // tag outside the recorded pre-epoch set appears without baselineTag being
    // armed, a green run would assert nothing — fail instead.
    const preEpoch = new Set(baselineDoc.preEpochTags ?? [])
    const tags = git(['tag', '--list']).split('\n').filter(Boolean)
    const unarmed = tags.filter((tag) => !preEpoch.has(tag))
    if (unarmed.length > 0) {
      console.error(
        `contract-compat: tag(s) exist beyond the pre-epoch set (${unarmed.join(', ')}) but baselineTag is null — arm the gate by recording the epoch baseline in contracts/compat-baseline.json`,
      )
      process.exit(1)
    }
    console.log('contract-compat: epoch not yet tagged; gate inert')
    return
  }
  try {
    git(['rev-parse', '--verify', `${ref}^{commit}`])
  } catch {
    usageError(`baseline ref does not resolve: ${ref}`)
  }

  const cache = new Map()
  const readOldContract = (contractFile) => {
    if (!cache.has(contractFile)) {
      // Only a path verifiably absent at the ref is "new since baseline"; any
      // other git failure must surface as a gate failure, not a silent skip.
      const listing = git(['ls-tree', ref, '--', contractFile])
      if (listing.trim() === '') {
        cache.set(contractFile, null)
      } else {
        cache.set(contractFile, JSON.parse(git(['show', `${ref}:${contractFile}`])))
      }
    }
    return cache.get(contractFile)
  }

  const { checked, skipped, failures } = await checkCompat({ readOldContract })

  for (const file of skipped) console.log(`contract-compat: new since baseline: ${file} (skipped)`)
  for (const failure of failures) {
    if (failure.kind === 'gate') {
      console.error(`contract-compat: ${failure.message}`)
      continue
    }
    if (failure.kind === 'widening') {
      console.error(`contract-compat: ${failure.subject} widened relative to ${ref} for ${failure.entry}:`)
    } else {
      console.error(`contract-compat: ${failure.subject} rejected by ${ref} validator for ${failure.entry}:`)
    }
    console.error(failure.message)
  }
  if (failures.length > 0) {
    console.error(`contract-compat: ${failures.length} rejection(s) against ${ref}`)
    process.exit(1)
  }

  const documents = checked.reduce((total, item) => total + item.documents, 0)
  console.log(
    `contract-compat: clean against ${ref} — ${documents} document(s) across ${checked.length} contract(s), ${skipped.length} new since baseline`,
  )
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main()
}
