#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(__dirname, '../..')

export const manifestSchema = 'analysis-adapter-manifest@v1'
export const claimSchema = 'atelier-claim@v1'
export const provider = 'analysis'
export const harnessPolicy = 'claim-only-local-disabled'
export const localAnalysisRoot = '.mnstry/atelier/analysis'
export const fixtureRoot = path.join(packageRoot, 'fixtures/analysis')

export const defaultAnalysisClaimContract = {
  schema: 'mnstry.atelier-analysis-claim-contract@v1',
  provider,
  claimSchema,
  harnessPolicy,
  authority: {
    claimOnly: true,
    frontMatterMutation: false,
    graphRelationMutation: false,
    publicExportFeed: false,
    mcpFeed: false,
    runtimeImport: false,
    directCanonicalWrite: false,
  },
}

const authorityPolicyKeys = new Set([
  'claimOnly',
  'frontMatterMutation',
  'graphRelationMutation',
  'publicExportFeed',
  'mcpFeed',
  'runtimeImport',
  'directCanonicalWrite',
])

const forbiddenAuthorityKeys = new Map([
  ['frontMatterMutation', 'front matter mutation'],
  ['frontmatterMutation', 'front matter mutation'],
  ['frontmatter', 'canonical front matter'],
  ['frontMatter', 'canonical front matter'],
  ['graphRelationMutation', 'graph relation mutation'],
  ['graphRelations', 'graph relations'],
  ['relations', 'graph relations'],
  ['edges', 'graph relation mutation'],
  ['publicExportFeed', 'public export feed'],
  ['publicExport', 'public exports'],
  ['publicExports', 'public exports'],
  ['mcpFeed', 'MCP feed'],
  ['runtimeImport', 'runtime import'],
  ['runtimeApply', 'runtime import'],
  ['directCanonicalWrite', 'direct canonical write'],
  ['canonicalWrite', 'direct canonical write'],
])

const hiddenProviderKeys = new Map([
  ['modelProvider', 'hidden model provider'],
  ['apiKey', 'hidden model provider credential'],
  ['apiToken', 'hidden model provider credential'],
  ['secret', 'hidden model provider credential'],
])

const executionKeys = new Map([
  ['execute', 'model-assisted analysis execution'],
  ['executeCommand', 'model-assisted analysis execution command'],
  ['runCommand', 'model-assisted analysis execution command'],
  ['shellCommand', 'model-assisted analysis execution command'],
  ['installCommand', 'model-assisted analysis install command'],
  ['network', 'network access'],
])

const manifestRootKeys = new Set(['schema', 'provider', 'enabled', 'outputRoot', 'claimContract', 'harness', 'canonicalMutation', 'authority'])
const manifestHarnessKeys = new Set(['policy', 'hiddenModelProvider', 'network', 'analysisExecution'])
const manifestAuthorityKeys = new Set([...authorityPolicyKeys])
const claimKeys = new Set(['schema', 'claimId', 'subject', 'predicate', 'object', 'provider', 'status', 'promoted', 'confidence', 'evidence', 'createdAt', 'notes'])

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function joinPath(base, key) {
  return base ? `${base}.${key}` : String(key)
}

