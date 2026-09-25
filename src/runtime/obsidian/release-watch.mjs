import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// Whether the package a service runs from changed on disk since it started.
//
// A service started by a login item runs until the person logs out. When the
// package it was started from is upgraded meanwhile (`npm i -D
// @mnstry/atelier@<new>` in the project), it would go on running the release
// it loaded, and load any module it had not needed yet from the new one. So,
// under `--startup`, the service asks after every tick whether its package
// changed, finishes that tick and exits with a code its service manager
// restarts (service.mjs, service-main.mjs): the next process runs the new
// release.
//
// The package is read through the path the service was started by, not its
// real path: a linked install (`file:`, `npm link`) that is pointed elsewhere
// is then seen. What is compared is the release identity: the package version
// and a digest of every file under `src/` and `contracts/`, by relative path
// and content. It is cheap to ask: the files' status (inode, size, change and
// modification time) is compared first, and the digest is computed only when
// that differs. A package that cannot be read right now (an install in
// progress) is not a change yet; it is asked again after the next tick.

const PARTS = Object.freeze(['src', 'contracts'])
const byName = (left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)

// Every regular file the identity covers, in a fixed order: `visit(relative, absolute)`.
function walkRelease(root, visit) {
  const walk = (relative) => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort(byName)) {
      const child = `${relative}/${entry.name}`
      if (entry.isDirectory()) walk(child)
      else if (entry.isFile()) visit(child, path.join(root, child))
    }
  }
  for (const part of PARTS) walk(part)
}

// The release identity of the package at `root`, read now: { version, digest }. Never cached.
export function readReleaseIdentity({ root }) {
  const hash = createHash('sha256')
  walkRelease(root, (relative, absolute) => { hash.update(`${relative}\0${createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')}\n`) })
  let version = null
  try { const read = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version; version = typeof read === 'string' ? read : null } catch { version = null }
  return { version, digest: `sha256:${hash.digest('hex')}` }
}

// The status of every file the identity covers and of package.json, as one comparable text. A package replaced by an
// install has new inodes and change times even where the archive kept the modification times.
export function releaseStatSignature({ root }) {
  const lines = []
  const stat = (relative, absolute) => { const found = fs.lstatSync(absolute); lines.push(`${relative}\0${found.dev}\0${found.ino}\0${found.size}\0${found.mtimeMs}\0${found.ctimeMs}`) }
  walkRelease(root, stat)
  stat('package.json', path.join(root, 'package.json'))
  return lines.join('\n')
}

// The root of the package whose service entry is `entryPath` (`<root>/src/runtime/obsidian/service-main.mjs`), as that
// path names it, without resolving links; null for any other entry.
export function packageRootOfEntry(entryPath) {
  if (typeof entryPath !== 'string' || !path.isAbsolute(entryPath)) return null
  const parts = path.resolve(entryPath).split(path.sep)
  const tail = ['src', 'runtime', 'obsidian', 'service-main.mjs']
  if (parts.length <= tail.length || tail.some((part, index) => parts[parts.length - tail.length + index] !== part)) return null
  return parts.slice(0, parts.length - tail.length).join(path.sep) || path.sep
}

// { root, started, changed() }. `started` is the identity the service runs, read when the watch is made; `changed()`
// answers true once the package on disk is another release, and false while it is the same or cannot be read.
export function createReleaseWatch({ root, identityOf = readReleaseIdentity, signatureOf = releaseStatSignature } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new TypeError('a release watch needs the absolute root of a package')
  let signature = signatureOf({ root })
  const started = identityOf({ root })
  return {
    root, started,
    changed() {
      let now
      try { now = signatureOf({ root }) } catch { return false }
      if (now === signature) return false
      let identity
      try { identity = identityOf({ root }) } catch { return false }
      if (identity.version === started.version && identity.digest === started.digest) { signature = now; return false }
      return true
    },
  }
}
