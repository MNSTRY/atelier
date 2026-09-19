import childProcess from 'node:child_process'
import { randomBytes as cryptoRandomBytes } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import { isoTime } from './documents.mjs'
import { refuse } from './errors.mjs'
import { ensureWorkspaceIdentity } from './machine-settings.mjs'
import { acquirePrivateGenerationLock, createAbandonmentProof, isProcessAlive } from './private-lock.mjs'
import { DEFAULT_PROBE_TIMEOUT_MS, LOOPBACK_HOSTS, probeHealth, requestLoopback } from './service-client.mjs'
import { SERVICE_ENTRY_PATH } from './service-main.mjs'
import {
  CONSENT_COVERAGES, SERVICE_SETTINGS_SCHEMA, executableIdentity, openServiceLog, publicRecord, readServiceRecord, readServiceSettings, removeServiceRecord,
  serviceNameFor, servicePaths, writeServiceSettings,
} from './service-record.mjs'
import { resolveServiceWorkspace } from './service.mjs'

// start / status / stop of the maintenance service of one workspace, as
// docs/local-services.md describes them.
//
// Ownership is proven, never assumed. A running service is ours only when the
// owner-only record and the health answer agree on service name, workspace,
// runtime identifier, PID, executable digest and literal loopback address,
// and that PID is alive. Anything else that answers on the port is
// `occupied`: it is not adopted, not stopped and not replaced. A record whose
// address refuses connections is `stale-record` when its PID is gone and
// `pid-not-ours` when that PID is alive (the number was reused, or a process
// outlived its listener): such a PID is never signalled.
//
// Nothing here looks a process up by port, name or pattern, and nothing here
// removes anything but the one generated record.

export const SERVICE_STATES = Object.freeze(['stopped', 'healthy', 'occupied', 'stale-record', 'pid-not-ours'])
export const DEFAULT_START_TIMEOUT_MS = 20 * 1000
export const DEFAULT_STOP_TIMEOUT_MS = 45 * 1000

const AGREEMENT = ['serviceName', 'workspaceId', 'runtimeId', 'pid', 'host', 'port']
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

// The decisions the lifecycle oracles are sensitive to; tests substitute broken ones to prove the oracles can fail.
export const LIFECYCLE_PRIMITIVES = Object.freeze({
  // Every field the record and the health answer must agree on; the names of those that differ.
  disagreements(record, health) {
    const differing = AGREEMENT.filter((field) => record[field] !== health[field])
    if (record.executable.digest !== health.executableDigest) differing.push('executableDigest')
    return differing
  },
  // Whether start may report a running service as this workspace's own instead of creating one.
  isOurs: (status) => status.state === 'healthy',
  // Whether start gives up because something unproven answers on the port.
  refusesOccupied: (status) => status.state === 'occupied',
  // Whether a stop may be sent at all.
  mayStop: (status) => status.state === 'healthy',
})

function context({ loadProject, dataRoot, env, platform, create = false, randomBytes }) {
  if (typeof loadProject !== 'function') throw new TypeError('the service lifecycle needs loadProject')
  const project = loadProject()
  if (create) ensureWorkspaceIdentity({ project, ...(randomBytes ? { randomBytes } : {}) })
  const workspace = resolveServiceWorkspace({ project, dataRoot, env, platform, create })
  return { project, workspace }
}

async function evaluate({ workspaceRoot, workspaceId }, { probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS, alive = isProcessAlive, rules = LIFECYCLE_PRIMITIVES } = {}) {
  // A malformed or foreign record refuses right here, typed; it is never repaired and never adopted.
  const record = readServiceRecord({ workspaceRoot, workspaceId })
  const settings = readServiceSettings({ workspaceRoot, workspaceId })
  const address = record ? { host: record.host, port: record.port } : settings ? { host: settings.host, port: settings.port } : null
  const base = { workspaceId, serviceName: serviceNameFor(workspaceId), address, record, logPath: servicePaths(workspaceRoot).log }
  if (address === null) return { ...base, state: 'stopped', reason: 'never-started' }
  const answer = await probeHealth({ ...address, timeoutMs: probeTimeoutMs })
  if (record === null) return answer.kind === 'refused' ? { ...base, state: 'stopped', reason: 'no-record-and-nothing-listens' } : { ...base, state: 'occupied', reason: 'a-listener-without-a-record', answer: answer.kind }
  if (answer.kind === 'refused') return alive(record.pid) ? { ...base, state: 'pid-not-ours', reason: 'recorded-pid-is-alive-but-nothing-listens' } : { ...base, state: 'stale-record', reason: 'recorded-pid-is-gone' }
  if (answer.kind !== 'health') return { ...base, state: 'occupied', reason: answer.kind === 'timeout' ? 'listener-did-not-answer-in-time' : 'listener-is-not-this-service', answer: answer.kind }
  const differing = rules.disagreements(record, answer.body)
  if (differing.length > 0) return { ...base, state: 'occupied', reason: 'health-identity-differs', disagreements: differing }
  if (!alive(record.pid)) return { ...base, state: 'occupied', reason: 'recorded-pid-is-gone-but-something-answers' }
  return { ...base, state: 'healthy', reason: 'record-and-health-agree', health: answer.body }
}

