import path from 'node:path'
import { performance } from 'node:perf_hooks'

// Quitting a running Obsidian so that `open` can add a vault and turn its
// command line on, only when a person asked for it (`--restart-obsidian`).
//
// `open` restarts the app in two states only, where it runs but cannot be
// reached: its command line is turned off, or no vault is open (and the app
// does not list the view's vault). The settings file then belongs to the
// running app, which would write its own list back over any change, and the
// app cannot be asked to add a vault. Before anything is sent, `open` checks,
// read-only, that the write the restart is for can succeed (opening.mjs); right
// before the first signal, once the main process is proven, `beforeSignal` keeps
// a copy of the settings file, and a copy that cannot be kept sends nothing.
//
// SIGTERM, which Electron handles as a quit, is sent to one process: the app's
// main process, proven from the process table, and never to anything else. The
// main process is proven when, in a table of this machine's processes as
// `pid ppid uid comm` (`comm` is the process's argv[0] as macOS reports it, not
// a verified image: a process of this user can name itself anything, which is
// why two candidates prove nothing):
//
//   - every process of the app (the names the process probe counts: `Obsidian`
//     and the bundle's `Obsidian Helper…`) runs as this user;
//   - exactly one of them names the app bundle's main executable by an absolute
//     path (`…/Contents/MacOS/Obsidian`); a process shown by its short name
//     only is not proven;
//   - every other one is a child of that process (its helpers).
//
// Anything else (two instances, another user's app, a helper of another
// parent, a table that cannot be read) is `app-main-process-unproven`, and no
// signal is sent. Immediately before the signal the one process is read again
// (`ppid uid start-time comm`) and must be of this user, under the parent the
// table showed, with the same name, and read the same twice.
//
// What SIGTERM does (1.13.7, checked on an isolated instance): the app handles
// the first one as a quit. It closes every window, keeping the vaults that were
// open flagged open in its list, and its helper processes end; on macOS the main
// process can then stay, with no window, as a macOS app does. Electron handles
// only the first SIGTERM as a quit: a second one ends the process at once,
// without its quit handlers. It is sent only after that same process has shown
// no window and no helper (it is alone in the table, and reads the same) at
// every reading for at least `lingerMs`, measured on a monotonic clock; a
// reading that cannot be parsed does not count as alone. That is a margin, not
// a proof that nothing is left to save. There is never a third signal, and
// never another kind; an app that is still not gone is reported
// (`app-did-not-quit`) and left to the person. `signals` counts the signals
// that were delivered.
//
// Qualified on macOS only: on Linux a quit app is started again with a link,
// which drops the other vaults' reopen flags (launch-plan.mjs), so the promise
// that they reopen would not hold there.
//
// Nothing here reads the process table or sends a signal itself: every seam is
// injected, with no default. Only the production seams module of the command
// entry and the opt-in real-app suite, for its isolated app, construct one.

export const RESTART_PLATFORMS = Object.freeze(['darwin'])
const APP_PROCESS = /^obsidian(?: helper\b.*)?$/i
const MAIN_EXECUTABLE = /^\/.+\.app\/Contents\/MacOS\/Obsidian$/i
// `pid ppid uid comm`. macOS prints the uid of `nobody` as -2: a uid is signed.
export const PROCESS_ROW = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(.+?)\s*$/
// `ppid uid start-time comm`, one process read again.
const DESCRIBED = /^\s*(\d+)\s+(-?\d+)\s+(.+?)\s*$/

const unproven = (detail) => ({ state: 'unproven', reason: 'app-main-process-unproven', detail })
const rowsOf = (table) => table.split('\n').filter((line) => line.trim() !== '').map((line) => PROCESS_ROW.exec(line))

// Pure. The app's main process in a process table (`ps -A -o pid=,ppid=,uid=,comm=`), for the account `uid`:
// { state: 'proven', pid, ppid, executable } | { state: 'absent' } | { state: 'unproven', reason, detail }.
export function provenMainProcess({ table, uid } = {}) {
  if (typeof table !== 'string' || table.trim() === '') return unproven('the process table could not be read')
  if (!Number.isSafeInteger(uid) || uid < 0) return unproven('the account is not known')
  const matches = rowsOf(table)
  if (matches.some((match) => match === null)) return unproven('the process table has a line that is not a process')
  const rows = matches.map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), uid: Number(match[3]), executable: match[4] }))
  const app = rows.filter((row) => APP_PROCESS.test(path.posix.basename(row.executable)))
  if (app.length === 0) return { state: 'absent' }
  if (app.some((row) => row.uid !== uid)) return unproven('an Obsidian process runs as another user')
  const main = app.filter((row) => /^obsidian$/i.test(path.posix.basename(row.executable)))
  if (main.length !== 1) return unproven(main.length === 0 ? 'no Obsidian main process is in the process table' : 'more than one Obsidian main process runs')
  const [one] = main
  if (!MAIN_EXECUTABLE.test(one.executable)) return unproven('the main process does not name the app bundle\'s executable')
  if (app.some((row) => row !== one && row.ppid !== one.pid)) return unproven('an Obsidian helper process is not a child of the main process')
  return { state: 'proven', pid: one.pid, ppid: one.ppid, executable: one.executable }
}

