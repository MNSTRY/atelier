import fs from 'node:fs'
import path from 'node:path'
import { acquirePrivateLock, syncPrivateDirectory } from '../../../project/durable-state.mjs'
import { journalDetail, listJournals } from './journal.mjs'
import { readFileBytes, readFileDigest, refuse, sha256Digest } from './store.mjs'

// Restart recovery. Every decision here is made from what is on disk, never
// from what a lost reply might have said, and every action is a move, a
// non-overwriting link, the removal of a file proven to be our own candidate,
// or an appended journal entry. Running it again changes nothing.
//
// Interrupted states of one note, identified by its write-ahead `capture`
// entry (base, candidate, staged path, recovery path) with no outcome entry:
//
//   staged file == candidate            nothing was exchanged. The candidate is
//                                       retired; the note is as it was.
//   staged file present, != candidate   the exchange happened and the move to
//                                       recovery did not: the staged path holds
//                                       the displaced bytes. They are moved to
//                                       the recovery path and compared with base.
//   staged absent, recovery present     exchange and move both happened.
//   neither                             nothing happened.
//
// For the whole journal: a pointer that already names this journal gets its
// missing `manifest-commit` entry; a journal that reached `verifying` with
// every note settled commits its stored manifest; anything else is left as
// `updating` for the next publication to converge, with the digests it did
// publish still trusted as bases.

