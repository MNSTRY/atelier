import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  atomicReplacePrivateText,
  ensureContainedPrivateDirectory,
  openRegularFileNoFollow,
  readRegularTextNoFollow,
} from '../project/private-state.mjs'
import { runGit } from './git-adapter.mjs'

export const ATELIER_RUNTIME_STATE_SCHEMA = 'atelier-runtime-state@v1'
export const ATELIER_RUNTIME_ENROLLMENT_SCHEMA = 'atelier-runtime-enrollment@v1'
export const ATELIER_RUNTIME_TRACE_SCHEMA = 'atelier-runtime-operation@v1'
export const ATELIER_RUNTIME_TRACE_MAX_BYTES = 2 * 1024 * 1024
export const ATELIER_RUNTIME_TRACE_MAX_RECORDS = 2048
export const ATELIER_RUNTIME_TRACE_MAX_EVENT_BYTES = 256 * 1024
export const ATELIER_RUNTIME_PLAN_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const ATELIER_RUNTIME_PLAN_MAX_FILES = 256
export const ATELIER_RUNTIME_PLAN_MAX_BYTES = 4 * 1024 * 1024
export const ATELIER_RUNTIME_STATE_MAX_BYTES = 512 * 1024
export const ATELIER_RUNTIME_LIVE_OWNER_MAX_AGE_MS = 24 * 60 * 60 * 1000

function lstatIfPresent(file) {
  try {
    return fs.lstatSync(file)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function runtimeWorkspaceRoot(file) {
  const absolute = path.resolve(file)
  const marker = `${path.sep}.atelier-local${path.sep}`
  const index = absolute.lastIndexOf(marker)
  if (index <= 0) throw new Error('runtime state path is outside .atelier-local')
  return absolute.slice(0, index)
}

function secureRuntimeLeaf(file) {
  const workspaceRoot = runtimeWorkspaceRoot(file)
  const directory = ensureContainedPrivateDirectory({
    workspaceRoot,
    directory: path.dirname(path.resolve(file)),
    label: 'runtime state directory',
  })
  return path.join(directory, path.basename(file))
}

export function atomicWriteJson(file, value) {
  const secured = secureRuntimeLeaf(file)
  atomicReplacePrivateText(secured, `${JSON.stringify(value, null, 2)}\n`)
}

export function readJsonIfPresent(file) {
  const secured = secureRuntimeLeaf(file)
  if (!lstatIfPresent(secured)) return null
  return JSON.parse(readRegularTextNoFollow(secured))
}

export function removeRuntimeLeaf(file) {
  const secured = secureRuntimeLeaf(file)
  const stat = lstatIfPresent(secured)
  if (!stat) return false
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('state leaf is not a regular file')
  fs.unlinkSync(secured)
  return true
}

export function runtimePlanInventory(plansPath) {
  const directory = ensureContainedPrivateDirectory({
    workspaceRoot: runtimeWorkspaceRoot(plansPath),
    directory: plansPath,
    label: 'runtime plans directory',
  })
  const files = []
  let bytes = 0
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.name.endsWith('.json')) continue
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error('runtime plans directory contains a redirected or non-file entry')
    const file = path.join(directory, entry.name)
    const stat = fs.lstatSync(file)
    files.push({ file, name: entry.name, bytes: stat.size, mtimeMs: stat.mtimeMs })
    bytes += stat.size
  }
  return { files, bytes }
}

export function runtimePaths(repoRoot) {
  const root = path.join(repoRoot, '.atelier-local', 'runtime')
  return {
    root,
    enrollment: path.join(root, 'enrollment.json'),
    state: path.join(root, 'state.json'),
    control: path.join(root, 'control.json'),
    trace: path.join(root, 'operations.ndjson'),
    plans: path.join(root, 'plans'),
    lock: path.join(root, 'operation.lock'),
  }
}

export function ensureRuntimeStateRoot(repoRoot, gitExecutable) {
  const probe = '.atelier-local/runtime/.ignore-probe'
  const ignored = runGit(gitExecutable, repoRoot, ['check-ignore', '-q', probe], { allowFailure: true })
  if (!ignored.ok) {
    throw new Error('.atelier-local/ must be Git-ignored before Atelier Sync writes machine-local state')
  }
  const root = ensureContainedPrivateDirectory({
    workspaceRoot: repoRoot,
    directory: path.join(repoRoot, '.atelier-local', 'runtime'),
    label: 'runtime state directory',
  })
  const plans = ensureContainedPrivateDirectory({
    workspaceRoot: repoRoot,
    directory: path.join(root, 'plans'),
    label: 'runtime plans directory',
  })
  return { ...runtimePaths(repoRoot), root, plans, lock: path.join(root, 'operation.lock') }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!value || typeof value !== 'object') return JSON.stringify(value)
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

