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

// readOldContract(contractFile) -> schema object, or null when the contract did
// not exist at the baseline. Injected so test/contract-compat.test.mjs can run
// the same plumbing in self-consistency mode (baseline = the working tree).
export async function checkCompat({ readOldContract, corpus = CONTRACT_CORPUS, root = CORPUS_ROOT }) {
  const checked = []
  const skipped = []
  const failures = []

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

  const ref = baselineOverride ?? baselineDoc.baselineTag
  if (ref === null || ref === undefined) {
    console.log('contract-compat: epoch not yet tagged; gate inert')
    return
  }

  const git = (gitArgs) =>
    execFileSync('git', ['-C', CORPUS_ROOT, ...gitArgs], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    })
  try {
    git(['rev-parse', '--verify', `${ref}^{commit}`])
  } catch {
    usageError(`baseline ref does not resolve: ${ref}`)
  }

  const cache = new Map()
  const readOldContract = (contractFile) => {
    if (!cache.has(contractFile)) {
      let text = null
      try {
        text = git(['show', `${ref}:${contractFile}`])
      } catch {
        text = null // absent at the baseline
      }
      cache.set(contractFile, text === null ? null : JSON.parse(text))
    }
    return cache.get(contractFile)
  }

  const { checked, skipped, failures } = await checkCompat({ readOldContract })

  for (const file of skipped) console.log(`contract-compat: new since baseline: ${file} (skipped)`)
  for (const failure of failures) {
    console.error(`contract-compat: ${failure.subject} rejected by ${ref} validator for ${failure.entry}:`)
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
