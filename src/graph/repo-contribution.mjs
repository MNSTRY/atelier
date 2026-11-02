import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { canonicalize } from '../attestation/jcs.mjs'
import { identityKey } from '../project/repo-identity.mjs'
import { openRegularFileNoFollow } from '../project/private-state.mjs'
import { resolveGitExecutable, runGit } from '../runtime/git-adapter.mjs'
import { VALID_AUDIENCES } from '../projection/policy.mjs'
import {
  censusScopeFilter, markdownMetadata, nodeForFile, resolveWorkspaceLinks,
  scanMarkdownSource, validateKnowledgeGraph, walkDocuments, walkSidecars, VALID_KG_TYPES, VALID_STATUSES, VALID_RELATION_TYPES,
} from './knowledge-graph.mjs'

export const REPO_CONTRIBUTION_SCHEMA = 'atelier.repo-contribution@v1'
const PROFILE = 'markdown-explicit-id/v1'
const digestPattern = /^sha256:[0-9a-f]{64}$/
const objectIdPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v))
const text = (v) => typeof v === 'string' && v.trim().length > 0 && !/[\u0000-\u001f]/.test(v)
const relative = (v) => text(v) && !v.includes('\\') && !/^(?:\/|~|[A-Za-z]:)/.test(v) && v.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
const sourcePath = (v) => relative(v) && !v.split('/').some((part) => part.toLowerCase() === '.git')
const hash = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const bodyDigest = (value) => hash(canonicalize(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'digest'))))
const pointerToken = (value) => value.replaceAll('~', '~0').replaceAll('/', '~1')

// Locate the same small YAML subset the source parser accepts, in the raw
// source. These offsets never come from normalized or reserialized metadata.
function relationSourceLocations(raw) {
  const found = new Map()
  const stack = [{ indent: -1, parts: [], index: 0 }]
  const span = (start, end) => ({ start, end, byteStart: Buffer.byteLength(raw.slice(0, start)), byteEnd: Buffer.byteLength(raw.slice(0, end)) })
  const put = (parts, start, end) => {
    if (parts[0] === 'kg' && parts[1] === 'relations' && parts.length >= 3) found.set(`/${parts.map(pointerToken).join('/')}`, span(start, end))
  }
  let first = true
  for (const match of raw.matchAll(/[^\r\n]+|\r\n|\r|\n/g)) {
    const line = match[0]
    if (/^[\r\n]/.test(line)) continue
    if (first) { first = false; continue }
    const trimmed = line.trim()
    if (trimmed === '---') break
    if (!trimmed || trimmed.startsWith('#')) continue
    const indent = line.replaceAll('\t', '  ').match(/^\s*/)[0].length
    while (stack.length > 1 && indent <= stack.at(-1).indent) stack.pop()
    const parent = stack.at(-1)
    const position = match.index + line.indexOf(trimmed)
    if (trimmed.startsWith('- ')) {
      const spelling = trimmed.slice(2).trim()
      if (spelling) put([...parent.parts, String(parent.index++)], position + trimmed.indexOf(spelling, 2), position + trimmed.length)
      continue
    }
    const keyValue = /^([^:]+):(.*)$/.exec(trimmed)
    if (!keyValue) continue
    const parts = [...parent.parts, keyValue[1].trim()]
    const pointer = `/${parts.map(pointerToken).join('/')}`
    // Repeated assignments replace their previous value in parseYamlSubset.
    for (const previous of found.keys()) if (previous === pointer || previous.startsWith(`${pointer}/`)) found.delete(previous)
    const value = keyValue[2].trim()
    if (!value) { stack.push({ indent, parts, index: 0 }); continue }
    const valueStart = position + trimmed.indexOf(':') + 1 + keyValue[2].indexOf(value)
    if (value.startsWith('[') && value.endsWith(']')) {
      let offset = valueStart + 1
      let index = 0
      for (const part of value.slice(1, -1).split(',')) {
        const spelling = part.trim()
        if (spelling && spelling !== '""' && spelling !== "''") put([...parts, String(index++)], offset + part.indexOf(spelling), offset + part.indexOf(spelling) + spelling.length)
        offset += part.length + 1
      }
    } else put(parts, valueStart, valueStart + value.length)
  }
  return found
}

