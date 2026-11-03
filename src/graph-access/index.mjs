// Graph adapter over host-owned access decisions. No authentication store.
import { createHash } from 'node:crypto'
import { canonicalize } from '../attestation/jcs.mjs'
import { deepFreeze } from '../composition/wire.mjs'

const hash = value => createHash('sha256').update(canonicalize(value)).digest('hex')
const sourceDigest = value => `sha256:${hash(value)}`
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
const digest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
const revision = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
const string = (value, max = 512) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/u.test(value)
const equal = (a, b) => canonicalize(a) === canonicalize(b)
const key = ref => canonicalize([ref.repoId, ref.localId])
const ref = value => value && string(value.repoId) && string(value.localId)
const path = value => string(value, 2048) && !value.includes('\\') && !value.startsWith('/') && !/^[A-Za-z]:/.test(value) && !value.split('/').some(p => ['', '.', '..'].includes(p))
const list = (value, max = 10000) => Array.isArray(value) && value.length <= max
const need = value => { if (!value) throw new GraphAccessRefusal() }
const immutable = value => deepFreeze(structuredClone(value))
const validScope = s => s && typeof s === 'object' && !Array.isArray(s) &&
  Object.keys(s).sort().join(',') === 'base,exclude,include' && (s.base === '' || s.base === '.' || path(s.base)) &&
  [s.include, s.exclude].every(v => v === null || string(v, 2048))

export class GraphAccessRefusal extends Error {
  constructor() { super('Graph access unavailable'); this.name = 'GraphAccessRefusal' }
}

function bounded(value) {
  // The adapter accepts JSON data from a trusted loader, never browser bundles.
  // Existing canonicalization refuses undefined, classes and nonfinite values.
  const bytes = canonicalize(value)
  need(Buffer.byteLength(bytes) <= 8 * 1024 * 1024)
  return immutable(value)
}

/** Pin the complete normalized candidate using the existing JCS serializer. */
export function digestAccessCandidate(value) { return sourceDigest(bounded(value)) }

function validateDecision(input, operation, now) {
  const d = bounded(input)
  need(d.operation === operation && ['read', 'export'].includes(operation))
  for (const k of ['principalRef', 'proofRef', 'grantRevision', 'policyRevision']) need(string(d[k]))
  need(Number.isSafeInteger(d.expiresAt) && d.expiresAt > now)
  need(list(d.repositories, 64))
  const seen = new Set()
  for (const r of d.repositories) {
    need(string(r.repoId) && !seen.has(r.repoId) && string(r.ownerRef))
    need(revision(r.head) && revision(r.tree) && digest(r.snapshotDigest) && digest(r.contributionDigest))
    need(validScope(r.scope))
    seen.add(r.repoId)
  }
  return d
}

function snapshotFor(c, approved) {
  const s = c.snapshot
  need(c.repository.repoId === approved.repoId && c.repository.ownerRef === approved.ownerRef)
  need(s.repoId === approved.repoId && s.head === approved.head && s.tree === approved.tree && s.digest === approved.snapshotDigest)
  need(validScope(s.scope) && equal(s.scope, approved.scope) && typeof s.dirty === 'boolean' && list(s.files))
  const seen = new Set()
  for (const f of s.files) {
    need(path(f.path) && digest(f.rawDigest) && Number.isSafeInteger(f.byteLength) && f.byteLength >= 0 && !seen.has(f.path))
    seen.add(f.path)
  }
  return { repoId: approved.repoId, head: s.head, tree: s.tree, dirty: s.dirty, scope: s.scope,
    files: s.files.map(f => ({ path: f.path, rawDigest: f.rawDigest, byteLength: f.byteLength })).sort((a, b) => compare(a.path, b.path)), digest: s.digest }
}

