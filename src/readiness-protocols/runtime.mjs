import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createProposalStore } from '../collaboration/proposals.mjs'
import { readJson, writeJson } from '../project/config.mjs'
import { bundledReadinessPack, bundledReadinessProtocols, protocolById } from './bundled-pack.mjs'

export const READINESS_RUN_SCHEMA = 'atelier-readiness-run@v1'
export const TENANT_PACKET_SCHEMA = 'mnstry.tenant-readiness-packet@v1'
export const CLAIM_SCHEMA = 'atelier-claim@v1'

export const DIMENSIONS = [
  ['identity', 'identity readiness', 'mnstry.readiness:identity-map'],
  ['transformation', 'transformation clarity', 'mnstry.readiness:transformation-map'],
  ['offer', 'offer readiness', 'mnstry.readiness:offer-map'],
  ['space', 'space readiness', 'mnstry.readiness:space-design'],
  ['trackable', 'trackable readiness', 'mnstry.readiness:trackables'],
  ['consent', 'consent readiness', 'mnstry.readiness:consent-boundaries'],
  ['content', 'content/material readiness', 'mnstry.readiness:content-inventory'],
  ['discovery', 'discovery readiness', 'mnstry.readiness:discovery-engine'],
  ['journey', 'journey readiness', 'mnstry.readiness:journey-map'],
  ['operations', 'operations readiness', 'mnstry.readiness:operations-readiness'],
  ['runtime', 'runtime readiness', 'mnstry.readiness:runtime-readiness'],
  ['export', 'export readiness', 'mnstry.readiness:tenant-packet'],
]

export function readinessLocalRoot(project) {
  return path.join(project.configDir || project.workspaceRoot, '.atelier-local', 'readiness')
}

export function readinessRunsDir(project) {
  return path.join(readinessLocalRoot(project), 'runs')
}

export function readinessPacketsDir(project) {
  return path.join(readinessLocalRoot(project), 'packets')
}

function nowIso() {
  return new Date().toISOString()
}

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function slugify(value, fallback = 'item') {
  const clean = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return clean || fallback
}

function answerPresent(value) {
  if (value == null) return false
  if (Array.isArray(value)) return value.length > 0 && value.some(answerPresent)
  if (typeof value === 'object') return Object.keys(value).length > 0
  return String(value).trim().length > 0
}

function pathVariants(fieldId) {
  const plain = String(fieldId || '').replace(/\[\]/g, '')
  const root = plain.split('.')[0]
  return [...new Set([fieldId, plain, root].filter(Boolean))]
}

function nestedAnswer(value, parts) {
  if (!parts.length) return value
  if (Array.isArray(value)) return value.map((item) => nestedAnswer(item, parts)).filter(answerPresent)
  if (!value || typeof value !== 'object') return undefined
  const [head, ...rest] = parts
  return nestedAnswer(value[head], rest)
}

function answerForField(answers, fieldId) {
  for (const key of pathVariants(fieldId)) {
    if (Object.hasOwn(answers, key)) return answers[key]
  }
  const parts = String(fieldId || '').replace(/\[\]/g, '').split('.').filter(Boolean)
  return nestedAnswer(answers, parts)
}

export function normalizeAnswers(protocol, answers = {}) {
  const out = {}
  for (const question of protocol.questions) {
    if (Object.hasOwn(answers, question.id)) out[question.id] = answers[question.id]
  }
  for (const [key, value] of Object.entries(answers)) {
    if (!Object.hasOwn(out, key)) out[key] = value
  }
  return out
}

export function evaluateProtocolAnswers(protocol, answers = {}) {
  const blockers = []
  const warnings = []
  for (const field of protocol.inputFields) {
    if (field.required && !answerPresent(answerForField(answers, field.id))) blockers.push(`missing-answer:${field.id}`)
  }
  const required = protocol.inputFields.filter((field) => field.required)
  const answeredRequired = required.filter((field) => answerPresent(answerForField(answers, field.id)))
  const score = required.length ? Math.round((answeredRequired.length / required.length) * 100) : 100
  const status = blockers.length ? (Object.keys(answers).length ? 'draft' : 'missing') : 'review-needed'
  return { blockers, warnings, score, status }
}

