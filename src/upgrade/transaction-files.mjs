// Bounded local filesystem evidence. This is cooperative concurrency control,
// not a sandbox for arbitrary executors, hooks or other host processes.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { canonicalize } from '../attestation/jcs.mjs'
import { openRegularFileNoFollow, ensureContainedPrivateDirectory } from '../project/private-state.mjs'

export const hashBytes = (bytes) => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`
export const hashObject = (value) => hashBytes(canonicalize(value))
export const same = (a, b) => canonicalize(a) === canonicalize(b)
export const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`
export const MAX_BYTES = 64 * 1024 * 1024

export function contained(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes('\0') || path.isAbsolute(relative) || relative.split('/').some((p) => !p || p === '.' || p === '..' || p === '.git')) throw new Error('invalid contained path')
  let current = root
  for (const part of relative.split('/')) {
    current = path.join(current, part)
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('redirected path refused') } catch (e) { if (e.code !== 'ENOENT') throw e }
  }
  return current
}

export function readBytes(file, { allowLinks = false } = {}) {
  const fd = openRegularFileNoFollow(file)
  try {
    const st = fs.fstatSync(fd)
    if ((!allowLinks && st.nlink !== 1) || st.size > MAX_BYTES) throw new Error('linked or oversized file refused')
    return fs.readFileSync(fd)
  } finally { fs.closeSync(fd) }
}

export function fileState(file, options) {
  try {
    const st = fs.lstatSync(file)
    if (!st.isFile() || st.isSymbolicLink()) throw new Error('non-regular file refused')
    return { digest: hashBytes(readBytes(file, options)), mode: st.mode & 0o111 ? '100755' : '100644' }
  } catch (e) { if (e.code === 'ENOENT') return null; throw e }
}

export function inventory(root, { exclude = [], allowLinks = false } = {}) {
  const entries = []
  let bytes = 0
  function walk(rel) {
    for (const name of fs.readdirSync(path.join(root, rel)).sort()) {
      const next = rel ? `${rel}/${name}` : name
      if (exclude.includes(next)) continue
      const file = contained(root, next)
      const st = fs.lstatSync(file)
      if (st.isDirectory()) walk(next)
      else {
        bytes += st.size
        if (bytes > MAX_BYTES || entries.length >= 4096) throw new Error('inventory capacity exceeded')
        entries.push({ path: next, state: fileState(file, { allowLinks }) })
      }
    }
  }
  walk('')
  return entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

export function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY)
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}

export function publish(file, bytes, mode = 0o600) {
  // Exclusive immutable publication. A crash during this write leaves an
  // invalid record which readers refuse; it never resembles a valid success.
  const fd = openRegularFileNoFollow(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode)
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  syncDirectory(path.dirname(file))
  if (!readBytes(file).equals(Buffer.from(bytes))) throw new Error('publication reread mismatch')
}

export function privateDirectory(root, relative) {
  const directory = ensureContainedPrivateDirectory({ workspaceRoot: root, directory: contained(root, relative) })
  let current = directory
  const realRoot = fs.realpathSync(root)
  while (current !== realRoot) { syncDirectory(current); current = path.dirname(current) }
  syncDirectory(realRoot)
  return directory
}

export function replaceExpected(root, entry) {
  const file = contained(root, entry.path)
  if (!same(fileState(file), entry.before)) throw new Error('write preimage changed')
  // Only missing parent directories are created; existing directory modes stay.
  let dir = root
  for (const part of entry.path.split('/').slice(0, -1)) {
    const next = path.join(dir, part)
    if (!fs.existsSync(next)) { fs.mkdirSync(next); syncDirectory(dir) }
    if (!fs.lstatSync(next).isDirectory() || fs.lstatSync(next).isSymbolicLink()) throw new Error('write parent refused')
    dir = next
  }
  const temp = `${file}.atelier-${crypto.randomUUID()}.tmp`
  publish(temp, Buffer.from(entry.content, 'base64'), entry.after.mode === '100755' ? 0o755 : 0o644)
  if (!same(fileState(file), entry.before)) { fs.unlinkSync(temp); throw new Error('write preimage changed') }
  fs.renameSync(temp, file)
  syncDirectory(dir)
  if (!same(fileState(file), entry.after)) throw new Error('write verification failed')
}
