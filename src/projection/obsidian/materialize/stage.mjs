import fs from 'node:fs'
import path from 'node:path'
import { refuse, sha256Digest } from './byte-lens.mjs'

// Writes a prepared view into a caller-supplied staging directory. Staging is
// disposable prepared output only: this never touches a vault, never replaces
// a file and never follows a link. Publication is a separate protocol.
export function stagePreparedView(prepared, stagingDir) {
  if (typeof stagingDir !== 'string' || !path.isAbsolute(stagingDir)) refuse('invalid-staging-directory', 'the staging directory must be an absolute path')
  fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 })
  const root = fs.realpathSync(stagingDir)
  if (fs.readdirSync(root).length > 0) refuse('staging-not-empty', 'the staging directory must be empty')
  for (const file of prepared.files) {
    const parts = file.path.split('/')
    if (path.isAbsolute(file.path) || parts.some((part) => part === '' || part === '.' || part === '..')) refuse('path-escapes-vault', 'a prepared path would leave the staging root')
    let directory = root
    for (const part of parts.slice(0, -1)) {
      directory = path.join(directory, part)
      if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 })
      if (!fs.lstatSync(directory).isDirectory()) refuse('path-escapes-vault', 'a staging path component is not a plain directory')
    }
    const target = path.join(directory, parts.at(-1))
    fs.writeFileSync(target, file.bytes, { flag: 'wx', mode: 0o600 })
    if (sha256Digest(fs.readFileSync(target)) !== file.digest) refuse('staging-readback-mismatch', 'staged bytes differ from the prepared bytes')
  }
  return { root, fileCount: prepared.files.length }
}
