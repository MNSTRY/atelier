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
// entry (base, candidate, candidate path, recovery path) with no outcome
// entry. The candidate path of a replacement is in the unit's recovery
// directory, so whatever it holds is never in a discardable area:
//
//   candidate path == candidate digest  nothing was exchanged. The file is a
//                                       generated candidate and is retired;
//                                       the note is as it was.
//   candidate path, any other bytes     the exchange happened and the move to
//                                       the recovery name did not: the path
//                                       holds the displaced bytes. They are
//                                       moved to the recovery name and
//                                       compared with base.
//   path absent, recovery name present  exchange and move both happened.
//   neither                             nothing happened.
//
// The journal names every exchange candidate, path and digest, before the file
// is at that path (the header for candidates known when the run began, a
// write-ahead entry for a late one), and only complete files are moved there.
// classifyCandidateFile is the only place that decides between the two kinds.
//
// For the whole journal: a pointer that already names this journal gets its
// missing `manifest-commit` entry; a journal that reached `verifying` with
// every note settled commits its stored manifest; anything else is left as
// `updating` for the next publication to converge, with the digests it did
// publish still trusted as bases.

const exists = (file) => { try { fs.lstatSync(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }

const RETIRING_NAME = 'retiring.bin'

// What a file at a candidate path is. `generated-candidate` is claimed only
// for bytes whose digest the journal recorded for that candidate; those are
// ours and may be deleted. Everything else, including a file whose candidate
// digest the journal does not give, is `displaced-bytes`: somebody's content,
// which is moved or kept and never deleted.
export function classifyCandidateFile({ file, candidateDigest }) {
  const digest = file ? readFileDigest(file) : null
  if (digest === null) return 'absent'
  return candidateDigest && digest === candidateDigest ? 'generated-candidate' : 'displaced-bytes'
}

// Every candidate a journal names: from its header, and from the write-ahead
// entries of late exchange candidates. `preparedRef` is where the bytes were
// written, in staging, before they were moved to `stagedRef`.
export function namedCandidates(document) {
  const named = (journalDetail(document).staged ?? []).map(({ unit, path: notePath, candidateDigest, stagedRef, preparedRef }) => ({ unit, path: notePath, candidateDigest, stagedRef, preparedRef: preparedRef ?? null, late: false }))
  for (const entry of document.entries) {
    const detail = journalDetail(entry)
    if (entry.step === 'capture' && detail.code === 'late-candidate' && detail.stagedRef) {
      named.push({ unit: detail.unit, path: entry.notePath, candidateDigest: entry.afterDigest ?? null, stagedRef: detail.stagedRef, preparedRef: detail.preparedRef ?? null, late: true })
    }
  }
  return named
}

function freeName(store, journalId, unit, stem = 'displaced') {
  for (let index = 0; ; index += 1) {
    const candidate = store.displacedPath(journalId, unit, index === 0 ? `${stem}.bin` : `${stem}-${index}.bin`)
    if (!exists(candidate)) return candidate
  }
}

// Judges a file already moved to the unit's retiring name: our own candidate
// is deleted; anything else is somebody's bytes and stays in recovery under a
// name of its own. This is both the second half of retireStagedFile and what
// restart recovery runs for a retirement that was interrupted.
function judgeRetiring({ store, journalId, unit, candidateDigest }) {
  const retiring = store.displacedPath(journalId, unit, RETIRING_NAME)
  if (!exists(retiring)) return { retired: false, capturedPaths: [] }
  if (classifyCandidateFile({ file: retiring, candidateDigest }) === 'generated-candidate') {
    fs.unlinkSync(retiring)
    return { retired: true, capturedPaths: [] }
  }
  const capturedPath = freeName(store, journalId, unit, 'unexpected-at-staged-path')
  fs.renameSync(retiring, capturedPath)
  syncPrivateDirectory(path.dirname(capturedPath))
  return { retired: false, capturedPaths: [capturedPath] }
}

// A candidate path is never unlinked in place: between a digest check and an
// unlink, a late exchange could put displaced bytes there. It is first moved
// to a private name, which no payload refers to, and only then judged. That
// name lives in the unit's recovery directory, beside the exchange candidate,
// never in staging: between the two steps the file may be the only copy of
// bytes an exchange displaced. A process that dies between the steps leaves
// `retiring.bin` there, and restart recovery finishes the judgement.
// Returns { retired, capturedPaths }: every path in `capturedPaths` holds
// bytes that were not the candidate and still needs a receipt.
export function retireStagedFile({ store, journalId, unit, stagedPath, candidateDigest, crash = () => {} }) {
  // An earlier interrupted retirement of this unit is finished first, so the move below never lands on it.
  const earlier = judgeRetiring({ store, journalId, unit, candidateDigest })
  if (!stagedPath || !exists(stagedPath)) return earlier
  fs.renameSync(stagedPath, store.displacedPath(journalId, unit, RETIRING_NAME))
  crash('after-retire-move')
  const result = judgeRetiring({ store, journalId, unit, candidateDigest })
  return { retired: result.retired, capturedPaths: [...earlier.capturedPaths, ...result.capturedPaths] }
}

// Units of one journal that still hold a `retiring.bin`.
function interruptedRetirements(store, journalId) {
  const base = path.join(store.workspaceRoot, 'recovery', journalId.replaceAll(':', '_'))
  if (!exists(base)) return []
  return fs.readdirSync(base).filter((name) => /^\d{6}$/.test(name) && exists(path.join(base, name, RETIRING_NAME))).map((name) => Number(name)).sort((a, b) => a - b)
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

  const keepUnexpected = (paths) => { for (const capturedPath of paths) recordDisplaced({ store, journalId, unit, notePath, displacedPath: capturedPath, baseDigest: base, at }) }
  const completeAfterExchange = (holder) => {
    const target = !displaced || exists(displaced) ? freeName(store, journalId, unit) : displaced
    fs.renameSync(holder, target)
    syncPrivateDirectory(path.dirname(target))
    const recorded = recordDisplaced({ store, journalId, unit, notePath, displacedPath: target, baseDigest: base, at })
    return settle('ok', 'completed-after-exchange', { recoveryRef: recorded.displacedRef, externalCaptured: recorded.externalCaptured })
  }

  if (op === 'replace') {
    // A retirement interrupted between its two moves: the file that was at the
    // staged path is at the retiring name. Bytes that are not the candidate
    // can only have come from the exchange, exactly as if they were still staged.
    const retiring = store.displacedPath(journalId, unit, RETIRING_NAME)
    if (classifyCandidateFile({ file: retiring, candidateDigest: candidate }) === 'displaced-bytes') {
      const entry = completeAfterExchange(retiring)
      if (staged) keepUnexpected(retireStagedFile({ store, journalId, unit, stagedPath: staged, candidateDigest: candidate }).capturedPaths)
      return entry
    }
    const atCandidatePath = classifyCandidateFile({ file: staged, candidateDigest: candidate })
    if (atCandidatePath === 'generated-candidate') {
      keepUnexpected(retireStagedFile({ store, journalId, unit, stagedPath: staged, candidateDigest: candidate }).capturedPaths)
      return settle('skipped', 'interrupted-before-exchange')
    }
    if (atCandidatePath === 'displaced-bytes') return completeAfterExchange(staged)
    keepUnexpected(judgeRetiring({ store, journalId, unit, candidateDigest: candidate }).capturedPaths)
    if (displaced && exists(displaced)) {
      const known = store.listReceipts(journalId).find((receipt) => receipt.role === 'displaced' && receipt.unit === unit && receipt.displacedRef === store.ref(displaced))
      const recorded = known ?? recordDisplaced({ store, journalId, unit, notePath, displacedPath: displaced, baseDigest: base, at })
      return settle('ok', 'completed-after-recovery-move', { recoveryRef: recorded.displacedRef, externalCaptured: recorded.externalCaptured })
    }
    return settle('skipped', 'nothing-happened')
  }
  if (op === 'create') {
    const created = readFileDigest(note) === candidate
    keepUnexpected(staged ? retireStagedFile({ store, journalId, unit, stagedPath: staged, candidateDigest: candidate }).capturedPaths : [])
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

// Late candidates in staging that no entry names. Every one counts: a journal
// may hold a named late candidate and an orphaned one side by side. This looks
// in staging only. Nothing in a unit's recovery directory is ever an orphan:
// a late exchange candidate gets there after its write-ahead entry, and a
// file there that the journal does not account for is kept.
function strays(store, document) {
  const directory = path.join(store.stagingRoot, document.journalId.replaceAll(':', '_'))
  if (!exists(directory)) return []
  const named = new Set(document.entries.flatMap((entry) => [journalDetail(entry).stagedRef, journalDetail(entry).preparedRef]).filter(Boolean))
  return fs.readdirSync(directory).filter((name) => name.endsWith('.late.candidate')).map((name) => path.join(directory, name)).filter((file) => !named.has(store.ref(file)))
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
    // Candidates the journal names that are still on disk. At the candidate path of a pending unit the file is
    // reconcileUnit's to judge. A file still in staging was never moved to an exchange path, whatever its unit.
    const leftovers = namedCandidates(document).flatMap((item) => [...(pendingUnits.has(item.unit) ? [] : [item.stagedRef]), item.preparedRef].filter(Boolean).map((ref) => ({ ...item, file: store.resolve(ref) })))
      .filter((item) => exists(item.file))
    // Retirements interrupted between their two moves, for notes that are otherwise settled.
    const candidateOf = new Map((header.staged ?? []).map((item) => [item.unit, item.candidateDigest]))
    for (const entry of document.entries) if (entry.step === 'capture' && journalDetail(entry).stagedRef && entry.afterDigest) candidateOf.set(journalDetail(entry).unit, entry.afterDigest)
    const pathOf = new Map((header.units ?? []).map((item) => [item.unit, item.path]))
    const retiring = interruptedRetirements(store, document.journalId).filter((unit) => !pendingUnits.has(unit))
    const orphans = strays(store, document)
    const pointer = store.readCurrent()
    const hasCommitEntry = document.entries.some((entry) => entry.step === 'manifest-commit' && entry.outcome === 'ok')
    const pointerNamesJournal = pointer?.journalId === document.journalId
    const verifying = document.entries.findLast((entry) => entry.step === 'verify' && journalDetail(entry).settled === true)
    const current = (pointer?.generationId ?? null) === document.expectedGeneration
    const canCommit = Boolean(verifying) && !hasCommitEntry && !pointerNamesJournal && current
    const stale = !current && !pointerNamesJournal
    const atRest = document.state === 'failed' || document.state === 'updating' || document.state === 'captured' || document.state === 'prepared'
    const work = pending.length > 0 || leftovers.length > 0 || retiring.length > 0 || orphans.length > 0 || (pointerNamesJournal && !hasCommitEntry) || canCommit || document.state === 'recovering' || (stale && document.state !== 'failed')
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
    const keepUnexpected = (unit, notePath, capturedPaths) => {
      for (const capturedPath of capturedPaths) {
        // Not the candidate, and nothing says what it is: it is kept and surfaced as an outside writer's bytes.
        recordDisplaced({ store, journalId: document.journalId, unit, notePath, displacedPath: capturedPath, baseDigest: null, at: iso(clock) })
        actions.push({ path: notePath, outcome: 'ok', code: 'unexpected-bytes-at-staged-path-kept' })
      }
    }
    for (const unit of retiring) {
      const result = retireStagedFile({ store, journalId: document.journalId, unit, stagedPath: null, candidateDigest: candidateOf.get(unit) ?? null })
      keepUnexpected(unit, pathOf.get(unit) ?? null, result.capturedPaths)
      if (result.retired) actions.push({ path: pathOf.get(unit) ?? null, outcome: 'ok', code: 'interrupted-retirement-finished' })
    }
    for (const item of leftovers) {
      const result = retireStagedFile({ store, journalId: document.journalId, unit: item.unit, stagedPath: item.file, candidateDigest: item.candidateDigest })
      keepUnexpected(item.unit, item.path, result.capturedPaths)
    }
    // A file in staging that no entry names was never put in a payload, so nothing can have exchanged it.
    for (const orphan of orphans) fs.rmSync(orphan, { force: true })
    const stagingDir = store.stagingDir(document.journalId)
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
