import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { buildGraph } from '../graph/graph.mjs'
import { parseYamlSubset, splitFrontmatter } from '../graph/knowledge-graph.mjs'
import { parseProjectOptions, projectOptionAt } from '../cli/project-options.mjs'
import { PROJECT_CONFIG_ENV, PROJECT_CONFIG_SCHEMA, resolveProjectConfig, validateProjectConfigDoc } from '../project/config.mjs'
import { sanitizedGitEnvironment } from '../runtime/git-adapter.mjs'

// The MNSTRY GraphMark standard (docs/reference/graphmark.md): a mark points at
// a specific part of a specific, recoverable edition of something someone
// singled out, records who made it, who marked it, when and why, and joins it
// to the knowledge graph as evidence. Its target is an evidence-navigation
// exact source reference (evidenceRef), refined: a full commit id, one literal
// path from the Git repository root, the digest of the whole object at that
// commit and a selector that names exactly one part of it.
//
// What is verified is what readers receive: the committed tree. The check
// reads the project config from its repository's HEAD blob, resolves its read
// policy from committed blobs of the repositories the project names, and
// streams the committed files of each managed repository folder into a private
// snapshot (raw blob bytes, no checkout filters; symbolic links and submodules
// are recorded, never written). It builds the knowledge graph there, without
// repository discovery or remote probes, and checks every mark against it.
// The working tree is read only through `git status` and the front matter of
// changed Markdown: an uncommitted, staged or edited mark record is refused,
// and uncommitted changes a mark depends on are reported. A repair hint (HEAD
// holds the bytes, another path form names them) is a diagnostic, never a
// verified mark. It never fetches a missing object, and it removes its
// snapshot, also on SIGINT or SIGTERM, and reclaims snapshots a killed run
// left behind.

export const GRAPHMARK_CONTRACT = 'atelier-graphmark@v1'
export const GRAPHMARK_TAG = 'graphmark'
export const MARK_STATES = ['marked', 'preserved', 'recorded', 'graph-checked', 'shared', 'accepted']
export const SELECTOR_TYPES = ['whole', 'lines', 'text-quote']
export const SNAPSHOT_PREFIX = 'atelier-graphmark-snapshot-'

// Read rank, as the knowledge graph ranks audiences for read boundaries. A Map,
// so only these names have a rank (an inherited name such as "constructor"
// is unknown, as it should be).
const AUDIENCE_READ_RANK = new Map([['public', 0], ['team', 1], ['operator', 2], ['staff', 2], ['private', 3], ['sensitive', 3]])
// A full commit id: 40 hex digits, or 64 in a SHA-256 repository.
export const FULL_COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const LINES_VALUE = /^([1-9][0-9]*)(?:-([1-9][0-9]*))?$/
// An edition or a record larger than this is reported as too large to verify,
// never as absent. Snapshot files are streamed, whatever their size.
const MAX_OBJECT_BYTES = 64 * 1024 * 1024
const COPY_CHUNK_BYTES = 1024 * 1024
// Changed Markdown is classified from its front matter, read up to this much.
const FRONT_MATTER_LIMIT = 256 * 1024
const NULL_OID = /^0+$/

const schema = JSON.parse(fs.readFileSync(new URL('../../contracts/atelier-graphmark.v1.schema.json', import.meta.url), 'utf8'))
let compiled = null
function contractValidator() {
  if (!compiled) {
    const ajv = new Ajv2020({ allErrors: true, strict: false })
    addFormats(ajv)
    compiled = ajv.compile(schema)
  }
  return compiled
}

// A lines range that ends before it starts names nothing; JSON Schema cannot
// say so, so the validator and the check share this. The bounds are compared
// as exact decimal integers, whatever their size.
export function linesOrderProblem(selector) {
  if (selector?.type !== 'lines') return null
  const match = LINES_VALUE.exec(selector.value ?? '')
  return match && match[2] && BigInt(match[2]) < BigInt(match[1]) ? `selector lines "${selector.value}" ends before it starts` : null
}

function contractFailures(frontMatter) {
  const validate = contractValidator()
  const failures = validate(frontMatter) ? [] : validate.errors.map((error) => ({ at: error.instancePath || '/', message: error.message }))
  const order = linesOrderProblem(frontMatter?.target?.selector)
  if (order) failures.push({ at: '/target/selector/value', message: `must be a range that does not end before it starts (${order})` })
  return failures
}

// Validate one mark record's front matter against atelier-graphmark@v1.
export function validateMarkRecord(frontMatter) {
  const errors = contractFailures(frontMatter).map((error) => `${error.at} ${error.message}`)
  return { ok: errors.length === 0, errors }
}

// Read a Markdown mark record's front matter with the graph's own reader.
export function readMarkRecord(raw) {
  const split = splitFrontmatter(raw)
  return split ? parseYamlSubset(split.yaml) : null
}

// The record body must say why: some line that is not blank and not a heading.
export function bodyReasonProblem(raw) {
  const body = splitFrontmatter(raw)?.body ?? ''
  const prose = body.split('\n').some((line) => line.trim() && !/^ {0,3}#/.test(line))
  return prose ? null : 'the record body is blank; it must say why the object was marked'
}

// The nearest enclosing Git repository root (a .git directory or file), or
// null when none encloses the path. The path itself need not exist.
export function gitRoot(dir) {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) return current
    if (path.dirname(current) === current) return null
  }
}

export const contentDigest = (bytes) => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`
const toPosix = (value) => value.split(path.sep).join('/')
const inside = (base, file) => file === base || file.startsWith(base + path.sep)
const short = (commit) => commit.slice(0, 12)
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`
const isDirectory = (value) => {
  try {
    return fs.statSync(value).isDirectory()
  } catch {
    return false
  }
}