export class RepositoryContributionError extends Error {
  constructor(code) {
    super(code)
    this.name = 'RepositoryContributionError'
    this.code = code
  }
}
const refuse = (code) => { throw new RepositoryContributionError(code) }

export function nodeRefKey(ref) {
  if (!plain(ref) || !text(ref.repoId) || !text(ref.localId)) refuse('invalid-node-ref')
  return JSON.stringify([ref.repoId, ref.localId])
}

function normalizeScope(scope = {}) {
  if (!plain(scope) || Object.keys(scope).some((key) => !['base', 'include', 'exclude'].includes(key))) refuse('invalid-census-scope')
  const result = { base: scope.base ?? '', include: scope.include ?? null, exclude: scope.exclude ?? null }
  if (typeof result.base !== 'string' || result.base.includes('\\') || /[\u0000-\u001f]/.test(result.base) || /^(?:\/|~|[A-Za-z]:)/.test(result.base)) refuse('invalid-census-scope')
  for (const key of ['include', 'exclude']) if (result[key] !== null && (!text(result[key]) || result[key].includes('\\') || /^(?:\/|~|[A-Za-z]:)/.test(result[key]))) refuse('invalid-census-scope')
  return result
}

function readBytes(root, rel) {
  if (!sourcePath(rel)) refuse('invalid-source-path')
  let cursor = root
  for (const segment of rel.split('/').slice(0, -1)) {
    cursor = path.join(cursor, segment)
    const stat = fs.lstatSync(cursor)
    if (!stat.isDirectory() || stat.isSymbolicLink()) refuse('redirected-source-path')
    rejectNestedRepository(cursor)
  }
  const fd = openRegularFileNoFollow(path.join(root, rel))
  try { return fs.readFileSync(fd) } finally { fs.closeSync(fd) }
}

function rejectNestedRepository(directory) {
  try { fs.lstatSync(path.join(directory, '.git')) } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  refuse('nested-repository-source')
}

function gitReader(root) {
  const executable = resolveGitExecutable()
  return (args) => {
    const result = runGit(executable, root, args, { allowFailure: true })
    if (!result.ok) refuse('repository-observation-unavailable')
    return result.stdout
  }
}

function observe(git) {
  const head = git(['rev-parse', '--verify', 'HEAD']).trim()
  const tree = git(['rev-parse', '--verify', 'HEAD^{tree}']).trim()
  if (!objectIdPattern.test(head) || !objectIdPattern.test(tree)) refuse('repository-revision-unavailable')
  const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (status !== '' && !status.endsWith('\0')) refuse('repository-observation-incomplete')
  return { head, tree, status, dirty: status.length > 0 }
}

