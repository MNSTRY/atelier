import path from 'node:path'

// Quitting a running Obsidian so that `open` can add a vault and turn its
// command line on, only when a person asked for it (`--restart-obsidian`).
//
// `open` restarts the app in two states only, where it runs but cannot be
// reached: its command line is turned off, or no vault is open (and the app
// does not list the view's vault). The settings file then belongs to the
// running app, which would write its own list back over any change, and the
// app cannot be asked to add a vault. A quitting app keeps every vault it has
// open flagged open (1.13.7, checked on an isolated instance), so a plain start
// afterwards reopens them.
//
// One signal, SIGTERM, which Electron treats as a normal quit, is sent to one
// process: the app's main process, proven from the process table, and never to
// anything else. Nothing is ever killed: an app that does not quit is reported
// (`app-did-not-quit`) and left to the person. The main process is proven when,
// in a table of this machine's processes as `pid ppid uid executable`:
//
//   - every process of the app (the executables the process probe counts:
//     `Obsidian` and the bundle's `Obsidian Helper…`) runs as this user;
//   - exactly one of them runs the app's main executable, named by an absolute
//     path inside an app bundle (`…/Contents/MacOS/Obsidian`); a process whose
//     path the table cannot show is not proven;
//   - every other one is a child of that process (its helpers).
//
// Anything else (two instances, another user's app, a helper of another
// parent, a table that cannot be read) is `app-main-process-unproven`, and no
// signal is sent. Immediately before the signal the one process is read again
// and must still be the same executable of the same user under the same parent,
// started at the same time.
//
// With a vault window open, the first SIGTERM quits the app. With only its
// starter window (no vault open), it closes the window and every helper ends,
// but the main process stays, as a macOS app does with no window (1.13.7,
// checked on an isolated instance); a second SIGTERM then quits it. So when,
// after `lingerMs`, the table shows that same main process alone (no helper,
// so no window left, and the same process when read again), it gets SIGTERM
// once more. There is never a third signal, and never another kind. Qualified on macOS only: on Linux a quit app is
// started again with a link, which drops the other vaults' reopen flags
// (launch-plan.mjs), so the promise that they reopen would not hold there.
//
// Nothing here reads the process table or sends a signal itself: every seam is
// injected, with no default. Only the production seams module of the command entry
// and the opt-in real-app suite, for its isolated app, construct one.

export const RESTART_PLATFORMS = Object.freeze(['darwin'])
const APP_PROCESS = /^obsidian(?: helper\b.*)?$/i
const MAIN_EXECUTABLE = /^\/.+\.app\/Contents\/MacOS\/Obsidian$/i
const ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/

const unproven = (detail) => ({ state: 'unproven', reason: 'app-main-process-unproven', detail })

// Pure. The app's main process in a process table (`ps -A -o pid=,ppid=,uid=,comm=`), for the account `uid`:
// { state: 'proven', pid, executable } | { state: 'absent' } | { state: 'unproven', reason, detail }.
export function provenMainProcess({ table, uid } = {}) {
  if (typeof table !== 'string' || table.trim() === '') return unproven('the process table could not be read')
  if (!Number.isSafeInteger(uid) || uid < 0) return unproven('the account is not known')
  const rows = []
  for (const line of table.split('\n')) {
    if (line.trim() === '') continue
    const match = ROW.exec(line)
    if (match === null) return unproven('the process table has a line that is not a process')
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), uid: Number(match[3]), executable: match[4] })
  }
  const app = rows.filter((row) => APP_PROCESS.test(path.posix.basename(row.executable)))
  if (app.length === 0) return { state: 'absent' }
  if (app.some((row) => row.uid !== uid)) return unproven('an Obsidian process runs as another user')
  const main = app.filter((row) => /^obsidian$/i.test(path.posix.basename(row.executable)))
  if (main.length !== 1) return unproven(main.length === 0 ? 'no Obsidian main process is in the process table' : 'more than one Obsidian main process runs')
  const [one] = main
  if (!MAIN_EXECUTABLE.test(one.executable)) return unproven('the main process does not name the app bundle\'s executable')
  if (app.some((row) => row !== one && row.ppid !== one.pid)) return unproven('an Obsidian helper process is not a child of the main process')
  return { state: 'proven', pid: one.pid, executable: one.executable }
}

