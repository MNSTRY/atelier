#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateAtelierExportContract } from './export/atelier-export-contract.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(__dirname, '..')
const schemaPath = path.join(packageRoot, 'contracts/atelier-export.v1.schema.json')

function readJsonFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8')
  return JSON.parse(text)
}

export function validateAtelierExportDryRun(doc, { schema = readJsonFile(schemaPath), graphNodes = [] } = {}) {
  return validateAtelierExportContract(doc, {
    schema,
    graphNodes,
    dryRunOnly: true,
  })
}

export function validateAtelierExportDryRunFile(filePath) {
  const absolutePath = path.resolve(filePath)
  const doc = readJsonFile(absolutePath)
  return validateAtelierExportDryRun(doc)
}

function emptyReport(message) {
  return {
    accepted: false,
    importable: false,
    worstOperationStatus: 'other',
    graphProvenanceMode: 'absent',
    operationSummary: {
      counts: { ready: 0, warning: 0, blocked: 0, other: 0 },
      worstOperationStatus: 'other',
      total: 0,
    },
    errors: [message],
    warnings: [],
    objects: { total: 0, byCollection: {} },
    sourceNodes: [],
    runtimeTargets: [],
    semanticProfileViolations: [],
  }
}

function printReport(report) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

export function main(argv) {
  const [filePath, ...extra] = argv
  if (!filePath || extra.length > 0) {
    printReport(emptyReport('usage: node scripts/validation/validate-atelier-export-dry-run.mjs <path-to-export-json>'))
    return 1
  }

  try {
    const report = validateAtelierExportDryRunFile(filePath)
    printReport(report)
    return report.accepted ? 0 : 1
  } catch (error) {
    printReport(emptyReport(error instanceof Error ? error.message : String(error)))
    return 1
  }
}

const currentFile = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  process.exitCode = main(process.argv.slice(2))
}