// --- Git ------------------------------------------------------------------
//
// Ambient GIT_* variables (GIT_DIR, GIT_INDEX_FILE and the like) could select
// another repository; drop them, take no optional locks, ask Git not to fetch
// a partial clone's missing objects, and ignore local replace refs, which
// would let a commit appear to hold bytes shared history does not. The
// repository's own trusted configuration (object alternates, includes, the
// clean filters `git status` may run) still applies.
const GIT_ENV = { ...sanitizedGitEnvironment(process.env), GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' }

function gitRun(root, args, { input, stdin, stdout, maxBuffer = MAX_OBJECT_BYTES + 1024 * 1024 } = {}) {
  const result = spawnSync('git', ['--no-replace-objects', '--literal-pathspecs', '-C', root, ...args], {
    env: GIT_ENV,
    input,
    stdio: [stdin ?? (input === undefined ? 'ignore' : 'pipe'), stdout ?? 'pipe', 'ignore'],
    maxBuffer,
  })
  return { status: result.error ? null : result.status, stdout: result.stdout, error: result.error }
}

function git(root, args, options) {
  const result = gitRun(root, args, options)
  return result.status === 0 ? result.stdout : null
}

// Resolve a revision to a commit and say whether shared history holds it: a
// commit reachable from HEAD or from a branch, tag or remote branch. The stash
// and unreachable objects do not count. `exact` is true only for the full
// commit id itself.
export function resolveRevision(root, revision) {
  if (!root || typeof revision !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,127}$/.test(revision) || revision.includes('..') || /(^|\/)stash$/.test(revision)) return null
  const commit = git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${revision}^{commit}`])?.toString('utf8').trim()
  if (!commit) return null
  const reachable =
    git(root, ['merge-base', '--is-ancestor', commit, 'HEAD']) !== null ||
    Boolean(git(root, ['for-each-ref', '--contains', commit, '--format=%(refname)', 'refs/heads', 'refs/tags', 'refs/remotes'])?.toString('utf8').trim())
  return { commit, reachable, exact: FULL_COMMIT_ID.test(revision) && revision === commit }
}

// Tree entries from `ls-tree -z` output, with each path kept as bytes and
// decoded only when it is valid UTF-8 (`path` is null otherwise).
function treeEntries(output) {
  const entries = []
  let start = 0
  while (start < output.length) {
    let end = output.indexOf(0, start)
    if (end < 0) end = output.length
    const record = output.subarray(start, end)
    start = end + 1
    const tab = record.indexOf(0x09)
    if (tab < 0) continue
    const [mode, type, oid] = record.subarray(0, tab).toString('latin1').split(' ')
    const pathBytes = Buffer.from(record.subarray(tab + 1))
    let decoded = null
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(pathBytes)
    } catch {
      decoded = null
    }
    entries.push({ mode, type, oid, pathBytes, path: decoded })
  }
  return entries
}

// --- Reading objects without fetching ---------------------------------------
//
// A partial clone fetches a missing object on demand. GIT_NO_LAZY_FETCH asks
// Git not to, and a Git that ignores it is covered too: in a promisor
// repository, `rev-list --missing=print` (which never fetches) says what a
// commit lacks before anything is read.

// Whether `root` is a promisor (partial clone) repository, by Git's own
// boolean parser: any true spelling Git accepts counts, and a setting Git
// cannot parse counts too, so the check stays on the side that never fetches.
export function isPromisorRepository(root) {
  const flags = gitRun(root, ['config', '--type=bool', '--get-regexp', '^remote\\..*\\.promisor$'])
  const extension = gitRun(root, ['config', '--get', 'extensions.partialclone'])
  const settled = (result) => result.status === 0 || result.status === 1
  return !settled(flags) || !settled(extension) ||
    (flags.status === 0 && flags.stdout.toString('utf8').split('\n').some((line) => / true$/.test(line))) ||
    (extension.status === 0 && extension.stdout.toString('utf8').trim() !== '')
}

const stores = new Map()
function storeFor(root) {
  if (!stores.has(root)) stores.set(root, { promisor: isPromisorRepository(root), views: new Map() })
  return stores.get(root)
}

function missingAt(root, commit) {
  const store = storeFor(root)
  if (!store.promisor) return { missing: new Set(), treesMissing: false }
  if (!store.views.has(commit)) {
    const all = git(root, ['rev-list', '--objects', '--missing=print', '--no-walk', commit], { maxBuffer: 512 * 1024 * 1024 })
    const trees = git(root, ['rev-list', '--objects', '--missing=print', '--no-walk', '--filter=blob:none', commit], { maxBuffer: 512 * 1024 * 1024 })
    const missingOf = (out) => new Set(String(out ?? '').split('\n').filter((line) => line.startsWith('?')).map((line) => line.slice(1).trim()))
    store.views.set(commit, all === null || trees === null ? null : { missing: missingOf(all), treesMissing: missingOf(trees).size > 0 })
  }
  return store.views.get(commit)
}

// What `commit` holds at exactly `objectPath`, as a kind: `file` (with its
// bytes), `absent`, `symlink`, `directory`, `gitlink`, `too-large` (with its
// size), `unavailable` (a partial clone lacks it) or `failed` (Git could not
// say). Only `absent` means there is nothing there.
function lookup(root, commit, objectPath, limit = MAX_OBJECT_BYTES) {
  const view = missingAt(root, commit)
  if (!view) return { kind: 'failed' }
  if (view.treesMissing) return { kind: 'unavailable' }
  const listed = git(root, ['ls-tree', '-z', '--end-of-options', commit, '--', objectPath])
  if (listed === null) return { kind: 'failed' }
  const entry = treeEntries(listed).find((item) => item.path === objectPath)
  if (!entry) return { kind: 'absent' }
  if (entry.mode === '120000') return { kind: 'symlink' }
  if (entry.mode === '160000') return { kind: 'gitlink' }
  if (entry.type === 'tree') return { kind: 'directory' }
  if (entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755')) return { kind: 'failed' }
  if (view.missing.has(entry.oid)) return { kind: 'unavailable' }
  const size = Number(git(root, ['cat-file', '-s', entry.oid])?.toString('utf8').trim())
  if (!Number.isFinite(size)) return { kind: 'failed' }
  if (size > limit) return { kind: 'too-large', size }
  const bytes = git(root, ['cat-file', 'blob', entry.oid])
  return bytes ? { kind: 'file', bytes } : { kind: 'failed' }
}

const DESCRIBE_LOOKUP = {
  absent: () => 'is not there',
  symlink: () => 'is a symbolic link',
  directory: () => 'is a directory',
  gitlink: () => 'is a submodule (gitlink)',
  'too-large': (found) => `holds ${found.size} bytes, more than this check reads`,
  unavailable: () => 'names bytes that are not available in this clone (a partial clone is not fetched offline)',
  failed: () => 'could not be read from Git',
}
const describeLookup = (found) => DESCRIBE_LOOKUP[found.kind](found)

// --- The working tree, through Git's own status ------------------------------

// Path (from the repository root) to how the index or working tree differs
// from HEAD. Git normalises line endings and checkout filters, so a clean
// checkout reports nothing. `index` is the index's object id when the index
// holds a version that differs from HEAD; `working` is false when the working
// tree has no file there.
function workingStatus(root) {
  const result = gitRun(root, ['-c', 'core.fsmonitor=false', '-c', 'status.relativePaths=false', 'status', '--porcelain=v2', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules=all'], { maxBuffer: 512 * 1024 * 1024 })
  const changes = new Map()
  if (result.status !== 0) return { available: false, changes }
  for (const entry of result.stdout.toString('utf8').split('\0')) {
    if (entry.startsWith('? ')) changes.set(entry.slice(2), { kind: 'untracked', index: null, working: true })
    else if (entry.startsWith('1 ')) {
      const fields = entry.split(' ')
      const [x, y] = fields[1]
      const kind = x === 'A' ? 'added' : x === 'D' || y === 'D' ? 'deleted' : 'modified'
      const index = x !== '.' && x !== 'D' && !NULL_OID.test(fields[7]) ? fields[7] : null
      changes.set(fields.slice(8).join(' '), { kind, xy: fields[1], index, working: x !== 'D' && y !== 'D' })
    } else if (entry.startsWith('u ')) changes.set(entry.split(' ').slice(10).join(' '), { kind: 'unmerged', index: null, working: true })
  }
  return { available: true, changes }
}

// The start of a regular working-tree file inside `base`, never through a
// symbolic link: { bytes, complete }, or null when it is not a regular file.
function workingHead(base, file) {
  try {
    if (!inside(fs.realpathSync(base), fs.realpathSync(file))) return null
    const stat = fs.lstatSync(file)
    if (!stat.isFile()) return null
    const fd = fs.openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, FRONT_MATTER_LIMIT))
      const read = fs.readSync(fd, buffer, 0, buffer.length, 0)
      return { bytes: buffer.subarray(0, read), complete: stat.size <= FRONT_MATTER_LIMIT }
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}

// The start of a blob: { bytes, complete }, or null when Git cannot read it.
function blobHead(root, oid) {
  const result = gitRun(root, ['cat-file', 'blob', oid], { maxBuffer: FRONT_MATTER_LIMIT })
  if (result.status === 0) return { bytes: result.stdout, complete: true }
  if (result.error?.code === 'ENOBUFS' && result.stdout) return { bytes: result.stdout.subarray(0, FRONT_MATTER_LIMIT), complete: false }
  return null
}

// What one version of a Markdown file is, by its front matter: a mark record,
// a marks index, something else, or indeterminate (unreadable, or front
// matter that does not end within the limit).
function classifyMarkdown(head, unreadable = 'indeterminate') {
  if (!head) return unreadable
  const text = head.bytes.toString('utf8')
  const split = splitFrontmatter(text)
  if (!split) return !head.complete && /^---\r?\n/.test(text) ? 'indeterminate' : 'other'
  const record = parseYamlSubset(split.yaml)
  if (!Array.isArray(record?.tags) || !record.tags.includes(GRAPHMARK_TAG)) return 'other'
  return record.kg?.type === 'index' && record.target === undefined ? 'index' : 'mark'
}

// --- The committed snapshot --------------------------------------------------

// Run `body` with a private snapshot directory that is removed afterwards,
// whether `body` returns, throws or the process receives SIGINT or SIGTERM
// meanwhile (the signal is re-raised once the directory is gone). Directories
// a killed run left behind are reclaimed first: only this prefix, only
// directories this user owns, only when the process that made one is gone.
const activeSnapshots = new Set()
let signalsHeld = false
function onSnapshotSignal(signal) {
  for (const dir of activeSnapshots) fs.rmSync(dir, { recursive: true, force: true })
  activeSnapshots.clear()
  releaseSignals()
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal)
}
function holdSignals() {
  if (signalsHeld) return
  signalsHeld = true
  process.on('SIGINT', onSnapshotSignal)
  process.on('SIGTERM', onSnapshotSignal)
}
function releaseSignals() {
  if (!signalsHeld) return
  signalsHeld = false
  process.off('SIGINT', onSnapshotSignal)
  process.off('SIGTERM', onSnapshotSignal)
}

export function withPrivateSnapshot(body) {
  reclaimAbandonedSnapshots()
  holdSignals()
  let base = null
  try {
    base = fs.mkdtempSync(path.join(os.tmpdir(), `${SNAPSHOT_PREFIX}${process.pid}-`))
    activeSnapshots.add(base)
    return body(base)
  } finally {
    if (base) {
      fs.rmSync(base, { recursive: true, force: true })
      activeSnapshots.delete(base)
    }
    // A signal that arrived during synchronous work is delivered only once
    // the event loop runs. Keep the handler, and the loop, for one short tick
    // so the pending signal is delivered and re-raised, not dropped at exit.
    setTimeout(() => {
      if (!activeSnapshots.size) releaseSignals()
    }, 25)
  }
}

export function reclaimAbandonedSnapshots(dir = os.tmpdir()) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  if (uid === null) return
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    const match = new RegExp(`^${SNAPSHOT_PREFIX}([0-9]+)-[A-Za-z0-9]+$`).exec(name)
    if (!match || Number(match[1]) === process.pid) continue
    const full = path.join(dir, name)
    try {
      const stat = fs.lstatSync(full)
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid) continue
      process.kill(Number(match[1]), 0)
    } catch (error) {
      if (error?.code === 'ESRCH') fs.rmSync(full, { recursive: true, force: true })
    }
  }
}

// Paths a checkout of this tree could not hold faithfully: not valid UTF-8,
// a segment Git refuses, the same path twice, or two paths that one
// case-insensitive or Unicode-normalising filesystem would merge.
function pathProblems(entries) {
  const problems = []
  const folded = new Map()
  const exact = new Set()
  for (const entry of entries) {
    if (entry.path === null) {
      problems.push(`a path that is not valid UTF-8 (bytes ${entry.pathBytes.toString('hex')})`)
      continue
    }
    const segments = entry.path.split('/')
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment.toLowerCase() === '.git')) {
      problems.push(`${entry.path} is not a path a checkout can hold`)
      continue
    }
    if (exact.has(entry.path)) problems.push(`${entry.path} appears twice`)
    exact.add(entry.path)
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const name = segments.slice(0, depth).join('/')
      const key = name.normalize('NFC').toLowerCase()
      const prior = folded.get(key)
      if (prior === undefined) folded.set(key, name)
      else if (prior !== name) problems.push(`${name} and ${prior} name one file on a case-insensitive or Unicode-normalising filesystem`)
    }
  }
  return [...new Set(problems)]
}

// Stream the blobs of `items` from Git into files under `destination` with
// bounded memory: `cat-file --batch` writes into a file, which is copied out
// in chunks. Files are created exclusively, so nothing is overwritten.
function streamBlobs(root, items, destination, base, recorded) {
  if (!items.length) return
  const stamp = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`
  const listFile = path.join(base, `batch-${stamp}.in`)
  const outFile = path.join(base, `batch-${stamp}.out`)
  fs.writeFileSync(listFile, `${items.map((item) => item.oid).join('\n')}\n`)
  const input = fs.openSync(listFile, 'r')
  const output = fs.openSync(outFile, 'w')
  let status
  try {
    status = gitRun(root, ['cat-file', '--batch'], { stdin: input, stdout: output }).status
  } finally {
    fs.closeSync(input)
    fs.closeSync(output)
  }
  if (status !== 0) {
    for (const item of items) recorded.missing.push(item.path)
    fs.rmSync(listFile, { force: true })
    fs.rmSync(outFile, { force: true })
    return
  }
  const reader = fs.openSync(outFile, 'r')
  const chunk = Buffer.alloc(COPY_CHUNK_BYTES)
  let offset = 0
  try {
    for (const item of items) {
      const head = Buffer.alloc(256)
      const got = fs.readSync(reader, head, 0, head.length, offset)
      const newline = head.subarray(0, got).indexOf(0x0a)
      if (newline < 0) {
        recorded.missing.push(item.path)
        break
      }
      const [oid, type, sizeText] = head.subarray(0, newline).toString('latin1').split(' ')
      offset += newline + 1
      if (oid !== item.oid || type !== 'blob') {
        recorded.missing.push(item.path)
        continue
      }
      const file = path.join(destination, ...item.path.split('/'))
      if (!inside(destination, file)) throw new Error(`refusing to write outside the snapshot: ${item.path}`)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const target = fs.openSync(file, 'wx')
      try {
        for (let remaining = Number(sizeText); remaining > 0;) {
          const read = fs.readSync(reader, chunk, 0, Math.min(chunk.length, remaining), offset)
          if (read <= 0) throw new Error(`the batch for ${item.path} ended early`)
          fs.writeSync(target, chunk, 0, read)
          offset += read
          remaining -= read
        }
      } finally {
        fs.closeSync(target)
      }
      offset += 1
    }
  } finally {
    fs.closeSync(reader)
    fs.rmSync(listFile, { force: true })
    fs.rmSync(outFile, { force: true })
  }
}

