import { execFile, execFileSync } from 'node:child_process'
import { readlinkSync } from 'node:fs'
import path from 'node:path'
import { POLICY_SETTINGS_PATH, buildEvalCode, createInProcessHost, runInProcess, validatePayload } from './bridge-script.mjs'
import { obsidianUserDataDir, readObsidianSettings, vaultRoute } from './vault-list.mjs'

// Editor coordination adapter.
//
//   adapter.probe({ vaultRoot })  -> { state: 'coordinated' | 'absent' | 'uncoordinated', reason, code? }
//   adapter.inspect(payload)      -> reply          read-only, may retry
//   adapter.collect(payload)      -> reply          read-only, may retry
//   adapter.publish(payload)      -> reply          sent at most once
//
// A raw `call(payload)` sends one payload once and resolves with the parsed
// reply. It throws TransportTimeout when the reply did not arrive in time and
// any other error when the call could not be made. createEditorAdapter adds
// the rules every transport must follow: calls are serialized, read-only calls
// may retry, and a publish is never resent. When a publish reply is lost the
// recorded outcome is re-read from the app; when none is recorded the caller
// is told so and reconciles from the files themselves.

export class TransportTimeout extends Error {
  constructor(message) {
    super(message)
    this.name = 'TransportTimeout'
    this.code = 'transport-timeout'
  }
}

