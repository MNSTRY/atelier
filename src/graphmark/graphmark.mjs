import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { buildGraph } from '../graph/graph.mjs'
import { REPO_ACCESS_SCHEMA, parseYamlSubset, splitFrontmatter, validateRepoAccessConfig } from '../graph/knowledge-graph.mjs'
import { parseProjectOptions, projectOptionAt } from '../cli/project-options.mjs'
import { PROJECT_CONFIG_ENV, PROJECT_CONFIG_SCHEMA, isExternalRepo, resolveProjectConfig, validateProjectConfigDoc } from '../project/config.mjs'
import { sanitizedGitEnvironment } from '../runtime/git-adapter.mjs'

// The MNSTRY GraphMark standard (docs/reference/graphmark.md): a mark points at
// a specific part of a specific, recoverable edition of something someone
// singled out, records who made it, who marked it, when and why, and joins it
// to the knowledge graph as evidence. Its target is an evidence-navigation
// exact source reference (evidenceRef), refined: a full commit id, one literal
// path from the Git repository root, the digest of the whole object at that
// commit and a selector that names exactly one part of it.
//
// What is verified is what readers receive: the committed tree, read from Git
// objects alone. The check reads the project config from its repository's
// HEAD blob, resolves its read policy from committed blobs by exact path,
// lists the committed files of each managed repository folder, and builds the
// knowledge graph from those objects, with the graph's own unchanged code
// reading them through an in-memory reader: no copy on any filesystem, no
// writes, no name folding. It checks every mark against that graph. The
// working tree is read only through `git status` and the front matter of the
// Markdown it reports as changed: an uncommitted, staged or edited mark record
// is refused, and uncommitted changes a mark depends on are reported. A repair
// hint (HEAD holds the bytes, another path form names them) is a diagnostic,
// never a verified mark. It never fetches a missing object.

export const GRAPHMARK_CONTRACT = 'atelier-graphmark@v1'
export const GRAPHMARK_TAG = 'graphmark'
export const MARK_STATES = ['marked', 'preserved', 'recorded', 'graph-checked', 'shared', 'accepted']
export const SELECTOR_TYPES = ['whole', 'lines', 'text-quote']