export function claimsForProtocolRun({ protocol, answers, projectName, runId, createdAt }) {
  const protocolSlug = slugify(protocol.slug || protocol.id.split(':').at(-1), 'protocol')
  const subject = `readiness:${slugify(projectName, 'project')}:${protocolSlug}`
  return protocol.claimMappings.map((mapping) => {
    const mappingSlug = slugify(mapping.id.split('.').at(-1), 'claim')
    return {
    schema: CLAIM_SCHEMA,
    claimId: `claim:${runId}:${mappingSlug}`,
    subject,
    predicate: mapping.claimPredicate,
    object: `readiness:${protocolSlug}:${mappingSlug}`,
    provider: 'atelier-readiness',
    status: 'proposed',
    promoted: false,
    confidence: Object.values(answers).some(answerPresent) ? 0.7 : 0.2,
    evidence: [`readiness-run:${runId}`],
    notes: [`Proposed ${mapping.id} from ${protocol.title}.`],
    createdAt,
    }
  })
}

export function buildReadinessRun({ project, protocol, answers = {}, createdAt = nowIso() }) {
  const normalizedAnswers = normalizeAnswers(protocol, answers)
  const evaluation = evaluateProtocolAnswers(protocol, normalizedAnswers)
  const seed = JSON.stringify({ project: project.config.name || path.basename(project.workspaceRoot), protocol: protocol.id, answers: normalizedAnswers, createdAt })
  const runId = `readiness-run-${stableHash(seed).slice(0, 24)}`
  const projectName = project.config.name || path.basename(project.workspaceRoot)
  return {
    schema: READINESS_RUN_SCHEMA,
    runId,
    protocolId: protocol.id,
    createdAt,
    project: projectName,
    answers: normalizedAnswers,
    status: evaluation.status,
    score: evaluation.score,
    blockers: evaluation.blockers,
    warnings: evaluation.warnings,
    claims: claimsForProtocolRun({ protocol, answers: normalizedAnswers, projectName, runId, createdAt }),
    safety: {
      runtimeMutation: false,
      canonicalWrites: false,
      claimOnly: true,
      storage: 'ignored-local',
    },
  }
}

export function writeReadinessRun(project, run) {
  const dir = readinessRunsDir(project)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, `${run.runId}.json`)
  writeJson(file, run)
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    // Best effort on filesystems that do not support chmod.
  }
  return file
}

export function createReadinessProposal(project, run) {
  const store = createProposalStore({ workspaceRoot: project.configDir || project.workspaceRoot })
  return store.createProposal({
    path: `.atelier-local/readiness/runs/${run.runId}.json`,
    action: 'copy.agentPrompt',
    intent: `Review proposed claims from ${run.protocolId}.`,
    reason: 'MNSTRY Readiness protocol runs are claim-first and do not mutate canonical graph/front matter.',
    proposal: {
      kind: 'mnstry-readiness-run',
      protocolId: run.protocolId,
      runId: run.runId,
      claims: run.claims,
      safety: run.safety,
    },
    diff: JSON.stringify(run.claims, null, 2),
  })
}

