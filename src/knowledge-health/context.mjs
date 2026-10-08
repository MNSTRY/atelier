import { assessmentDigest } from './assessment.mjs'

const clone = value => structuredClone(value)
const demand = (ok, message) => { if (!ok) throw new TypeError(message) }
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value
export const knowledgeHealthContextDigest = value => assessmentDigest(JSON.stringify(canonical(value)))

/** A caller projection of existing outputs, never a canonical model or score. */
export function knowledgeHealthContext({ assessment, graph, planBytes, agentSuggestions = [], repositoryEvidence = null }) {
  demand(assessment?.projectionVersion === 'kh-required-direction-projection/r1'
    && assessment.grantsAuthority === false && Array.isArray(assessment.findings), 'Source-qualified assessment required')
  demand(Array.isArray(graph?.nodes) && Array.isArray(graph?.edges) && Array.isArray(graph?.diagnostics), 'Existing canonical graph required')
  demand(assessment.evidence.graphSha256 === knowledgeHealthContextDigest(graph), 'Assessment graph identity mismatch')
  demand(planBytes instanceof Uint8Array && assessmentDigest(planBytes) === assessment.evidence.planSha256, 'Assessment raw plan identity mismatch')
  const plan = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(planBytes))
  demand(Array.isArray(plan?.concepts) && Array.isArray(plan?.relations) && Array.isArray(plan?.questions), 'Typed plan required')
  demand(Array.isArray(agentSuggestions) && agentSuggestions.length <= 20, 'At most 20 supplied suggestions')
  const context = assessment.original.context
  const selected = new Map((context?.sources ?? []).map(s => [s.id, s]))
  const suggestions = agentSuggestions.map(suggestion => {
    demand(suggestion && typeof suggestion.text === 'string' && suggestion.text.trim()
      && Buffer.byteLength(suggestion.text) <= 4096 && Array.isArray(suggestion.citations)
      && suggestion.citations.length > 0 && suggestion.citations.length <= 20, 'Bounded suggestion and citations required')
    const p = suggestion.provenance
    demand(p && ['actorId', 'method', 'version', 'recordId'].every(k => typeof p[k] === 'string' && p[k].trim())
      && p.planSha256 === assessment.evidence.planSha256
      && p.readSetSha256 === assessment.evidence.readSetSha256, 'Suggestion provenance must bind this assessment')
    for (const c of suggestion.citations) {
      const source = selected.get(c.id)
      demand(source && c.sha256 === source.sha256, 'Suggestion citation is absent or stale')
    }
    return { text: suggestion.text, citations: clone(suggestion.citations), provenance: clone(p),
      status: 'caller-supplied-unreviewed', semanticSupport: 'unknown', grantsAuthority: false }
  })
  const byCode = Object.fromEntries([...new Set(graph.diagnostics.map(d => d.code ?? 'unspecified'))].sort()
    .map(code => [code, graph.diagnostics.filter(d => (d.code ?? 'unspecified') === code).length]))
  return {
    schema: 'atelier-knowledge-health-context@v0', projection: 'existing-output-view',
    assessment: clone(assessment),
    structure: { scope: 'This enrolled graph and typed plan; counts are observations, not health judgments.',
      records: { observed: graph.nodes.length, unclassified: assessment.original.report.unclassifiedRecords ?? null },
      edges: { observed: graph.edges.length, declared: graph.edges.filter(e => e.origin === 'declared').length,
        ordinaryLinks: graph.edges.filter(e => e.origin === 'ordinary-link').length },
      diagnostics: { observed: graph.diagnostics.length, byCode },
      concepts: { planned: plan.concepts.length, checked: assessment.original.report.concepts?.length ?? null,
        rows: clone(assessment.original.report.concepts ?? []) },
      relations: { planned: plan.relations.length, checked: assessment.original.report.relations?.length ?? null,
        rows: clone(assessment.original.report.relations ?? []) },
      questions: { planned: plan.questions.length, selected: context?.question ?? null } },
    coverage: context ? { state: assessment.coverage, ...clone(context.coverage), selected: context.sources.length,
      omissions: clone(context.omissions), budget: clone(context.budget) } : { state: 'unknown', selected: null },
    semantic: { qualification: 'not-assessed', support: 'unknown', providerCalls: 0,
      measuredCost: null, humanAcceptance: 'unobserved' },
    agentSuggestions: suggestions,
    repository: { state: repositoryEvidence === null ? 'unobserved' : 'caller-supplied-unverified',
      evidence: clone(repositoryEvidence), declared: 'unobserved', adopted: 'unobserved', consumed: 'unobserved', executed: 'unobserved' },
    reproducibility: { ...clone(assessment.evidence),
      graphDigestScope: 'Exact native graph output includes location-dependent options. Relocating changes that digest; source/read-set pins remain independently visible.' },
    grantsAuthority: false,
  }
}
