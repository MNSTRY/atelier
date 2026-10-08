import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createProposalStore } from '../src/collaboration/proposals.mjs'
import { initializeKnowledgeHealthWorkshop } from '../src/knowledge-health/workshop.mjs'
import { encodePublicWorkshopInterpretation } from '../src/knowledge-health/workshop-profile.mjs'
import { createKnowledgeSessions } from '../src/knowledge/sessions.mjs'
import { resolveProjectConfig } from '../src/project/config.mjs'
import { createAtelierSidecarServer } from '../src/server/local-sidecar.mjs'

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mnstry-atelier-proposals-'))
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Atelier</title>\n')
  fs.writeFileSync(path.join(root, 'atelier.manifest.json'), '{"schema":"mnstry.atelier-manifest@v1","entry":"index.html"}\n')
  return root
}

function fingerprint(file) {
  const stat = fs.statSync(file)
  return {
    hash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  }
}

async function postJson(route, body, base, nonce = null) {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: base,
      'Sec-Fetch-Site': 'same-origin',
      ...(nonce ? { 'X-Atelier-Nonce': nonce } : {}),
    },
    body: JSON.stringify(body),
  })
  return { response, body: await response.json().catch(() => ({})) }
}

test('proposal lifecycle is nonce-protected, local, and copy-only', async (t) => {
  const workspaceRoot = makeWorkspace()
  const sourceFile = path.join(workspaceRoot, 'index.html')
  const before = fingerprint(sourceFile)
  const sidecar = createAtelierSidecarServer({ workspaceRoot })
  t.after(async () => {
    await sidecar.close()
    fs.rmSync(workspaceRoot, { recursive: true, force: true })
  })
  const address = await sidecar.listen()
  const base = `http://127.0.0.1:${address.port}`

  const unauthenticated = await postJson('/api/proposals', {
    sessionId: 'proposal-session',
    viewId: 'proposal-view',
    path: 'index.html',
    action: 'metadata.status',
  }, base)
  assert.equal(unauthenticated.response.status, 403)
  assert.match(unauthenticated.body.error, /nonce/i)

  const auth = await fetch(`${base}/api/session-auth?sessionId=proposal-session&viewId=proposal-view&path=index.html`, {
    headers: {
      Origin: base,
      'Sec-Fetch-Site': 'same-origin',
    },
  })
  const authBody = await auth.json()
  const nonce = authBody.mutationNonce

  const directWrite = await postJson('/api/proposals', {
    sessionId: 'proposal-session',
    viewId: 'proposal-view',
    path: 'index.html',
    action: 'apply.patch',
    authority: { directWrite: true },
  }, base, nonce)
  assert.equal(directWrite.response.status, 409)
  assert.match(directWrite.body.error, /direct-write/i)

  const diff = [
    'diff --git a/index.html b/index.html',
    '--- a/index.html',
    '+++ b/index.html',
    '@@ -1 +1 @@',
    '-<title>Atelier</title>',
    '+<title>MNSTRY Atelier</title>',
  ].join('\n')
  const created = await postJson('/api/proposals', {
    sessionId: 'proposal-session',
    viewId: 'proposal-view',
    path: 'index.html',
    // Display verbs are not authority. The explicit capability fields are.
    action: 'apply.patch',
    capability: 'proposal.copy-only',
    directWrite: false,
    applyEndpoint: null,
    diff,
    proposal: {
      reason: 'review-only handoff',
    },
  }, base, nonce)
  assert.equal(created.response.status, 200)
  assert.equal(created.body.ok, true)
  assert.equal(created.body.proposal.status, 'proposed')
  assert.equal(created.body.proposal.storage.ignored, true)
  assert.equal(created.body.proposal.authority.directWrite, false)
  assert.equal(created.body.proposal.authority.applyEndpoint, null)
  assert.deepEqual(fingerprint(sourceFile), before)

  const id = created.body.proposal.id
  const prematureAccept = await postJson(`/api/proposals/${id}/review`, {
    status: 'accepted',
    reviewer: 'test',
  }, base, nonce)
  assert.equal(prematureAccept.response.status, 409)
  assert.match(prematureAccept.body.error, /proposed -> accepted/)

  const reviewed = await postJson(`/api/proposals/${id}/review`, {
    status: 'reviewed',
    reviewer: 'test',
    notes: 'metadata-only review',
  }, base, nonce)
  assert.equal(reviewed.response.status, 200)
  assert.equal(reviewed.body.proposal.status, 'reviewed')
  assert.equal(reviewed.body.copyable, undefined)

  const accepted = await postJson(`/api/proposals/${id}/review`, {
    status: 'accepted',
    reviewer: 'test',
    notes: 'accepted for normal editing',
  }, base, nonce)
  assert.equal(accepted.response.status, 200)
  assert.equal(accepted.body.proposal.status, 'accepted')
  assert.equal(accepted.body.copyable.directWrite, false)
  assert.equal(accepted.body.copyable.applyEndpoint, null)
  assert.equal(accepted.body.copyable.diff, diff)
  assert.match(accepted.body.copyable.agentInstructions, /normal repo editing/)
  assert.deepEqual(fingerprint(sourceFile), before)
  const ledgerPath = path.join(workspaceRoot, '.atelier-proposals', 'events.ndjson')
  const events = fs
    .readFileSync(ledgerPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  assert.deepEqual(events.map((event) => event.type), [
    'proposal-created',
    'proposal-reviewed',
    'proposal-reviewed',
  ])
  assert.equal(events.at(-1).version, 3)
  if (process.platform !== 'win32') assert.equal(fs.statSync(ledgerPath).mode & 0o777, 0o600)

  const page = await fetch(`${base}/proposals/${id}`, {
    headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin' },
  })
  const pageText = await page.text()
  assert.equal(page.status, 200)
  assert.match(pageText, /Copy Handoff/)
  assert.match(pageText, /no browser apply endpoint/i)
})

// Retention of the public workshop handoff. Every workspace below is the
// invented workshop fixture in a disposable directory. Sessions are driven
// through the same on-disk store the server reads; the handoff, the proposal
// routes and their fences are exercised over HTTP.
const ORIGINAL_WORDS = 'I would like more context.\nKeep my words exactly.'
const SELECTED_DECLARATION = '["devday:workshop"]'
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')

async function openWorkshop(t) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mnstry-atelier-retention-')))
  const root = initializeKnowledgeHealthWorkshop(path.join(parent, 'workshop'))
  const project = resolveProjectConfig({
    cwd: root,
    argv: ['--project', path.join(root, 'atelier.project.json')],
    env: {},
    writeLocalState: false,
  })
  const published = path.join(parent, 'published')
  fs.mkdirSync(published)
  fs.writeFileSync(path.join(published, 'index.html'), '<!doctype html><title>Invented projection</title>\n')
  fs.writeFileSync(path.join(published, 'atelier.manifest.json'), '{"schema":"mnstry.atelier-manifest@v1","entry":"index.html"}\n')
  const workshop = {
    parent,
    root,
    published,
    project,
    sessions: createKnowledgeSessions(project),
    source: path.join(root, 'records', 'checklist.md'),
    ledger: path.join(published, '.atelier-proposals', 'events.ndjson'),
    sidecar: null,
    base: null,
    nonce: null,
  }
  workshop.start = async () => {
    workshop.sidecar = createAtelierSidecarServer({ workspaceRoot: published, knowledgeProject: project })
    const address = await workshop.sidecar.listen()
    workshop.base = `http://127.0.0.1:${address.port}`
    const grant = await postJson('/api/knowledge/session', {}, workshop.base)
    assert.equal(grant.response.status, 200)
    workshop.nonce = grant.body.mutationNonce
  }
  workshop.stop = async () => {
    if (workshop.sidecar) await workshop.sidecar.close()
    workshop.sidecar = null
  }
  workshop.handoff = (body) => postJson('/api/knowledge/workshop-handoff', body, workshop.base, workshop.nonce)
  workshop.readProposal = async (id) => {
    const response = await fetch(`${workshop.base}/api/proposals/${id}`, { headers: { Origin: workshop.base, 'Sec-Fetch-Site': 'same-origin' } })
    return { response, body: await response.json().catch(() => ({})) }
  }
  workshop.ledgerBytes = () => (fs.existsSync(workshop.ledger) ? fs.readFileSync(workshop.ledger, 'utf8') : '')
  workshop.events = () => workshop.ledgerBytes().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  workshop.savedValue = (sessionId, requestId) => path.join(root, '.atelier-local', 'coauthor', 'values', sha256(sessionId), `${sha256(requestId)}.json`)
  t.after(async () => {
    await workshop.stop()
    fs.rmSync(parent, { recursive: true, force: true })
  })
  await workshop.start()
  return workshop
}

