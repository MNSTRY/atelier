import fs from 'node:fs'
import path from 'node:path'

function escapes(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative.startsWith('..') || path.isAbsolute(relative)
}

function lstatIfPresent(file) {
  try {
    return fs.lstatSync(file)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export function ensureContainedPrivateDirectory({ workspaceRoot, directory, label = 'private state directory' }) {
  const lexicalRoot = path.resolve(workspaceRoot)
  const realRoot = fs.realpathSync(lexicalRoot)
  const requested = path.resolve(directory)
  let relative = path.relative(lexicalRoot, requested)
  if (escapes(lexicalRoot, requested)) relative = path.relative(realRoot, requested)
  if (relative === '' || escapes(realRoot, path.join(realRoot, relative))) {
    if (relative === '') return realRoot
    throw new Error(`${label} escapes workspace`)
  }

  let current = realRoot
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment)
    let stat = lstatIfPresent(current)
    if (!stat) {
      fs.mkdirSync(current, { mode: 0o700 })
      stat = fs.lstatSync(current)
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`${label} contains a redirected or non-directory component`)
    }
  }
  const resolved = fs.realpathSync(current)
  if (escapes(realRoot, resolved)) throw new Error(`${label} escapes workspace`)
  try {
    fs.chmodSync(resolved, 0o700)
  } catch {
    // Best effort on filesystems that do not support chmod.
  }
  return resolved
}

export function openRegularFileNoFollow(file, flags = fs.constants.O_RDONLY, mode) {
  const before = lstatIfPresent(file)
  if (before && (before.isSymbolicLink() || !before.isFile())) {
    throw new Error('state leaf is not a regular file')
  }
  const descriptor = fs.openSync(file, flags | (fs.constants.O_NOFOLLOW ?? 0), mode)
  try {
    const opened = fs.fstatSync(descriptor)
    if (!opened.isFile()) throw new Error('state leaf is not a regular file')
    // Windows does not expose O_NOFOLLOW. Refuse a pre-existing redirected
    // leaf before open and bind the opened descriptor back to that same file
    // identity where the filesystem supplies stable device/inode values.
    if (before && before.ino !== 0 && (before.dev !== opened.dev || before.ino !== opened.ino)) {
      throw new Error('state leaf changed while opening')
    }
    return descriptor
  } catch (error) {
    fs.closeSync(descriptor)
    throw error
  }
}

export function readRegularTextNoFollow(file) {
  const descriptor = openRegularFileNoFollow(file)
  try {
    return fs.readFileSync(descriptor, 'utf8')
  } finally {
    fs.closeSync(descriptor)
  }
}

export function atomicReplacePrivateText(file, text, mode = 0o600) {
  const existing = lstatIfPresent(file)
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new Error('state leaf is not a regular file')
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  let descriptor
  try {
    descriptor = openRegularFileNoFollow(
      tmp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      mode,
    )
    fs.writeFileSync(descriptor, text)
    fs.fsyncSync(descriptor)
    fs.fchmodSync(descriptor, mode)
    fs.closeSync(descriptor)
    descriptor = null
    fs.renameSync(tmp, file)
  } catch (error) {
    if (descriptor != null) fs.closeSync(descriptor)
    try {
      fs.unlinkSync(tmp)
    } catch {
      // The temporary file may not have been created.
    }
    throw error
  }
}
