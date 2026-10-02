import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import Ajv from 'ajv/dist/2020.js'
import { resolveProjectConfig, validateProjectConfigDoc } from '@mnstry/atelier/project'
import { buildCanonicalGraph } from '@mnstry/atelier/graph'
import { sanitizedGitEnvironment, sanitizeRemoteUrl } from '@mnstry/atelier/runtime/git'

export const MANIFEST_SCHEMA = 'atelier-personal-workspace-manifest@v1'
export const OVERLAY_SCHEMA = 'atelier-personal-workspace-overlay@v1'
const GENERATION_SCHEMA = 'atelier-personal-workspace-generation@v1'
const MANIFEST_FILE = 'atelier.personal.json'
const OVERLAY_FILE = 'atelier.overlay.json'
const MAX_INPUT = 1024 * 1024
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sortObject = (v) => Array.isArray(v) ? v.map(sortObject) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortObject(v[k])])) : v
const canonical = (v) => `${JSON.stringify(sortObject(v))}\n`
const inside = (root, file) => file === root || file.startsWith(`${root}${path.sep}`)
const overlap = (a, b) => inside(a, b) || inside(b, a)
const ajv = new Ajv({ strict: true, allErrors: true })
const validators = Object.fromEntries(['manifest', 'overlay'].map((name) => [name, ajv.compile(JSON.parse(fs.readFileSync(
  new URL(`../../contracts/atelier-personal-workspace-${name}.v1.schema.json`, import.meta.url), 'utf8')))]))
const resolvedInputs = new WeakSet()
const plans = new WeakSet()
const freeze = (v) => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v) } return v }

