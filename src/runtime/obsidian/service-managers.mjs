import fs from 'node:fs'
import path from 'node:path'
import { atomicReplacePrivateText, readRegularTextNoFollow } from '../../project/private-state.mjs'

// The operating system's service managers, as a login item uses them: a
// launchd user agent on macOS and a systemd user unit on Linux.
//
// Each is built from the directory its unit files live in and `run`, the only
// way it starts a program: `run(program, args)` resolves { status, stdout,
// stderr }, with a null status when the program could not be run at all.
// Neither has a default here. The production ones are made only by the real
// command-line entry, through the production manager module, never under the
// test runner and never for a HOME that is not the account's own; tests hand
// in a `run` that records what it was asked and a temporary directory.
//
// What each does, in order:
//
//   launchd  install  write the property list (mode 0644, atomically); boot
//                     the job out if it is loaded, because a loaded job keeps
//                     the definition it was loaded with, and wait until
//                     launchd has let it go; bootstrap it (RunAtLoad starts it);
//                     a file written where none was is removed again when
//                     launchd did not take it
//            start    kickstart -p: starts the job when it is not running and
//                     prints its PID either way
//            remove   bootout; delete the file
//            inspect  print (loaded, state, PID, last exit code) and
//                     print-disabled (switched off in System Settings)
//   systemd  install  write the unit (mode 0644, atomically); daemon-reload;
//                     enable
//            start    start
//            remove   disable --now; delete the file; daemon-reload
//            inspect  show LoadState, ActiveState, SubState, UnitFileState,
//                     MainPID, ExecMainStatus
//
// Every answer is { ok: true, ... } or { ok: false, code, status, message }
// with one of these codes:
//
//   login-item-unavailable     no manager to install into (no systemd user
//                              instance: WSL, a container, no session bus)
//   login-item-install-failed  the manager refused the unit
//   login-item-not-loaded      a start of a job the manager does not have
//                              loaded (booted out, or not allowed to run)
//   login-item-start-failed    the manager did not start it for another reason
//   login-item-remove-failed   the manager did not let the job go
//   login-item-file-unsafe     the unit's file is a link or not a regular file
//
// The exit statuses and texts of launchctl and systemctl read here are the
// documented ones; they are exercised against recorded texts, never against
// this machine's own session.

export const SERVICE_MANAGER_KINDS = Object.freeze(['launchd-user-agent', 'systemd-user-unit'])
export const LAUNCHCTL = '/bin/launchctl'
const UNIT_FILE_MODE = 0o644
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
// launchctl: the service is not in the domain (print, kickstart), and the job was not loaded (bootout).
const LAUNCHD_NOT_FOUND = [113, 3]
const BOOTOUT_WAIT_MS = 10 * 1000
const BOOTOUT_POLL_MS = 100

// Whether HOME names the account's own home directory (`accountHome`, as the system records it). A login item is
// registered in the account's real session whatever HOME says, so only then is one installed.
export function homeIsAccountHome({ env, accountHome }) {
  const home = env?.HOME
  if (typeof home !== 'string' || !path.isAbsolute(home) || typeof accountHome !== 'string' || !path.isAbsolute(accountHome)) return false
  if (path.resolve(home) === path.resolve(accountHome)) return true
  try { return fs.realpathSync(home) === fs.realpathSync(accountHome) } catch { return false }
}

const failed = (code, answer, message) => ({ ok: false, code, status: answer?.status ?? null, message: message ?? firstLine(answer) })
// The first line of what a manager printed, bounded: never a whole output, which can carry an environment.
function firstLine(answer) {
  const text = `${answer?.stderr ?? ''}\n${answer?.stdout ?? ''}`.split('\n').map((line) => line.trim()).find((line) => line !== '')
  return text === undefined ? null : text.slice(0, 200)
}
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

function checkUnit({ label, fileName }) {
  if (typeof label !== 'string' || !LABEL.test(label)) throw new TypeError('a login item has a plain label')
  if (typeof fileName !== 'string' || fileName !== path.basename(fileName) || !fileName.startsWith(label)) throw new TypeError('a unit file name is the label and its suffix')
}