function validLocator(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (!Object.keys(value).every(k => ['pointer', 'range', 'targetRange', 'rangeDigest'].includes(k))) return false
  if (value.rangeDigest !== undefined && (!digest(value.rangeDigest) || !value.range || !Number.isSafeInteger(value.range.byteStart) || !Number.isSafeInteger(value.range.byteEnd))) return false
  if (value.pointer !== undefined && (typeof value.pointer !== 'string' || value.pointer.length > 1024 || (value.pointer !== '' && !value.pointer.startsWith('/')))) return false
  for (const k of ['range', 'targetRange']) {
    const r = value[k]
    if (r === undefined) continue
    if (!r || !Object.keys(r).every(k => ['start', 'end', 'byteStart', 'byteEnd'].includes(k))) return false
    if (![r.start, r.end].every(n => Number.isSafeInteger(n) && n >= 0) || r.end < r.start) return false
    if ((r.byteStart === undefined) !== (r.byteEnd === undefined)) return false
    if (r.byteStart !== undefined && (![r.byteStart, r.byteEnd].every(n => Number.isSafeInteger(n) && n >= 0) || r.byteEnd < r.byteStart)) return false
  }
  return Object.keys(value).length > 0
}

function source(value, snapshots) {
  if (!value || !path(value.path) || !string(value.repoId) || !digest(value.revision) || !digest(value.digest)) return null
  const s = snapshots.get(value.repoId)
  const file = s?.files.find(f => f.path === value.path && f.rawDigest === value.digest)
  if (!s || value.revision !== s.digest || !file) return null
  if (value.locator !== undefined && !validLocator(value.locator)) return null
  for (const range of [value.locator?.range, value.locator?.targetRange]) {
    if (range && (range.end > file.byteLength || (range.byteEnd !== undefined && range.byteEnd > file.byteLength))) return null
  }
  return { repoId: value.repoId, path: value.path, revision: value.revision, digest: value.digest,
    ...(value.locator === undefined ? {} : { locator: value.locator }) }
}

function projectedNode(n, repoId, snapshots) {
  if (!ref(n.ref) || n.ref.repoId !== repoId || n.displayEligible === false) return null
  const pin = source(n.sourceRef, snapshots)
  if (!pin || pin.repoId !== repoId) return null
  for (const k of ['sourceKind', 'title', 'classification', 'lifecycle']) if (!string(n[k], k === 'title' ? 1024 : 128)) return null
  if (typeof n.summary !== 'string' || n.summary.length > 8192 || !list(n.tags, 64) || !n.tags.every(t => string(t, 256))) return null
  return { ref: { repoId, localId: n.ref.localId }, sourceKind: n.sourceKind, title: n.title, summary: n.summary,
    classification: n.classification, lifecycle: n.lifecycle, tags: [...new Set(n.tags)].sort(), sourceRef: pin, displayEligible: true }
}

/**
 * Trusted host ports establish principal, grants, source ownership and freshness.
 * A local host may do this only over its operator's deliberately permitted clones.
 * Audience, readBoundary, Git authors and browser claims never supply these ports.
 * The contribution is a normalized projection pinned by the decision's digest;
 * verifyContribution must check the owning producer's exact bytes and scope,
 * including any locator.rangeDigest over its exact raw byte slice.
 */