// A call that no route can take: the app's list says no call reaches only
// this vault. `code` says why; the call is never made.
export class RouteRefusal extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`)
    this.name = 'RouteRefusal'
    this.code = code
  }
}

const READ_RETRIES = 2

// `qualification`, when given, is the app qualification this adapter was
// constructed under (`qualifyApp`). An adapter qualified while no app ran was
// never shown a version, so it never coordinates with an app found running
// later, whose version nobody checked: it is `uncoordinated` until an adapter
// qualified with a checked version replaces it. Without a qualification the
// adapter coordinates as before.
export function createEditorAdapter({ call, processProbe, kind = 'custom', qualification }) {
  if (typeof call !== 'function') throw new TypeError('createEditorAdapter needs a call function')
  if (typeof processProbe !== 'function') throw new TypeError('createEditorAdapter needs a processProbe function')
  const versionUnchecked = qualification !== undefined && qualification?.versionChecked !== true
  const retries = []
  let tail = Promise.resolve()
  const serialized = (operation) => {
    const next = tail.then(operation, operation)
    tail = next.catch(() => {})
    return next
  }
  const readOnly = async (payload) => {
    for (let attempt = 0; ; attempt += 1) {
      try { return await call(validatePayload(payload)) } catch (error) {
        if (attempt >= READ_RETRIES || !(error instanceof TransportTimeout)) throw error
        retries.push(payload.op)
      }
    }
  }
  return {
    kind,
    transportRetries: retries,
    inspect: (payload) => serialized(() => readOnly({ ...payload, op: 'inspect' })),
    collect: (payload) => serialized(() => readOnly({ ...payload, op: 'collect' })),
    publish: (payload) => serialized(async () => {
      validatePayload(payload)
      if (payload.op !== 'publish') throw new TypeError('publish needs a publish payload')
      try { return await call(payload) } catch (error) {
        retries.push(error instanceof TransportTimeout ? 'publish-reply-lost' : 'publish-call-failed')
        let record = null
        try { record = await readOnly({ op: 'collect', vaultRoot: payload.vaultRoot, path: payload.path }) } catch { /* the app is not answering */ }
        if (record && record.operationId === payload.operationId && typeof record.outcome === 'string') return { ...record, status: record.outcome, replyLost: true }
        return { status: 'outcome-unknown', operationId: payload.operationId, wrote: null, replyLost: true, transportError: String(error.message || error).slice(0, 300) }
      }
    }),
    // Path selection. `absent` is returned only when the process probe says,
    // positively, that no Obsidian is running. A running or unknowable app
    // that does not answer for this exact vault is `uncoordinated`, and so is
    // any app while this adapter's qualification checked no version. When no
    // call could be routed to only this vault, `code` names the route's refusal.
    probe: ({ vaultRoot }) => serialized(async () => {
      let processes
      try { processes = await processProbe() } catch { processes = 'unknown' }
      if (processes === 'absent') return { state: 'absent', reason: 'no Obsidian process is running' }
      if (versionUnchecked) return { state: 'uncoordinated', reason: 'app-version-unchecked: an Obsidian process may be running, and this adapter was qualified while none ran, so its version was never checked' }
      try {
        const reply = await readOnly({ op: 'inspect', vaultRoot, path: POLICY_SETTINGS_PATH })
        // `path-unsafe` for the probe path still proves the app answered for this vault; the settings unit reports the path.
        if (['inspected', 'path-unsafe'].includes(reply.status) && reply.vaultBasePath === vaultRoot) return { state: 'coordinated', reason: 'the app answered for this vault' }
        return { state: 'uncoordinated', reason: reply.status === 'vault-mismatch' ? 'the app answered for another vault' : `the app answered ${reply.status}` }
      } catch (error) {
        return { state: 'uncoordinated', ...(error instanceof RouteRefusal ? { code: error.code } : {}), reason: `an Obsidian process may be running and the bridge did not answer: ${String(error.message || error).slice(0, 200)}` }
      }
    }),
  }
}

// ---------------------------------------------------------------------------
// In-process transport: the same script, run here. Used for the path with no
// app, and by tests that supply a host modelling an app.
// ---------------------------------------------------------------------------

export function createInProcessCall(host = createInProcessHost()) {
  return async (payload) => runInProcess(payload, host)
}

export function createDirectAdapter({ crashSeam } = {}) {
  return createEditorAdapter({ call: createInProcessCall(createInProcessHost({ crashSeam })), processProbe: () => 'absent', kind: 'direct' })
}

// ---------------------------------------------------------------------------
// Obsidian CLI transport
// ---------------------------------------------------------------------------

export function defaultCliPath(platform = process.platform) {
  if (platform === 'darwin') return '/Applications/Obsidian.app/Contents/MacOS/obsidian-cli'
  return 'obsidian-cli'
}

// A directory that is no vault, for a call that must not choose one by where it runs.
export const NEUTRAL_DIRECTORY = (() => { try { return path.parse(process.cwd()).root } catch { return path.sep } })()

// The working directory and leading arguments of a call that goes where a
// `vaultRoute` says: into the vault's folder, or naming the vault's id first
// from a directory that is no vault (`neutral`), or, for any other route, from
// that directory naming no vault.
export function routedCall(route, neutral = NEUTRAL_DIRECTORY) {
  if (route?.how === 'folder') return { cwd: route.cwd, args: [] }
  if (route?.how === 'id') return { cwd: neutral, args: [`vault=${route.id}`] }
  return { cwd: neutral, args: [] }
}

// Which window a publication call reaches. The app answers a command in the
// window of the vault its list routes the call to (see vault-list.mjs),
// opening that vault first when it is closed, and otherwise in the vault
// window that had focus last, which may be any vault the person uses. While
// the app lists this vault as open, a call therefore runs in its folder, or,
// when a vault listed at a folder above it would take a call run there, names
// its id; when neither reaches only this vault, no call is made (the error
// says `vault-inside-another-vault`), nor when the app has the vault open in
// more than one window, one per entry of its list that names this folder
// (`vault-open-in-several-windows`): a call would coordinate with one of them
// only. Otherwise a call runs in a directory
// that is no vault and names none: a closed vault is never reopened by
// maintenance, no other vault is reached through this one's folder, and the
// working directory of whoever started the service never picks a vault. The
// script still checks that it answered for exactly this vault.
export function publicationRoute({ env = process.env, platform = process.platform } = {}) {
  const userDataDir = obsidianUserDataDir({ platform, env })
  return (payload) => {
    const settings = readObsidianSettings({ userDataDir })
    const route = settings.ok ? vaultRoute({ vaults: settings.vaults, vaultRoot: payload.vaultRoot, open: true }) : { how: 'unlisted' }
    if (route.how === 'ambiguous') throw new RouteRefusal('vault-inside-another-vault', 'Obsidian lists a vault at a folder above this one, and no call reaches only this vault; no call was made')
    if (route.how === 'duplicated') throw new RouteRefusal('vault-open-in-several-windows', `Obsidian has this vault open in ${route.entries.length} windows (${route.entries.map((entry) => entry.id).join(', ')}), and a call reaches one of them only; no call was made`)
    return routedCall(route)
  }
}

// The CLI reaches the app through a socket under $HOME, so `env` selects the
// app instance. It is passed explicitly and never edited here. A call that
// outlives its timeout is killed with SIGKILL: the CLI ignores SIGTERM while
// it waits on the app. `route(payload)` says where a call runs and what it
// names first ({ cwd, args }); a route that throws makes no call.
export function createObsidianCliCall({ cliPath = defaultCliPath(), env = process.env, timeoutMs = 20000, route = () => routedCall(null) } = {}) {
  return (payload) => new Promise((resolve, reject) => {
    let where
    try { where = route(payload) } catch (error) { return reject(error) }
    execFile(cliPath, [...where.args, 'eval', `code=${buildEvalCode(payload)}`], { env, cwd: where.cwd, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(error.killed ? new TransportTimeout(`CLI call timed out: ${payload.op}`) : new Error(`CLI call failed: ${String(error.message).slice(0, 300)}`))
      const out = stdout || stderr || ''
      const start = out.indexOf('=> ')
      if (start < 0) return reject(new Error(`bridge returned no value: ${JSON.stringify(out.slice(0, 300))}`))
      try { return resolve(JSON.parse(out.slice(start + 3))) } catch { return reject(new Error('bridge returned a value that is not JSON')) }
    })
  })
}

// The app is recognised by the executable a process runs, never by its
// arguments: a path argument with an `obsidian` segment (this package's own
// maintenance service, its private data root) is not the app. `ps -o comm=`
// names the executable as it was started on macOS, usually its full path, and
// by its command name of at most 15 characters on Linux.
//
//   macOS  `Obsidian` and the bundle's `Obsidian Helper…` processes, in any
//          directory: a moved or renamed bundle still counts, and so does a
//          process whose path ps cannot read and names by its short name.
//   Linux  `obsidian`, the executable of the .deb, snap, AppImage and Flatpak
//          builds, by name or, for a name that is not recognised, by the
//          executable it resolves to. A distribution that runs the app under
//          a system Electron shows only `electron`, and which app it hosts is
//          not known.
//
// The command-line tool is a client of the app, not the app: counting it would
// make every call this package makes through it look like a running app.
const APP_EXECUTABLE = Object.freeze({ darwin: /^obsidian(?: helper\b.*)?$/i, linux: /^obsidian$/i })
const ELECTRON_HOST = /^\.?electron(?:\d+|-wrap.*)?$/i
// A `ps` that has not answered by then is killed, and the reading is unknown.
const PS_TIMEOUT_MS = 5000
// A process that exited since the table was read, or whose executable this
// user may not read: another user's process, or one of this user's that hides
// it from tracing (ssh-agent, a sandboxed renderer). Such a process is judged
// by its name alone.
const EXECUTABLE_UNREADABLE = new Set(['ENOENT', 'ESRCH', 'EACCES', 'EPERM'])

const baseName = (text) => text.slice(text.lastIndexOf('/') + 1)
const readProcessExecutable = (pid) => readlinkSync(`/proc/${pid}/exe`)

// Linux names a process after the path it was started through, so an app
// started through a differently named link or launcher shows another name.
// The executable `/proc/<pid>/exe` resolves to does not change with the name.
// Any failure other than the expected ones is unknown, and so is a table in
// which no executable could be resolved at all: without `/proc`, nothing
// below the names can be established.
function resolveLinuxExecutables(rows, readExe) {
  let resolved = 0
  let unknown = false
  for (const { pid } of rows) {
    let target
    try { target = String(readExe(pid)) } catch (error) {
      if (!EXECUTABLE_UNREADABLE.has(error?.code)) unknown = true
      continue
    }
    resolved += 1
    const name = baseName(target.replace(/ \(deleted\)$/, ''))
    if (APP_EXECUTABLE.linux.test(name)) return 'running'
    if (ELECTRON_HOST.test(name)) unknown = true
  }
  return unknown || resolved === 0 ? 'unknown' : 'absent'
}

// Default process probe: 'absent' only when the process table was read and
// holds no Obsidian. Limits: it sees this machine's processes as this user
// can list them; it cannot see an app on another machine that reaches the
// vault through a shared or synchronized folder, an app packaged under another
// executable name, or an app that starts after the probe. Anything it cannot
// establish is 'unknown', which the adapter treats as a running app: an empty
// table, a failed or slow read, and on Linux a system Electron process or an
// executable that cannot be resolved for an unexpected reason.
export function defaultObsidianProcessProbe({ platform = process.platform, run = execFileSync, readExe = readProcessExecutable } = {}) {
  if (!Object.hasOwn(APP_EXECUTABLE, platform)) return 'unknown'
  const linux = platform === 'linux'
  try {
    const table = run('/bin/ps', ['-A', '-o', linux ? 'pid=,comm=' : 'comm='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024, timeout: PS_TIMEOUT_MS, killSignal: 'SIGKILL' })
    if (typeof table !== 'string' || table.trim() === '') return 'unknown'
    const rows = table.split('\n').map((line) => line.trim()).filter((line) => line !== '').map((line) => {
      const match = linux ? /^(\d+)\s+(.*)$/.exec(line) : null
      return match ? { pid: Number(match[1]), comm: match[2] } : { pid: null, comm: line }
    })
    if (rows.some((row) => APP_EXECUTABLE[platform].test(baseName(row.comm)))) return 'running'
    if (!linux) return 'absent'
    if (rows.some((row) => row.pid === null || ELECTRON_HOST.test(baseName(row.comm)))) return 'unknown'
    return resolveLinuxExecutables(rows, readExe)
  } catch {
    return 'unknown'
  }
}

export function createObsidianCliAdapter({ cliPath, env = process.env, timeoutMs, processProbe = () => defaultObsidianProcessProbe(), qualification, route = publicationRoute({ env }) } = {}) {
  return createEditorAdapter({ call: createObsidianCliCall({ cliPath, env, timeoutMs, route }), processProbe, kind: 'obsidian-cli', qualification })
}
