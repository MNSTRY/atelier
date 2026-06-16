#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  validateAtelierExportContract,
  validateJsonSchema,
  validateSchemaShape,
} from './export/atelier-export-contract.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(__dirname, '..')
const schemaPath = path.join(packageRoot, 'contracts/atelier-export.v1.schema.json')
const fixtureRoot = path.join(packageRoot, 'fixtures/atelier-export')
const invalidFixtureRoot = path.join(fixtureRoot, 'invalid')

function fail(message) {
  console.error(`[atelier-export-contract:check] ${message}`)
  throw new Error(message)
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    fail(`${path.relative(process.cwd(), file)} is not valid JSON: ${error.message}`)
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function applyPointerMutation(target, pointer, value) {
  if (!pointer.startsWith('/')) throw new Error(`invalid JSON pointer ${pointer}`)
  const parts = pointer.slice(1).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
  let node = target
  for (const part of parts.slice(0, -1)) {
    if (node == null || !(part in node)) throw new Error(`missing JSON pointer parent ${pointer}`)
    node = node[part]
  }
  const leaf = parts.at(-1)
  if (node == null || leaf == null || !(leaf in node)) throw new Error(`missing JSON pointer leaf ${pointer}`)
  node[leaf] = value
}

function validateInvalidFixture(file, { schema }) {
  const spec = readJson(file)
  const basePath = path.resolve(path.dirname(file), spec.base)
  const doc = clone(readJson(basePath))
  for (const mutation of asArray(spec.mutations)) {
    applyPointerMutation(doc, mutation.path, mutation.value)
  }

  const report = validateAtelierExportContract(doc, { schema, dryRunOnly: true })
  const errors = [
    ...report.errors,
    ...report.semanticProfileViolations.map((violation) => `${violation.path} ${violation.message}`),
  ]
  if (errors.length === 0) {
    return [`negative fixture ${path.basename(file)} unexpectedly passed`]
  }

  return asArray(spec.expectedErrors)
    .filter((expected) => !errors.some((error) => error.includes(expected)))
    .map((expected) => `negative fixture ${path.basename(file)} did not produce expected error: ${expected}`)
}

export function runAtelierExportContractCheck() {
  const schema = readJson(schemaPath)
  const failures = validateSchemaShape(schema)
  const positiveFixtures = fs.readdirSync(fixtureRoot)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(fixtureRoot, name))

  for (const file of positiveFixtures) {
    const doc = readJson(file)
    failures.push(...validateJsonSchema(schema, doc).map((error) => `${path.relative(process.cwd(), file)}: schema ${error}`))
    const report = validateAtelierExportContract(doc, { schema, dryRunOnly: true })
    failures.push(...report.errors.map((error) => `${path.relative(process.cwd(), file)}: ${error}`))
    failures.push(
      ...report.semanticProfileViolations.map((violation) => {
        return `${path.relative(process.cwd(), file)}: ${violation.path} ${violation.message}`
      })
    )
  }

  if (fs.existsSync(invalidFixtureRoot)) {
    for (const name of fs.readdirSync(invalidFixtureRoot).filter((entry) => entry.endsWith('.json')).sort()) {
      failures.push(...validateInvalidFixture(path.join(invalidFixtureRoot, name), { schema }))
    }
  }

  if (failures.length) {
    for (const failure of failures) console.error(`[atelier-export-contract:check] ${failure}`)
    return 1
  }

  console.log(`[atelier-export-contract:check] ${positiveFixtures.length} positive fixture(s) and invalid fixtures passed`)
  return 0
}

const currentFile = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  try {
    process.exitCode = runAtelierExportContractCheck()
  } catch (error) {
    console.error(`[atelier-export-contract:check] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