// `readTable()`   -> the process table as provenMainProcess reads it (throws or answers '' when it cannot)
// `readProcess(pid)` -> one line describing that process (its parent, user, start time and executable), or null;
//                     compared before the signal, never parsed
// `signal(pid)`   -> sends SIGTERM to exactly that pid
// `processProbe()` -> 'running' | 'absent' | 'unknown', the probe the settings write uses
//
// quit() answers { quit: true, pid, signalled: true } once the probe says `absent`, or { quit: false, reason,
// signalled, pid? }: `restart-platform-unqualified` and `app-main-process-unproven` before any signal,
// `app-did-not-quit` after one, when the probe did not say `absent` within `waitMs`.
export function createAppQuitter({ platform, uid, readTable, readProcess, signal, processProbe, sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) }), now = () => Date.now(), waitMs = 30_000, pollMs = 250, lingerMs = 5000 } = {}) {
  for (const [name, seam] of Object.entries({ readTable, readProcess, signal, processProbe })) if (typeof seam !== 'function') throw new TypeError(`quitting Obsidian needs an injected ${name}`)
  const probe = () => { try { return processProbe() } catch { return 'unknown' } }
  const describe = (pid) => { try { const line = readProcess(pid); return typeof line === 'string' && line.trim() !== '' ? line.trim() : null } catch { return null } }
  const table = () => { try { const text = readTable(); return typeof text === 'string' ? text : '' } catch { return '' } }
  // The proven main process alone, still the process `seen` described: its windows are closed, and it did not quit.
  const lingersAlone = (pid, seen) => {
    const rows = table().split('\n').filter((line) => line.trim() !== '').map((line) => ROW.exec(line)).filter((match) => match !== null && APP_PROCESS.test(path.posix.basename(match[4])))
    return rows.length === 1 && Number(rows[0][1]) === pid && describe(pid) === seen
  }
  return {
    async quit() {
      if (!RESTART_PLATFORMS.includes(platform)) return { quit: false, reason: 'restart-platform-unqualified', signalled: false }
      const found = provenMainProcess({ table: table(), uid })
      if (found.state === 'absent') return probe() === 'absent' ? { quit: true, pid: null, signalled: false } : { quit: false, reason: 'app-main-process-unproven', detail: 'the process table shows no Obsidian, and the process probe does not say it is gone', signalled: false }
      if (found.state !== 'proven') return { quit: false, reason: found.reason, detail: found.detail, signalled: false }
      const seen = describe(found.pid)
      if (seen === null || !seen.endsWith(found.executable)) return { quit: false, reason: 'app-main-process-unproven', detail: 'the main process could not be read again', signalled: false }
      // Immediately before the signal: still the same process.
      if (describe(found.pid) !== seen) return { quit: false, reason: 'app-main-process-unproven', detail: 'the main process changed while it was being proven', signalled: false }
      try { signal(found.pid) } catch { return { quit: false, reason: 'app-main-process-unproven', detail: 'the main process could not be signalled', signalled: false } }
      let signals = 1
      const signalledAt = now()
      const deadline = signalledAt + waitMs
      for (;;) {
        if (probe() === 'absent') return { quit: true, pid: found.pid, signalled: true, signals }
        if (now() >= deadline) return { quit: false, reason: 'app-did-not-quit', pid: found.pid, signalled: true, signals }
        if (signals === 1 && now() - signalledAt >= lingerMs && lingersAlone(found.pid, seen)) {
          try { signal(found.pid); signals = 2 } catch { signals = 2 }
        }
        await sleep(pollMs)
      }
    },
  }
}
