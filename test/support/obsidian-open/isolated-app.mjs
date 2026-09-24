// A disposable, isolated Obsidian for the opt-in real-app suite of `open`.
//
// Isolation has two independent parts, as in experiments/obsidian-publication:
// a private HOME (the command-line tool reaches the app through a socket under
// $HOME on macOS, so nothing here can reach another session's app) and a
// private Electron profile, passed as --user-data-dir. The profile sits exactly
// where the app keeps it for that HOME (`$HOME/Library/Application
// Support/obsidian`), so the production seams, which derive the settings
// location from HOME, find this app's vault list and no other. The private
// HOME has no login keychain, so Chromium's mock keychain is used. On Linux
// the tool and the app find each other under XDG_RUNTIME_DIR instead, and the
// settings live under XDG_CONFIG_HOME when that is set: the environment gets a
// private XDG_RUNTIME_DIR and no XDG_CONFIG_HOME, but the suite is qualified
// on macOS only, and refuses to start anywhere else.
//
// Nothing here uses the operating system's URL opener: that would reach the
// app the person runs. A URL is handed to this app on its command line when it
// starts, and through its own command-line tool while it runs. The process
// table is read for this app only, by its --user-data-dir; any other Obsidian
// on the desktop is not seen. Everything lives under one temporary directory
// that `remove()` deletes after `quit()` ended exactly this app's processes.
import { execFile, execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { OBSIDIAN_SETTINGS_FILE, obsidianUserDataDir } from '../../../src/projection/obsidian/publication/vault-list.mjs'

export const APP_DIR = process.env.ATELIER_OBSIDIAN_APP_DIR || '/Applications/Obsidian.app/Contents/MacOS'
export const CLI_PATH = path.join(APP_DIR, 'obsidian-cli')

// 'running' while a process of the app with this profile exists, 'absent' when the table holds none, 'unknown' when it cannot be read.
export function isolatedProcessProbe(userDataDir) {
  if (typeof userDataDir !== 'string' || !path.isAbsolute(userDataDir)) throw new TypeError('the isolated process probe needs the profile directory')
  const marker = `--user-data-dir=${userDataDir}`
  return () => {
    let table
    try { table = execFileSync('/bin/ps', ['-ww', '-A', '-o', 'pid=,command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024, timeout: 5000, killSignal: 'SIGKILL' }) } catch { return 'unknown' }
    return pidsIn(table, marker).length > 0 ? 'running' : 'absent'
  }
}

function pidsIn(table, marker) {
  return String(table).split('\n').map((line) => line.trim()).filter((line) => {
    const at = line.indexOf(` ${marker}`) + 1
    // The marker is a whole argument; the directory has spaces, so it ends the line or another argument follows.
    return at > 0 && (at + marker.length === line.length || line[at + marker.length] === ' ')
  }).map((line) => Number(line.split(/\s+/)[0])).filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
}

export function createIsolatedApp({ parent = process.env.ATELIER_OBSIDIAN_TMP || '/tmp', vaults = {}, platform = process.platform } = {}) {
  if (platform !== 'darwin') throw new Error('the isolated app suite is qualified on macOS only')
  const root = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'atelier-first-open-')))
  const home = path.join(root, 'home')
  const runtime = path.join(root, 'runtime')
  const userDataDir = obsidianUserDataDir({ platform, env: { HOME: home } })
  fs.mkdirSync(userDataDir, { recursive: true })
  fs.mkdirSync(runtime, { mode: 0o700 })
  // The app runs the newest app build in its profile; the pinned one, when given, is the one qualified.
  if (process.env.ATELIER_OBSIDIAN_ASAR) fs.copyFileSync(process.env.ATELIER_OBSIDIAN_ASAR, path.join(userDataDir, path.basename(process.env.ATELIER_OBSIDIAN_ASAR)))
  fs.writeFileSync(path.join(userDataDir, OBSIDIAN_SETTINGS_FILE), JSON.stringify({ vaults, cli: true, updateDisabled: true }))
  const { XDG_CONFIG_HOME: _config, ...inherited } = process.env
  const env = { ...inherited, HOME: home, XDG_RUNTIME_DIR: runtime }
  const marker = `--user-data-dir=${userDataDir}`
  const processProbe = isolatedProcessProbe(userDataDir)
  const pids = () => { try { return pidsIn(execFileSync('/bin/ps', ['-ww', '-A', '-o', 'pid=,command='], { encoding: 'utf8' }), marker) } catch { return [] } }
  const socket = path.join(home, '.obsidian-cli.sock')

  const cli = (args, { timeoutMs = 20000 } = {}) => new Promise((resolve) => {
    execFile(CLI_PATH, args, { env, cwd: root, timeout: timeoutMs, killSignal: 'SIGKILL', encoding: 'utf8' }, (error, stdout, stderr) => resolve({ failed: Boolean(error), stdout: String(stdout), stderr: String(stderr) }))
  })

  function start(url) {
    fs.rmSync(socket, { force: true })
    const log = fs.openSync(path.join(root, 'app.log'), 'a')
    const child = spawn(path.join(APP_DIR, 'Obsidian'), [marker, '--use-mock-keychain', '--password-store=basic',
      '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', ...(url ? [url] : [])], { env, detached: true, stdio: ['ignore', log, log] })
    child.unref()
    fs.closeSync(log)
  }

  return {
    root, home, userDataDir, env, processProbe, cli, cliPath: CLI_PATH,
    settingsFile: path.join(userDataDir, OBSIDIAN_SETTINGS_FILE),
    running: () => processProbe() === 'running',
    // Starts the app on the vaults its list marks open, and waits until its command line answers.
    async launch({ readyTimeoutMs = 60000 } = {}) {
      start(null)
      const until = Date.now() + readyTimeoutMs
      while (Date.now() < until) {
        if (fs.existsSync(socket)) {
          const reply = await cli(['version'], { timeoutMs: 5000 })
          if (!reply.failed && /^\d+\.\d+\.\d+/.test(reply.stdout.trim())) return reply.stdout.trim()
        }
        await sleep(300)
      }
      throw new Error('the isolated Obsidian did not answer its command line in time')
    },
    // `open`'s launcher for this app: a URL on its command line when it starts, through its own tool while it runs.
    launcher: {
      async open({ vaultRoot }) {
        const url = `obsidian://open?path=${encodeURIComponent(vaultRoot)}`
        if (processProbe() !== 'running') { start(url); return { launched: true, reason: 'isolated-app-started' } }
        const reply = await cli([url])
        return reply.failed || !reply.stdout.includes('Processed URI') ? { launched: false, reason: 'isolated-app-refused-url' } : { launched: true, reason: 'isolated-app-accepted-url' }
      },
    },
    // Ends exactly this app's processes, by its profile; answers the PIDs still alive afterwards.
    async quit() {
      for (const pid of pids()) try { process.kill(pid, 'SIGTERM') } catch { /* gone */ }
      for (let attempt = 0; attempt < 40 && pids().length > 0; attempt += 1) await sleep(250)
      for (const pid of pids()) try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
      for (let attempt = 0; attempt < 20 && pids().length > 0; attempt += 1) await sleep(250)
      return pids()
    },
    remove() { fs.rmSync(root, { recursive: true, force: true }) },
  }
}