// `readTable()`      -> the process table as provenMainProcess reads it (throws or answers '' when it cannot)
// `readProcess(pid)` -> that process read again as `ppid uid start-time comm`, or null
// `signal(pid)`      -> sends SIGTERM to exactly that pid; throws when it was not delivered
// `processProbe()`   -> 'running' | 'absent' | 'unknown', the probe the settings write uses
//
// quit({ beforeSignal }) answers { quit: true, pid, signalled, signals, settingsCopy? } once the probe says `absent`,
// or { quit: false, reason, signalled, signals, pid?, detail?, settingsCopy? }: `restart-platform-unqualified`,
// `app-main-process-unproven` and the refusal of `beforeSignal` before any signal, `app-did-not-quit` after one, when
// the probe did not say `absent` within `waitMs`. `beforeSignal()`, when given, runs once the main process is proven
// and read again, immediately before the first signal: { ok: true, backupPath? } lets it be sent, anything else
// ({ ok: false, code }) sends nothing. `now` is a monotonic clock in milliseconds.
export function createAppQuitter({ platform, uid, readTable, readProcess, signal, processProbe, sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) }), now = () => performance.now(), waitMs = 30_000, pollMs = 250, lingerMs = 5000 } = {}) {
  for (const [name, seam] of Object.entries({ readTable, readProcess, signal, processProbe })) if (typeof seam !== 'function') throw new TypeError(`quitting Obsidian needs an injected ${name}`)
  const probe = () => { try { return processProbe() } catch { return 'unknown' } }
  const describe = (pid) => { try { const line = readProcess(pid); return typeof line === 'string' && line.trim() !== '' ? line.trim() : null } catch { return null } }
  const table = () => { try { const text = readTable(); return typeof text === 'string' ? text : '' } catch { return '' } }
  // The process read again is the one the table proved: this user's, under the parent the table showed, same name.
  const isFound = (line, found) => {
    const match = line === null ? null : DESCRIBED.exec(line)
    return match !== null && Number(match[1]) === found.ppid && Number(match[2]) === uid && match[3].endsWith(found.executable)
  }
  // The proven main process alone in the table, still the process `seen` described: its windows closed, it did not quit.
  const lingersAlone = (found, seen) => {
    const matches = rowsOf(table())
    if (matches.length === 0 || matches.some((match) => match === null)) return false
    const rows = matches.filter((match) => APP_PROCESS.test(path.posix.basename(match[4])))
    return rows.length === 1 && Number(rows[0][1]) === found.pid && describe(found.pid) === seen
  }
  return {
    async quit({ beforeSignal = null } = {}) {
      if (!RESTART_PLATFORMS.includes(platform)) return { quit: false, reason: 'restart-platform-unqualified', signalled: false, signals: 0 }
      const found = provenMainProcess({ table: table(), uid })
      if (found.state === 'absent') return probe() === 'absent' ? { quit: true, pid: null, signalled: false, signals: 0 } : { quit: false, reason: 'app-main-process-unproven', detail: 'the process table shows no Obsidian, and the process probe does not say it is gone', signalled: false, signals: 0 }
      if (found.state !== 'proven') return { quit: false, reason: found.reason, detail: found.detail, signalled: false, signals: 0 }
      const seen = describe(found.pid)
      if (!isFound(seen, found)) return { quit: false, reason: 'app-main-process-unproven', detail: 'the main process read again is not the one the table showed', signalled: false, signals: 0 }
      // Immediately before the signal: still the same process.
      if (describe(found.pid) !== seen) return { quit: false, reason: 'app-main-process-unproven', detail: 'the main process changed while it was being proven', signalled: false, signals: 0 }
      let copy = {}
      if (typeof beforeSignal === 'function') {
        let kept
        try { kept = await beforeSignal() } catch { kept = null }
        if (kept?.ok !== true) return { quit: false, reason: typeof kept?.code === 'string' ? kept.code : 'obsidian-settings-unwritable', signalled: false, signals: 0 }
        if (typeof kept.backupPath === 'string') copy = { settingsCopy: kept.backupPath }
      }
      try { signal(found.pid) } catch { return { quit: false, reason: 'app-main-process-unproven', detail: 'the main process could not be signalled', signalled: false, signals: 0, ...copy } }
      let signals = 1
      let second = false
      let aloneSince = null
      const deadline = now() + waitMs
      for (;;) {
        if (probe() === 'absent') return { quit: true, pid: found.pid, signalled: true, signals, ...copy }
        if (now() >= deadline) return { quit: false, reason: 'app-did-not-quit', pid: found.pid, signalled: true, signals, ...copy }
        if (!second) {
          if (!lingersAlone(found, seen)) aloneSince = null
          else if (aloneSince === null) aloneSince = now()
          else if (now() - aloneSince >= lingerMs) {
            // Once, whether or not it is delivered.
            second = true
            try { signal(found.pid); signals = 2 } catch { /* not delivered: not counted */ }
          }
        }
        await sleep(pollMs)
      }
    },
  }
}