// Write the committed regular files under `prefixes` of `root` at HEAD into
// `destination`, after checking that every path can be held faithfully.
function materialise(root, commit, prefixes, destination, base) {
  const recorded = { links: [], gitlinks: [], missing: [], unreadable: false, problems: [], written: new Set() }
  const view = missingAt(root, commit)
  const scope = prefixes.includes('') ? [] : ['--', ...prefixes]
  const listing = view && !view.treesMissing ? git(root, ['ls-tree', '-r', '-z', '--full-tree', commit, ...scope], { maxBuffer: 512 * 1024 * 1024 }) : null
  if (listing === null) {
    recorded.unreadable = true
    return recorded
  }
  const entries = treeEntries(listing)
  recorded.problems = pathProblems(entries)
  if (recorded.problems.length) return recorded
  const regular = []
  for (const entry of entries) {
    if (entry.mode === '120000') recorded.links.push(entry.path)
    else if (entry.mode === '160000') recorded.gitlinks.push(entry.path)
    else if (entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755')) {
      if (view.missing.has(entry.oid)) recorded.missing.push(entry.path)
      else regular.push({ oid: entry.oid, path: entry.path })
    }
  }
  try {
    streamBlobs(root, regular, destination, base, recorded)
  } catch (error) {
    recorded.problems.push(`a file could not be written into the snapshot (${error.message})`)
  }
  for (const item of regular) recorded.written.add(item.path)
  return recorded
}

