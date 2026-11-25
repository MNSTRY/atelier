import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { buildGraph } from '../graph/graph.mjs'
import { parseYamlSubset, splitFrontmatter } from '../graph/knowledge-graph.mjs'
import { projectOptionAt } from '../cli/project-options.mjs'
import { LOCAL_OVERLAY_ENV, PROJECT_CONFIG_ENV, commandProject } from '../project/config.mjs'
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
// materialises HEAD of every repository it reads into a private snapshot (raw
// blob bytes, no checkout filters; symbolic links and submodules are recorded,
// never written), resolves the committed project config and read boundaries
// there, builds the knowledge graph there and checks every mark against it.
// The working tree is read only through `git status`, to refuse an uncommitted
// or edited mark record and to warn about uncommitted changes a mark depends
// on. A repair hint (HEAD holds the bytes, another path form names them) is a
// diagnostic, never a verified mark. Offline: it never fetches a missing
// object, and it writes nothing outside the snapshot, which it deletes.

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
// Larger objects are reported as too large to verify, never as absent.
const MAX_OBJECT_BYTES = 64 * 1024 * 1024
const SNAPSHOT_BATCH_BYTES = 64 * 1024 * 1024
// An untracked Markdown file is read only to tell whether it is a mark record.
const MAX_CLASSIFY_BYTES = 1024 * 1024

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
// say so, so the validator and the check share this.
export function linesOrderProblem(selector) {
  if (selector?.type !== 'lines') return null
  const match = LINES_VALUE.exec(selector.value ?? '')
  return match && match[2] && Number(match[2]) < Number(match[1]) ? `selector lines "${selector.value}" ends before it starts` : null
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
// null when none encloses the directory.
export function gitRoot(dir) {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) return current
    if (path.dirname(current) === current) return null
  }
}

export const contentDigest = (bytes) => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`

// Ambient GIT_* variables (GIT_DIR, GIT_INDEX_FILE and the like) could select
// another repository; drop them, take no optional locks, ask Git not to fetch
// a partial clone's missing objects, and ignore local replace refs, which
// would let a commit appear to hold bytes shared history does not.
const GIT_ENV = { ...sanitizedGitEnvironment(process.env), GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' }

function git(root, args, { input, maxBuffer = MAX_OBJECT_BYTES + 1024 * 1024 } = {}) {
  try {
    return execFileSync('git', ['--no-replace-objects', '--literal-pathspecs', '-C', root, ...args], {
      env: GIT_ENV,
      input,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
      maxBuffer,
    })
  } catch {
    return null
  }
}

// Resolve a revision to a commit and say whether shared history holds it: a
// commit reachable from HEAD or from a branch, tag or remote branch. The stash
// and unreachable objects do not count. `exact` is true only for the full
// commit id itself.
export function resolveRevision(root, revision) {
  if (!root || typeof revision !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,127}$/.test(revision) || revision.includes('..') || /(^|\/)stash$/.test(revision)) return null
  const out = git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${revision}^{commit}`])
  const commit = out?.toString('utf8').trim()
  if (!commit) return null
  const reachable =
    git(root, ['merge-base', '--is-ancestor', commit, 'HEAD']) !== null ||
    Boolean(git(root, ['for-each-ref', '--contains', commit, '--format=%(refname)', 'refs/heads', 'refs/tags', 'refs/remotes'])?.toString('utf8').trim())
  return { commit, reachable, exact: FULL_COMMIT_ID.test(revision) && revision === commit }
}

// --- Reading objects without fetching ---------------------------------------
//
// A partial clone fetches a missing object on demand, and Git before 2.44
// ignores GIT_NO_LAZY_FETCH. In a promisor repository, ask `rev-list
// --missing=print` (which never fetches) what a commit lacks before reading.

const stores = new Map()
function storeFor(root) {
  if (!stores.has(root)) {
    const config = git(root, ['config', '--get-regexp', '^(remote\\..*\\.promisor|extensions\\.partialclone)$'])?.toString('utf8') ?? ''
    const promisor = config.split('\n').some((line) => /^extensions\.partialclone \S/i.test(line) || /^remote\..*\.promisor true$/i.test(line))
    stores.set(root, { promisor, views: new Map() })
  }
  return stores.get(root)
}

