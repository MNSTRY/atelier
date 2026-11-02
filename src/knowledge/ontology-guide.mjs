import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { validateKnowledgePlan as validatePlan } from './plan.mjs'
import { knowledgeQuestionContext as contextForQuestion } from './workspace.mjs'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const filled = value => typeof value === 'string' && value.trim().length > 0
const clone = value => structuredClone(value)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

// A draft adapter for the existing local workspace. It owns no source store,
// accepted concept identity, access decision, semantic verdict or apply path.
export function createOntologyGuide() {
  function bind(workspace, questionId) {
    const errors = validatePlan(workspace.plan)
    if (errors.length) throw new Error(`invalid current plan: ${errors.join('; ')}`)
    const question = workspace.plan.questions.find(q => q.id === questionId)
    if (!question) throw new Error('unknown knowledge question')
    const context = contextForQuestion(workspace, questionId)
    if (context.schema !== 'atelier-knowledge-context@v1' || context.planSha256 !== workspace.sha256)
      throw new Error('context is not bound to the current plan')
    return { question, context }
  }

  function prompts(workspace, questionId, entry = 'corpus') {
    const { question } = bind(workspace, questionId)
    if (!['corpus', 'blank'].includes(entry)) throw new Error('unknown entry route')
    return [
      { id: 'decision', view: 'onboard', field: 'concept', question: 'What decision will this help?', hint: question.work },
      { id: 'concept', view: 'model', field: 'concept', question: 'What is the thing you are naming?', hint: 'Choose an existing concept by identity; propose a definition only where it leaves a concrete gap.' },
      { id: 'identity', view: 'model', field: 'identity', question: 'How would you recognize the same thing next week?', hint: 'Give a stable identifying observation or key, and an example. A similar name or alias alone does not establish identity.' },
      { id: 'counterexample', view: 'model', field: 'identity', question: 'What close example should stay separate?', hint: 'Explain the difference and name any existing concept with which it could be confused.' },
      { id: 'evidence', view: 'deepen', field: 'test', question: 'Which source supports it?', hint: entry === 'blank' ? 'Write a permitted observation or interview note, or keep the answer unknown. A synthetic practice note stays labelled synthetic.' : 'Choose a permitted source already read by the current context; inspect the exact passage and qualifications.' },
      { id: 'relation', view: 'model', field: 'relation', question: 'What does this relationship mean in each direction?', hint: 'Describe the forward claim and how to read it from the other endpoint. The reverse reading creates no inverse assertion.' },
      { id: 'change', view: 'apply', field: 'test', question: 'What would change your mind?', hint: 'Give a disconfirming observation, unresolved evidence and next test; return to Learn after the outcome is observed.' },
    ]
  }

  function inspect(workspace, questionId, draft) {
    const { question, context } = bind(workspace, questionId)
    const diagnostics = []
    const add = (code, field, next) => diagnostics.push({ code, field, next })
    if (!object(draft)) return { status: 'needs-guidance', diagnostics: [{ code: 'draft-required', field: 'draft', next: 'Start a structured draft from the current question and workspace.' }], evidence: [], contextStatus: context.status }
    if (draft.snapshot !== workspace.snapshot || draft.basePlanSha256 !== workspace.sha256)
      add('changed-source', 'snapshot', 'Refresh the workspace, inspect changed sources and rebind a new draft; retain this one as historical.')
    if (!['corpus', 'blank'].includes(draft.entry)) add('entry-required', 'entry', 'Choose an existing corpus or a blank workspace.')
    if (!filled(draft.decision)) add('decision-required', 'decision', 'Name the decision this question could change.')
    const proposedPlan = draft.proposedPlan ?? workspace.plan
    const planErrors = validatePlan(proposedPlan)
    for (const error of planErrors) add('invalid-proposed-plan', 'proposedPlan', error)
    if (planErrors.length) return { status: 'needs-guidance', diagnostics, evidence: [], contextStatus: context.status }
    const proposedQuestion = proposedPlan.questions.find(q => q.id === question.id)
    if (!proposedQuestion) add('question-removed', 'proposedPlan', 'Retain the current question or propose its retirement separately with the source owner.')
    const concepts = proposedPlan.concepts
    const selected = draft.concepts ?? []
    if (!Array.isArray(selected) || !selected.length) add('concept-required', 'concepts', 'Choose the smallest existing concept set needed by this question.')
    const seen = new Set()
    for (const choice of Array.isArray(selected) ? selected : []) {
      if (!object(choice)) { add('invalid-concept-choice', 'concepts', 'Choose a concept by its exact plan identity.'); continue }
      const concept = concepts.find(c => c.id === choice.id)
      if (!concept) { add('unknown-concept', 'concepts', 'Select an exact concept ID; a name or alias is not an identity mapping.'); continue }
      if (seen.has(choice.id)) add('duplicate-concept', 'concepts', 'Keep one selection per concept identity.')
      seen.add(choice.id)
      for (const field of ['example', 'counterexample', 'identityBasis']) {
        if (!filled(choice[field])) add(`${field}-required`, `concepts.${choice.id}`, `Give a concrete ${field} for ${choice.id}; review its definition and identity rule.`)
      }
      if (filled(choice.example) && choice.example.trim() === choice.counterexample?.trim())
        add('indistinguishable-example', `concepts.${choice.id}`, 'Use a near miss that the stated identity rule actually keeps separate.')
      const collisions = concepts.filter(c => c.id !== concept.id && (c.definition.trim().toLowerCase() === concept.definition.trim().toLowerCase() || c.identityRule.trim().toLowerCase() === concept.identityRule.trim().toLowerCase()))
      for (const other of collisions) {
        if (!Array.isArray(choice.distinctFrom) || !choice.distinctFrom.some(x => object(x) && x.id === other.id && filled(x.reason)))
          add('ambiguous-identity', `concepts.${choice.id}`, `Explain how ${choice.id} differs from ${other.id}, or send an explicit mapping proposal for source-owner review. Do not merge them by name.`)
      }
      if (!proposedQuestion?.concepts.includes(choice.id)) add('orphan-concept', `concepts.${choice.id}`, 'Link the concept to the current question or remove it from this draft.')
    }
    for (const id of proposedQuestion?.concepts ?? []) {
      if (!seen.has(id)) add('untested-concept', 'concepts', `Inspect the definition, identity and near miss for ${id}.`)
    }
    for (const id of proposedQuestion?.relations ?? []) {
      const relation = proposedPlan.relations.find(r => r.id === id)
      const reading = Array.isArray(draft.relations) ? draft.relations.find(r => object(r) && r.id === id) : null
      if (!reading || !filled(reading.forward) || !filled(reading.reverse))
        add('directed-meaning-required', 'relations', `Explain ${relation.from} → ${relation.to} (${relation.predicate}) and its reverse reading; neither wording proves an accepted edge.`)
    }
    const evidence = []
    if (!Array.isArray(draft.evidence)) add('evidence-list-required', 'evidence', 'Select exact passages, or retain an empty list for an honest unknown.')
    for (const pin of Array.isArray(draft.evidence) ? draft.evidence : []) {
      if (!object(pin)) { add('invalid-evidence-pin', 'evidence', 'Choose a current source digest and exact passage.'); continue }
      const matches = context.sources.filter(s => s.id === pin.id)
      if (matches.length !== 1) { add('unavailable-or-ambiguous-source', 'evidence', 'Select one unambiguous source from the current permitted context; inspect omissions separately.'); continue }
      const source = matches[0]
      if (pin.sha256 !== source.sha256) { add('stale-evidence', 'evidence', 'Read the changed source and propose new pins explicitly; keep the old pin in history.'); continue }
      const lines = source.text.split('\n')
      if (source.text.endsWith('\n')) lines.pop()
      if (!Number.isSafeInteger(pin.start) || !Number.isSafeInteger(pin.end) || pin.start < 1 || pin.end < pin.start || pin.end > lines.length) {
        add('invalid-passage', 'evidence', 'Choose a complete existing line range in the selected source.'); continue
      }
      const passage = lines.slice(pin.start - 1, pin.end).join('\n')
      if (!filled(pin.quote) || pin.quote !== passage) { add('changed-passage', 'evidence', 'Copy the exact current passage, including its qualifications.'); continue }
      evidence.push({ id: source.id, repo: source.repo, path: source.path, sha256: source.sha256, start: pin.start, end: pin.end, quote: passage })
    }
    if (!['supported', 'abstain'].includes(draft.answer?.status) || !filled(draft.answer?.text))
      add('answer-required', 'answer', 'Write a source-supported proposed answer or an explicit abstention.')
    if (draft.answer?.status === 'supported' && !evidence.length)
      add('unsupported-answer', 'answer', 'Narrow the claim to an inspected source, or abstain and name the evidence needed.')
    if (draft.answer?.certainty !== 'qualified' || !filled(draft.answer?.limits))
      add('unsupported-certainty', 'answer', 'State scope, uncertainty, contradictions and alternative explanations. A retrieved passage alone does not establish certainty.')
    if (!filled(draft.wouldChangeMind)) add('disconfirmation-required', 'wouldChangeMind', 'Name an observation that could disconfirm the answer, or the next evidence needed to resolve the unknown.')
    return {
      status: diagnostics.length ? 'needs-guidance' : 'ready-for-human-review', diagnostics, evidence,
      contextStatus: context.status, coverage: clone(context.coverage), omissions: clone(context.omissions),
      abstention: draft.answer?.status === 'abstain' ? context.coverage.omitted ? 'unverified-omissions' : 'proposed' : null,
      assurance: 'Draft completeness and source binding only. The reviewer judges support, identity, meaning and the decision.',
    }
  }

  function prepareReview(workspace, questionId, draft, { basePlanText, planRef = 'knowledge-plan.json' }) {
    const result = inspect(workspace, questionId, draft)
    if (result.diagnostics.length) return { ok: false, ...result }
    if (sha256(Buffer.from(basePlanText, 'utf8')) !== workspace.sha256 || !isDeepStrictEqual(JSON.parse(basePlanText.replace(/^\uFEFF/, '')), workspace.plan))
      throw new Error('raw plan bytes differ from the bound source')
    if (!filled(planRef) || planRef.length > 500 || planRef.includes('\\') || planRef.split('/').some(p => !p || p.startsWith('.')) || planRef.startsWith('/'))
      throw new Error('visible workspace-relative plan reference required')
    const next = draft.proposedPlan ?? workspace.plan
    const proposedText = isDeepStrictEqual(next, workspace.plan) ? basePlanText : `${JSON.stringify(next, null, 2)}\n`
    const changes = Object.keys(next).filter(key => !isDeepStrictEqual(workspace.plan[key], next[key])).sort()
      .map(key => ({ path: `/${key}`, before: clone(workspace.plan[key]), after: clone(next[key]) }))
    const payload = {
      kind: 'ontology-guidance-draft', basePlanSha256: workspace.sha256, snapshot: workspace.snapshot, questionId,
      sourceEditsApplied: false, canonicalAdmission: false, reviewRequired: true,
      beforeText: basePlanText, proposedText, changes, evidence: result.evidence,
      retrieval: { status: result.contextStatus, coverage: result.coverage, omissions: result.omissions, abstention: result.abstention },
      guidance: { entry: draft.entry, decision: draft.decision, concepts: draft.concepts, relations: draft.relations ?? [], answer: draft.answer, wouldChangeMind: draft.wouldChangeMind },
      coauthor: { flow: 'model', fields: {
        concept: JSON.stringify({ decision: draft.decision, concepts: draft.concepts }),
        identity: JSON.stringify(draft.concepts.map(({ id, identityBasis, example, counterexample, distinctFrom }) => ({ id, identityBasis, example, counterexample, distinctFrom: distinctFrom ?? [] }))),
        relation: JSON.stringify(draft.relations ?? []),
        test: JSON.stringify({ evidence: result.evidence, answer: draft.answer, wouldChangeMind: draft.wouldChangeMind }),
      } },
    }
    // Existing copy-only store bounds each JSON/text payload at 50,000 chars.
    // Refuse rather than silently truncate the reviewable source or draft.
    const diff = JSON.stringify(changes, null, 2)
    if (JSON.stringify(payload).length > 49000 || diff.length > 49000) throw new Error('review draft exceeds the copy-only store bound; narrow the change')
    return { ok: true, status: 'proposed', sourceEditsApplied: false,
      body: { path: planRef, action: 'copy.repoPath', intent: 'Review a source-bound knowledge-plan proposal',
        capability: 'proposal.copy-only', directWrite: false, applyEndpoint: null,
        diff, proposal: payload },
    }
  }
  return { prompts, inspect, prepareReview }
}