// Run `build` with no ambient Git variables and with Git unable to find a
// repository above the snapshot, so the graph's own Git calls see only it.
function hermeticGit(ceiling, build) {
  const saved = {}
  for (const key of Object.keys(process.env)) {
    if (key.toUpperCase().startsWith('GIT_')) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
  }
  process.env.GIT_CEILING_DIRECTORIES = ceiling
  try {
    return build()
  } finally {
    delete process.env.GIT_CEILING_DIRECTORIES
    Object.assign(process.env, saved)
  }
}

// The committed project, verified from Git:
// 1. find the config's repository and read the config from its HEAD blob (it
//    need not be checked out, and an unfinished edit does not matter);
// 2. resolve it against this checkout (tracked paths, --repo-path, a local
//    overlay, sibling discovery give each repository its location);
// 3. read the effective repository access file from the committed tree of the
//    project repository that holds it; only true absence means defaults;
// 4. stream each managed repository folder's committed files into the
//    snapshot, and map the project onto it with no further resolution.
function buildSnapshot(base, request) {
  const mirror = (abs) => path.join(base, 'tree', path.resolve(abs).replace(/^([A-Za-z]):/, '$1'))
  const errors = []
  const warnings = []
  const snapshot = { errors, warnings, repositories: new Map(), project: null }
  const roots = new Map()
  const take = (root) => {
    if (!roots.has(root)) {
      const head = resolveRevision(root, 'HEAD')
      const status = workingStatus(root)
      if (!head) errors.push(`${root}: has no commit at HEAD, so nothing committed can be verified`)
      if (!status.available) errors.push(`${root}: git status failed, so uncommitted mark records cannot be ruled out; the result is indeterminate`)
      roots.set(root, { root, head, status, mirror: mirror(root), prefixes: new Set(), extra: [] })
    }
    return roots.get(root)
  }

  // 1. The committed config.
  const { configPath } = request
  const configRoot = gitRoot(path.dirname(configPath))
  if (!configRoot) {
    errors.push(`${configPath}: the project config is not in a Git repository, so its committed policy cannot be read`)
    return snapshot
  }
  const configOwner = take(configRoot)
  if (errors.length) return snapshot
  const configRel = toPosix(path.relative(configRoot, configPath))
  const committedConfig = lookup(configRoot, configOwner.head.commit, configRel)
  if (committedConfig.kind !== 'file') {
    errors.push(committedConfig.kind === 'absent'
      ? `${configRel}: the project config is not committed at HEAD, so its policy cannot be verified`
      : `${configRel}: the committed project config ${describeLookup(committedConfig)}, so its policy cannot be verified`)
    return snapshot
  }
  let document
  try {
    document = JSON.parse(committedConfig.bytes.toString('utf8'))
  } catch {
    errors.push(`${configRel}: the project config committed at HEAD is not valid JSON`)
    return snapshot
  }
  for (const problem of validateProjectConfigDoc(document)) errors.push(`${configRel} (committed at HEAD): ${problem}`)
  if (errors.length) return snapshot
  configOwner.extra.push({ rel: configRel, bytes: committedConfig.bytes })
  const configChange = configOwner.status.changes.get(configRel)
  if (configChange) warnings.push(`${configRel}: has uncommitted changes (${configChange.kind}), which this check does not use; it reads the project config committed at HEAD`)

  // 2. Locations for this checkout.
  const env = { ...request.env }
  delete env[PROJECT_CONFIG_ENV]
  let resolved
  try {
    resolved = resolveProjectConfig({ argv: ['--project', configPath, ...request.overrides], cwd: request.cwd, env, configDocument: document, writeLocalState: false })
  } catch (error) {
    errors.push(`the project config committed at HEAD cannot be resolved here: ${error.message}`)
    return snapshot
  }
  if (resolved.schema !== PROJECT_CONFIG_SCHEMA) errors.push(`${configRel} (committed at HEAD): schema must be ${PROJECT_CONFIG_SCHEMA}`)
  const managed = (resolved.repos ?? []).filter((repo) => !repo.external && repo.name)
  if (!managed.length) errors.push(`${configRel} (committed at HEAD): it declares no managed repository`)
  for (const repo of managed) {
    const root = repo.path ? gitRoot(repo.path) : null
    if (!root) {
      errors.push(`repository ${repo.name}: ${repo.path ?? 'its location'} is not in a Git repository, so nothing committed can be verified`)
      continue
    }
    take(root).prefixes.add(toPosix(path.relative(root, repo.path)))
  }
  if (errors.length) return snapshot

  // 3. The effective read policy, bound to the committed tree that holds it.
  const accessPath = path.resolve(resolved.repoAccessPath)
  const accessOwner = [...roots.values()].filter((entry) => inside(entry.root, accessPath)).sort((a, b) => b.root.length - a.root.length)[0]
  if (!accessOwner) {
    errors.push(`the repository access file ${accessPath} is outside the project's repositories, so no committed version of it can be read; the check does not read live files or fall back to defaults`)
    return snapshot
  }
  const accessRel = toPosix(path.relative(accessOwner.root, accessPath))
  const committedAccess = lookup(accessOwner.root, accessOwner.head.commit, accessRel)
  if (committedAccess.kind === 'file') accessOwner.extra.push({ rel: accessRel, bytes: committedAccess.bytes })
  else if (committedAccess.kind !== 'absent') {
    errors.push(`${accessRel}: the committed repository access file ${describeLookup(committedAccess)}; the check does not fall back to defaults`)
    return snapshot
  }
  const accessChange = accessOwner.status.changes.get(accessRel)
  if (accessChange) warnings.push(`${accessRel}: has uncommitted changes (${accessChange.kind}), which this check does not use; it reads the repository access file committed at HEAD${committedAccess.kind === 'absent' ? ' (there is none, so defaults apply)' : ''}`)

  // 4. The committed files of each managed folder.
  for (const entry of roots.values()) {
    const prefixes = [...entry.prefixes]
    const recorded = prefixes.length ? materialise(entry.root, entry.head.commit, prefixes, entry.mirror, base) : { links: [], gitlinks: [], missing: [], unreadable: false, problems: [], written: new Set() }
    entry.recorded = recorded
    if (recorded.unreadable) errors.push(`${entry.root}: HEAD's tree cannot be read without fetching objects this clone lacks`)
    for (const problem of recorded.problems.slice(0, 5)) errors.push(`${entry.root}: HEAD's tree cannot be written faithfully: ${problem}; the check refuses rather than lose or merge a file`)
    for (const { rel, bytes } of entry.extra) {
      if (recorded.written.has(rel)) continue
      const file = path.join(entry.mirror, ...rel.split('/'))
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, bytes, { flag: 'wx' })
      } catch (error) {
        errors.push(`${entry.root}: ${rel} could not be written into the snapshot faithfully (${error.code ?? error.message}); the check refuses rather than read another file`)
      }
    }
  }
  if (errors.length) return snapshot

  for (const repo of managed) {
    const owner = roots.get(gitRoot(repo.path))
    const folder = mirror(repo.path)
    snapshot.repositories.set(repo.name, { folder, realFolder: path.resolve(repo.path), root: owner.root, mirror: owner.mirror, head: owner.head, status: owner.status })
    const prefix = toPosix(path.relative(owner.root, repo.path))
    const within = (objectPath) => prefix === '' || objectPath === prefix || objectPath.startsWith(`${prefix}/`)
    const missing = owner.recorded.missing.filter(within)
    if (missing.length) errors.push(`repository ${repo.name}: HEAD names ${missing.length} file(s) this clone lacks (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''}); the committed graph cannot be built without them`)
    for (const link of owner.recorded.links.filter(within).filter((objectPath) => /\.(md|kg\.json)$/i.test(objectPath))) {
      warnings.push(`${link}: is a symbolic link at HEAD; the check does not follow links, so it is not part of the committed graph`)
    }
  }
  // The committed project, mapped onto the snapshot. External repositories
  // are not read, so they are left out: no discovery, no remote probes.
  for (const dir of [resolved.configDir, resolved.workspaceRoot, resolved.repoOpsRoot]) fs.mkdirSync(mirror(dir), { recursive: true })
  snapshot.project = {
    ...resolved,
    configPath: mirror(configPath),
    configDir: mirror(resolved.configDir),
    workspaceRoot: mirror(resolved.workspaceRoot),
    repoOpsRoot: mirror(resolved.repoOpsRoot),
    repoAccessPath: mirror(accessPath),
    repos: managed.map((repo) => ({ ...repo, path: mirror(repo.path) })),
  }
  return snapshot
}

