import fs from 'node:fs'
import path from 'node:path'
import { packageRootOfEntry, readReleaseIdentity, walkRelease } from './service-record.mjs'

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
// is then seen. What is compared is the release identity (readReleaseIdentity
// in service-record.mjs, the one a service records at its start): the package
// version and a digest of every file under `src/`, `contracts/` and
// `plugins/`, by relative path and content. It is cheap to ask: the files'
// status (inode, size, change and modification time) is compared first, and
// the digest is computed only when that differs. A package that cannot be read right now (an install in
// progress) is not a change yet; it is asked again after the next tick.

export { packageRootOfEntry, readReleaseIdentity }

// The status of every file the identity covers and of package.json, as one comparable text. A package replaced by an
// install has new inodes and change times even where the archive kept the modification times.
export function releaseStatSignature({ root }) {
  const lines = []
  const stat = (relative, absolute) => { const found = fs.lstatSync(absolute); lines.push(`${relative}\0${found.dev}\0${found.ino}\0${found.size}\0${found.mtimeMs}\0${found.ctimeMs}`) }
  walkRelease(root, stat)
  stat('package.json', path.join(root, 'package.json'))
  return lines.join('\n')
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
