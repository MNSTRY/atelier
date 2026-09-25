import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { atomicReplacePrivateText, ensureContainedPrivateDirectory, openRegularFileNoFollow, readRegularTextNoFollow } from '../../project/private-state.mjs'
import { ObsidianContractRefusal, assertObsidianContract } from '../../projection/obsidian/contracts.mjs'
import { canonicalJson, closedObject } from './documents.mjs'
import { refuse } from './errors.mjs'
import { LOOPBACK_HOSTS } from './service-client.mjs'

// Private documents of the maintenance service of one workspace, under
//
//   <data>/obsidian/<workspace-id>/state/service/
//     runtime.json     the adapter record of the running service (service-state v1)
//     settings.json    what this machine chose: loopback host, port, startup consent
//     last-error.json  the last tick that failed for a reason nobody typed
//     service.log      the operational log of the service process
//     start-lock/      serializes `start` for this workspace
//
// Owner-only, replaced atomically, outside every repository and every vault.
// Every document is validated on every read. One that does not validate, or
// that names another workspace, service or state location, refuses: it is
// never repaired, never adopted and never overwritten without a person.

export const SERVICE_SETTINGS_SCHEMA = 'atelier-obsidian-service-settings/v1'
export const SERVICE_ERROR_SCHEMA = 'atelier-obsidian-service-last-error/v1'
export const CONSENT_COVERAGES = Object.freeze(['service', 'service-and-startup'])

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const BEARER = /^[A-Za-z0-9_-]{43}$/

export function serviceNameFor(workspaceId) {
  const name = `atelier-obsidian-${workspaceId}`
  if (!IDENTIFIER.test(name)) refuse('invalid-workspace-identity', 'the workspace identity cannot name a service')
  return name
}

export function servicePaths(workspaceRoot) {
  const directory = path.join(workspaceRoot, 'state', 'service')
  return {
    stateLocation: path.join(workspaceRoot, 'state'), directory, record: path.join(directory, 'runtime.json'), settings: path.join(directory, 'settings.json'),
    lastError: path.join(directory, 'last-error.json'), log: path.join(directory, 'service.log'), startLock: path.join(directory, 'start-lock'),
  }
}

const serviceDirectory = (workspaceRoot) => ensureContainedPrivateDirectory({ workspaceRoot, directory: servicePaths(workspaceRoot).directory, label: 'Obsidian service state' })

function readJson(file, code, label) {
  let text
  try { text = readRegularTextNoFollow(file) } catch (error) {
    if (error.code === 'ENOENT') return null
    refuse(code, `${label} cannot be read`, { cause: error.code ?? String(error.message) })
  }
  try { return JSON.parse(text) } catch { return refuse(code, `${label} is not JSON`) }
}

// The identity of what runs: the service entry module and the digest of its bytes.
export function executableIdentity(entryPath) {
  const resolved = fs.realpathSync(entryPath)
  return { path: resolved, digest: `sha256:${createHash('sha256').update(fs.readFileSync(resolved)).digest('hex')}` }
}

// The package this module ships in.
const PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const byName = (left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
const releases = new Map()

// The release that runs, beyond its entry module: the version of the package
// and a digest of the runtime it ships, by relative path and content. That is
// what the service loads: every module under `src/`, and the `contracts/` it
// reads; outside `src/` it reads nothing else of the package but the version
// in `package.json`. A release that changes any of it, and not only the
// entry, differs. Computed once per process and package root, so a service
// keeps the identity of the code it loaded.
export function releaseIdentity({ root = PACKAGE_ROOT } = {}) {
  if (!releases.has(root)) {
    const hash = createHash('sha256')
    const walk = (relative) => {
      for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort(byName)) {
        const child = `${relative}/${entry.name}`
        if (entry.isDirectory()) walk(child)
        else if (entry.isFile()) hash.update(`${child}\0${createHash('sha256').update(fs.readFileSync(path.join(root, child))).digest('hex')}\n`)
      }
    }
    for (const part of ['src', 'contracts']) walk(part)
    let version = null
    try { const read = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version; version = typeof read === 'string' ? read : null } catch { version = null }
    releases.set(root, Object.freeze({ version, digest: `sha256:${hash.digest('hex')}` }))
  }
  return releases.get(root)
}

// ---------------------------------------------------------------------------
// The adapter record
// ---------------------------------------------------------------------------

export function validateServiceRecord(document, { workspaceRoot, workspaceId }) {
  const code = 'invalid-service-record'
  try { assertObsidianContract('service-state', document) } catch (error) {
    if (error instanceof ObsidianContractRefusal) refuse(code, 'the service record does not satisfy its contract', { errors: error.detail?.errors ?? [] })
    throw error
  }
  if (document.workspaceId !== workspaceId || document.serviceName !== serviceNameFor(workspaceId)) refuse(code, 'the service record belongs to another workspace or service')
  if (document.stateLocation !== servicePaths(workspaceRoot).stateLocation) refuse(code, 'the service record names another state location')
  if (!path.isAbsolute(document.executable.path)) refuse(code, 'the service record names an executable that is not an absolute path')
  // The bearer of the running service lives here and nowhere else.
  closedObject(document.ext, { required: ['bearer'] }, code, 'the private part of the service record')
  if (typeof document.ext.bearer !== 'string' || !BEARER.test(document.ext.bearer)) refuse(code, 'the service record carries no usable bearer')
  return document
}