function digest(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex')
}

export function readOperationTrace(tracePath) {
  const secured = secureRuntimeLeaf(tracePath)
  const stat = lstatIfPresent(secured)
  if (!stat) return []
  if (stat.size > ATELIER_RUNTIME_TRACE_MAX_BYTES) throw new Error('runtime trace exceeds the resident byte ceiling')
  const records = readRegularTextNoFollow(secured).split('\n').filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new Error(`invalid runtime trace line ${index + 1}: ${error.message}`)
    }
  })
  if (records.length > ATELIER_RUNTIME_TRACE_MAX_RECORDS) throw new Error('runtime trace exceeds the resident record ceiling')
  let previousHash = null
  records.forEach((record, index) => {
    const { hash, ...unsigned } = record
    if (record.sequence !== index + 1) throw new Error(`runtime trace sequence gap at line ${index + 1}`)
    if ((record.previousHash ?? null) !== previousHash) throw new Error(`runtime trace chain mismatch at line ${index + 1}`)
    if (digest(unsigned) !== hash) throw new Error(`runtime trace hash mismatch at line ${index + 1}`)
    previousHash = hash
  })
  return records
}

function boundedTraceEvent(event) {
  const encoded = JSON.stringify(event)
  const originalBytes = Buffer.byteLength(encoded)
  if (originalBytes <= ATELIER_RUNTIME_TRACE_MAX_EVENT_BYTES) return event
  return {
    at: event?.at,
    operation: event?.operation || 'trace-event',
    outcome: event?.outcome || 'recorded',
    ...(event?.operationId ? { operationId: String(event.operationId) } : {}),
    ...(event?.mode ? { mode: String(event.mode) } : {}),
    details: {
      truncated: true,
      originalBytes,
      originalSha256: crypto.createHash('sha256').update(encoded).digest('hex'),
    },
  }
}

function traceRecoveryCheckpoint(secured, event, reason) {
  const stat = lstatIfPresent(secured)
  let priorSha256 = null
  try {
    if ((stat?.size ?? 0) <= ATELIER_RUNTIME_TRACE_MAX_BYTES) {
      priorSha256 = crypto.createHash('sha256').update(readRegularTextNoFollow(secured)).digest('hex')
    }
  } catch {
    // The recovery checkpoint still records the size and reason if the old
    // regular file cannot be read completely.
  }
  const checkpointUnsigned = {
    schema: ATELIER_RUNTIME_TRACE_SCHEMA,
    sequence: 1,
    previousHash: null,
    at: event.at,
    operation: 'trace-checkpoint',
    outcome: 'recovered',
    details: { reason, priorBytes: stat?.size ?? 0, priorSha256 },
  }
  const checkpoint = { ...checkpointUnsigned, hash: digest(checkpointUnsigned) }
  atomicReplacePrivateText(secured, `${JSON.stringify(checkpoint)}\n`)
  return checkpoint
}

