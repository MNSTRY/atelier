import fs from 'node:fs'
import path from 'node:path'
import { preparePublication } from './service.mjs'
const LIMIT = 4 * 1024 * 1024
/** Node-only bundle preparation. Select paths explicitly; never scan a repo. */
export async function prepareVaultSource({ root, paths, expectedRevision }) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || !Array.isArray(paths) || !paths.length || paths.length > 100) throw new TypeError('Absolute artifact root and explicit paths required')
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('Artifact root must not be a symlink')
  const realRoot = fs.realpathSync(root)
  if (!fs.statSync(realRoot).isDirectory()) throw new Error('Artifact root must be a directory')
  let total = 0
  const files = []
  for (const name of paths) {
    if (typeof name !== 'string' || name.length > 512 || !name.split('/').every(part => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))) throw new Error('Invalid selected artifact path')
    let file = realRoot
    for (const part of name.split('/')) {
      file = path.join(file, part)
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Selected artifacts must not traverse symlinks')
    }
    const before = fs.lstatSync(file)
    if (!before.isFile() || before.nlink !== 1 || before.size > LIMIT) throw new Error('Selected artifact must be a bounded, unlinked regular file')
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    try {
      const opened = fs.fstatSync(fd)
      const resolved = fs.realpathSync(file)
      if ((path.relative(realRoot, resolved).startsWith('..' + path.sep) || path.isAbsolute(path.relative(realRoot, resolved))) || opened.ino !== before.ino || opened.dev !== before.dev || !opened.isFile() || opened.nlink !== 1 || opened.size > LIMIT) throw new Error('Artifact changed during selection')
      const data = Buffer.alloc(opened.size)
      let offset = 0
      while (offset < data.length) {
        const count = fs.readSync(fd, data, offset, data.length - offset, offset)
        if (!count) throw new Error('Artifact changed during read')
        offset += count
      }
      const after = fs.fstatSync(fd)
      const current = fs.lstatSync(file)
      if (after.nlink !== 1 || current.nlink !== 1 || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || current.ino !== opened.ino || current.dev !== opened.dev || fs.realpathSync(file) !== resolved) throw new Error('Artifact changed during read')
      total += data.length
      if (total > LIMIT) throw new Error('Artifact bundle too large')
      files.push({ path: name, base64: data.toString('base64') })
    } finally { fs.closeSync(fd) }
  }
  const request = { schema: 'atelier-vault-publication/v1', contractVersion: '1.0.0', expectedRevision, files }
  const prepared = await preparePublication(request)
  return { request, publication: prepared.publication, manifest: prepared.manifest }
}