export function readServiceRecord({ workspaceRoot, workspaceId }) {
  const document = readJson(servicePaths(workspaceRoot).record, 'invalid-service-record', 'the service record')
  return document === null ? null : validateServiceRecord(document, { workspaceRoot, workspaceId })
}

export function writeServiceRecord({ workspaceRoot, workspaceId, record }) {
  validateServiceRecord(record, { workspaceRoot, workspaceId })
  atomicReplacePrivateText(path.join(serviceDirectory(workspaceRoot), 'runtime.json'), canonicalJson(record))
  return record
}

// Removes the record only while it still names this runtime and PID. Nothing else is ever removed here.
export function removeServiceRecord({ workspaceRoot, workspaceId, runtimeId, pid }) {
  let current
  try { current = readServiceRecord({ workspaceRoot, workspaceId }) } catch { return false }
  if (current === null || current.runtimeId !== runtimeId || current.pid !== pid) return false
  try { fs.unlinkSync(servicePaths(workspaceRoot).record); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

// What may be shown: everything but the bearer.
export function publicRecord(record) {
  if (record === null) return null
  const { ext: _private, ...shown } = record
  return shown
}

// ---------------------------------------------------------------------------
// Machine-specific service settings
// ---------------------------------------------------------------------------

function validateServiceSettings(document, workspaceId) {
  const code = 'invalid-service-settings'
  closedObject(document, { required: ['schema', 'workspaceId', 'host', 'port', 'consent', 'updatedAt'] }, code, 'service settings')
  if (document.schema !== SERVICE_SETTINGS_SCHEMA || document.workspaceId !== workspaceId) refuse(code, 'service settings name an unknown schema or another workspace')
  if (!LOOPBACK_HOSTS.includes(document.host)) refuse(code, 'the service host must be the literal 127.0.0.1 or ::1')
  if (!Number.isInteger(document.port) || document.port < 1024 || document.port > 65535) refuse(code, 'the service port must be between 1024 and 65535')
  closedObject(document.consent, { required: ['grantedAt', 'actor', 'coverage'] }, code, 'the startup consent')
  if (!TIMESTAMP.test(document.consent.grantedAt) || typeof document.consent.actor !== 'string' || !IDENTIFIER.test(document.consent.actor) || !CONSENT_COVERAGES.includes(document.consent.coverage)) refuse(code, 'the startup consent is malformed')
  if (typeof document.updatedAt !== 'string' || !TIMESTAMP.test(document.updatedAt)) refuse(code, 'updatedAt must be a UTC timestamp')
  return document
}

export function readServiceSettings({ workspaceRoot, workspaceId }) {
  const document = readJson(servicePaths(workspaceRoot).settings, 'invalid-service-settings', 'service settings')
  return document === null ? null : validateServiceSettings(document, workspaceId)
}

export function writeServiceSettings({ workspaceRoot, workspaceId, settings }) {
  validateServiceSettings(settings, workspaceId)
  atomicReplacePrivateText(path.join(serviceDirectory(workspaceRoot), 'settings.json'), canonicalJson(settings))
  return settings
}

// ---------------------------------------------------------------------------
// The last untyped tick error, and the operational log
// ---------------------------------------------------------------------------

function validateLastError(document, workspaceId) {
  const code = 'invalid-service-last-error'
  closedObject(document, { required: ['schema', 'workspaceId', 'runtimeId', 'code', 'name', 'at', 'consecutiveFailures', 'totalFailures', 'resolvedAt'] }, code, 'the last service error')
  const ok = document.schema === SERVICE_ERROR_SCHEMA && document.workspaceId === workspaceId && typeof document.runtimeId === 'string' && IDENTIFIER.test(document.runtimeId)
    && typeof document.code === 'string' && document.code.length <= 64 && typeof document.name === 'string' && document.name.length <= 64 && TIMESTAMP.test(document.at)
    && Number.isInteger(document.consecutiveFailures) && document.consecutiveFailures >= 0 && Number.isInteger(document.totalFailures) && document.totalFailures >= 1
    && (document.resolvedAt === null || TIMESTAMP.test(document.resolvedAt))
  if (!ok) refuse(code, 'the last service error is malformed')
  return document
}

export function readLastServiceError({ workspaceRoot, workspaceId }) {
  const document = readJson(servicePaths(workspaceRoot).lastError, 'invalid-service-last-error', 'the last service error')
  return document === null ? null : validateLastError(document, workspaceId)
}

// An error code and class only: a message can carry a path or a title, and goes to the private log instead.
export function writeLastServiceError({ workspaceRoot, workspaceId, document }) {
  validateLastError(document, workspaceId)
  atomicReplacePrivateText(path.join(serviceDirectory(workspaceRoot), 'last-error.json'), canonicalJson(document))
  return document
}

// The log is bounded: past the ceiling it becomes the one previous log, and a new one begins.
export const SERVICE_LOG_MAX_BYTES = 1024 * 1024

export function openServiceLog(workspaceRoot) {
  const file = path.join(serviceDirectory(workspaceRoot), 'service.log')
  try { if (fs.lstatSync(file).size > SERVICE_LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`) } catch (error) { if (error.code !== 'ENOENT') throw error }
  return { file, descriptor: openRegularFileNoFollow(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND, 0o600) }
}
