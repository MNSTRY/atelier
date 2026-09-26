import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { openRegularFileNoFollow, atomicReplacePrivateText, syncPrivateDirectory } from '../project/private-state.mjs'

export const LIMITS = Object.freeze({ files: 512, directories: 256, bytes: 8 * 1024 * 1024, depth: 16 })
export const digest = (bytes) => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
export const objectDigest = (value) => digest(canonical(value))
export const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`
export function stat(file) {
  try { return fs.lstatSync(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

export function relativeFile(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value) ||
      value.split('/').some(part => part === '.' || part === '..' || part.toLowerCase() === '.git' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('invalid portable relative path')
  }
  return value
}

// All callers resolve an explicitly supplied root once. No links below it are
// followed, including intermediate components and absent write destinations.
export function within(root, relative, { directory = false, create = false } = {}) {
  relativeFile(relative)
  const parts = relative.split('/')
  let current = root
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index])
    const isDirectory = index < parts.length - 1 || directory
    let entry = stat(current)
    if (!entry && isDirectory && create) {
      fs.mkdirSync(current, { mode: 0o700 })
      syncPrivateDirectory(path.dirname(current))
      entry = stat(current)
    }
    if (entry && (entry.isSymbolicLink() || (isDirectory ? !entry.isDirectory() : !entry.isFile()))) throw new Error('redirected or non-regular path component')
  }
  return current
}

export function bytesAt(root, relative) {
  const file = within(root, relative)
  const fd = openRegularFileNoFollow(file)
  try {
    if (fs.fstatSync(fd).size > LIMITS.bytes) throw new Error('file exceeds byte ceiling')
    const bytes = fs.readFileSync(fd)
    if (bytes.length > LIMITS.bytes) throw new Error('file exceeds byte ceiling')
    return bytes
  } finally { fs.closeSync(fd) }
}

export function jsonAt(root, relative) {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytesAt(root, relative)))
}

export function tree(root, relative = '', state = { files: [], bytes: 0, directories: 0 }) {
  const directory = relative ? within(root, relative, { directory: true }) : root
  if (!stat(directory)?.isDirectory() || stat(directory).isSymbolicLink()) throw new Error('bundle directory missing or redirected')
  if (++state.directories > LIMITS.directories || relative.split('/').length > LIMITS.depth) throw new Error('bundle directory ceiling exceeded')
  for (const name of fs.readdirSync(directory).sort()) {
    const file = relative ? `${relative}/${name}` : name
    relativeFile(file)
    const entry = stat(path.join(root, file))
    if (entry.isSymbolicLink()) throw new Error('bundle contains a symbolic link')
    if (entry.isDirectory()) { tree(root, file, state); continue }
    if (!entry.isFile()) throw new Error('bundle contains a non-regular file')
    if (state.files.length >= LIMITS.files || state.bytes + entry.size > LIMITS.bytes) throw new Error('bundle size ceiling exceeded')
    const bytes = bytesAt(root, file)
    state.bytes += bytes.length
    if (state.bytes > LIMITS.bytes) throw new Error('bundle size ceiling exceeded')
    state.files.push({ path: file, bytes })
  }
  return state.files
}

export const fileInventory = (files) => files.map(file => ({ path: file.path, digest: digest(file.bytes), bytes: file.bytes.length }))
export const treeDigest = (files) => objectDigest(fileInventory(files))
export function currentTree(root, relative) {
  const directory = within(root, relative, { directory: true })
  return stat(directory) ? treeDigest(tree(directory)) : null
}

export function writeNew(root, relative, bytes) {
  const parent = path.posix.dirname(relative)
  if (parent !== '.') within(root, parent, { directory: true, create: true })
  const file = within(root, relative)
  const fd = openRegularFileNoFollow(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  syncPrivateDirectory(path.dirname(file))
}

export function replaceJson(root, relative, value) {
  const parent = path.posix.dirname(relative)
  if (parent !== '.') within(root, parent, { directory: true, create: true })
  atomicReplacePrivateText(within(root, relative), jsonText(value))
}

export function workspaceRoot(input, { write = false } = {}) {
  const root = fs.realpathSync(path.resolve(input))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')))
  const git = args => execFileSync('git', ['-C', root, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const top = fs.realpathSync(git(['rev-parse', '--show-toplevel']))
  // Git can expand a Windows short-name alias. Preserve case-sensitive paths
  // and compare actual directory identity when the resolved spellings differ.
  const rootStat = fs.statSync(root, { bigint: true }), topStat = fs.statSync(top, { bigint: true })
  if (!rootStat.isDirectory() || !topStat.isDirectory() ||
      (top !== root && !(rootStat.ino !== 0n && rootStat.dev === topStat.dev && rootStat.ino === topStat.ino))) {
    throw new Error('capability workspace must be the repository root')
  }
  if (write) {
    if (process.platform === 'win32') throw new Error('capability writes require a qualified POSIX filesystem')
    if (git(['ls-files', '--', '.atelier-local'])) throw new Error('private capability state is tracked')
    try { git(['check-ignore', '--quiet', '.atelier-local/']) } catch { throw new Error('capability writes require ignored .atelier-local/ state') }
  }
  within(root, '.atelier-local', { directory: true })
  return root
}
