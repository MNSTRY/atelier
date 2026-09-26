import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { refuse } from './errors.mjs'
import { createLaunchdManager, createSystemdManager, homeIsAccountHome } from './service-managers.mjs'

// The production service manager of a login item: the only code that runs
// launchctl or systemctl, or writes into ~/Library/LaunchAgents or the user's
// systemd folder.
//
// It is imported in exactly one place, dynamically: the command entry
// (src/commands/obsidian.mjs), only when it runs as the real command-line
// entry. Importing it leaves a trace below that the test suite asserts is
// absent. It refuses, before anything is looked up or run:
//
//   - under the Node test runner (`real-login-item-under-test`), whatever
//     environment it is handed: a test hands in its own manager;
//   - when HOME is not the account's own home directory
//     (`login-item-home-mismatch`): launchd and systemd register a unit in
//     the account's real session whatever HOME says, so a private HOME must
//     never install one;
//   - on Windows (`startup-platform-unqualified`) and on any platform but
//     macOS and Linux (`startup-platform-unsupported`).
globalThis[Symbol.for('mnstry.atelier.obsidian.production-service-manager-loaded')] = true

const RUN_TIMEOUT_MS = 15 * 1000
const SYSTEMCTL = ['/usr/bin/systemctl', '/bin/systemctl']

// No shell, in the root directory, bounded.
function runner(env) {
  return (program, args) => new Promise((resolve) => {
    execFile(program, args, { env, cwd: '/', timeout: RUN_TIMEOUT_MS, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ status: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

export function createProductionServiceManager({ platform = process.platform, env = process.env } = {}) {
  if (process.env.NODE_TEST_CONTEXT !== undefined || env.NODE_TEST_CONTEXT !== undefined) refuse('real-login-item-under-test', 'the production login-item manager is never used under the test runner; a test hands in its own')
  if (platform === 'win32') refuse('startup-platform-unqualified', 'operating-system startup on Windows has not been qualified', { platform })
  if (platform !== 'darwin' && platform !== 'linux') refuse('startup-platform-unsupported', 'no login item is known for this platform', { platform: String(platform) })
  const account = os.userInfo()
  if (!homeIsAccountHome({ env, accountHome: account.homedir })) refuse('login-item-home-mismatch', 'HOME is not this account\'s home directory; a login item is registered in the account\'s real session whatever HOME says, so none is installed from here')
  const run = runner(env)
  if (platform === 'darwin') return createLaunchdManager({ run, uid: account.uid, directory: path.join(account.homedir, 'Library', 'LaunchAgents') })
  const configHome = typeof env.XDG_CONFIG_HOME === 'string' && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(account.homedir, '.config')
  const systemctl = SYSTEMCTL.find((candidate) => { try { return fs.statSync(candidate).isFile() } catch { return false } })
  if (systemctl === undefined) return unavailableManager({ directory: path.join(configHome, 'systemd', 'user') })
  return createSystemdManager({ run, systemctl, directory: path.join(configHome, 'systemd', 'user') })
}

// Linux without systemctl: every change answers `login-item-unavailable`, and nothing is written.
function unavailableManager({ directory }) {
  const unavailable = async () => ({ ok: false, code: 'login-item-unavailable', status: null, message: 'systemctl was not found' })
  return {
    kind: 'systemd-user-unit', platform: 'linux', directory, fileFor: (fileName) => path.join(directory, fileName),
    readUnit: () => null, install: unavailable, start: unavailable, remove: async () => ({ ok: true, removed: false }),
    inspect: async ({ fileName }) => ({ ok: true, file: path.join(directory, fileName), present: false, loaded: null, running: null, pid: null, lastExit: null, disabled: null }),
  }
}
