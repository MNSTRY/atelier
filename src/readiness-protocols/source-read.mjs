import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { openRegularFileNoFollow } from '../project/private-state.mjs'
const hashBytes = (value) =>
  `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`

export function readBoundedSource(root, relative) {
  if (
    typeof relative !== 'string' ||
    path.isAbsolute(relative) ||
    relative.split(/[\\/]/).some((part) => part === '..' || part === '.git')
  )
    throw new Error('source reference escapes declared boundary')
  const realRoot = fs.realpathSync(root)
  const file = path.resolve(realRoot, relative)
  let cursor = realRoot
  for (const part of path.relative(realRoot, file).split(path.sep)) {
    cursor = path.join(cursor, part)
    if (fs.lstatSync(cursor).isSymbolicLink())
      throw new Error('redirected source reference refused')
  }
  const descriptor = openRegularFileNoFollow(file)
  try {
    const before = fs.fstatSync(descriptor)
    if (before.size > 1024 * 1024)
      throw new Error('source exceeds review byte bound')
    const bytes = fs.readFileSync(descriptor)
    const after = fs.fstatSync(descriptor)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new Error('source changed during read')
    return {
      digest: hashBytes(bytes),
      text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    }
  } finally {
    fs.closeSync(descriptor)
  }
}
