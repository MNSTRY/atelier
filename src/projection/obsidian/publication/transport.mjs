import { execFile, execFileSync } from 'node:child_process'
import { POLICY_SETTINGS_PATH, buildEvalCode, createInProcessHost, runInProcess, validatePayload } from './bridge-script.mjs'

// Editor coordination adapter.
//
//   adapter.probe({ vaultRoot })  -> { state: 'coordinated' | 'absent' | 'uncoordinated', reason }
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

const READ_RETRIES = 2

export function createEditorAdapter({ call, processProbe, kind = 'custom' }) {
  if (typeof call !== 'function') throw new TypeError('createEditorAdapter needs a call function')
  if (typeof processProbe !== 'function') throw new TypeError('createEditorAdapter needs a processProbe function')
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
    // that does not answer for this exact vault is `uncoordinated`.
    probe: ({ vaultRoot }) => serialized(async () => {
      let processes
      try { processes = await processProbe() } catch { processes = 'unknown' }
      if (processes === 'absent') return { state: 'absent', reason: 'no Obsidian process is running' }
      try {
        const reply = await readOnly({ op: 'inspect', vaultRoot, path: POLICY_SETTINGS_PATH })
        // `path-unsafe` for the probe path still proves the app answered for this vault; the settings unit reports the path.
        if (['inspected', 'path-unsafe'].includes(reply.status) && reply.vaultBasePath === vaultRoot) return { state: 'coordinated', reason: 'the app answered for this vault' }
        return { state: 'uncoordinated', reason: reply.status === 'vault-mismatch' ? 'the app answered for another vault' : `the app answered ${reply.status}` }
      } catch (error) {
        return { state: 'uncoordinated', reason: `an Obsidian process may be running and the bridge did not answer: ${String(error.message || error).slice(0, 200)}` }
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

// The CLI reaches the app through a socket under $HOME, so `env` selects the
// app instance. It is passed explicitly and never edited here. A call that
// outlives its timeout is killed with SIGKILL: the CLI ignores SIGTERM while
// it waits on the app.
export function createObsidianCliCall({ cliPath = defaultCliPath(), env = process.env, timeoutMs = 20000 } = {}) {
  return (payload) => new Promise((resolve, reject) => {
    execFile(cliPath, ['eval', `code=${buildEvalCode(payload)}`], { env, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
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
//          builds. A distribution that runs the app under a system Electron
//          shows only `electron`, and which app it hosts is not known.
//
// The command-line tool is a client of the app, not the app: counting it would
// make every call this package makes through it look like a running app.
const APP_EXECUTABLE = Object.freeze({ darwin: /^obsidian(?: helper\b.*)?$/i, linux: /^obsidian$/i })
const ELECTRON_HOST = /^\.?electron(?:\d+|-wrap.*)?$/i

// Default process probe: 'absent' only when the process table was read and
// holds no Obsidian. Limits: it sees this machine's processes as this user
// can list them; it cannot see an app on another machine that reaches the
// vault through a shared or synchronized folder, an app packaged under another
// executable name, or an app that starts after the probe. Anything it cannot
// establish is 'unknown', which the adapter treats as a running app: an empty
// table, a failed read, and on Linux a system Electron process.
export function defaultObsidianProcessProbe({ platform = process.platform, run = execFileSync } = {}) {
  if (!Object.hasOwn(APP_EXECUTABLE, platform)) return 'unknown'
  try {
    const table = run('/bin/ps', ['-A', '-o', 'comm='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 })
    if (typeof table !== 'string' || table.trim() === '') return 'unknown'
    const names = table.split('\n').map((line) => line.trim()).filter((line) => line !== '').map((line) => line.slice(line.lastIndexOf('/') + 1))
    if (names.some((name) => APP_EXECUTABLE[platform].test(name))) return 'running'
    return platform === 'linux' && names.some((name) => ELECTRON_HOST.test(name)) ? 'unknown' : 'absent'
  } catch {
    return 'unknown'
  }
}

export function createObsidianCliAdapter({ cliPath, env, timeoutMs, processProbe = () => defaultObsidianProcessProbe() } = {}) {
  return createEditorAdapter({ call: createObsidianCliCall({ cliPath, env, timeoutMs }), processProbe, kind: 'obsidian-cli' })
}
