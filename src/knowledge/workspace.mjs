import fs from 'node:fs'
import path from 'node:path'
import { commandProject } from '../project/config.mjs'
import { buildCanonicalGraph, createGraphFileCache } from '../graph/graph.mjs'
import { openRegularFileNoFollow } from '../project/private-state.mjs'
import { digest, inspectKnowledgePlan, validateKnowledgePlan } from './plan.mjs'
import {
  createKnowledgeContext,
  evaluateKnowledgeQuestions,
} from './context.mjs'

export function readKnowledgePlan(project, name = 'knowledge-plan.json') {
  const file = path.resolve(project.configDir, name)
  const fd = openRegularFileNoFollow(file)
  try {
    if (fs.fstatSync(fd).size > 65536)
      throw new Error('knowledge plan exceeds 65536 bytes')
    const buffer = Buffer.alloc(65537)
    let count = 0
    while (count < buffer.length) {
      const read = fs.readSync(fd, buffer, count, buffer.length - count, null)
      if (!read) break
      count += read
    }
    if (count > 65536) throw new Error('knowledge plan exceeds 65536 bytes')
    const bytes = buffer.subarray(0, count)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const plan = JSON.parse(text)
    const errors = validateKnowledgePlan(plan)
    if (errors.length)
      throw new Error(`invalid knowledge plan: ${errors.join('; ')}`)
    // Raw bytes bind the workspace snapshot. Coauthor's text reader strips a
    // UTF-8 BOM, so its source binding must use the same decoded text digest.
    return { file, plan, sha256: digest(bytes), sourceDigest: digest(text) }
  } finally {
    fs.closeSync(fd)
  }
}

// One small, task-oriented curriculum. Domain definitions and evidence stay in
// the consuming plan and sources. Prompts are retained in each private session.
export const KNOWLEDGE_FLOWS = [
  {
    id: 'onboard',
    title: 'Onboard',
    description: 'Choose useful work and establish who can steward it.',
    prompts: [
      [
        'work',
        'What decision or deliverable should this workspace improve?',
        'Name a real task, who needs it, and what a useful result would change.',
      ],
      [
        'people',
        'Who owns the sources, maintains the model, and reviews the result?',
        'Name accountable roles and your own role. A typed name records a local assertion.',
      ],
      [
        'sources',
        'Which sources may be processed, and where must their use stop?',
        'Record source permissions, audiences, excluded material, and correction or withdrawal arrangements.',
      ],
      [
        'success',
        'How will you recognize useful work at an acceptable cost?',
        'Choose an unseen question, a direct-search comparison, and the time, correction, and measured usage you will record.',
      ],
    ],
  },
  {
    id: 'model',
    title: 'Model',
    description: 'Give the smallest useful vocabulary a precise meaning.',
    prompts: [
      [
        'concept',
        'Which concept matters to this question, and what does it mean?',
        'Give its definition, an example, and a counterexample. Reuse a concept before adding another.',
      ],
      [
        'identity',
        'How do you distinguish the same thing from two similar things?',
        'State a stable identity rule, aliases, false-merge risks, and how corrections preserve history.',
      ],
      [
        'relation',
        'Which directed relationship makes the evidence useful?',
        'Name both concepts, a native predicate, its direction, and its precise meaning. Distinguish an observation from an expectation.',
      ],
      [
        'test',
        'Which source-supported question would expose a bad model?',
        'Name decisive passages and unresolved evidence. Propose plan and record changes for the source owner to review.',
      ],
    ],
  },
  {
    id: 'deepen',
    title: 'Deepen',
    description:
      'Resolve missing evidence, conflicting claims, and gaps in the model.',
    prompts: [
      [
        'gap',
        'What can this workspace still not answer reliably?',
        'Choose a missing relationship, unsupported claim, stale source, contradiction, or unmodeled finding.',
      ],
      [
        'evidence',
        'What exactly does the source support?',
        'Cite record IDs and passages. Preserve speaker, date, negation, uncertainty, and alternative explanations.',
      ],
      [
        'proposal',
        'What is the smallest justified correction or addition?',
        'Propose a concept, relationship, or source correction. State why it helps this question and what could disprove it.',
      ],
      [
        'review',
        'Who should review it, and what remains unresolved?',
        'Record the reviewer, next evidence needed, and a concrete owner handoff. This draft does not apply a source change.',
      ],
    ],
  },
  {
    id: 'apply',
    title: 'Apply',
    description:
      'Use bounded evidence to produce a useful answer or an explicit abstention.',
    prompts: [
      [
        'answer',
        'What answer does the selected evidence support?',
        'Use source IDs and exact passages. Keep qualifications visible, and say when evidence is insufficient.',
      ],
      [
        'limits',
        'What remains uncertain or contradicted?',
        'Separate recorded facts, inference, proposals, and missing evidence. Do not fill a gap from a forecast.',
      ],
      [
        'action',
        'What should happen next, and who owns that decision?',
        'Name the proposed action or deliverable, prerequisites, recipient, and accountable owner. Saving does not execute it.',
      ],
      [
        'validation',
        'What must a reviewer verify before using this result?',
        'Specify the source checks and the observable outcome that would demonstrate useful work.',
      ],
    ],
  },
  {
    id: 'learn',
    title: 'Learn',
    description: 'Use observed outcomes to improve the next task.',
    prompts: [
      [
        'outcome',
        'What actually happened when this result was used?',
        'Separate intended action, observed outcome, and user acceptance. Cite outcome evidence or say it is not yet observed.',
      ],
      [
        'quality',
        'What did the person or agent get right, miss, or need help with?',
        'Record correctness, abstention, confusion, assistance, and correction effort on an unseen question.',
      ],
      [
        'cost',
        'What did the work cost compared with direct source search?',
        'Record elapsed time, actual input/output/cache tokens, provider cost, and correction minutes. Use unknown for unmeasured values.',
      ],
      [
        'change',
        'What should change in the ontology or workflow?',
        'Propose the smallest useful change, its owner, a regression question, and any lesson suitable for later reviewed reuse.',
      ],
    ],
  },
]