// Read rank, as the knowledge graph ranks audiences for read boundaries. A Map,
// so only these names have a rank (an inherited name such as "constructor"
// is unknown, as it should be).
const AUDIENCE_READ_RANK = new Map([['public', 0], ['team', 1], ['operator', 2], ['staff', 2], ['private', 3], ['sensitive', 3]])
// A full commit id: 40 hex digits, or 64 in a SHA-256 repository.
export const FULL_COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const LINES_VALUE = /^([1-9][0-9]*)(?:-([1-9][0-9]*))?$/
// An edition or a record larger than this is reported as too large to verify,
// never as absent.
const MAX_OBJECT_BYTES = 64 * 1024 * 1024
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
      // ignoreBOM keeps a leading U+FEFF, which is part of the name.
      decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(pathBytes)
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
// A remote with a partial-clone filter is a promisor too, as Git registers it.
export function isPromisorRepository(root) {
  const flags = gitRun(root, ['config', '--type=bool', '--get-regexp', '^remote\\..*\\.promisor$'])
  const filters = gitRun(root, ['config', '--get-regexp', '^remote\\..*\\.partialclonefilter$'])
  const extension = gitRun(root, ['config', '--get', 'extensions.partialclone'])
  const settled = (result) => result.status === 0 || result.status === 1
  return !settled(flags) || !settled(filters) || !settled(extension) ||
    (flags.status === 0 && flags.stdout.toString('utf8').split('\n').some((line) => / true$/.test(line))) ||
    filters.status === 0 ||
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
// bytes), `absent`, `symlink`, `directory`, `gitlink`, `blocked` (a folder on
// the way is a link, a submodule or a file), `too-large` (with its size),
// `unavailable` (a partial clone lacks it) or `failed` (Git could not say).
// Only `absent` means there is nothing there, and only when every folder on
// the way is a plain tree. Paths are compared as bytes.
function lookup(root, commit, objectPath, limit = MAX_OBJECT_BYTES, { content = true } = {}) {
  const view = missingAt(root, commit)
  if (!view) return { kind: 'failed' }
  if (view.treesMissing) return { kind: 'unavailable' }
  const segments = objectPath.split('/')
  const ancestors = segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'))
  // -t lists each folder on the way; naming each one lists what stands there.
  const listed = git(root, ['ls-tree', '-t', '-z', '--end-of-options', commit, '--', ...ancestors, objectPath])
  if (listed === null) return { kind: 'failed' }
  const entries = treeEntries(listed)
  const at = (wanted) => {
    const bytes = Buffer.from(wanted, 'utf8')
    return entries.find((item) => item.pathBytes.equals(bytes))
  }
  for (const ancestor of ancestors) {
    const folder = at(ancestor)
    if (!folder) return { kind: 'absent' }
    if (folder.type === 'tree' && folder.mode === '040000') continue
    return { kind: 'blocked', at: ancestor, as: folder.mode === '120000' ? 'a symbolic link' : folder.mode === '160000' ? 'a submodule' : 'a file' }
  }
  const entry = at(objectPath)
  if (!entry) return { kind: 'absent' }
  if (entry.mode === '120000') return { kind: 'symlink' }
  if (entry.mode === '160000') return { kind: 'gitlink' }
  if (entry.type === 'tree') return { kind: 'directory' }
  if (entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755')) return { kind: 'failed' }
  if (!content) return { kind: 'file' }
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
  blocked: (found) => `lies under ${found.at}, which is ${found.as} in the committed tree, not a folder`,
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
  const undecodable = []
  if (result.status !== 0) return { available: false, changes, undecodable }
  // Records are split as bytes, and each path decoded on its own, exactly
  // (fatal, keeping a leading U+FEFF); a path that is not UTF-8 is kept as
  // bytes rather than replaced by a lossy spelling.
  const raw = result.stdout
  const records = []
  for (let start = 0; start < raw.length;) {
    let end = raw.indexOf(0, start)
    if (end < 0) end = raw.length
    if (end > start) records.push(raw.subarray(start, end))
    start = end + 1
  }
  const fieldsBefore = { '?': 1, 1: 8, u: 10 }
  const decode = (bytes) => {
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
      return null
    }
  }
  const entries = []
  for (const record of records) {
    const skip = fieldsBefore[String.fromCharCode(record[0])]
    if (skip === undefined) continue
    let at = 0
    for (let seen = 0; seen < skip && at >= 0; seen += 1) at = record.indexOf(0x20, at) + 1 || -1
    if (at <= 0) continue
    const header = record.subarray(0, at - 1).toString('latin1')
    const name = decode(record.subarray(at))
    if (name === null) undecodable.push({ kind: record[0] === 0x3f ? 'untracked' : 'changed', bytes: Buffer.from(record.subarray(at)) })
    else entries.push(`${header} ${name}`)
  }
  for (const entry of entries) {
    if (entry.startsWith('? ')) changes.set(entry.slice(2), { kind: 'untracked', index: null, working: true })
    else if (entry.startsWith('1 ')) {
      const fields = entry.split(' ')
      const [x, y] = fields[1]
      const kind = x === 'A' ? 'added' : x === 'D' || y === 'D' ? 'deleted' : 'modified'
      const index = x !== '.' && x !== 'D' && !NULL_OID.test(fields[7]) ? fields[7] : null
      changes.set(fields.slice(8).join(' '), { kind, xy: fields[1], index, working: x !== 'D' && y !== 'D' })
    } else if (entry.startsWith('u ')) {
      // An unresolved conflict: each stage (base, ours, theirs) is a version.
      const fields = entry.split(' ')
      const stages = fields.slice(7, 10).filter((oid) => !NULL_OID.test(oid))
      changes.set(fields.slice(10).join(' '), { kind: 'unmerged', index: null, stages, working: true })
    }
  }
  return { available: true, changes, undecodable }
}

// The start of a blob: { bytes, complete }, or null when Git cannot read it.
function blobHead(root, oid) {
  const result = gitRun(root, ['cat-file', 'blob', oid], { maxBuffer: FRONT_MATTER_LIMIT })
  if (result.status === 0) return { bytes: result.stdout, complete: true }
  if (result.error?.code === 'ENOBUFS' && result.stdout) return { bytes: result.stdout.subarray(0, FRONT_MATTER_LIMIT), complete: false }
  return null
}

// What one committed version (a Git object) of a Markdown file is, by its
// front matter: a mark record, a marks index, something else, or
// indeterminate (unreadable, or front matter that does not end within the
// limit). The opening delimiter is matched with the newline rule of the full
// parser (splitFrontmatter): LF, CRLF or a lone CR.
function classifyMarkdown(head) {
  if (!head) return 'indeterminate'
  const text = head.bytes.toString('utf8')
  const split = splitFrontmatter(text)
  if (!split) return !head.complete && text.replace(/\r\n?/g, '\n').startsWith('---\n') ? 'indeterminate' : 'other'
  const record = parseYamlSubset(split.yaml)
  if (!Array.isArray(record?.tags) || !record.tags.includes(GRAPHMARK_TAG)) return 'other'
  return record.kg?.type === 'index' && record.target === undefined ? 'index' : 'mark'
}

// --- The committed tree, from Git objects alone -------------------------------
//
// The knowledge graph is built from the committed tree without copying it onto
// any filesystem. The graph's own code, unchanged, reads through `fs`; while it
// builds, every path-based `fs` call on a path under a virtual root (a path
// that never exists on disk) is answered from Git objects by exact committed
// path, at the moment of the read, and any other call on such a path is
// refused. Nothing is written, nothing is probed, and no name is folded: a
// committed name is the bytes Git holds for it.

// Paths that are not one exact name here: not valid UTF-8, a segment Git
// refuses, the same path twice, or one that this host's path rules would not
// keep as one literal path (on Windows, a "\\" inside a name).
function pathProblems(entries) {
  const problems = []
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
    if (toPosix(path.relative('committed', path.join('committed', ...segments))) !== entry.path) {
      problems.push(`${entry.path} is not one literal path on this host`)
      continue
    }
    if (exact.has(entry.path)) problems.push(`${entry.path} appears twice`)
    exact.add(entry.path)
  }
  return [...new Set(problems)]
}

// The committed entries under `prefixes` at `commit`: each regular file's
// object id by exact path, with links, submodules and the objects a partial
// clone lacks recorded.
function committedFiles(root, commit, prefixes) {
  const recorded = { files: new Map(), trees: [], links: [], gitlinks: [], missing: [], unreadable: false, problems: [] }
  const view = missingAt(root, commit)
  const scope = prefixes.includes('') ? [] : ['--', ...prefixes]
  // -t lists the trees too: the folders a checkout has are exactly these.
  const listing = view && !view.treesMissing ? git(root, ['ls-tree', '-r', '-t', '-z', '--full-tree', commit, ...scope], { maxBuffer: 512 * 1024 * 1024 }) : null
  if (listing === null) {
    recorded.unreadable = true
    return recorded
  }
  const entries = treeEntries(listing)
  recorded.problems = pathProblems(entries)
  if (recorded.problems.length) return recorded
  for (const entry of entries) {
    if (entry.type === 'tree') recorded.trees.push(entry.path)
    else if (entry.mode === '120000') recorded.links.push(entry.path)
    else if (entry.mode === '160000') recorded.gitlinks.push(entry.path)
    else if (entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755')) {
      if (view.missing.has(entry.oid)) recorded.missing.push(entry.path)
      else recorded.files.set(entry.path, entry.oid)
    }
  }
  return recorded
}