// objectId must be one literal path from the Git repository root.
export function objectIdProblem(objectId) {
  if (typeof objectId !== 'string' || !objectId) return 'target objectId is empty'
  const segments = objectId.split('/')
  if (objectId.includes('\\') || objectId.startsWith('/') || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return `target objectId "${objectId}" must be one literal path from the Git repository root ("/"-separated, with no leading or trailing "/" and no empty, "." or ".." part); it leaves the repository or is not canonical`
  }
  if (segments[0].toLowerCase() === '.git') return `target objectId "${objectId}" points into .git`
  return null
}

// The selector must be one the standard defines.
export function selectorProblem(selector) {
  if (!selector || typeof selector !== 'object') return 'target selector is missing'
  if (!SELECTOR_TYPES.includes(selector.type)) return `selector type "${selector.type}" is not one of ${SELECTOR_TYPES.join(', ')}`
  if (selector.version !== '1') return `selector ${selector.type} version "${selector.version}" is not 1`
  if (selector.type === 'whole' && selector.value !== '*') return 'selector whole must have the value "*"'
  if (selector.type === 'lines' && !LINES_VALUE.test(selector.value ?? '')) return `selector lines "${selector.value}" must be N or N-M (1-based, inclusive)`
  return linesOrderProblem(selector)
}

export function revisionProblem(revision) {
  return FULL_COMMIT_ID.test(revision ?? '') ? null : `target revision "${revision}" is not a full commit id; a name or an abbreviation is not a portable edition`
}

// Readable problems with the target's form, keyed by the field they concern.
function targetFormProblems(target) {
  if (!target || typeof target !== 'object') return []
  return [
    ['objectId', objectIdProblem(target.objectId)],
    ['selector', selectorProblem(target.selector)],
    ['revision', revisionProblem(target.revision)],
  ].filter(([, problem]) => problem)
}