// One participant response, then the separate Review session. `select`
// decides whether the Review session saves its one selected declaration.
function contribute(workshop, { suffix = '1', choice = 'perspective-only', review = true, select = true } = {}) {
  const api = workshop.sessions
  let current = api.start({
    requestId: `1111111${suffix}-1111-4111-8111-111111111111`,
    flow: 'workshop',
    questionId: 'workshop-readiness',
    snapshot: api.workshopProfile().snapshot,
    author: 'Invented participant',
  })
  const event = (sessionId, id, type, extra = {}) => {
    current = api.event({ sessionId, event: { id, type, expectedRevision: current.state.revision, ...extra } })
    return current
  }
  const field = (sessionId, name, text) => {
    event(sessionId, `${name}-answer`, 'answer', { text })
    event(sessionId, `${name}-save`, 'save')
    event(sessionId, `${name}-advance`, 'advance')
  }
  const participantId = current.record.id
  field(participantId, 'words', ORIGINAL_WORDS)
  field(participantId, 'interpretation', encodePublicWorkshopInterpretation(''))
  field(participantId, 'choice', choice)
  if (!review) return { participantId, reviewId: null }
  current = api.workshopReview({ requestId: `2222222${suffix}-2222-4222-8222-222222222222`, sessionId: participantId })
  const reviewId = current.record.id
  if (select) {
    event(reviewId, 'selected-answer', 'answer', { text: SELECTED_DECLARATION })
    event(reviewId, 'selected-save', 'save')
    event(reviewId, 'selected-advance', 'advance')
  }
  return { participantId, reviewId }
}

