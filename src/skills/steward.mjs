import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { createCollaborationEventLedger } from '../collaboration/event-ledger.mjs'
import { validateJsonSchema } from '../export/atelier-export-contract.mjs'
import { atomicReplacePrivateText, ensureContainedPrivateDirectory, openRegularFileNoFollow } from '../project/private-state.mjs'
import { packageRootFrom } from '../project/package-root.mjs'

export const ATELIER_SKILL_AUDIT_SCHEMA = 'mnstry.atelier-skill-audit@v1'
export const ATELIER_SKILL_CANDIDATES_SCHEMA = 'mnstry.atelier-skill-candidates@v1'
export const ATELIER_SKILL_SYNC_PLAN_SCHEMA = 'mnstry.atelier-skill-sync-plan@v1'
export const ATELIER_SKILL_SYNC_LOCK_SCHEMA = 'mnstry.atelier-skill-sync-lock@v1'
export const SKILL_SYNC_LOCK_FILE = '.atelier-skill-lock.json'

export const SKILL_OBSERVATION_SIGNALS = Object.freeze([
  'repeated-task',
  'missing-workflow',
  'user-correction',
  'trigger-miss',
  'trigger-collision',
  'tool-failure',
  'stale-guidance',
  'successful-run',
  'unused-skill',
  'superseded-skill',
])

export const SKILL_OBSERVATION_OUTCOMES = Object.freeze([
  'success',
  'failure',
  'corrected',
  'missing',
  'unknown',
])

const packageRoot = packageRootFrom(import.meta.url)
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
const stewardSchema = JSON.parse(fs.readFileSync(path.join(packageRoot, 'contracts', 'atelier-skill-steward.v1.schema.json'), 'utf8'))
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const WORKFLOW_KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/
const MAX_BUNDLE_FILES = 256
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024
const MAX_SKILL_DESCRIPTION = 600
const OBSERVATION_LEDGER = path.join('.atelier-local', 'skill-steward', 'observations.ndjson')