// The edition as text, for a lines or text-quote selector: valid UTF-8 with no
// NUL byte. A binary edition can only be marked whole.
function editionText(bytes) {
  if (bytes.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

// Lines are the text split at line feeds; a final line feed ends the last
// line, and an empty edition has no lines.
export function lineCount(text) {
  if (text === '') return 0
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

// Every occurrence, overlapping ones included.
export function occurrences(text, quote) {
  let count = 0
  for (let index = text.indexOf(quote); index !== -1; index = text.indexOf(quote, index + 1)) count += 1
  return count
}

// A verified selector names exactly one part of the edition.
function selectionProblem(selector, bytes) {
  if (selector.type === 'whole') return null
  const text = editionText(bytes)
  if (text === null) return `selector ${selector.type} needs a UTF-8 text edition, and the marked edition is binary or not valid UTF-8; mark it whole`
  if (selector.type === 'lines') {
    const [, startText, endText] = LINES_VALUE.exec(selector.value)
    const count = lineCount(text)
    if (BigInt(endText ?? startText) > BigInt(count)) return `selector lines ${selector.value} fall outside the marked edition (${count} lines)`
    return null
  }
  const found = occurrences(text, selector.value)
  if (found === 0) return 'selector text-quote is not in the marked edition'
  if (found > 1) return `selector text-quote occurs ${found} times in the marked edition; a mark names one part, so quote enough to occur once`
  return null
}

// The audience a kg block declares: absent (no kg block or no audience), a
// name, or a value that is not a name, which is an error, not "private".
function declaredAudienceOf(kg) {
  if (!kg || typeof kg !== 'object' || !Object.hasOwn(kg, 'audience') || kg.audience === undefined) return { absent: true }
  if (typeof kg.audience !== 'string') return { problem: `it declares an audience that is not a name (${JSON.stringify(kg.audience)})` }
  return { audience: kg.audience.trim() }
}

// The audience an edition declares for itself at `commit`: Markdown front
// matter (undeclared Markdown is private, as the graph treats it), or for any
// other file its sidecar as committed at the same commit, read under the same
// rules as the object. { audience: null } when a non-Markdown file has no
// sidecar there.
function declaredAudienceAt(root, commit, objectPath, bytes) {
  if (/\.md$/i.test(objectPath)) {
    const declared = declaredAudienceOf(readMarkRecord(bytes.toString('utf8'))?.kg)
    return declared.absent ? { audience: 'private' } : declared
  }
  const sidecar = lookup(root, commit, `${objectPath}.kg.json`)
  if (sidecar.kind === 'absent') return { audience: null }
  if (sidecar.kind !== 'file') return { problem: `its sidecar ${describeLookup(sidecar)}` }
  let parsed
  try {
    parsed = JSON.parse(sidecar.bytes.toString('utf8'))
  } catch {
    return { problem: 'its sidecar is not valid JSON' }
  }
  const declared = declaredAudienceOf(parsed?.kg)
  return declared.absent ? { audience: 'private' } : declared
}

// A repository passed as a plain directory is read as it stands: its graph
// files are taken as given and only its records and editions come from Git.
function repositoryContext(value) {
  if (typeof value !== 'string') return value
  const folder = path.resolve(value)
  const root = gitRoot(folder)
  return { folder, realFolder: folder, root, mirror: root, head: root ? resolveRevision(root, 'HEAD') : null, status: root ? workingStatus(root) : { available: false, changes: new Map() } }
}

// Check every mark in a built graph. `repositories` maps every configured repo
// name to its context (from the committed snapshot) or to its directory;
// `expect` lists mark ids that must be present. Returns { ok, marks, errors,
// warnings }; every mark record appears in `marks`, `refused` when it has any
// error.
export function checkGraphmarksInGraph(graph, repositories, { expect = [] } = {}) {
  const errors = []
  const warnings = []
  const marks = []
  const tagged = (node) => Array.isArray(node.tags) && node.tags.includes(GRAPHMARK_TAG)
  const contexts = new Map([...repositories].map(([name, value]) => [name, repositoryContext(value)]))
  const folders = new Map([...contexts].map(([name, context]) => [name, context.folder]))
  const nodesByFile = new Map(graph.nodes.filter((node) => folders.has(node.repo)).map((node) => [path.resolve(folders.get(node.repo), node.path), node]))
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]))
  const seen = new Set()
  const SKIP = Symbol('marks index')
  // A path from its repository root, for Git and for status.
  const fromRoot = (context, file) => toPosix(path.relative(context.mirror, file))
  const committedRecord = (node) => {
    const context = contexts.get(node.repo)
    if (!context?.root || !context.head) return { kind: 'failed' }
    return lookup(context.root, context.head.commit, fromRoot(context, path.join(context.folder, node.path)))
  }
  const isIndexWithoutTarget = (node) => {
    if (node.type !== 'index') return false
    const found = committedRecord(node)
    return found.kind !== 'file' || readMarkRecord(found.bytes.toString('utf8'))?.target === undefined
  }
  // Every Markdown node tagged graphmark is a mark record, except a marks index
  // (kg type index) that carries no target.
  const candidates = graph.nodes.filter((node) => tagged(node) && /\.md$/i.test(node.path ?? ''))

  // Changed Markdown in a managed folder that is not a committed mark: what
  // its index version and its working copy are. A pending mark record, staged
  // or not, is refused; a pending marks index is reported; one that cannot be
  // classified makes the result indeterminate.
  const scanned = new Set()
  for (const [name, context] of contexts) {
    if (!context.root || !context.head) continue
    if (!context.status?.available) {
      if (!scanned.has(context.root)) errors.push(`${context.root}: git status failed, so uncommitted mark records cannot be ruled out; the result is indeterminate`)
      scanned.add(context.root)
      continue
    }
    const key = `${context.root}\0${context.realFolder}`
    if (scanned.has(key)) continue
    scanned.add(key)
    for (const [objectPath, change] of context.status.changes) {
      if (!/\.md$/i.test(objectPath)) continue
      const file = path.join(context.root, ...objectPath.split('/'))
      if (!inside(context.realFolder, file)) continue
      const atHead = lookup(context.root, context.head.commit, objectPath)
      // A link, a directory or a submodule is never a mark record; a version
      // Git cannot show makes the answer indeterminate.
      const headKind = atHead.kind === 'file'
        ? classifyMarkdown({ bytes: atHead.bytes, complete: true })
        : atHead.kind === 'absent' ? 'none' : ['symlink', 'directory', 'gitlink'].includes(atHead.kind) ? 'other' : 'indeterminate'
      if (headKind === 'mark') continue // a committed record: inspected with the marks
      const versions = []
      if (change.index) versions.push(['index', classifyMarkdown(blobHead(context.root, change.index))])
      if (change.working) versions.push(['working tree', classifyMarkdown(workingHead(context.root, file), 'other')])
      if (headKind === 'indeterminate') versions.push(['committed tree', 'indeterminate'])
      const where = `${name}/${toPosix(path.relative(context.realFolder, file))}`
      const of = (kind) => versions.filter(([, found]) => found === kind).map(([place]) => place).join(' and ')
      if (of('mark')) errors.push(`${where}: the mark record is not committed at HEAD (it is in the ${of('mark')}); commit it before checking`)
      else if (of('indeterminate')) errors.push(`${where}: cannot tell whether the version in the ${of('indeterminate')} is a mark record (its front matter is unreadable or longer than ${FRONT_MATTER_LIMIT} bytes); the result is indeterminate`)
      else if (of('index')) warnings.push(`${where}: an uncommitted marks index change (${change.kind}); this check verified the marks index committed at HEAD`)
    }
  }

  if (graph.errors?.length) {
    // The committed graph does not build: no mark can be verified. Report each
    // record the graph could read as refused, beside the graph's own errors.
    for (const error of graph.errors) errors.push(`knowledge graph: ${error}`)
    for (const node of candidates) {
      if (isIndexWithoutTarget(node)) continue
      seen.add(node.id)
      marks.push({ id: node.id, path: `${node.repo}/${node.path}`, edition: 'refused' })
    }
    expectations()
    return { ok: false, marks, errors, warnings }
  }

  // A record in a marks index without the tag would never be checked.
  const marksIndexes = new Set(graph.nodes.filter((node) => node.type === 'index' && tagged(node)).map((node) => node.id))
  for (const node of candidates.filter((candidate) => candidate.type !== 'index')) {
    for (const index of node.relations?.belongs_to ?? []) if (nodesById.get(index)?.type === 'index') marksIndexes.add(index)
  }
  for (const node of graph.nodes) {
    if (tagged(node)) continue
    const index = (node.relations?.belongs_to ?? []).find((id) => marksIndexes.has(id))
    if (index) errors.push(`${node.repo}/${node.path}: belongs to the marks index ${index} but is not tagged ${GRAPHMARK_TAG}, so it is not checked; tag it, or take it out of the index`)
  }

  // Uncommitted changes to what a mark depends on: the check verified the
  // committed version, and says so.
  const advise = (where, label, context, objectPath) => {
    const change = context?.status?.changes.get(objectPath)
    if (change) warnings.push(`${where}: ${label} ${objectPath} has uncommitted changes (${change.kind}); this check verified the version committed at HEAD`)
  }
  const nodeFiles = (dependency) => {
    const context = contexts.get(dependency.repo)
    if (!context) return []
    const source = fromRoot(context, path.join(context.folder, dependency.path))
    return [[context, source], ...(/\.md$/i.test(dependency.path) ? [] : [[context, `${source}.kg.json`]])]
  }

  const inspect = (node) => {
    const where = `${node.repo}/${node.path}`
    const context = contexts.get(node.repo)
    if (!context) {
      errors.push(`${where}: repository is not readable from this project`)
      return null
    }
    if (isIndexWithoutTarget(node)) return SKIP
    seen.add(node.id)
    const { root, head } = context
    if (!root || !head) {
      errors.push(`${where}: the repository is not under Git, so no mark record or edition can be verified`)
      return null
    }

    // The record readers receive is the committed one; an uncommitted edit to
    // it would make a green check describe a record nobody has.
    const recordPath = fromRoot(context, path.join(context.folder, node.path))
    const committed = lookup(root, head.commit, recordPath)
    if (committed.kind !== 'file') {
      errors.push(committed.kind === 'absent'
        ? `${where}: the mark record is not committed at HEAD; commit it before checking`
        : `${where}: the committed mark record ${describeLookup(committed)}`)
      return null
    }
    const change = context.status?.changes.get(recordPath)
    if (change) errors.push(`${where}: the working-tree mark record differs from the one committed at HEAD (${change.kind}); commit or discard the change before checking, since readers receive the committed record`)
    const raw = committed.bytes.toString('utf8')
    const record = readMarkRecord(raw)
    if (!record) {
      errors.push(`${where}: tagged ${GRAPHMARK_TAG} but has no front matter; a mark exists only when its record is written`)
      return null
    }
    if (record.kg?.id) seen.add(record.kg.id)

    // The contract, with readable messages for the target's form. A revision
    // that is not a full commit id still gets repair hints below.
    const failures = contractFailures(record)
    const forms = targetFormProblems(record.target)
    const covered = forms.map(([field]) => `/target/${field}`)
    for (const failure of failures) {
      if (!covered.some((field) => failure.at === field || failure.at.startsWith(`${field}/`))) errors.push(`${where}: ${GRAPHMARK_CONTRACT} ${failure.at} ${failure.message}`)
    }
    const at = `${where}: ${record.target?.objectId ?? 'target'}`
    for (const [, problem] of forms) errors.push(`${at}: ${problem}`)
    const reasonProblem = bodyReasonProblem(raw)
    if (reasonProblem) errors.push(`${where}: ${reasonProblem}`)
    if (failures.some((failure) => failure.at !== '/target/revision') || forms.some(([field]) => field !== 'revision')) return null

    const { target } = record
    if (target.owner !== node.repo) {
      errors.push(`${where}: target owner "${target.owner}" is not this repository "${node.repo}"; a mark lives in the repository that owns what it marks`)
      return null
    }
    for (const index of record.kg.relations.belongs_to) {
      if (nodesById.get(index)?.type !== 'index') errors.push(`${where}: belongs_to ${index} is not a marks index (kg type index)`)
    }

    const objectPath = target.objectId
    const file = path.join(context.mirror, ...objectPath.split('/'))
    // A target must lie with its owner, not in another configured repository.
    const foreign = [...folders].find(([name, dir]) => name !== node.repo && inside(dir, file) && !inside(dir, context.folder))
    if (foreign) {
      errors.push(`${at}: lies in repository "${foreign[0]}", not in "${node.repo}"; mark it in the repository that owns it`)
      return null
    }
    const fileNode = nodesByFile.get(file)
    advise(where, 'the marked file', context, objectPath)
    advise(where, 'its sidecar', context, `${objectPath}.kg.json`)
    const dependencies = new Map()
    for (const id of record.kg.relations.evidences) if (nodesById.has(id) && id !== fileNode?.id) dependencies.set(id, ['evidences', nodesById.get(id)])
    for (const id of record.kg.relations.belongs_to) if (nodesById.has(id)) dependencies.set(id, ['the marks index', nodesById.get(id)])
    for (const [id, [role, dependency]] of dependencies) {
      for (const [dependencyContext, dependencyPath] of nodeFiles(dependency)) advise(where, `${role} ${id}:`, dependencyContext, dependencyPath)
    }

    // The edition: target.revision is a full commit id, reachable from HEAD or
    // a branch, tag or remote branch, that holds bytes with contentDigest at
    // exactly target.objectId.
    const resolved = resolveRevision(root, target.revision)
    const revision = resolved?.exact ? resolved : null
    const atRev = revision?.reachable ? lookup(root, revision.commit, objectPath) : null
    let failure = null
    if (!FULL_COMMIT_ID.test(target.revision)) failure = 'revision-form'
    else if (!revision) failure = `revision ${target.revision} is not a commit id in this repository`
    else if (!revision.reachable) failure = `revision ${target.revision} is not reachable from HEAD or any branch or tag`
    else if (atRev.kind === 'absent') failure = `revision ${short(revision.commit)} does not hold ${objectPath}`
    else if (atRev.kind !== 'file') failure = `at revision ${short(revision.commit)}, ${objectPath} ${describeLookup(atRev)}; it cannot be verified`
    else if (contentDigest(atRev.bytes) !== target.contentDigest) failure = `revision ${short(revision.commit)} holds different bytes at ${objectPath}`

    if (failure) {
      if (failure !== 'revision-form') errors.push(`${at}: the marked edition is not verified: ${failure}`)
      for (const hint of repairHints({ context, target, resolved })) warnings.push(`${at}: repair hint: ${hint}`)
      return null
    }
    const editionBytes = atRev.bytes
    const selected = selectionProblem(target.selector, editionBytes)
    if (selected) {
      errors.push(`${at}: ${selected}`)
      return null
    }

    // Currency: what HEAD holds at the same path. Only absence is `removed`.
    // Anything else HEAD cannot show as a file (a directory, a submodule, a
    // link, too large, unavailable, a failed lookup) leaves its currency and
    // its current audience unchecked, so the mark is refused.
    const atHead = lookup(root, head.commit, objectPath)
    // Read Git as the check did: replace refs would return other bytes.
    const recover = ['git', '-C', root, '--no-replace-objects', 'cat-file', 'blob', `${revision.commit}:${objectPath}`]
    const recoverText = recover.map((arg) => (/^[A-Za-z0-9._-]+$/.test(arg) ? arg : shellQuote(arg))).join(' ')
    let edition
    if (atHead.kind === 'absent') {
      edition = 'removed'
      warnings.push(`${at}: is no longer held at HEAD; the marked edition is recoverable with \`${recoverText}\``)
    } else if (atHead.kind !== 'file') {
      edition = 'unreadable'
      errors.push(`${at}: at HEAD it ${describeLookup(atHead)}, so whether it changed and what audience it now declares cannot be checked`)
    } else if (contentDigest(atHead.bytes) === target.contentDigest) edition = 'intact'
    else {
      edition = 'changed'
      warnings.push(`${at}: has changed since it was marked; the marked edition is recoverable with \`${recoverText}\``)
      const now = editionText(atHead.bytes)
      if (target.selector.type === 'text-quote' && now !== null && !now.includes(target.selector.value)) {
        warnings.push(`${at}: the marked quote is no longer in the current file`)
      }
    }

    // Audience: a mark is never more widely visible than its marked edition
    // declares, nor than its owner's committed policy: the marked file's node,
    // or, for a file that is not a graph node, the repository's read boundary
    // and what the file declares at HEAD. The narrowest wins, and an audience
    // this check cannot read is an error.
    const materials = []
    const declared = declaredAudienceAt(root, revision.commit, objectPath, editionBytes)
    if (declared.problem) errors.push(`${at}: at ${short(revision.commit)}, ${declared.problem}; its declared audience cannot be checked`)
    else if (declared.audience !== null) materials.push({ id: `${objectPath} (the audience its marked edition declares)`, audience: declared.audience })
    if (fileNode) {
      materials.push({ id: fileNode.id, audience: fileNode.audience })
      if (!record.kg.relations.evidences.includes(fileNode.id)) {
        errors.push(`${where}: evidences must name the marked node ${fileNode.id}`)
      }
    } else {
      materials.push({ id: `${objectPath} (the repository's read boundary)`, audience: node.repoAccess?.readBoundary ?? 'private' })
      if (atHead.kind === 'file') {
        const current = declaredAudienceAt(root, head.commit, objectPath, atHead.bytes)
        if (current.problem) errors.push(`${at}: at HEAD, ${current.problem}; its declared audience cannot be checked`)
        else if (current.audience !== null) materials.push({ id: `${objectPath} (the audience it declares at HEAD)`, audience: current.audience })
      }
    }
    for (const targetId of record.kg.relations.evidences) {
      const targetNode = nodesById.get(targetId)
      if (targetNode) materials.push({ id: targetNode.id, audience: targetNode.audience })
      else errors.push(`${where}: evidences ${targetId} is not a node in this graph, so its audience cannot be checked`)
    }
    const markRank = AUDIENCE_READ_RANK.get(record.kg.audience)
    for (const material of new Map(materials.map((item) => [item.id, item])).values()) {
      if (typeof material.audience !== 'string' || !AUDIENCE_READ_RANK.has(material.audience)) {
        errors.push(`${where}: ${material.id} has the unknown audience "${material.audience}"; a mark cannot be checked against it`)
      } else if (markRank === undefined || markRank < AUDIENCE_READ_RANK.get(material.audience)) {
        errors.push(`${where}: the mark's audience "${record.kg.audience}" is wider than "${material.audience}" of ${material.id}; a mark is never more widely visible than what it marks`)
      }
    }

    return {
      id: record.kg.id,
      path: where,
      markState: record.markState,
      edition,
      selector: target.selector.type,
      audience: record.kg.audience,
      objectId: objectPath,
      revision: revision.commit,
      recover,
    }
  }

  for (const node of candidates) {
    const before = errors.length
    const entry = inspect(node)
    if (entry === SKIP) continue
    const mark = entry ?? { id: node.id, path: `${node.repo}/${node.path}` }
    // A mark with any error is refused, whatever its bytes are.
    marks.push(errors.length > before ? { ...mark, edition: 'refused' } : mark)
  }
  expectations()
  return { ok: errors.length === 0, marks, errors, warnings }

  function expectations() {
    for (const id of expect) {
      if (seen.has(id)) continue
      const node = nodesById.get(id)
      errors.push(!node
        ? `expected mark ${id} was not found in the knowledge graph`
        : tagged(node)
          ? `expected mark ${id} is a marks index, not a mark record`
          : `expected mark ${id} is not a GraphMark record: it is not tagged ${GRAPHMARK_TAG}`)
    }
  }
}