const shown = ({ record, ...status }) => ({ ...status, record: publicRecord(record) })

export async function serviceStatus({ loadProject, dataRoot, env = process.env, platform = process.platform, probeTimeoutMs, alive } = {}, rules = LIFECYCLE_PRIMITIVES) {
  const { workspace } = context({ loadProject, dataRoot, env, platform })
  if (!workspace?.workspaceRoot) return { state: 'stopped', reason: 'workspace-not-prepared', workspaceId: workspace?.workspaceId ?? null, record: null, address: null }
  return shown(await evaluate(workspace, { probeTimeoutMs, alive, rules }))
}

// A port nobody listens on right now, chosen once and then recorded, so later starts, status and an installed unit all name the same one.
function freeLoopbackPort(host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen({ host, port: 0, exclusive: true }, () => { const { port } = server.address(); server.close(() => resolve(port)) })
  })
}

async function resolveSettings({ workspaceRoot, workspaceId }, { host, port, consent, now }) {
  const current = readServiceSettings({ workspaceRoot, workspaceId })
  if (host !== undefined && !LOOPBACK_HOSTS.includes(host)) refuse('service-address-not-loopback', 'the service host must be the literal 127.0.0.1 or ::1')
  if (port !== undefined && (!Number.isInteger(port) || port < 1024 || port > 65535)) refuse('service-address-not-loopback', 'the service port must be between 1024 and 65535')
  if (consent !== undefined && (typeof consent?.actor !== 'string' || !CONSENT_COVERAGES.includes(consent.coverage ?? 'service'))) refuse('startup-consent-required', 'a consent names its actor and what it covers')
  if (current === null && consent === undefined) refuse('startup-consent-required', 'the first start of this workspace needs an explicit consent naming its actor')
  const nextHost = host ?? current?.host ?? '127.0.0.1'
  const next = {
    schema: SERVICE_SETTINGS_SCHEMA, workspaceId, host: nextHost, port: port ?? (current && current.host === nextHost ? current.port : await freeLoopbackPort(nextHost)),
    consent: consent === undefined || (current && current.consent.actor === consent.actor && current.consent.coverage === (consent.coverage ?? 'service')) ? current.consent : { grantedAt: now, actor: consent.actor, coverage: consent.coverage ?? 'service' },
    updatedAt: now,
  }
  const changed = current === null || ['host', 'port'].some((key) => current[key] !== next[key]) || current.consent !== next.consent
  return changed ? writeServiceSettings({ workspaceRoot, workspaceId, settings: next }) : current
}

