import fs from 'node:fs'
import path from 'node:path'
import { REPOSITORY_ROOT, isoNow, readJson, sha256Digest, writeJson } from './common.mjs'
import { materializeFixtureWorkspace } from './derive.mjs'
import { evidenceFileName } from './receipts.mjs'
import { digestDifferences, fileDigest, initialiseRepositories, noteFile, openEdits, privateStateSnapshot, sourceDigests } from './service-world.mjs'

// AP-05 (G17): editing and agentic application, against two isolated
// instances that hold the full and the scoped vault of one workspace. Every
// edit is typed into the app (real input through CDP in production; the test
// suite writes the same bytes into the vault file), every decision is read
// through the shipped command (`apply`, `conflicts`, `apply-policy`, `mode`,
// `proposals`) and every step records the wall clock, the raw answer and the
// digests of every source before and after.
//
//   multi-vault    the same canonical object edited in both vaults: identical
//                  edits coalesce into one operation, divergent edits stay
//                  preserved and conflicted
//   manual         in manual mode N ticks write no source; one explicit apply
//                  changes exactly the source it names, exactly as typed
//   automatic      a scoped automatic policy installed through the phase-1
//                  setup and enabled through `mode set`; an eligible edit is
//                  applied on a tick with nobody asked; out-of-scope, stale,
//                  unsupported, conflicting and post-revocation edits stay
//                  pending; a stop and start between journal steps replays
//                  the same pending set
//   retention      a structural edit is followed into the repository's
//                  copy-only proposal store with the source unchanged; the
//                  integration is disabled and the service stopped, and the
//                  typed bytes in the vaults and the preserved objects remain
//
// Nothing here writes a source file itself: only `apply run` and the engine's
// automatic dispatch under the installed policy do, and each is recorded.

export const AP05_SCOPES = Object.freeze({ full: 'scope-full', scoped: 'scope-harbor' })
export const AP05_SCOPE_DOCUMENTS = Object.freeze([
  Object.freeze({ scopeId: AP05_SCOPES.full, mode: 'full', selector: Object.freeze({ all: true }) }),
  Object.freeze({ scopeId: AP05_SCOPES.scoped, mode: 'scoped', selector: Object.freeze({ ids: Object.freeze(['north-desk:harbor-plan', 'south-desk:tide-table']) }) }),
])
export const AP05_EXTRA_NOTES = path.join(REPOSITORY_ROOT, 'fixtures', 'obsidian', 'acceptance', 'ap05-extra-notes.json')
// The objects each step edits. The identical edit needs a note whose bytes
// are the same in both vaults (the tide table links only to a note both views
// hold); the divergent one is the harbor plan, whose rewritten links differ
// by view anyway. A structural edit is a link to a file of the vault, so its
// text names the published note of the tide table, resolved at run time.
export const AP05_EDITS = Object.freeze({
  identical: Object.freeze({ nodeId: 'south-desk:tide-table', repoId: 'south-desk', source: 'tables/tide-table.md', anchor: '# Tide table', text: ' (identical line typed in both vaults)' }),
  divergent: Object.freeze({ nodeId: 'north-desk:harbor-plan', repoId: 'north-desk', source: 'plans/harbor-plan.md', anchor: 'byte offsets and character offsets differ.', texts: Object.freeze({ full: ' Typed in the full vault.', scoped: ' Typed in the scoped vault.' }) }),
  eligible: Object.freeze({ nodeId: 'north-desk:shared-b', repoId: 'north-desk', source: 'plans/shared-b.md', anchor: 'Second note with the same title', text: ' (applied automatically)' }),
  outOfScope: Object.freeze({ nodeId: 'north-desk:shared-a', repoId: 'north-desk', source: 'plans/shared-a.md', anchor: 'First of two notes with one title.', text: ' Outside the policy selection.' }),
  stale: Object.freeze({ nodeId: 'north-desk:quay-notes', repoId: 'north-desk', source: 'plans/quay-notes.md', anchor: 'Moorings are checked at first light.', text: ' Typed before the source moved.' }),
  structural: Object.freeze({ nodeId: 'north-desk:lantern-log', repoId: 'north-desk', source: 'plans/lantern-log.md', anchor: 'checked twice.', text: ' See [[{{note:south-desk:tide-table}}]].', linksTo: 'south-desk:tide-table' }),
  revoked: Object.freeze({ nodeId: 'north-desk:shared-b', repoId: 'north-desk', source: 'plans/shared-b.md', anchor: '(applied automatically)', text: ' Typed after the revocation.' }),
})
export const AP05_POLICY_ID = 'pol-ap05-scoped-automatic'

