import fs from 'node:fs'
import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { boundedLearningValue, learningDigest as digest } from '../learning/contracts.mjs'
import { buildCoordinationProposal } from '../build/index.mjs'
const schema = JSON.parse(fs.readFileSync(new URL('../../contracts/atelier-coordination.v1.schema.json', import.meta.url)))
const ajv = new Ajv({ strict: true, allErrors: true }); addFormats(ajv)
const validate = ajv.compile(schema)
const key = r => `${r.repository}/${r.id}`
export function validateCoordination(record) {
  try { boundedLearningValue(record) } catch (error) { return [error.message] }
  if (!validate(record)) return validate.errors.map(e => `${e.instancePath || '/'}: ${e.message}`)
  const errors = []
  if (Date.parse(record.expiresAt) <= Date.parse(record.observedAt)) errors.push('expiry must follow observation')
  if (new Set(record.scope).size !== record.scope.length || !record.scope.length) errors.push('nonempty distinct scope required')
  if (record.kind === 'dependency' && record.body.receiving.status !== 'missing' && record.body.receiving.receipt === null) errors.push('reported receipt or acceptance needs native receipt reference')
  if (record.kind === 'outcome') {
    if (new Set(record.body.gates.map(g => g.id)).size !== record.body.gates.length) errors.push('duplicate gate identity')
    if (record.body.gates.some(g => ['passed', 'waived'].includes(g.status) && g.evidence === null)) errors.push('reported passed/waived gate needs evidence')
  }
  if (record.kind === 'disposition' && ['sent', 'read', 'applied', 'verified'].includes(record.body.stage) && record.body.evidence === null) errors.push('reported disposition needs native evidence')
  return errors
}
export function coordinationReference(record) {
  const errors = validateCoordination(record)
  if (errors.length) throw new Error(errors.join('; '))
  return { repository: record.repository, id: record.id, digest: digest(record) }
}
export function coordinationView({ records, at, maxAgeMs = 86400000 }) {
  if (!Array.isArray(records) || records.length > 256 || !Number.isFinite(Date.parse(at)) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 30 * 86400000) throw new Error('bounded coordination snapshot and time required')
  const map = new Map(), freshness = new Map()
  for (const record of records) {
    coordinationReference(record)
    if (map.has(key(record))) throw new Error('ambiguous repository record identity; select an exact snapshot')
    map.set(key(record), record)
    const age = Date.parse(at) - Date.parse(record.observedAt)
    freshness.set(key(record), age < 0 ? 'unknown' : Date.parse(at) >= Date.parse(record.expiresAt) || age > maxAgeMs ? 'stale' : 'current-reported')
  }
  const resolves = (pin, kind) => {
    const record = map.get(key(pin))
    return record?.kind === kind && digest(record) === pin.digest && freshness.get(key(pin)) === 'current-reported' ? record : null
  }
  const dependencies = [], adjacency = new Map()
  for (const record of records.filter(r => r.kind === 'dependency')) {
    const { producer: pin, consumer, artifactDigest, receiving } = record.body
    const producer = resolves(pin, 'outcome'), target = map.get(key(consumer)), reasons = []
    if (freshness.get(key(record)) !== 'current-reported') reasons.push('dependency-report-not-current')
    if (!producer) reasons.push('producer-missing-stale-or-changed')
    if (!target || target.kind !== 'outcome' || freshness.get(key(consumer)) !== 'current-reported') reasons.push('consumer-missing-or-stale')
    if (producer && (producer.body.lifecycle !== 'active' || producer.body.candidate?.artifactDigest !== artifactDigest)) reasons.push('producer-artifact-unavailable')
    if (record.repository !== consumer.repository) reasons.push('receiving-report-outside-consumer-repository')
    if (target && (!record.scope.every(s => target.scope.includes(s)) || (producer && !record.scope.every(s => producer.scope.includes(s))))) reasons.push('dependency-scope-differs')
    if (receiving.status !== 'accepted') reasons.push(`receiving-${receiving.status}`)
    if (!adjacency.has(key(consumer))) adjacency.set(key(consumer), [])
    adjacency.get(key(consumer)).push(key(pin))
    dependencies.push({ reference: coordinationReference(record), producer: pin, consumer, receiving, reasons, nativeReceiptVerified: false })
  }
  // Strongly connected components (Tarjan): every dependency inside one lies on
  // a cycle, whatever order the records arrive in.
  const cycles = [], component = new Map(), index = new Map(), low = new Map(), stack = [], onStack = new Set()
  let counter = 0
  function connect(node) {
    index.set(node, counter); low.set(node, counter++); stack.push(node); onStack.add(node)
    for (const next of adjacency.get(node) ?? []) {
      if (!index.has(next)) { connect(next); low.set(node, Math.min(low.get(node), low.get(next))) }
      else if (onStack.has(next)) low.set(node, Math.min(low.get(node), index.get(next)))
    }
    if (low.get(node) !== index.get(node)) return
    const members = []
    let member
    do { member = stack.pop(); onStack.delete(member); members.push(member) } while (member !== node)
    if (members.length > 1 || (adjacency.get(node) ?? []).includes(node)) {
      members.sort()
      for (const m of members) component.set(m, cycles.length)
      cycles.push(members)
    }
  }
  for (const node of [...adjacency.keys()].sort()) if (!index.has(node)) connect(node)
  for (const dependency of dependencies) {
    const group = component.get(key(dependency.consumer))
    if (group !== undefined && group === component.get(key(dependency.producer))) dependency.reasons.push('dependency-cycle')
  }
  const directives = records.filter(r => r.kind === 'directive').map(directive => {
    const pin = coordinationReference(directive)
    const replacements = records.filter(r => r.kind === 'directive' && r.body.supersedes && digest(r.body.supersedes) === digest(pin) &&
      r.repository === directive.repository && key(r.body.target) === key(directive.body.target) && digest([...r.scope].sort()) === digest([...directive.scope].sort()))
    // Supersession is permanent: a replacement going stale withdraws its own
    // report, never revives the directive it replaced.
    const superseded = replacements.length > 0
    const reports = records.filter(r => r.kind === 'disposition' && digest(r.body.directive) === digest(pin))
    return { reference: pin, target: directive.body.target, freshness: freshness.get(key(directive)), supersedes: directive.body.supersedes,
      supersededBy: replacements.map(coordinationReference), activeReported: !superseded && freshness.get(key(directive)) === 'current-reported',
      reports: reports.map(r => ({ reference: coordinationReference(r), stage: r.body.stage, evidence: r.body.evidence,
        applicable: !superseded && freshness.get(key(r)) === 'current-reported' && freshness.get(key(directive)) === 'current-reported' && key(r.body.recipient) === key(directive.body.target) && r.repository === directive.body.target.repository && r.scope.every(s => directive.scope.includes(s)),
        nativeReceiptVerified: false })), executionAuthorized: false }
  })
  const outcomes = records.filter(r => r.kind === 'outcome').map(record => ({ reference: coordinationReference(record), owner: record.body.owner, purpose: record.body.purpose,
    priority: record.body.priority, freshness: freshness.get(key(record)), lifecycle: record.body.lifecycle, candidate: record.body.candidate,
    gates: record.body.gates.map(g => ({ ...g, candidateCurrent: record.body.candidate !== null && g.candidateDigest === digest(record.body.candidate), nativeEvidenceVerified: false })),
    blockers: dependencies.filter(d => key(d.consumer) === key(record)).flatMap(d => d.reasons) }))
  const recovery = records.filter(r => r.kind === 'recovery').map(record => ({ reference: coordinationReference(record), ...record.body,
    freshness: freshness.get(key(record)), priorPresent: !!resolves(record.body.prior, 'outcome'), successorPresent: map.get(key(record.body.successor ?? {}))?.kind === 'outcome', owningRepository: record.repository === record.body.prior.repository, executionAuthorized: false }))
  return { schema: 'atelier-coordination-view@v1', at, maxAgeMs, coverage: records.map(coordinationReference), outcomes, dependencies, directives, recovery, cycles,
    freshness: 'relative-to-supplied-observations', completionVerified: false, authorityTransferred: false, executionAuthorized: false }
}
// Retain the native Build history and its own dependency/gate qualification.
// Additional portfolio records cannot change this result or waive its blockers.
export function coordinatedBuild({ records, buildRecords, dependencySnapshots = [], at, maxAgeMs }) {
  return { coordination: coordinationView({ records, at, maxAgeMs }), build: buildCoordinationProposal(buildRecords, { dependencySnapshots }), authorityTransferred: false }
}
