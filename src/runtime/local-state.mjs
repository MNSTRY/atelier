import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { runGit } from './git-adapter.mjs'

export const ATELIER_RUNTIME_STATE_SCHEMA = 'atelier-runtime-state@v1'
export const ATELIER_RUNTIME_ENROLLMENT_SCHEMA = 'atelier-runtime-enrollment@v1'
export const ATELIER_RUNTIME_TRACE_SCHEMA = 'atelier-runtime-operation@v1'

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(dir, 0o700)
  } catch {
    // Windows inherits the current user's ACL; POSIX mode is best effort.
  }
}

export function atomicWriteJson(file, value) {
  ensurePrivateDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  fs.renameSync(tmp, file)
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    // Windows inherits the current user's ACL; POSIX mode is best effort.
  }
}

export function readJsonIfPresent(file) {
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf8'))
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
  const paths = runtimePaths(repoRoot)
  ensurePrivateDir(paths.root)
  ensurePrivateDir(paths.plans)
  return paths
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
  if (!fs.existsSync(tracePath)) return []
  const records = fs.readFileSync(tracePath, 'utf8').split('\n').filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new Error(`invalid runtime trace line ${index + 1}: ${error.message}`)
    }
  })
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
  ensurePrivateDir(path.dirname(tracePath))
  const records = readOperationTrace(tracePath)
  const previousHash = records.at(-1)?.hash ?? null
  const unsigned = {
    schema: ATELIER_RUNTIME_TRACE_SCHEMA,
    sequence: records.length + 1,
    previousHash,
    ...event,
  }
  const record = { ...unsigned, hash: digest(unsigned) }
  const descriptor = fs.openSync(tracePath, 'a', 0o600)
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  try {
    fs.chmodSync(tracePath, 0o600)
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

function removeOwnedLock(lockPath, lockNonce = null) {
  if (!fs.existsSync(lockPath)) return
  const ownerFile = path.join(lockPath, 'owner.json')
  const owner = readJsonIfPresent(ownerFile)
  if (lockNonce && owner?.lockNonce !== lockNonce) throw new Error('runtime lock ownership changed before release')
  fs.rmSync(lockPath, { recursive: true, force: true })
}

export function acquireRepositoryLock(paths, { operation, clock = () => new Date().toISOString(), ownerWriteGraceMs = 30_000 } = {}) {
  ensurePrivateDir(paths.root)
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
    removeOwnedLock(paths.lock)
    fs.mkdirSync(paths.lock, { mode: 0o700 })
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