// The AP-05 workspace: the materialization fixture plus the two extra notes,
// with each repository a real git repository that ignores the proposal store.
export function prepareAp05Workspace(workspaceDir, { materialize = materializeFixtureWorkspace, initialise = initialiseRepositories, extraNotes = AP05_EXTRA_NOTES } = {}) {
  const fixture = materialize(workspaceDir, { scopes: AP05_SCOPE_DOCUMENTS.map((scope) => ({ ...scope, selector: { ...scope.selector, ...(scope.selector.ids ? { ids: [...scope.selector.ids] } : {}) } })) })
  const extra = readJson(extraNotes)
  for (const [relative, file] of Object.entries(extra.files)) {
    const absolute = path.join(workspaceDir, relative)
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, Buffer.from(file.text, 'utf8'))
  }
  initialise(fixture.repositories.map((repoId) => path.join(workspaceDir, repoId)))
  return { ...fixture, extraNotes: Object.keys(extra.files) }
}

const text = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
const tickSummary = (answer) => ({ requested: answer.requested, state: answer.state, reason: answer.reason ?? null, tick: answer.tick ? { ok: answer.tick.ok, state: answer.tick.state, scopes: answer.tick.scopes ?? [], dispatched: answer.tick.dispatched ?? null } : null })
const commandRecord = ({ argv, exit, json, startedAt, endedAt }) => ({ argv, exit, startedAt, endedAt, answer: json })
const insertAfter = (bytes, anchor, inserted) => {
  const source = bytes.toString('utf8')
  const at = source.indexOf(anchor)
  if (at < 0) return null
  const end = at + anchor.length
  return Buffer.from(source.slice(0, end) + inserted + source.slice(end), 'utf8')
}

