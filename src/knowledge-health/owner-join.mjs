import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { buildCanonicalGraph, createGraphFileCache } from '../graph/graph.mjs'
import { splitFrontmatter, parseYamlSubset } from '../graph/knowledge-graph.mjs'
import { inspectKnowledgePlan } from '../knowledge/plan.mjs'
import { createKnowledgeContext, evaluateKnowledgeQuestions } from '../knowledge/context.mjs'
import { openRegularFileNoFollow } from '../project/private-state.mjs'
import { assessmentDigest, createAssessmentProjector } from './assessment.mjs'
import { knowledgeHealthContext, knowledgeHealthContextDigest } from './context.mjs'

// Receiving proposal: place this directory beside the existing owner modules.
// It joins their functions; it adds no graph rules, root CLI or source writer.
import { ruleIdentity as identity } from './rule-identity.mjs'
function verifyRules() {
  for (const pin of identity.files) {
    const bytes = fs.readFileSync(new URL(`../../${pin.path}`, import.meta.url))
    if (assessmentDigest(bytes) !== pin.sha256) throw new Error(`Knowledge Health rule identity drift: ${pin.path}`)
  }
}
const pinFor = file => identity.files.find(p => p.path === file)
const check = { id: 'atelier.inspectKnowledgePlan.required-direction', version: identity.commit,
  sourceTree: identity.tree, sourceBlob: pinFor('src/knowledge/plan.mjs').blob,
  schemaBlob: pinFor('templates/knowledge-workspace/knowledge-plan.schema.json').blob,
  graphBlob: pinFor('src/graph/graph.mjs').blob, sourceSha256: pinFor('src/knowledge/plan.mjs').sha256 }
const projectAssessment = createAssessmentProjector({ inspectKnowledgePlan, splitFrontmatter, parseYamlSubset, check })

function readBounded(file, ceiling) {
  const fd = openRegularFileNoFollow(file)
  try {
    if (fs.fstatSync(fd).size > ceiling) throw new Error('Assessment input exceeds byte ceiling')
    const bytes = Buffer.alloc(ceiling + 1)
    let count = 0, read
    while (count < bytes.length && (read = fs.readSync(fd, bytes, count, bytes.length - count, null)) > 0) count += read
    if (count > ceiling) throw new Error('Assessment input exceeds byte ceiling')
    return bytes.subarray(0, count)
  } finally { fs.closeSync(fd) }
}

/** Read-only assessment of an existing resolved project. Binding and revisions
 * come from the source's owner. A content digest is not a durable store head. */
export function assessKnowledgeHealth({ project, planPath = 'knowledge-plan.json', relationId, questionId,
  sourceRevisions, binding, currentSourceBytes, maxContextBytes, agentSuggestions = [], repositoryEvidence = null }) {
  verifyRules()
  if (!project?.configPath || !project?.repoAccessPath || !Array.isArray(sourceRevisions)) {
    throw new TypeError('Existing resolved project, explicit access file and source revisions required')
  }
  const file = path.resolve(project.configDir, planPath)
  const planBytes = readBounded(file, 65536), planSha256 = assessmentDigest(planBytes)
  const plan = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(planBytes))
  const configBytes = readBounded(project.configPath, 1048576)
  if (!isDeepStrictEqual(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(configBytes)), project.config)) {
    throw new TypeError('Resolved project config is stale; resolve it again before assessment')
  }
  const scope = { projectSha256: assessmentDigest(configBytes),
    repoAccessSha256: assessmentDigest(readBounded(project.repoAccessPath, 1048576)),
    resolvedReposSha256: knowledgeHealthContextDigest(project.repos) }
  const revisionKeys = sourceRevisions.map(r => JSON.stringify([r.repo, r.path]))
  if (new Set(revisionKeys).size !== revisionKeys.length) throw new TypeError('Duplicate source revision')
  const revisions = new Map(sourceRevisions.map(r => [JSON.stringify([r.repo, r.path]), r.revision]))
  const cache = createGraphFileCache(), graph = buildCanonicalGraph(project, { fileCache: cache })
  const readSet = { scope, entries: [...cache.files].map(([key, value]) => {
    const [repo, sourcePath] = key.split('\u0000')
    const revision = revisions.get(JSON.stringify([repo, sourcePath]))
    if (typeof revision !== 'string' || !revision.trim()) throw new TypeError('Missing exact source revision')
    return { repo, path: sourcePath, sha256: value.digest, revision }
  }) }
  const native = inspectKnowledgePlan(plan, graph)
  const question = plan.questions?.find(q => q.id === questionId)
  const context = native.ok && graph.ok && question
    ? createKnowledgeContext({ project, plan, sha256: planSha256, graph, cache,
      question: question.question, ...(maxContextBytes === undefined ? {} : { maxBytes: maxContextBytes }) }) : null
  // Expected pins are an evaluation input, not a retrieval input. Never update
  // them because a source was edited: stale evaluation remains visible.
  const evaluation = native.ok && graph.ok ? evaluateKnowledgeQuestions({ project, plan, sha256: planSha256, graph, cache }) : null
  if (scope.projectSha256 !== assessmentDigest(readBounded(project.configPath, 1048576))
    || scope.repoAccessSha256 !== assessmentDigest(readBounded(project.repoAccessPath, 1048576))
    || planSha256 !== assessmentDigest(readBounded(file, 65536))) throw new Error('Assessment scope changed during read; rerun from current inputs')
  const assessment = projectAssessment({ planBytes, planSha256, graph, context, evaluation: null,
    readSet, relationId, questionId, binding, currentSourceBytes })
  // Retrieval evaluation can retain stale baseline expectations after an
  // authorized edit while the current structural reassessment clears. These
  // are separate facts. Caller can feed evaluation to the pure projector when
  // its task specifically requires those frozen expected-evidence pins.
  return { assessment, retrievalEvaluation: evaluation,
    context: Array.isArray(plan.concepts) && Array.isArray(plan.relations) && Array.isArray(plan.questions)
      ? knowledgeHealthContext({ assessment, graph, planBytes, agentSuggestions, repositoryEvidence }) : null }
}
