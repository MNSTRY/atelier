import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createProposalStore } from '../../../collaboration/proposals.mjs'
import { AtelierDiagnosticError } from '../../../project/config.mjs'
import { compareText, isoTime } from '../../../runtime/obsidian/documents.mjs'
import { ObsidianMaintenanceRefusal } from '../../../runtime/obsidian/errors.mjs'
import { readMachineSettings } from '../../../runtime/obsidian/machine-settings.mjs'
import { DEFAULT_ELIGIBILITY, createProductionSeams } from '../../../runtime/obsidian/pipeline.mjs'
import { acquirePrivateGenerationLock, createAbandonmentProof } from '../../../runtime/obsidian/private-lock.mjs'
import { OBSIDIAN_EXT_KEY, ObsidianContractRefusal, assertObsidianContract } from '../contracts.mjs'
import { SOURCE_APPLY_PRIMITIVES } from '../edits/apply.mjs'
import { EditArbitrationRefusal } from '../edits/arbitrate.mjs'
import { isIdentifier } from '../edits/object-identity.mjs'
import { openObjectStore } from '../edits/object-store.mjs'
import { decideApply } from '../edits/policy.mjs'
import { applyEditLens } from '../edits/regions.mjs'
import { PublicationRefusal, readFileBytes, sha256Digest } from '../recovery/store.mjs'
import {
  PROPOSAL_BACKPRESSURE, PROPOSAL_LEDGER_LIMITS, classifyLedgerRead, classifyStoreRefusal, estimateEventLineBytes, isDue, isExhausted, nextAttemptAt, preflightAppend,
} from './backpressure.mjs'
import { OPEN_QUEUE_STATES, ProposalQueueRefusal, openProposalQueue } from './queue.mjs'
import { PROPOSAL_STORE_DIRECTORY, adapterOperationId, isAdapterOperationId, isRoutableSourcePath, proposalStoreId, resolveProposalRoute } from './router.mjs'

// The proposal adapter: a structural edit somebody made in a vault becomes ONE
// durable copy-only proposal in the store of the repository that owns the
// source, and nothing else happens to it.
//
// An edit the byte lens cannot turn into source bytes (a new or changed link
// to another note, an edited front matter) is recorded by the object store as
// an operation of kind `semantic-proposal`, state `proposed`. On a tick the
// adapter is handed the pending edits; for each such operation it has not
// settled, in this order and under the private lock of that repository:
//
//   1. records the operation in its queue (queue.mjs), before anything else;
//   2. reads the ledger of the store and refuses or waits when it has no room
//      or cannot be read (backpressure.mjs);
//   3. LOOKS in the persisted store for a proposal that already carries this
//      adapter operation identity, and creates one only when there is none;
//   4. records `submitted`, reads the proposal back, and records
//      `acknowledged` with a receipt that binds the edit to the proposal.
//
// The identifier the store gives a proposal is seeded with the time, so it
// names a proposal and decides nothing here: what makes two proposals the same
// request is the adapter operation identity inside the payload. A crash at any
// point leaves either no proposal and a queued record, or a proposal that step
// 3 finds on the next tick. Two ticks or two processes cannot both create,
// because step 3 and the creation happen under one lock, which is taken from a
// holder only with proof that its process is gone and never because time
// passed.
//
// What a proposal says. Identifiers, the repository-relative path of the
// source, codes, byte offsets, digests and references to the preserved bytes,
// and sentences made from those codes. It holds NO text of any note: the bytes
// a person typed may name or quote another document (a link carries the title
// of its target), and a reviewer of one repository must not learn the title of
// a document of another, or of one withheld from them, from a proposal. The
// preserved bytes stay in private state, named by digest.
//
// The adapter writes no source file and no vault, and no status of a proposal
// is an instruction to it: a proposal a reviewer accepts is a note for a
// person or an agent with a checkout, exactly as the store says.

export const PROPOSAL_ADAPTER_ID = 'atelier.obsidian-proposal-adapter/v1'
export const PROPOSAL_ADAPTER_ACTOR = 'atelier obsidian proposal adapter'
export const PROPOSAL_PAYLOAD_SCHEMA = 'atelier-obsidian-structural-proposal/v1'
export const PROPOSAL_PAYLOAD_KIND = 'obsidian-structural-edit'
export const PROPOSAL_LOCK_PURPOSE = 'proposal-adapter'
export const PROPOSAL_ADAPTER_CRASH_STEPS = Object.freeze(['queued', 'before-append', 'appended', 'submitted', 'acknowledged'])
export const MAX_CHANGE_OCCURRENCES = 64