function valueAttemptsAuthority(value) {
  return value === true || value === 'true' || value === 'enabled' || value === 'apply' || value === 'write'
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export function collectContractAttempts(value, {
  pathLabel = '',
  attempts = [],
  skipExecutionNetworkKey = false,
} = {}) {
  if (!value || typeof value !== 'object') return attempts
  for (const [key, item] of Object.entries(value)) {
    const current = joinPath(pathLabel, key)
    if (forbiddenAuthorityKeys.has(key) && valueAttemptsAuthority(item)) {
      attempts.push(`${current} attempts ${forbiddenAuthorityKeys.get(key)}`)
    }
    if (hiddenProviderKeys.has(key) && item != null && item !== false) {
      attempts.push(`${current} attempts ${hiddenProviderKeys.get(key)}`)
    }
    if (executionKeys.has(key) && item != null && item !== false && !(skipExecutionNetworkKey && key === 'network')) {
      if (key === 'network' && item === 'none') {
        // Explicit no-network posture is allowed.
      } else {
        attempts.push(`${current} attempts ${executionKeys.get(key)}`)
      }
    }
    if (item && typeof item === 'object') {
      collectContractAttempts(item, {
        pathLabel: current,
        attempts,
        skipExecutionNetworkKey,
      })
    }
  }
  return attempts
}

function validateLocalOutputRoot(outputRoot) {
  const errors = []
  if (typeof outputRoot !== 'string' || !outputRoot) {
    errors.push('outputRoot is required')
    return errors
  }
  if (path.isAbsolute(outputRoot)) errors.push('outputRoot must not be absolute')
  const normalized = outputRoot.replaceAll('\\', '/')
  if (normalized.split('/').includes('..')) errors.push('outputRoot must not escape via ..')
  if (!(normalized === localAnalysisRoot || normalized.startsWith(`${localAnalysisRoot}/`))) {
    errors.push(`outputRoot must live under ${localAnalysisRoot}`)
  }
  return errors
}

export function validateContractShape(contract = defaultAnalysisClaimContract) {
  const errors = []
  if (contract?.schema !== 'mnstry.atelier-analysis-claim-contract@v1') {
    errors.push('contract schema must be mnstry.atelier-analysis-claim-contract@v1')
  }
  if (contract?.provider !== provider) errors.push('contract provider must be analysis')
  if (contract?.claimSchema !== claimSchema) errors.push('contract claimSchema must be atelier-claim@v1')
  if (contract?.harnessPolicy !== harnessPolicy) errors.push(`contract harnessPolicy must be ${harnessPolicy}`)
  if (contract?.authority?.claimOnly !== true) errors.push('authority.claimOnly must be true')
  for (const key of authorityPolicyKeys) {
    if (key === 'claimOnly') continue
    if (contract?.authority?.[key] !== false) errors.push(`authority.${key} must be false`)
  }
  errors.push(...collectContractAttempts(contract, { skipExecutionNetworkKey: true }))
  return errors
}

export function validateManifest(manifest, { contract = defaultAnalysisClaimContract } = {}) {
  const errors = validateContractShape(contract)
  const warnings = []
  const normalized = structuredClone(manifest || {})
  if (!isPlainObject(normalized)) {
    return { errors: ['manifest must be an object'], warnings, manifest: null }
  }
  for (const key of Object.keys(normalized)) {
    if (!manifestRootKeys.has(key)) errors.push(`manifest has unknown property ${key}`)
  }
  if (normalized.schema !== manifestSchema) errors.push(`schema must be ${manifestSchema}`)
  if (normalized.provider !== provider) errors.push('provider must be analysis')
  if (normalized.enabled == null) {
    normalized.enabled = false
    warnings.push('enabled missing; defaulting to false')
  }
  if (normalized.enabled !== false) errors.push('enabled must be false until the operator explicitly installs an adapter')
  errors.push(...validateLocalOutputRoot(normalized.outputRoot))
  if (normalized.claimContract !== claimSchema) errors.push(`claimContract must be ${claimSchema}`)

  const harness = normalized.harness || {}
  if (!isPlainObject(harness)) errors.push('harness must be an object')
  for (const key of Object.keys(harness)) {
    if (!manifestHarnessKeys.has(key)) errors.push(`harness has unknown property ${key}`)
  }
  if (harness.policy !== harnessPolicy) errors.push(`harness.policy must be ${harnessPolicy}`)
  if (harness.hiddenModelProvider !== false) errors.push('harness.hiddenModelProvider must be false')
  if (harness.network !== 'none') errors.push('harness.network must be none')
  if (harness.analysisExecution !== false) errors.push('harness.analysisExecution must be false')

  if (normalized.canonicalMutation !== false) errors.push('canonicalMutation must be false')
  const authority = normalized.authority || {}
  if (!isPlainObject(authority)) errors.push('authority must be an object')
  for (const key of Object.keys(authority)) {
    if (!manifestAuthorityKeys.has(key)) errors.push(`authority has unknown property ${key}`)
  }
  if (authority.claimOnly !== true) errors.push('authority.claimOnly must be true')
  for (const key of authorityPolicyKeys) {
    if (key === 'claimOnly') continue
    if (authority[key] !== false) errors.push(`authority.${key} must be false`)
  }
  errors.push(...collectContractAttempts(normalized, { skipExecutionNetworkKey: true }))
  return { errors, warnings, manifest: normalized }
}

function normalizeOutputClaims(output) {
  if (Array.isArray(output)) return output
  if (isPlainObject(output) && Array.isArray(output.claims)) return output.claims
  return null
}

export function validateAdapterOutput(output, { nodes = null, contract = defaultAnalysisClaimContract } = {}) {
  const errors = validateContractShape(contract)
  if (isPlainObject(output) && (Array.isArray(output.nodes) || Array.isArray(output.edges))) {
    errors.push('model-assisted analysis output must be a single atelier-claim@v1 claim list, not native graph nodes/edges')
    errors.push('native graph output attempts graph relation mutation')
  }
  const claims = normalizeOutputClaims(output)
  if (!claims) {
    errors.push('model-assisted analysis output must be a single atelier-claim@v1 claim list')
    return { errors, claimCount: 0 }
  }

  for (const [index, claim] of claims.entries()) {
    const label = `claims[${index}]`
    if (!isPlainObject(claim)) {
      errors.push(`${label} must be an object`)
      continue
    }
    for (const key of Object.keys(claim)) {
      if (!claimKeys.has(key)) errors.push(`${label} has unknown key ${key}`)
    }
    if (claim.schema !== claimSchema) errors.push(`${label}.schema must be ${claimSchema}`)
    if (claim.provider !== provider) errors.push(`${label}.provider must be analysis`)
    if (typeof claim.claimId !== 'string' || !claim.claimId.startsWith('claim:analysis:')) {
      errors.push(`${label}.claimId must start with claim:analysis:`)
    }
    for (const key of ['subject', 'predicate', 'object']) {
      if (typeof claim[key] !== 'string' || !claim[key]) errors.push(`${label}.${key} is required`)
    }
    if (claim.status !== 'proposed') errors.push(`${label}.status must be proposed`)
    if (claim.promoted !== false) errors.push(`${label}.promoted must remain false`)
    if (typeof claim.confidence !== 'number' || claim.confidence < 0 || claim.confidence > 1) {
      errors.push(`${label}.confidence must be a number between 0 and 1`)
    }
    if (!Array.isArray(claim.evidence) || claim.evidence.length === 0) {
      errors.push(`${label}.evidence must include at least one source reference`)
    }
    if (nodes && !nodes.some((node) => node?.id === claim.subject)) {
      errors.push(`${label}.subject does not match a known graph node`)
    }
    errors.push(...collectContractAttempts(claim).map((attempt) => `${label}.${attempt}`))
  }

  return { errors, claimCount: claims.length }
}

function isJsonFile(file) {
  return file.endsWith('.json')
}

export function checkFixtureSet({ root = fixtureRoot, nodes = null } = {}) {
  const errors = []
  let fixtureCount = 0
  let invalidFixtureCount = 0
  const validDir = path.join(root, 'valid')
  const invalidDir = path.join(root, 'invalid')

  if (fs.existsSync(validDir)) {
    for (const name of fs.readdirSync(validDir).filter(isJsonFile).sort()) {
      fixtureCount += 1
      const result = validateAdapterOutput(readJson(path.join(validDir, name)), { nodes })
      errors.push(...result.errors.map((error) => `${name}: ${error}`))
    }
  }
  if (fs.existsSync(invalidDir)) {
    for (const name of fs.readdirSync(invalidDir).filter(isJsonFile).sort()) {
      invalidFixtureCount += 1
      const result = validateAdapterOutput(readJson(path.join(invalidDir, name)), { nodes })
      if (result.errors.length === 0) errors.push(`${name}: invalid fixture unexpectedly passed`)
    }
  }
  return { errors, fixtureCount, invalidFixtureCount }
}

export function runAnalysisClaimContractCheck({
  manifestPath = null,
  fixtures = fixtureRoot,
  contract = defaultAnalysisClaimContract,
} = {}) {
  const report = {
    status: 'disabled',
    enabled: false,
    analysisExecuted: false,
    networkCalls: false,
    canonicalMutation: false,
    errors: [],
    warnings: [],
  }

  report.errors.push(...validateContractShape(contract))
  if (manifestPath && fs.existsSync(manifestPath)) {
    const manifestResult = validateManifest(readJson(manifestPath), { contract })
    report.errors.push(...manifestResult.errors)
    report.warnings.push(...manifestResult.warnings)
    report.enabled = manifestResult.manifest?.enabled === true
  } else if (manifestPath) {
    report.warnings.push('manifest missing; model-assisted analysis remains disabled')
  }
  const fixtureResult = checkFixtureSet({ root: fixtures })
  report.errors.push(...fixtureResult.errors)
  report.fixtureCount = fixtureResult.fixtureCount
  report.invalidFixtureCount = fixtureResult.invalidFixtureCount
  report.status = report.errors.length ? 'failed' : 'disabled'
  return report
}

function formatReport(report) {
  return JSON.stringify(report, null, 2)
}

function main() {
  const manifestArg = process.argv.find((arg) => arg.startsWith('--manifest='))
  const manifestPath = manifestArg ? manifestArg.slice('--manifest='.length) : null
  const report = runAnalysisClaimContractCheck({ manifestPath })
  console.log(formatReport(report))
  if (report.errors.length) process.exitCode = 1
}

const currentFile = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main()
}
