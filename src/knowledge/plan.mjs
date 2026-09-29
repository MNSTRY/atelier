import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { validateJsonSchema } from '../export/atelier-export-contract.mjs'

const schema = JSON.parse(fs.readFileSync(new URL('../../templates/knowledge-workspace/knowledge-plan.schema.json', import.meta.url), 'utf8'))
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

export function validateKnowledgePlan(plan) {
  const errors = validateJsonSchema(schema, plan)
  if (errors.length) return errors
  const unique = (values, label) => {
    if (new Set(values).size !== values.length) errors.push(`duplicate ${label}`)
  }
  unique(plan.concepts.map(x => x.id), 'concept id')
  unique(plan.concepts.map(x => x.tag), 'concept tag')
  unique(plan.relations.map(x => x.id), 'relation id')
  unique(plan.questions.map(x => x.id), 'question id')
  const concepts = new Set(plan.concepts.map(x => x.id))
  const relations = new Set(plan.relations.map(x => x.id))
  for (const relation of plan.relations) {
    if (!concepts.has(relation.from) || !concepts.has(relation.to)) errors.push(`relation ${relation.id} references an unknown concept`)
  }
  for (const question of plan.questions) {
    if (question.concepts.some(x => !concepts.has(x))) errors.push(`question ${question.id} references an unknown concept`)
    if (question.relations.some(x => !relations.has(x))) errors.push(`question ${question.id} references an unknown relation`)
    unique(question.expectedEvidence.map(x => x.id), `evidence id for ${question.id}`)
    if ((question.expect === 'abstain') !== (question.expectedEvidence.length === 0)) errors.push(`question ${question.id} needs evidence for evidence, and none for abstain`)
  }
  return errors
}

export function inspectKnowledgePlan(plan, graph) {
  const errors = validateKnowledgePlan(plan)
  if (errors.length) return { ok: false, errors, warnings: [] }
  errors.push(...graph.errors)
  const warnings = []
  const knownTags = new Set(plan.concepts.map(c => c.tag))
  for (const node of graph.nodes) {
    if (node.tags.some(tag => tag.startsWith('concept:') && !knownTags.has(tag))) warnings.push(`record ${node.id} uses a concept tag absent from the plan`)
  }
  const members = new Map(plan.concepts.map(c => [c.id, graph.nodes.filter(n => n.tags.includes(c.tag))]))
  const concepts = plan.concepts.map(c => {
    const usedBy = plan.questions.filter(q => q.concepts.includes(c.id)).map(q => q.id)
    if (!usedBy.length) warnings.push(`concept ${c.id} supports no question; remove it or explain its useful work`)
    if (!members.get(c.id).length) warnings.push(`concept ${c.id} has no source records`)
    return { id: c.id, records: members.get(c.id).length, questions: usedBy }
  })
  const relations = plan.relations.map(r => {
    const from = new Set(members.get(r.from).map(n => n.id))
    const to = new Set(members.get(r.to).map(n => n.id))
    const matches = graph.edges.filter(e => e.declared && e.type === r.predicate && from.has(e.source) && to.has(e.target))
    if (!matches.length) warnings.push(`relation ${r.id} has no declared edge in the required direction`)
    if (!plan.questions.some(q => q.relations.includes(r.id))) warnings.push(`relation ${r.id} supports no question`)
    return { id: r.id, matchingEdges: matches.length }
  })
  return { ok: errors.length === 0, status: errors.length ? 'invalid' : warnings.length ? 'needs-attention' : 'structurally-valid', errors, warnings, concepts, relations,
    unclassifiedRecords: graph.nodes.filter(n => n.classification === 'unclassified').length,
    assurance: 'Structure and coverage only; definitions, source rights, meaning, and usefulness require human review.' }
}