function missingAt(root, commit) {
  const store = storeFor(root)
  if (!store.promisor) return { missing: new Set(), treesMissing: false }
  if (!store.views.has(commit)) {
    const all = git(root, ['rev-list', '--objects', '--missing=print', '--no-walk', commit])
    const trees = git(root, ['rev-list', '--objects', '--missing=print', '--no-walk', '--filter=blob:none', commit])
    const missingOf = (out) => new Set(String(out ?? '').split('\n').filter((line) => line.startsWith('?')).map((line) => line.slice(1).trim()))
    store.views.set(commit, all === null || trees === null ? null : { missing: missingOf(all), treesMissing: missingOf(trees).size > 0 })
  }
  return store.views.get(commit)
}

// What `commit` holds at exactly `objectPath`: { bytes } for a regular file,
// { symlink } for a symbolic link, { tooLarge } or { unavailable } when the
// bytes cannot be read, or null when it holds no file there.
function blobAt(root, commit, objectPath) {
  const view = missingAt(root, commit)
  if (!view || view.treesMissing) return { unavailable: true }
  const out = git(root, ['ls-tree', '-z', '--end-of-options', commit, '--', objectPath])
  const entry = out?.toString('utf8').split('\0').find(Boolean)
  if (!entry) return null
  const tab = entry.indexOf('\t')
  const [mode, type, oid] = entry.slice(0, tab).split(' ')
  if (entry.slice(tab + 1) !== objectPath) return null
  if (mode === '120000') return { symlink: true }
  if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) return null
  if (view.missing.has(oid)) return { unavailable: true }
  const size = Number(git(root, ['cat-file', '-s', oid])?.toString('utf8').trim())
  if (!Number.isFinite(size)) return { unavailable: true }
  if (size > MAX_OBJECT_BYTES) return { tooLarge: size }
  const bytes = git(root, ['cat-file', 'blob', oid])
  return bytes ? { bytes } : { unavailable: true }
}

const describeUnread = (found) => found.symlink
  ? 'is a symbolic link'
  : found.tooLarge
    ? `holds ${found.tooLarge} bytes, more than this check reads`
    : 'names bytes that are not available in this clone (a partial clone is not fetched offline)'

// --- The working tree, through Git's own status ------------------------------