export async function runAp05({ world, views, runtime, command, operator, now = Date.now, clock = isoNow, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), manualTicks = 3, edits = AP05_EDITS }) {
  const steps = {}
  const failures = []
  const check = (step, condition, message) => { if (!condition) failures.push(`${step}: ${message}`); return condition }
  const sourceFile = (edit) => path.join(world.repositories.find((repo) => repo.repoId === edit.repoId).path, ...edit.source.split('/'))
  const scopeIds = Object.values(AP05_SCOPES)
  const run = async (...argv) => commandRecord(await command(...argv))
  const tick = async () => tickSummary(await runtime.tick())
  const notePathOf = (scopeId, nodeId) => world.manifestFor(scopeId)?.notes.find((note) => note.nodeId === nodeId)?.path ?? null
  // `{{note:ID}}` in a text is the published note of that object, without its extension: what a wiki link names.
  const resolveText = (view, value) => value.replace(/\{\{note:([^}]+)\}\}/g, (_match, nodeId) => { const notePath = notePathOf(view.scopeId, nodeId); return notePath === null ? nodeId : path.posix.basename(notePath, '.md') })
  const type = async (view, edit, rawText) => {
    const textToType = resolveText(view, rawText)
    const notePath = notePathOf(view.scopeId, edit.nodeId)
    if (!check('typing', notePath !== null, `${view.scopeId} holds no note for ${edit.nodeId}`)) return { scopeId: view.scopeId, nodeId: edit.nodeId, notePath: null, text: textToType, skipped: 'note-not-in-view' }
    return { scopeId: view.scopeId, nodeId: edit.nodeId, ...(await view.editor.typeAt({ notePath, anchor: edit.anchor, text: textToType })) }
  }
  const listEdits = async () => { const answer = await run('apply', 'list'); return { record: answer, edits: answer.answer?.edits ?? [] } }
  const conflicts = async () => { const answer = await run('conflicts'); return { record: answer, objects: answer.answer?.objects ?? [] } }
  const objectOf = (view, nodeId) => view.objects.find((object) => object.nodeId === nodeId) ?? null
  const editsOf = (list, nodeId, state = null) => list.edits.filter((edit) => edit.nodeId === nodeId && (state === null || edit.state === state))
  const typedText = []
  const vaultHolds = () => typedText.map(({ scopeId, notePath, text: typed }) => ({ scopeId, notePath, present: notePath !== null && fs.existsSync(noteFile(world.vaultRootFor(scopeId), notePath)) && fs.readFileSync(noteFile(world.vaultRootFor(scopeId), notePath), 'utf8').includes(typed) }))
  const remember = (trace) => { if (trace.notePath !== null) typedText.push({ scopeId: trace.scopeId, notePath: trace.notePath, text: trace.text }); return trace }

  // Baseline.
  const baseline = { startedAt: clock() }
  baseline.start = await runtime.start()
  check('baseline', baseline.start.state === 'healthy', `the service did not start healthy (${baseline.start.state})`)
  baseline.tick = await tick()
  baseline.mode = await run('mode', 'show')
  check('baseline', baseline.mode.answer?.maintenanceMode === 'manual', 'the baseline mode is not manual')
  baseline.notes = Object.fromEntries(scopeIds.map((scopeId) => [scopeId, world.manifestFor(scopeId)?.notes.map(({ nodeId, path: notePath }) => ({ nodeId, path: notePath })) ?? null]))
  for (const scopeId of scopeIds) check('baseline', Array.isArray(baseline.notes[scopeId]) && baseline.notes[scopeId].length > 0, `${scopeId} published no note`)
  baseline.sources = sourceDigests(world)
  baseline.endedAt = clock()
  steps.baseline = baseline

  // 1. The same canonical object in both vaults.
  const multi = { startedAt: clock() }
  multi.identical = { edit: edits.identical, typed: [remember(await type(views.full, edits.identical, edits.identical.text)), remember(await type(views.scoped, edits.identical, edits.identical.text))] }
  multi.identical.tick = await tick()
  multi.identical.edits = await listEdits()
  multi.identical.conflicts = await conflicts()
  const coalesced = objectOf(multi.identical.conflicts, edits.identical.nodeId)
  multi.identical.object = coalesced
  check('multi-vault', editsOf(multi.identical.edits, edits.identical.nodeId).length === 2, 'the identical edit was not queued once per vault')
  check('multi-vault', coalesced?.state === 'pending' && coalesced.operations.length === 1 && coalesced.pendingEdits.length === 2, `identical edits did not coalesce into one pending operation (${JSON.stringify(coalesced && { state: coalesced.state, operations: coalesced.operations.length, pendingEdits: coalesced.pendingEdits.length })})`)
  multi.divergent = { edit: edits.divergent, typed: [remember(await type(views.full, edits.divergent, edits.divergent.texts.full)), remember(await type(views.scoped, edits.divergent, edits.divergent.texts.scoped))] }
  multi.divergent.tick = await tick()
  multi.divergent.edits = await listEdits()
  multi.divergent.conflicts = await conflicts()
  const contested = objectOf(multi.divergent.conflicts, edits.divergent.nodeId)
  multi.divergent.object = contested
  check('multi-vault', editsOf(multi.divergent.edits, edits.divergent.nodeId).length === 2 && editsOf(multi.divergent.edits, edits.divergent.nodeId).every((edit) => edit.object?.state === 'conflicted'), 'the divergent edits are not both preserved and open against a conflicted object')
  check('multi-vault', contested?.state === 'conflicted' && contested.conflictedOperations.length === 2 && contested.needsPerson === true, `divergent edits are not conflicted with two operations (${JSON.stringify(contested && { state: contested.state, conflicted: contested.conflictedOperations.length })})`)
  multi.vaultHolds = vaultHolds()
  check('multi-vault', multi.vaultHolds.every((item) => item.present), 'a typed edit is no longer in its vault after the ticks')
  multi.sources = { unchanged: digestDifferences(baseline.sources, sourceDigests(world)).length === 0 }
  check('multi-vault', multi.sources.unchanged, 'a source changed while edits were only observed')
  multi.endedAt = clock()
  steps['multi-vault'] = multi

  // 2. Manual mode: ticks write no source; one explicit apply changes exactly one source, exactly as typed.
  const manual = { startedAt: clock(), ticks: [] }
  const before = sourceDigests(world)
  for (let index = 0; index < manualTicks; index += 1) {
    const answer = await tick()
    const after = sourceDigests(world)
    manual.ticks.push({ tick: answer, sourceChanges: digestDifferences(before, after) })
  }
  check('manual', manual.ticks.every((item) => item.sourceChanges.length === 0), 'a tick in manual mode changed a source')
  const applicable = editsOf(multi.identical.edits, edits.identical.nodeId).find((edit) => edit.scopeId === views.full.scopeId) ?? null
  manual.editId = applicable?.editId ?? null
  const targetFile = sourceFile(edits.identical)
  const oldBytes = fs.readFileSync(targetFile)
  manual.before = { sourceDigest: sha256Digest(oldBytes), expectedDigest: insertAfter(oldBytes, edits.identical.anchor, edits.identical.text) === null ? null : sha256Digest(insertAfter(oldBytes, edits.identical.anchor, edits.identical.text)) }
  manual.show = manual.editId ? await run('apply', 'show', manual.editId) : null
  manual.apply = manual.editId ? await run('apply', 'run', manual.editId, '--actor', operator) : null
  const newBytes = fs.readFileSync(targetFile)
  manual.after = { sourceDigest: sha256Digest(newBytes), exactlyAsTyped: manual.before.expectedDigest !== null && sha256Digest(newBytes) === manual.before.expectedDigest, otherSourceChanges: digestDifferences(before, sourceDigests(world)).filter((item) => item.key !== `${edits.identical.repoId}/${edits.identical.source}`) }
  check('manual', manual.apply?.answer?.result?.status === 'applied', `the explicit apply did not apply (${JSON.stringify(manual.apply?.answer?.result ?? manual.apply?.answer?.error ?? null)})`)
  check('manual', manual.after.exactlyAsTyped, 'the applied source is not the old source with the typed text after the anchor')
  check('manual', manual.after.otherSourceChanges.length === 0, 'the explicit apply changed another source')
  manual.tickAfterApply = await tick()
  manual.editsAfterApply = await listEdits()
  manual.conflictsAfterApply = await conflicts()
  manual.appliedObject = objectOf(manual.conflictsAfterApply, edits.identical.nodeId)
  manual.endedAt = clock()
  steps.manual = manual

  // 3. Automatic mode under a scoped policy.
  const automatic = { startedAt: clock() }
  const requestFile = path.join(world.dataRoot, 'ap05-policy-request.json')
  const request = { policyId: AP05_POLICY_ID, mode: 'automatic', actor: { kind: 'agent', id: operator }, selector: { ids: [...new Set([edits.eligible.nodeId, edits.revoked.nodeId])] }, maxBatchSize: 10, retryBudget: 0 }
  writeJson(requestFile, request)
  automatic.policy = { request, create: await run('apply-policy', 'create', requestFile), show: await run('apply-policy', 'show') }
  check('automatic', automatic.policy.create.answer?.installed === true && automatic.policy.create.answer.policy?.mode === 'automatic' && automatic.policy.create.answer.policy.status === 'active', 'the scoped automatic policy was not installed')
  automatic.modeSet = await run('mode', 'set', 'automatic')
  check('automatic', automatic.modeSet.answer?.maintenanceMode === 'automatic', 'the mode could not be set to automatic')
  automatic.authorization = (await run('apply-policy', 'show')).answer?.automaticApply ?? null
  check('automatic', automatic.authorization?.authorized === true, `automatic apply is not authorized (${automatic.authorization?.reason})`)

  const eligibleFile = sourceFile(edits.eligible)
  const eligibleBefore = fs.readFileSync(eligibleFile)
  automatic.eligible = { edit: edits.eligible, typed: remember(await type(views.full, edits.eligible, edits.eligible.text)), before: { sourceDigest: sha256Digest(eligibleBefore), expectedDigest: insertAfter(eligibleBefore, edits.eligible.anchor, edits.eligible.text) === null ? null : sha256Digest(insertAfter(eligibleBefore, edits.eligible.anchor, edits.eligible.text)) } }
  automatic.eligible.tick = await tick()
  const eligibleAfter = fs.readFileSync(eligibleFile)
  automatic.eligible.after = { sourceDigest: sha256Digest(eligibleAfter), exactlyAsTyped: sha256Digest(eligibleAfter) === automatic.eligible.before.expectedDigest, dispatched: automatic.eligible.tick.tick?.dispatched ?? null }
  automatic.eligible.edits = await listEdits()
  automatic.eligible.prompt = 'none: the tick is a loopback request answered by the service; no stdin was read and no question was asked'
  check('automatic', automatic.eligible.after.exactlyAsTyped, `the eligible edit was not applied exactly on the tick (${JSON.stringify(automatic.eligible.after.dispatched)})`)
  check('automatic', editsOf(automatic.eligible.edits, edits.eligible.nodeId).length === 0, 'the applied edit is still open')

  const pendingKinds = {}
  automatic.outOfScope = { edit: edits.outOfScope, typed: remember(await type(views.full, edits.outOfScope, edits.outOfScope.text)), before: fileDigest(sourceFile(edits.outOfScope)) }
  automatic.outOfScope.tick = await tick()
  automatic.outOfScope.after = fileDigest(sourceFile(edits.outOfScope))
  automatic.outOfScope.edits = await listEdits()
  pendingKinds.outOfScope = editsOf(automatic.outOfScope.edits, edits.outOfScope.nodeId)
  check('automatic', automatic.outOfScope.before === automatic.outOfScope.after && pendingKinds.outOfScope.length === 1 && pendingKinds.outOfScope[0].lastCode === 'outside-policy-selection', `the out-of-scope edit did not stay pending as outside-policy-selection (${JSON.stringify(pendingKinds.outOfScope.map((edit) => [edit.state, edit.lastCode]))})`)

  const staleFile = sourceFile(edits.stale)
  automatic.stale = { edit: edits.stale, typed: remember(await type(views.full, edits.stale, edits.stale.text)) }
  fs.appendFileSync(staleFile, `\nSource moved under the edit at ${clock()}.\n`)
  automatic.stale.sourceMovedAt = clock()
  automatic.stale.before = fileDigest(staleFile)
  automatic.stale.tick = await tick()
  automatic.stale.after = fileDigest(staleFile)
  automatic.stale.edits = await listEdits()
  automatic.stale.conflicts = await conflicts()
  pendingKinds.stale = editsOf(automatic.stale.edits, edits.stale.nodeId)
  automatic.stale.object = objectOf(automatic.stale.conflicts, edits.stale.nodeId)
  check('automatic', automatic.stale.before === automatic.stale.after && pendingKinds.stale.length === 1 && pendingKinds.stale[0].lastCode === 'stale-source' && pendingKinds.stale[0].object?.state === 'conflicted', `the stale edit did not stay pending as stale-source on a conflicted object (${JSON.stringify(pendingKinds.stale.map((edit) => [edit.state, edit.lastCode, edit.object?.state]))})`)

  const structuralFile = sourceFile(edits.structural)
  automatic.unsupported = { edit: edits.structural, typed: remember(await type(views.full, edits.structural, edits.structural.text)), before: fileDigest(structuralFile) }
  automatic.unsupported.tick = await tick()
  automatic.unsupported.after = fileDigest(structuralFile)
  automatic.unsupported.edits = await listEdits()
  automatic.unsupported.conflicts = await conflicts()
  pendingKinds.unsupported = editsOf(automatic.unsupported.edits, edits.structural.nodeId)
  automatic.unsupported.object = objectOf(automatic.unsupported.conflicts, edits.structural.nodeId)
  check('automatic', automatic.unsupported.before === automatic.unsupported.after && pendingKinds.unsupported.length === 1 && pendingKinds.unsupported[0].object?.operations.some((operation) => operation.kind === 'semantic-proposal' && operation.state === 'proposed'), `the structural edit did not stay pending as a proposed semantic proposal (${JSON.stringify(pendingKinds.unsupported.map((edit) => [edit.state, edit.lastCode, edit.object?.operations]))})`)

  pendingKinds.conflicting = editsOf(automatic.unsupported.edits, edits.divergent.nodeId)
  automatic.conflicting = { nodeId: edits.divergent.nodeId, edits: pendingKinds.conflicting, object: objectOf(automatic.unsupported.conflicts, edits.divergent.nodeId), sourceDigest: fileDigest(sourceFile(edits.divergent)), unchangedSinceBaseline: baseline.sources[`${edits.divergent.repoId}/${edits.divergent.source}`] === fileDigest(sourceFile(edits.divergent)) }
  check('automatic', pendingKinds.conflicting.length === 2 && automatic.conflicting.object?.state === 'conflicted' && automatic.conflicting.unchangedSinceBaseline, 'the conflicting edits did not stay pending with their source untouched')

  // Stop and start between journal steps: the pending set replays unchanged and no source moves.
  const restart = { stop: await runtime.stop(), beforeSnapshot: privateStateSnapshot(world, scopeIds), beforeSources: sourceDigests(world) }
  check('automatic', restart.stop.stopped === true, 'the service was not stopped between journal steps')
  restart.start = await runtime.start()
  restart.tick = await tick()
  restart.afterSnapshot = privateStateSnapshot(world, scopeIds)
  restart.edits = await listEdits()
  const key = (snapshot) => JSON.stringify(openEdits(snapshot).map(({ editId, state, objectRef, lastCode }) => [editId, state, objectRef, lastCode]).sort())
  restart.idempotent = { sameOpenEdits: key(restart.beforeSnapshot) === key(restart.afterSnapshot), sourceChanges: digestDifferences(restart.beforeSources, sourceDigests(world)), journalsRetained: scopeIds.every((scopeId) => restart.beforeSnapshot.journals[scopeId].every((entry) => restart.afterSnapshot.journals[scopeId].some((item) => item.journalId === entry.journalId))), objectsPresent: restart.afterSnapshot.retainedObjects.every((item) => item.present) }
  check('automatic', restart.start.state === 'healthy' && restart.idempotent.sameOpenEdits && restart.idempotent.sourceChanges.length === 0 && restart.idempotent.journalsRetained && restart.idempotent.objectsPresent, `the restart did not replay idempotently (${JSON.stringify({ ...restart.idempotent, sourceChanges: restart.idempotent.sourceChanges.length })})`)
  automatic.restart = restart

  automatic.revocation = { revoke: await run('apply-policy', 'revoke'), mode: await run('mode', 'show') }
  check('automatic', automatic.revocation.revoke.answer?.revoked === true && automatic.revocation.mode.answer?.maintenanceMode === 'manual', 'the revocation did not take the mode back to manual')
  const revokedFile = sourceFile(edits.revoked)
  automatic.revoked = { edit: edits.revoked, typed: remember(await type(views.full, edits.revoked, edits.revoked.text)), before: fileDigest(revokedFile) }
  automatic.revoked.tick = await tick()
  automatic.revoked.after = fileDigest(revokedFile)
  automatic.revoked.edits = await listEdits()
  pendingKinds.revoked = editsOf(automatic.revoked.edits, edits.revoked.nodeId)
  check('automatic', automatic.revoked.before === automatic.revoked.after && pendingKinds.revoked.length === 1 && pendingKinds.revoked[0].state === 'queued', `the edit after revocation did not stay queued (${JSON.stringify(pendingKinds.revoked.map((edit) => [edit.state, edit.lastCode]))})`)
  automatic.pendingSummary = Object.fromEntries(Object.entries(pendingKinds).map(([kind, list]) => [kind, list.map(({ editId, scopeId, state, lastCode, object }) => ({ editId, scopeId, state, lastCode, objectState: object?.state ?? null }))]))
  automatic.endedAt = clock()
  steps.automatic = automatic

  // 4. Proposal store, then disable and stop: vault edits and preserved bytes remain.
  const retention = { startedAt: clock() }
  retention.proposals = await run('proposals', 'list')
  const repoStatus = retention.proposals.answer?.status?.repositories?.find((item) => item.repoId === edits.structural.repoId) ?? null
  const routed = (retention.proposals.answer?.operations ?? []).filter((operation) => operation.nodeId === edits.structural.nodeId || operation.identity?.nodeId === edits.structural.nodeId)
  retention.routed = { repository: repoStatus, operations: routed }
  const ledger = path.join(world.repositories.find((repo) => repo.repoId === edits.structural.repoId).path, '.atelier-proposals', 'events.ndjson')
  retention.ledger = { path: ledger, exists: fs.existsSync(ledger), digest: fileDigest(ledger), lines: fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).length : 0 }
  retention.shown = routed.length > 0 && routed[0].adapterOperationId ? await run('proposals', 'show', routed[0].adapterOperationId) : null
  retention.structuralSource = { digest: fileDigest(structuralFile), unchangedSinceTyped: fileDigest(structuralFile) === automatic.unsupported.before }
  check('retention', repoStatus !== null && (repoStatus.queued + repoStatus.submitted + repoStatus.acknowledged + repoStatus.backpressure) >= 1, `no proposal reached the ${edits.structural.repoId} store (${JSON.stringify(repoStatus)})`)
  check('retention', retention.ledger.exists && retention.ledger.lines >= 1, 'the copy-only proposal ledger holds no event')
  check('retention', retention.structuralSource.unchangedSinceTyped, 'the source changed on the way into the proposal store')

  const projectDocument = JSON.parse(fs.readFileSync(world.projectFile, 'utf8'))
  const extKey = Object.keys(projectDocument.ext ?? {}).find((name) => name.endsWith('.obsidian')) ?? 'mnstry.atelier.obsidian'
  projectDocument.ext[extKey].enabled = false
  writeJson(world.projectFile, projectDocument)
  retention.disable = { at: clock(), tick: await tick(), status: await run('status') }
  check('retention', retention.disable.tick.tick?.state === 'disabled' || retention.disable.status.answer?.enablement?.state === 'disabled', `the integration did not report disabled (${retention.disable.tick.tick?.state})`)
  retention.uninstall = { stop: await runtime.stop(), serviceStatus: await runtime.status() }
  check('retention', retention.uninstall.stop.stopped === true, 'the service was not stopped at uninstall')
  const finalSnapshot = privateStateSnapshot(world, scopeIds)
  retention.retained = { vaultHolds: vaultHolds(), recoveryObjects: finalSnapshot.retainedObjects, openEdits: openEdits(finalSnapshot).length, journals: finalSnapshot.journals }
  check('retention', retention.retained.vaultHolds.every((item) => item.present), 'a typed edit is gone from its vault after disable and uninstall')
  check('retention', retention.retained.recoveryObjects.length > 0 && retention.retained.recoveryObjects.every((item) => item.present), 'a preserved recovery object is gone after disable and uninstall')
  retention.finalSources = sourceDigests(world)
  retention.sourceChangesSinceBaseline = digestDifferences(baseline.sources, retention.finalSources)
  retention.endedAt = clock()
  steps.retention = retention

  const host = { recordedAt: clock(), operator, baselineSources: baseline.sources, finalSources: retention.finalSources }
  const evidence = [
    { role: 'multi-vault-edit-trace', name: evidenceFileName('G17', 'multi-vault-edit-trace', 'json'), bytes: text({ step: steps['multi-vault'], baseline: steps.baseline, host }) },
    { role: 'manual-apply-trace', name: evidenceFileName('G17', 'manual-apply-trace', 'json'), bytes: text({ step: steps.manual, host }) },
    { role: 'automatic-apply-trace', name: evidenceFileName('G17', 'automatic-apply-trace', 'json'), bytes: text({ step: steps.automatic, host }) },
    { role: 'uninstall-retention', name: evidenceFileName('G17', 'uninstall-retention', 'json'), bytes: text({ step: steps.retention, host }) },
    { role: null, name: 'G17-command-log.json', bytes: text(command.calls ?? []) },
  ]
  return { steps, evidence, failures, passed: failures.length === 0, timings: { manualTicks, sourceChangesSinceBaseline: retention.sourceChangesSinceBaseline.map((item) => item.key) } }
}
