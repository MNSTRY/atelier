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

export function appendOperationTrace(tracePath, event) {
  const secured = secureRuntimeLeaf(tracePath)
  let records = readOperationTrace(secured)
  let previousHash = records.at(-1)?.hash ?? null
  const nextProbe = JSON.stringify({ schema: ATELIER_RUNTIME_TRACE_SCHEMA, sequence: records.length + 1, previousHash, ...event, hash: '0'.repeat(64) })
  const currentBytes = lstatIfPresent(secured)?.size ?? 0
  if (records.length >= ATELIER_RUNTIME_TRACE_MAX_RECORDS || currentBytes + Buffer.byteLength(`${nextProbe}\n`) > ATELIER_RUNTIME_TRACE_MAX_BYTES) {
    const checkpointUnsigned = {
      schema: ATELIER_RUNTIME_TRACE_SCHEMA,
      sequence: 1,
      previousHash: null,
      at: event.at,
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
    ...event,
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
    let owner = null
    try {
      owner = readJsonIfPresent(path.join(paths.lock, 'owner.json'))
    } catch {
      // A truncated owner file is not authority to delete a possibly live lock.
    }
    if (owner && processAlive(owner.pid)) {
      return { ok: false, code: 'repository-busy', owner }
    }
    if (!owner) {
      const ageMs = Date.now() - fs.statSync(paths.lock).mtimeMs
      if (ageMs < ownerWriteGraceMs) return { ok: false, code: 'repository-busy', owner: { operation: 'lock-owner-pending', ageMs } }
    }
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
      if (claimError?.code === 'EEXIST' || claimError?.code === 'ENOENT') {
        return { ok: false, code: 'repository-busy', owner: owner || { operation: 'stale-lock-recovery' } }
      }
      throw claimError
    } finally {
      if (claimDescriptor != null) fs.closeSync(claimDescriptor)
    }
    let currentOwner = null
    try {
      currentOwner = readJsonIfPresent(path.join(paths.lock, 'owner.json'))
    } catch {
      // The exclusive recovery claim and age gate permit quarantining a stale,
      // corrupt owner record; corruption is never authority to touch a new lock.
    }
    if (currentOwner && processAlive(currentOwner.pid)) {
      try {
        if (readRegularTextNoFollow(claimPath) === lockNonce) fs.unlinkSync(claimPath)
      } catch {
        // The current owner controls the lock; leave it untouched on uncertainty.
      }
      return { ok: false, code: 'repository-busy', owner: currentOwner }
    }
    const quarantine = `${paths.lock}.stale-${lockNonce}`
    try {
      fs.renameSync(paths.lock, quarantine)
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
  const value = { schema: ATELIER_RUNTIME_STATE_SCHEMA, ...state }
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