test('a selected workshop draft is retained once, whole, and read back', async (t) => {
  const workshop = await openWorkshop(t)
  const sourceBefore = fingerprint(workshop.source)
  const { participantId, reviewId } = contribute(workshop)

  const first = await workshop.handoff({ sessionId: reviewId })
  assert.equal(first.response.status, 200, JSON.stringify(first.body))
  assert.equal(first.body.ok, true)
  assert.equal(first.body.directWrite, false)
  assert.equal(first.body.sourceEditsApplied, false)
  const retention = first.body.retention
  assert.equal(retention.status, 'retained')
  assert.equal(retention.outcome, 'created')
  assert.equal(retention.sourceCurrent, true)
  assert.match(retention.proposalId, /^proposal-[a-f0-9]{32}$/)
  assert.equal(retention.readback, `/api/proposals/${retention.proposalId}`)
  assert.deepEqual(retention.receipt, { sessionId: reviewId, requestId: 'selected-save', valueDigest: sha256(SELECTED_DECLARATION) })
  assert.match(retention.payloadDigest, /^[a-f0-9]{64}$/)
  assert.equal(retention.proposalStatus, 'proposed')

  const events = workshop.events()
  assert.deepEqual(events.map((event) => event.type), ['proposal-created'])
  assert.equal(events[0].aggregateId, retention.proposalId)

  const read = await workshop.readProposal(retention.proposalId)
  assert.equal(read.response.status, 200)
  assert.equal(read.body.proposal.id, retention.proposalId)
  assert.equal(read.body.proposal.status, 'proposed')
  assert.equal(read.body.proposal.path, 'records/checklist.md')
  assert.equal(read.body.proposal.action, 'copy.repoPath')
  assert.equal(read.body.proposal.authority.directWrite, false)
  assert.equal(read.body.proposal.authority.applyEndpoint, null)
  assert.equal(read.body.copyable, undefined, 'a retained handoff is not an accepted review')
  const kept = read.body.payload
  const prepared = first.body.handoff
  assert.deepEqual(kept, prepared.proposal, 'the retained payload is the server-derived handoff, unshortened')
  assert.equal(kept.originalWords, ORIGINAL_WORDS)
  assert.equal(kept.interpretation, '')
  assert.equal(kept.choice, 'perspective-only')
  assert.equal(kept.originalContributionId, 'words-answer')
  assert.equal(kept.originalChoiceId, 'choice-answer')
  assert.equal(kept.contributionSessionId, participantId)
  assert.equal(kept.authoredRevision, SELECTED_DECLARATION)
  assert.deepEqual(Object.keys(kept.findingReference).sort(), ['checkId', 'checkVersion', 'comparisonSha256', 'id', 'planSha256', 'readSetSha256'])
  assert.ok(kept.source, 'the source binding is retained')
  assert.equal(kept.anchor.quote, '[]')
  assert.ok(kept.readSet, 'the read set is retained')
  assert.deepEqual(kept.declarationBytes, { encoding: 'utf8', before: '[]', after: SELECTED_DECLARATION })
  assert.equal(kept.savedDraftReceipts.length, 4)
  assert.deepEqual(kept.selectedDraftReceipt, kept.savedDraftReceipts[3])
  assert.equal(kept.selectedDraftReceipt.requestId, 'selected-save')
  assert.equal(kept.directWrite, false)
  assert.equal(kept.applyEndpoint, null)
  assert.equal(kept.sourceEditsApplied, false)
  assert.equal(read.body.diff, JSON.stringify(prepared.diff, null, 2))
  assert.deepEqual(read.body.retention.receipt, kept.selectedDraftReceipt)
  assert.equal(read.body.retention.payloadDigest, retention.payloadDigest)
  assert.deepEqual(fingerprint(workshop.source), sourceBefore, 'retention writes no source byte')

  const listed = await fetch(`${workshop.base}/api/proposals`, { headers: { Origin: workshop.base, 'Sec-Fetch-Site': 'same-origin' } })
  const listedBody = await listed.json()
  assert.deepEqual(listedBody.proposals.map((record) => record.proposal.id), [retention.proposalId])
})

