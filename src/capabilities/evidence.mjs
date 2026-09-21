import fs from 'node:fs'
import { inspectCapabilityAdoption, inspectCapabilityRecovery, readCapabilityState, withOperationLock } from './adoption.mjs'
import { assertDocument, unique } from './package.mjs'
import { currentTree, digest, jsonAt, jsonText, objectDigest, stat, within, workspaceRoot, writeNew } from './files.mjs'

const EVENTS = '.atelier-local/capabilities/events'
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/

export function readCapabilityEvents({ workspaceRoot: input }) {
  const root = workspaceRoot(input ?? process.cwd())
  const directory = within(root, EVENTS, { directory: true })
  if (!stat(directory)) return []
  const names = fs.readdirSync(directory).sort()
  if (names.length > 4096) throw new Error('capability event ceiling reached; archive reviewed events before adding more')
  return names.map(name => {
    if (!/^[a-z][a-z0-9.-]{0,63}\.json$/.test(name)) throw new Error('unrecognized event file')
    const event = assertDocument(jsonAt(root, `${EVENTS}/${name}`), 'event')
    if (`${event.id}.json` !== name) throw new Error('event identity differs from its storage path')
    return event
  })
}

export function recordCapabilityEvent({ workspaceRoot: input, event }) {
  const root = workspaceRoot(input ?? process.cwd(), { write: true })
  assertDocument(event, 'event')
  // Metadata is supplied by the caller, never harvested from a host session.
  // Its schema cannot carry prompts, source excerpts, URLs or free-form prose.
  if (event.ext && Object.keys(event.ext).length) throw new Error('event extensions are not admitted for local observation storage')
  return withOperationLock(root, () => {
    if (inspectCapabilityRecovery({ workspaceRoot: root }).pending) throw new Error('cannot record an event during unfinished adoption')
    const state = readCapabilityState(root)
    const item = state?.packages.find(entry => entry.id === event.package)
    const binding = item?.bindings.find(entry => entry.target === event.binding)
    if (!binding || item.release.digest !== event.releaseDigest || state.generation !== event.generation || binding.host !== event.host || binding.digest !== event.bindingDigest) throw new Error('event does not identify the current installed binding')
    if (currentTree(root, binding.target) !== binding.digest) throw new Error('cannot record an event for a drifted binding')
    const events = readCapabilityEvents({ workspaceRoot: root })
    if (events.length >= 4096) throw new Error('capability event ceiling reached')
    if (events.some(item => item.id === event.id)) throw new Error('event identity already recorded')
    writeNew(root, `${EVENTS}/${event.id}.json`, jsonText(event))
    return { recorded: true, event, assurance: 'caller-reported-evidence-reference' }
  })
}

export function capabilityEvidenceStatus({ workspaceRoot: input, session = null }) {
  if (session !== null && !IDENTIFIER_PATTERN.test(session)) throw new Error('invalid host session identifier')
  const status = inspectCapabilityAdoption({ workspaceRoot: input })
  const events = readCapabilityEvents({ workspaceRoot: input })
  for (const item of status.packages) {
    for (const binding of item.bindings) {
      const related = events.filter(event => event.package === item.id && event.binding === binding.target)
      const current = related.filter(event => event.generation === status.generation && event.releaseDigest === item.digest && event.bindingDigest === binding.observedDigest && session !== null && event.session === session)
      for (const [kind, field] of [['host-observed', 'hostObserved'], ['exercise', 'exercised']]) {
        const recent = current.filter(event => event.kind === kind).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)).at(-1)
        binding[field] = recent ? `reported-${recent.outcome}` : related.some(event => event.kind === kind) ? 'historical-or-other-session' : 'unknown'
      }
    }
  }
  return { ...status, evidenceAssurance: 'caller-reported; no host probe or model execution', session, events }
}

export function capabilityImprovementCandidates({ workspaceRoot: input }) {
  const status = capabilityEvidenceStatus({ workspaceRoot: input })
  const grouped = new Map()
  for (const event of status.events) {
    const item = status.packages.find(item => item.id === event.package && item.digest === event.releaseDigest)
    if (!item || !item.bindings.some(binding => binding.target === event.binding && binding.digest === event.bindingDigest && binding.installed === 'current') || event.generation !== status.generation) continue
    const key = `${event.package}|${event.releaseDigest}|${event.binding}|${event.cause}`
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key).push(event)
  }
  const candidates = []
  for (const events of grouped.values()) {
    const failed = events.filter(event => event.outcome === 'failed' && ['exercise', 'feedback', 'evaluation'].includes(event.kind))
    // Duplicate reports for one session/evidence do not count as repetition.
    const independent = new Map(failed.map(event => [`${event.session}|${event.evidenceDigest}`, event]))
    if (independent.size < 2) continue
    const first = failed[0]
    candidates.push({ package: first.package, releaseDigest: first.releaseDigest, binding: first.binding, cause: first.cause,
      proposal: first.cause === 'skill' ? 'review-skill' : first.cause === 'unknown' ? 'investigate-cause' : `review-${first.cause}`,
      evidence: [...independent.values()].map(event => event.id), automaticEdit: false, automaticRetirement: false })
  }
  return { schema: 'mnstry.atelier-capability-candidates@v1', candidates, inference: 'reported causes and repetition are review signals, not causal proof' }
}