// Path (from the repository root) to how the working tree or index differs
// from HEAD: modified, added, deleted, unmerged or untracked. Git normalises
// line endings and checkout filters, so a clean checkout reports nothing.
function workingStatus(root) {
  const out = git(root, ['-c', 'core.fsmonitor=false', '-c', 'status.relativePaths=false', 'status', '--porcelain=v2', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules=all'])
  const changes = new Map()
  if (out === null) return { available: false, changes }
  for (const entry of out.toString('utf8').split('\0')) {
    if (entry.startsWith('? ')) changes.set(entry.slice(2), 'untracked')
    else if (entry.startsWith('1 ')) {
      const fields = entry.split(' ')
      const xy = fields[1]
      changes.set(fields.slice(8).join(' '), xy[0] === 'A' ? 'added' : xy.includes('D') ? 'deleted' : 'modified')
    } else if (entry.startsWith('u ')) changes.set(entry.split(' ').slice(10).join(' '), 'unmerged')
  }
  return { available: true, changes }
}

// A regular working-tree file inside `base`, never through a symbolic link.
function workingFile(base, file, limit) {
  try {
    if (!inside(fs.realpathSync(base), fs.realpathSync(file))) return null
    const stat = fs.lstatSync(file)
    return stat.isFile() && stat.size <= limit ? fs.readFileSync(file) : null
  } catch {
    return null
  }
}

// --- The committed snapshot --------------------------------------------------

// Write HEAD's regular blobs, raw, under `destination`. Symbolic links,
// submodules and missing objects are recorded and not written.
function materialise(root, commit, destination) {
  const recorded = { links: [], gitlinks: [], missing: [], unreadable: false }
  const view = missingAt(root, commit)
  const listing = view && !view.treesMissing ? git(root, ['ls-tree', '-r', '-z', '--full-tree', commit], { maxBuffer: 512 * 1024 * 1024 }) : null
  if (listing === null) {
    recorded.unreadable = true
    return recorded
  }
  const regular = []
  for (const entry of listing.toString('utf8').split('\0')) {
    if (!entry) continue
    const tab = entry.indexOf('\t')
    const [mode, type, oid] = entry.slice(0, tab).split(' ')
    const objectPath = entry.slice(tab + 1)
    if (objectPath.split('/').some((segment) => segment.toLowerCase() === '.git')) continue
    if (mode === '120000') recorded.links.push(objectPath)
    else if (mode === '160000') recorded.gitlinks.push(objectPath)
    else if (type === 'blob' && (mode === '100644' || mode === '100755')) {
      if (view.missing.has(oid)) recorded.missing.push(objectPath)
      else regular.push({ oid, objectPath })
    }
  }
  const sizes = git(root, ['cat-file', '--batch-check=%(objectname) %(objectsize)'], { input: `${regular.map((item) => item.oid).join('\n')}\n`, maxBuffer: 512 * 1024 * 1024 })
  const sizeOf = new Map(String(sizes ?? '').split('\n').filter(Boolean).map((line) => line.split(' ')).map(([oid, size]) => [oid, Number(size)]))
  let batch = []
  let bytes = 0
  const flush = () => {
    if (batch.length) writeBatch(root, batch, bytes, destination, recorded)
    batch = []
    bytes = 0
  }
  for (const item of regular) {
    const size = sizeOf.get(item.oid)
    if (!Number.isFinite(size)) {
      recorded.missing.push(item.objectPath)
      continue
    }
    if (batch.length && bytes + size > SNAPSHOT_BATCH_BYTES) flush()
    batch.push({ ...item, size })
    bytes += size
  }
  flush()
  return recorded
}

function writeBatch(root, batch, bytes, destination, recorded) {
  const out = git(root, ['cat-file', '--batch'], { input: `${batch.map((item) => item.oid).join('\n')}\n`, maxBuffer: bytes + batch.length * 160 + 1024 * 1024 })
  if (out === null) {
    for (const item of batch) recorded.missing.push(item.objectPath)
    return
  }
  let offset = 0
  for (const item of batch) {
    const newline = out.indexOf(0x0a, offset)
    if (newline < 0) {
      recorded.missing.push(item.objectPath)
      continue
    }
    const [oid, type, size] = out.subarray(offset, newline).toString('utf8').split(' ')
    offset = newline + 1
    if (oid !== item.oid || type !== 'blob') {
      recorded.missing.push(item.objectPath)
      continue
    }
    const length = Number(size)
    if (!Number.isFinite(length) || offset + length > out.length) {
      recorded.missing.push(item.objectPath)
      break
    }
    const content = out.subarray(offset, offset + length)
    offset += length + 1
    const file = path.join(destination, ...item.objectPath.split('/'))
    if (!inside(destination, file)) continue
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
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

// Materialise HEAD of the project config's repository and of every managed
// repository, then resolve the committed project inside the snapshot. Each
// repository keeps the location this invocation gave it (a --repo-path, a
// local overlay, sibling discovery), mirrored into the snapshot; its policy
// (read boundary, identity, include scope) comes from the committed config.
function committedSnapshot(project) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-graphmark-snapshot-'))
  const mirror = (abs) => path.join(base, 'tree', path.resolve(abs).replace(/^([A-Za-z]):/, '$1'))
  const errors = []
  const warnings = []
  const roots = new Map()
  const snapshot = { base, errors, warnings, roots, repositories: new Map(), project: null }
  const take = (root) => {
    if (roots.has(root)) return roots.get(root)
    const head = resolveRevision(root, 'HEAD')
    const entry = { root, mirror: mirror(root), head, status: workingStatus(root), recorded: null }
    roots.set(root, entry)
    if (!head) {
      errors.push(`${root}: has no commit at HEAD, so nothing committed can be verified`)
      return entry
    }
    entry.recorded = materialise(root, head.commit, entry.mirror)
    if (entry.recorded.unreadable) errors.push(`${root}: HEAD's tree cannot be read without fetching objects this clone lacks`)
    if (!entry.status.available) warnings.push(`${root}: the working tree could not be compared with HEAD`)
    return entry
  }

  if (!project.configPath) {
    errors.push('graphmark check needs a project config file (atelier.project.json) committed in a Git repository')
    return snapshot
  }
  const configRoot = gitRoot(project.configDir)
  if (!configRoot) {
    errors.push(`${project.configPath}: the project config is not in a Git repository, so its committed policy cannot be read`)
    return snapshot
  }
  const configEntry = take(configRoot)
  const managed = (project.repos ?? []).filter((repo) => !repo.external && repo.name && repo.path)
  for (const repo of managed) {
    const root = gitRoot(repo.path)
    if (root) take(root)
    else errors.push(`repository ${repo.name}: ${repo.path} is not in a Git repository, so nothing committed can be verified`)
  }
  if (errors.length) return snapshot

  const relativeToConfigRoot = (file) => toPosix(path.relative(configRoot, file))
  if (!fs.existsSync(mirror(project.configPath))) {
    errors.push(`${relativeToConfigRoot(project.configPath)}: the project config is not committed at HEAD, so its policy cannot be verified`)
    return snapshot
  }
  for (const policyFile of [project.configPath, project.repoAccessPath]) {
    if (!policyFile || !inside(configRoot, policyFile)) continue
    const change = configEntry.status.changes.get(relativeToConfigRoot(policyFile))
    if (change) warnings.push(`${relativeToConfigRoot(policyFile)}: has uncommitted changes (${change}), which this check does not use; it reads the project policy committed at HEAD`)
  }

  const overrides = managed.filter((repo) => repo.pathSource !== 'tracked-config').flatMap((repo) => ['--repo-path', `${repo.name}=${mirror(repo.path)}`])
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('GIT_') || key === PROJECT_CONFIG_ENV || key === LOCAL_OVERLAY_ENV) delete env[key]
  try {
    snapshot.project = hermeticGit(base, () => commandProject({ argv: ['--project', mirror(project.configPath), ...overrides], cwd: mirror(project.configDir), env, writeLocalState: false }))
  } catch (error) {
    errors.push(`the project config committed at HEAD is not usable: ${error.message}`)
    return snapshot
  }

  for (const repo of snapshot.project.repos ?? []) {
    if (repo.external || !repo.name || !repo.path) continue
    const owner = [...roots.values()].filter((entry) => inside(entry.mirror, repo.path)).sort((a, b) => b.mirror.length - a.mirror.length)[0]
    if (!owner?.head) {
      errors.push(`repository ${repo.name}: its committed location is not in a Git repository this check read`)
      continue
    }
    const folder = repo.path
    const realFolder = path.join(owner.root, path.relative(owner.mirror, folder))
    snapshot.repositories.set(repo.name, { folder, realFolder, root: owner.root, mirror: owner.mirror, head: owner.head, status: owner.status })
    const within = (objectPath) => inside(folder, path.join(owner.mirror, ...objectPath.split('/')))
    const missing = owner.recorded.missing.filter(within)
    if (missing.length) errors.push(`repository ${repo.name}: HEAD names ${missing.length} file(s) this clone lacks (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''}); the committed graph cannot be built without them`)
    for (const link of owner.recorded.links.filter(within).filter((objectPath) => /\.(md|kg\.json)$/i.test(objectPath))) {
      warnings.push(`${link}: is a symbolic link at HEAD; the check does not follow links, so it is not part of the committed graph`)
    }
  }
  return snapshot
}

const toPosix = (value) => value.split(path.sep).join('/')
const inside = (base, file) => file === base || file.startsWith(base + path.sep)
const short = (commit) => commit.slice(0, 12)
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`

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
    if (Number(endText ?? startText) > count) return `selector lines ${selector.value} fall outside the marked edition (${count} lines)`
    return null
  }
  const found = occurrences(text, selector.value)
  if (found === 0) return 'selector text-quote is not in the marked edition'
  if (found > 1) return `selector text-quote occurs ${found} times in the marked edition; a mark names one part, so quote enough to occur once`
  return null
}

// The audience an edition declares for itself at `commit`: Markdown front
// matter (undeclared Markdown is private, as the graph treats it), or for any
// other file its sidecar as committed at the same commit, read under the same
// rules as the object. { audience: null } when a non-Markdown file has no
// sidecar there.
function declaredAudienceAt(root, commit, objectPath, bytes) {
  if (/\.md$/i.test(objectPath)) {
    const audience = readMarkRecord(bytes.toString('utf8'))?.kg?.audience
    return { audience: typeof audience === 'string' ? audience.trim() : 'private' }
  }
  const sidecar = blobAt(root, commit, `${objectPath}.kg.json`)
  if (!sidecar) return { audience: null }
  if (!sidecar.bytes) return { problem: `its sidecar ${describeUnread(sidecar)}` }
  try {
    const audience = JSON.parse(sidecar.bytes.toString('utf8'))?.kg?.audience
    return { audience: typeof audience === 'string' ? audience.trim() : 'private' }
  } catch {
    return { problem: 'its sidecar is not valid JSON' }
  }
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
    if (!context?.root || !context.head) return null
    return blobAt(context.root, context.head.commit, fromRoot(context, path.join(context.folder, node.path)))
  }
  const isIndexWithoutTarget = (node) => {
    if (node.type !== 'index') return false
    const found = committedRecord(node)
    return !found?.bytes || readMarkRecord(found.bytes.toString('utf8'))?.target === undefined
  }
  // Every Markdown node tagged graphmark is a mark record, except a marks index
  // (kg type index) that carries no target.
  const candidates = graph.nodes.filter((node) => tagged(node) && /\.md$/i.test(node.path ?? ''))

  // A mark record that is not committed is not in the snapshot; find it in the
  // working tree through status, and refuse it.
  for (const [name, context] of contexts) {
    if (!context.root || !context.status?.available) continue
    for (const [objectPath, change] of context.status.changes) {
      if ((change !== 'untracked' && change !== 'added') || !/\.md$/i.test(objectPath)) continue
      const file = path.join(context.root, ...objectPath.split('/'))
      if (!inside(context.realFolder, file)) continue
      const bytes = workingFile(context.root, file, MAX_CLASSIFY_BYTES)
      const record = bytes ? readMarkRecord(bytes.toString('utf8')) : null
      if (Array.isArray(record?.tags) && record.tags.includes(GRAPHMARK_TAG)) {
        const what = record.kg?.type === 'index' && record.target === undefined ? 'the marks index' : 'the mark record'
        errors.push(`${name}/${toPosix(path.relative(context.realFolder, file))}: ${what} is not committed at HEAD; commit it before checking`)
      }
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
    if (change) warnings.push(`${where}: ${label} ${objectPath} has uncommitted changes (${change}); this check verified the version committed at HEAD`)
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
    const committed = blobAt(root, head.commit, recordPath)
    if (!committed?.bytes) {
      errors.push(`${where}: the mark record is not committed at HEAD; commit it before checking`)
      return null
    }
    const change = context.status?.changes.get(recordPath)
    if (change) errors.push(`${where}: the working-tree mark record differs from the one committed at HEAD (${change}); commit or discard the change before checking, since readers receive the committed record`)
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
    const atRev = revision?.reachable ? blobAt(root, revision.commit, objectPath) : null
    let failure = null
    if (!FULL_COMMIT_ID.test(target.revision)) failure = 'revision-form'
    else if (!revision) failure = `revision ${target.revision} is not a commit id in this repository`
    else if (!revision.reachable) failure = `revision ${target.revision} is not reachable from HEAD or any branch or tag`
    else if (!atRev) failure = `revision ${short(revision.commit)} does not hold ${objectPath}`
    else if (!atRev.bytes) failure = `at revision ${short(revision.commit)}, ${objectPath} ${describeUnread(atRev)}; it cannot be verified`
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

    // Currency: what HEAD holds at the same path. A file HEAD cannot show
    // (too large, unavailable, a link) is not a removed file: its currency and
    // its current audience cannot be checked, so the mark is refused.
    const atHead = blobAt(root, head.commit, objectPath)
    // Read Git as the check did: replace refs would return other bytes.
    const recover = ['git', '-C', root, '--no-replace-objects', 'cat-file', 'blob', `${revision.commit}:${objectPath}`]
    const recoverText = recover.map((arg) => (/^[A-Za-z0-9._-]+$/.test(arg) ? arg : shellQuote(arg))).join(' ')
    let edition
    if (atHead && !atHead.bytes) {
      edition = 'unreadable'
      errors.push(`${at}: at HEAD it ${describeUnread(atHead)}, so whether it changed and what audience it now declares cannot be checked`)
    } else if (atHead && contentDigest(atHead.bytes) === target.contentDigest) edition = 'intact'
    else if (atHead) {
      edition = 'changed'
      warnings.push(`${at}: has changed since it was marked; the marked edition is recoverable with \`${recoverText}\``)
      const now = editionText(atHead.bytes)
      if (target.selector.type === 'text-quote' && now !== null && !now.includes(target.selector.value)) {
        warnings.push(`${at}: the marked quote is no longer in the current file`)
      }
    } else {
      edition = 'removed'
      warnings.push(`${at}: is no longer held at HEAD; the marked edition is recoverable with \`${recoverText}\``)
    }

    // Audience: a mark is never more widely visible than its marked edition
    // declares, nor than its owner's committed policy: the marked file's node,
    // or, for a file that is not a graph node, the repository's read boundary
    // and what the file declares at HEAD. The narrowest wins, and an audience
    // this check cannot read is an error.
    const materials = []
    const declared = declaredAudienceAt(root, revision.commit, objectPath, editionBytes)
    if (declared.problem) errors.push(`${at}: at ${short(revision.commit)}, ${declared.problem}; its declared audience cannot be read`)
    else if (declared.audience !== null) materials.push({ id: `${objectPath} (the audience its marked edition declares)`, audience: declared.audience })
    if (fileNode) {
      materials.push({ id: fileNode.id, audience: fileNode.audience })
      if (!record.kg.relations.evidences.includes(fileNode.id)) {
        errors.push(`${where}: evidences must name the marked node ${fileNode.id}`)
      }
    } else {
      materials.push({ id: `${objectPath} (the repository's read boundary)`, audience: node.repoAccess?.readBoundary ?? 'private' })
      if (atHead?.bytes) {
        const current = declaredAudienceAt(root, head.commit, objectPath, atHead.bytes)
        if (current.problem) errors.push(`${at}: at HEAD, ${current.problem}; its declared audience cannot be read`)
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
    const found = commit ? blobAt(root, commit, at) : null
    return Boolean(found?.bytes) && contentDigest(found.bytes) === target.contentDigest
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
    hints.push(`the working tree has uncommitted changes to ${objectPath} (${change}); if the marked edition exists only in the working tree, commit it and record that commit as target.revision`)
  }
  return hints
}

