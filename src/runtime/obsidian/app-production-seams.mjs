import { execFile, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { NEUTRAL_DIRECTORY, defaultCliPath, defaultObsidianProcessProbe, routedCall } from '../../projection/obsidian/publication/transport.mjs'
import { obsidianSandboxedBuild, obsidianUserDataDir, readObsidianSettings } from '../../projection/obsidian/publication/vault-list.mjs'
import { readEvalAnswer, readVersionAnswer } from './app-capability.mjs'
import { registerVaultInObsidianSettings } from './app-registration.mjs'

// The production seams of `obsidian open` and of the service's adapter
// factory: the only code that asks the installed Obsidian anything or asks the
// operating system to open it.
//
// This module is imported by exactly two places, both real command-line
// entries and both behind an explicit `--adapter=obsidian-cli`: the service
// entry (service-main.mjs) and the command entry (src/commands/obsidian.mjs,
// `production: true`). No test of the default suite imports it in-process, and
// importing it leaves a trace below that the test suite asserts is absent. One
// test imports it in a child process, with a stand-in for the command-line
// tool, to read the version answers it parses; the opt-in real-app suite
// imports it to reach an isolated app through that app's private HOME.
//
// Status: exercised against an isolated Obsidian 1.13.7 (installer 1.12.7) on
// macOS by the opt-in real-app suite in test/obsidian-first-open-real-app.test.mjs;
// every answer it cannot establish is the failing one.
//
// Where each call runs matters: the app answers a command in the window of the
// vault its list routes the call to, opening that vault when it is closed (see
// vault-list.mjs). A call about one vault goes where its route says, in its
// folder or naming its id, and is not made without a route that reaches only
// that vault; every other call runs in a directory that is no vault, so the
// directory this process was started in never picks, or opens, a vault.
globalThis[Symbol.for('mnstry.atelier.obsidian.production-seams-loaded')] = true

const CLI_TIMEOUT_MS = 5000

function installedAppPath(platform) {
  if (platform === 'darwin') return '/Applications/Obsidian.app'
  return null
}

function cliExists(cliPath) {
  if (!path.isAbsolute(cliPath)) return null // found through PATH or not at all: only running it tells
  try { return fs.statSync(cliPath).isFile() } catch { return false }
}

const NOT_ASKED = Object.freeze({ version: null, noVaultOpen: false })

const observationOf = ({ platform, cliPath, processes, answer }) => {
  const appPath = installedAppPath(platform)
  const present = cliExists(cliPath)
  const answered = answer.version !== null || answer.noVaultOpen
  return {
    installed: appPath === null ? (present !== false && (answered || present === true)) : fs.existsSync(appPath),
    cli: present === true || answered,
    running: processes === 'running' ? true : processes === 'absent' ? false : null,
    version: answer.version,
    ...(answer.noVaultOpen ? { noVaultOpen: true } : {}),
  }
}

// `processProbe` reads the process table ('running', 'absent' or 'unknown');
// `workingDirectory` is where calls that are about no vault run.
export function createProductionAppProbe({ platform = process.platform, env = process.env, cliPath = defaultCliPath(platform), processProbe = () => defaultObsidianProcessProbe({ platform }), workingDirectory = NEUTRAL_DIRECTORY } = {}) {
  const options = { env, cwd: workingDirectory, timeout: CLI_TIMEOUT_MS, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 1024 * 1024 }
  const processes = () => { try { return processProbe() } catch { return 'unknown' } }
  return {
    // For the service's adapter factory, which is synchronous. The version is asked for only while an app runs.
    // Both output streams are read, whatever the exit status: the answer with no vault open is not a version.
    inspectSync() {
      const seen = processes()
      if (seen === 'absent') return observationOf({ platform, cliPath, processes: seen, answer: NOT_ASKED })
      let answer = NOT_ASKED
      try {
        const reply = spawnSync(cliPath, ['version'], { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
        answer = readVersionAnswer({ stdout: reply.stdout, stderr: reply.stderr, exited: reply.error === undefined && reply.status === 0 })
      } catch { answer = NOT_ASKED }
      return observationOf({ platform, cliPath, processes: seen, answer })
    },
    inspect() {
      const seen = processes()
      if (seen === 'absent') return Promise.resolve(observationOf({ platform, cliPath, processes: seen, answer: NOT_ASKED }))
      return new Promise((resolve) => {
        execFile(cliPath, ['version'], options, (error, stdout, stderr) => resolve(observationOf({ platform, cliPath, processes: seen, answer: readVersionAnswer({ stdout, stderr, exited: !error }) })))
      })
    },
    // Whether the app answers for exactly this vault and has finished reading it. Asked where `route` (a
    // `vaultRoute` of the app's list) says: from inside the vault's folder, or naming its id, so the app answers in
    // that vault's window whichever window has focus, and opens it when it is known and closed. Without a route that
    // reaches only this vault nothing is asked. Both sides are compared by real path.
    vaultState({ vaultRoot, route }) {
      let target
      try { target = fs.realpathSync(vaultRoot) } catch { return Promise.resolve({ answered: false, indexReady: false }) }
      if (route?.how !== 'folder' && route?.how !== 'id') return Promise.resolve({ answered: false, indexReady: false })
      const where = routedCall(route, workingDirectory)
      return new Promise((resolve) => {
        execFile(cliPath, [...where.args, 'eval', `code=${VAULT_STATE_CODE}`], { ...options, cwd: where.cwd }, (error, stdout, stderr) => {
          const answer = readEvalAnswer({ stdout, stderr, failed: Boolean(error) })
          const value = answer.answered ? answer.value : null
          const answered = value !== null && typeof value === 'object' && value.basePath === target
          resolve({ answered, indexReady: answered && value.ready === true })
        })
      })
    },
  }
}

// The fixed scripts the app runs for `open`. The only variable input is a JSON
// payload that travels base64-encoded, so a path never becomes code.
const VAULT_STATE_CODE = "(()=>{let p=app.vault.adapter.basePath;try{p=require('fs').realpathSync(p)}catch(e){}return JSON.stringify({basePath:p,ready:app.metadataCache.initialized===true})})()"
const VAULT_LIST_CODE = "(()=>JSON.stringify({vaults:require('electron').ipcRenderer.sendSync('vault-list')}))()"
// `vault-open` with `false` adds an existing folder to the app's vault list (the app writes its own file) and opens
// it in a window; it answers true, or a message. With `true` it would create a new folder, which is never wanted.
const VAULT_REGISTER_SCRIPT = "return JSON.stringify({result:require('electron').ipcRenderer.sendSync('vault-open',P.path,false)})"
function vaultRegisterCode(vaultRoot) {
  if (typeof vaultRoot !== 'string' || !path.isAbsolute(vaultRoot) || vaultRoot.includes('\u0000')) throw new TypeError('vaultRoot must be an absolute path')
  const data = Buffer.from(JSON.stringify({ path: vaultRoot }), 'utf8').toString('base64')
  return `(()=>{const P=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('${data}'),c=>c.charCodeAt(0))));${VAULT_REGISTER_SCRIPT}})()`
}

// The vault list of the app, and adding this view's vault to it:
//
//   listThroughApp()                  -> { answered: true, vaults } | { answered: false, reason }
//   registerThroughApp({ vaultRoot }) -> { answered: true, result } | { answered: false, reason }
//   readSettings()                    -> readObsidianSettings answer (never writes)
//   registerInSettings({ vaultRoot }) -> registerVaultInObsidianSettings answer
//
// Through the app only while it runs and answers; in its settings file only
// while no Obsidian runs, which registerVaultInObsidianSettings checks itself.
// A Flatpak or snap build found for this account (`sandbox`) never reads that
// file: it is then neither read nor written (`obsidian-sandboxed`), and a vault
// is added through the app only. Adding a vault opens a window, so a call may
// take longer than a version answer.
export function createProductionAppRegistry({
  platform = process.platform, env = process.env, cliPath = defaultCliPath(platform), processProbe = () => defaultObsidianProcessProbe({ platform }), workingDirectory = NEUTRAL_DIRECTORY,
  userDataDir = obsidianUserDataDir({ platform, env }), sandbox = obsidianSandboxedBuild({ platform, env }), timeoutMs = CLI_TIMEOUT_MS * 3,
} = {}) {
  const sandboxed = { ok: false, code: 'obsidian-sandboxed', message: `this Obsidian is a ${sandbox} build, which reads its vault list inside its sandbox, where Atelier does not write` }
  const evaluate = (code) => new Promise((resolve) => {
    execFile(cliPath, ['eval', `code=${code}`], { env, cwd: workingDirectory, timeout: timeoutMs, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => resolve(readEvalAnswer({ stdout, stderr, failed: Boolean(error) })))
  })
  return {
    async listThroughApp() {
      const answer = await evaluate(VAULT_LIST_CODE)
      if (!answer.answered) return answer
      const vaults = answer.value?.vaults
      return vaults !== null && typeof vaults === 'object' && !Array.isArray(vaults) ? { answered: true, vaults } : { answered: false, reason: 'no-value' }
    },
    async registerThroughApp({ vaultRoot }) {
      const answer = await evaluate(vaultRegisterCode(vaultRoot))
      return answer.answered ? { answered: true, result: answer.value?.result ?? null } : answer
    },
    readSettings: () => (sandbox === null ? readObsidianSettings({ userDataDir }) : sandboxed),
    registerInSettings: ({ vaultRoot }) => (sandbox !== null ? sandboxed : userDataDir === null
      ? { ok: false, code: 'obsidian-settings-location-unknown', message: 'where Obsidian keeps its settings on this system is not known' }
      : registerVaultInObsidianSettings({ userDataDir, vaultRoot, processProbe })),
  }
}

// Asks the operating system to open the vault in Obsidian. No shell.
export function createProductionLauncher({ platform = process.platform, env = process.env } = {}) {
  const command = platform === 'darwin' ? '/usr/bin/open' : platform === 'linux' ? 'xdg-open' : null
  return {
    open({ vaultRoot }) {
      if (command === null) return Promise.resolve({ launched: false, reason: 'launcher-platform-unqualified' })
      const uri = `obsidian://open?path=${encodeURIComponent(vaultRoot)}`
      return new Promise((resolve) => {
        execFile(command, [uri], { env, timeout: 15_000 }, (error) => resolve(error ? { launched: false, reason: 'os-open-failed' } : { launched: true, reason: 'os-open-accepted' }))
      })
    },
  }
}

export function createProductionAppSeams(options = {}) {
  return { appProbe: createProductionAppProbe(options), launcher: createProductionLauncher(options), registry: createProductionAppRegistry(options) }
}