function census(root, git, scope) {
  const output = git(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'])
  if (output !== '' && !output.endsWith('\0')) refuse('repository-observation-incomplete')
  const ignored = new Set(output.split('\0').filter(Boolean).map((item) => item.replace(/\/+$/, '')))
  const outside = censusScopeFilter(scope)
  const isIgnored = (rel, info) => {
    if (ignored.has(rel.replace(/\/+$/, '')) || (outside?.(rel, info) ?? false)) return true
    // A nested clone or submodule owns its own source. The caller must select
    // it separately or explicitly exclude it from this repository's scope.
    if (info?.directory) rejectNestedRepository(path.join(root, rel))
    return false
  }
  const files = walkDocuments(root, root, [], isIgnored).sort((a, b) => compare(a.rel, b.rel))
  // Other formats require the existing metadata reader's pinned-byte seam.
  // Never silently omit them, or turn an incomplete contribution into a complete one.
  if (files.some((file) => file.ext !== '.md') || walkSidecars(root, root, [], isIgnored).length) refuse('source-profile-unsupported')
  return files
}

/**
 * A derived local contribution. No network lookup, authorization, assertion
 * acceptance or writes occur here. Provider IDs must already be recorded by
 * the repository's existing adoption path. Unsupported identity/format refuses.
 * @param {{name:string, path:string, identity:{provider:'github', id:string}, aliases?:string[]}} repo
 * @param {import('./repo-contribution.types.mjs').SourceBuilderOptions} [options]
 * @returns {import('./repo-contribution.types.mjs').RepositoryContribution}
 */
export function buildRepositoryContribution(repo, { scope: scopeInput, inputPaths = {} } = {}) {
  try {
    if (!plain(repo) || !text(repo.name) || !text(repo.path)) refuse('invalid-repository')
    if (!plain(repo.identity) || repo.identity.provider !== 'github' || !text(repo.identity.id)) refuse('stable-repository-identity-required')
    if (!plain(inputPaths) || Object.keys(inputPaths).some((key) => !['config', 'plan'].includes(key))) refuse('invalid-input-paths')
    const repoId = identityKey(repo.identity)
    const scope = normalizeScope(scopeInput)
    const root = fs.realpathSync(repo.path)
    const git = gitReader(root)
    // Filesystem identity handles Windows case/short-name aliases without
    // treating a different directory as the enrolled repository root.
    const requestedRoot = fs.statSync(root, { bigint: true })
    const gitRoot = fs.statSync(git(['rev-parse', '--show-toplevel']).trim(), { bigint: true })
    if (!requestedRoot.isDirectory() || !gitRoot.isDirectory() || requestedRoot.ino === 0n || gitRoot.ino === 0n || requestedRoot.dev !== gitRoot.dev || requestedRoot.ino !== gitRoot.ino) refuse('repository-root-mismatch')
    const before = observe(git)
    const files = census(root, git, scope)
    const pins = new Map()
    const contents = new Map()
    const capture = (rel) => {
      if (!contents.has(rel)) {
        const bytes = readBytes(root, rel)
        contents.set(rel, bytes)
        pins.set(rel, { path: rel, rawDigest: hash(bytes), byteLength: bytes.length })
      }
      return contents.get(rel)
    }
    const nodes = []
    const scanned = new Map()
    const metadata = new Map()
    const locations = new Map()
    const coverage = { surfaced: new Set(), sections: new Map() }
    for (const file of files) {
      const bytes = capture(file.rel)
      const raw = bytes.toString('utf8')
      const scan = scanMarkdownSource(bytes)
      if (!scan.utf8Exact) refuse('source-not-utf8')
      const node = nodeForFile(repo.name, root, coverage, file, null, raw)
      if (node.classification !== 'classified' || node.markdownHasKgId !== true) refuse('explicit-source-identity-required')
      nodes.push(node)
      scanned.set(node, scan)
      metadata.set(node, markdownMetadata(raw))
      locations.set(node, relationSourceLocations(raw))
    }
    // Endpoint availability is a composition concern. Source validation still
    // checks IDs, classifications, predicate vocabulary and relation shapes.
    if (validateKnowledgeGraph(nodes, []).length) refuse('source-graph-invalid')
    for (const input of Object.values(inputPaths)) capture(input)
    // This profile resolves document links only. Keep original embed flags in
    // the contribution, while disabling the resolver's asset-directory scan.
    const linkScans = new Map([...scanned].map(([node, scan]) => [node, { ...scan, occurrences: scan.occurrences.map((occurrence) => ({ ...occurrence, embed: false })) }]))
    const resolved = resolveWorkspaceLinks({ repos: [{ name: repo.name, root, nodesByPath: new Map(nodes.map((node) => [node.path, node])) }], scanned: linkScans, isAssetEligible: () => false })
    const localTargets = new Map(resolved.links.map((link) => [JSON.stringify([link.sourcePath, link.range.start]), link.target]))
    // Recheck inventory and every selected byte, including explicit config/plan
    // inputs. The graph and its source pins were derived from the same buffers.
    if (canonicalize(census(root, git, scope).map((f) => f.rel)) !== canonicalize(files.map((f) => f.rel))) refuse('source-snapshot-changed')
    for (const [rel, pin] of pins) if (hash(readBytes(root, rel)) !== pin.rawDigest) refuse('source-snapshot-changed')
    if (canonicalize(observe(git)) !== canonicalize(before)) refuse('repository-snapshot-changed')
    const snapshot = { repoId, head: before.head, tree: before.tree, dirty: before.dirty, scope, files: [...pins.values()].sort((a, b) => compare(a.path, b.path)) }
    snapshot.digest = bodyDigest(snapshot)
    const ref = (localId) => ({ repoId, localId })
    const source = (rel, locator) => ({ repoId, path: rel, revision: snapshot.digest, digest: pins.get(rel).rawDigest, ...(locator ? { locator: { ...locator, ...(locator.range ? { rangeDigest: hash(contents.get(rel).subarray(locator.range.byteStart, locator.range.byteEnd)) } : {}) } } : {}) })
    const fields = ['title', 'summary', 'path', 'extension', 'type', 'kgType', 'domain', 'lifecycle', 'status', 'audience', 'classification', 'tags']
    const contributionNodes = nodes.map((node) => ({ ref: ref(node.id), source: source(node.path), ...Object.fromEntries(fields.map((key) => [key, node[key]])) }))
    const ordinaryLinks = nodes.flatMap((node) => scanned.get(node).occurrences.map((occurrence) => {
      const target = localTargets.get(JSON.stringify([node.path, occurrence.range.start]))
      return { source: ref(node.id), target: target ? ref(target) : null, origin: 'ordinary-link', syntax: occurrence.syntax, embed: occurrence.embed, href: occurrence.href, fragment: occurrence.fragment, provenance: source(node.path, { range: occurrence.range, targetRange: occurrence.targetRange }), resolution: target ? 'resolved-local' : 'unresolved' }
    }))
    const declaredRelations = nodes.flatMap((node) => Object.entries(node.relations).flatMap(([predicate, targets]) => targets.map((target, index) => {
      const written = metadata.get(node).kg.relations[predicate]
      const originalIndex = Array.isArray(written) ? written.map((item, i) => ({ value: String(item).trim(), index: i })).filter((item) => item.value)[index].index : null
      const pointer = `/kg/relations/${pointerToken(predicate)}${originalIndex !== null ? `/${originalIndex}` : ''}`
      const range = locations.get(node).get(pointer)
      if (!range) refuse('relation-source-location-unavailable')
      return { source: ref(node.id), target, predicate, origin: 'declared', provenance: source(node.path, { pointer, range }) }
    })))
    const contribution = {
      schema: REPO_CONTRIBUTION_SCHEMA, sourceProfile: PROFILE,
      repository: { repoId, identity: { provider: repo.identity.provider, id: repo.identity.id, source: 'recorded-identity' }, aliases: [...new Set([repo.name, ...(repo.aliases ?? [])])].sort(compare) },
      snapshot, inputs: { config: inputPaths.config ? source(inputPaths.config) : null, plan: inputPaths.plan ? source(inputPaths.plan) : null },
      nodes: contributionNodes, ordinaryLinks, declaredRelations,
    }
    contribution.digest = bodyDigest(contribution)
    const validation = validateRepositoryContribution(contribution)
    if (!validation.ok) refuse('contribution-invalid')
    return contribution
  } catch (error) {
    if (error instanceof RepositoryContributionError) throw error
    refuse('source-unavailable')
  }
}

/** Structural and digest integrity only; never source ownership or freshness. */
export function validateRepositoryContribution(value) {
  const errors = []
  const check = (ok, code) => { if (!ok) errors.push(code); return ok }
  const keys = (v, required, optional = []) => plain(v) && required.every((key) => Object.hasOwn(v, key)) && Object.keys(v).every((key) => [...required, ...optional].includes(key))
  try {
    if (!check(keys(value, ['schema', 'sourceProfile', 'repository', 'snapshot', 'inputs', 'nodes', 'ordinaryLinks', 'declaredRelations', 'digest']), 'invalid-contribution-shape')) return { ok: false, errors }
    check(value.schema === REPO_CONTRIBUTION_SCHEMA && value.sourceProfile === PROFILE, 'unsupported-contribution-schema')
    const repository = value.repository
    if (!check(keys(repository, ['repoId', 'identity', 'aliases']), 'invalid-repository-shape')) return { ok: false, errors }
    check(keys(repository.identity, ['provider', 'id', 'source']) && repository.identity.provider === 'github' && text(repository.identity.id) && repository.identity.source === 'recorded-identity' && repository.repoId === identityKey(repository.identity), 'invalid-repository-identity')
    check(Array.isArray(repository.aliases) && repository.aliases.every(text) && new Set(repository.aliases).size === repository.aliases.length, 'invalid-repository-aliases')
    const snapshot = value.snapshot
    if (!check(keys(snapshot, ['repoId', 'head', 'tree', 'dirty', 'scope', 'files', 'digest']), 'invalid-snapshot-shape')) return { ok: false, errors }
    check(snapshot.repoId === repository.repoId && objectIdPattern.test(snapshot.head) && objectIdPattern.test(snapshot.tree) && typeof snapshot.dirty === 'boolean', 'invalid-snapshot-revision')
    check(canonicalize(normalizeScope(snapshot.scope)) === canonicalize(snapshot.scope), 'invalid-snapshot-scope')
    check(digestPattern.test(snapshot.digest) && snapshot.digest === bodyDigest(snapshot), 'snapshot-digest-mismatch')
    if (!check(Array.isArray(snapshot.files), 'invalid-source-files')) return { ok: false, errors }
    const files = new Map()
    for (const file of snapshot.files) {
      if (check(keys(file, ['path', 'rawDigest', 'byteLength']) && sourcePath(file.path) && digestPattern.test(file.rawDigest) && Number.isSafeInteger(file.byteLength) && file.byteLength >= 0 && !files.has(file.path), 'invalid-source-file')) files.set(file.path, file)
    }
    const validRef = (ref) => keys(ref, ['repoId', 'localId']) && ref.repoId === repository.repoId && text(ref.localId)
    const range = (v, pin) => keys(v, ['start', 'end', 'byteStart', 'byteEnd']) && [v.start, v.end, v.byteStart, v.byteEnd].every(Number.isSafeInteger) && v.start >= 0 && v.start < v.end && v.byteStart >= 0 && v.byteStart < v.byteEnd && v.byteEnd <= pin.byteLength
    const validSource = (s) => {
      if (!keys(s, ['repoId', 'path', 'revision', 'digest'], ['locator']) || s.repoId !== repository.repoId || s.revision !== snapshot.digest || !files.has(s.path) || s.digest !== files.get(s.path).rawDigest) return false
      if (!Object.hasOwn(s, 'locator')) return true
      const loc = s.locator
      return keys(loc, [], ['pointer', 'range', 'targetRange', 'rangeDigest']) && Object.keys(loc).length > 0 && (!Object.hasOwn(loc, 'pointer') || (text(loc.pointer) && loc.pointer.startsWith('/'))) && (!Object.hasOwn(loc, 'range') || (range(loc.range, files.get(s.path)) && digestPattern.test(loc.rangeDigest))) && (!Object.hasOwn(loc, 'targetRange') || (range(loc.targetRange, files.get(s.path)) && loc.range && loc.targetRange.start >= loc.range.start && loc.targetRange.end <= loc.range.end && loc.targetRange.byteStart >= loc.range.byteStart && loc.targetRange.byteEnd <= loc.range.byteEnd)) && (!Object.hasOwn(loc, 'rangeDigest') || Object.hasOwn(loc, 'range'))
    }
    if (!check(Array.isArray(value.nodes) && Array.isArray(value.ordinaryLinks) && Array.isArray(value.declaredRelations), 'invalid-source-records')) return { ok: false, errors }
    const nodeKeys = new Map()
    const fields = ['ref', 'source', 'title', 'summary', 'path', 'extension', 'type', 'kgType', 'domain', 'lifecycle', 'status', 'audience', 'classification', 'tags']
    for (const node of value.nodes) {
      const valid = keys(node, fields) && validRef(node.ref) && validSource(node.source) && node.source.path === node.path && sourcePath(node.path) && fields.slice(2, -1).every((key) => typeof node[key] === 'string') && node.extension === 'md' && node.type === 'markdown' && VALID_KG_TYPES.has(node.kgType) && VALID_STATUSES.has(node.status) && VALID_AUDIENCES.has(node.audience) && node.classification === 'classified' && Array.isArray(node.tags) && node.tags.every(text)
      if (check(valid, 'invalid-source-node')) {
        check(!nodeKeys.has(nodeRefKey(node.ref)), 'duplicate-local-node-id')
        nodeKeys.set(nodeRefKey(node.ref), node)
      }
    }
    const sourceNode = (ref, source) => validRef(ref) && validSource(source) && nodeKeys.get(nodeRefKey(ref))?.path === source.path
    for (const link of value.ordinaryLinks) check(keys(link, ['source', 'target', 'origin', 'syntax', 'embed', 'href', 'fragment', 'provenance', 'resolution']) && sourceNode(link.source, link.provenance) && link.origin === 'ordinary-link' && ['markdown', 'wikilink'].includes(link.syntax) && typeof link.embed === 'boolean' && text(link.href) && typeof link.fragment === 'string' && link.provenance.locator?.range && link.provenance.locator?.targetRange && (link.target === null ? link.resolution === 'unresolved' : validRef(link.target) && nodeKeys.has(nodeRefKey(link.target)) && link.resolution === 'resolved-local'), 'invalid-ordinary-link')
    for (const relation of value.declaredRelations) check(keys(relation, ['source', 'target', 'predicate', 'origin', 'provenance']) && sourceNode(relation.source, relation.provenance) && text(relation.target) && VALID_RELATION_TYPES.has(relation.predicate) && relation.origin === 'declared' && relation.provenance.locator?.range && typeof relation.provenance.locator?.pointer === 'string' && new RegExp(`^/kg/relations/${pointerToken(relation.predicate)}(?:/[0-9]+)?$`).test(relation.provenance.locator.pointer), 'invalid-declared-relation')
    check(keys(value.inputs, ['config', 'plan']) && [value.inputs.config, value.inputs.plan].every((s) => s === null || validSource(s)), 'invalid-input-pins')
    check(digestPattern.test(value.digest) && value.digest === bodyDigest(value), 'contribution-digest-mismatch')
  } catch { errors.push('invalid-contribution-data') }
  return { ok: errors.length === 0, errors: [...new Set(errors)] }
}

/** Only the supplied set participates. No repository/name/nearest-match guess. */
export function resolveLegacyNodeRef(localId, contributions) {
  if (!text(localId) || !Array.isArray(contributions)) refuse('invalid-legacy-node-ref')
  const matches = []
  const repos = new Set()
  for (const contribution of contributions) {
    if (!validateRepositoryContribution(contribution).ok) refuse('contribution-invalid')
    if (repos.has(contribution.repository.repoId)) refuse('duplicate-repository-contribution')
    repos.add(contribution.repository.repoId)
    matches.push(...contribution.nodes.filter((node) => node.ref.localId === localId).map((node) => node.ref))
  }
  if (matches.length > 1) refuse('legacy-node-id-ambiguous-use-qualified-ref')
  if (matches.length === 0) refuse('legacy-node-id-unresolved')
  return structuredClone(matches[0])
}

/**
 * Pure topology over exactly the supplied contributions and explicit layout.
 * The caller owns access decisions. Missing/ambiguous endpoints stay null;
 * no diagnostics, files, provider calls or inferred enrollment are consulted.
 * @param {import('./repo-contribution.types.mjs').RepositoryContribution[]} contributions
 * @param {{enrollment:{repoId:string, root:string}[]}} options
 * @returns {import('./repo-contribution.types.mjs').ContributionTopology}
 */
export function resolveContributionTopology(contributions, { enrollment } = {}) {
  if (!Array.isArray(contributions) || !Array.isArray(enrollment)) refuse('invalid-contribution-enrollment')
  const supplied = new Map()
  for (const contribution of contributions) {
    if (!validateRepositoryContribution(contribution).ok) refuse('contribution-invalid')
    if (supplied.has(contribution.repository.repoId)) refuse('duplicate-repository-contribution')
    supplied.set(contribution.repository.repoId, contribution)
  }
  const roots = new Map()
  for (const entry of enrollment) {
    if (!plain(entry) || Object.keys(entry).length !== 2 || !text(entry.repoId) || !supplied.has(entry.repoId) || roots.has(entry.repoId) || !(entry.root === '.' || relative(entry.root))) refuse('invalid-contribution-enrollment')
    roots.set(entry.repoId, entry.root)
  }
  if (roots.size !== supplied.size) refuse('invalid-contribution-enrollment')
  const virtualRoot = path.resolve(path.sep, '__atelier_contribution_enrollment__')
  const byRef = new Map()
  const byLocation = new Map()
  const scanned = new Map()
  const sorted = [...supplied.values()].sort((a, b) => compare(a.repository.repoId, b.repository.repoId))
  const repos = sorted.map((contribution) => {
    const repoId = contribution.repository.repoId
    const root = path.resolve(virtualRoot, roots.get(repoId))
    const nodesByPath = new Map()
    for (const node of contribution.nodes) {
      const key = nodeRefKey(node.ref)
      const internal = { id: key, path: node.path, title: node.title }
      nodesByPath.set(node.path, internal)
      byRef.set(key, node.ref)
      const location = path.resolve(root, node.path)
      if (!byLocation.has(location)) byLocation.set(location, [])
      byLocation.get(location).push(key)
      // Source bytes were already scanned and pinned. Disabling only the
      // resolver's asset fallback makes this invocation entirely free of I/O;
      // the returned occurrence retains its original embed flag unchanged.
      scanned.set(internal, { utf8Exact: true, occurrences: contribution.ordinaryLinks.filter((link) => nodeRefKey(link.source) === key).map((link) => ({ syntax: link.syntax, embed: false, href: link.href, fragment: link.fragment, range: link.provenance.locator.range, targetRange: link.provenance.locator.targetRange })) })
    }
    return { name: roots.get(repoId), root, nodesByPath }
  })
  const resolved = resolveWorkspaceLinks({ repos, scanned, isAssetEligible: () => false })
  const targets = new Map()
  for (const link of resolved.links) {
    const candidates = byLocation.get(path.resolve(virtualRoot, link.targetRepo, link.targetPath))
    if (candidates?.length === 1) targets.set(JSON.stringify([link.source, link.range.start]), byRef.get(link.target))
  }
  return {
    nodes: structuredClone(sorted.flatMap((contribution) => contribution.nodes)),
    ordinaryLinks: sorted.flatMap((contribution) => contribution.ordinaryLinks.map((link) => {
      const target = targets.get(JSON.stringify([nodeRefKey(link.source), link.provenance.locator.range.start])) ?? null
      return { ...structuredClone(link), target: target ? structuredClone(target) : null, resolution: target ? target.repoId === link.source.repoId ? 'resolved-local' : 'resolved-cross-repository' : 'unresolved' }
    })),
    declaredRelations: structuredClone(sorted.flatMap((contribution) => contribution.declaredRelations)),
  }
}