export function createGraphAccess(ports, { now = Date.now } = {}) {
  for (const name of ['resolveAccess', 'loadContribution', 'verifyContribution', 'evaluateEdge', 'revalidate']) need(typeof ports?.[name] === 'function')
  need(typeof now === 'function')
  const handles = new WeakMap()
  const time = () => { const n = now(); need(Number.isSafeInteger(n)); return n }
  const live = (state, signal) => {
    try { need(!signal?.aborted && !state.invalid && state.decision.expiresAt > time()) }
    catch { state.invalid = true; state.graph = null; throw new GraphAccessRefusal() }
  }
  const fresh = async (state, signal) => {
    try {
      live(state, signal)
      need(await ports.revalidate(state.decision, signal) === true)
      live(state, signal)
    } catch { state.invalid = true; state.graph = null; throw new GraphAccessRefusal() }
  }
  const stateFor = binding => { const s = handles.get(binding); need(s); return s }

  return Object.freeze({
    async loadAuthorizedGraph(context, { operation = 'read', signal } = {}) {
      let state
      try {
        need(['read', 'export'].includes(operation) && !signal?.aborted)
        const decision = validateDecision(await ports.resolveAccess(context, { operation, signal }), operation, time())
        state = { decision, invalid: false }
        await fresh(state, signal); live(state, signal)
        const contributions = [], snapshots = new Map(), diagnostics = []
        // Only the approved set is enumerated. A denied repo cannot affect loader
        // calls, raw exceptions, counts, diagnostics, cache keys or search input.
        for (const approved of [...decision.repositories].sort((a, b) => compare(a.repoId, b.repoId))) {
          await fresh(state, signal); live(state, signal)
          try {
            const c = bounded(await ports.loadContribution(approved, { operation, signal }))
            need(sourceDigest(c) === approved.contributionDigest)
            need(await ports.verifyContribution(c, approved, { operation, signal }) === true)
            const snapshot = snapshotFor(c, approved)
            need(list(c.nodes) && list(c.edges) && list(c.evidence))
            // Intrinsic records must belong to this exact verified contribution.
            // A stale/invalid authorized record makes its source incomplete;
            // do not silently call the remaining subset a complete snapshot.
            const localSnapshots = new Map([[approved.repoId, snapshot]])
            for (const n of c.nodes) need(n?.displayEligible === false || projectedNode(n, approved.repoId, localSnapshots))
            for (const e of c.evidence) {
              const pin = source(e?.sourceRef, localSnapshots)
              need(string(e?.evidenceId) && pin?.repoId === approved.repoId)
            }
            snapshots.set(approved.repoId, snapshot)
            contributions.push(c)
          } catch {
            diagnostics.push({ code: 'authorized-source-unavailable', severity: 'warning', repoId: approved.repoId,
              nodeRefs: [], evidenceRefs: [], action: 'Refresh the authorized source.' })
          }
          await fresh(state, signal); live(state, signal)
        }
        const nodes = [], evidence = [], edges = [], nodeKeys = new Set(), evidenceIds = new Set(), edgeIds = new Set()
        for (const c of contributions) {
          for (const raw of c.nodes) {
            const n = projectedNode(raw, c.repository.repoId, snapshots)
            if (!n) continue
            need(!nodeKeys.has(key(n.ref))); nodeKeys.add(key(n.ref)); nodes.push(n)
          }
          for (const raw of c.evidence) {
            const pin = source(raw.sourceRef, snapshots)
            if (!string(raw.evidenceId) || !pin || pin.repoId !== c.repository.repoId) continue
            need(!evidenceIds.has(raw.evidenceId)); evidenceIds.add(raw.evidenceId)
            evidence.push({ evidenceId: raw.evidenceId, sourceRef: pin, verification: 'verified-source' })
          }
        }
        for (const c of contributions) for (const raw of c.edges) {
          // Cross-repository topology disappears before the policy port runs.
          if (!string(raw.edgeId) || !ref(raw.source) || !ref(raw.target) || !nodeKeys.has(key(raw.source)) || !nodeKeys.has(key(raw.target))) continue
          const home = source(raw.sourceRef, snapshots)
          if (!home || home.repoId !== c.repository.repoId || !list(raw.supportRefs, 64) || !raw.supportRefs.every(id => evidenceIds.has(id))) continue
          if (new Set(raw.supportRefs).size !== raw.supportRefs.length) continue
          await fresh(state, signal); live(state, signal)
          // The edge owner verifies its immutable record, signatures and policy.
          // A contribution's eligible/accepted flags have no authority.
          const result = bounded(await ports.evaluateEdge(raw, decision, { signal }))
          if (result.eligible !== true || result.edgeId !== raw.edgeId || !equal(result.source, raw.source) || !equal(result.target, raw.target) || !equal(result.supportRefs, raw.supportRefs)) continue
          if (!string(result.predicate, 128) || !['hyperlink', 'source-declaration', 'reviewed-assertion'].includes(result.family)) continue
          if (result.acceptanceState !== 'active' || result.supportRefs.length === 0 || !result.supportRefs.includes(result.sourceRef)) continue
          if (!['navigation', 'source-declaration', 'reviewed-assertion'].includes(result.assurance) || !digest(result.recordDigest) || !digest(result.policyDigest)) continue
          if (!list(result.qualifications, 64) || !result.qualifications.every(q => string(q, 2048))) continue
          if (!list(result.reviewRefs, 64) || !result.reviewRefs.every(r => string(r, 2048))) continue
          need(!edgeIds.has(result.edgeId)); edgeIds.add(result.edgeId)
          edges.push({ edgeId: result.edgeId, source: { repoId: raw.source.repoId, localId: raw.source.localId },
            target: { repoId: raw.target.repoId, localId: raw.target.localId }, predicate: result.predicate, family: result.family,
            acceptanceState: 'active', supportRefs: [...result.supportRefs], sourceRef: result.sourceRef, eligible: true,
            assurance: result.assurance, qualifications: [...result.qualifications], reviewRefs: [...result.reviewRefs],
            recordDigest: result.recordDigest, policyDigest: result.policyDigest })
        }
        nodes.sort((a, b) => compare(key(a.ref), key(b.ref)))
        edges.sort((a, b) => compare(a.edgeId, b.edgeId))
        evidence.sort((a, b) => compare(a.evidenceId, b.evidenceId))
        const sourceSnapshot = { repositories: [...snapshots.values()].map(s => {
          const c = contributions.find(c => c.repository.repoId === s.repoId)
          const input = name => {
            const pin = source(c.inputs?.[name], snapshots)
            return pin?.repoId === s.repoId ? pin : null
          }
          return { ...s, inputs: { config: input('config'), plan: input('plan') } }
        }) }
        // Source manifests may themselves mention denied targets. Only exact
        // approved files/scope are admitted by the host; arbitrary diagnostics,
        // relation arrays, search terms and source-wide summaries are not copied.
        const graph = immutable({ producerVersion: 'atelier-graph-access/proposal-v1', sourceSnapshot,
          accessContext: { proofRef: decision.proofRef, authorizedRepoIds: decision.repositories.map(r => r.repoId).sort(),
            grantRevision: decision.grantRevision, policyRevision: decision.policyRevision, expiresAt: decision.expiresAt, filter: 'repository-grants' },
          nodes, edges, evidence, questions: [], diagnostics,
          completeness: diagnostics.length === 0 ? 'complete' : 'incomplete',
          counts: { nodes: nodes.length, edges: edges.length, evidence: evidence.length },
          capabilities: { read: true, export: operation === 'export' } })
        const cacheKey = hash({ principalRef: decision.principalRef, proofRef: decision.proofRef, operation,
          grantRevision: decision.grantRevision, policyRevision: decision.policyRevision, expiresAt: decision.expiresAt,
          repositories: [...decision.repositories].sort((a, b) => compare(a.repoId, b.repoId)), graphDigest: hash(graph) })
        const binding = Object.freeze({ cacheKey, expiresAt: decision.expiresAt })
        state.graph = graph; state.operation = operation; handles.set(binding, state)
        await fresh(state, signal); live(state, signal)
        return Object.freeze({ graph, binding })
      } catch { if (state) { state.invalid = true; state.graph = null }; throw new GraphAccessRefusal() }
    },
    async revalidate(binding, { signal } = {}) {
      try { const state = stateFor(binding); await fresh(state, signal); live(state, signal); return true } catch { return false }
    },
    invalidate(binding) {
      try { const state = stateFor(binding); state.invalid = true; state.graph = null; return true } catch { return false }
    },
    async guardArtifact(binding, graph, { operation = 'read', signal } = {}) {
      try {
        const state = stateFor(binding)
        // Object identity prevents a copied/mixed artifact or caller label from
        // becoming a reader-specific graph. Export needs a fresh export decision.
        need(graph === state.graph && operation === state.operation)
        await fresh(state, signal); live(state, signal)
        return graph
      } catch { throw new GraphAccessRefusal() }
    },
  })
}