export class PersonalWorkspaceRefusal extends Error {
  constructor(code) { super(`Personal workspace refused: ${code}`); this.name = 'PersonalWorkspaceRefusal'; this.code = code }
}
const refuse = (code) => { throw new PersonalWorkspaceRefusal(code) }
function safe(fn, fallback = 'malformed-input') {
  try { return fn() } catch (error) { if (error instanceof PersonalWorkspaceRefusal) throw error; refuse(fallback) }
}
function forbiddenKeys(value) {
  if (!value || typeof value !== 'object') return
  for (const [key, member] of Object.entries(value)) {
    if (/^(permit|permission|permissions|mandate|consent|authority|classification|audience|readBoundary)$/i.test(key)) refuse('authority-field-refused')
    if (/^(rules|policy|workflow)$/i.test(key)) refuse('unsupported-rule')
    forbiddenKeys(member)
  }
}
function validate(value, kind) {
  forbiddenKeys(value)
  if (typeof value?.schema === 'string' && value.schema !== (kind === 'manifest' ? MANIFEST_SCHEMA : OVERLAY_SCHEMA)) {
    const version = value.schema.match(/^atelier-personal-workspace-(manifest|overlay)@v([0-9]+)$/)
    if (version && Number(version[2]) > 1) refuse('future-schema')
    refuse('unknown-schema')
  }
  if (!validators[kind](value)) refuse('malformed-input')
  const ids = kind === 'manifest' ? value.repos.map((r) => r.repoId)
    : ['annotations', 'connections', 'collections', 'views'].flatMap((k) => value[k].map((r) => r.id))
  if (new Set(ids).size !== ids.length) refuse('malformed-input')
  if (kind === 'manifest') {
    for (const repo of value.repos) {
      if (repo.remote !== null && sanitizeRemoteUrl(repo.remote) !== repo.remote) refuse('remote-credentials-refused')
    }
    for (const binding of value.bindings) if (!path.isAbsolute(binding) || binding.includes('\0')) refuse('path-not-absolute')
    for (let i = 0; i < value.bindings.length; i++) for (const b of value.bindings.slice(i + 1)) {
      if (overlap(path.resolve(value.bindings[i]), path.resolve(b))) refuse('ambiguous-binding')
    }
  }
  return freeze(value)
}
function rootCheck(root, privateRoot = false) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.resolve(root) !== root || root.includes('\0')) refuse('path-not-absolute')
  if (privateRoot && (process.platform === 'win32' || typeof process.getuid !== 'function')) refuse('private-root-unverifiable')
  let stat
  try { stat = fs.lstatSync(root) } catch { refuse('root-missing') }
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(root) !== root) refuse('root-symlinked')
  if (privateRoot && (stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0)) refuse('not-private-location')
  return root
}
function readPrivate(file, personalHome, limit = MAX_INPUT) {
  return safe(() => {
    rootCheck(personalHome, true)
    if (!path.isAbsolute(file) || !inside(personalHome, file)) refuse('not-private-location')
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      const stat = fs.fstatSync(fd)
      if (!stat.isFile() || stat.size > limit || fs.realpathSync(file) !== file) refuse('malformed-input')
      const bytes = fs.readFileSync(fd)
      if (bytes.length > limit) refuse('malformed-input')
      return bytes
    } finally { fs.closeSync(fd) }
  })
}
export function loadPersonalManifest(file, { personalHome = path.dirname(file) } = {}) {
  return safe(() => validate(JSON.parse(readPrivate(file, personalHome)), 'manifest'))
}
export function loadPersonalOverlay(file, { personalHome = path.dirname(file) } = {}) {
  return safe(() => validate(JSON.parse(readPrivate(file, personalHome)), 'overlay'))
}
function git(root, args, { allowAbsent = false } = {}) {
  // Preserve the config environment used by the shared reader, while disabling
  // helpers on every module-owned probe. The config probe checks all values,
  // including those before this command-line override.
  const r = spawnSync('git', ['-C', root, '-c', 'core.fsmonitor=false', ...args], { encoding: 'utf8', env: sanitizedGitEnvironment(process.env), timeout: 8000, maxBuffer: 16 * 1024 * 1024 })
  if (r.error || r.signal || (r.status !== 0 && !(allowAbsent && (r.status === 1 || (args[0] === 'remote' && r.status === 2))))) refuse('git-unavailable')
  return r.stdout || ''
}
function checkEnvironment() {
  if (Object.keys(process.env).some((key) => /^GIT_/i.test(key))) refuse('ambient-git-environment')
}
function checkRepo(repo) {
  rootCheck(repo.root)
  const helpers = git(repo.root, ['config', '--type=bool-or-str', '--get-all', 'core.fsmonitor'], { allowAbsent: true }).trim().split('\n')
  if (helpers.some((helper) => helper && helper !== 'false')) refuse('git-helper-configured')
  // A failed remote lookup is not proof of an absent remote: require a valid worktree first.
  if (git(repo.root, ['rev-parse', '--is-inside-work-tree']).trim() !== 'true') refuse('git-unavailable')
  if (fs.realpathSync(git(repo.root, ['rev-parse', '--show-toplevel']).trim()) !== repo.root) refuse('repo-root-mismatch')
  const observed = git(repo.root, ['remote', 'get-url', 'origin'], { allowAbsent: true }).trim()
  const remote = observed ? sanitizeRemoteUrl(observed) : null
  if (remote !== repo.remote) refuse('repo-identity-replaced')
}
function refs(overlay) {
  return [...overlay.annotations.map((a) => a.target), ...overlay.connections.flatMap((a) => [a.from, a.to]), ...overlay.collections.flatMap((a) => a.members)]
}
const refKey = (r) => JSON.stringify([r.repoId, r.nodeId])
function inputCheck(manifest, overlay, personalHome) {
  if (manifest.workspaceId !== overlay.workspaceId) refuse('malformed-input')
  const enrolled = manifest.repos.filter((r) => r.enrolled)
  if (enrolled.length === 0) refuse('not-enrolled')
  const overlayRepoId = `personal-${manifest.workspaceId}`
  if (manifest.repos.some((r) => r.repoId === overlayRepoId)) refuse('malformed-input')
  for (const r of refs(overlay)) {
    if (!manifest.repos.some((repo) => repo.repoId === r.repoId)) refuse('malformed-input')
    if (!enrolled.some((repo) => repo.repoId === r.repoId)) refuse('retained-removed-reference')
  }
  for (const view of overlay.views) for (const id of view.repoIds) if (!enrolled.some((r) => r.repoId === id)) refuse('retained-removed-reference')
  for (const repo of enrolled) {
    rootCheck(repo.root)
    if (overlap(personalHome, repo.root)) refuse('private-state-in-shared-root')
    checkRepo(repo)
  }
  for (let i = 0; i < enrolled.length; i++) for (const r of enrolled.slice(i + 1)) if (overlap(enrolled[i].root, r.root)) refuse('nested-enrolled-roots')
  return { enrolled, overlayRepoId }
}
function readInputs(personalHome) {
  checkEnvironment()
  rootCheck(personalHome, true)
  const manifest = loadPersonalManifest(path.join(personalHome, MANIFEST_FILE), { personalHome })
  const overlay = loadPersonalOverlay(path.join(personalHome, OVERLAY_FILE), { personalHome })
  return { manifest, overlay, ...inputCheck(manifest, overlay, personalHome) }
}
export function resolvePersonalWorkspace({ folder, personalHome } = {}) {
  return safe(() => {
    const input = readInputs(personalHome)
    rootCheck(folder)
    const bindings = input.manifest.bindings.map((b) => rootCheck(b))
    const matching = bindings.filter((b) => inside(b, folder))
    if (!matching.length) return freeze({ status: 'none', reasons: [{ code: 'not-enrolled' }] })
    if (matching.length > 1) refuse('ambiguous-binding')
    const resolved = { status: 'resolved', personalHome, ...input, workspaceId: input.manifest.workspaceId,
      manifestRevision: input.manifest.revision, coverage: { profile: 'manifest-only', enforcement: 'none', uncovered: ['filesystem-access', 'disclosure', 'effects', 'host-sandbox'] } }
    resolvedInputs.add(resolved)
    const plan = planPersonalGeneration(resolved)
    resolved.generationId = plan.generationId
    resolved.exists = fs.existsSync(path.join(personalHome, 'generations', plan.generationId))
    return freeze(resolved)
  })
}
// The canonical YAML subset treats raw Unicode line separators as line syntax.
const scalar = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
function markdown(id, title, body, targets = [], tags = []) {
  const privateTags = tags.length ? tags : ['personal-interpretation']
  return `---\ntitle: ${scalar(title)}\ntags:\n${privateTags.map((tag) => `  - ${scalar(tag)}\n`).join('')}kg:\n  id: ${JSON.stringify(id)}\n  type: document\n  status: active\n  audience: private\n${targets.length ? `  relations:\n    related:\n${[...new Set(targets)].sort().map((t) => `      - ${JSON.stringify(t)}\n`).join('')}` : ''}---\n\n${body}\n`
}
export function planPersonalGeneration(resolved) {
  if (!resolvedInputs.has(resolved) || resolved.status !== 'resolved') refuse('malformed-input')
  const { manifest, overlay, personalHome, enrolled, overlayRepoId } = resolved
  const referenceMap = Object.fromEntries(refs(overlay).map((r) => [refKey(r), r.nodeId]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  const inputsDigest = hash(canonical({ manifest, overlay, referenceMap }))
  // Relative project paths depend on this location. Moving the private home
  // produces a fresh generation without modifying or overwriting its history.
  const generationId = hash(canonical({ inputsDigest, personalHome }))
  const final = path.join(personalHome, 'generations', generationId)
  const files = {
    'inputs.json': canonical({ manifest, overlay, referenceMap }),
    'atelier.project.json': canonical({ schema: 'mnstry.atelier-project-config@v1', roots: { workspace: '.' },
      repos: [...enrolled.map((r) => ({ name: r.repoId, path: path.relative(final, r.root), readBoundary: 'private' })),
        { name: overlayRepoId, path: 'overlay', readBoundary: 'private' }] }),
    'shared/atelier.project.json': canonical({ schema: 'mnstry.atelier-project-config@v1', roots: { workspace: '..' },
      repos: enrolled.map((r) => ({ name: r.repoId, path: path.relative(path.join(final, 'shared'), r.root), readBoundary: 'private' })) }),
  }
  const overlayNodes = []
  function addOverlay(rel, id, title, body, targets = [], tags = []) {
    files[`overlay/${rel}`] = markdown(id, title, body, targets, tags)
    const related = [...new Set(targets)].sort()
    overlayNodes.push({ path: rel, id, title, classification: 'classified', markdownHasKgId: true,
      kgType: 'document', status: 'active', audience: 'private', tags: tags.length ? tags : ['personal-interpretation'],
      relations: related.length ? { related } : {} })
  }
  for (const a of overlay.annotations) addOverlay(`annotations/${a.id}.md`, `${overlayRepoId}:annotation-${a.id}`, a.displayAlias || a.id, a.note, [a.target.nodeId], a.tags)
  for (const a of overlay.connections) addOverlay(`connections/${a.id}.md`, `${overlayRepoId}:connection-${a.id}`, a.label, a.label, [a.from.nodeId, a.to.nodeId])
  for (const a of overlay.collections) addOverlay(`collections/${a.id}.md`, `${overlayRepoId}:collection-${a.id}`, a.name, a.name, a.members.map((r) => r.nodeId))
  for (const a of overlay.views) addOverlay(`views/${a.id}.md`, `${overlayRepoId}:view-${a.id}`, a.name, `Saved repository selection: ${JSON.stringify(a.repoIds)}`)
  // A private graph anchor makes an empty overlay a real, observable canonical input.
  addOverlay('workspace.md', `${overlayRepoId}:workspace`, manifest.workspaceId, 'Private workspace interpretation. Enrollment grants no authority.')
  const generation = { schema: GENERATION_SCHEMA, generationId, inputsDigest, personalHome, manifestSchema: MANIFEST_SCHEMA, overlaySchema: OVERLAY_SCHEMA,
    files: Object.keys(files).sort().map((p) => ({ path: p, sha256: hash(files[p]) })) }
  const plan = freeze({ personalHome, generationId, generation, files, overlayNodes })
  plans.add(plan)
  return plan
}
function verifyFiles(plan, final, mismatchCode = 'generation-corrupt') {
  return safe(() => {
    rootCheck(final, true)
    const expected = new Set([...Object.keys(plan.files), 'generation.json'])
    function walk(dir) {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, item.name)
        if (item.isSymbolicLink()) refuse(mismatchCode)
        if (item.isDirectory()) { rootCheck(file, true); walk(file) }
        else if (!item.isFile() || !expected.delete(path.relative(final, file).split(path.sep).join('/'))) refuse(mismatchCode)
      }
    }
    walk(final)
    if (expected.size) refuse(mismatchCode)
    for (const [rel, content] of Object.entries({ ...plan.files, 'generation.json': canonical(plan.generation) })) {
      if (!readPrivate(path.join(final, rel), final, 8 * MAX_INPUT).equals(Buffer.from(content))) refuse(mismatchCode)
    }
  }, mismatchCode)
}
function requireOutsideGit(root) {
  for (let ancestor = root; ; ancestor = path.dirname(ancestor)) {
    try { fs.lstatSync(path.join(ancestor, '.git')); refuse('generation-inside-work-tree') }
    catch (error) { if (error instanceof PersonalWorkspaceRefusal || error.code !== 'ENOENT') throw error }
    if (ancestor === path.dirname(ancestor)) break
  }
  const r = spawnSync('git', ['-C', root, '-c', 'core.fsmonitor=false', 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', env: sanitizedGitEnvironment(process.env), timeout: 8000 })
  if (r.error || r.signal) refuse('git-unavailable')
  if (r.status === 0) refuse('generation-inside-work-tree')
}
function currentPlan(personalHome) {
  const input = readInputs(personalHome)
  const resolved = { status: 'resolved', personalHome, ...input }
  resolvedInputs.add(resolved)
  return planPersonalGeneration(resolved)
}
function generationsRoot(personalHome, create = false) {
  rootCheck(personalHome, true)
  requireOutsideGit(personalHome)
  const root = path.join(personalHome, 'generations')
  if (create && !fs.existsSync(root)) fs.mkdirSync(root, { mode: 0o700 })
  rootCheck(root, true)
  requireOutsideGit(root)
  return root
}
export function materializePersonalGeneration(plan, { personalHome } = {}) {
  return safe(() => {
    if (!plans.has(plan) || personalHome !== plan.personalHome) refuse('malformed-input')
    if (currentPlan(personalHome).generationId !== plan.generationId) refuse('stale-generation')
    const root = generationsRoot(personalHome, true)
    const final = path.join(root, plan.generationId)
    if (fs.existsSync(final)) { verifyFiles(plan, final, 'generation-overwrite-refused'); composeAt(plan, final); return { generationId: plan.generationId, reused: true } }
    const staging = fs.mkdtempSync(path.join(root, `.staging-${plan.generationId}-`))
    fs.chmodSync(staging, 0o700)
    const syncDir = (dir) => { const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) } }
    // An interrupted staging directory stays observable. No authored file or old generation is removed.
    for (const [rel, content] of Object.entries({ ...plan.files, 'generation.json': canonical(plan.generation) })) {
      const file = path.join(staging, rel)
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      const fd = fs.openSync(file, 'wx', 0o600)
      try { fs.writeFileSync(fd, content); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      syncDir(path.dirname(file))
    }
    syncDir(staging)
    try { composeAt(plan, staging) } catch (error) { fs.rmSync(staging, { recursive: true }); throw error }
    // Revalidate immediately before publishing, including every enrolled root and input.
    if (currentPlan(personalHome).generationId !== plan.generationId) refuse('stale-generation')
    rootCheck(root, true)
    try { fs.renameSync(staging, final) } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error
      fs.rmSync(staging, { recursive: true })
      verifyFiles(plan, final, 'generation-overwrite-refused')
      composeAt(plan, final)
      return { generationId: plan.generationId, reused: true }
    }
    syncDir(root)
    verifyFiles(plan, final)
    return { generationId: plan.generationId, reused: false }
  }, 'generation-write-failed')
}
export function composePersonalWorkspace({ personalHome, generationId } = {}) {
  return safe(() => {
    checkEnvironment()
    if (typeof generationId !== 'string' || !/^[0-9a-f]{64}$/.test(generationId)) refuse('malformed-input')
    const plan = currentPlan(personalHome)
    if (generationId !== plan.generationId) {
      const previousFile = path.join(personalHome, 'generations', generationId, 'generation.json')
      if (fs.existsSync(previousFile)) {
        // Untrusted history can only classify a refusal here; it never permits
        // reuse, changes authored inputs, or retargets the graph.
        const previous = safe(() => JSON.parse(readPrivate(previousFile, personalHome)), 'generation-corrupt')
        if (previous.inputsDigest === plan.generation.inputsDigest && typeof previous.personalHome === 'string' && previous.personalHome !== personalHome) refuse('generation-relocated')
      }
      refuse('stale-generation')
    }
    if (!fs.existsSync(path.join(personalHome, 'generations'))) refuse('generation-missing')
    const root = generationsRoot(personalHome)
    const final = path.join(root, generationId)
    if (!fs.existsSync(final)) refuse('generation-missing')
    const { graph, sourceRevisions, input } = composeAt(plan, final)
    return { graph, generation: { ...plan.generation, sourceRevisions }, preferences: input.overlay.preferences,
      coverage: { profile: 'manifest-only', enforcement: 'none', uncovered: ['filesystem-access', 'disclosure', 'effects', 'host-sandbox'] },
      warnings: fs.readdirSync(root).filter((n) => n.startsWith('.staging-')).map(() => ({ code: 'stale-staging' })) }
  })
}

