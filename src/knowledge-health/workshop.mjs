import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { resolveProjectConfig } from '../project/config.mjs'
import { openRegularFileNoFollow } from '../project/private-state.mjs'
import { assessmentDigest } from './assessment.mjs'
import { assessKnowledgeHealth } from './owner-join.mjs'
import { createGuidedContribution } from '../knowledge/participatory/index.mjs'

// A projection of the existing public workshop identities, not a new model.
const relationId = 'checklist-workshop'
const questionId = 'workshop-readiness'
const sourceId = 'devday:checklist'
const fieldId = 'kg.relations.supports'
const exampleBinding = Object.freeze({ storeId: 'devday-workshop-example', sourceId,
  artifactId: 'workshop-checklist', fieldId, actorBindingId: 'invented-workshop-owner' })

function read(file) {
  const fd = openRegularFileNoFollow(file)
  try {
    const size = fs.fstatSync(fd).size
    if (size > 65536) throw Error('Workshop input exceeds its 65536-byte bound')
    const bytes = Buffer.alloc(size + 1)
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0)
    if (count !== size) throw Error('Workshop input changed during read')
    return bytes.subarray(0, count)
  } finally { fs.closeSync(fd) }
}

/** Copy the actual shipped public fixture into a NEW disposable workspace. */
export function initializeKnowledgeHealthWorkshop(destination) {
  const root = path.resolve(destination)
  fs.mkdirSync(root, { recursive: false })
  fs.cpSync(fileURLToPath(new URL('../../fixtures/knowledge-health/workshop/', import.meta.url)), root,
    { recursive: true, force: false, errorOnExist: true })
  fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\noutput/\n', { flag: 'wx' })
  const git = spawnSync('git', ['init', '--quiet'], { cwd: root, encoding: 'utf8', timeout: 15000,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } })
  if (git.status !== 0) throw Error('Git initialization failed for the new disposable workshop')
  return root
}

/** Use the generic owner assessment against the participatory fixture itself.
 * Expected evidence is read unchanged. This function writes no source or plan.
 * A digest revision names source content; it is not an authoring-store head. */
export function assessKnowledgeHealthWorkshop({ workspaceRoot, authoringBinding = exampleBinding,
  sourceRevisions } = {}) {
  const root = path.resolve(workspaceRoot)
  if (authoringBinding.sourceId !== sourceId || authoringBinding.fieldId !== fieldId)
    throw Error('The existing workshop source and field binding are required')
  const project = resolveProjectConfig({ cwd: root, argv: ['--project', path.join(root, 'atelier.project.json')],
    env: {}, writeLocalState: false })
  const sourceBytes = read(path.join(root, 'records/checklist.md'))
  const planBytes = read(path.join(root, 'knowledge-plan.json'))
  const plan = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(planBytes))
  if (!plan.relations?.some(r => r.id === relationId && r.from === 'checklist' && r.to === 'workshop' && r.predicate === 'supports')
    || !plan.questions?.some(q => q.id === questionId && q.relations.includes(relationId)))
    throw Error('The participatory workshop plan is required; the pilot fixture is separate')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes)
  const matches = [...text.matchAll(/^    supports: (\[[^\r\n]*\])$/gm)]
  if (matches.length !== 1) throw Error('One exact inline workshop supports declaration is required')
  const match = matches[0], prefix = text.slice(0, match.index) + '    supports: '
  const start = Buffer.byteLength(prefix), quote = match[1], digest = assessmentDigest(sourceBytes)
  const revisions = sourceRevisions ?? ['checklist.md', 'workshop.md'].map(p => ({ repo: 'records', path: p,
    revision: `content-sha256:${assessmentDigest(read(path.join(root, 'records', p)))}` }))
  const revision = revisions.find(r => r.repo === 'records' && r.path === 'checklist.md')?.revision
  if (!revision) throw Error('The workshop checklist source revision is required')
  const binding = { source: { id: sourceId, repo: 'records', path: 'checklist.md', sha256: digest, revision },
    field: { id: fieldId, pointer: '/kg/relations/supports', format: 'markdown-inline-array',
      start, end: start + Buffer.byteLength(quote), quote }, authoring: structuredClone(authoringBinding) }
  const observed = assessKnowledgeHealth({ project, relationId, questionId, sourceRevisions: revisions,
    binding, currentSourceBytes: sourceBytes })
  const graphRun = observed.retrievalEvaluation?.cases.find(c => c.id === questionId)?.runs.graph
  return { ...observed, workshop: { sourceId, relationId, questionId, binding,
    sourceSha256: digest, planSha256: assessmentDigest(planBytes),
    expectedEvidence: structuredClone(plan.questions.find(q => q.id === questionId).expectedEvidence),
    evaluationStaleSources: graphRun ? [...graphRun.stale] : null,
    evaluationStatus: graphRun?.status ?? 'unavailable',
    sourceRevisionKind: sourceRevisions ? 'owner-supplied' : 'content-digest',
    sourceWritten: false, expectedEvidenceRefreshed: false, humanAcceptance: false } }
}

/** Compose the existing guided adapter and native caller with this observation.
 * The host supplies actual native APIs and a current join. All writes and
 * recovery remain in the existing native caller/store; none happen here. */
export function prepareKnowledgeHealthWorkshopChoice({ observation, adapter, caller, same, ...input } = {}) {
  const assessment = observation?.assessment, finding = assessment?.findings[0]
  const joined = input.joined, reference = joined?.finding?.reference, evidence = assessment?.evidence
  if (!finding || finding.source.id !== sourceId || evidence.relationId !== relationId
    || evidence.questionId !== questionId || !reference
    || reference.checkId !== finding.check.id || reference.checkVersion !== finding.check.version
    || reference.planSha256 !== evidence.planSha256 || reference.readSetSha256 !== evidence.readSetSha256
    || reference.comparisonSha256 !== evidence.comparisonSha256
    || joined.document?.binding.sourceId !== sourceId || joined.document?.binding.fieldId !== fieldId)
    throw Error('A current native join for this exact workshop observation is required')
  return createGuidedContribution({ adapter, caller, same }).prepareChoice(input)
}