const exists = (file) => { try { fs.lstatSync(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }

// A staged path is never unlinked in place: between a digest check and an
// unlink, a late exchange could put displaced bytes there. It is first moved
// to a private name, which no payload refers to, and only then judged.
export function retireStagedFile({ stagedPath, candidateDigest, fallbackPath }) {
  if (!exists(stagedPath)) return { retired: false }
  const retired = `${stagedPath}.retired`
  fs.renameSync(stagedPath, retired)
  if (readFileDigest(retired) === candidateDigest) {
    fs.unlinkSync(retired)
    return { retired: true }
  }
  fs.renameSync(retired, fallbackPath)
  syncPrivateDirectory(path.dirname(fallbackPath))
  return { retired: false, capturedPath: fallbackPath }
}

function freeName(store, journalId, unit) {
  for (let index = 0; ; index += 1) {
    const candidate = store.displacedPath(journalId, unit, index === 0 ? 'displaced.bin' : `displaced-${index}.bin`)
    if (!exists(candidate)) return candidate
  }
}

// `digestAtMove` is the digest taken inside the critical section, right after
// the move, when the caller has it. A holder of the old file may already have
// written into it by the time this process reads it; that difference is left
// for the late-writer check to report.
export function recordDisplaced({ store, journalId, unit, notePath, displacedPath, baseDigest, at, digestAtMove: observedAtMove = null }) {
  const bytes = readFileBytes(displacedPath)
  const digestAtMove = observedAtMove ?? sha256Digest(bytes)
  const externalCaptured = digestAtMove !== baseDigest
  // The displaced file stays where it is. Bytes that are not the known base get an immutable copy as well.
  const object = sha256Digest(bytes) !== baseDigest ? store.retainObject(bytes) : null
  store.writeReceipt(journalId, unit, { role: 'displaced', notePath, displacedRef: store.ref(displacedPath), digestAtMove, baseDigest, externalCaptured, ...(object ? { objectRef: object.ref } : {}), at })
  return { digestAtMove, externalCaptured, displacedRef: store.ref(displacedPath) }
}

// Settles one note whose outcome is unknown. Returns the entry to append.
export function reconcileUnit({ store, journalId, capture, at }) {
  const detail = journalDetail(capture)
  const { unit, op } = detail
  const notePath = capture.notePath
  const note = path.join(store.vaultRoot, notePath)
  const base = capture.beforeDigest ?? null
  const candidate = capture.afterDigest ?? null
  const staged = detail.stagedRef ? store.resolve(detail.stagedRef) : null
  const displaced = capture.recoveryRef ? store.resolve(capture.recoveryRef) : null
  const settle = (outcome, code, extra = {}) => ({ step: 'conditional-update', outcome, notePath, ...(base ? { beforeDigest: base } : {}), ...(outcome === 'ok' && candidate ? { afterDigest: candidate } : {}),
    ...(extra.recoveryRef ? { recoveryRef: extra.recoveryRef } : {}), detail: { unit, op, kind: detail.kind, code, reconciled: true, ...(extra.externalCaptured ? { externalCaptured: true } : {}) } })

  if (op === 'replace') {
    const stagedDigest = staged ? readFileDigest(staged) : null
    if (stagedDigest !== null && stagedDigest === candidate) {
      retireStagedFile({ stagedPath: staged, candidateDigest: candidate, fallbackPath: freeName(store, journalId, unit) })
      return settle('skipped', 'interrupted-before-exchange')
    }
    if (stagedDigest !== null) {
      const target = exists(displaced) ? freeName(store, journalId, unit) : displaced
      fs.renameSync(staged, target)
      syncPrivateDirectory(path.dirname(target))
      const recorded = recordDisplaced({ store, journalId, unit, notePath, displacedPath: target, baseDigest: base, at })
      return settle('ok', 'completed-after-exchange', { recoveryRef: recorded.displacedRef, externalCaptured: recorded.externalCaptured })
    }
    if (displaced && exists(displaced)) {
      const known = store.listReceipts(journalId).find((receipt) => receipt.role === 'displaced' && receipt.unit === unit)
      const recorded = known ?? recordDisplaced({ store, journalId, unit, notePath, displacedPath: displaced, baseDigest: base, at })
      return settle('ok', 'completed-after-recovery-move', { recoveryRef: recorded.displacedRef, externalCaptured: recorded.externalCaptured })
    }
    return settle('skipped', 'nothing-happened')
  }
  if (op === 'create') {
    const created = readFileDigest(note) === candidate
    if (staged) retireStagedFile({ stagedPath: staged, candidateDigest: candidate, fallbackPath: freeName(store, journalId, unit) })
    return created ? settle('ok', 'completed-after-create') : settle('skipped', 'interrupted-before-create')
  }
  if (op === 'remove') {
    if (!displaced || !exists(displaced)) return settle('skipped', 'interrupted-before-removal')
    const noteStat = fs.lstatSync(note, { throwIfNoEntry: false })
    const movedStat = fs.lstatSync(displaced)
    if (noteStat && noteStat.ino === movedStat.ino && noteStat.dev === movedStat.dev) {
      // An interrupted put-back: the note path already names these bytes again.
      fs.unlinkSync(displaced)
      return settle('skipped', 'remove-reverted')
    }
    const recorded = recordDisplaced({ store, journalId, unit, notePath, displacedPath: displaced, baseDigest: base, at })
    return settle('ok', recorded.externalCaptured ? 'removed-external-captured' : 'completed-after-removal', { recoveryRef: recorded.displacedRef, externalCaptured: recorded.externalCaptured })
  }
  return refuse('journal-corrupt', 'a capture entry names an unknown operation')
}

function strays(store, document) {
  const directory = path.join(store.stagingRoot, document.journalId.replaceAll(':', '_'))
  return exists(directory) && fs.readdirSync(directory).some((name) => name.endsWith('.late.candidate'))
    && !document.entries.some((entry) => entry.step === 'capture' && journalDetail(entry).intent === true && journalDetail(entry).stagedRef?.endsWith('.late.candidate'))
}

const iso = (clock) => { const value = clock(); return (value instanceof Date ? value : new Date(value)).toISOString() }

// Caller holds the view's lock.
export function recoverPublicationsLocked({ store, clock = () => new Date() }) {
  const report = []
  for (const journal of listJournals(store, { clock, openOnly: true })) {
    const document = journal.document()
    if (document.state === 'committed') { journal.close(); continue }
    const header = journalDetail(document)
    const settled = new Set(document.entries.filter((entry) => entry.step === 'conditional-update').map((entry) => journalDetail(entry).unit))
    const pending = document.entries.filter((entry) => entry.step === 'capture' && journalDetail(entry).intent === true && !settled.has(journalDetail(entry).unit))
    const pendingUnits = new Set(pending.map((entry) => journalDetail(entry).unit))
    const leftovers = (header.staged ?? []).filter((item) => !pendingUnits.has(item.unit) && exists(store.resolve(item.stagedRef)))
    const pointer = store.readCurrent()
    const hasCommitEntry = document.entries.some((entry) => entry.step === 'manifest-commit' && entry.outcome === 'ok')
    const pointerNamesJournal = pointer?.journalId === document.journalId
    const verifying = document.entries.findLast((entry) => entry.step === 'verify' && journalDetail(entry).settled === true)
    const current = (pointer?.generationId ?? null) === document.expectedGeneration
    const canCommit = Boolean(verifying) && !hasCommitEntry && !pointerNamesJournal && current
    const stale = !current && !pointerNamesJournal
    const atRest = document.state === 'failed' || document.state === 'updating' || document.state === 'captured' || document.state === 'prepared'
    const work = pending.length > 0 || leftovers.length > 0 || strays(store, document) || (pointerNamesJournal && !hasCommitEntry) || canCommit || document.state === 'recovering' || (stale && document.state !== 'failed')
    if (!work && atRest) { if (stale) journal.close(); continue }

    const actions = []
    journal.append({ step: 'restart', outcome: 'ok', state: 'recovering', detail: { phase: 'begin', pendingUnits: pending.length } })
    for (const capture of pending) {
      const entry = reconcileUnit({ store, journalId: document.journalId, capture, at: iso(clock) })
      journal.append({ ...entry, state: 'recovering' })
      actions.push({ path: capture.notePath, outcome: entry.outcome, code: entry.detail.code })
      if (entry.outcome === 'ok' && entry.detail.op !== 'remove') {
        const verified = readFileDigest(path.join(store.vaultRoot, capture.notePath)) === capture.afterDigest
        journal.append({ step: 'verify', outcome: verified ? 'ok' : 'conflict', state: 'recovering', notePath: capture.notePath, afterDigest: capture.afterDigest,
          detail: { unit: entry.detail.unit, code: verified ? 'verified' : 'changed-after-publication' } })
      }
    }
    for (const item of leftovers) {
      const result = retireStagedFile({ stagedPath: store.resolve(item.stagedRef), candidateDigest: item.candidateDigest, fallbackPath: freeName(store, document.journalId, item.unit) })
      if (result.capturedPath) {
        recordDisplaced({ store, journalId: document.journalId, unit: item.unit, notePath: item.path, displacedPath: result.capturedPath, baseDigest: null, at: iso(clock) })
        actions.push({ path: item.path, outcome: 'ok', code: 'unexpected-bytes-at-staged-path-kept' })
      }
    }
    // A staged file that no capture entry names was never put in a payload, so nothing can have exchanged it.
    const stagingDir = store.stagingDir(document.journalId)
    const named = new Set(document.entries.map((entry) => journalDetail(entry).stagedRef).filter(Boolean).map((ref) => path.basename(ref)))
    for (const name of fs.readdirSync(stagingDir)) {
      if (name.endsWith('.late.candidate') && !named.has(name)) fs.rmSync(path.join(stagingDir, name), { force: true })
    }
    try { fs.rmdirSync(stagingDir) } catch { /* not empty, or already gone */ }

    let committed = false
    if (pointerNamesJournal && !hasCommitEntry) {
      journal.append({ step: 'manifest-commit', outcome: 'ok', state: 'committed', detail: { code: 'pointer-already-committed', reconciled: true } })
      committed = true
    } else if (canCommit) {
      const manifestBytes = readFileBytes(store.resolve(header.manifestRef))
      if (sha256Digest(manifestBytes) !== header.manifestDigest) refuse('journal-corrupt', 'the manifest stored with a journal no longer matches its digest')
      store.commitManifest({ manifestBytes, generationId: document.targetGeneration, journalId: document.journalId, retained: journalDetail(verifying).retained ?? [], committedAt: iso(clock) })
      journal.append({ step: 'manifest-commit', outcome: 'ok', state: 'committed', detail: { code: 'committed-on-restart', reconciled: true } })
      committed = true
    } else {
      journal.append({ step: 'restart', outcome: 'ok', state: stale ? 'failed' : 'updating', detail: { phase: 'complete', ...(stale ? { code: 'superseded' } : {}) } })
    }
    if (committed || stale) journal.close()
    report.push({ journalId: document.journalId, actions, committed, state: journal.document().state })
  }
  return { journals: report }
}

export function recoverPublications({ store, clock = () => new Date() }) {
  const release = acquirePrivateLock(store.lockPath)
  try { return recoverPublicationsLocked({ store, clock }) } finally { release() }
}

// Digests this view has published since its trusted manifest was committed,
// by journals that did not reach a commit. They are valid bases: without them
// a note published by an interrupted run would look like an outside edit.
export function publishedSinceCommit({ store }) {
  const pointer = store.readCurrent()
  const ledger = new Map()
  for (const journal of listJournals(store, { openOnly: true })) {
    const document = journal.document()
    if (document.state === 'committed' || document.expectedGeneration !== (pointer?.generationId ?? null)) continue
    for (const entry of document.entries) {
      const detail = journalDetail(entry)
      if (entry.step !== 'conditional-update' || entry.outcome !== 'ok' || detail.kind === 'settings') continue
      ledger.set(entry.notePath, detail.op === 'remove' ? null : entry.afterDigest)
    }
  }
  return ledger
}