const EXT = OBSIDIAN_EXT_KEY
const STRUCTURAL_CODES = Object.freeze(['unsupported-structural-edit', 'unsupported-frontmatter-edit'])
const CODE = /^[a-z][a-z0-9-]{0,63}$/
const CHANGE_SENTENCES = Object.freeze({
  'unsupported-structural-edit': 'A link to another note of the vault was added, changed or removed.',
  'unsupported-frontmatter-edit': 'The front matter of the note was edited.',
  unclassified: 'The edit changes the structure of the note in a way that was not classified further.',
})
const segment = (identifier) => identifier.replaceAll(':', '_')
const isTyped = (error) => error instanceof ObsidianMaintenanceRefusal || error instanceof AtelierDiagnosticError || error instanceof ObsidianContractRefusal || error instanceof PublicationRefusal
  || error instanceof EditArbitrationRefusal || error instanceof ProposalQueueRefusal
const hashOf = (parts) => createHash('sha256').update(parts.join('\u0000')).digest('hex')
const isOffset = (value) => Number.isInteger(value) && value >= 0

// What of a lens refusal a proposal repeats: the code, a reason code and byte offsets. Anything else it holds
// (a digest of the note, a name) stays behind.
export function describeChange(outcome) {
  if (outcome?.kind !== 'refusal' || !STRUCTURAL_CODES.includes(outcome.code)) return { code: 'unclassified', reason: typeof outcome?.code === 'string' && CODE.test(outcome.code) ? outcome.code : null }
  const detail = outcome.detail ?? {}
  const change = { code: outcome.code, reason: typeof detail.reason === 'string' && CODE.test(detail.reason) ? detail.reason : null }
  for (const name of ['firstDifference', 'publishedStart', 'publishedEnd']) if (isOffset(detail[name])) change[name] = detail[name]
  if (Array.isArray(detail.occurrences)) {
    const occurrences = detail.occurrences.filter((item) => isOffset(item?.noteStart) && isOffset(item?.noteEnd)).map(({ noteStart, noteEnd }) => ({ noteStart, noteEnd }))
    // Said, never silent: how many there were, and how many of them are listed.
    change.occurrenceCount = occurrences.length
    change.occurrences = occurrences.slice(0, MAX_CHANGE_OCCURRENCES)
  }
  return change
}

// The body handed to createProposal. `item` is the operation, `route` where it goes, `change` what describeChange said.
export function buildProposalContent({ item, route, change }) {
  const sentence = CHANGE_SENTENCES[change.code] ?? CHANGE_SENTENCES.unclassified
  const summary = [
    'Somebody edited the generated note of this document in an Obsidian view, and the edit cannot be written back as a replacement of the body.',
    sentence,
    `Code: ${change.code}${change.reason ? ` (${change.reason})` : ''}.${change.occurrenceCount === undefined ? '' : ` Places in the edited note: ${change.occurrenceCount}.`}`,
    'The edited bytes and the source they were judged against are kept in the private state of the workspace that observed the edit, under the digests below. Nothing was written to the source.',
  ]
  return {
    path: route.sourcePath,
    action: 'copy.agentPrompt',
    actor: PROPOSAL_ADAPTER_ACTOR,
    viewId: item.scopeId,
    intent: `Review a structural edit of ${route.sourcePath} made in an Obsidian view (${change.code}).`.slice(0, 500),
    reason: sentence,
    diff: '',
    proposal: {
      schema: PROPOSAL_PAYLOAD_SCHEMA,
      kind: PROPOSAL_PAYLOAD_KIND,
      adapter: { id: PROPOSAL_ADAPTER_ID, operationId: item.adapterOperationId },
      identity: { workspaceId: item.workspaceId, repoId: item.repoId, nodeId: item.nodeId },
      sourcePath: route.sourcePath,
      editId: item.editId,
      idempotencyKey: item.idempotencyKey,
      origin: { scopeId: item.scopeId, generationId: item.generationId },
      change,
      references: {
        observed: { digest: item.observed.digest, byteLength: item.observed.byteLength, recoveryRef: item.observed.recoveryRef },
        baseSourceDigest: item.baseSourceDigest,
        ...(item.publishedNoteDigest ? { publishedNoteDigest: item.publishedNoteDigest } : {}),
      },
      summary,
    },
  }
}

// The decisions the oracles of test/obsidian-proposals.test.mjs are sensitive
// to. Production always uses these; the tests substitute deliberately broken
// ones through createProposalAdapterForOracleTests to prove each oracle can fail.
export const PROPOSAL_ADAPTER_PRIMITIVES = Object.freeze({
  // The proposals of the persisted store that are this operation: the ones whose payload carries its identity.
  // Never the identifier of a proposal, which is seeded with the time it was made.
  existingFor: ({ proposals, item }) => proposals.filter((record) => record?.payload?.adapter?.id === PROPOSAL_ADAPTER_ID && record.payload.adapter.operationId === item.adapterOperationId),
  // The store is asked before anything is created, on the first attempt and on every one after it.
  lookBeforeCreate: true,
  // An operation that is acknowledged or refused is not looked at again, and one that waits is looked at when it is due.
  handOver: ({ head, nowMs, bounds }) => isDue(head, { nowMs, bounds }),
  isSettled: ({ head }) => head.state === 'acknowledged' || head.state === 'refused',
  content: buildProposalContent,
  // The check-then-create of one repository is serialized between ticks and between processes by a private lock.
  acquireLock: acquirePrivateGenerationLock,
  // What the adapter does to a ledger that has no room: nothing.
  relieve: () => {},
  // What the adapter does when it sees how a reviewer settled a proposal: nothing. It is shown, and that is all.
  onReviewStatus: () => {},
})