test('repeating the request, and reopening after a restart, returns the same proposal and appends nothing', async (t) => {
  const workshop = await openWorkshop(t)
  const { reviewId } = contribute(workshop)
  const first = await workshop.handoff({ sessionId: reviewId })
  assert.equal(first.body.retention.outcome, 'created')
  const ledgerAfterFirst = workshop.ledgerBytes()

  // A lost reply: the caller repeats the identical request.
  const again = await workshop.handoff({ sessionId: reviewId })
  assert.equal(again.response.status, 200)
  assert.equal(again.body.retention.outcome, 'existing')
  assert.equal(again.body.retention.proposalId, first.body.retention.proposalId)
  assert.equal(again.body.retention.payloadDigest, first.body.retention.payloadDigest)
  assert.equal(workshop.ledgerBytes(), ledgerAfterFirst)

  // A new server process over the same durable state.
  await workshop.stop()
  await workshop.start()
  const reopened = await workshop.handoff({ sessionId: reviewId })
  assert.equal(reopened.response.status, 200)
  assert.equal(reopened.body.retention.outcome, 'existing')
  assert.equal(reopened.body.retention.proposalId, first.body.retention.proposalId)
  assert.deepEqual(reopened.body.handoff, first.body.handoff)
  assert.equal(workshop.ledgerBytes(), ledgerAfterFirst)
  const read = await workshop.readProposal(first.body.retention.proposalId)
  assert.deepEqual(read.body.payload, first.body.handoff.proposal)
})