// The unit's file, owned by this module: written atomically with the mode a manager accepts (neither launchd nor
// systemd reads a unit anyone else can write), never through a link.
function unitFiles(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new TypeError('a service manager needs the absolute directory of its unit files')
  const fileFor = (fileName) => path.join(directory, fileName)
  return {
    directory,
    fileFor,
    read(fileName) {
      try { return readRegularTextNoFollow(fileFor(fileName)) } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
        return undefined
      }
    },
    write(fileName, text) {
      try {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
        atomicReplacePrivateText(fileFor(fileName), text, UNIT_FILE_MODE)
        return { ok: true }
      } catch (error) {
        return { ok: false, code: error?.code === undefined || /regular file|redirected/.test(String(error.message)) ? 'login-item-file-unsafe' : 'login-item-install-failed', status: null, message: String(error.code ?? 'not-written') }
      }
    },
    remove(fileName) {
      let before
      try { before = fs.lstatSync(fileFor(fileName)) } catch (error) { if (error.code === 'ENOENT') return { ok: true, removed: false }; return { ok: false, code: 'login-item-remove-failed', status: null, message: String(error.code) } }
      if (!before.isFile()) return { ok: false, code: 'login-item-file-unsafe', status: null, message: 'not a regular file' }
      try { fs.unlinkSync(fileFor(fileName)); return { ok: true, removed: true } } catch (error) {
        return error.code === 'ENOENT' ? { ok: true, removed: false } : { ok: false, code: 'login-item-remove-failed', status: null, message: String(error.code) }
      }
    },
    present(fileName) { try { return fs.lstatSync(fileFor(fileName)).isFile() } catch { return false } },
  }
}

// Pure. What `launchctl print <domain>/<label>` says about one job.
export function readLaunchdPrint(text) {
  const value = (name) => { const match = new RegExp(`^\\s*${name} = (.+)$`, 'm').exec(String(text ?? '')); return match === null ? null : match[1].trim() }
  const pid = Number(value('pid'))
  const exit = Number(value('last exit code'))
  return { state: value('state'), pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null, lastExit: Number.isInteger(exit) ? exit : null }
}

// Pure. Whether `launchctl print-disabled <domain>` lists this label as disabled: true, false, or null when it is not
// listed. Releases of macOS print `=> disabled` / `=> enabled`, earlier ones `=> true` / `=> false`.
export function readLaunchdDisabled(text, label) {
  for (const line of String(text ?? '').split('\n')) {
    const match = /^\s*"([^"]+)"\s*=>\s*(\S+)\s*$/.exec(line)
    if (match === null || match[1] !== label) continue
    if (match[2] === 'disabled' || match[2] === 'true') return true
    if (match[2] === 'enabled' || match[2] === 'false') return false
  }
  return null
}

export function createLaunchdManager({ run, uid, directory, waitMs = BOOTOUT_WAIT_MS, pollMs = BOOTOUT_POLL_MS } = {}) {
  if (typeof run !== 'function') throw new TypeError('a service manager needs run')
  if (!Number.isSafeInteger(uid) || uid < 0) throw new TypeError('a launchd manager needs the user id of its session')
  const files = unitFiles(directory)
  const domain = `gui/${uid}`
  const target = (label) => `${domain}/${label}`
  const launchctl = (...args) => run(LAUNCHCTL, args)
  const loaded = async (label) => {
    const answer = await launchctl('print', target(label))
    return answer.status === 0 ? { loaded: true, answer } : { loaded: LAUNCHD_NOT_FOUND.includes(answer.status) ? false : null, answer }
  }
  // Boots the job out when launchd has it, and waits, bounded, until it is gone: bootstrap refuses a label still loaded.
  async function bootout(label) {
    const answer = await launchctl('bootout', target(label))
    if (answer.status !== 0 && !LAUNCHD_NOT_FOUND.includes(answer.status)) return failed('login-item-remove-failed', answer)
    const until = Date.now() + waitMs
    for (;;) {
      const now = await loaded(label)
      if (now.loaded === false) return { ok: true, wasLoaded: answer.status === 0 }
      if (Date.now() >= until) return failed('login-item-remove-failed', now.answer, 'launchd kept the job loaded')
      await sleep(pollMs)
    }
  }
  return {
    kind: 'launchd-user-agent', platform: 'darwin', directory: files.directory, fileFor: files.fileFor,
    readUnit({ label, fileName }) { checkUnit({ label, fileName }); return files.read(fileName) },
    async install({ label, fileName, text }) {
      checkUnit({ label, fileName })
      // launchd loads every property list in LaunchAgents at login: one this installation wrote where none was is
      // removed again when launchd did not take it.
      const existed = files.present(fileName)
      const written = files.write(fileName, text)
      if (!written.ok) return written
      const out = await bootout(label)
      if (!out.ok) { if (!existed) files.remove(fileName); return out }
      const answer = await launchctl('bootstrap', domain, files.fileFor(fileName))
      if (answer.status !== 0) {
        if (!existed) files.remove(fileName)
        return failed(answer.status === null ? 'login-item-unavailable' : 'login-item-install-failed', answer)
      }
      return { ok: true, file: files.fileFor(fileName) }
    },
    async start({ label, fileName }) {
      checkUnit({ label, fileName })
      const answer = await launchctl('kickstart', '-p', target(label))
      if (answer.status === 0) { const pid = Number(String(answer.stdout ?? '').trim()); return { ok: true, pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null } }
      return failed(LAUNCHD_NOT_FOUND.includes(answer.status) ? 'login-item-not-loaded' : 'login-item-start-failed', answer)
    },
    async remove({ label, fileName }) {
      checkUnit({ label, fileName })
      const out = await bootout(label)
      if (!out.ok) return out
      const removed = files.remove(fileName)
      return removed.ok ? { ok: true, removed: removed.removed || out.wasLoaded } : removed
    },
    async inspect({ label, fileName }) {
      checkUnit({ label, fileName })
      const present = files.present(fileName)
      const printed = await loaded(label)
      const disabled = await launchctl('print-disabled', domain)
      const job = printed.loaded === true ? readLaunchdPrint(printed.answer.stdout) : { state: null, pid: null, lastExit: null }
      return {
        ok: true, file: files.fileFor(fileName), present, loaded: printed.loaded, running: printed.loaded === true ? job.state === 'running' : printed.loaded === false ? false : null,
        pid: job.pid, lastExit: job.lastExit, disabled: disabled.status === 0 ? readLaunchdDisabled(disabled.stdout, label) === true : null,
      }
    },
  }
}

