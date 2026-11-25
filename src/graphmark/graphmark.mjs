import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { buildGraph } from '../graph/graph.mjs'
import { parseYamlSubset, splitFrontmatter } from '../graph/knowledge-graph.mjs'
import { parseProjectOptions } from '../cli/project-options.mjs'
import { commandProject } from '../project/config.mjs'
import { sanitizedGitEnvironment } from '../runtime/git-adapter.mjs'

// The MNSTRY GraphMark standard (docs/reference/graphmark.md): a mark points at
// a specific part of a specific, recoverable edition of something someone
// singled out, records who made it, who marked it, when and why, and joins it
// to the knowledge graph as evidence. Its target is an evidence-navigation
// exact source reference (evidenceRef), refined: a full commit id, one literal
// path from the Git repository root, the digest of the whole object at that
// commit and a selector that names exactly one part of it. The knowledge graph
// already proves that a mark's edges resolve. This check adds what the graph
// cannot see: that the record is the committed one, the record contract, that
// the target lies in the mark's own repository, that the named commit holds
// the marked bytes and is reachable from a branch, a tag or HEAD, that the
// selector names one part of them, whether the file has changed since, and
// that a mark is never more widely visible than its marked edition declares
// or its owner's current policy allows. A repair hint (HEAD holds the bytes,
// another path form names them) is a diagnostic, never a verified mark.
// Offline: the graph is built from the working tree, so a mark whose record
// or graph dependencies differ from HEAD is refused; editions and declared
// audiences come from committed Git objects. It writes nothing.

export const GRAPHMARK_CONTRACT = 'atelier-graphmark@v1'
export const GRAPHMARK_TAG = 'graphmark'
export const MARK_STATES = ['marked', 'preserved', 'recorded', 'graph-checked', 'shared', 'accepted']
export const SELECTOR_TYPES = ['whole', 'lines', 'text-quote']

// Read rank, as the knowledge graph ranks audiences for read boundaries.
const AUDIENCE_READ_RANK = { public: 0, team: 1, operator: 2, staff: 2, private: 3, sensitive: 3 }
// A full commit id: 40 hex digits, or 64 in a SHA-256 repository.
export const FULL_COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const LINES_VALUE = /^([1-9][0-9]*)(?:-([1-9][0-9]*))?$/
// Larger objects are reported as too large to verify, never as absent.
const MAX_OBJECT_BYTES = 64 * 1024 * 1024

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