test('after the source changes, a retained proposal is still read back and nothing new is retained', async (t) => {
  const workshop = await openWorkshop(t)
  const retained = contribute(workshop, { suffix: '1' })
  const late = contribute(workshop, { suffix: '2' })
  const first = await workshop.handoff({ sessionId: retained.reviewId })
  assert.equal(first.body.retention.outcome, 'created')
  const ledgerAfterFirst = workshop.ledgerBytes()

  // An ordinary owner edit of the source, outside the tool.
  fs.appendFileSync(workshop.source, '\nChanged by the source owner.\n')

  const reopened = await workshop.handoff({ sessionId: retained.reviewId })
  assert.equal(reopened.response.status, 200, JSON.stringify(reopened.body))
  assert.equal(reopened.body.retention.outcome, 'existing')
  assert.equal(reopened.body.retention.sourceCurrent, false)
  assert.equal(reopened.body.retention.proposalId, first.body.retention.proposalId)
  assert.deepEqual(reopened.body.handoff, first.body.handoff, 'the retained handoff is read back as it was kept')

  const stale = await workshop.handoff({ sessionId: late.reviewId })
  assert.equal(stale.response.status, 409)
  assert.equal(stale.body.ok, false)
  assert.equal(stale.body.retention.status, 'not-retained')
  assert.equal(workshop.ledgerBytes(), ledgerAfterFirst)
})

test('an incomplete Review, a response that selects nothing and an unknown session retain nothing', async (t) => {
  const workshop = await openWorkshop(t)
  const unselected = contribute(workshop, { suffix: '1', select: false })
  const paused = contribute(workshop, { suffix: '2', choice: 'pause', review: false })
  for (const sessionId of [unselected.reviewId, unselected.participantId, paused.participantId, 'kg-00000000-0000-4000-8000-000000000000']) {
    const refused = await workshop.handoff({ sessionId })
    assert.equal(refused.response.status, 409, sessionId)
    assert.equal(refused.body.ok, false, sessionId)
  }
  assert.deepEqual(workshop.events(), [])
})

test('a saved value that is altered or missing refuses retention before any append', async (t) => {
  const workshop = await openWorkshop(t)
  const altered = contribute(workshop, { suffix: '1' })
  const selectedValue = workshop.savedValue(altered.reviewId, 'selected-save')
  const kept = fs.readFileSync(selectedValue, 'utf8')
  fs.rmSync(selectedValue)
  fs.writeFileSync(selectedValue, kept.replace('devday:workshop', 'devday:altered'))
  assert.notEqual(fs.readFileSync(selectedValue, 'utf8'), kept)
  const tampered = await workshop.handoff({ sessionId: altered.reviewId })
  assert.equal(tampered.response.status, 409)
  assert.equal(tampered.body.ok, false)

  fs.rmSync(selectedValue)
  const missing = await workshop.handoff({ sessionId: altered.reviewId })
  assert.equal(missing.response.status, 409)

  // The original contribution is read back from its own session too.
  const original = contribute(workshop, { suffix: '2' })
  const wordsValue = workshop.savedValue(original.participantId, 'words-save')
  const words = fs.readFileSync(wordsValue, 'utf8')
  fs.rmSync(wordsValue)
  fs.writeFileSync(wordsValue, words.replace('Keep my words exactly.', 'Words somebody else wrote.'))
  const foreign = await workshop.handoff({ sessionId: original.reviewId })
  assert.equal(foreign.response.status, 409)
  assert.equal(foreign.body.ok, false)
  assert.deepEqual(workshop.events(), [])
})

