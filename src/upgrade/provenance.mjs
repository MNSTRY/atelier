import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { openRegularFileNoFollow } from '../project/private-state.mjs'
import { canonicalize } from '../attestation/jcs.mjs'
import { sanitizedGitEnvironment } from '../runtime/git-adapter.mjs'

const digest = (bytes) =>
  `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`
const MAX_BYTES = 32 * 1024 * 1024
const MAX_FILES = 5000

export function safeRepository(value) {
  if (typeof value !== 'string') return null
  const input = value.replace(/^git\+/, '')
  const scp = input.match(/^git@([a-z0-9.-]+):([a-z0-9/_.-]+)$/i)
  if (scp) return `ssh://git@${scp[1]}/${scp[2]}`
  try {
    const url = new URL(input)
    if (!['https:', 'http:', 'ssh:'].includes(url.protocol)) return null
    return new URL(`${url.protocol}//${url.host}${url.pathname}`).href
  } catch {
    return null
  }
}

function git(root, args) {
  const result = spawnSync(
    'git',
    ['--no-replace-objects', '-c', 'core.fsmonitor=false', '-C', root, ...args],
    {
      encoding: 'utf8',
      env: sanitizedGitEnvironment(process.env),
      maxBuffer: MAX_BYTES,
    },
  )
  return result.status === 0 ? result.stdout.trim() : null
}

// Inventory every installed package file except dependency trees and Git
// administration. Do not follow links or silently omit unexpected local files.
function inventory(root) {
  const files = []
  let bytes = 0
  function visit(rel) {
    for (const name of fs.readdirSync(path.join(root, rel)).sort()) {
      if (name === '.git' || name === 'node_modules') continue
      const next = path.posix.join(rel, name)
      const file = path.join(root, next)
      const stat = fs.lstatSync(file)
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
        throw new Error('unsupported package inventory entry')
      if (stat.isDirectory()) {
        visit(next)
        continue
      }
      bytes += stat.size
      if (files.length >= MAX_FILES || bytes > MAX_BYTES)
        throw new Error('package inventory exceeds bounds')
      const descriptor = openRegularFileNoFollow(file)
      let content
      try {
        content = fs.readFileSync(descriptor)
      } finally {
        fs.closeSync(descriptor)
      }
      const after = fs.lstatSync(file)
      if (
        stat.ino !== after.ino ||
        stat.size !== after.size ||
        stat.mtimeMs !== after.mtimeMs
      )
        throw new Error('package changed during inventory')
      files.push({
        path: next,
        digest: digest(content),
        executable: Boolean(stat.mode & 0o111),
      })
    }
  }
  visit('')
  return {
    digest: digest(canonicalize(files)),
    files,
    exclusions: ['.git', 'node_modules'],
    scope: 'package-files-without-dependencies',
  }
}

// Compare observed working bytes with HEAD objects as well as status. Git
// index hints (assume-unchanged/skip-worktree) must not conceal modified bytes.
function matchesCommit(root, head, observed) {
  if (!head || !observed) return false
  const tree = git(root, ['ls-tree', '-r', '-z', head])
  if (tree === null) return false
  const entries = tree
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf('\t'),
        [mode, type, oid] = line.slice(0, separator).split(' ')
      return { mode, type, oid, path: line.slice(separator + 1) }
    })
    .filter(
      (entry) =>
        !entry.path
          .split('/')
          .some((part) => part === '.git' || part === 'node_modules'),
    )
  if (
    entries.length !== observed.files.length ||
    entries.some(
      (entry) =>
        entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode),
    )
  )
    return false
  const result = spawnSync(
    'git',
    ['--no-replace-objects', '-C', root, 'cat-file', '--batch'],
    {
      input: entries.map((entry) => entry.oid).join('\n') + '\n',
      env: sanitizedGitEnvironment(process.env),
      maxBuffer: MAX_BYTES + MAX_FILES * 100,
    },
  )
  if (result.status !== 0) return false
  let offset = 0
  const files = new Map(observed.files.map((file) => [file.path, file]))
  for (const entry of entries) {
    const end = result.stdout.indexOf(10, offset)
    if (end < 0) return false
    const [oid, type, length] = result.stdout
        .subarray(offset, end)
        .toString('utf8')
        .split(' '),
      size = Number(length)
    if (
      oid !== entry.oid ||
      type !== 'blob' ||
      !Number.isSafeInteger(size) ||
      size < 0
    )
      return false
    const content = result.stdout.subarray(end + 1, end + 1 + size),
      file = files.get(entry.path)
    if (
      !file ||
      content.length !== size ||
      file.digest !== digest(content) ||
      file.executable !== (entry.mode === '100755')
    )
      return false
    offset = end + 1 + size + 1
  }
  return offset === result.stdout.length
}

