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
//
// `quitter` is the production quitter of `open --restart-obsidian`
// (app-restart.mjs) with this app's seams: its process table holds only the
// processes that carry this profile's --user-data-dir, and its signal is sent
// only to a process whose command line carries it, checked again right before;
// any other process is refused with an error, never signalled.
import { execFile, execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { OBSIDIAN_SETTINGS_FILE, obsidianUserDataDir } from '../../../src/projection/obsidian/publication/vault-list.mjs'
import { launchPlan, runLaunchPlan, urlProcessed } from '../../../src/runtime/obsidian/launch-plan.mjs'
import { appAnswered } from '../../../src/runtime/obsidian/app-capability.mjs'
import { createAppQuitter } from '../../../src/runtime/obsidian/app-restart.mjs'

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

// `settings`: the settings file the profile starts with; null for none, as for an Obsidian that never started.
export function createIsolatedApp({ parent = process.env.ATELIER_OBSIDIAN_TMP || '/tmp', vaults = {}, settings, platform = process.platform } = {}) {
  if (platform !== 'darwin') throw new Error('the isolated app suite is qualified on macOS only')
  const root = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'atelier-first-open-')))
  const home = path.join(root, 'home')
  const runtime = path.join(root, 'runtime')
  const userDataDir = obsidianUserDataDir({ platform, env: { HOME: home } })
  fs.mkdirSync(userDataDir, { recursive: true })
  fs.mkdirSync(runtime, { mode: 0o700 })
  // The app runs the newest app build in its profile; the pinned one, when given, is the one qualified.
  if (process.env.ATELIER_OBSIDIAN_ASAR) fs.copyFileSync(process.env.ATELIER_OBSIDIAN_ASAR, path.join(userDataDir, path.basename(process.env.ATELIER_OBSIDIAN_ASAR)))
  if (settings !== null) fs.writeFileSync(path.join(userDataDir, OBSIDIAN_SETTINGS_FILE), JSON.stringify(settings ?? { vaults, cli: true, updateDisabled: true }))
  const { XDG_CONFIG_HOME: _config, ...inherited } = process.env
  const env = { ...inherited, HOME: home, XDG_RUNTIME_DIR: runtime }
  const marker = `--user-data-dir=${userDataDir}`
  const processProbe = isolatedProcessProbe(userDataDir)
  const pids = () => { try { return pidsIn(execFileSync('/bin/ps', ['-ww', '-A', '-o', 'pid=,command='], { encoding: 'utf8' }), marker) } catch { return [] } }
  const socket = path.join(home, '.obsidian-cli.sock')
  const ps = (args) => execFileSync('/bin/ps', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024, timeout: 5000, killSignal: 'SIGKILL' })
  const carriesMarker = (pid) => { try { const line = ps(['-ww', '-o', 'command=', '-p', String(pid)]).trim(); const at = line.indexOf(` ${marker}`) + 1; return at > 0 && (at + marker.length === line.length || line[at + marker.length] === ' ') } catch { return false } }
  const quitter = createAppQuitter({
    platform, uid: process.getuid(), processProbe,
    readTable: () => { const own = pids(); return own.length === 0 ? '' : ps(['-ww', '-o', 'pid=,ppid=,uid=,comm=', '-p', own.join(',')]) },
    readProcess: (pid) => (carriesMarker(pid) ? ps(['-ww', '-o', 'ppid=,uid=,lstart=,comm=', '-p', String(pid)]) : null),
    signal: (pid) => {
      if (!carriesMarker(pid)) throw new Error(`refused to signal ${pid}: it is not this isolated app`)
      process.kill(pid, 'SIGTERM')
    },
  })

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
    root, home, userDataDir, env, processProbe, cli, cliPath: CLI_PATH, quitter, pids,
    settingsFile: path.join(userDataDir, OBSIDIAN_SETTINGS_FILE),
    running: () => processProbe() === 'running',
    // Starts the app on the vaults its list marks open, and waits until its command line answers: with a version, or,
    // with `anyAnswer`, with any answer of the app itself (its command line off, no vault open).
    async launch({ readyTimeoutMs = 60000, anyAnswer = false } = {}) {
      start(null)
      const until = Date.now() + readyTimeoutMs
      while (Date.now() < until) {
        if (fs.existsSync(socket)) {
          const reply = await cli(['version'], { timeoutMs: 5000 })
          if (!reply.failed && /^\d+\.\d+\.\d+/.test(reply.stdout.trim())) return reply.stdout.trim()
          if (anyAnswer && appAnswered({ stdout: reply.stdout, stderr: reply.stderr, exited: !reply.failed }) && !/^error: command/i.test(`${reply.stdout}${reply.stderr}`.trim())) return `${reply.stdout}${reply.stderr}`.trim()
        }
        await sleep(300)
      }
      throw new Error('the isolated Obsidian did not answer its command line in time')
    },
    // `open`'s launcher for this app, carried out like the production launcher (launch-plan.mjs), with this app's
    // private start and its own tool: never the operating system's URL opener.
    launcher: {
      startPlain: async () => { start(null); return true },
      open({ vaultId = null, vaultPath = null, appRunning, startedByThisOpen = false }) {
        return runLaunchPlan(launchPlan({ platform: 'darwin', appRunning, vaultId, vaultPath }), {
          startedEarlier: startedByThisOpen === true,
          start: async () => { start(null); return true },
          answered: async () => { if (!fs.existsSync(socket)) return false; const reply = await cli(['version'], { timeoutMs: 5000 }); return appAnswered({ stdout: reply.stdout, stderr: reply.stderr, exited: !reply.failed }) },
          handLink: async (uri) => urlProcessed((await cli([uri])).stdout),
          osOpen: async () => false,
          waitMs: 60000, pollMs: 300,
        })
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