test('the handoff request keeps its nonce, origin and session-only body fences', async (t) => {
  const workshop = await openWorkshop(t)
  const { reviewId } = contribute(workshop)
  const withoutNonce = await postJson('/api/knowledge/workshop-handoff', { sessionId: reviewId }, workshop.base)
  assert.equal(withoutNonce.response.status, 403)
  const crossOrigin = await fetch(`${workshop.base}/api/knowledge/workshop-handoff`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://example.invalid', 'Sec-Fetch-Site': 'cross-site', 'X-Atelier-Nonce': workshop.nonce },
    body: JSON.stringify({ sessionId: reviewId }),
  })
  assert.equal(crossOrigin.status, 403)
  // A client cannot supply the path, the actor, the anchor, the read set or bytes.
  for (const extra of [{ path: 'index.html' }, { actor: 'Somebody else' }, { anchor: { quote: '[]' } }, { readSet: [] }, { proposal: { originalWords: 'Replaced' } }]) {
    const refused = await workshop.handoff({ sessionId: reviewId, ...extra })
    assert.equal(refused.response.status, 409, JSON.stringify(extra))
    assert.equal(refused.body.ok, false)
  }
  assert.deepEqual(workshop.events(), [])

  const accepted = await workshop.handoff({ sessionId: reviewId })
  assert.equal(accepted.body.retention.outcome, 'created')
  assert.equal(accepted.body.handoff.actor, 'Invented participant')
})

test('the generic proposal route keeps its published-HTML fence and cannot claim retention', async (t) => {
  const workshop = await openWorkshop(t)
  const { reviewId } = contribute(workshop)
  const markdown = await postJson('/api/proposals', {
    sessionId: reviewId,
    viewId: 'knowledge-workshop',
    path: 'records/checklist.md',
    action: 'copy.repoPath',
    proposal: { originalWords: 'Sent by a client' },
  }, workshop.base, workshop.nonce)
  assert.equal(markdown.body.ok, false)
  assert.match(markdown.body.error, /unknown workspace html file/)
  assert.deepEqual(workshop.events(), [])

  const receipt = { sessionId: reviewId, requestId: 'selected-save', valueDigest: sha256(SELECTED_DECLARATION) }
  const generic = await postJson('/api/proposals', {
    sessionId: reviewId,
    viewId: 'knowledge-workshop',
    path: 'index.html',
    action: 'copy.repoPath',
    retention: { kind: 'workshop-handoff', ...receipt, payloadDigest: 'a'.repeat(64) },
    proposal: { selectedDraftReceipt: receipt },
  }, workshop.base, workshop.nonce)
  assert.equal(generic.response.status, 200)
  assert.equal(generic.body.ok, true)
  const [stored] = workshop.events()
  assert.equal(Object.hasOwn(stored.payload.record, 'retention'), false, 'a client-supplied retention field is not stored')
  const read = await workshop.readProposal(generic.body.proposal.id)
  assert.equal(read.body.retention, undefined)
  assert.equal(read.body.payload, undefined)

  // The real handoff is still retained under its own identity, beside it.
  const retained = await workshop.handoff({ sessionId: reviewId })
  assert.equal(retained.body.retention.outcome, 'created')
  assert.notEqual(retained.body.retention.proposalId, generic.body.proposal.id)
  assert.equal(workshop.events().length, 2)
})