export function appendOperationTrace(tracePath, event) {
  const secured = secureRuntimeLeaf(tracePath)
  const boundedEvent = boundedTraceEvent(event)
  let records
  try {
    records = readOperationTrace(secured)
  } catch (error) {
    records = [traceRecoveryCheckpoint(secured, boundedEvent, error.message)]
  }
  let previousHash = records.at(-1)?.hash ?? null
  const nextProbe = JSON.stringify({ schema: ATELIER_RUNTIME_TRACE_SCHEMA, sequence: records.length + 1, previousHash, ...boundedEvent, hash: '0'.repeat(64) })
  const currentBytes = lstatIfPresent(secured)?.size ?? 0
  if (records.length >= ATELIER_RUNTIME_TRACE_MAX_RECORDS || currentBytes + Buffer.byteLength(`${nextProbe}\n`) > ATELIER_RUNTIME_TRACE_MAX_BYTES) {
    const checkpointUnsigned = {
      schema: ATELIER_RUNTIME_TRACE_SCHEMA,
      sequence: 1,
      previousHash: null,
      at: boundedEvent.at,
      operation: 'trace-checkpoint',
      outcome: 'compacted',
      details: { compactedRecords: records.length, priorLastHash: previousHash },
    }
    const checkpoint = { ...checkpointUnsigned, hash: digest(checkpointUnsigned) }
    atomicReplacePrivateText(secured, `${JSON.stringify(checkpoint)}\n`)
    records = [checkpoint]
    previousHash = checkpoint.hash
  }
  const unsigned = {
    schema: ATELIER_RUNTIME_TRACE_SCHEMA,
    sequence: records.length + 1,
    previousHash,
    ...boundedEvent,
  }
  const record = { ...unsigned, hash: digest(unsigned) }
  const descriptor = openRegularFileNoFollow(
    secured,
    fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT,
    0o600,
  )
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  try {
    fs.chmodSync(secured, 0o600)
  } catch {
    // Windows inherits the current user's ACL; POSIX mode is best effort.
  }
  return record
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function removeOwnedLock(lockPath, lockNonce) {
  const stat = lstatIfPresent(lockPath)
  if (!stat) return
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('runtime lock is redirected or not a directory')
  const ownerFile = path.join(lockPath, 'owner.json')
  const owner = readJsonIfPresent(ownerFile)
  if (!lockNonce || owner?.lockNonce !== lockNonce) throw new Error('runtime lock ownership changed before release')
  const quarantine = `${lockPath}.release-${lockNonce}`
  fs.renameSync(lockPath, quarantine)
  fs.rmSync(quarantine, { recursive: true, force: true })
}

export function acquireRepositoryLock(paths, { operation, clock = () => new Date().toISOString(), ownerWriteGraceMs = 30_000 } = {}) {
  ensureContainedPrivateDirectory({ workspaceRoot: runtimeWorkspaceRoot(paths.root), directory: paths.root, label: 'runtime state directory' })
  const lockNonce = crypto.randomBytes(16).toString('hex')
  try {
    fs.mkdirSync(paths.lock, { mode: 0o700 })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const lockStat = lstatIfPresent(paths.lock)
    if (!lockStat || lockStat.isSymbolicLink() || !lockStat.isDirectory()) {
      throw new Error('runtime lock is redirected or not a directory')
    }
    let owner = null
    try {
      owner = readJsonIfPresent(path.join(paths.lock, 'owner.json'))
    } catch (ownerError) {
      if (/redirected|regular file|escapes workspace/.test(ownerError.message)) throw ownerError
      // A truncated owner file is not authority to delete a possibly live lock.
    }
    const ownerTimestamp = Date.parse(owner?.acquiredAt || '')
    const ownerAgeMs = Date.now() - (Number.isFinite(ownerTimestamp) ? ownerTimestamp : lockStat.mtimeMs)
    if (owner && processAlive(owner.pid) && ownerAgeMs < ATELIER_RUNTIME_LIVE_OWNER_MAX_AGE_MS) {
      return { ok: false, code: 'repository-busy', owner }
    }
    const currentLockStat = lstatIfPresent(paths.lock)
    if (!currentLockStat || currentLockStat.isSymbolicLink() || !currentLockStat.isDirectory()) {
      throw new Error('runtime lock is redirected or not a directory')
    }
    const ageMs = Date.now() - currentLockStat.mtimeMs
    if (ageMs < ownerWriteGraceMs) return { ok: false, code: 'repository-busy', owner: owner || { operation: 'lock-owner-pending', ageMs } }
    const claimPath = path.join(paths.lock, 'recovery.claim')
    let claimDescriptor
    try {
      claimDescriptor = openRegularFileNoFollow(
        claimPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o600,
      )
      fs.writeFileSync(claimDescriptor, lockNonce)
      fs.fsyncSync(claimDescriptor)
    } catch (claimError) {
      if (claimError?.code === 'EEXIST') {
        const claimStat = lstatIfPresent(claimPath)
        if (!claimStat || claimStat.isSymbolicLink() || !claimStat.isFile()) throw new Error('runtime recovery claim is redirected or not a regular file')
        const claimAgeMs = Date.now() - claimStat.mtimeMs
        if (claimAgeMs < ownerWriteGraceMs) {
          return { ok: false, code: 'repository-busy', owner: owner || { operation: 'stale-lock-recovery', ageMs: claimAgeMs } }
        }
        const staleClaim = `${claimPath}.stale-${lockNonce}`
        try {
          fs.renameSync(claimPath, staleClaim)
          const movedClaimStat = lstatIfPresent(staleClaim)
          if (!movedClaimStat || movedClaimStat.dev !== claimStat.dev || movedClaimStat.ino !== claimStat.ino) {
            if (movedClaimStat && !lstatIfPresent(claimPath)) fs.renameSync(staleClaim, claimPath)
            return { ok: false, code: 'repository-busy', owner: owner || { operation: 'stale-lock-recovery-identity-changed' } }
          }
          fs.unlinkSync(staleClaim)
          claimDescriptor = openRegularFileNoFollow(
            claimPath,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
            0o600,
          )
          fs.writeFileSync(claimDescriptor, lockNonce)
          fs.fsyncSync(claimDescriptor)
        } catch (retryError) {
          if (retryError?.code === 'EEXIST' || retryError?.code === 'ENOENT') {
            return { ok: false, code: 'repository-busy', owner: owner || { operation: 'stale-lock-recovery-lost' } }
          }
          throw retryError
        }
      } else if (claimError?.code === 'ENOENT') {
        return { ok: false, code: 'repository-busy', owner: owner || { operation: 'stale-lock-recovery' } }
      } else {
        throw claimError
      }
    } finally {
      if (claimDescriptor != null) fs.closeSync(claimDescriptor)
    }
    let currentOwner = null
    try {
      currentOwner = readJsonIfPresent(path.join(paths.lock, 'owner.json'))
    } catch (ownerError) {
      if (/redirected|regular file|escapes workspace/.test(ownerError.message)) throw ownerError
      // The exclusive recovery claim and age gate permit quarantining a stale,
      // corrupt owner record; corruption is never authority to touch a new lock.
    }
    const currentOwnerTimestamp = Date.parse(currentOwner?.acquiredAt || '')
    const currentOwnerAgeMs = Date.now() - (Number.isFinite(currentOwnerTimestamp) ? currentOwnerTimestamp : lockStat.mtimeMs)
    if (currentOwner && processAlive(currentOwner.pid) && currentOwnerAgeMs < ATELIER_RUNTIME_LIVE_OWNER_MAX_AGE_MS) {
      try {
        if (readRegularTextNoFollow(claimPath) === lockNonce) fs.unlinkSync(claimPath)
      } catch {
        // The current owner controls the lock; leave it untouched on uncertainty.
      }
      return { ok: false, code: 'repository-busy', owner: currentOwner }
    }
    const quarantine = `${paths.lock}.stale-${lockNonce}`
    try {
      const beforeRecovery = lstatIfPresent(paths.lock)
      if (!beforeRecovery || beforeRecovery.dev !== lockStat.dev || beforeRecovery.ino !== lockStat.ino) {
        return { ok: false, code: 'repository-busy', owner: { operation: 'stale-lock-recovery-identity-changed' } }
      }
      fs.renameSync(paths.lock, quarantine)
      const movedLock = lstatIfPresent(quarantine)
      if (!movedLock || movedLock.dev !== lockStat.dev || movedLock.ino !== lockStat.ino) {
        if (movedLock && !lstatIfPresent(paths.lock)) fs.renameSync(quarantine, paths.lock)
        return { ok: false, code: 'repository-busy', owner: { operation: 'stale-lock-recovery-identity-changed' } }
      }
      fs.mkdirSync(paths.lock, { mode: 0o700 })
    } catch (recoveryError) {
      if (recoveryError?.code === 'EEXIST' || recoveryError?.code === 'ENOENT') {
        if (lstatIfPresent(quarantine)) fs.rmSync(quarantine, { recursive: true, force: true })
        return { ok: false, code: 'repository-busy', owner: { operation: 'stale-lock-recovery-lost' } }
      }
      throw recoveryError
    }
    fs.rmSync(quarantine, { recursive: true, force: true })
  }
  const owner = { lockNonce, pid: process.pid, operation, acquiredAt: clock() }
  atomicWriteJson(path.join(paths.lock, 'owner.json'), owner)
  return {
    ok: true,
    owner,
    release() {
      removeOwnedLock(paths.lock, lockNonce)
    },
  }
}

export function writeRuntimeState(paths, state) {
  let value = { schema: ATELIER_RUNTIME_STATE_SCHEMA, ...state }
  const encodedBytes = Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`)
  if (encodedBytes > ATELIER_RUNTIME_STATE_MAX_BYTES) {
    value = {
      schema: ATELIER_RUNTIME_STATE_SCHEMA,
      status: 'attention',
      code: 'runtime-state-resident-ceiling',
      message: 'runtime state exceeded its resident byte ceiling and was compacted',
      incidentId: state.incidentId ?? null,
      updatedAt: state.updatedAt ?? new Date().toISOString(),
      observation: state.observation ? {
        schema: state.observation.schema,
        observedAt: state.observation.observedAt,
        complete: false,
        root: state.observation.root,
        branch: state.observation.branch ? { branch: state.observation.branch.branch, head: state.observation.branch.head } : null,
        status: state.observation.status ? { clean: state.observation.status.clean, digest: state.observation.status.digest } : null,
        blockers: [{ code: 'runtime-state-resident-ceiling', message: 'full resident state was too large to retain', details: { limitBytes: ATELIER_RUNTIME_STATE_MAX_BYTES, observedBytes: encodedBytes } }],
      } : null,
      details: { limitBytes: ATELIER_RUNTIME_STATE_MAX_BYTES, observedBytes: encodedBytes },
    }
  }
  atomicWriteJson(paths.state, value)
  return value
}

export function readRuntimeControl(paths) {
  return readJsonIfPresent(paths.control) || { paused: false, reason: null, updatedAt: null }
}

export function writeRuntimeControl(paths, { paused, reason = null, updatedAt = new Date().toISOString() }) {
  const control = { paused: Boolean(paused), reason: paused ? String(reason || 'paused by user') : null, updatedAt }
  atomicWriteJson(paths.control, control)
  return control
}