const fsError = (code, syscall, target) => Object.assign(new Error(`${code}: committed tree, ${syscall} '${target}'`), { code, syscall, path: target })
const kindTest = (kind) => ({
  isFile: () => kind === 'file',
  isDirectory: () => kind === 'dir',
  isSymbolicLink: () => kind === 'link',
  isBlockDevice: () => false,
  isCharacterDevice: () => false,
  isFIFO: () => false,
  isSocket: () => false,
})

// The committed tree as the knowledge graph will see it: folders, regular
// files (read from their Git objects on demand) and links (listed, never
// followed). Submodules are not part of it.
const READER_CACHE_BYTES = 64 * 1024 * 1024

export function committedReader(base, { cacheBytes = READER_CACHE_BYTES } = {}) {
  const entries = new Map([[base, { kind: 'dir', children: new Map() }]])
  const cache = new Map()
  let cached = 0
  const sizes = new Map()
  const violations = []
  // Each repository has its virtual root (and the policy file its own); a
  // path in no root belongs to no committed tree and is refused, even a
  // folder the layout made to hold a root.
  const roots = new Set()
  const owned = (name) => [...roots].some((root) => inside(root, name))
  const addDir = (dir) => {
    const existing = entries.get(dir)
    if (existing) {
      if (existing.kind !== 'dir') throw new Error(`${dir} is both a folder and a ${existing.kind}`)
      return
    }
    const parent = path.dirname(dir)
    if (!inside(base, parent)) throw new Error(`committed path outside the reader: ${dir}`)
    addDir(parent)
    entries.set(dir, { kind: 'dir', children: new Map() })
    entries.get(parent).children.set(path.basename(dir), 'dir')
  }
  const add = (name, kind, source) => {
    if (entries.has(name)) throw new Error(`${name} is held twice`)
    const parent = path.dirname(name)
    addDir(parent)
    entries.set(name, { kind, ...source })
    entries.get(parent).children.set(path.basename(name), kind)
  }
  const at = (target) => {
    const name = path.resolve(pathArgument(target) ?? String(target))
    if (!owned(name)) {
      violations.push(`the knowledge graph reached ${name}, which is in no committed tree`)
      throw fsError('EPERM', 'resolve', name)
    }
    return entries.get(name) ?? null
  }
  const bytesOf = (entry, target) => {
    if (entry.bytes) return entry.bytes
    if (!cache.has(entry.oid)) {
      const read = gitRun(entry.root, ['cat-file', 'blob', entry.oid], { maxBuffer: 512 * 1024 * 1024 })
      if (read.status !== 0) {
        violations.push(`${target} could not be read from Git`)
        throw fsError('EIO', 'read', target)
      }
      // Bounded: a blob larger than the budget is served without being kept,
      // and the oldest blobs are dropped, and read again if needed.
      if (read.stdout.length > cacheBytes) return read.stdout
      cache.set(entry.oid, read.stdout)
      cached += read.stdout.length
      for (const [oid, bytes] of cache) {
        if (cached <= cacheBytes) break
        cache.delete(oid)
        cached -= bytes.length
      }
      return read.stdout
    }
    return cache.get(entry.oid)
  }
  const sizeOf = (entry, target) => {
    if (entry.bytes) return entry.bytes.length
    if (!sizes.has(entry.oid)) {
      const size = Number(git(entry.root, ['cat-file', '-s', entry.oid])?.toString('utf8').trim())
      if (!Number.isFinite(size)) {
        violations.push(`${target} could not be read from Git`)
        throw fsError('EIO', 'stat', target)
      }
      sizes.set(entry.oid, size)
    }
    return sizes.get(entry.oid)
  }
  const statOf = (entry, target, follow, options) => {
    if (!entry || (follow && entry.kind === 'link')) {
      if (options?.throwIfNoEntry === false) return undefined
      throw fsError('ENOENT', follow ? 'stat' : 'lstat', target)
    }
    return { ...kindTest(entry.kind), size: entry.kind === 'file' ? sizeOf(entry, target) : 0, mode: entry.kind === 'dir' ? 0o40755 : 0o100644, mtimeMs: 0, mtime: new Date(0), dev: 0, ino: 0 }
  }
  const implementation = {
    existsSync: (target) => {
      const entry = at(target)
      return Boolean(entry) && entry.kind !== 'link'
    },
    statSync: (target, options) => statOf(at(target), target, true, options),
    lstatSync: (target, options) => statOf(at(target), target, false, options),
    readFileSync: (target, options) => {
      const entry = at(target)
      if (!entry || entry.kind === 'link') throw fsError('ENOENT', 'open', target)
      if (entry.kind === 'dir') throw fsError('EISDIR', 'read', target)
      const bytes = bytesOf(entry, target)
      const encoding = typeof options === 'string' ? options : options?.encoding
      return encoding ? bytes.toString(encoding) : Buffer.from(bytes)
    },
    readdirSync: (target, options) => {
      const entry = at(target)
      if (!entry || entry.kind === 'link') throw fsError('ENOENT', 'scandir', target)
      if (entry.kind !== 'dir') throw fsError('ENOTDIR', 'scandir', target)
      // A repository nested in this folder is read as its own repository
      // only: a checkout of this one holds none of its files.
      const parent = path.resolve(pathArgument(target) ?? String(target))
      const names = [...entry.children.keys()].filter((name) => !roots.has(path.join(parent, name))).sort()
      if (!options?.withFileTypes) return names
      return names.map((name) => ({ name, parentPath: parent, path: parent, ...kindTest(entry.children.get(name)) }))
    },
    realpathSync: (target) => {
      const entry = at(target)
      if (!entry || entry.kind === 'link') throw fsError('ENOENT', 'realpath', target)
      return path.resolve(pathArgument(target) ?? String(target))
    },
    accessSync: (target) => {
      const entry = at(target)
      if (!entry || entry.kind === 'link') throw fsError('ENOENT', 'access', target)
    },
  }
  // A repository's own root: a committed tree, whatever it holds.
  const addRoot = (root) => {
    roots.add(root)
    addDir(root)
  }
  return { base, add, addDir, addRoot, implementation, violations, cachedBytes: () => cached }
}