test('a retained proposal moves through the existing review route and stays copy-only', async (t) => {
  const workshop = await openWorkshop(t)
  const sourceBefore = fingerprint(workshop.source)
  const { reviewId } = contribute(workshop)
  const retained = await workshop.handoff({ sessionId: reviewId })
  const id = retained.body.retention.proposalId
  const premature = await postJson(`/api/proposals/${id}/review`, { status: 'accepted', reviewer: 'Invented source owner' }, workshop.base, workshop.nonce)
  assert.equal(premature.response.status, 409)
  const reviewed = await postJson(`/api/proposals/${id}/review`, { status: 'reviewed', reviewer: 'Invented source owner' }, workshop.base, workshop.nonce)
  assert.equal(reviewed.response.status, 200)
  const accepted = await postJson(`/api/proposals/${id}/review`, { status: 'accepted', reviewer: 'Invented source owner' }, workshop.base, workshop.nonce)
  assert.equal(accepted.response.status, 200)
  assert.equal(accepted.body.copyable.directWrite, false)
  assert.equal(accepted.body.copyable.applyEndpoint, null)
  assert.equal(accepted.body.copyable.targetPath, 'records/checklist.md')
  assert.equal(accepted.body.copyable.diff, JSON.stringify(retained.body.handoff.diff, null, 2))
  const read = await workshop.readProposal(id)
  assert.equal(read.body.proposal.status, 'accepted')
  assert.deepEqual(read.body.payload, retained.body.handoff.proposal, 'review keeps the retained evidence')
  assert.equal(read.body.retention.payloadDigest, retained.body.retention.payloadDigest)
  // The same request after review still finds the one proposal.
  const again = await workshop.handoff({ sessionId: reviewId })
  assert.equal(again.body.retention.outcome, 'existing')
  assert.equal(again.body.retention.proposalStatus, 'accepted')
  assert.deepEqual(workshop.events().map((event) => event.type), ['proposal-created', 'proposal-reviewed', 'proposal-reviewed'])
  assert.deepEqual(fingerprint(workshop.source), sourceBefore)
})

// The store on its own, with an invented handoff of the same shape.
function inventedHandoff(overrides = {}) {
  const receipt = {
    sessionId: 'kg-invented-review',
    requestId: 'selected-save',
    fieldId: 'authored-revision',
    sourceRef: 'records/checklist.md',
    sourceDigest: 'b'.repeat(64),
    valueDigest: sha256(SELECTED_DECLARATION),
  }
  return {
    sessionId: receipt.sessionId,
    viewId: 'knowledge-workshop',
    path: 'records/checklist.md',
    action: 'copy.repoPath',
    actor: 'Invented participant',
    intent: 'Source owner reviews one supporting declaration.',
    directWrite: false,
    applyEndpoint: null,
    diff: { source: { id: 'devday:checklist' }, anchor: { quote: '[]' }, replacement: SELECTED_DECLARATION },
    proposal: {
      directWrite: false,
      applyEndpoint: null,
      sourceEditsApplied: false,
      originalWords: ORIGINAL_WORDS,
      interpretation: '',
      choice: 'note',
      selectedDraftReceipt: receipt,
      savedDraftReceipts: [receipt],
    },
    ...overrides,
  }
}

