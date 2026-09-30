import fs from 'node:fs'
import { digest } from '../src/capabilities/files.mjs'
import { inquiryRef, inspectInquiry } from '../src/inquiry/index.mjs'

const records = [], at = '2026-01-01T00:00:00.000Z'
const add = (kind, id, data) => { const r = { schema: 'atelier-inquiry-record@v1', kind, id, campaign: 'workshop', at, by: 'synthetic-operator', data }; records.push(r); return r }
add('campaign', 'workshop', { title: 'Fictional workshop inquiry', purpose: 'Learn whether a reminder helps return visits.', scope: 'Invented workshop; no real participants or study results.', owner: 'synthetic-operator', audience: 'private', stoppingRule: 'Stop after checking the agreed evidence and naming remaining uncertainty.' })
const h = add('hypothesis', 'reminder', { question: 'Does a reminder improve return visits?', scope: 'workshop-visitors', context: 'A fictional workshop over one month.', alternatives: ['A reminder helps recall.', 'Scheduling constraints dominate.', 'The apparent change is selection bias.'], testPlan: 'Plan a reversible trial before observing outcomes. Treat these examples as fictional arithmetic.' })
const request = add('request', 'research', { hypothesis: inquiryRef(h), question: h.data.question, context: h.data.context,
  lenses: [{ id: 'mechanism', question: 'Which mechanisms could explain a change?', method: 'Compare competing explanations.', exclusions: 'Do not assume a causal effect.' }, { id: 'counterevidence', question: 'When does a reminder fail?', method: 'Seek conflicting evidence and scope differences.', exclusions: 'Do not count repeated citations as independent evidence.' }],
  sourceStandards: ['Preserve complete captures and exact quotes.', 'Separate verified statements from interpretation.'], maxReports: 4, budget: 'Manual capture only; no provider spend.', allowedEffects: ['read-workspace', 'write-workspace'],
  binding: { package: 'mnstry.atelier/research-harness', releaseDigest: `sha256:${'a'.repeat(64)}`, generation: `sha256:${'b'.repeat(64)}`, binding: '.agents/skills/atelier-research-harness', bindingDigest: `sha256:${'c'.repeat(64)}`, host: 'codex-repo-v1', session: 'synthetic-session' } })
const source = (id, family, content, scope = 'workshop-visitors') => add('source', id, { locator: `invented:${id}`, audience: 'private', content, digest: digest(content), family, scope, method: 'Synthetic demonstration; not an empirical observation.' })
const positive = source('study', 'study-family', 'Invented report: a reminder could help visitors return.')
const duplicate = source('summary', 'study-family', 'Invented summary of the same study: a reminder could help visitors return.')
const negative = source('counterstudy', 'counter-family', 'Invented counterevidence: scheduling barriers remain despite reminders.')
const outside = source('different-population', 'outside-family', 'Invented finding in a different population.', 'other-visitors')
function bundle(id, src, stance) {
  return add('bundle', id, { request: inquiryRef(request), attempt: id, provider: { tool: 'manual-fixture', model: 'unknown', runId: 'unknown' }, prompt: 'Synthetic standalone research prompt; no provider was executed.', reports: [inquiryRef(src)], assertions: [{ id: 'finding', statement: src.data.content, source: inquiryRef(src), quote: src.data.content, verification: 'verified', stance }], synthesis: 'Fictional evidence for a worked example.', conflicts: ['Different mechanisms remain plausible.'], gaps: ['No real research has been performed.'], newQuestions: ['Which contextual factors would change this result?'] })
}
const a = bundle('report', positive, 'supports'), b = bundle('repeat-report', duplicate, 'supports'), c = bundle('counter-report', negative, 'contradicts')
bundle('outside-report', outside, 'neutral')
const ev = r => ({ bundle: inquiryRef(r), assertion: 'finding' })
function odds(id, items, ratios) {
  return add('assessment', id, { hypothesis: inquiryRef(h), evidence: items.map(ev), model: { kind: 'elicited-odds', prior: 0.4, sensitivityPriors: [0.2, 0.6], priorFamilies: [], assumptions: 'Invented elicitation values. Independent families assumed conditional on H and not H; repeated family is one contribution.', likelihoods: items.map((r, i) => ({ key: `${r.id}/finding`, ratio: ratios[i] })) }, rationale: 'Arithmetic illustration only; neither likelihoods nor prior are empirically calibrated.' })
}
odds('first-assessment', [a], [3]); odds('duplicate-assessment', [a, b], [3, 3])
const mixed = odds('mixed-assessment', [a, b, c], [3, 3, 0.5])
add('assessment', 'qualitative', { hypothesis: inquiryRef(h), evidence: [ev(a), ev(c)], model: { kind: 'qualitative', judgment: 'Competing explanations remain open.' }, rationale: 'No numerical confidence is needed for this interpretation.' })
add('legacy-assessment', 'old-score', { hypothesis: inquiryRef(h), value: 0.8, sourceDigest: digest('invented heuristic'), method: 'Historical weighted heuristic', limitations: 'Not a calibrated probability and never used as an automatic prior.' })
const decide = (id, assessment) => add('decision', id, { assessment: inquiryRef(assessment), disposition: 'accepted', conclusion: 'Use this invented case to explain conditional reasoning; it establishes no real-world effect.', reason: 'Synthetic acceptance fixture only.', reviewBasis: 'Simulated owner review for software testing, not actual recipient acceptance.', nextQuestions: ['Collect appropriate real evidence before any substantive decision.'] })
decide('decision-before', mixed)
add('feedback', 'research-feedback', { request: inquiryRef(request), outcome: 'unknown', cause: 'unknown', evidenceDigest: digest('synthetic-exercise'), rationale: 'No host research quality evaluation was executed.' })
add('withdrawal', 'withdraw-study', { target: inquiryRef(positive), reason: 'Synthetic correction scenario: the underlying positive contribution is withdrawn.' })
const revised = odds('revised-assessment', [c], [0.5])
decide('decision-after', revised)
inspectInquiry(records)
const target = new URL('../fixtures/inquiry/workshop.json', import.meta.url)
fs.mkdirSync(new URL('../fixtures/inquiry/', import.meta.url), { recursive: true })
fs.writeFileSync(target, `${JSON.stringify(records, null, 2)}\n`)
console.log(`Wrote ${records.length} explicitly synthetic inquiry records.`)