// Return reviewable graph source documents, never write to canonical content.
// The caller chooses a repository, audience and destination through its normal
// authoring/graph workflow. Generated evidence remains an unreviewed claim.
export function capabilityGraphSources({ workspaceRoot: input, namespace, audience = 'private' }) {
  if (!IDENTIFIER_PATTERN.test(namespace) || !['private', 'team', 'operator', 'staff', 'public', 'sensitive'].includes(audience)) throw new Error('invalid graph namespace or audience')
  const root = workspaceRoot(input ?? process.cwd())
  const state = readCapabilityState(root), events = readCapabilityEvents({ workspaceRoot: root })
  if (!state) return { schema: 'mnstry.atelier-capability-graph-sources@v1', files: [], canonicalMutation: false }
  const documents = new Map()
  const nodeId = (kind, key) => `${namespace}:capability-${kind}-${objectDigest(key).slice(7)}`
  function add(kind, key, title, body, relations = {}) {
    const id = nodeId(kind, key)
    const metadata = [
      '---', `title: ${JSON.stringify(title)}`, 'kg:', `  id: ${JSON.stringify(id)}`, '  type: "document"',
      '  lifecycle: "capability-stewardship"', '  status: "draft"', `  audience: ${JSON.stringify(audience)}`,
    ]
    if (Object.keys(relations).length) {
      metadata.push('  relations:')
      for (const [relation, targets] of Object.entries(relations)) {
        metadata.push(`    ${relation}:`)
        for (const target of targets) metadata.push(`      - ${JSON.stringify(target)}`)
      }
    }
    metadata.push('---', '', `# ${title}`, '', body, '', 'This record describes evidence or adoption. It grants no execution or publication authority.', '')
    documents.set(id, { path: `${id.split(':')[1]}.md`, content: metadata.join('\n') })
    return id
  }
  const enrollmentId = add('adoption', [state.enrollment, state.generation], `Capability adoption ${state.enrollment}`, `Generation: ${state.generation}\n\nDesired policy digest: ${state.policyDigest}`)
  for (const version of state.versions) {
    const packageId = add('package', version.id, `Capability package ${version.id}`, 'Publisher identity is declared. A digest establishes integrity, not publisher authentication.')
    add('release', [version.id, version.digest], `Release ${version.id} ${version.version}`, `Previously observed release digest: ${version.digest}`, { belongs_to: [packageId] })
  }
  for (const item of state.packages) {
    const packageId = add('package', item.id, `Capability package ${item.id}`, 'Publisher identity is declared. A digest establishes integrity, not publisher authentication.')
    const releaseId = add('release', [item.id, item.release.digest], `Release ${item.id} ${item.release.package.version}`, `Release digest: ${item.release.digest}\n\nMode: ${item.mode}`, { belongs_to: [packageId] })
    for (const capability of item.release.package.capabilities) add('outcome', [item.id, capability.id, item.release.digest], `Capability ${capability.id}`, `Provided by release ${item.release.digest}.`, { belongs_to: [releaseId] })
    for (const evaluation of item.release.package.evaluations) add('evaluation', [item.id, item.release.digest, evaluation.id], `Publisher evaluation ${evaluation.id}`, `Publisher-reported outcome: ${evaluation.outcome}\n\nEvidence is bound by the release payload, not independently verified by this graph.`, { evidences: [releaseId] })
    for (const binding of item.bindings) {
      add('binding', [state.enrollment, state.generation, binding.target], `Host binding ${binding.alias}`, `Profile: ${binding.host}\n\nInstalled digest: ${binding.digest}\n\nHost loading and successful exercise require separate evidence.`, { implements: [releaseId], belongs_to: [enrollmentId] })
    }
  }
  for (const event of events) {
    const releaseId = nodeId('release', [event.package, event.releaseDigest])
    if (!documents.has(releaseId)) throw new Error('event release is absent from adoption history')
    const adoptionId = nodeId('adoption', [state.enrollment, event.generation])
    if (!documents.has(adoptionId)) add('adoption', [state.enrollment, event.generation], `Historical adoption ${state.enrollment}`, `Historical generation: ${event.generation}`)
    const bindingId = nodeId('binding', [state.enrollment, event.generation, event.binding])
    if (!documents.has(bindingId)) add('binding', [state.enrollment, event.generation, event.binding], `Historical host binding ${event.host}`, `Previously reported binding digest: ${event.bindingDigest}`, { implements: [releaseId], belongs_to: [adoptionId] })
    add('event', [state.enrollment, event.id], `Reported ${event.kind} ${event.id}`, `Outcome: ${event.outcome}\n\nCause reported: ${event.cause}\n\nEvidence digest: ${event.evidenceDigest}\n\nReview status: unreviewed caller report.`, { evidences: [bindingId] })
  }
  for (const proposal of capabilityImprovementCandidates({ workspaceRoot: root }).candidates) {
    add('proposal', [state.enrollment, proposal.package, proposal.releaseDigest, proposal.binding, proposal.cause], `Proposed ${proposal.proposal}`, 'A review proposal from reported evidence; no edit or retirement is authorized.', { related: proposal.evidence.map(id => nodeId('event', [state.enrollment, id])) })
  }
  unique([...documents.values()].map(item => item.path), 'graph source path')
  return { schema: 'mnstry.atelier-capability-graph-sources@v1', files: [...documents.values()], canonicalMutation: false }
}