function declarations(root, realRoot, name) {
  const found = []
  for (let dir = path.dirname(root); ; ) {
    for (const filename of ['npm-shrinkwrap.json', 'package-lock.json']) {
      const file = path.join(dir, filename)
      if (!fs.existsSync(file)) continue
      const stat = fs.lstatSync(file)
      if (!stat.isFile() || stat.size > MAX_BYTES) continue
      let lock
      try {
        lock = JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch {
        continue
      }
      const key = path.relative(dir, root).split(path.sep).join('/')
      const entry = lock.packages?.[key]
      if (!entry || entry.link || (entry.name && entry.name !== name)) continue
      // The lexical install slot must still resolve to this exact instance.
      try {
        if (fs.realpathSync(path.join(dir, key)) !== realRoot) continue
      } catch {
        continue
      }
      const resolved = typeof entry.resolved === 'string' ? entry.resolved : ''
      const sha = /^(?:git\+|git:)/.test(resolved)
        ? resolved.match(/#([0-9a-f]{40})$/)?.[1] ?? null
        : null
      found.push({
        kind: sha ? 'git' : /^https?:/.test(resolved) ? 'npm' : 'local_path',
        repository: safeRepository(resolved),
        gitSha: sha,
        integrity:
          typeof entry.integrity === 'string' &&
          /^(sha256|sha384|sha512)-[A-Za-z0-9+/=]+$/.test(entry.integrity)
            ? entry.integrity
            : null,
        evidence: filename,
      })
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return found
}

export function inspectPackageProvenance(
  packageRoot,
  { includeInventory = true } = {},
) {
  const root = path.resolve(packageRoot)
  const realRoot = fs.realpathSync(root)
  const pkg = JSON.parse(
    fs.readFileSync(path.join(realRoot, 'package.json'), 'utf8'),
  )
  const top = git(realRoot, ['rev-parse', '--show-toplevel'])
  const own = top !== null && fs.realpathSync(top) === realRoot
  const head = own ? git(realRoot, ['rev-parse', 'HEAD']) : null
  const status = own
    ? git(realRoot, [
        'status',
        '--porcelain',
        '--untracked-files=all',
        '--ignored=matching',
      ])
    : null
  const declared = declarations(root, realRoot, pkg.name)
  const conflict =
    new Set(
      declared.map((value) =>
        canonicalize({
          kind: value.kind,
          repository: value.repository,
          gitSha: value.gitSha,
          integrity: value.integrity,
        }),
      ),
    ).size > 1
  let observed = null
  const limitations = [
    'dependency bytes are outside this inventory',
    'local metadata and digests do not authenticate an upstream publisher',
  ]
  try {
    if (!includeInventory) throw new Error('metadata only')
    const first = inventory(realRoot)
    const second = inventory(realRoot)
    if (first.digest !== second.digest)
      throw new Error('package changed during inventory')
    observed = first
  } catch {
    limitations.push('complete stable package inventory unavailable')
  }
  const afterHead = own ? git(realRoot, ['rev-parse', 'HEAD']) : null
  const afterStatus = own
    ? git(realRoot, [
        'status',
        '--porcelain',
        '--untracked-files=all',
        '--ignored=matching',
      ])
    : null
  // node_modules is excluded from inventory and never covered by sourceVerified.
  const cleanStatus = (value) =>
    value !== null &&
    value
      .split('\n')
      .filter(Boolean)
      .every((line) => line === '!! node_modules/')
  const clean =
    cleanStatus(status) &&
    cleanStatus(afterStatus) &&
    head !== null &&
    head === afterHead
  const matchesHead = own && matchesCommit(realRoot, head, observed)
  const verified = own && clean && matchesHead && !conflict
  if (own && observed && !matchesHead)
    limitations.push(
      'observed package bytes differ from the claimed commit tree',
    )
  if (own && !clean)
    limitations.push(
      'checkout contains changes or ignored/untracked inputs; exact source binding refused',
    )
  if (conflict) limitations.push('conflicting install declarations')
  if (!own && declared.length === 0)
    limitations.push(
      'install manager metadata unavailable or unsupported; origin unresolved',
    )
  return {
    schema: 'atelier-package-provenance@v1',
    name: pkg.name,
    version: pkg.version,
    level: conflict
      ? 'unresolved'
      : verified
      ? 'verified-checkout'
      : declared.length
      ? 'declared'
      : 'unresolved',
    sourceVerified: verified,
    trackedGitSha: head,
    repository: safeRepository(
      own
        ? git(realRoot, ['remote', 'get-url', 'origin'])
        : pkg.repository?.url,
    ),
    declared,
    inventory: observed,
    limitations,
  }
}

export function legacyPackageSource(report) {
  if (report.trackedGitSha && report.repository)
    return {
      type: 'git',
      repository: report.repository,
      gitSha: report.trackedGitSha,
    }
  const entry = report.level === 'declared' ? report.declared[0] : null
  if (entry?.kind === 'git')
    return { type: 'git', repository: entry.repository, gitSha: entry.gitSha }
  if (entry?.kind === 'npm')
    return { type: 'npm', repository: report.repository, gitSha: null }
  return {
    type: 'local_path',
    path: '.',
    repository: report.repository,
    gitSha: null,
  }
}
