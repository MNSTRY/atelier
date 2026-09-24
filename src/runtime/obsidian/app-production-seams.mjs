import { execFile, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { defaultCliPath, defaultObsidianProcessProbe } from '../../projection/obsidian/publication/transport.mjs'
import { readVersionAnswer } from './app-capability.mjs'

// The production seams of `obsidian open` and of the service's adapter
// factory: the only code that asks the installed Obsidian anything or asks the
// operating system to open it.
//
// This module is imported by exactly two places, both real command-line
// entries and both behind an explicit `--adapter=obsidian-cli`: the service
// entry (service-main.mjs) and the command entry (src/commands/obsidian.mjs,
// `production: true`). No test imports it in-process, and importing it leaves
// a trace below that the test suite asserts is absent. One test imports it in
// a child process, with a stand-in for the command-line tool, to read the
// version answers it parses.
//
// Status: written against the documented command-line interface and NOT yet
// exercised against a running app. The acceptance work qualifies it on an
// isolated host before any of it is relied on; until then every answer it
// cannot establish is the failing one.
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

export function createProductionAppProbe({ platform = process.platform, env = process.env, cliPath = defaultCliPath(platform) } = {}) {
  const options = { env, timeout: CLI_TIMEOUT_MS, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 1024 * 1024 }
  return {
    // For the service's adapter factory, which is synchronous. The version is asked for only while an app runs.
    // Both output streams are read, whatever the exit status: the answer with no vault open is not a version.
    inspectSync() {
      const processes = defaultObsidianProcessProbe({ platform })
      if (processes === 'absent') return observationOf({ platform, cliPath, processes, answer: NOT_ASKED })
      let answer = NOT_ASKED
      try {
        const reply = spawnSync(cliPath, ['version'], { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
        answer = readVersionAnswer({ stdout: reply.stdout, stderr: reply.stderr, exited: reply.error === undefined && reply.status === 0 })
      } catch { answer = NOT_ASKED }
      return observationOf({ platform, cliPath, processes, answer })
    },
    inspect() {
      const processes = defaultObsidianProcessProbe({ platform })
      if (processes === 'absent') return Promise.resolve(observationOf({ platform, cliPath, processes, answer: NOT_ASKED }))
      return new Promise((resolve) => {
        execFile(cliPath, ['version'], options, (error, stdout, stderr) => resolve(observationOf({ platform, cliPath, processes, answer: readVersionAnswer({ stdout, stderr, exited: !error }) })))
      })
    },
    // Whether the app answers for exactly this vault and has finished reading it.
    vaultState({ vaultRoot }) {
      const code = '(()=>JSON.stringify({basePath:app.vault.adapter.basePath,ready:app.metadataCache.initialized===true}))()'
      return new Promise((resolve) => {
        execFile(cliPath, ['eval', `code=${code}`], options, (error, stdout) => {
          if (error) return resolve({ answered: false, indexReady: false })
          try {
            const text = String(stdout)
            const value = JSON.parse(JSON.parse(text.slice(text.indexOf('=> ') + 3)))
            return resolve({ answered: value.basePath === vaultRoot, indexReady: value.basePath === vaultRoot && value.ready === true })
          } catch { return resolve({ answered: false, indexReady: false }) }
        })
      })
    },
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
  return { appProbe: createProductionAppProbe(options), launcher: createProductionLauncher(options) }
}