// Diagnostics for an edition that did not verify. Each names a fix; none makes
// the mark verified. The working tree is consulted only through status.
function repairHints({ context, target, resolved }) {
  const { root, head, folder, mirror } = context
  const hints = []
  const objectPath = target.objectId
  const holds = (commit, at) => {
    const found = commit ? lookup(root, commit, at) : null
    return found?.kind === 'file' && contentDigest(found.bytes) === target.contentDigest
  }
  const named = resolved?.reachable ? resolved.commit : null
  if (named && !resolved.exact && holds(named, objectPath)) {
    hints.push(`"${target.revision}" resolves to ${named}, which holds the marked bytes; record that full commit id as target.revision`)
  } else if (head && holds(head.commit, objectPath)) {
    hints.push(`HEAD (${head.commit}) holds the marked bytes at ${objectPath}; if that is the edition that was marked, record its full commit id as target.revision`)
  }
  const folderForm = toPosix(path.relative(mirror, path.join(folder, ...objectPath.split('/'))))
  if (folderForm !== objectPath && !folderForm.startsWith('..')) {
    const commit = [named, head?.commit].filter(Boolean).find((candidate) => holds(candidate, folderForm))
    if (commit) hints.push(`${short(commit)} holds the marked bytes at ${folderForm}; objectId is the path from the Git repository root, so record "${folderForm}"`)
  }
  const change = context.status?.changes.get(objectPath)
  if (!hints.length && change) {
    hints.push(`the working tree has uncommitted changes to ${objectPath} (${change.kind}); if the marked edition exists only in the working tree, commit it and record that commit as target.revision`)
  }
  return hints
}

