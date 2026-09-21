import fs from 'node:fs'
import path from 'node:path'
import { createMaintenanceEngine } from '../../../src/runtime/obsidian/engine.mjs'
import { createNullWatcherFactory } from '../../../src/runtime/obsidian/watchers.mjs'
import { isoNow, sha256Digest } from './common.mjs'
import { PROPOSED_TARGETS, waitUntil } from './measure.mjs'
import { evidenceFileName } from './receipts.mjs'
import { fileDigest, noteFile, openEdits, privateStateSnapshot, sourceDigests } from './service-world.mjs'

// AP-03 (G14, G15): maintenance and host lifecycle against the owned
// service and an isolated app. Every step below is what a person would do at
// the keyboard, done through the runtime's own API with the wall clock and
// the raw answers recorded. What no script can do, the host's actual
// sleep/wake, stays a manual role with its exact commands.
//
//   source-refresh     edit a canonical source while the note is open in the
//                      app: source digest, vault file update, app readback
//   dropped-event      the watcher is stopped only through the owned test
//                      hook (createNullWatcherFactory); a source change with
//                      no event is caught by digest reconciliation on a tick
//   interruption       the disposable service is killed at owned points
//                      (idle, and while a tick runs); after each restart the
//                      retained state (pending edits, journals, preserved
//                      bytes) is read back and compared
//   launcher-exit      the service is started from a child that exits at
//                      once; the runtime identifier and PID stay healthy
//
// `runtime`, `app`, `createEngine` and `adapterFactory` are seams; the test
// suite runs this with a real service process of a test entry and a fake app.

export const AP03_STEPS = Object.freeze(['baseline', 'source-refresh', 'dropped-event', 'interruption', 'launcher-exit'])
export const AP03_DEFAULTS = Object.freeze({ scopeId: 'scope-full', nodeId: 'north-desk:harbor-plan', repoId: 'north-desk', sourceRelative: 'plans/harbor-plan.md' })

const text = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
const tickSummary = (answer) => ({ requested: answer.requested, state: answer.state, reason: answer.reason ?? null, pending: answer.pending ?? false, tick: answer.tick ? { ok: answer.tick.ok, state: answer.tick.state, reason: answer.tick.reason ?? null, scopes: answer.tick.scopes ?? [] } : null })
const statusSummary = (status) => ({ state: status.state, reason: status.reason ?? null, runtimeId: status.record?.runtimeId ?? null, pid: status.record?.pid ?? null, address: status.address ?? null, health: status.health ? { runtimeId: status.health.runtimeId, pid: status.health.pid, status: status.health.status } : null })