function contractFailures(frontMatter) {
  const validate = contractValidator()
  return validate(frontMatter) ? [] : validate.errors.map((error) => ({ at: error.instancePath || '/', message: error.message }))
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
// another repository; drop them, take no optional locks, never fetch a missing
// object of a partial clone, and ignore local replace refs, which would let a
// commit appear to hold bytes shared history does not.
const GIT_ENV = { ...sanitizedGitEnvironment(process.env), GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' }

function git(root, args) {
  try {
    return execFileSync('git', ['--no-replace-objects', '--literal-pathspecs', '-C', root, ...args], {
      env: GIT_ENV,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: MAX_OBJECT_BYTES + 1024 * 1024,
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

// What `commit` holds at exactly `objectPath`: { bytes } for a regular file,
// { symlink } for a symbolic link, { tooLarge } or { unavailable } when the
// bytes cannot be read, or null when it holds no file there.
function blobAt(root, commit, objectPath) {
  const out = git(root, ['ls-tree', '-l', '-z', '--end-of-options', commit, '--', objectPath])
  const entry = out?.toString('utf8').split('\0').find(Boolean)
  if (!entry) return null
  const tab = entry.indexOf('\t')
  const [mode, type, oid, size] = entry.slice(0, tab).split(/ +/)
  if (entry.slice(tab + 1) !== objectPath) return null
  if (mode === '120000') return { symlink: true }
  if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) return null
  if (Number(size) > MAX_OBJECT_BYTES) return { tooLarge: Number(size) }
  const bytes = git(root, ['cat-file', 'blob', oid])
  return bytes ? { bytes } : { unavailable: true }
}

// Working-tree bytes of a regular file, never through a symbolic link or a
// folder swapped for one. Used only to compare and to give repair hints.
function workingBytes(root, file) {
  try {
    if (!inside(fs.realpathSync(root), fs.realpathSync(file))) return null
    const stat = fs.lstatSync(file)
    return stat.isFile() && stat.size <= MAX_OBJECT_BYTES ? fs.readFileSync(file) : null
  } catch {
    return null
  }
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
  if (!sidecar.bytes) return { problem: 'its sidecar is not a regular file Git holds' }
  try {
    const audience = JSON.parse(sidecar.bytes.toString('utf8'))?.kg?.audience
    return { audience: typeof audience === 'string' ? audience.trim() : 'private' }
  } catch {
    return { problem: 'its sidecar is not valid JSON' }
  }
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
  if (selector.type === 'lines') {
    const match = LINES_VALUE.exec(selector.value ?? '')
    if (!match) return `selector lines "${selector.value}" must be N or N-M (1-based, inclusive)`
    if (match[2] && Number(match[2]) < Number(match[1])) return `selector lines "${selector.value}" ends before it starts`
  }
  return null
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

// Check every mark in a built graph. `repoRoots` maps every configured repo
// name to its directory; `expect` lists mark ids that must be present.
// Returns { ok, marks, errors, warnings }.
export function checkGraphmarksInGraph(graph, repoRoots, { expect = [] } = {}) {
  const errors = []
  const warnings = []
  const marks = []
  if (graph.errors?.length) {
    return { ok: false, marks, errors: graph.errors.map((error) => `knowledge graph: ${error}`), warnings }
  }
  const tagged = (node) => Array.isArray(node.tags) && node.tags.includes(GRAPHMARK_TAG)
  const folders = new Map([...repoRoots].map(([name, dir]) => [name, path.resolve(dir)]))
  const nodesByFile = new Map(graph.nodes.filter((node) => folders.has(node.repo)).map((node) => [path.resolve(folders.get(node.repo), node.path), node]))
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]))
  // Every Markdown node tagged graphmark is a mark record, except a marks index
  // (kg type index) that carries no target.
  const candidates = graph.nodes.filter((node) => tagged(node) && /\.md$/i.test(node.path ?? ''))
  const seen = new Set()
  const SKIP = Symbol('marks index')

  // The graph is read from the working tree; a node a mark depends on must be
  // the one committed at HEAD, source and sidecar, or the check would verify
  // something readers never receive.
  const heads = new Map()
  const headOf = (dir) => {
    if (!heads.has(dir)) heads.set(dir, resolveRevision(dir, 'HEAD'))
    return heads.get(dir)
  }
  const nodeDrift = (graphNode) => {
    const nodeFolder = folders.get(graphNode.repo)
    const nodeRoot = nodeFolder ? gitRoot(nodeFolder) : null
    if (!nodeRoot) return 'is not in a Git repository this check reads'
    const nodeHead = headOf(nodeRoot)
    const source = path.resolve(nodeFolder, graphNode.path)
    for (const file of /\.md$/i.test(graphNode.path) ? [source] : [source, `${source}.kg.json`]) {
      const rel = toPosix(path.relative(nodeRoot, file))
      const committed = nodeHead ? blobAt(nodeRoot, nodeHead.commit, rel) : null
      const working = workingBytes(nodeRoot, file)
      if (!committed && !working) continue
      if (!committed?.bytes) return `${rel} ${working ? 'is not committed at HEAD' : 'is not a regular file at HEAD'}`
      if (!working) return `${rel} is committed at HEAD but missing from the working tree`
      if (!working.equals(committed.bytes)) return `${rel} differs from the one committed at HEAD`
    }
    return null
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

  const inspect = (node) => {
    const where = `${node.repo}/${node.path}`
    const folder = folders.get(node.repo)
    if (!folder) {
      errors.push(`${where}: repository is not readable from this project`)
      return null
    }
    const recordFile = path.join(folder, node.path)
    const root = gitRoot(folder)
    const working = workingBytes(root ?? folder, recordFile)
    const draft = working ? readMarkRecord(working.toString('utf8')) : null
    if (node.type === 'index' && draft && draft.target === undefined) return SKIP
    seen.add(node.id)
    if (!root) {
      errors.push(`${where}: the repository is not under Git, so no mark record or edition can be verified`)
      return null
    }

    // The record readers receive is the committed one: read it from HEAD, and
    // refuse a working-tree record that differs from it.
    const head = resolveRevision(root, 'HEAD')
    const recordPath = toPosix(path.relative(root, recordFile))
    const committed = head ? blobAt(root, head.commit, recordPath) : null
    if (!committed?.bytes) {
      errors.push(`${where}: the mark record is not committed at HEAD; commit it before checking`)
      return null
    }
    if (!working || !working.equals(committed.bytes)) {
      errors.push(`${where}: the working-tree mark record differs from the one committed at HEAD; commit the change before checking, since readers receive the committed record`)
      return null
    }
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
    const file = path.join(root, ...objectPath.split('/'))
    // A target must lie with its owner, not in another configured repository.
    const foreign = [...folders].find(([name, dir]) => name !== node.repo && inside(dir, file) && !inside(dir, folder))
    if (foreign) {
      errors.push(`${at}: lies in repository "${foreign[0]}", not in "${node.repo}"; mark it in the repository that owns it`)
      return null
    }
    const fileNode = nodesByFile.get(file)
    const dependencies = new Map()
    if (fileNode) dependencies.set(fileNode.id, ['the marked node', fileNode])
    for (const id of record.kg.relations.evidences) if (nodesById.has(id) && !dependencies.has(id)) dependencies.set(id, ['evidences', nodesById.get(id)])
    for (const id of record.kg.relations.belongs_to) if (nodesById.has(id)) dependencies.set(id, ['the marks index', nodesById.get(id)])
    for (const [id, [role, dependency]] of dependencies) {
      const drift = nodeDrift(dependency)
      if (drift) errors.push(`${where}: ${role} ${id}: ${drift}; commit it before checking, since the graph is read from the working tree`)
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
    else if (atRev?.symlink) failure = `revision ${short(revision.commit)} holds a symbolic link at ${objectPath}; mark the file it points to`
    else if (atRev?.tooLarge) failure = `revision ${short(revision.commit)} holds ${atRev.tooLarge} bytes at ${objectPath}, more than this check reads; it cannot be verified`
    else if (atRev?.unavailable) failure = `revision ${short(revision.commit)} names ${objectPath}, but its bytes are not available in this clone (a partial clone does not fetch them offline)`
    else if (!atRev) failure = `revision ${short(revision.commit)} does not hold ${objectPath}`
    else if (contentDigest(atRev.bytes) !== target.contentDigest) failure = `revision ${short(revision.commit)} holds different bytes at ${objectPath}`

    if (failure) {
      if (failure !== 'revision-form') errors.push(`${at}: the marked edition is not verified: ${failure}`)
      for (const hint of repairHints({ root, folder, head, target, resolved, file })) warnings.push(`${at}: repair hint: ${hint}`)
      return null
    }
    const editionBytes = atRev.bytes
    const selected = selectionProblem(target.selector, editionBytes)
    if (selected) {
      errors.push(`${at}: ${selected}`)
      return null
    }

    // Currency: what HEAD holds at the same path.
    const atHead = blobAt(root, head.commit, objectPath)
    // Read Git as the check did: replace refs would return other bytes.
    const recover = ['git', '-C', root, '--no-replace-objects', 'cat-file', 'blob', `${revision.commit}:${objectPath}`]
    const recoverText = recover.map((arg) => (/^[A-Za-z0-9._-]+$/.test(arg) ? arg : shellQuote(arg))).join(' ')
    let edition
    if (atHead?.bytes && contentDigest(atHead.bytes) === target.contentDigest) edition = 'intact'
    else if (atHead?.bytes) {
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
    // declares, nor than its owner's current policy: the marked file's node,
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
    const markRank = AUDIENCE_READ_RANK[record.kg.audience]
    for (const material of new Map(materials.map((item) => [item.id, item])).values()) {
      const materialRank = AUDIENCE_READ_RANK[material.audience]
      if (materialRank == null) {
        errors.push(`${where}: ${material.id} has the unknown audience "${material.audience}"; a mark cannot be checked against it`)
      } else if (markRank < materialRank) {
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

  for (const id of expect) {
    if (seen.has(id)) continue
    const node = nodesById.get(id)
    errors.push(!node
      ? `expected mark ${id} was not found in the knowledge graph`
      : tagged(node)
        ? `expected mark ${id} is a marks index, not a mark record`
        : `expected mark ${id} is not a GraphMark record: it is not tagged ${GRAPHMARK_TAG}`)
  }

  return { ok: errors.length === 0, marks, errors, warnings }
}

// Diagnostics for an edition that did not verify. Each names a fix; none makes
// the mark verified.
function repairHints({ root, folder, head, target, resolved, file }) {
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
  const folderForm = toPosix(path.relative(root, path.join(folder, ...objectPath.split('/'))))
  if (folderForm !== objectPath && !folderForm.startsWith('..')) {
    const commits = [named, head?.commit].filter(Boolean)
    const commit = commits.find((candidate) => holds(candidate, folderForm))
    if (commit) hints.push(`${short(commit)} holds the marked bytes at ${folderForm}; objectId is the path from the Git repository root, so record "${folderForm}"`)
  }
  const current = workingBytes(root, file)
  if (!hints.length && current && contentDigest(current) === target.contentDigest) {
    hints.push('the marked edition exists only in the working tree; commit it and record that commit as target.revision')
  }
  return hints
}

// Build the project's graph and check its marks.
export function checkGraphmarks(project, options = {}) {
  const graph = buildGraph(project)
  const repoRoots = new Map((project.repos ?? []).filter((repo) => repo.name && repo.path && !repo.external).map((repo) => [repo.name, repo.path]))
  return checkGraphmarksInGraph(graph, repoRoots, options)
}

const USAGE = 'Usage: atelier graphmark check [--json] [--expect ID]... [--project PATH] [--repo-path NAME=PATH]...\n\nVerify every GraphMark record: that it is committed, the atelier-graphmark@v1 contract, that the target lies in its own repository, that its full commit id holds the marked edition, that the selector names one part of it, and the audience. --expect fails the check when the mark with that kg id is missing; repeat it for several.\nRefuses unless the files the mark depends on match HEAD. Writes nothing.'

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
  // --project, --project-config and --repo-path go to the shared resolver.
  let remaining
  try {
    remaining = parseProjectOptions(rest).remaining
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`)
    process.exit(2)
  }
  const expect = []
  let json = false
  for (let i = 0; i < remaining.length; i += 1) {
    const arg = remaining[i]
    if (arg === '--json') json = true
    else if (arg === '--expect' && i + 1 < remaining.length && remaining[i + 1].trim() && !remaining[i + 1].startsWith('--')) expect.push(remaining[(i += 1)].trim())
    else if (arg.startsWith('--expect=') && arg.slice('--expect='.length).trim()) expect.push(arg.slice('--expect='.length).trim())
    else {
      console.error(`unknown option: ${arg}\n\n${USAGE}`)
      process.exit(2)
    }
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