function inventedStore(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mnstry-atelier-retention-store-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const ledger = path.join(root, '.atelier-proposals', 'events.ndjson')
  return { root, ledger, store: createProposalStore({ workspaceRoot: root }), bytes: () => (fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8') : '') }
}

test('another value or another handoff under the same original receipt is refused, and the first stays readable', (t) => {
  const { store, bytes } = inventedStore(t)
  const handoff = inventedHandoff()
  const receipt = handoff.proposal.selectedDraftReceipt
  assert.equal(store.lookupRetainedProposal(receipt).outcome, 'not-found')
  const created = store.retainProposal(handoff)
  assert.equal(created.ok, true, created.error)
  assert.equal(created.outcome, 'created')
  const kept = bytes()

  const same = store.retainProposal(inventedHandoff())
  assert.equal(same.outcome, 'existing')
  assert.equal(same.record.proposal.id, created.record.proposal.id)

  const otherPayload = store.retainProposal(inventedHandoff({ intent: 'Another intent under the same receipt.' }))
  assert.equal(otherPayload.ok, false)
  assert.equal(otherPayload.status, 409)
  assert.equal(otherPayload.outcome, 'conflict')

  const otherReceipt = { ...receipt, valueDigest: sha256('["devday:other"]') }
  const base = inventedHandoff()
  const otherValue = store.retainProposal({ ...base, proposal: { ...base.proposal, selectedDraftReceipt: otherReceipt } })
  assert.equal(otherValue.ok, false)
  assert.equal(otherValue.outcome, 'conflict')
  assert.equal(store.lookupRetainedProposal(otherReceipt).outcome, 'conflict')

  assert.equal(bytes(), kept, 'no refusal appended anything')
  const found = store.lookupRetainedProposal(receipt)
  assert.equal(found.outcome, 'retained')
  assert.deepEqual(store.retainedHandoff(found.record), handoff)
  assert.equal(store.readProposal(created.record.proposal.id).record.payload.originalWords, ORIGINAL_WORDS)
  assert.equal(store.listProposals().proposals.length, 1)
})

test('a handoff that cannot be kept whole is refused, never shortened', (t) => {
  const { store, bytes } = inventedStore(t)
  const base = inventedHandoff()
  const refusals = [
    [{ intent: 'x'.repeat(501) }, 413],
    [{ actor: ' Invented participant' }, 413],
    [{ path: '' }, 413],
    [{ diff: { ...base.diff, replacement: 'x'.repeat(50001) } }, 413],
    [{ proposal: { ...base.proposal, originalWords: 'x'.repeat(300 * 1024) } }, 413],
    [{ directWrite: true }, 409],
    [{ applyEndpoint: '/api/apply' }, 409],
    [{ proposal: { ...base.proposal, selectedDraftReceipt: { sessionId: base.sessionId, requestId: 'selected-save' } } }, 422],
    [{ proposal: { ...base.proposal, selectedDraftReceipt: { ...base.proposal.selectedDraftReceipt, sessionId: 'kg-another-session' } } }, 422],
    [{ diff: 'not an object' }, 422],
  ]
  for (const [overrides, status] of refusals) {
    const refused = store.retainProposal(inventedHandoff(overrides))
    assert.equal(refused.ok, false, JSON.stringify(Object.keys(overrides)))
    assert.equal(refused.status, status, JSON.stringify(Object.keys(overrides)))
    assert.equal(refused.outcome, 'refused', JSON.stringify(Object.keys(overrides)))
  }
  assert.equal(bytes(), '')
  assert.equal(store.lookupRetainedProposal(base.proposal.selectedDraftReceipt).outcome, 'not-found')
  assert.equal(store.lookupRetainedProposal({ sessionId: base.sessionId }).outcome, 'refused')
})

test('a ledger that cannot be read leaves the outcome unknown and appends nothing', (t) => {
  const { store, ledger, bytes } = inventedStore(t)
  const handoff = inventedHandoff()
  assert.equal(store.retainProposal(handoff).outcome, 'created')
  // Damage in the middle of the ledger, not a torn final line.
  fs.writeFileSync(ledger, `not a ledger line\n${bytes()}`)
  const damaged = bytes()
  const lookup = store.lookupRetainedProposal(handoff.proposal.selectedDraftReceipt)
  assert.equal(lookup.ok, false)
  assert.equal(lookup.outcome, 'unknown')
  const retried = store.retainProposal(handoff)
  assert.equal(retried.ok, false)
  assert.equal(retried.outcome, 'unknown')
  assert.equal(bytes(), damaged, 'an unknown outcome is not an absence: nothing is appended')
})

test('a snapshot without a ledger record is not a retained outcome', (t) => {
  const { store, ledger, bytes } = inventedStore(t)
  const handoff = inventedHandoff()
  const created = store.retainProposal(handoff)
  assert.equal(created.outcome, 'created')
  assert.equal(fs.existsSync(store.proposalPath(created.record.proposal.id)), true)
  fs.rmSync(ledger)
  const lookup = store.lookupRetainedProposal(handoff.proposal.selectedDraftReceipt)
  assert.equal(lookup.outcome, 'unknown')
  const retried = store.retainProposal(handoff)
  assert.equal(retried.ok, false)
  assert.equal(retried.outcome, 'unknown')
  assert.equal(bytes(), '')
})