// Pure. The `KEY=value` lines of `systemctl show`.
export function readSystemdShow(text) {
  const values = {}
  for (const line of String(text ?? '').split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) values[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  const pid = Number(values.MainPID)
  const exit = Number(values.ExecMainStatus)
  return {
    loadState: values.LoadState ?? null, activeState: values.ActiveState ?? null, subState: values.SubState ?? null, unitFileState: values.UnitFileState ?? null,
    pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null, lastExit: values.ExecMainStatus === undefined || !Number.isInteger(exit) ? null : exit,
  }
}

export function createSystemdManager({ run, systemctl, directory } = {}) {
  if (typeof run !== 'function') throw new TypeError('a service manager needs run')
  if (typeof systemctl !== 'string' || !path.isAbsolute(systemctl)) throw new TypeError('a systemd manager needs the absolute path of systemctl')
  const files = unitFiles(directory)
  const user = (...args) => run(systemctl, ['--user', ...args])
  // A user instance that cannot be reached (no session bus: WSL, a container, a session without systemd) makes the
  // first call fail; nothing is left behind by an installation it stopped.
  const unreachable = (answer) => answer.status === null || /Failed to connect to bus|No medium found|not been booted with systemd|System has not been booted/i.test(`${answer.stderr ?? ''}`)
  return {
    kind: 'systemd-user-unit', platform: 'linux', directory: files.directory, fileFor: files.fileFor,
    readUnit({ label, fileName }) { checkUnit({ label, fileName }); return files.read(fileName) },
    async install({ label, fileName, text }) {
      checkUnit({ label, fileName })
      const existed = files.present(fileName)
      const written = files.write(fileName, text)
      if (!written.ok) return written
      const reloaded = await user('daemon-reload')
      if (reloaded.status !== 0) {
        if (!existed) files.remove(fileName)
        return failed(unreachable(reloaded) ? 'login-item-unavailable' : 'login-item-install-failed', reloaded)
      }
      const enabled = await user('enable', fileName)
      if (enabled.status !== 0) return failed(unreachable(enabled) ? 'login-item-unavailable' : 'login-item-install-failed', enabled)
      return { ok: true, file: files.fileFor(fileName) }
    },
    async start({ label, fileName }) {
      checkUnit({ label, fileName })
      const answer = await user('start', fileName)
      if (answer.status === 0) return { ok: true, pid: null }
      return failed(unreachable(answer) ? 'login-item-unavailable' : /not found|not loaded|does not exist/i.test(`${answer.stderr ?? ''}`) ? 'login-item-not-loaded' : 'login-item-start-failed', answer)
    },
    async remove({ label, fileName }) {
      checkUnit({ label, fileName })
      const disabled = await user('disable', '--now', fileName)
      const missing = disabled.status !== 0 && /not found|not loaded|does not exist/i.test(`${disabled.stderr ?? ''}`)
      if (disabled.status !== 0 && !missing) return failed(unreachable(disabled) ? 'login-item-unavailable' : 'login-item-remove-failed', disabled)
      const removed = files.remove(fileName)
      if (!removed.ok) return removed
      await user('daemon-reload')
      return { ok: true, removed: removed.removed || disabled.status === 0 }
    },
    async inspect({ label, fileName }) {
      checkUnit({ label, fileName })
      const present = files.present(fileName)
      const answer = await user('show', '-p', 'LoadState,ActiveState,SubState,UnitFileState,MainPID,ExecMainStatus', fileName)
      if (answer.status !== 0) return { ok: true, file: files.fileFor(fileName), present, loaded: null, running: null, pid: null, lastExit: null, disabled: null }
      const unit = readSystemdShow(answer.stdout)
      return {
        ok: true, file: files.fileFor(fileName), present, loaded: unit.loadState === 'loaded', running: unit.activeState === 'active' || unit.activeState === 'activating',
        pid: unit.pid, lastExit: unit.lastExit, disabled: unit.unitFileState === null ? null : !['enabled', 'enabled-runtime', 'linked', 'linked-runtime'].includes(unit.unitFileState),
      }
    },
  }
}
