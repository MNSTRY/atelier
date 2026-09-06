import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { canonicalize } from '../attestation/jcs.mjs'
import { buildGraph } from '../graph/graph.mjs'
import {
  loadExtensionPacks,
  createProtocolRegistry,
} from '../extension-packs/loader.mjs'
import { readRegularTextNoFollow } from '../project/private-state.mjs'
import { createCollaborationEventLedger } from '../collaboration/event-ledger.mjs'
import { inspectPackLifecycle } from '../extension-packs/lifecycle.mjs'
import { readLocalOverlay } from '../project/config.mjs'
import { readBoundedSource } from './source-read.mjs'
export { readBoundedSource } from './source-read.mjs'
import { validReviewArtifact } from '../collaboration/review-contracts.mjs'
import { buildReadinessRun, answerForField } from './runtime.mjs'

export const hashEvidence = (value) =>
  `sha256:${crypto
    .createHash('sha256')
    .update(canonicalize(value))
    .digest('hex')}`
const hashBytes = (value) =>
  `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`
const packageRoot = fileURLToPath(new URL('../../', import.meta.url))
function evaluatorInventory() {
  const files = ['package.json']
  function visit(relative) {
    for (const name of fs
      .readdirSync(path.join(packageRoot, relative))
      .sort()) {
      const next = path.posix.join(relative, name),
        stat = fs.lstatSync(path.join(packageRoot, next))
      if (stat.isSymbolicLink()) throw new Error('redirected evaluator input')
      if (stat.isDirectory()) visit(next)
      else if (stat.isFile() && /\.(mjs|json)$/.test(name)) files.push(next)
    }
  }
  visit('src')
  visit('contracts')
  return files
    .sort()
    .map((file) => ({
      file,
      digest: hashBytes(readRegularTextNoFollow(path.join(packageRoot, file))),
    }))
}
const evaluator = hashEvidence(evaluatorInventory())

function currentInputs(project, protocolId, answers) {
  if (
    project.configPath &&
    hashEvidence(JSON.parse(readRegularTextNoFollow(project.configPath))) !==
      hashEvidence(project.config)
  )
    throw new Error('project config changed; resolve the project again')
  if (hashEvidence(evaluatorInventory()) !== evaluator)
    throw new Error('evaluator changed; restart before review')
  if (
    project.localOverlay &&
    hashEvidence(readLocalOverlay({ configDir: project.configDir }).overlay) !==
      hashEvidence(project.localOverlay.overlay)
  )
    throw new Error('local overlay changed; resolve again')
  const loaded = loadExtensionPacks(project)
  const packs = loaded.packs ?? loaded
  const lifecycle = inspectPackLifecycle(project, packs)
  if (!lifecycle.ok) throw new Error(lifecycle.errors.join('; '))
  const registry = createProtocolRegistry({ packs })
  const protocol = registry.protocolById(protocolId)
  if (!protocol) throw new Error('protocol unavailable for evidence binding')
  const graph = buildGraph(project)
  if (graph.errors.length)
    throw new Error('source graph is invalid; evidence capture refused')
  if (graph.nodes.length > 256)
    throw new Error('review evidence exceeds bounded source count')
  const sources = [],
    excerpts = new Map()
  for (const node of graph.nodes) {
    const repo = project.repos.find(
      (entry) => entry.name === node.repo && !entry.external,
    )
    if (!repo?.path) throw new Error('source repository unavailable')
    const source = readBoundedSource(repo.path, node.path)
    const metadata = !/\.md$/i.test(node.path)
      ? readBoundedSource(repo.path, `${node.path}.kg.json`).digest
      : null
    excerpts.set(node.id, source.text.slice(0, 2000))
    sources.push({
      id: node.id,
      repo: node.repo,
      path: node.path,
      audience: node.audience,
      digest: source.digest,
      metadata,
    })
  }
  sources.sort((a, b) =>
    `${a.repo}/${a.path}`.localeCompare(`${b.repo}/${b.path}`, 'en'),
  )
  const claimEvidence = protocol.claimMappings.map((mapping) => {
    const raw = answerForField(answers, mapping.evidence)
    const references = (Array.isArray(raw) ? raw.flat(Infinity) : [raw])
      .filter((value) => typeof value === 'string' && value.trim())
      .map((value) => value.trim())
    const resolved = [],
      unresolved = []
    for (const reference of references) {
      const source = sources.find((item) => item.id === reference)
      if (source)
        resolved.push({
          id: source.id,
          repo: source.repo,
          path: source.path,
          digest: source.digest,
          excerpt: excerpts.get(source.id),
        })
      else unresolved.push(reference)
    }
    return {
      mappingId: mapping.id,
      sourceFields: mapping.sourceFields,
      answers: Object.fromEntries(
        mapping.sourceFields.map((field) => [
          field,
          answerForField(answers, field) ?? null,
        ]),
      ),
      evidenceField: mapping.evidence,
      references,
      resolved,
      unresolved,
      status: !references.length
        ? 'missing'
        : unresolved.length
        ? 'unresolved'
        : 'linked-source',
    }
  })
  const readPolicy = (file) =>
    fs.existsSync(file) ? hashBytes(readRegularTextNoFollow(file)) : null
  return {
    schema: 'atelier-review-evidence@v1',
    protocolId,
    protocol,
    protocolDigest: hashEvidence(protocol),
    answers,
    answersDigest: hashEvidence(answers),
    configDigest: hashEvidence(project.config),
    lifecycleDigest: hashEvidence(lifecycle),
    policyDigest: hashEvidence({
      access: readPolicy(project.repoAccessPath),
      boundary: readPolicy(project.boundaryPolicyPath),
    }),
    packs: packs
      .map(({ id, version, digest }) => ({ id, version, digest }))
      .sort((a, b) => a.id.localeCompare(b.id, 'en')),
    evaluator: { id: 'answer-completeness/v1', digest: evaluator },
    sources,
    claimEvidence,
    limitations: [
      'Answers are operator assertions; source presence does not substantiate each claim.',
      'No calibrated evidence confidence or runtime acceptance is established.',
    ],
  }
}