// Asset evidence must not allocate the entire source file, including large binaries.
function sourceHash(file) {
  return safe(() => {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      const before = fs.fstatSync(fd)
      if (!before.isFile() || fs.realpathSync(file) !== file) refuse('source-read-failed')
      const digest = createHash('sha256'), chunk = Buffer.alloc(64 * 1024)
      let position = 0
      while (position < before.size) {
        const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, before.size - position), position)
        if (!count) refuse('source-read-failed')
        digest.update(chunk.subarray(0, count)); position += count
      }
      const after = fs.fstatSync(fd)
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) refuse('source-read-failed')
      return digest.digest('hex')
    } finally { fs.closeSync(fd) }
  }, 'source-read-failed')
}

function composeAt(plan, final) {
  const { personalHome } = plan
    // Distinguish ambient project overrides from other unmanifested generation bytes.
    for (const rel of ['atelier.local.json', 'atelier.workspace.local.json', '.atelier-local']) {
      if (fs.existsSync(path.join(final, rel))) refuse('ambient-overlay-present')
    }
    verifyFiles(plan, final)
    const input = readInputs(personalHome)
    // Git can report NFC while macOS readdir preserves an NFD spelling. Match
    // canonical equivalents conservatively before any ignored census returns.
    const ignorePath = (rel) => process.platform === 'darwin' ? rel.normalize('NFC') : rel
    const ignored = new Map(input.enrolled.map((repo) => [repo.repoId, git(repo.root,
      ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']).split('\0').filter(Boolean).map((p) => ignorePath(p.replace(/\/+$/, '')))]))
    const project = resolveProjectConfig({ argv: [`--project-config=${path.join(final, 'atelier.project.json')}`], cwd: final, env: { PATH: process.env.PATH }, writeLocalState: false })
    if (validateProjectConfigDoc(project.config).length) refuse('generation-corrupt')
    if (project.localOverlay.paths.length || project.repos.some((r) => r.pathSource !== 'tracked-config')) refuse('ambient-overlay-present')
    const graph = buildCanonicalGraph(project, { isLinkTargetEligible: (node) => node.repo !== input.overlayRepoId })
    for (const n of [...graph.nodes, ...graph.assets]) {
      if ((ignored.get(n.repo) || []).some((p) => [n.path, n.sidecar].filter(Boolean).map(ignorePath).some((rel) => rel === p || rel.startsWith(`${p}/`)))) refuse('ignored-source-in-census')
    }
    for (const ref of refs(input.overlay)) {
      const node = graph.nodes.find((n) => n.id === ref.nodeId && n.repo === ref.repoId)
      if (!node) refuse('stale-reference')
      if (node.markdownHasKgId !== true && node.sidecarHasKgId !== true) refuse('unstable-reference')
    }
    if (!graph.ok) refuse('source-graph-invalid')
    const sharedProject = resolveProjectConfig({ argv: [`--project-config=${path.join(final, 'shared/atelier.project.json')}`],
      cwd: path.join(final, 'shared'), env: { PATH: process.env.PATH }, writeLocalState: false })
    if (validateProjectConfigDoc(sharedProject.config).length || sharedProject.localOverlay.paths.length || sharedProject.repos.some((r) => r.pathSource !== 'tracked-config')) refuse('generation-corrupt')
    const shared = buildCanonicalGraph(sharedProject)
    if (!shared.ok) refuse('source-graph-invalid')
    const sharedIds = new Set(shared.nodes.map((n) => n.id))
    const sharedFacts = (nodes, edges, linkDiagnostics) => canonical({ nodes, edges, linkDiagnostics })
    if (sharedFacts(shared.nodes, shared.edges, shared.linkDiagnostics) !== sharedFacts(
      graph.nodes.filter((n) => n.repo !== input.overlayRepoId), graph.edges.filter((e) => sharedIds.has(e.source)), graph.linkDiagnostics)) refuse('shared-facts-changed')
    for (const rel of Object.keys(plan.files).filter((p) => p.startsWith('overlay/'))) {
      if (!graph.nodes.some((n) => n.repo === input.overlayRepoId && n.path === rel.slice('overlay/'.length))) refuse('overlay-census-mismatch')
    }
    // Parser acceptance alone is insufficient: generated interpretations must
    // retain every planned identity, classification, tag, and declared relation.
    for (const expected of plan.overlayNodes) {
      const node = graph.nodes.find((n) => n.repo === input.overlayRepoId && n.path === expected.path)
      const semantics = node && Object.fromEntries(Object.keys(expected).map((key) => [key, node[key]]))
      if (canonical(expected) !== canonical(semantics)) refuse('overlay-semantics-mismatch')
      const expectedEdges = (expected.relations.related || []).map((target) => ({ source: expected.id, target, type: 'related', declared: true, origin: 'declared' }))
      const actualEdges = graph.edges.filter((e) => e.source === expected.id).map(({ source, target, type, declared, origin }) => ({ source, target, type, declared, origin })).sort((a, b) => a.target < b.target ? -1 : a.target > b.target ? 1 : 0)
      if (canonical(expectedEdges) !== canonical(actualEdges)) refuse('overlay-semantics-mismatch')
    }
    const expectedOverlay = Object.keys(plan.files).filter((p) => p.startsWith('overlay/')).map((p) => p.slice(8)).sort()
    const actualOverlay = graph.nodes.filter((n) => n.repo === input.overlayRepoId).map((n) => n.path).sort()
    if (canonical(expectedOverlay) !== canonical(actualOverlay)) refuse('overlay-census-mismatch')
    // Report current source evidence, never claim that an immutable private generation freezes live source bytes.
    const sourceRevisions = input.enrolled.map((repo) => ({ repoId: repo.repoId, remote: repo.remote,
      observedCensusDigest: hash(canonical(graph.nodes.filter((n) => n.repo === repo.repoId).map((n) => ({ id: n.id, path: n.path, sha256: sourceHash(path.join(repo.root, n.path)) })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)))) }))
    if (currentPlan(personalHome).generationId !== plan.generationId) refuse('stale-generation')
    verifyFiles(plan, final)
  return { graph, sourceRevisions, input }
}