export function listProtocolRuns(project) {
  const dir = readinessRunsDir(project)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      try {
        return readJson(path.join(dir, name))
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

export function summarizeReadinessJourney(project, { runs = listProtocolRuns(project) } = {}) {
  const runsByProtocol = new Map()
  for (const run of runs) runsByProtocol.set(run.protocolId, run)
  const dimensions = DIMENSIONS.map(([key, label, protocolId]) => {
    const protocol = protocolById(protocolId)
    const run = runsByProtocol.get(protocolId)
    const status = run ? run.status : 'missing'
    const score = run ? run.score ?? 0 : 0
    const blockers = run?.blockers ?? [`not-run:${protocolId}`]
    return {
      key,
      label,
      protocolId,
      title: protocol?.title ?? protocolId,
      status,
      score,
      blockers,
      warnings: run?.warnings ?? [],
      sourceRefs: run ? [`readiness-run:${run.runId}`] : [],
      proposedClaims: run?.claims?.map((claim) => claim.claimId) ?? [],
      nextSuggestedProtocol: status === 'ready' || status === 'review-needed' ? null : protocolId,
      agentPrompt: protocol?.ui?.agentPrompt ?? `Run atelier readiness run ${protocolId} --project ./atelier.project.json.`,
    }
  })
  const readyCount = dimensions.filter((item) => item.status === 'ready' || item.status === 'review-needed').length
  const score = Math.round((readyCount / dimensions.length) * 100)
  return {
    schema: 'mnstry.tenant-readiness-journey@v1',
    generatedAt: 'deterministic',
    project: project.config.name || path.basename(project.workspaceRoot),
    score,
    ready: readyCount === dimensions.length,
    dimensions,
    nextProtocol: dimensions.find((item) => item.nextSuggestedProtocol)?.nextSuggestedProtocol ?? null,
    pack: {
      id: bundledReadinessPack.id,
      version: bundledReadinessPack.version,
      protocolCount: bundledReadinessProtocols.length,
    },
  }
}

function answersFor(run, key) {
  return run?.answers?.[key] ?? null
}

export function buildTenantPacket(project, { runs = listProtocolRuns(project) } = {}) {
  const byId = new Map(runs.map((run) => [run.protocolId, run]))
  const journey = summarizeReadinessJourney(project, { runs })
  const packet = {
    schema: TENANT_PACKET_SCHEMA,
    generatedAt: 'deterministic',
    project: project.config.name || path.basename(project.workspaceRoot),
    readinessScore: journey.score,
    runtimeMutation: false,
    runtimeImport: false,
    tenantCandidate: answersFor(byId.get('mnstry.readiness:identity-map'), 'tenantCandidate') ?? answersFor(byId.get('mnstry.readiness:identity-map'), 'actors')?.[0]?.displayName ?? null,
    actorsAndRoles: {
      primaryPractitioner: answersFor(byId.get('mnstry.readiness:identity-map'), 'primaryPractitioner') ?? answersFor(byId.get('mnstry.readiness:identity-map'), 'actors')?.[0] ?? null,
      collaborators: answersFor(byId.get('mnstry.readiness:identity-map'), 'collaborators') ?? answersFor(byId.get('mnstry.readiness:identity-map'), 'actors')?.slice?.(1) ?? [],
    },
    boundaries: {
      privateDomainRepo: answersFor(byId.get('mnstry.readiness:identity-map'), 'privateDomainRepo'),
      privateMaterial: answersFor(byId.get('mnstry.readiness:consent-boundaries'), 'privateMaterial') ?? answersFor(byId.get('mnstry.readiness:consent-boundaries'), 'boundaries') ?? [],
      sharedMaterial: answersFor(byId.get('mnstry.readiness:consent-boundaries'), 'sharedMaterial') ?? [],
      runtimeConsentNeeds: answersFor(byId.get('mnstry.readiness:consent-boundaries'), 'runtimeConsentNeeds') ?? answersFor(byId.get('mnstry.readiness:consent-boundaries'), 'boundaries') ?? [],
    },
    offers: answersFor(byId.get('mnstry.readiness:offer-map'), 'offer') ? [{
      name: answersFor(byId.get('mnstry.readiness:offer-map'), 'offer')?.name,
      promise: answersFor(byId.get('mnstry.readiness:offer-map'), 'offer')?.promise,
      idealParticipant: answersFor(byId.get('mnstry.readiness:offer-map'), 'offer')?.audience,
    }] : [],
    spaces: {
      private: answersFor(byId.get('mnstry.readiness:space-design'), 'privateSpaces') ?? [],
      shared: answersFor(byId.get('mnstry.readiness:space-design'), 'sharedSpaces') ?? [],
      public: answersFor(byId.get('mnstry.readiness:space-design'), 'publicSpaces') ?? [],
      runtime: answersFor(byId.get('mnstry.readiness:space-design'), 'space') ? [answersFor(byId.get('mnstry.readiness:space-design'), 'space')] : [],
    },
    trackables: answersFor(byId.get('mnstry.readiness:trackables'), 'trackables') ?? [],
    materials: answersFor(byId.get('mnstry.readiness:content-inventory'), 'materials') ?? [],
    discoveryEngine: {
      audienceSignals: answersFor(byId.get('mnstry.readiness:discovery-engine'), 'audienceSignals') ?? answersFor(byId.get('mnstry.readiness:discovery-engine'), 'signals') ?? [],
      channels: answersFor(byId.get('mnstry.readiness:discovery-engine'), 'channels') ?? [],
      conversionPath: answersFor(byId.get('mnstry.readiness:discovery-engine'), 'conversionPath') ?? answersFor(byId.get('mnstry.readiness:discovery-engine'), 'nextSteps'),
    },
    journey: {
      entryPoint: answersFor(byId.get('mnstry.readiness:journey-map'), 'entryPoint') ?? answersFor(byId.get('mnstry.readiness:journey-map'), 'stages')?.[0] ?? null,
      commitmentPath: answersFor(byId.get('mnstry.readiness:journey-map'), 'commitmentPath') ?? answersFor(byId.get('mnstry.readiness:journey-map'), 'stages') ?? [],
      continuityLoop: answersFor(byId.get('mnstry.readiness:journey-map'), 'continuityLoop') ?? answersFor(byId.get('mnstry.readiness:journey-map'), 'handoffs') ?? [],
    },
    operationsRequirements: {
      roles: answersFor(byId.get('mnstry.readiness:operations-readiness'), 'roles') ?? answersFor(byId.get('mnstry.readiness:operations-readiness'), 'responsibilities') ?? [],
      runbooks: answersFor(byId.get('mnstry.readiness:operations-readiness'), 'runbooks') ?? [],
      policies: answersFor(byId.get('mnstry.readiness:operations-readiness'), 'policies') ?? answersFor(byId.get('mnstry.readiness:operations-readiness'), 'escalations') ?? [],
    },
    runtimeObjectCandidates: answersFor(byId.get('mnstry.readiness:runtime-readiness'), 'runtimeObjectCandidates') ?? answersFor(byId.get('mnstry.readiness:runtime-readiness'), 'runtimeOwners') ?? [],
    exportBlockers: [
      ...journey.dimensions.filter((item) => item.status === 'missing' || item.status === 'draft').map((item) => `readiness-incomplete:${item.protocolId}`),
      ...(answersFor(byId.get('mnstry.readiness:tenant-packet'), 'exportBlockers') ?? []),
    ],
    openQuestions: answersFor(byId.get('mnstry.readiness:tenant-packet'), 'openQuestions') ?? [],
    proposedClaims: runs.flatMap((run) => run.claims ?? []).map((claim) => claim.claimId),
  }
  return packet
}

export function writeTenantPacket(project, packet) {
  const dir = readinessPacketsDir(project)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, 'tenant-readiness-packet.json')
  writeJson(file, packet)
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    // Best effort on filesystems that do not support chmod.
  }
  return file
}

export function buildReadinessExportDryRun(project) {
  const packet = buildTenantPacket(project)
  return {
    schema: 'mnstry.readiness-export-dry-run@v1',
    generatedAt: 'deterministic',
    project: packet.project,
    accepted: true,
    importable: false,
    dryRunOnly: true,
    runtimeMutation: false,
    runtimeImport: false,
    worstOperationStatus: packet.exportBlockers.length ? 'blocked' : 'warning',
    tenantPacket: packet,
    blockers: [
      'runtime-import-not-implemented',
      ...packet.exportBlockers,
    ],
  }
}

export function runProtocol(project, protocolId, { answers = {}, write = true, createProposal = true } = {}) {
  const protocol = protocolById(protocolId)
  if (!protocol) throw new Error(`unknown readiness protocol: ${protocolId}`)
  const run = buildReadinessRun({ project, protocol, answers })
  const file = write ? writeReadinessRun(project, run) : null
  const proposal = createProposal ? createReadinessProposal(project, run) : null
  return { run, file, proposal }
}