export function captureReviewEvidence(project, protocolId, answers) {
  const first = currentInputs(project, protocolId, answers)
  const second = currentInputs(project, protocolId, answers)
  const digest = hashEvidence(first)
  if (digest !== hashEvidence(second))
    throw new Error('review inputs changed during capture')
  const snapshot = { ...first, digest }
  if (!validReviewArtifact('evidence', snapshot))
    throw new Error('evidence contract invalid or exceeds bounds')
  return snapshot
}

export function evidenceLedger(project) {
  return createCollaborationEventLedger({
    workspaceRoot: project.configDir,
    ledgerPath: path.join(
      project.configDir,
      '.atelier-local/review/evidence.ndjson',
    ),
  })
}

export function recordReviewEvidence(project, run) {
  const snapshot = captureReviewEvidence(project, run.protocolId, run.answers)
  if (
    hashEvidence(
      buildReadinessRun({
        project,
        protocol: snapshot.protocol,
        answers: run.answers,
        createdAt: run.createdAt,
      }),
    ) !== hashEvidence(run)
  )
    throw new Error('run no longer matches its current protocol and evaluator')
  const payload = {
    schema: 'atelier-bound-run@v1',
    run,
    runDigest: hashEvidence(run),
    snapshot,
  }
  if (!validBoundRun(payload)) throw new Error('bound run contract invalid')
  const ledger = evidenceLedger(project)
  const existing = ledger.eventsFor(run.runId)
  if (!existing.ok) throw new Error(existing.error)
  if (existing.events.length) {
    if (hashEvidence(existing.events[0].payload) !== hashEvidence(payload))
      throw new Error('run identity already has different evidence')
    return existing.events[0].payload
  }
  const result = ledger.append({
    aggregateId: run.runId,
    expectedVersion: 0,
    type: 'run-bound',
    actor: 'local-runtime',
    payload,
  })
  if (!result.ok) throw new Error(result.error)
  return payload
}

export function validBoundRun(payload) {
  if (!validReviewArtifact('bound', payload)) return false
  const { digest, ...body } = payload.snapshot
  const { run, snapshot } = payload
  return (
    payload.runDigest === hashEvidence(run) &&
    digest === hashEvidence(body) &&
    snapshot.protocolDigest === hashEvidence(snapshot.protocol) &&
    snapshot.answersDigest === hashEvidence(snapshot.answers) &&
    snapshot.answersDigest === hashEvidence(run.answers) &&
    snapshot.protocol.id === run.protocolId &&
    snapshot.protocolId === run.protocolId &&
    snapshot.claimEvidence.length === run.claims.length &&
    snapshot.claimEvidence.every(
      (entry, index) =>
        entry.mappingId === snapshot.protocol.claimMappings[index]?.id,
    )
  )
}

export function loadBoundRun(project, runId) {
  const result = evidenceLedger(project).eventsFor(runId)
  if (!result.ok) return result
  if (result.events.length !== 1 || result.events[0].type !== 'run-bound')
    return {
      ok: false,
      status: 409,
      error: 'run lacks immutable review evidence',
    }
  const payload = result.events[0].payload
  const { digest, ...body } = payload.snapshot ?? {}
  if (
    !validBoundRun(payload) ||
    payload.schema !== 'atelier-bound-run@v1' ||
    payload.run?.runId !== runId ||
    payload.runDigest !== hashEvidence(payload.run) ||
    digest !== hashEvidence(body)
  )
    return { ok: false, status: 422, error: 'run evidence is invalid' }
  return { ok: true, status: 200, ...payload }
}

export function currentRunEligibility(project, bound) {
  try {
    return (
      captureReviewEvidence(project, bound.run.protocolId, bound.run.answers)
        .digest === bound.snapshot.digest
    )
  } catch {
    return false
  }
}