const pathArgument = (target) => {
  if (typeof target === 'string') return target
  if (Buffer.isBuffer(target)) return target.toString('utf8')
  if (target instanceof URL && target.protocol === 'file:') {
    try {
      return fileURLToPath(target)
    } catch {
      return null
    }
  }
  return null
}

// Run `build` with `fs` answering from Git objects. While it runs, every `fs`
// call that names a path (a string, a Buffer or a file URL), synchronous or
// not, is served by the reader when the path is in a committed tree and the
// reader implements the call; any other such call, on any path, is refused
// and recorded, so the build can read nothing else and a future read the
// graph adds cannot go unchecked. Calls on an open descriptor pass through:
// no descriptor for a path can be opened while the build runs.
export function withCommittedReader(reader, build) {
  const prefix = reader.base + path.sep
  const virtual = (target) => {
    const name = pathArgument(target)
    return name !== null && (name === reader.base || name.startsWith(prefix))
  }
  const refuse = (name) => {
    reader.violations.push(`the knowledge graph used fs.${name} on the committed tree, which only Git-object reads may serve`)
    throw fsError('EPERM', name, reader.base)
  }
  const refuseOutside = (name, target) => {
    reader.violations.push(`the knowledge graph used fs.${name} on ${target}, which is outside the committed tree`)
    throw fsError('EPERM', name, target)
  }
  const restore = []
  const wrap = (owner, name) => {
    const original = owner[name]
    if (typeof original !== 'function' || /^[A-Z]/.test(name)) return
    const own = owner === fs ? reader.implementation[name] : undefined
    const wrapped = function (target, ...rest) {
      if (virtual(target)) return own ? own(target, ...rest) : refuse(name)
      if (pathArgument(target) !== null) return refuseOutside(name, pathArgument(target))
      return original.call(this, target, ...rest)
    }
    if (typeof original.native === 'function') {
      wrapped.native = function (target, ...rest) {
        if (virtual(target)) return own ? own(target, ...rest) : refuse(`${name}.native`)
        if (pathArgument(target) !== null) return refuseOutside(`${name}.native`, pathArgument(target))
        return original.native.call(this, target, ...rest)
      }
    }
    owner[name] = wrapped
    restore.push(() => { owner[name] = original })
  }
  try {
    for (const name of Object.keys(fs)) wrap(fs, name)
    for (const name of Object.keys(fs.promises ?? {})) wrap(fs.promises, name)
    return build()
  } finally {
    for (const undo of restore.reverse()) undo()
  }
}

// The repository access formats Atelier writes (`atelier init` and setup) and
// reads (the knowledge graph).
const ACCESS_SCHEMAS = new Set(['mnstry.atelier-repo-access@v1', REPO_ACCESS_SCHEMA])