export async function startService(options = {}, rules = LIFECYCLE_PRIMITIVES) {
  const {
    loadProject, dataRoot, host, port, consent, detached = false, entryPath = SERVICE_ENTRY_PATH, entryArgs = [], intervalMs,
    startTimeoutMs = DEFAULT_START_TIMEOUT_MS, probeTimeoutMs, clock = () => new Date(), env = process.env, platform = process.platform,
    spawn = childProcess.spawn, execPath = process.execPath, alive = isProcessAlive, randomBytes = cryptoRandomBytes,
  } = options
  const { project, workspace } = context({ loadProject, dataRoot, env, platform, create: true })
  const { workspaceRoot, workspaceId } = workspace
  const deadline = Date.now() + startTimeoutMs

  // One start at a time per workspace. A start is bounded by its own deadline, so a holder far older than that is gone.
  const proveAbandoned = createAbandonmentProof({ alive, maxAgeMs: startTimeoutMs * 4 })
  let lock
  for (;;) {
    lock = await acquirePrivateGenerationLock({ workspaceRoot, directory: servicePaths(workspaceRoot).startLock, workspaceId, purpose: 'service-start', clock, proveAbandoned })
    if (lock.acquired) break
    const meanwhile = await evaluate(workspace, { probeTimeoutMs, alive, rules })
    if (rules.isOurs(meanwhile)) return { ...shown(meanwhile), started: false, alreadyRunning: true }
    if (Date.now() >= deadline) refuse('service-start-in-progress', 'another start of this workspace holds the start lock', { reason: lock.reason })
    await sleep(100)
  }

  let child = null
  try {
    const before = await evaluate(workspace, { probeTimeoutMs, alive, rules })
    if (rules.isOurs(before)) return { ...shown(before), started: false, alreadyRunning: true }
    if (rules.refusesOccupied(before)) refuse('service-port-occupied', 'something that is not this service answers on the loopback port; it is never taken over', { reason: before.reason, address: before.address })
    // `stale-record` and `pid-not-ours`: nothing listens, so the recorded runtime is not serving. Its PID is never signalled;
    // the new service replaces the record once it listens. Nothing under recovery or staging is touched on the way.
    const settings = await resolveSettings(workspace, { host, port, consent, now: isoTime(clock) })
    if (before.address && (before.address.host !== settings.host || before.address.port !== settings.port)) {
      const moved = await probeHealth({ host: settings.host, port: settings.port, timeoutMs: probeTimeoutMs })
      if (moved.kind !== 'refused') refuse('service-port-occupied', 'something already answers on the selected loopback port; it is never taken over', { address: { host: settings.host, port: settings.port } })
    }

    const runtimeId = `rt-${randomBytes(16).toString('hex')}`
    const executable = executableIdentity(entryPath)
    const log = openServiceLog(workspaceRoot)
    try {
      const args = [executable.path, `--project=${project.configPath}`, ...(dataRoot === undefined ? [] : [`--data-root=${dataRoot}`]), `--runtime-id=${runtimeId}`, ...(intervalMs === undefined ? [] : [`--interval-ms=${intervalMs}`]), ...entryArgs]
      // No shell. Detached only when the service is meant to outlive the command that starts it.
      child = spawn(execPath, args, { detached, shell: false, windowsHide: true, stdio: ['ignore', log.descriptor, log.descriptor], env })
    } finally {
      fs.closeSync(log.descriptor)
    }
    let exited = null
    child.once('exit', (code, signal) => { exited = { code, signal } })
    child.once('error', (error) => { exited = { code: null, signal: null, error: error.code ?? 'spawn-failed' } })

    // Health must echo the runtime identifier generated here and the PID of the child created here.
    let last = null
    while (Date.now() < deadline && exited === null) {
      last = await evaluate(workspace, { probeTimeoutMs, alive, rules }).catch((error) => ({ state: 'refused', reason: error.code ?? 'untyped-error' }))
      if (last.state === 'healthy' && last.record.runtimeId === runtimeId && last.record.pid === child.pid) {
        if (detached) child.unref()
        return { ...shown(last), started: true, alreadyRunning: false, ...(detached ? {} : { child }) }
      }
      await sleep(50)
    }
    // Ownership was never proven: only the child created here is stopped, by its handle.
    if (exited === null) { child.kill(); const until = Date.now() + 5000; while (exited === null && Date.now() < until) await sleep(25) }
    removeServiceRecord({ workspaceRoot, workspaceId, runtimeId, pid: child.pid })
    return { state: 'start-failed', started: false, alreadyRunning: false, workspaceId, reason: exited?.error ?? (exited?.code === null || exited === null ? 'health-never-proved-ownership' : `service-exited-${exited.code}`), observed: last?.state ?? null, logPath: log.file }
  } finally {
    lock.release()
  }
}

export async function stopService(options = {}, rules = LIFECYCLE_PRIMITIVES) {
  const { loadProject, dataRoot, stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS, probeTimeoutMs, env = process.env, platform = process.platform, alive = isProcessAlive, force = false, kill = process.kill.bind(process) } = options
  const { workspace } = context({ loadProject, dataRoot, env, platform })
  if (!workspace?.workspaceRoot) return { state: 'stopped', stopped: false, refused: false, reason: 'workspace-not-prepared' }
  const { workspaceRoot, workspaceId } = workspace
  const status = await evaluate(workspace, { probeTimeoutMs, alive, rules })
  if (status.state === 'stopped') return { ...shown(status), stopped: false, refused: false }
  // Any disagreement refuses. Nothing is signalled, and the record stays for a person to look at.
  if (!rules.mayStop(status)) return { ...shown(status), stopped: false, refused: true }

  const { record } = status
  const answer = await requestLoopback({ host: record.host, port: record.port, method: 'POST', path: '/stop', bearer: record.ext.bearer, payload: { runtimeId: record.runtimeId }, timeoutMs: probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS * 5 })
  const accepted = answer.kind === 'response' && answer.statusCode === 202 && answer.body?.runtimeId === record.runtimeId && answer.body?.pid === record.pid
  if (!accepted) return { ...shown(status), stopped: false, refused: true, reason: 'stop-was-not-accepted-by-the-proven-runtime' }
  const until = Date.now() + stopTimeoutMs
  while (alive(record.pid) && Date.now() < until) await sleep(50)
  if (alive(record.pid)) {
    // Escalation is opt-in and proven again first: the same runtime and PID must still answer.
    const again = force ? await evaluate(workspace, { probeTimeoutMs, alive, rules }).catch(() => null) : null
    if (!(again?.state === 'healthy' && again.record.runtimeId === record.runtimeId && again.record.pid === record.pid)) return { ...shown(status), stopped: false, refused: true, reason: 'stop-timed-out' }
    kill(record.pid, 'SIGKILL')
    while (alive(record.pid) && Date.now() < until + 5000) await sleep(50)
  }
  // The service removes its own record on the way out; after a hard end it is removed here, and only if it still names that runtime.
  removeServiceRecord({ workspaceRoot, workspaceId, runtimeId: record.runtimeId, pid: record.pid })
  return { state: 'stopped', stopped: true, refused: false, reason: 'stopped-the-proven-runtime', workspaceId, runtimeId: record.runtimeId, pid: record.pid }
}