export function loadKnowledgeWorkspace(
  initial,
  planName = 'knowledge-plan.json'
) {
  // Re-read enrollment and local overrides on every operation. Explicit CLI
  // path overrides stay explicit; an edited project is not a cached authority.
  const overrides = initial.repos
    .filter((r) => r.pathSource === 'cli')
    .flatMap((r) => ['--repo-path', `${r.name}=${r.path}`])
  // Normalize the selected workspace directory, not internal plan/source links.
  // /tmp, /var, and user-created workspace aliases resolve to the same binding.
  const configDir = fs.realpathSync(initial.configDir)
  const project = commandProject({
    cwd: configDir,
    argv: [
      '--project',
      path.join(configDir, path.basename(initial.configPath)),
      ...overrides,
    ],
    writeLocalState: false,
  })
  const source = readKnowledgePlan(project, planName)
  const cache = createGraphFileCache()
  const graph = buildCanonicalGraph(project, { fileCache: cache })
  const inventory = [...cache.files]
    .map(([key, value]) => [key, value.digest])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const snapshot = digest(
    JSON.stringify({
      plan: source.sha256,
      config: project.config,
      repos: project.repos,
      nodes: graph.nodes,
      edges: graph.edges,
      inventory,
    })
  )
  return { project, ...source, cache, graph, snapshot }
}

export function knowledgeDashboard(workspace) {
  const { project, plan, graph, snapshot } = workspace
  const inspection = inspectKnowledgePlan(plan, graph)
  const evaluation = graph.ok ? evaluateKnowledgeQuestions(workspace) : null
  return {
    schema: 'atelier-knowledge-dashboard/experimental-v1',
    snapshot,
    name: project.config.name,
    purpose: plan.purpose,
    steward: plan.steward,
    reviewer: plan.reviewer,
    governance: plan.governance,
    budget: plan.budget,
    inspection,
    concepts: plan.concepts.map((c) => ({
      ...c,
      coverage: inspection.concepts?.find((x) => x.id === c.id) ?? null,
    })),
    relations: plan.relations.map((r) => ({
      ...r,
      coverage: inspection.relations?.find((x) => x.id === r.id) ?? null,
    })),
    questions: plan.questions,
    evaluation,
    flows: KNOWLEDGE_FLOWS,
    next: !inspection.ok
      ? {
          stage: 'onboard',
          reason: 'Repair the graph diagnostics before relying on context.',
        }
      : inspection.warnings.length
      ? { stage: 'deepen', reason: inspection.warnings[0] }
      : evaluation?.cases.some((c) => c.runs.graph.status === 'abstain-unverified')
      ? {
          stage: 'deepen',
          reason:
            'Matching evidence was omitted; the abstention cannot be verified. Inspect the listed omissions.',
        }
      : evaluation?.cases.some((c) => c.expect === 'abstain' && c.runs.graph.sourceIds.length)
      ? {
          stage: 'deepen',
          reason:
            'Matching evidence was retrieved for an expected abstention. Inspect the evidence and review the question.',
        }
      : evaluation?.cases.some(
          (c) =>
            !c.runs.graph.expectedEvidencePresent || c.runs.graph.stale.length
        )
      ? {
          stage: 'deepen',
          reason:
            'Resolve missing or changed evidence before using the affected answer.',
        }
      : {
          stage: 'apply',
          reason:
            'Try a useful question, inspect its evidence, and record the result for review.',
        },
    assurance:
      'Coverage checks describe retrieval. Human judgment, useful outcomes, and measured savings remain to be observed.',
    sourceEditsApplied: false,
    providerCalls: 0,
  }
}

export function knowledgeQuestionContext(workspace, id, mode = 'graph') {
  const question = workspace.plan.questions.find((q) => q.id === id)
  if (!question) throw new Error('unknown knowledge question')
  return createKnowledgeContext({
    ...workspace,
    question: question.question,
    mode,
  })
}