// Where the project config is and what this invocation adds: from command
// arguments ({ argv, cwd, env }) or from an already resolved project.
function checkRequest(input) {
  if (input && typeof input === 'object' && 'configPath' in input && Array.isArray(input.repos)) {
    return {
      configPath: input.configPath,
      overrides: input.repos.filter((repo) => repo.pathSource === 'cli' && repo.name && repo.path).flatMap((repo) => ['--repo-path', `${repo.name}=${repo.path}`]),
      cwd: input.configDir ?? process.cwd(),
      env: process.env,
    }
  }
  const { argv = [], cwd = process.cwd(), env = process.env } = input ?? {}
  const { project, repoPaths } = parseProjectOptions(argv)
  const selected = project ?? (typeof env[PROJECT_CONFIG_ENV] === 'string' && env[PROJECT_CONFIG_ENV].trim() ? env[PROJECT_CONFIG_ENV].trim() : 'atelier.project.json')
  let configPath = path.resolve(cwd, selected)
  if (isDirectory(configPath)) configPath = path.join(configPath, 'atelier.project.json')
  return { configPath, overrides: [...repoPaths].flatMap(([name, value]) => ['--repo-path', `${name}=${path.resolve(cwd, value)}`]), cwd, env }
}

// Verify the project's marks against its committed tree: read the committed
// config, stream the committed files into a private snapshot, build the graph
// there, check, and remove the snapshot. `input` is a resolved project or the
// command's { argv, cwd, env }.
export function checkGraphmarks(input, options = {}) {
  const request = checkRequest(input)
  if (!request.configPath) {
    return { ok: false, marks: [], errors: ['graphmark check needs a project config file (atelier.project.json) committed in a Git repository'], warnings: [] }
  }
  return withPrivateSnapshot((base) => {
    const snapshot = buildSnapshot(base, request)
    if (snapshot.errors.length) return { ok: false, marks: [], errors: snapshot.errors, warnings: snapshot.warnings }
    const graph = hermeticGit(base, () => buildGraph(snapshot.project))
    const report = checkGraphmarksInGraph(graph, snapshot.repositories, options)
    return { ...report, warnings: [...snapshot.warnings, ...report.warnings] }
  })
}

const USAGE = 'Usage: atelier graphmark check [--json] [--expect ID]... [--project PATH] [--repo-path NAME=PATH]...\n\nVerify every GraphMark record against the committed tree at HEAD: the atelier-graphmark@v1 contract, that the target lies in its own repository, that its full commit id holds the marked edition, that the selector names one part of it, and the audience. An uncommitted or edited mark record is refused. --expect fails the check when the mark with that kg id is missing; repeat it for several.\nWrites nothing outside a temporary snapshot, which it removes.'

export function runGraphmarkCommand(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    return
  }
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'check'
  if (sub !== 'check') {
    console.error(`unknown graphmark subcommand: ${sub}\n\n${USAGE}`)
    process.exit(2)
  }
  const rest = argv[0] === sub ? argv.slice(1) : argv
  const fail = (message) => {
    console.error(`${message}\n\n${USAGE}`)
    process.exit(2)
  }
  // One pass in the given order, so each flag takes its own adjacent value;
  // --project, --project-config and --repo-path go to the shared resolver.
  const expect = []
  let json = false
  for (let i = 0; i < rest.length;) {
    let option = null
    try {
      option = projectOptionAt(rest, i)
    } catch (error) {
      fail(error.message)
    }
    if (option) {
      i = option.nextIndex
      continue
    }
    const arg = rest[i]
    const value = rest[i + 1]
    if (arg === '--json') {
      json = true
      i += 1
    } else if (arg === '--expect' && typeof value === 'string' && value.trim() && !value.startsWith('--')) {
      expect.push(value.trim())
      i += 2
    } else if (arg.startsWith('--expect=') && arg.slice('--expect='.length).trim()) {
      expect.push(arg.slice('--expect='.length).trim())
      i += 1
    } else fail(`unknown option: ${arg}`)
  }
  const report = checkGraphmarks({ argv: rest, cwd: process.cwd(), env: process.env }, { expect })
  if (json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    for (const warning of report.warnings) console.warn(`warning: ${warning}`)
    for (const error of report.errors) console.error(error)
    const count = (state) => report.marks.filter((mark) => mark.edition === state).length
    console.log(`graphmark: ${report.marks.length} marks · ${count('intact')} intact · ${count('changed')} changed · ${count('removed')} removed · ${count('refused')} refused · ${report.errors.length} errors`)
  }
  // Leave through the event loop, so a signal received during the check is
  // re-raised after the snapshot is gone.
  if (!report.ok) process.exitCode = 1
}
