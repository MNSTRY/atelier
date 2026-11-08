// Portable, pure adapters over pinned Impeccable resources. They perform no
// filesystem writes, process execution, network requests or canonical admission.
import resources from './resources.mjs'
import { impeccableFindingExitCode } from './engine-contract.mjs'
import { digest, objectDigest } from '../capabilities/files.mjs'

const MAX_TEXT = 2 * 1024 * 1024
const MAX_FINDINGS = 10000
const DIGEST = /^sha256:[a-f0-9]{64}$/
const isDigest = value => typeof value === 'string' && DIGEST.test(value)
const SLUG = /^[a-z][a-z0-9-]{0,95}$/
const rules = new Map(resources.rules.map(rule => [rule.id, rule]))
const commands = new Set(resources.commands)
const readOnly = new Set(['audit', 'critique'])
const session = new Set(['live', 'generate'])
const sourceWork = new Set(['extract', 'harden', 'optimize', 'overdrive'])

function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`invalid ${label}`)
  return value
}
function closed(value, keys, label) {
  plain(value, label)
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error(`unknown ${label} field`)
  return value
}
function text(value, label, { empty = false } = {}) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.includes('\0') ||
      Buffer.byteLength(value) > MAX_TEXT) throw new Error(`invalid or oversized ${label}`)
  return value
}
function sourceReference(value) {
  closed(value, ['id', 'revision', 'digest'], 'source reference')
  const { id, revision, digest } = value
  text(id, 'source identity')
  text(revision, 'source revision')
  if (!isDigest(digest)) throw new Error('source digest required')
  return { id, revision, digest }
}
function jsonValue(value, depth = 0) {
  if (depth > 32) throw new Error('JSON depth exceeded')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (Array.isArray(value)) {
    for (const child of value) jsonValue(child, depth + 1)
    return
  }
  plain(value, 'JSON value')
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('unsafe JSON key')
    jsonValue(child, depth + 1)
  }
}

export function impeccableResources() {
  return structuredClone(resources)
}

export function describeImpeccableCommand(command) {
  if (!commands.has(command)) throw new Error('unknown Impeccable command')
  const compatibilityAlias = command === 'craft'
  return {
    command,
    outcome: readOnly.has(command) ? 'report' : session.has(command) ? 'variant-session' : 'proposal',
    mayProduceImplementationProposal: sourceWork.has(command),
    compatibilityAlias,
    deprecated: compatibilityAlias,
    authority: 'none',
    upstream: { ...resources.upstream },
  }
}

// The host owns product/design truth and supplies already-authored projections.
// This adapter packages exact bytes; it never infers a tenant, creates a store,
// runs an interview, resolves compiler-owned values or changes the source.
export function projectImpeccableContext(input) {
  closed(input, ['source', 'productMarkdown', 'designMarkdown', 'designSidecar', 'surface'], 'context')
  const source = sourceReference(input.source)
  const files = [{ path: 'PRODUCT.md', content: text(input.productMarkdown, 'product context') }]
  if (input.designMarkdown !== undefined) files.push({
    path: 'DESIGN.md', content: text(input.designMarkdown, 'design context'),
  })
  if (input.designSidecar !== undefined) {
    if (input.designMarkdown === undefined) throw new Error('design sidecar requires its design document')
    plain(input.designSidecar, 'design sidecar')
    jsonValue(input.designSidecar)
    if (input.designSidecar.schemaVersion !== 2) throw new Error('unsupported design sidecar version')
    const content = JSON.stringify(input.designSidecar, null, 2) + '\n'
    text(content, 'design sidecar')
    files.push({ path: '.impeccable/design.json', content })
  }
  if (input.surface !== undefined) {
    closed(input.surface, ['id', 'markdown'], 'surface')
    if (typeof input.surface.id !== 'string' || !SLUG.test(input.surface.id)) throw new Error('invalid external surface identity')
    files.push({
      path: `.impeccable/surfaces/${input.surface.id}.md`,
      content: text(input.surface.markdown, 'surface brief'),
    })
  }
  const inventory = files.map(file => ({ path: file.path, digest: digest(file.content), bytes: Buffer.byteLength(file.content) }))
  if (inventory.reduce((sum, file) => sum + file.bytes, 0) > 4 * MAX_TEXT) throw new Error('context byte ceiling exceeded')
  return {
    source, upstream: { ...resources.upstream }, files, inventory,
    digest: objectDigest({ source, upstream: resources.upstream, inventory }),
    authority: 'projection-only',
    limitations: ['Supplied by the host; source authority, format conformance and compiler resolution are not inferred.'],
  }
}