// Verify the project's marks against its committed tree: snapshot HEAD, build
// the graph from the committed config and sources, check, delete the snapshot.
export function checkGraphmarks(project, options = {}) {
  const snapshot = committedSnapshot(project)
  try {
    if (snapshot.errors.length) return { ok: false, marks: [], errors: snapshot.errors, warnings: snapshot.warnings }
    const graph = hermeticGit(snapshot.base, () => buildGraph(snapshot.project))
    const report = checkGraphmarksInGraph(graph, snapshot.repositories, options)
    return { ...report, warnings: [...snapshot.warnings, ...report.warnings] }
  } finally {
    fs.rmSync(snapshot.base, { recursive: true, force: true })
  }
}

const USAGE = 'Usage: atelier graphmark check [--json] [--expect ID]... [--project PATH] [--repo-path NAME=PATH]...\n\nVerify every GraphMark record against the committed tree at HEAD: the atelier-graphmark@v1 contract, that the target lies in its own repository, that its full commit id holds the marked edition, that the selector names one part of it, and the audience. An uncommitted or edited mark record is refused. --expect fails the check when the mark with that kg id is missing; repeat it for several.\nWrites nothing outside a temporary snapshot, which it deletes.'

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
  const project = commandProject({ argv: rest, writeLocalState: false })
  const report = checkGraphmarks(project, { expect })
  if (json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    for (const warning of report.warnings) console.warn(`warning: ${warning}`)
    for (const error of report.errors) console.error(error)
    const count = (state) => report.marks.filter((mark) => mark.edition === state).length
    console.log(`graphmark: ${report.marks.length} marks · ${count('intact')} intact · ${count('changed')} changed · ${count('removed')} removed · ${count('refused')} refused · ${report.errors.length} errors`)
  }
  if (!report.ok) process.exit(1)
}