const stableCompare = (left, right) => String(left).localeCompare(String(right), 'en')
const portablePath = (value) => String(value).split(path.sep).join('/')
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value)

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`
}

function canonicalDigest(value) {
  return sha256(JSON.stringify(value))
}

function lstatIfPresent(file) {
  try {
    return fs.lstatSync(file)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function escaped(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative.startsWith('..') || path.isAbsolute(relative)
}

function containedPath(root, candidate, label) {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(candidate)
  if (resolved === resolvedRoot || escaped(resolvedRoot, resolved)) throw new Error(`${label} escapes workspace`)
  return resolved
}

function relativeTo(root, file) {
  const relative = path.relative(root, file)
  if (relative === '' || escaped(root, file)) return null
  return portablePath(relative)
}

function strictUtf8(bytes, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error(`${label} is not valid UTF-8 text`)
  }
}

function readBounded(file) {
  const fd = openRegularFileNoFollow(file)
  try {
    if (fs.fstatSync(fd).size > MAX_BUNDLE_BYTES) throw new Error('skill file exceeds byte ceiling')
    const bytes = fs.readFileSync(fd)
    if (bytes.length > MAX_BUNDLE_BYTES) throw new Error('skill file exceeds byte ceiling')
    return bytes
  } finally { fs.closeSync(fd) }
}

function requirePrivatePlacement(workspaceRoot) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')))
  try {
    const tracked = execFileSync('git', ['-C', workspaceRoot, 'ls-files', '-z', '--', '.atelier-local'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    if (tracked) throw new Error('tracked private state')
    execFileSync('git', ['-C', workspaceRoot, 'check-ignore', '--quiet', '.atelier-local/'], { env, stdio: 'ignore' })
  } catch { throw new Error('skill stewardship requires untracked, ignored .atelier-local/ state in a Git workspace') }
}

function scalarValue(raw) {
  const value = raw.trim()
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value)
    } catch {
      return value.slice(1, -1)
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'")
  return value
}

export function parseSkillFrontmatter(text) {
  const normalized = String(text).replaceAll('\r\n', '\n')
  if (!normalized.startsWith('---\n')) return { ok: false, values: {}, body: normalized, error: 'SKILL.md must begin with YAML frontmatter' }
  const closing = normalized.indexOf('\n---\n', 4)
  if (closing < 0) return { ok: false, values: {}, body: normalized, error: 'SKILL.md frontmatter is not closed' }
  const header = normalized.slice(4, closing)
  const values = {}
  for (const line of header.split('\n')) {
    if (!line || /^\s/.test(line) || line.trimStart().startsWith('#')) continue
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (!match) continue
    values[match[1]] = scalarValue(match[2])
  }
  return { ok: true, values, body: normalized.slice(closing + 5), error: null }
}

function bundleFiles(root, relative = '', state = { files: [], bytes: 0, directories: 0 }) {
  if (++state.directories > 256 || relative.split(path.sep).length > 16) throw new Error('skill bundle directory ceiling exceeded')
  const directory = relative ? path.join(root, relative) : root
  const stat = fs.lstatSync(directory)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('skill bundle contains a redirected or non-directory component')
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => stableCompare(left.name, right.name))) {
    const childRelative = relative ? path.join(relative, entry.name) : entry.name
    const child = path.join(root, childRelative)
    const childStat = fs.lstatSync(child)
    if (childStat.isSymbolicLink()) throw new Error(`skill bundle contains symbolic link ${portablePath(childRelative)}`)
    if (childStat.isDirectory()) {
      bundleFiles(root, childRelative, state)
      continue
    }
    if (!childStat.isFile()) throw new Error(`skill bundle contains non-regular file ${portablePath(childRelative)}`)
    if (state.files.length >= MAX_BUNDLE_FILES) throw new Error(`skill bundle exceeds ${MAX_BUNDLE_FILES} file ceiling`)
    if (state.bytes + childStat.size > MAX_BUNDLE_BYTES) throw new Error(`skill bundle exceeds ${MAX_BUNDLE_BYTES} byte ceiling`)
    const bytes = readBounded(child)
    if (state.bytes + bytes.length > MAX_BUNDLE_BYTES) throw new Error('skill bundle exceeds byte ceiling')
    state.files.push({ path: portablePath(childRelative), bytes })
    state.bytes += bytes.length
  }
  return state
}

function bundleDigest(files) {
  const hash = crypto.createHash('sha256')
  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8')
    const size = Buffer.alloc(8)
    size.writeBigUInt64BE(BigInt(file.bytes.length))
    hash.update(Buffer.from(`${name.length}:`, 'utf8'))
    hash.update(name)
    hash.update(size)
    hash.update(file.bytes)
  }
  return `sha256:${hash.digest('hex')}`
}

function readSkillBundle(root, directoryName) {
  const skillRoot = path.join(root, directoryName)
  const state = bundleFiles(skillRoot)
  const skillFile = state.files.find((file) => file.path === 'SKILL.md')
  if (!skillFile) throw new Error('skill bundle is missing SKILL.md')
  const skillText = strictUtf8(skillFile.bytes, 'SKILL.md')
  return {
    directoryName,
    root: skillRoot,
    files: state.files,
    bytes: state.bytes,
    digest: bundleDigest(state.files),
    skillText,
    frontmatter: parseSkillFrontmatter(skillText),
  }
}

function markdownResourceLinks(text) {
  const links = []
  const pattern = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  for (const match of text.matchAll(pattern)) {
    const target = match[1].replace(/^<|>$/g, '')
    if (!target || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue
    links.push(target.split('#')[0])
  }
  return [...new Set(links)].sort(stableCompare)
}

function auditSurface({ name, root, reportRoot }) {
  const entries = []
  const findings = []
  const surfacePath = relativeTo(reportRoot, root) ?? portablePath(path.basename(root))
  const rootStat = lstatIfPresent(root)
  if (!rootStat) {
    findings.push({ severity: 'error', code: 'surface-missing', surface: name, skill: null, path: surfacePath, message: 'skill surface does not exist' })
    return { entries, findings }
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    findings.push({ severity: 'error', code: 'surface-redirected', surface: name, skill: null, path: surfacePath, message: 'skill surface must be a real directory' })
    return { entries, findings }
  }

  for (const directory of fs.readdirSync(root, { withFileTypes: true }).sort((left, right) => stableCompare(left.name, right.name))) {
    if (directory.name.startsWith('.')) continue
    const entryPath = path.join(root, directory.name)
    const entryDisplay = portablePath(path.join(surfacePath, directory.name))
    if (directory.isSymbolicLink()) {
      findings.push({ severity: 'error', code: 'skill-redirected', surface: name, skill: directory.name, path: entryDisplay, message: 'skill entry must not be a symbolic link' })
      continue
    }
    if (!directory.isDirectory()) {
      findings.push({ severity: 'warning', code: 'unexpected-surface-file', surface: name, skill: null, path: entryDisplay, message: 'non-directory entry is ignored' })
      continue
    }
    let bundle
    try {
      bundle = readSkillBundle(root, directory.name)
    } catch (error) {
      findings.push({ severity: 'error', code: 'skill-bundle-invalid', surface: name, skill: directory.name, path: entryDisplay, message: error.message })
      continue
    }
    const { frontmatter } = bundle
    if (!frontmatter.ok) {
      findings.push({ severity: 'error', code: 'frontmatter-invalid', surface: name, skill: directory.name, path: `${entryDisplay}/SKILL.md`, message: frontmatter.error })
    }
    const declaredName = typeof frontmatter.values.name === 'string' ? frontmatter.values.name.trim() : ''
    const description = typeof frontmatter.values.description === 'string' ? frontmatter.values.description.trim() : ''
    if (!declaredName) findings.push({ severity: 'error', code: 'name-missing', surface: name, skill: directory.name, path: `${entryDisplay}/SKILL.md`, message: 'frontmatter name is required' })
    else {
      if (!SKILL_NAME_PATTERN.test(declaredName) || declaredName.length > 64) {
        findings.push({ severity: 'error', code: 'name-invalid', surface: name, skill: directory.name, path: `${entryDisplay}/SKILL.md`, message: 'frontmatter name must be lowercase kebab-case and at most 64 characters' })
      }
      if (declaredName !== directory.name) {
        findings.push({ severity: 'error', code: 'name-directory-mismatch', surface: name, skill: directory.name, path: `${entryDisplay}/SKILL.md`, message: 'frontmatter name must match its directory' })
      }
    }
    if (!description) findings.push({ severity: 'error', code: 'description-missing', surface: name, skill: directory.name, path: `${entryDisplay}/SKILL.md`, message: 'frontmatter description is required' })
    else if (description.length > MAX_SKILL_DESCRIPTION) {
      findings.push({ severity: 'warning', code: 'description-long', surface: name, skill: directory.name, path: `${entryDisplay}/SKILL.md`, message: `frontmatter description exceeds ${MAX_SKILL_DESCRIPTION} characters` })
    }
    const fileNames = new Set(bundle.files.map((file) => file.path))
    for (const link of markdownResourceLinks(bundle.skillText)) {
      const normalized = portablePath(path.posix.normalize(link.replaceAll('\\', '/')))
      if (normalized === '..' || normalized.startsWith('../')) {
        findings.push({ severity: 'error', code: 'reference-escapes-bundle', surface: name, skill: directory.name, path: `${entryDisplay}/SKILL.md`, message: 'relative resource link escapes the skill bundle' })
      } else if (!fileNames.has(normalized)) {
        findings.push({ severity: 'error', code: 'reference-missing', surface: name, skill: directory.name, path: `${entryDisplay}/SKILL.md`, message: `relative resource link is missing: ${normalized}` })
      }
    }
    if (/\b(?:TODO|TBD|REPLACE_ME)\b/.test(bundle.skillText)) {
      findings.push({ severity: 'warning', code: 'unfinished-placeholder', surface: name, skill: directory.name, path: `${entryDisplay}/SKILL.md`, message: 'skill contains an unfinished scaffold placeholder' })
    }
    const entryName = SKILL_NAME_PATTERN.test(declaredName) && declaredName.length <= 64
      ? declaredName
      : SKILL_NAME_PATTERN.test(directory.name) && directory.name.length <= 64
        ? directory.name
        : null
    if (entryName) {
      entries.push({
        surface: name,
        name: entryName,
        description,
        lifecycle: 'active',
        risk: bundle.files.length === 1 ? 'instruction-only' : 'resource-backed',
        digest: bundle.digest,
        fileCount: bundle.files.length,
        bytes: bundle.bytes,
      })
    }
  }
  return { entries, findings }
}

function parityFindings(entries, surfaces) {
  if (surfaces.length < 2) return []
  const findings = []
  const canonical = surfaces[0].name
  const bySurface = new Map(surfaces.map((surface) => [surface.name, new Map()]))
  for (const entry of entries) bySurface.get(entry.surface)?.set(entry.name, entry)
  const names = [...new Set(entries.map((entry) => entry.name))].sort(stableCompare)
  for (const name of names) {
    const base = bySurface.get(canonical)?.get(name) ?? null
    for (const surface of surfaces.slice(1)) {
      const peer = bySurface.get(surface.name)?.get(name) ?? null
      if (!base) {
        findings.push({ severity: 'error', code: 'peer-only-skill', surface: surface.name, skill: name, path: name, message: `skill is absent from canonical surface ${canonical}` })
      } else if (!peer) {
        findings.push({ severity: 'error', code: 'peer-missing-skill', surface: surface.name, skill: name, path: name, message: `skill is missing from peer surface ${surface.name}` })
      } else if (base.digest !== peer.digest) {
        findings.push({ severity: 'error', code: 'peer-bundle-mismatch', surface: surface.name, skill: name, path: name, message: `skill bundle differs from canonical surface ${canonical}` })
      }
    }
  }
  return findings
}

function reportAuthority() {
  return {
    telemetry: false,
    egress: false,
    promptCapture: false,
    sourceMutation: false,
    runtimeMutation: false,
    applyEndpoint: null,
  }
}

export function auditSkillCatalog({ surfaces, reportRoot = process.cwd(), clock = () => new Date().toISOString() } = {}) {
  const selected = Array.isArray(surfaces) && surfaces.length
    ? surfaces.map((surface, index) => ({ name: String(surface.name || `surface-${index + 1}`), root: path.resolve(surface.root) }))
    : [
        { name: 'codex', root: path.join(packageRoot, 'skills', 'codex') },
        { name: 'claude', root: path.join(packageRoot, 'skills', 'claude') },
      ]
  const entries = []
  const findings = []
  for (const surface of selected) {
    const audited = auditSurface({ ...surface, reportRoot: path.resolve(reportRoot) })
    entries.push(...audited.entries)
    findings.push(...audited.findings)
  }
  findings.push(...parityFindings(entries, selected))
  entries.sort((left, right) => stableCompare(`${left.surface}:${left.name}`, `${right.surface}:${right.name}`))
  findings.sort((left, right) => stableCompare(`${left.severity}:${left.surface}:${left.skill}:${left.code}`, `${right.severity}:${right.surface}:${right.skill}:${right.code}`))
  const errors = findings.filter((finding) => finding.severity === 'error').length
  const warnings = findings.filter((finding) => finding.severity === 'warning').length
  const report = {
    schema: ATELIER_SKILL_AUDIT_SCHEMA,
    generatedAt: clock(),
    ok: errors === 0,
    surfaces: selected.map((surface) => ({ name: surface.name, path: relativeTo(path.resolve(reportRoot), surface.root) ?? portablePath(path.basename(surface.root)) })),
    summary: { skills: entries.length, errors, warnings },
    entries,
    findings,
    authority: reportAuthority(),
  }
  const validation = validateSkillStewardDocument(report, '#/$defs/auditReport')
  if (validation.length) throw new Error(`generated skill audit violates its contract: ${validation.join('; ')}`)
  return report
}

function skillObservationLedger(workspaceRoot) {
  requirePrivatePlacement(workspaceRoot)
  return createCollaborationEventLedger({
    workspaceRoot,
    ledgerPath: path.join(workspaceRoot, OBSERVATION_LEDGER),
  })
}

function validateObservation({ workflowKey, signal, skill, outcome }) {
  const errors = []
  if (typeof workflowKey !== 'string' || !WORKFLOW_KEY_PATTERN.test(workflowKey)) errors.push('workflow key is invalid')
  if (!SKILL_OBSERVATION_SIGNALS.includes(signal)) errors.push(`signal must be one of ${SKILL_OBSERVATION_SIGNALS.join(', ')}`)
  if (skill != null && (typeof skill !== 'string' || skill.length > 64 || !SKILL_NAME_PATTERN.test(skill))) errors.push('skill name is invalid')
  if (!SKILL_OBSERVATION_OUTCOMES.includes(outcome)) errors.push(`outcome must be one of ${SKILL_OBSERVATION_OUTCOMES.join(', ')}`)
  return errors
}

export function recordSkillObservation({
  workspaceRoot = process.cwd(),
  workflowKey,
  signal,
  skill = null,
  outcome = 'unknown',
  at = new Date().toISOString(),
  ...unknown
} = {}) {
  if (Object.keys(unknown).length) throw new Error('unknown skill observation fields refused')
  const errors = validateObservation({ workflowKey, signal, skill, outcome })
  if (errors.length) throw new Error(errors.join('; '))
  const ledger = skillObservationLedger(workspaceRoot)
  const current = ledger.eventsFor(workflowKey)
  if (!current.ok) throw new Error(current.error)
  const result = ledger.append({
    aggregateId: workflowKey,
    expectedVersion: current.currentVersion,
    type: `skill-observation.${signal}`,
    actor: 'atelier-skill-steward',
    at,
    payload: { signal, skill, outcome },
  })
  if (!result.ok) throw new Error(result.error)
  return {
    ok: true,
    schema: 'mnstry.atelier-skill-observation-receipt@v1',
    observation: {
      id: result.event.id,
      workflowKey,
      version: result.event.version,
      signal,
      skill,
      outcome,
      observedAt: result.event.at,
    },
    storage: portablePath(OBSERVATION_LEDGER),
    authority: { telemetry: false, egress: false, promptCapture: false },
  }
}

function candidateKind(events) {
  const lastSkill = [...events].reverse().find((event) => typeof event.payload?.skill === 'string')?.payload.skill ?? null
  const counts = Object.fromEntries(SKILL_OBSERVATION_SIGNALS.map((signal) => [signal, 0]))
  for (const event of events) {
    if (Object.hasOwn(counts, event.payload?.signal)) counts[event.payload.signal] += 1
  }
  const creationEvidence = counts['repeated-task'] + counts['missing-workflow']
  const improvementEvidence = counts['user-correction'] + counts['trigger-miss'] + counts['tool-failure'] + counts['stale-guidance']
  const collisionEvidence = counts['trigger-collision']
  let kind = null
  let eligible = false
  if (collisionEvidence >= 2) {
    kind = 'reconcile'
    eligible = true
  } else if (lastSkill && (counts['superseded-skill'] >= 2 || counts['unused-skill'] >= 3)) {
    kind = 'retire'
    eligible = true
  } else if (lastSkill && (counts['user-correction'] >= 2 || improvementEvidence >= 3)) {
    kind = 'improve'
    eligible = true
  } else if (!lastSkill && creationEvidence >= 3) {
    kind = 'create'
    eligible = true
  }
  return { kind, eligible, skill: lastSkill, counts }
}

export function buildSkillCandidates({ workspaceRoot = process.cwd(), includeInsufficient = false, clock = () => new Date().toISOString() } = {}) {
  const ledger = skillObservationLedger(workspaceRoot)
  const result = ledger.readAll()
  if (!result.ok) throw new Error(result.error)
  const groups = new Map()
  for (const event of result.events) {
    if (!event.type.startsWith('skill-observation.')) continue
    if (validateObservation({ workflowKey: event.aggregateId, ...event.payload }).length || event.type !== `skill-observation.${event.payload.signal}`) throw new Error('invalid stored skill observation')
    const key = JSON.stringify([event.aggregateId, event.payload.skill ?? null])
    const group = groups.get(key) ?? []
    group.push(event)
    groups.set(key, group)
  }
  const candidates = []
  for (const [key, events] of [...groups.entries()].sort(([left], [right]) => stableCompare(left, right))) {
    const [workflowKey] = JSON.parse(key)
    const classified = candidateKind(events)
    if (!classified.eligible && !includeInsufficient) continue
    candidates.push({
      workflowKey,
      kind: classified.kind ?? 'observe',
      status: classified.eligible ? 'eligible' : 'insufficient-evidence',
      skill: classified.skill,
      evidenceCount: events.length,
      signals: classified.counts,
      lastObservedAt: events.at(-1)?.at ?? null,
    })
  }
  const report = {
    schema: ATELIER_SKILL_CANDIDATES_SCHEMA,
    generatedAt: clock(),
    ok: true,
    candidates,
    observationCount: result.events.length,
    diagnostics: [],
    authority: reportAuthority(),
  }
  const validation = validateSkillStewardDocument(report, '#/$defs/candidateReport')
  if (validation.length) throw new Error(`generated skill candidates violate their contract: ${validation.join('; ')}`)
  return report
}

function catalogEntries(sourceRoot) {
  const audit = auditSkillCatalog({ surfaces: [{ name: 'source', root: sourceRoot }], reportRoot: path.dirname(sourceRoot) })
  return { audit, entries: audit.entries.map((entry) => ({ name: entry.name, digest: entry.digest })).sort((left, right) => stableCompare(left.name, right.name)) }
}

function syncAuthority() {
  return {
    telemetry: false,
    egress: false,
    sourceMutation: false,
    targetMutation: 'content-bound-confirmed',
    destructiveDelete: false,
  }
}

function readSyncLock(lockPath) {
  const stat = lstatIfPresent(lockPath)
  if (!stat) return { lock: null, errors: [] }
  if (stat.isSymbolicLink() || !stat.isFile()) return { lock: null, errors: ['skill sync lock must be a regular file'] }
  let lock
  try {
    lock = JSON.parse(strictUtf8(readBounded(lockPath), 'skill sync lock'))
  } catch (error) {
    return { lock: null, errors: [`skill sync lock cannot be read: ${error.message}`] }
  }
  const errors = validateSkillStewardDocument(lock, '#/$defs/syncLock').map((error) => `skill sync lock ${error}`)
  if (errors.length) return { lock: null, errors }
  const names = (lock?.skills ?? []).map((entry) => entry.name)
  if (new Set(names).size !== names.length) errors.push('skill sync lock contains duplicate skill names')
  return { lock, errors }
}

function currentSkillDigest(targetRoot, name) {
  const stat = lstatIfPresent(path.join(targetRoot, name))
  if (!stat) return null
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`target skill ${name} must be a real directory`)
  return readSkillBundle(targetRoot, name).digest
}

function verifyDirectoryPath(workspace, directory) {
  const relative = path.relative(workspace, directory)
  let current = workspace
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment)
    const stat = lstatIfPresent(current)
    if (!stat) return
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('skill sync target contains a redirected or non-directory component')
    }
  }
}

export function planSkillSync({
  workspaceRoot = process.cwd(),
  sourceRoot = path.join(packageRoot, 'skills', 'codex'),
  target = path.join('.agents', 'skills'),
  clock = () => new Date().toISOString(),
} = {}) {
  const workspace = fs.realpathSync(path.resolve(workspaceRoot))
  const targetRoot = containedPath(workspace, path.resolve(workspace, target), 'skill sync target')
  const sourcePath = fs.realpathSync(path.resolve(sourceRoot))
  if (sourcePath === targetRoot || !escaped(sourcePath, targetRoot) || !escaped(targetRoot, sourcePath)) throw new Error('skill source and target must not overlap')
  const privatePath = path.join(workspace, '.atelier-local')
  if (targetRoot === privatePath || !escaped(privatePath, targetRoot)) throw new Error('skill target must not overlap private state')
  verifyDirectoryPath(workspace, targetRoot)
  const targetRelative = portablePath(path.relative(workspace, targetRoot))
  if (targetRelative.split('/').includes('.git')) throw new Error('skill target must not overlap Git metadata')
  const lockPath = path.join(targetRoot, SKILL_SYNC_LOCK_FILE)
  const lockRelative = portablePath(path.relative(workspace, lockPath))
  const blockers = []
  let source
  try {
    source = catalogEntries(path.resolve(sourceRoot))
  } catch (error) {
    source = { audit: null, entries: [] }
    blockers.push(`source catalog cannot be audited: ${error.message}`)
  }
  if (source.audit && !source.audit.ok) blockers.push(...source.audit.findings.filter((finding) => finding.severity === 'error').map((finding) => `${finding.skill ?? finding.surface}: ${finding.message}`))
  const lockRead = readSyncLock(lockPath)
  blockers.push(...lockRead.errors)
  const lock = lockRead.lock
  const locked = new Map((lock?.skills ?? []).map((entry) => [entry.name, entry.digest]))
  const next = new Map(source.entries.map((entry) => [entry.name, entry.digest]))
  const names = [...new Set([...next.keys(), ...locked.keys()])].sort(stableCompare)
  const actions = []
  const planToken = canonicalDigest({ source: source.entries, target: targetRelative }).slice('sha256:'.length, 'sha256:'.length + 16)
  for (const name of names) {
    const expectedDigest = locked.get(name) ?? null
    const nextDigest = next.get(name) ?? null
    let currentDigest = null
    try {
      currentDigest = currentSkillDigest(targetRoot, name)
    } catch (error) {
      blockers.push(error.message)
      continue
    }
    if (expectedDigest && expectedDigest !== currentDigest) {
      blockers.push(`managed target skill ${name} has local drift; preserve or review it before sync`)
      continue
    }
    if (!nextDigest && expectedDigest) {
      if (!currentDigest) continue
      actions.push({ type: 'quarantine', name, expectedDigest, currentDigest, nextDigest: null, quarantinePath: portablePath(path.join('.atelier-local', 'skill-steward', 'quarantine', planToken, name)) })
    } else if (nextDigest && !currentDigest) {
      actions.push({ type: 'add', name, expectedDigest: null, currentDigest: null, nextDigest, quarantinePath: null })
    } else if (nextDigest && currentDigest && !expectedDigest) {
      blockers.push(`target skill ${name} already exists and is not managed by Atelier`)
    } else if (nextDigest && currentDigest && nextDigest === currentDigest) {
      actions.push({ type: 'unchanged', name, expectedDigest, currentDigest, nextDigest, quarantinePath: null })
    } else if (nextDigest && currentDigest) {
      actions.push({ type: 'update', name, expectedDigest, currentDigest, nextDigest, quarantinePath: portablePath(path.join('.atelier-local', 'skill-steward', 'quarantine', planToken, name)) })
    }
  }
  actions.sort((left, right) => stableCompare(left.name, right.name))
  blockers.sort(stableCompare)
  const catalogDigest = canonicalDigest(source.entries)
  const authoritative = {
    source: { packageName: packageJson.name, packageVersion: packageJson.version, catalogDigest,
      ext: { catalogOrigin: sourcePath === path.join(packageRoot, 'skills', 'codex') ? 'bundled-codex' : 'caller-selected' } },
    target: { path: targetRelative, lockPath: lockRelative },
    actions,
    blockers,
    authority: syncAuthority(),
    ext: { workspaceBinding: sha256(workspace), sourceBinding: sha256(sourcePath) },
  }
  const plan = {
    schema: ATELIER_SKILL_SYNC_PLAN_SCHEMA,
    generatedAt: clock(),
    planDigest: canonicalDigest(authoritative),
    applyAllowed: blockers.length === 0,
    ...authoritative,
  }
  const validation = validateSkillStewardDocument(plan, '#/$defs/syncPlan')
  if (validation.length) throw new Error(`generated skill sync plan violates its contract: ${validation.join('; ')}`)
  return plan
}

function copyBundle(sourceRoot, targetRoot, name, expectedDigest) {
  const source = path.join(sourceRoot, name)
  const target = path.join(targetRoot, name)
  fs.mkdirSync(target, { recursive: false, mode: 0o700 })
  const bundle = readSkillBundle(sourceRoot, name)
  for (const file of bundle.files) {
    const output = path.join(target, ...file.path.split('/'))
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 })
    fs.writeFileSync(output, file.bytes, { mode: 0o600, flag: 'wx' })
  }
  const copied = readSkillBundle(targetRoot, name)
  if (copied.digest !== bundle.digest) throw new Error(`staged skill ${name} digest mismatch`)
  if (copied.digest !== expectedDigest) throw new Error(`source skill ${name} changed after the confirmed plan was prepared`)
}

function ensureTargetDirectory(workspace, targetRoot) {
  const relative = path.relative(workspace, targetRoot)
  let current = workspace
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment)
    let stat = lstatIfPresent(current)
    if (!stat) {
      fs.mkdirSync(current, { mode: 0o700 })
      stat = fs.lstatSync(current)
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('skill sync target contains a redirected or non-directory component')
  }
}

function applySkillSyncLocked({
  workspaceRoot = process.cwd(),
  sourceRoot = path.join(packageRoot, 'skills', 'codex'),
  target = path.join('.agents', 'skills'),
  confirm,
  clock = () => new Date().toISOString(),
} = {}) {
  const workspace = fs.realpathSync(path.resolve(workspaceRoot))
  const targetRoot = containedPath(workspace, path.resolve(workspace, target), 'skill sync target')
  const plan = planSkillSync({ workspaceRoot: workspace, sourceRoot, target, clock })
  if (!DIGEST_PATTERN.test(String(confirm ?? '')) || confirm !== plan.planDigest) throw new Error('skill sync confirmation must exactly match the current plan digest')
  if (!plan.applyAllowed) throw new Error(plan.blockers.join('\n'))
  ensureTargetDirectory(workspace, targetRoot)

  const planKey = plan.actions.find((action) => action.quarantinePath)?.quarantinePath.split('/').at(-2) ?? plan.planDigest.slice('sha256:'.length, 'sha256:'.length + 16)
  const privateRoot = ensureContainedPrivateDirectory({ workspaceRoot: workspace, directory: path.join(workspace, '.atelier-local', 'skill-steward'), label: 'skill steward private state' })
  const stagingRoot = ensureContainedPrivateDirectory({ workspaceRoot: workspace, directory: path.join(privateRoot, 'staging', planKey), label: 'skill sync staging directory' })
  const quarantineRoot = ensureContainedPrivateDirectory({ workspaceRoot: workspace, directory: path.join(privateRoot, 'quarantine', planKey), label: 'skill sync quarantine directory' })
  if (fs.readdirSync(stagingRoot).length || fs.readdirSync(quarantineRoot).length) throw new Error('skill sync plan state already exists; inspect or clear the preserved state before retrying')

  const mutating = plan.actions.filter((action) => ['add', 'update'].includes(action.type))
  try {
    for (const action of mutating) copyBundle(path.resolve(sourceRoot), stagingRoot, action.name, action.nextDigest)
  } catch (error) {
    throw new Error(`skill sync staging failed: ${error.message}`)
  }

  const applied = []
  try {
    verifyDirectoryPath(workspace, targetRoot)
    if (planSkillSync({ workspaceRoot: workspace, sourceRoot, target, clock }).planDigest !== plan.planDigest) throw new Error('skill sync plan changed during staging')
    for (const action of plan.actions) {
      const currentDigest = currentSkillDigest(targetRoot, action.name)
      if (currentDigest !== action.currentDigest) throw new Error(`target skill ${action.name} changed after the confirmed plan was prepared`)
    }
    for (const action of plan.actions) {
      const targetSkill = path.join(targetRoot, action.name)
      const stagedSkill = path.join(stagingRoot, action.name)
      const quarantinedSkill = path.join(quarantineRoot, action.name)
      if (action.type === 'add') {
        fs.renameSync(stagedSkill, targetSkill)
        applied.push({ action, targetSkill, stagedSkill, quarantinedSkill })
      } else if (action.type === 'update') {
        fs.renameSync(targetSkill, quarantinedSkill)
        try {
          fs.renameSync(stagedSkill, targetSkill)
        } catch (error) {
          fs.renameSync(quarantinedSkill, targetSkill)
          throw error
        }
        applied.push({ action, targetSkill, stagedSkill, quarantinedSkill })
      } else if (action.type === 'quarantine') {
        fs.renameSync(targetSkill, quarantinedSkill)
        applied.push({ action, targetSkill, stagedSkill, quarantinedSkill })
      }
    }

    const lock = {
      schema: ATELIER_SKILL_SYNC_LOCK_SCHEMA,
      generatedAt: clock(),
      source: plan.source,
      target: plan.target.path,
      skills: plan.actions
        .filter((action) => action.nextDigest)
        .map((action) => ({ name: action.name, digest: action.nextDigest }))
        .sort((left, right) => stableCompare(left.name, right.name)),
      authority: syncAuthority(),
    }
    const validation = validateSkillStewardDocument(lock, '#/$defs/syncLock')
    if (validation.length) throw new Error(`generated skill sync lock violates its contract: ${validation.join('; ')}`)
    atomicReplacePrivateText(path.join(targetRoot, SKILL_SYNC_LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`, 0o600)
    try {
      fs.rmSync(stagingRoot, { recursive: true })
    } catch {
      // The applied projection is authoritative; leftover empty private state is diagnosable and ignored.
    }
    return {
      ok: true,
      schema: 'mnstry.atelier-skill-sync-result@v1',
      plan,
      lock,
      quarantined: applied.filter((item) => ['update', 'quarantine'].includes(item.action.type)).map((item) => portablePath(path.relative(workspace, item.quarantinedSkill))),
    }
  } catch (error) {
    for (const item of [...applied].reverse()) {
      try {
        if (item.action.type === 'add' && lstatIfPresent(item.targetSkill)) fs.renameSync(item.targetSkill, item.stagedSkill)
        if (item.action.type === 'update') {
          if (lstatIfPresent(item.targetSkill)) fs.renameSync(item.targetSkill, item.stagedSkill)
          if (lstatIfPresent(item.quarantinedSkill)) fs.renameSync(item.quarantinedSkill, item.targetSkill)
        }
        if (item.action.type === 'quarantine' && lstatIfPresent(item.quarantinedSkill)) fs.renameSync(item.quarantinedSkill, item.targetSkill)
      } catch {
        // Preserve every directory for manual recovery; never delete ambiguous state.
      }
    }
    throw new Error(`skill sync apply failed and preserved recovery state: ${error.message}`)
  }
}

export function applySkillSync(options = {}) {
  const workspace = fs.realpathSync(path.resolve(options.workspaceRoot ?? process.cwd()))
  // Confirmation is checked before creating private operation state.
  const plan = planSkillSync(options)
  if (options.confirm !== plan.planDigest) throw new Error('skill sync confirmation must exactly match the current plan digest')
  if (!plan.applyAllowed) throw new Error(plan.blockers.join('\n'))
  requirePrivatePlacement(workspace)
  const directory = ensureContainedPrivateDirectory({ workspaceRoot: workspace, directory: path.join(workspace, '.atelier-local', 'skill-steward'), label: 'skill steward private state' })
  const lockPath = path.join(directory, '.operation.lock')
  const descriptor = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600)
  try {
    return applySkillSyncLocked(options)
  } finally {
    fs.closeSync(descriptor)
    fs.unlinkSync(lockPath)
  }
}

export function validateSkillStewardDocument(document, pointer = null) {
  const schema = pointer
    ? { $schema: stewardSchema.$schema, $defs: stewardSchema.$defs, $ref: pointer }
    : stewardSchema
  return validateJsonSchema(schema, document)
}
