import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Shared helpers of the developer proof tooling under scripts/obsidian. Not
// shipped, not part of the public API. Nothing here starts an application.

export const TOOLING_VERSION = '1.0.0'
export const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex')
export const sha256Digest = (bytes) => `sha256:${sha256Hex(bytes)}`

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
export const isIdentifier = (value) => typeof value === 'string' && IDENTIFIER.test(value)

// An arbitrary label as a contract identifier: anything outside the allowed
// alphabet becomes a dash, and a leading dash is dropped.
export function toIdentifier(value, fallback = 'unnamed') {
  const cleaned = String(value ?? '').replace(/[^A-Za-z0-9._:-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 128)
  return cleaned === '' ? fallback : cleaned
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  fs.renameSync(temporary, file)
}

export function walkFiles(directory) {
  const found = []
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else if (entry.isFile()) found.push(absolute)
    }
  }
  if (fs.existsSync(directory)) walk(directory)
  return found.sort()
}

export function bytesUnder(directory) {
  let bytes = 0
  let files = 0
  for (const file of walkFiles(directory)) { bytes += fs.statSync(file).size; files += 1 }
  return { bytes, files }
}

function isInside(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

// A repository is any directory with a `.git` entry (directory or worktree
// file). The check walks the target and its ancestors; children of the target
// are not consulted, so a dataset that itself contains synthetic `.git`
// directories can be regenerated into the same parent.
export function repositoryContaining(target) {
  let current = path.resolve(target)
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

export class OutputRefusal extends Error {
  constructor(code, message, detail = {}) {
    super(`${code}: ${message}`)
    this.name = 'OutputRefusal'
    this.code = code
    this.detail = detail
  }
}

// Generated datasets and receipts are written only outside every repository
// and outside any `fixtures` path, so nothing generated can be packed,
// committed or scanned as source by accident.
export function assertExternalOutput(target, { repositoryRoot = REPOSITORY_ROOT, allowInsideRepository = [] } = {}) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) throw new OutputRefusal('output-not-absolute', 'the output directory is an absolute path')
  const resolved = path.resolve(target)
  const segments = resolved.split(path.sep)
  if (segments.includes('fixtures')) throw new OutputRefusal('output-inside-fixtures', 'generated data never goes under a fixtures path', { target: resolved })
  const allowed = allowInsideRepository.some((prefix) => isInside(path.resolve(prefix), resolved))
  if (!allowed && isInside(path.resolve(repositoryRoot), resolved)) throw new OutputRefusal('output-inside-repository', 'generated data never goes inside this repository', { target: resolved })
  const repository = repositoryContaining(resolved)
  if (repository !== null && !allowed) throw new OutputRefusal('output-inside-repository', 'generated data never goes inside a repository', { target: resolved, repository })
  return resolved
}

export function hardwareProfile() {
  const cpus = os.cpus()
  return {
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    cpuModel: cpus[0]?.model ?? null,
    cpuCount: cpus.length,
    totalMemoryBytes: os.totalmem(),
    nodeVersion: process.version,
  }
}

export function hostIdentity() {
  return { id: toIdentifier(`host-${os.hostname()}`, 'host-unnamed'), platform: process.platform, release: os.release(), arch: process.arch }
}

export const osEnvironment = () => ({ name: process.platform, version: os.release() })

// The candidate is the exact source the procedure ran against: the commit
// and a digest of the index (`git ls-files -s`: mode, blob and path of every
// tracked file). A dirty tree is recorded, never hidden.
export function candidateIdentity(repositoryRoot = REPOSITORY_ROOT, { run = execFileSync } = {}) {
  const git = (args) => String(run('git', ['-C', repositoryRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }))
  const commit = git(['rev-parse', 'HEAD']).trim()
  const index = git(['ls-files', '-s'])
  const dirty = git(['status', '--porcelain']).trim() !== ''
  return { commit, treeDigest: sha256Digest(index), ext: { dirty } }
}

export function parseArgs(argv, { flags = [], values = [] } = {}) {
  const parsed = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) { parsed._.push(arg); continue }
    const [name, inline] = arg.slice(2).split(/=(.*)/s)
    if (flags.includes(name)) { parsed[name] = true; continue }
    if (!values.includes(name)) throw new OutputRefusal('usage', `unknown option --${name}`)
    const value = inline ?? argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new OutputRefusal('usage', `--${name} needs a value`)
    if (inline === undefined) index += 1
    parsed[name] = value
  }
  return parsed
}

export const isoNow = () => new Date().toISOString()