function accessPolicyProblems(bytes, managedNames, externalNames, label) {
  let doc
  try {
    doc = JSON.parse(bytes.toString('utf8'))
  } catch {
    return [`${label}: the committed repository access file is not valid JSON`]
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return [`${label}: the committed repository access file is not a JSON object`]
  const problems = []
  if (!ACCESS_SCHEMAS.has(doc.schema)) problems.push(`${label}: schema must be one of ${[...ACCESS_SCHEMAS].join(', ')}`)
  const shaped = { ...doc, schema: REPO_ACCESS_SCHEMA }
  for (const problem of validateRepoAccessConfig(shaped, managedNames, { configPath: label, externalRepos: externalNames })) problems.push(problem)
  return problems.map((problem) => `${problem} (in the committed repository access file); the check does not fill in defaults`)
}

// The project's virtual layout. `anchor` is the deepest host folder holding
// every path given (the config folder and each repository); a path below it
// keeps its path from there under `<base>/project/<the anchor's name>`. So
// every folder keeps its name, and the path from the config folder to each
// repository, which the census scope (setup.include and setup.exclude) and
// relative links are read against, is exactly the one on this host, by this
// host's path rules. Null when no folder holds them all (two Windows drives
// or shares): the layout cannot be kept.
export function projectLayout(base, paths, pathModule = path) {
  const below = (folder, one) => {
    const rel = pathModule.relative(folder, one)
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${pathModule.sep}`) && !pathModule.isAbsolute(rel))
  }
  if (!paths.length) return null
  let anchor = paths[0]
  while (!paths.every((one) => below(anchor, one))) {
    const up = pathModule.dirname(anchor)
    if (up === anchor) return null
    anchor = up
  }
  // The anchor keeps its own name, so every folder at or below it does.
  const project = pathModule.join(base, 'project', pathModule.basename(anchor) || 'root')
  return {
    anchor,
    holds: (one) => below(anchor, one),
    at: (one) => {
      const rel = pathModule.relative(anchor, one)
      return rel ? pathModule.join(project, rel) : project
    },
  }
}

// What the committed tree of `outer`, a Git repository enclosing the
// repository at `inner`, holds where `inner` lies, when that is anything but
// nothing or the submodule that records `inner` (exactly there, or above it);
// null when it holds nothing there. An outer repository with no commit holds
// nothing; one Git cannot read leaves the answer open, which is a problem.
function enclosingProblem(outer, inner) {
  if (git(outer, ['rev-parse', '--git-dir']) === null) return 'cannot be read by Git'
  const head = git(outer, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])?.toString('utf8').trim()
  if (!head) return null
  const at = toPosix(path.relative(outer, inner))
  const found = lookup(outer, head, at, MAX_OBJECT_BYTES, { content: false })
  if (found.kind === 'absent' || found.kind === 'gitlink' || (found.kind === 'blocked' && found.as === 'a submodule')) return null
  const held = {
    file: () => `a file at ${at}`,
    directory: () => `committed files at ${at}`,
    symlink: () => `a symbolic link at ${at}`,
    blocked: () => `${found.as} at ${found.at}, above ${at}`,
  }[found.kind]
  return held ? `holds ${held()} in its HEAD` : `cannot show what its HEAD holds at ${at}`
}

// The committed project, verified from Git:
// 1. find the config's repository and read the config from its HEAD blob (it
//    need not be checked out, and an unfinished edit does not matter);
// 2. resolve it against this checkout only for locations (tracked paths,
//    --repo-path, a local overlay, sibling discovery);
// 3. list the committed files of each managed repository folder;
// 4. read the effective repository access file from the committed tree of the
//    project repository that holds it, by exact path; only true absence under
//    plain folders means defaults;
// 5. map the project onto the reader's virtual layout, which keeps every
//    repository at its host path from the config folder, with no further
//    resolution, so the graph reads exactly those objects and scopes its
//    census exactly as a checkout here would.
function buildCommitted(request) {
  const base = path.join(os.tmpdir(), `.atelier-graphmark-committed-${process.pid}-${crypto.randomBytes(12).toString('hex')}`)
  const errors = []
  const warnings = []
  const reader = committedReader(base)
  const committed = { errors, warnings, repositories: new Map(), project: null, reader }
  const roots = new Map()
  const take = (root) => {
    if (!roots.has(root)) {
      const head = resolveRevision(root, 'HEAD')
      const status = workingStatus(root)
      if (!head) errors.push(`${root}: has no commit at HEAD, so nothing committed can be verified`)
      if (!status.available) errors.push(`${root}: git status failed, so uncommitted mark records cannot be ruled out; the result is indeterminate`)
      roots.set(root, { root, head, status, mirror: null, prefixes: new Set() })
    }
    return roots.get(root)
  }
  // A host path the layout holds keeps its place in it; any other path (a
  // workspace or operations folder elsewhere) maps to a name that is in no
  // committed tree.
  let layout = null
  let outside = 0
  const mirror = (abs) => {
    const resolvedPath = path.resolve(abs)
    if (layout.holds(resolvedPath)) return layout.at(resolvedPath)
    outside += 1
    return path.join(base, `outside-${outside}`, path.basename(resolvedPath))
  }

  // 1. The committed config.
  const { configPath } = request
  const configRoot = gitRoot(path.dirname(configPath))
  if (!configRoot) {
    errors.push(`${configPath}: the project config is not in a Git repository, so its committed policy cannot be read`)
    return committed
  }
  const configOwner = take(configRoot)
  if (errors.length) return committed
  const configRel = toPosix(path.relative(configRoot, configPath))
  const committedConfig = lookup(configRoot, configOwner.head.commit, configRel)
  if (committedConfig.kind !== 'file') {
    errors.push(committedConfig.kind === 'absent'
      ? `${configRel}: the project config is not committed at HEAD, so its policy cannot be verified`
      : `${configRel}: the committed project config ${describeLookup(committedConfig)}, so its policy cannot be verified`)
    return committed
  }
  let document
  try {
    document = JSON.parse(committedConfig.bytes.toString('utf8'))
  } catch {
    errors.push(`${configRel}: the project config committed at HEAD is not valid JSON`)
    return committed
  }
  for (const problem of validateProjectConfigDoc(document)) errors.push(`${configRel} (committed at HEAD): ${problem}`)
  if (errors.length) return committed
  const configChange = configOwner.status.changes.get(configRel)
  if (configChange) warnings.push(`${configRel}: has uncommitted changes (${configChange.kind}), which this check does not use; it reads the project config committed at HEAD`)

  // 2. Locations for this checkout. External repositories are not read, so
  // they are dropped before resolution: no sibling discovery or remote probe
  // runs for them.
  const env = { ...request.env }
  delete env[PROJECT_CONFIG_ENV]
  const declared = Array.isArray(document.repos) ? document.repos : []
  const externalNames = declared.filter((repo) => isExternalRepo(repo)).map((repo) => repo.name).filter(Boolean)
  let resolved
  try {
    resolved = resolveProjectConfig({ argv: ['--project', configPath, ...request.overrides], cwd: request.cwd, env, configDocument: { ...document, repos: declared.filter((repo) => !isExternalRepo(repo)) }, writeLocalState: false })
  } catch (error) {
    errors.push(`the project config committed at HEAD cannot be resolved here: ${error.message}`)
    return committed
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
  if (errors.length) return committed
  // One folder is one repository: two declarations that resolve to the same
  // folder would census it twice under two names.
  for (const [index, one] of managed.entries()) {
    for (const other of managed.slice(index + 1)) {
      if (path.relative(path.resolve(one.path), path.resolve(other.path)) === '') errors.push(`repositories ${one.name} and ${other.name}: both resolve to ${path.resolve(one.path)}; one folder is read as one repository only, so the check refuses`)
    }
  }
  if (errors.length) return committed
  // Every Git repository that encloses a repository serving a managed folder,
  // in the project or not, must hold nothing committed where that repository
  // lies: only the submodule that records it there, or nothing at all.
  // Otherwise a checkout of it holds files there that the census never sees.
  for (const served of new Set(managed.map((repo) => gitRoot(repo.path)))) {
    for (let outer = path.dirname(served); ; outer = path.dirname(outer)) {
      if (fs.existsSync(path.join(outer, '.git'))) {
        const problem = enclosingProblem(outer, served)
        if (problem) errors.push(`${served}: is a Git repository where the enclosing repository ${outer} ${problem}; a checkout cannot hold both, so the check refuses`)
      }
      if (path.dirname(outer) === outer) break
    }
  }
  if (errors.length) return committed

  // One virtual project folder for the config and every repository, each at
  // its host path from the deepest folder holding them all.
  const resolvedConfigDir = path.resolve(resolved.configDir)
  layout = projectLayout(base, [resolvedConfigDir, ...roots.keys(), ...managed.map((repo) => path.resolve(repo.path))])
  if (!layout) {
    errors.push(`the project config (${resolvedConfigDir}) and its repositories (${[...roots.keys()].join(', ')}) share no folder on this host (they are on different drives or shares), so their committed trees cannot be laid out as one checkout; the check refuses rather than scope the census differently`)
    return committed
  }
  const listed = [...roots.values()]
  for (const [index, one] of listed.entries()) {
    for (const other of listed.slice(index + 1)) {
      if (path.relative(one.root, other.root) === '') errors.push(`${one.root} and ${other.root}: name one folder on this host, so their committed trees cannot both be read; the check refuses`)
    }
    one.mirror = layout.at(one.root)
  }
  if (errors.length) return committed

  // 3. The committed tree of each managed folder, by exact path: its
  // folders, regular files and links, and its submodules as the empty
  // folders a clean checkout holds. Nothing else is in the reader.
  for (const entry of roots.values()) {
    const prefixes = [...entry.prefixes]
    const recorded = prefixes.length ? committedFiles(entry.root, entry.head.commit, prefixes) : { files: new Map(), trees: [], links: [], gitlinks: [], missing: [], unreadable: false, problems: [] }
    entry.recorded = recorded
    if (recorded.unreadable) errors.push(`${entry.root}: HEAD's tree cannot be read without fetching objects this clone lacks`)
    for (const problem of recorded.problems.slice(0, 5)) errors.push(`${entry.root}: HEAD's tree cannot be read exactly: ${problem}; the check refuses rather than read a different file`)
  }
  if (errors.length) return committed
  try {
    for (const entry of roots.values()) {
      const { recorded } = entry
      const at = (rel) => path.join(entry.mirror, ...rel.split('/'))
      reader.addRoot(entry.mirror)
      for (const rel of [...recorded.trees, ...recorded.gitlinks]) reader.addDir(at(rel))
      for (const [rel, oid] of recorded.files) reader.add(at(rel), 'file', { root: entry.root, oid })
      for (const rel of recorded.links) reader.add(at(rel), 'link', {})
    }
  } catch (error) {
    errors.push(`the committed trees cannot be laid out as one checkout: ${error.message}`)
    return committed
  }

  // The census base, which the graph derives from the mapped config folder
  // and each repository's mapped folder, must be the one on this host.
  const virtualConfigDir = mirror(resolvedConfigDir)
  for (const repo of managed) {
    const logical = toPosix(path.relative(resolvedConfigDir, path.resolve(repo.path)))
    const mapped = toPosix(path.relative(virtualConfigDir, mirror(repo.path)))
    if (logical !== mapped) errors.push(`repository ${repo.name}: lies at ${logical} from the project config here, which the committed layout cannot keep (${mapped}); the check refuses rather than scope the census differently`)
  }
  if (errors.length) return committed

  // 4. The effective read policy, bound to the committed tree that holds it.
  const accessPath = path.resolve(resolved.repoAccessPath)
  const accessOwner = [...roots.values()].filter((entry) => inside(entry.root, accessPath)).sort((a, b) => b.root.length - a.root.length)[0]
  if (!accessOwner) {
    errors.push(`the repository access file ${accessPath} is outside the project's repositories, so no committed version of it can be read; the check does not read live files or fall back to defaults`)
    return committed
  }
  const accessRel = toPosix(path.relative(accessOwner.root, accessPath))
  const committedAccess = lookup(accessOwner.root, accessOwner.head.commit, accessRel)
  if (committedAccess.kind === 'file') {
    // Validate the committed policy as written, before any loader fills in
    // defaults: a supported format, and a read boundary for every managed
    // repository.
    for (const problem of accessPolicyProblems(committedAccess.bytes, managed.map((repo) => repo.name), externalNames, accessRel)) errors.push(problem)
    if (errors.length) return committed
  } else if (committedAccess.kind !== 'absent') {
    errors.push(`${accessRel}: the committed repository access file ${describeLookup(committedAccess)}; the check does not fall back to defaults`)
    return committed
  }
  // The graph reads the policy from its own virtual file: the verified bytes,
  // or nothing when the committed policy is absent.
  const policyFile = path.join(base, 'policy', 'repo-access.json')
  reader.addRoot(path.dirname(policyFile))
  if (committedAccess.kind === 'file') reader.add(policyFile, 'file', { bytes: committedAccess.bytes })
  const accessChange = accessOwner.status.changes.get(accessRel)
  if (accessChange) warnings.push(`${accessRel}: has uncommitted changes (${accessChange.kind}), which this check does not use; it reads the repository access file committed at HEAD${committedAccess.kind === 'absent' ? ' (there is none, so defaults apply)' : ''}`)

  for (const repo of managed) {
    const owner = roots.get(gitRoot(repo.path))
    const folder = mirror(repo.path)
    const prefix = toPosix(path.relative(owner.root, repo.path))
    committed.repositories.set(repo.name, { folder, realFolder: path.resolve(repo.path), root: owner.root, mirror: owner.mirror, head: owner.head, status: owner.status, prefix, recorded: owner.recorded })
    const within = (objectPath) => prefix === '' || objectPath === prefix || objectPath.startsWith(`${prefix}/`)
    const missing = owner.recorded.missing.filter(within)
    if (missing.length) errors.push(`repository ${repo.name}: HEAD names ${missing.length} file(s) this clone lacks (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''}); the committed graph cannot be built without them`)
    for (const link of owner.recorded.links.filter(within).filter((objectPath) => /\.(md|kg\.json)$/i.test(objectPath))) {
      warnings.push(`${link}: is a symbolic link at HEAD; the check does not follow links, so it is not part of the committed graph`)
    }
  }
  if (errors.length) return committed
  // The committed project, mapped onto the virtual roots. Its own folders
  // (config, workspace, operations) are only names: no folder is made for
  // them, so none can stand in for a missing committed path. External
  // repositories are not read, so they are left out: no remote probes.
  committed.project = {
    ...resolved,
    configPath: mirror(configPath),
    configDir: mirror(resolved.configDir),
    workspaceRoot: mirror(resolved.workspaceRoot),
    repoOpsRoot: mirror(resolved.repoOpsRoot),
    repoAccessPath: policyFile,
    repos: managed.map((repo) => ({ ...repo, path: mirror(repo.path) })),
  }
  return committed
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
// name to its context (from the committed tree) or to its directory;
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
  // Exempt only an index whose committed record was read and has no target;
  // one that cannot be read is inspected, and its read failure reported.
  const isIndexWithoutTarget = (node) => {
    if (node.type !== 'index') return false
    const found = committedRecord(node)
    if (found.kind !== 'file') return false
    const record = readMarkRecord(found.bytes.toString('utf8'))
    return Boolean(record) && record.target === undefined
  }
  // Every Markdown node tagged graphmark is a mark record, except a marks index
  // (kg type index) that carries no target.
  const candidates = graph.nodes.filter((node) => tagged(node) && /\.md$/i.test(node.path ?? ''))

  // The folders that hold a committed mark record or marks index, by
  // repository.
  const marksFolders = new Map()
  const holdsMarks = (node) => {
    const folder = path.posix.dirname(node.path)
    if (!marksFolders.has(node.repo)) marksFolders.set(node.repo, new Set())
    marksFolders.get(node.repo).add(folder === '.' ? '' : folder)
  }
  for (const node of candidates) {
    holdsMarks(node)
    for (const index of node.relations?.belongs_to ?? []) {
      const target = nodesById.get(index)
      if (target?.type === 'index' && /\.md$/i.test(target.path ?? '')) holdsMarks(target)
    }
  }
  const inMarksFolder = (repo, rel) => [...(marksFolders.get(repo) ?? [])].some((folder) => folder === '' || rel.startsWith(`${folder}/`))

  // Pending Markdown in a managed folder, from `git status` and Git objects
  // alone: the check never reads a working-tree file. A version Git holds
  // (the index, each stage of a conflict) that is a mark record, and any
  // pending change in a folder that holds marks, is refused; new Markdown
  // elsewhere is reported as not verified; a committed version Git cannot
  // show makes the result indeterminate.
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
    const folderBytes = Buffer.from(toPosix(path.relative(context.root, context.realFolder)))
    for (const { kind, bytes } of context.status.undecodable ?? []) {
      const inFolder = folderBytes.length === 0 || (bytes.subarray(0, folderBytes.length).equals(folderBytes) && bytes[folderBytes.length] === 0x2f)
      if (inFolder && /\.md$/i.test(bytes.toString('latin1'))) {
        errors.push(`${name}: a pending Markdown file whose name is not UTF-8 (bytes ${bytes.toString('hex')}, ${kind}) cannot be classified; the result is indeterminate`)
      }
    }
    for (const [objectPath, change] of context.status.changes) {
      if (!/\.md$/i.test(objectPath)) continue
      const file = path.join(context.root, ...objectPath.split('/'))
      if (!inside(context.realFolder, file)) continue
      const rel = toPosix(path.relative(context.realFolder, file))
      const where = `${name}/${rel}`
      const atHead = lookup(context.root, context.head.commit, objectPath)
      // A link, a directory or a submodule is never a mark record; a version
      // Git cannot show makes the answer indeterminate.
      const headKind = atHead.kind === 'file'
        ? classifyMarkdown({ bytes: atHead.bytes, complete: true })
        : atHead.kind === 'absent' ? 'none' : ['symlink', 'directory', 'gitlink'].includes(atHead.kind) ? 'other' : 'indeterminate'
      if (headKind === 'mark') continue // a committed record: inspected with the marks
      const versions = []
      if (change.index) versions.push(['index', classifyMarkdown(blobHead(context.root, change.index))])
      for (const stage of change.stages ?? []) versions.push(['index (an unresolved conflict)', classifyMarkdown(blobHead(context.root, stage))])
      if (headKind === 'indeterminate') versions.push(['committed tree', 'indeterminate'])
      const of = (kind) => versions.filter(([, found]) => found === kind).map(([place]) => place).join(' and ')
      if (of('mark')) errors.push(`${where}: pending mark: the record is in the ${of('mark')}, not committed at HEAD; commit it to verify`)
      else if (inMarksFolder(name, rel)) errors.push(`${where}: pending mark: an uncommitted change (${change.kind}) in a folder that holds marks, which this check does not read; commit it to verify`)
      else if (of('indeterminate')) errors.push(`${where}: cannot tell whether the version in the ${of('indeterminate')} is a mark record (its front matter is unreadable or longer than ${FRONT_MATTER_LIMIT} bytes); the result is indeterminate`)
      else if (change.kind === 'untracked' || change.kind === 'added') warnings.push(`${where}: uncommitted Markdown (${change.kind}); not verified, since this check reads only what is committed`)
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

// Build the knowledge graph of the committed tree from Git objects alone.
// Returns { graph, committed, errors }; `graph` is null when the committed
// tree could not be read or the graph build reached past what Git serves.
export function buildCommittedGraph(input) {
  const request = checkRequest(input)
  if (!request.configPath) return { graph: null, committed: null, errors: ['graphmark check needs a project config file (atelier.project.json) committed in a Git repository'], warnings: [] }
  const committed = buildCommitted(request)
  if (committed.errors.length) return { graph: null, committed, errors: committed.errors, warnings: committed.warnings }
  let graph = null
  let failure = null
  try {
    graph = withCommittedReader(committed.reader, () => buildGraph(committed.project))
  } catch (error) {
    failure = error
  }
  const errors = [...committed.reader.violations]
  if (failure && !errors.length) errors.push(`the committed knowledge graph could not be built from Git objects: ${failure.message}`)
  return { graph: errors.length ? null : graph, committed, errors, warnings: committed.warnings }
}

// Verify the project's marks against its committed tree, from Git objects
// alone. `input` is a resolved project or the command's { argv, cwd, env }.
export function checkGraphmarks(input, options = {}) {
  const { graph, committed, errors, warnings } = buildCommittedGraph(input)
  if (!graph) return { ok: false, marks: [], errors, warnings }
  const report = checkGraphmarksInGraph(graph, committed.repositories, options)
  // A committed mark record the census does not count is never checked: say
  // so for each, and refuse an empty result that would hide them.
  const outside = uncountedRecords(graph, committed.repositories)
  const notes = outside.map(({ where, kind }) => kind === 'mark'
    ? `${where}: a committed mark record outside the knowledge graph's census (the project's setup.include or setup.exclude, or a folder the census skips), so this check did not verify it`
    : `${where}: is outside the knowledge graph's census, and the check cannot tell whether it is a mark record (its committed front matter is unreadable or longer than ${FRONT_MATTER_LIMIT} bytes)`)
  const extra = []
  if (!report.marks.length && outside.length) extra.push(`no mark record is in the knowledge graph's census, but the committed tree holds ${outside.length} outside it that may be (${outside.slice(0, 3).map(({ where }) => where).join(', ')}${outside.length > 3 ? ', …' : ''}); the check refuses rather than pass with nothing verified`)
  return { ...report, ok: report.ok && !extra.length, errors: [...report.errors, ...extra], warnings: [...warnings, ...report.warnings, ...notes] }
}

// Committed Markdown files in a managed repository's folder that the census
// did not count (out of the project's scope, or in a folder the census skips)
// and whose committed front matter is a mark record's, or cannot be read.
function uncountedRecords(graph, repositories) {
  const counted = new Set(graph.nodes.map((node) => `${node.repo}\0${node.path}`))
  const found = []
  for (const [name, repository] of repositories) {
    const { prefix, recorded, root } = repository
    if (!recorded) continue
    const candidates = []
    for (const [objectPath, oid] of recorded.files) {
      if (!/\.md$/i.test(objectPath) || (prefix && !objectPath.startsWith(`${prefix}/`))) continue
      const rel = prefix ? objectPath.slice(prefix.length + 1) : objectPath
      if (!counted.has(`${name}\0${rel}`)) candidates.push({ rel, oid })
    }
    const kinds = classifyBlobs(root, candidates.map(({ oid }) => oid))
    for (const { rel, oid } of candidates) {
      const kind = kinds.get(oid) ?? 'indeterminate'
      if (kind === 'mark' || kind === 'indeterminate') found.push({ where: `${name}/${rel}`, kind })
    }
  }
  return found
}

// What each blob is as a Markdown version (classifyMarkdown), by object id.
// Sizes come first from one `cat-file --batch-check`; a blob within the
// front-matter limit is read with others in a batch of at most `batchBytes`
// (one blob alone may fill a batch up to the limit), and classified, its
// bytes dropped, before the next batch is read; a larger blob is read only up
// to the limit. An object Git cannot read is left out (indeterminate).
// `onBatch(bytes)` observes the size of each Git read.
export function classifyBlobs(root, oids, { batchBytes = 8 * 1024 * 1024, onBatch = () => {} } = {}) {
  const kinds = new Map()
  const unique = [...new Set(oids)]
  if (!unique.length) return kinds
  const checked = gitRun(root, ['cat-file', '--batch-check'], { input: `${unique.join('\n')}\n`, maxBuffer: unique.length * 128 + 1024 })
  if (checked.status !== 0 || !checked.stdout) return kinds
  const sizes = new Map()
  for (const line of checked.stdout.toString('utf8').split('\n')) {
    const [oid, type, sizeText] = line.split(' ')
    const size = Number(sizeText)
    if (type === 'blob' && Number.isSafeInteger(size)) sizes.set(oid, size)
  }
  const small = []
  for (const [oid, size] of sizes) {
    if (size > FRONT_MATTER_LIMIT) {
      const head = blobHead(root, oid)
      onBatch(head?.bytes.length ?? 0)
      if (head) kinds.set(oid, classifyMarkdown({ bytes: head.bytes, complete: false }))
    } else small.push(oid)
  }
  for (let start = 0; start < small.length;) {
    const batch = []
    let bytes = 0
    while (start < small.length && (!batch.length || bytes + sizes.get(small[start]) <= batchBytes)) {
      bytes += sizes.get(small[start])
      batch.push(small[start])
      start += 1
    }
    const result = gitRun(root, ['cat-file', '--batch'], { input: `${batch.join('\n')}\n`, maxBuffer: bytes + batch.length * 128 + 1024 })
    if (result.status !== 0 || !result.stdout) continue
    const out = result.stdout
    onBatch(out.length)
    let at = 0
    for (let index = 0; index < batch.length; index += 1) {
      const end = out.indexOf(0x0a, at)
      if (end < 0) break
      const [oid, type, sizeText] = out.subarray(at, end).toString('utf8').split(' ')
      at = end + 1
      const size = Number(sizeText)
      if (!Number.isSafeInteger(size)) continue
      if (type === 'blob') kinds.set(oid, classifyMarkdown({ bytes: out.subarray(at, at + size), complete: true }))
      at += size + 1
    }
  }
  return kinds
}

const USAGE = 'Usage: atelier graphmark check [--json] [--expect ID]... [--project PATH] [--repo-path NAME=PATH]...\n\nVerify every GraphMark record against the committed tree at HEAD: the atelier-graphmark@v1 contract, that the target lies in its own repository, that its full commit id holds the marked edition, that the selector names one part of it, and the audience. An uncommitted or edited mark record is refused. --expect fails the check when the mark with that kg id is missing; repeat it for several.\nReads Git objects only; writes nothing.'

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
  if (!report.ok) process.exitCode = 1
}