export function compileImpeccablePolicy(input) {
  closed(input, ['requiredRules', 'advisoryRules'], 'policy')
  const list = (value, label) => {
    if (!Array.isArray(value) || value.length > rules.size) throw new Error(`invalid ${label}`)
    const copied = [...value]
    if (copied.some(id => typeof id !== 'string' || !rules.has(id)) ||
        new Set(copied).size !== copied.length) throw new Error(`invalid ${label}`)
    return copied.sort()
  }
  const requiredRules = list(input.requiredRules, 'required rule list')
  const advisoryRules = list(input.advisoryRules, 'advisory rule list')
  if (requiredRules.some(id => advisoryRules.includes(id))) throw new Error('rule policy classes overlap')
  const body = { upstream: { ...resources.upstream }, requiredRules, advisoryRules }
  return { ...body, digest: objectDigest(body) }
}

function checkedPolicy(value) {
  closed(value, ['upstream', 'requiredRules', 'advisoryRules', 'digest'], 'compiled policy')
  const rebuilt = compileImpeccablePolicy({ requiredRules: value.requiredRules, advisoryRules: value.advisoryRules })
  if (objectDigest(value.upstream) !== objectDigest(resources.upstream) || value.digest !== rebuilt.digest) {
    throw new Error('policy identity mismatch')
  }
  return rebuilt
}

export function interpretImpeccableDetection(input) {
  closed(input, ['source', 'policy', 'engine', 'engineDigest', 'exitCode', 'stdout', 'stderr'], 'detector result')
  const source = sourceReference(input.source)
  const policy = checkedPolicy(input.policy)
  if (!['source', 'static-html', 'browser'].includes(input.engine) || !isDigest(input.engineDigest)) {
    throw new Error('exact engine and digest required')
  }
  // Raw strings are already captured by the host. Retain them exactly even when
  // malformed/oversized; the parsing ceiling must not discard failure evidence.
  if (typeof input.stdout !== 'string' || typeof input.stderr !== 'string') throw new Error('detector streams must be strings')
  const stdout = input.stdout
  const stderr = input.stderr
  const base = {
    source, upstream: { ...resources.upstream }, engine: input.engine, engineDigest: input.engineDigest,
    policyDigest: policy.digest, raw: { stdout, stderr, exitCode: input.exitCode },
    authority: 'evidence-only',
  }
  const failed = reason => ({
    ...base, status: 'inconclusive', requiredFindingsStatus: 'unknown', findings: [], gaps: [reason],
  })
  if (![0, 1, 2].includes(input.exitCode)) return failed('detector did not finish with a supported exit code')
  if (input.exitCode === 1) return failed('detector could not scan the requested target')
  if ([stdout, stderr].some(stream => stream.includes('\0') || Buffer.byteLength(stream) > MAX_TEXT)) {
    return failed('detector stream is malformed or exceeds the parsing ceiling; exact raw strings retained')
  }
  let findings
  try { findings = JSON.parse(stdout) } catch { return failed('detector output is not valid JSON') }
  if (!Array.isArray(findings) || findings.length > MAX_FINDINGS) return failed('invalid findings array')
  for (const finding of findings) {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding) ||
        !rules.has(finding.antipattern) ||
        !['error', 'warning', 'advisory'].includes(finding.severity) ||
        (finding.advisory !== undefined && typeof finding.advisory !== 'boolean') ||
        typeof finding.name !== 'string' || typeof finding.description !== 'string' ||
        !(finding.category === null || typeof finding.category === 'string') ||
        typeof finding.file !== 'string' || typeof finding.snippet !== 'string' ||
        !Number.isSafeInteger(finding.line) || finding.line < 0) {
      return failed('findings do not match the pinned resource contract')
    }
  }
  if (input.exitCode !== impeccableFindingExitCode(findings)) return failed('exit code and findings disagree')
  const projected = findings.map(finding => ({
    raw: structuredClone(finding),
    disposition: policy.requiredRules.includes(finding.antipattern) ? 'required-failure' :
      policy.advisoryRules.includes(finding.antipattern) ? 'advisory' : 'unclassified',
  }))
  const unclassified = projected.some(finding => finding.disposition === 'unclassified')
  const requiredFailure = projected.some(finding => finding.disposition === 'required-failure')
  return {
    ...base, status: unclassified ? 'inconclusive' : requiredFailure ? 'failed' : 'reported',
    findings: projected, requiredFindingsStatus: unclassified ? 'unclassified' : requiredFailure ? 'present' : 'absent-in-reported-run',
    gaps: [
      ...(unclassified ? ['one or more findings have no admitted policy disposition'] : []),
      'This result records one engine run; it does not establish unattempted renderer, state or rule coverage.',
    ],
  }
}