export function createProposalAdapterForOracleTests(primitives = PROPOSAL_ADAPTER_PRIMITIVES) {
  const rules = { ...PROPOSAL_ADAPTER_PRIMITIVES, ...primitives }

  // `clock` is injected. `crash(step, detail)` is the crash seam. `openStore` opens the existing proposal store of a
  // repository root; `objectStore` the arbitration store; `isVisible(identity, context)` and `isGitIgnored` replace the
  // two questions asked of the machine; `proveAbandoned` is the proof a held lock is passed over with.
  return function createProposalAdapter(options = {}) {
    const {
      env = process.env, crash = () => {}, bounds: boundsInput = {}, limits = PROPOSAL_LEDGER_LIMITS, eligibility = DEFAULT_ELIGIBILITY,
      openStore = createProposalStore, objectStore = openObjectStore, isGitIgnored = SOURCE_APPLY_PRIMITIVES.isGitIgnored, proveAbandoned = createAbandonmentProof(), queueCrash = () => {},
    } = options
    const bounds = { ...PROPOSAL_BACKPRESSURE, ...boundsInput }
    // The clock given when the adapter was made; else the one of the engine that calls it; else the time of day.
    let callerClock = null
    const clock = () => (options.clock ?? callerClock ?? (() => new Date()))()
    const seams = { ...createProductionSeams(), ...(options.seams ?? {}) }
    let cursor = 0
    const queues = new Map()
    // Edits whose operation is known not to be a proposal. A cache: losing it costs one read of an object.
    const notProposals = new Set()

    // -- the workspace of one call -------------------------------------------

    function open(context) {
      const { project, workspaceRoot, workspaceId, repositoryRoots } = context
      if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot) || !isIdentifier(workspaceId) || !Array.isArray(repositoryRoots) || project === null || typeof project !== 'object') {
        throw new TypeError('the proposal adapter needs the project, the private workspace root, the workspace identity and the repository roots')
      }
      callerClock = typeof context.clock === 'function' ? context.clock : null
      const stores = new Map()
      const recoveryOf = (scopeId) => {
        if (!stores.has(scopeId)) stores.set(scopeId, seams.createRecoveryStore({ workspaceRoot, workspaceId, scopeId, repositoryRoots }))
        return stores.get(scopeId)
      }
      let corpus
      // true, false, or null when the canonical graph cannot be read now. The rule is the one source apply asks.
      const visible = options.isVisible ? (identity) => options.isVisible(identity, context) : ({ repoId, nodeId }) => {
        try {
          corpus ??= {
            graph: seams.buildGraph({ project, eligibility }),
            profile: seams.profileFor({ project, workspaceId, audienceAllow: readMachineSettings({ workspaceRoot, workspaceId })?.audienceAllow ?? [] }),
          }
        } catch (error) { if (isTyped(error)) return null; throw error }
        if (!corpus.graph.nodes.some((node) => node.repo === repoId && node.id === nodeId)) return false
        const decision = decideApply({ request: { mode: 'manual', editId: 'edit-route' }, workspace: { workspaceRoot, workspaceId }, graph: corpus.graph, profile: corpus.profile, object: { repoId, nodeId }, editClass: 'body-replacement' })
        return decision.allowed === true || decision.code !== 'object-not-visible'
      }
      let objects = null
      // Records are immutable, so the queue of a workspace, and what it has verified, is kept from one tick to the next.
      const queueKey = JSON.stringify([workspaceRoot, workspaceId, repositoryRoots])
      const queue = () => {
        if (queues.get(queueKey) === undefined) { queues.clear(); queues.set(queueKey, openProposalQueue({ stateRoot: workspaceRoot, workspaceId, repositoryRoots, clock, crash: queueCrash })) }
        return queues.get(queueKey)
      }
      return {
        ...context, recoveryOf, visible,
        objects: () => (objects ??= objectStore({ stateRoot: workspaceRoot, workspaceId, repositoryRoots, clock })),
        queue,
        managedRoots: () => [workspaceRoot, ...[...stores.values()].map((store) => store.vaultRoot)],
      }
    }

    // The immutable manifest of one generation of one view.
    function manifestOf(workspace, scopeId, generationId) {
      const current = workspace.recoveryOf(scopeId).readCurrentManifest()
      if (current?.generationId === generationId) return current
      const directory = path.join(workspace.workspaceRoot, 'state', 'manifests', segment(scopeId))
      let names = []
      try { names = fs.readdirSync(directory) } catch (error) { if (error.code !== 'ENOENT') throw error }
      for (const name of names.filter((item) => item.startsWith(`${segment(generationId)}--`) && item.endsWith('.json')).sort()) {
        let bytes
        try { bytes = readFileBytes(path.join(directory, name)) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
        if (name !== `${segment(generationId)}--${sha256Digest(bytes).slice(7, 19)}.json`) continue
        const manifest = JSON.parse(bytes.toString('utf8'))
        if (manifest.generationId === generationId && manifest.scopeId === scopeId) return manifest
      }
      return null
    }

    function retained(store, digest) {
      if (typeof digest !== 'string') return null
      try { const bytes = store.readObject(digest); return sha256Digest(bytes) === digest ? bytes : null } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'recovery-object-corrupt') return null
        throw error
      }
    }

    // A pending edit as the operation the object store recorded for it, or null when that is not a proposed
    // structural edit (or is not recorded yet). The live note is never read: only bytes that were preserved.
    function describe(workspace, edit) {
      const { workspaceId, repoId, nodeId } = edit.identity
      const entry = workspace.objects().stateOf({ repoId, nodeId }).operations.find((operation) => operation.origins.some((origin) => origin.editId === edit.editId && origin.scopeId === edit.scopeId))
      if (!entry) return null
      if (entry.kind !== 'semantic-proposal' || entry.state !== 'proposed') { notProposals.add(edit.editId); return null }
      const origin = entry.origins.find((item) => item.editId === edit.editId && item.scopeId === edit.scopeId)
      const item = {
        workspaceId, repoId, nodeId, editId: edit.editId, idempotencyKey: entry.idempotencyKey, scopeId: origin.scopeId, generationId: origin.generationId,
        baseSourceDigest: entry.baseSourceDigest, observed: { digest: entry.observedDigest, byteLength: entry.observedByteLength, recoveryRef: origin.recoveryRef },
        adapterOperationId: adapterOperationId({ workspaceId, repoId, nodeId, idempotencyKey: entry.idempotencyKey }), sourcePath: null, publishedNoteDigest: null, change: { code: 'unclassified', reason: 'manifest-unavailable' },
      }
      const manifest = manifestOf(workspace, origin.scopeId, origin.generationId)
      const noteEntry = manifest?.notes.find((note) => note.repoId === repoId && note.nodeId === nodeId && note.path === edit.path)
      if (!noteEntry) return item
      const recordedPath = noteEntry.ext?.[EXT]?.source?.path
      item.sourcePath = typeof recordedPath === 'string' ? recordedPath : null
      item.publishedNoteDigest = noteEntry.noteDigest ?? null
      const store = workspace.recoveryOf(origin.scopeId)
      const [publishedNoteBytes, editedNoteBytes, baseSourceBytes] = [retained(store, noteEntry.noteDigest), retained(store, entry.observedDigest), retained(store, entry.baseSourceDigest)]
      if (!publishedNoteBytes || !editedNoteBytes || !baseSourceBytes) { item.change = { code: 'unclassified', reason: 'preserved-bytes-unavailable' }; return item }
      let outcome
      try { outcome = applyEditLens({ manifest, repoId, nodeId, publishedNoteBytes, editedNoteBytes, baseSourceBytes }) } catch (error) { if (!isTyped(error)) throw error; outcome = { kind: 'refusal', code: error.code } }
      item.change = describeChange(outcome)
      return item
    }

    // -- one operation, under the lock of its repository ----------------------

    function receiptOf({ item, storeId, sequence, proposalId, dedupe, backpressure }) {
      const receipt = {
        schema: 'atelier-obsidian-proposal-receipt/v1', contractVersion: '1.0.0', receiptId: `pr-${hashOf([item.adapterOperationId, String(sequence)]).slice(0, 48)}`,
        repoId: item.repoId, storeId, adapterOperationId: item.adapterOperationId, editId: item.editId, proposalId, dedupe, backpressure, recordedAt: isoTime(clock),
      }
      assertObsidianContract('proposal-receipt', receipt)
      return receipt
    }

    function settleOne(workspace, item, { requireOpenEdit = true, editState = 'open' } = {}) {
      const queue = workspace.queue()
      const { repoId, adapterOperationId: operationId } = item
      const storeId = proposalStoreId(item)
      const step = (name) => crash(name, { adapterOperationId: operationId, repoId })
      const outcome = (status, record, extra = {}) => ({ status, code: record?.code ?? null, editId: item.editId, repoId, nodeId: item.nodeId, adapterOperationId: operationId, state: record?.state ?? null, proposalId: record?.proposalId ?? null, ...extra })
      let history = queue.read(repoId, operationId)
      const known = history !== null
      const sequenceNext = () => (history?.records.length ?? 0) + 1
      const write = (fields) => { const record = queue.append(repoId, operationId, fields); history = queue.read(repoId, operationId); return record }
      const refused = (code) => {
        const receipt = receiptOf({ item, storeId, sequence: sequenceNext(), proposalId: null, dedupe: known ? 'duplicate' : 'new', backpressure: 'refused' })
        return outcome('refused', write({ ...identityFields(item, storeId), state: 'refused', code, proposalId: null, dedupe: null, nextAttemptAt: null, receipt }), { receipt })
      }
      const deferred = (code, attempts) => {
        const record = write({ ...identityFields(item, storeId), state: 'backpressure', code, attempts, lastAttemptAt: isoTime(clock), nextAttemptAt: nextAttemptAt({ attempts, nowMs: Date.parse(isoTime(clock)), bounds }), proposalId: null, dedupe: null, receipt: null })
        return outcome('deferred', record, { receipt: receiptOf({ item, storeId, sequence: record.sequence, proposalId: null, dedupe: known ? 'duplicate' : 'new', backpressure: 'deferred' }), exhausted: isExhausted(record, bounds) })
      }

      if (history && rules.isSettled({ head: history.head })) {
        // Offered again: answered from the record. Nothing is read from the store and nothing is written.
        const { head } = history
        return outcome('duplicate', head, { receipt: { ...head.receipt, dedupe: 'duplicate' } })
      }

      let proposalId = history?.head.state === 'submitted' ? history.head.proposalId : null
      let dedupe = history?.head.state === 'submitted' ? history.head.dedupe : null
      let attempts = history?.head.attempts ?? 0
      let store = null
      let route = null

      if (proposalId === null) {
        // A person took the edit back, or made another over it: the request is theirs to withdraw.
        if (requireOpenEdit && editState !== 'open') return known ? refused(`edit-${editState}`) : outcome('skipped', null, { code: `edit-${editState}` })
        // The object store no longer says this is a proposed structural edit, so there is nothing to describe.
        if (item.observed === null) return refused('operation-not-proposed')
        const resolved = resolveProposalRoute({ project: workspace.project, workspaceId: workspace.workspaceId, identity: item, sourcePath: item.sourcePath, managedRoots: workspace.managedRoots(), isVisible: workspace.visible, isGitIgnored, env })
        if (!resolved.ok && !resolved.transient) return refused(resolved.code)
        // Recorded before anything is asked of the store.
        if (!known) write({ ...identityFields(item, storeId), state: 'queued', code: null, proposalId: null, dedupe: null, receipt: null, nextAttemptAt: null })
        step('queued')
        if (!resolved.ok) return deferred(resolved.code, attempts + 1)
        route = resolved.route
      }

      attempts += 1
      const repositoryRoot = route?.repositoryRoot ?? repositoryRootOf(workspace.project, repoId)
      if (repositoryRoot === null) return proposalId === null ? refused('repository-not-enrolled') : outcome('deferred', history.head, { code: 'repository-not-enrolled' })
      try { store = openStore({ workspaceRoot: repositoryRoot, workspaceId: workspace.workspaceId }) } catch { return proposalId === null ? deferred('store-unavailable', attempts) : outcome('deferred', history.head, { code: 'store-unavailable' }) }

      if (proposalId === null) {
        const ledger = classifyLedgerRead(store.eventLedger.readAll(), limits)
        if (ledger.state === 'corrupt') return refused(ledger.code)
        if (ledger.state === 'full') { rules.relieve({ store, ledger }); return deferred(ledger.code, attempts) }
        if (ledger.state !== 'readable') return deferred(ledger.code, attempts)

        let existing = []
        if (rules.lookBeforeCreate) {
          const listed = store.listProposals()
          if (!listed.ok) { const read = classifyLedgerRead(listed, limits); return read.state === 'corrupt' ? refused(read.code) : deferred(read.code, attempts) }
          existing = rules.existingFor({ proposals: listed.proposals, item }).sort((left, right) => compareText(left.proposal.createdAt, right.proposal.createdAt) || compareText(left.proposal.id, right.proposal.id))
        }
        if (existing.length > 0) {
          proposalId = existing[0].proposal.id
          dedupe = 'recovered'
        } else {
          const body = rules.content({ item, route, change: item.change })
          const fits = preflightAppend({ ledger, lineBytes: estimateEventLineBytes({ body, workspaceId: workspace.workspaceId, marginBytes: bounds.lineMarginBytes }), limits, bounds })
          if (!fits.ok) {
            if (fits.code === 'proposal-too-large') return refused(fits.code)
            rules.relieve({ store, ledger })
            return deferred(fits.code, attempts)
          }
          step('before-append')
          const created = store.createProposal(body)
          if (!created.ok) {
            const code = classifyStoreRefusal(created.status)
            return code === 'store-refused' || code === 'ledger-corrupt' ? refused(code) : deferred(code, attempts)
          }
          step('appended')
          // What went in is what is there: the identity in the payload and the path, byte for byte.
          if (created.record?.payload?.adapter?.operationId !== operationId || created.record?.proposal?.path !== route.sourcePath) return refused('identity-not-preserved')
          proposalId = created.record.proposal.id
          dedupe = 'new'
        }
        write({ ...identityFields(item, storeId), state: 'submitted', code: null, attempts, lastAttemptAt: isoTime(clock), nextAttemptAt: null, proposalId, dedupe, receipt: null })
        step('submitted')
      }

      // Read back from the persisted store before it is acknowledged.
      const read = store.readProposal(proposalId)
      if (!read.ok || read.record?.payload?.adapter?.operationId !== operationId) {
        if (read.status === 404 || read.ok) { write({ ...identityFields(item, storeId), state: 'queued', code: 'proposal-not-found', proposalId: null, dedupe: null, receipt: null, nextAttemptAt: null }); return outcome('deferred', history.head) }
        const record = write({ state: 'submitted', code: classifyLedgerRead(read, limits).code, attempts, lastAttemptAt: isoTime(clock), nextAttemptAt: nextAttemptAt({ attempts, nowMs: Date.parse(isoTime(clock)), bounds }) })
        return outcome('deferred', record)
      }
      const receipt = receiptOf({ item, storeId, sequence: sequenceNext(), proposalId, dedupe, backpressure: 'accepted' })
      const record = write({ state: 'acknowledged', code: null, nextAttemptAt: null, receipt })
      step('acknowledged')
      return outcome('acknowledged', record, { receipt, dedupe })
    }

    const identityFields = (item, storeId) => ({
      nodeId: item.nodeId, editId: item.editId, idempotencyKey: item.idempotencyKey, scopeId: item.scopeId, generationId: item.generationId, storeId,
      sourcePath: isRoutableSourcePath(item.sourcePath) ? item.sourcePath : null,
    })

    function repositoryRootOf(project, repoId) {
      const named = (project?.repos ?? []).filter((item) => item?.name === repoId && !item.external && typeof item.path === 'string')
      if (named.length !== 1) return null
      try { return fs.realpathSync.native(named[0].path) } catch { return null }
    }

    async function withRepositoryLock(workspace, repoId, operation) {
      const queue = workspace.queue()
      queue.ensureRepository(repoId)
      let lock
      for (let attempt = 0; ; attempt += 1) {
        try { lock = await rules.acquireLock({ workspaceRoot: queue.stateRoot, directory: queue.lockDirectory(repoId), workspaceId: workspace.workspaceId, purpose: PROPOSAL_LOCK_PURPOSE, clock, proveAbandoned }); break } catch (error) {
          if (error.code !== 'EEXIST' || attempt >= 8) throw error
        }
      }
      if (!lock.acquired) return { locked: false, reason: lock.reason }
      let crashed = false
      try { return { locked: true, value: await operation() } } catch (error) { crashed = error?.crashSeam === true; throw error } finally {
        // A process that died released nothing; the test that stands for it says so.
        if (!crashed) lock.release()
      }
    }

    const itemOfHead = (head, edit) => ({
      workspaceId: head.workspaceId, repoId: head.repoId, nodeId: head.nodeId, editId: head.editId, idempotencyKey: head.idempotencyKey, scopeId: head.scopeId, generationId: head.generationId,
      adapterOperationId: head.adapterOperationId, sourcePath: head.sourcePath, baseSourceDigest: null, observed: null, publishedNoteDigest: null, change: { code: 'unclassified', reason: null }, edit,
    })

    // One repository: its lock, then each of its operations in turn. What goes wrong with one repository, or with one
    // operation, is reported by its code and stops nothing else.
    async function settleRepository(workspace, repoId, works, report) {
      try {
        const held = await withRepositoryLock(workspace, repoId, () => {
          for (const work of works) {
            try { report.outcomes.push(settleOne(workspace, work.item, work)) } catch (error) {
              if (error?.crashSeam === true || !isTyped(error)) throw error
              report.outcomes.push({ status: 'failed', code: error.code, editId: work.item.editId, repoId, nodeId: work.item.nodeId, adapterOperationId: work.item.adapterOperationId, state: null, proposalId: null })
            }
          }
        })
        if (!held.locked) report.repositories.push({ repoId, code: 'adapter-lock-held', reason: held.reason })
      } catch (error) {
        if (error?.crashSeam === true || !isTyped(error)) throw error
        report.repositories.push({ repoId, code: error.code })
      }
    }

    return {
      id: PROPOSAL_ADAPTER_ID,

      // The tick. `context` is { project, workspaceRoot, workspaceId, repositoryRoots, edits }: the pending edit
      // records of the engine, open and closed. Returns codes and identifiers only.
      async propose(context) {
        const workspace = open(context)
        const nowMs = Date.parse(isoTime(clock))
        const report = { adapterId: PROPOSAL_ADAPTER_ID, examined: 0, outcomes: [], repositories: [] }
        const edits = Array.isArray(context.edits) ? context.edits : []
        const { operations: heads, unreadable } = workspace.queue().heads()
        for (const item of unreadable) report.repositories.push({ repoId: null, code: item.code })
        const byEdit = new Map(edits.map((edit) => [edit.editId, edit]))
        const knownEdits = new Set(heads.map((head) => head.editId))
        const works = new Map()
        const add = (repoId, work) => { if (!works.has(repoId)) works.set(repoId, []); if (works.get(repoId).length < bounds.maxBatchPerRepository) works.get(repoId).push(work) }

        // Operations the queue already knows, when they are due.
        for (const head of [...heads].sort((left, right) => compareText(left.recordedAt, right.recordedAt) || compareText(left.adapterOperationId, right.adapterOperationId))) {
          if (!rules.handOver({ head, nowMs, bounds })) continue
          const edit = byEdit.get(head.editId) ?? null
          // An operation whose edit this caller did not hand over is not this caller's to decide: it waits as it is.
          if (edit === null && head.state !== 'submitted') continue
          const editState = edit === null || edit.closedAt === null ? 'open' : ['withdrawn', 'superseded'].includes(edit.state) ? edit.state : 'closed'
          let item = itemOfHead(head, edit)
          if (edit !== null && head.state !== 'submitted') {
            try { item = { ...item, ...(describe(workspace, edit) ?? {}) } } catch (error) { if (!isTyped(error)) throw error; report.outcomes.push({ status: 'failed', code: error.code, editId: head.editId, repoId: head.repoId, nodeId: head.nodeId, adapterOperationId: head.adapterOperationId, state: head.state, proposalId: null }); continue }
          }
          add(head.repoId, { item, editState })
        }

        // Pending edits the queue does not know: a bounded number per tick, starting where the last tick stopped.
        const fresh = edits.filter((edit) => edit.closedAt === null && !knownEdits.has(edit.editId) && !notProposals.has(edit.editId)).sort((left, right) => compareText(left.observedAt, right.observedAt) || compareText(left.editId, right.editId))
        const start = fresh.length === 0 ? 0 : cursor % fresh.length
        const looked = [...fresh.slice(start), ...fresh.slice(0, start)].slice(0, bounds.maxExaminedPerTick)
        cursor = fresh.length > bounds.maxExaminedPerTick ? start + looked.length : 0
        for (const edit of looked) {
          report.examined += 1
          let item
          try { item = describe(workspace, edit) } catch (error) { if (!isTyped(error)) throw error; report.outcomes.push({ status: 'failed', code: error.code, editId: edit.editId, repoId: edit.identity.repoId, nodeId: edit.identity.nodeId, adapterOperationId: null, state: null, proposalId: null }); continue }
          if (item !== null) add(item.repoId, { item, editState: 'open' })
        }

        for (const [repoId, list] of [...works].sort(([left], [right]) => compareText(left, right))) await settleRepository(workspace, repoId, list, report)
        return report
      },

      // One edit operation document, offered directly: what a caller that already holds the operation uses, and what
      // the tests of routing and identity use. `sourcePath` is the repository-relative path the manifest records.
      async offer(context, { operation, sourcePath, change = { code: 'unclassified', reason: null }, publishedNoteDigest = null }) {
        assertObsidianContract('edit-operation', operation)
        if (operation.kind !== 'semantic-proposal' || operation.state !== 'proposed') return { status: 'refused', code: 'invalid-operation', editId: operation.editId, repoId: operation.repoId, nodeId: operation.nodeId, adapterOperationId: null, state: null, proposalId: null }
        const workspace = open(context)
        const item = {
          workspaceId: operation.workspaceId, repoId: operation.repoId, nodeId: operation.nodeId, editId: operation.editId, idempotencyKey: operation.idempotencyKey, scopeId: operation.origin.scopeId, generationId: operation.origin.generationId,
          baseSourceDigest: operation.baseSourceDigest, observed: { ...operation.observed }, adapterOperationId: adapterOperationId(operation), sourcePath, publishedNoteDigest, change,
        }
        if (item.workspaceId !== workspace.workspaceId) return { status: 'refused', code: 'foreign-workspace', editId: item.editId, repoId: item.repoId, nodeId: item.nodeId, adapterOperationId: item.adapterOperationId, state: null, proposalId: null }
        const report = { outcomes: [], repositories: [] }
        await settleRepository(workspace, item.repoId, [{ item, requireOpenEdit: false }], report)
        return report.outcomes[0] ?? { status: 'deferred', code: report.repositories[0]?.code ?? 'adapter-lock-held', editId: item.editId, repoId: item.repoId, nodeId: item.nodeId, adapterOperationId: item.adapterOperationId, state: null, proposalId: null }
      },

      // A refused operation, or one whose retries are spent, asked for again by a person or an agent acting for them.
      async requeue(context, { repoId, adapterOperationId: operationId }) {
        const workspace = open(context)
        if (!isIdentifier(repoId) || !isAdapterOperationId(operationId)) return { requeued: false, code: 'invalid-operation' }
        const held = await withRepositoryLock(workspace, repoId, () => {
          const history = workspace.queue().read(repoId, operationId)
          if (history === null) return { requeued: false, code: 'unknown-operation' }
          if (history.head.state !== 'refused' && !isExhausted(history.head, bounds)) return { requeued: false, code: 'operation-not-refused', state: history.head.state }
          const record = workspace.queue().append(repoId, operationId, { state: 'queued', code: null, attempts: 0, lastAttemptAt: null, nextAttemptAt: null, proposalId: null, dedupe: null, receipt: null })
          return { requeued: true, state: record.state, sequence: record.sequence }
        })
        return held.locked ? held.value : { requeued: false, code: 'adapter-lock-held' }
      },

      // Read-only. Per repository: how many operations are in each state, the codes of the refused and the waiting,
      // and how much room the ledger of its store has. No note text, no source text, no path of this machine.
      status(context) {
        const workspace = open(context)
        const { operations, unreadable } = workspace.queue().heads()
        const enrolled = (workspace.project.repos ?? []).filter((repo) => !repo.external && typeof repo.path === 'string' && isIdentifier(repo.name)).map((repo) => repo.name)
        const repositories = [...new Set([...enrolled, ...operations.map((record) => record.repoId)])].sort(compareText).map((repoId) => {
          const own = operations.filter((record) => record.repoId === repoId)
          const count = (state) => own.filter((record) => record.state === state).length
          const codes = (state) => Object.fromEntries([...new Set(own.filter((record) => record.state === state).map((record) => record.code))].sort(compareText).map((code) => [code, own.filter((record) => record.state === state && record.code === code).length]))
          return {
            repoId, enrolled: enrolled.includes(repoId), storeId: proposalStoreId({ workspaceId: workspace.workspaceId, repoId }),
            queued: count('queued'), submitted: count('submitted'), acknowledged: count('acknowledged'), backpressure: count('backpressure'), refused: count('refused'),
            exhausted: own.filter((record) => isExhausted(record, bounds)).length, backpressureCodes: codes('backpressure'), refusedCodes: codes('refused'),
            ledger: ledgerOf(workspace, repoId),
          }
        })
        return { schema: 'atelier-obsidian-proposal-status/v1', workspaceId: workspace.workspaceId, adapterId: PROPOSAL_ADAPTER_ID, limits: { ...limits }, reserve: { events: bounds.reserveEvents, bytes: bounds.reserveBytes }, repositories, unreadable: unreadable.map(({ adapterOperationId: operationId, code }) => ({ adapterOperationId: operationId, code })) }
      },

      // Every operation of the queue: identifiers, states, codes and times.
      list(context) {
        const { operations } = open(context).queue().heads()
        return operations.sort((left, right) => compareText(left.repoId, right.repoId) || compareText(left.recordedAt, right.recordedAt) || compareText(left.adapterOperationId, right.adapterOperationId))
          .map(({ adapterOperationId: operationId, repoId, nodeId, editId, state, code, attempts, nextAttemptAt: next, proposalId, recordedAt }) => ({ adapterOperationId: operationId, repoId, nodeId, editId, state, code, attempts, nextAttemptAt: next, exhausted: state === 'backpressure' && attempts >= bounds.maxAttempts, proposalId, recordedAt }))
      },

      // One operation: its record, its receipt, and how the reviewers of the repository have settled its proposal so
      // far. That last part is shown and nothing more: no status of a proposal makes this adapter do anything.
      show(context, { adapterOperationId: operationId }) {
        const workspace = open(context)
        const head = workspace.queue().heads().operations.find((record) => record.adapterOperationId === operationId)
        if (!head) return null
        let review = null
        if (head.proposalId !== null) {
          const repositoryRoot = repositoryRootOf(workspace.project, head.repoId)
          if (repositoryRoot !== null && fs.existsSync(path.join(repositoryRoot, PROPOSAL_STORE_DIRECTORY))) {
            const read = openStore({ workspaceRoot: repositoryRoot, workspaceId: workspace.workspaceId }).readProposal(head.proposalId)
            review = read.ok ? { status: read.record.proposal.status, updatedAt: read.record.proposal.updatedAt } : { status: 'unreadable', updatedAt: null }
            if (read.ok) rules.onReviewStatus({ status: read.record.proposal.status, record: read.record, head, repositoryRoot })
          }
        }
        return { operation: head, review }
      },
    }

    function ledgerOf(workspace, repoId) {
      const repositoryRoot = repositoryRootOf(workspace.project, repoId)
      if (repositoryRoot === null) return { state: 'not-enrolled', events: null, bytes: null, headroom: null }
      // A store nobody made yet is not made to be asked: it has all of its room.
      if (!fs.existsSync(path.join(repositoryRoot, PROPOSAL_STORE_DIRECTORY))) return { state: 'absent', events: 0, bytes: 0, headroom: { events: limits.maxEvents, bytes: limits.maxBytes } }
      try {
        const { state, events, bytes, headroom } = classifyLedgerRead(openStore({ workspaceRoot: repositoryRoot, workspaceId: workspace.workspaceId }).eventLedger.readAll(), limits)
        return { state, events, bytes, headroom }
      } catch { return { state: 'unavailable', events: null, bytes: null, headroom: null } }
    }
  }
}

export const createProposalAdapter = createProposalAdapterForOracleTests()
export { OPEN_QUEUE_STATES }