export async function runAp03({
  world, runtime, app, adapterFactory, createEngine = createMaintenanceEngine, now = Date.now, clock = isoNow, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  scopeId = AP03_DEFAULTS.scopeId, nodeId = AP03_DEFAULTS.nodeId, repoId = AP03_DEFAULTS.repoId, sourceRelative = AP03_DEFAULTS.sourceRelative,
  recoveryIntervalMs = 3000, settleMs = 3000, fileTimeoutMs = 60000, appTimeoutMs = 60000, midTickDelayMs = 5,
}) {
  const repo = world.repositories.find((item) => item.repoId === repoId)
  if (!repo) throw new Error(`the workspace enrols no repository ${repoId}`)
  const sourceFile = path.join(repo.path, ...sourceRelative.split('/'))
  const vaultRoot = world.vaultRootFor(scopeId)
  const steps = {}
  const failures = []
  const check = (step, condition, message) => { if (!condition) failures.push(`${step}: ${message}`); return condition }

  // Baseline: the service is started, ticks once and the view is current.
  const baseline = { startedAt: clock() }
  baseline.start = statusSummary(await runtime.start())
  check('baseline', baseline.start.state === 'healthy', `service did not start healthy (${baseline.start.state})`)
  baseline.tick = tickSummary(await runtime.tick())
  const manifest = world.manifestFor(scopeId)
  check('baseline', manifest !== null, 'no manifest after the first tick')
  const note = manifest?.notes.find((item) => item.nodeId === nodeId) ?? null
  check('baseline', note !== null, `the view holds no note for ${nodeId}`)
  baseline.notePath = note?.path ?? null
  baseline.scopeState = baseline.tick.tick?.scopes.find((scope) => scope.scopeId === scopeId) ?? null
  baseline.endedAt = clock()
  steps.baseline = baseline
  const notePath = note?.path ?? 'missing.md'
  const vaultFile = noteFile(vaultRoot, notePath)

  // Source refresh while the note is open in the app.
  const refresh = { startedAt: clock(), notePath, sourceFile: `${repoId}/${sourceRelative}` }
  try { refresh.appOpen = await app.openNote(notePath) } catch (error) { refresh.appOpen = { error: error.message } }
  refresh.before = { sourceDigest: fileDigest(sourceFile), vaultDigest: fileDigest(vaultFile), vaultMtime: fs.statSync(vaultFile).mtime.toISOString() }
  const needle = `Source refresh typed at ${clock()} (AP-03).`
  const editedAtMs = now()
  fs.appendFileSync(sourceFile, `\n${needle}\n`)
  refresh.editedAt = new Date(editedAtMs).toISOString()
  refresh.after = { sourceDigest: fileDigest(sourceFile) }
  refresh.tick = tickSummary(await runtime.tick())
  const file = await waitUntil(() => fs.readFileSync(vaultFile, 'utf8').includes(needle), { timeoutMs: fileTimeoutMs, intervalMs: 100 })
  refresh.fileUpdate = { met: file.met, sourceToFileMs: file.met ? now() - editedAtMs : null, vaultMtime: fs.statSync(vaultFile).mtime.toISOString(), vaultDigest: fileDigest(vaultFile), attempts: file.attempts, error: file.error }
  const readback = await waitUntil(() => app.readIncludes({ path: notePath, needle }), { timeoutMs: appTimeoutMs, intervalMs: 100 })
  refresh.appReadback = { met: readback.met, sourceToAppMs: readback.met ? now() - editedAtMs : null, attempts: readback.attempts, error: readback.error, probe: 'app.vault.adapter.read(path).includes(needle)' }
  refresh.status = (await runtime.statusDocument()).document ?? null
  refresh.targets = { fileUpdateP95Ms: PROPOSED_TARGETS.fileUpdate.p95Ms, note: 'one sample; the p95 file target is recorded beside it, not asserted from it; no app target is substituted' }
  check('source-refresh', file.met && readback.met, 'the source change did not reach the vault file and the app')
  check('source-refresh', refresh.after.sourceDigest !== refresh.before.sourceDigest, 'the source digest did not change')
  refresh.endedAt = clock()
  steps['source-refresh'] = refresh

  // Dropped event: the service is stopped; an engine with the null watcher
  // factory ticks in this process. No watcher runs, so no event can arrive.
  const dropped = { startedAt: clock(), watcherFactory: 'createNullWatcherFactory (owned test hook; no filesystem watcher is created)', fullReconciliationIntervalMs: recoveryIntervalMs }
  dropped.serviceStop = await runtime.stop()
  check('dropped-event', dropped.serviceStop.stopped === true, `the service was not stopped (${dropped.serviceStop.reason ?? dropped.serviceStop.state})`)
  const engine = createEngine({ loadProject: world.loadProject, dataRoot: world.dataRoot, env: world.env, adapterFactory, clock: () => new Date(), watcherFactory: createNullWatcherFactory(), fullReconciliationIntervalMs: recoveryIntervalMs, quietPeriodMs: 0 })
  try {
    const first = await engine.tick()
    dropped.firstTick = { state: first.state, full: first.full, changes: first.changes, scopes: first.scopes?.map(({ scopeId: id, state, reason }) => ({ scopeId: id, state, reason })) ?? [] }
    const trials = []
    for (const [label, waitForFull] of [['stat-and-digest', false], ['full-hash-pass', true]]) {
      const trial = { label, before: { sourceDigest: fileDigest(sourceFile), vaultDigest: fileDigest(vaultFile) } }
      const marker = `Dropped event ${label} at ${clock()}.`
      const changedAtMs = now()
      fs.appendFileSync(sourceFile, `\n${marker}\n`)
      trial.changedAt = new Date(changedAtMs).toISOString()
      if (waitForFull) { await sleep(recoveryIntervalMs + 50); trial.waitedMs = now() - changedAtMs }
      const report = await engine.tick()
      trial.tick = { state: report.state, full: report.full, changes: report.changes, scopes: report.scopes?.map(({ scopeId: id, state, reason }) => ({ scopeId: id, state, reason })) ?? [], refusal: report.refusal ?? null }
      const caught = fs.readFileSync(vaultFile, 'utf8').includes(marker)
      trial.caught = caught
      trial.recoveryMs = caught ? now() - changedAtMs : null
      trial.after = { sourceDigest: fileDigest(sourceFile), vaultDigest: fileDigest(vaultFile) }
      const appSaw = await waitUntil(() => app.readIncludes({ path: notePath, needle: marker }), { timeoutMs: appTimeoutMs, intervalMs: 100 })
      trial.appReadback = { met: appSaw.met, sinceChangeMs: appSaw.met ? now() - changedAtMs : null, error: appSaw.error }
      check('dropped-event', caught && report.changes.some((change) => change.changeClass === 'source-body'), `${label}: the change was not caught by reconciliation`)
      if (waitForFull) check('dropped-event', report.full === true, 'the second trial was not a full reconciliation')
      trials.push(trial)
    }
    dropped.trials = trials
    dropped.targets = { recoveryMaxMs: PROPOSED_TARGETS.droppedEventRecovery.maxMs, recorded: trials.map((trial) => trial.recoveryMs), note: 'the proposed <= 60 s recovery target is recorded here, not asserted; the tick was requested explicitly, so the recorded times are the engine cost, not the service interval' }
  } finally { engine.stop() }
  dropped.endedAt = clock()
  steps['dropped-event'] = dropped

  // Interruption at owned points. Retained state is created first: an edit of a vault note that a tick preserves and queues.
  const interruption = { startedAt: clock(), points: [] }
  interruption.restart = statusSummary(await runtime.start())
  check('interruption', interruption.restart.state === 'healthy', 'the service did not restart after the engine step')
  const editMarker = `Vault edit retained across interruptions at ${clock()}.`
  fs.appendFileSync(vaultFile, `\n${editMarker}\n`)
  interruption.editTick = tickSummary(await runtime.tick())
  const reference = privateStateSnapshot(world, [scopeId])
  interruption.reference = reference
  check('interruption', openEdits(reference).length >= 1, 'no pending edit was queued from the vault edit')
  check('interruption', reference.retainedObjects.every((item) => item.present), 'a preserved object is missing before any interruption')
  for (const point of ['idle-between-ticks', 'during-a-tick']) {
    const record = { point, before: statusSummary(await runtime.status()) }
    const pid = record.before.pid
    check('interruption', record.before.state === 'healthy' && Number.isInteger(pid), `${point}: no healthy service to interrupt`)
    if (point === 'during-a-tick') {
      const inFlight = runtime.tick({ tickTimeoutMs: 5000 }).then((answer) => ({ answer: tickSummary(answer) }), (error) => ({ error: error.message }))
      await sleep(midTickDelayMs)
      record.killedAt = clock()
      record.kill = runtime.kill(pid, 'SIGKILL')
      record.tickInFlight = await inFlight
    } else {
      record.killedAt = clock()
      record.kill = runtime.kill(pid, 'SIGKILL')
    }
    const gone = await waitUntil(() => !runtime.alive(pid), { timeoutMs: 10000, intervalMs: 50 })
    record.processGone = { met: gone.met, elapsedMs: gone.elapsedMs }
    record.afterKill = statusSummary(await runtime.status())
    check('interruption', ['stale-record', 'stopped'].includes(record.afterKill.state), `${point}: after the kill the status is ${record.afterKill.state}, not stale-record`)
    record.restart = statusSummary(await runtime.start())
    check('interruption', record.restart.state === 'healthy' && record.restart.pid !== pid, `${point}: the service did not come back as a new runtime`)
    record.tick = tickSummary(await runtime.tick())
    const after = privateStateSnapshot(world, [scopeId])
    record.retained = {
      pendingEditsUnchanged: JSON.stringify(openEdits(after).map(({ editId, state, objectRef }) => [editId, state, objectRef])) === JSON.stringify(openEdits(reference).map(({ editId, state, objectRef }) => [editId, state, objectRef])),
      journalsRetained: reference.journals[scopeId].every((entry) => after.journals[scopeId].some((item) => item.journalId === entry.journalId)),
      objectsPresent: after.retainedObjects.every((item) => item.present),
      vaultEditStillOnDisk: fs.readFileSync(vaultFile, 'utf8').includes(editMarker),
      snapshot: after,
    }
    check('interruption', record.retained.pendingEditsUnchanged && record.retained.journalsRetained && record.retained.objectsPresent && record.retained.vaultEditStillOnDisk, `${point}: retained state differs after restart`)
    interruption.points.push(record)
  }
  interruption.endedAt = clock()
  steps.interruption = interruption

  // Launcher exit: stop, then start from a child that exits at once.
  const launcher = { startedAt: clock() }
  launcher.stop = await runtime.stop()
  check('launcher-exit', launcher.stop.stopped === true, 'the service was not stopped before the launcher step')
  const launched = await runtime.startFromExitingLauncher()
  launcher.launcher = launched.launcher
  launcher.reported = launched.reported
  check('launcher-exit', launched.launcher.exit.code === 0 && launched.launcher.alive === false, `the launching process did not exit cleanly (${JSON.stringify(launched.launcher.exit)})`)
  check('launcher-exit', launched.reported?.state === 'healthy' && launched.reported.started === true, 'the launcher did not report a healthy start')
  launcher.statusAfterExit = statusSummary(await runtime.status())
  launcher.healthAfterExit = await runtime.health()
  await sleep(settleMs)
  launcher.settledMs = settleMs
  launcher.statusLater = statusSummary(await runtime.status())
  launcher.tickLater = tickSummary(await runtime.tick())
  launcher.statusDocument = (await runtime.statusDocument()).document ?? null
  const same = (status) => status.state === 'healthy' && status.runtimeId === launched.reported?.runtimeId && status.pid === launched.reported?.pid
  check('launcher-exit', same(launcher.statusAfterExit) && same(launcher.statusLater), 'the runtime identifier and PID did not stay healthy after the launcher exited')
  check('launcher-exit', launcher.healthAfterExit.answer?.kind === 'health' && launcher.healthAfterExit.answer.body?.runtimeId === launched.reported?.runtimeId, 'the health probe does not name the launched runtime')
  launcher.finalStop = await runtime.stop()
  launcher.endedAt = clock()
  steps['launcher-exit'] = launcher

  const sources = sourceDigests(world)
  const host = { recordedAt: clock(), sourceDigests: sources }
  const evidence = [
    { role: 'source-refresh-trace', name: evidenceFileName('G14', 'source-refresh-trace', 'json'), bytes: text({ step: steps['source-refresh'], baseline: steps.baseline, host }) },
    { role: 'dropped-event-recovery', name: evidenceFileName('G14', 'dropped-event-recovery', 'json'), bytes: text({ step: steps['dropped-event'], host }) },
    { role: 'ownership-health', name: evidenceFileName('G15', 'ownership-health', 'json'), bytes: text({ launcher: { reported: launcher.reported, statusAfterExit: launcher.statusAfterExit, healthAfterExit: launcher.healthAfterExit, statusDocument: launcher.statusDocument }, interruption: steps.interruption, host }) },
    { role: 'terminal-closure', name: evidenceFileName('G15', 'terminal-closure', 'json'), bytes: text({ step: steps['launcher-exit'], host }) },
  ]
  const timings = {
    sourceToFileMs: refresh.fileUpdate.sourceToFileMs, sourceToAppMs: refresh.appReadback.sourceToAppMs,
    droppedEventRecoveryMs: dropped.trials?.map((trial) => trial.recoveryMs) ?? null, interruptions: interruption.points.map(({ point, processGone, retained }) => ({ point, processGoneMs: processGone.elapsedMs, retained: retained.pendingEditsUnchanged && retained.journalsRetained && retained.objectsPresent })),
    launcherExit: launcher.launcher?.exit ?? null,
  }
  return { steps, evidence, timings, failures, passed: failures.length === 0, sourceFiles: Object.keys(sources).length, digestOfSteps: sha256Digest(Buffer.from(JSON.stringify(steps))) }
}
