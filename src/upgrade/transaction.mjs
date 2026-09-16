import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { resolveGitExecutable, runGit, parseNullConfig } from '../runtime/git-adapter.mjs'
import { resolveProjectConfig } from '../project/config.mjs'
import { validateJsonSchema } from '../export/atelier-export-contract.mjs'
import { buildAtelierLock } from './upgrade.mjs'
import { checkBoundaryPolicy, loadBoundaryPolicy } from '../boundary/policy.mjs'
import { buildGraph } from '../graph/graph.mjs'
import { buildProjectProjection, buildProjectManifest } from '../projection/project.mjs'
import { buildReadiness } from '../readiness/readiness.mjs'
import { hashBytes, hashObject, same, jsonText, contained, readBytes, fileState, inventory, syncDirectory, publish, privateDirectory, replaceExpected, MAX_BYTES } from './transaction-files.mjs'

const packageRoot = fileURLToPath(new URL('../../', import.meta.url))
const PRIVATE = '.atelier-local/upgrades'
const POLICY = 'atelier.adoption-policy.json'
const SCHEMAS = { policy: 'atelier-adoption-policy.v1', plan: 'atelier-upgrade-plan.v2', migration: 'atelier-migration.v2', event: 'atelier-upgrade-receipt.v1', lock: 'atelier-lock.v1' }
const schemaDocs = Object.fromEntries(Object.entries(SCHEMAS).map(([key, name]) => [key, JSON.parse(fs.readFileSync(path.join(packageRoot, 'contracts', `${name}.schema.json`)))]))
export function validateUpgradeDocument(kind, doc) {
  const errors = validateJsonSchema(schemaDocs[kind], doc)
  if (errors.length) throw new Error(`invalid upgrade ${kind}: ${errors.join('; ')}`)
  return doc
}
const readJson = (file) => JSON.parse(readBytes(file))
const git = (root, args, options = {}) => runGit(resolveGitExecutable(), root, ['-c', 'core.fsmonitor=false', ...(args[0] === 'check-ignore' ? [] : ['--literal-pathspecs']), ...args], options)
const text = (root, args) => git(root, args).stdout.trim()
const snapshot = (root) => inventory(root, { exclude: ['.git', '.atelier-local'] })

function privateRoot(root) {
  // An ignored pathname alone is insufficient when its files were force-added.
  if (text(root, ['ls-files', '--', '.atelier-local']).length || !git(root, ['check-ignore', '-q', '.atelier-local/upgrades/probe'], { allowFailure: true }).ok) throw new Error('private upgrade state must be ignored and untracked')
  return privateDirectory(root, PRIVATE)
}
function policy(root) {
  const result = validateUpgradeDocument('policy', readJson(contained(root, POLICY)))
  if (!result.enabled) throw new Error('upgrade policy is disabled')
  return result
}
function canonicalProject(project) {
  const root = fs.realpathSync(project.configDir)
  const remap = (value) => value ? path.resolve(root, path.relative(project.configDir, value)) : value
  const copy = { ...project, configDir: root, repos: project.repos.map((repo) => ({ ...repo, path: remap(repo.path) })) }
  for (const key of ['configPath', 'workspaceRoot', 'repoOpsRoot', 'repoAccessPath', 'boundaryPolicyPath', 'graphPath', 'readinessPath', 'outputRoot']) copy[key] = remap(project[key])
  return copy
}
function checkProject(project) {
  if (Object.keys(process.env).some((key) => /^GIT_(?!PAGER$|TERMINAL_PROMPT$|OPTIONAL_LOCKS$)/i.test(key))) throw new Error('Git environment overrides unsupported during exact preparation')
  const root = fs.realpathSync(project.configDir)
  if (text(root, ['rev-parse', '--show-toplevel']) !== root) throw new Error('configuration must be at repository root')
  const gitDir = text(root, ['rev-parse', '--absolute-git-dir'])
  const common = path.resolve(root, text(root, ['rev-parse', '--git-common-dir']))
  if (gitDir === common) throw new Error('upgrade requires an isolated linked worktree')
  if (!text(root, ['symbolic-ref', '--quiet', 'HEAD']).startsWith('refs/heads/')) throw new Error('upgrade requires a candidate branch')
  if (project.repos.length !== 1 || project.repos[0].external || fs.realpathSync(project.repos[0].path) !== root || fs.realpathSync(project.workspaceRoot) !== root || fs.realpathSync(project.repoOpsRoot) !== root) throw new Error('slice 1 requires one repository with workspace and configuration at its root')
  if (project.localOverlay.paths.length || project.config.runtime || project.config.alignment || project.governanceLedgerPath) throw new Error('local overlays and runtime/alignment participants are unsupported')
  if (project.config.ext && Object.entries(project.config.ext).some(([key, value]) => key !== 'mnstry.atelier' || Object.keys(value).some((k) => k !== 'distribution'))) throw new Error('extension pack and custom extension participants are unsupported')
  if (fs.existsSync(path.join(root, '.atelier-local', 'readiness'))) throw new Error('private readiness inputs require a later read-set participant')
  for (const file of [project.configPath, project.repoAccessPath, project.boundaryPolicyPath, project.graphPath, project.readinessPath, path.join(project.outputRoot, 'index.html')]) contained(root, path.relative(root, file))
  if (fs.existsSync(path.join(root, '.gitmodules'))) throw new Error('submodules unsupported')
  return root
}
function gitAuxiliary(root) {
  const result = git(root, ['config', '--path', '--get', 'core.excludesFile'], { allowFailure: true })
  if (!result.ok && result.status !== 1) throw new Error('Git ignore configuration unavailable')
  const globalIgnore = result.ok ? path.resolve(root, result.stdout.trim()) : path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config'), 'git', 'ignore')
  const globalAttributes = path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config'), 'git', 'attributes')
  const files = [text(root, ['rev-parse', '--git-path', 'info/exclude']), text(root, ['rev-parse', '--git-path', 'info/attributes']), globalIgnore, globalAttributes].map((file) => path.resolve(root, file))
  return files.map((file) => ({ path: file, state: fileState(file) }))
}
function gitEvidence(root) {
  const result = git(root, ['config', '--path', '--get', 'core.hooksPath'], { allowFailure: true })
  if (!result.ok && result.status !== 1) throw new Error('hook configuration unavailable')
  const hooksPath = path.resolve(root, result.ok ? result.stdout.trim() : text(root, ['rev-parse', '--git-path', 'hooks']))
  const config = parseNullConfig(git(root, ['config', '--null', '--list']).stdout)
  if (config.some(({ key, value }) => /^core\.attributesfile$|^filter\.|^extensions\.(partialclone|worktreeconfig)$|^remote\..*\.promisor$/.test(key) || (/^core\.(sparsecheckout|autocrlf|fsmonitor)$/.test(key) && !/^(false|no|off|0)$/.test(value)))) throw new Error('unsupported Git transformation or checkout configuration')
  if (fs.existsSync(hooksPath) && (fs.lstatSync(hooksPath).isSymbolicLink() || fs.realpathSync(hooksPath) !== hooksPath)) throw new Error('redirected hook directory refused')
  const auxiliary = gitAuxiliary(root)
  for (const entry of [auxiliary[1], auxiliary[3]]) {
    if (entry.state && readBytes(entry.path).length) throw new Error('Git attribute transformations unsupported in slice 1')
  }
  return {
    gitAuxDigest: hashObject(auxiliary),
    gitDigest: hashBytes(readBytes(resolveGitExecutable(), { allowLinks: true })),
    gitConfigDigest: hashBytes(git(root, ['config', '--null', '--list', '--show-origin']).stdout),
    hooksPath,
    hooksDigest: hashObject(fs.existsSync(hooksPath) ? inventory(hooksPath) : []),
  }
}
function executorDigest() {
  const inputs = ['src', 'contracts', 'bin'].map((dir) => ({ dir, files: inventory(path.join(packageRoot, dir)) }))
  for (const file of ['package.json', 'package-lock.json']) inputs.push({ file, state: fileState(path.join(packageRoot, file)) })
  // Resolve from the actual importing module, then follow each package's own
  // dependency resolution. npm may hoist a dependency; nested copies must be
  // bound to the importer that actually selects them, not a guessed layout.
  const roots = new Map()
  const edges = []
  function dependency(specifier, importer, via) {
    const entry = fs.realpathSync(createRequire(importer).resolve(specifier))
    let dir = path.dirname(entry)
    while (!fs.existsSync(path.join(dir, 'package.json'))) {
      const parent = path.dirname(dir)
      if (parent === dir) throw new Error('dependency package identity unavailable')
      dir = parent
    }
    const metadata = readJson(path.join(dir, 'package.json'))
    const id = hashObject({ name: metadata.name, version: metadata.version, files: inventory(dir, { exclude: ['node_modules'], allowLinks: true }) })
    edges.push({ via, specifier, id })
    if (roots.has(dir)) return
    if (roots.size >= 64) throw new Error('executor dependency closure exceeds bounds')
    roots.set(dir, id)
    for (const child of Object.keys(metadata.dependencies ?? {}).sort()) dependency(child, path.join(dir, 'package.json'), id)
  }
  const importer = fileURLToPath(new URL('../export/atelier-export-contract.mjs', import.meta.url))
  dependency('ajv/dist/2020.js', importer, 'schema-validator')
  dependency('ajv-formats', importer, 'schema-validator')
  inputs.push({ dependencies: edges })
  return hashObject({ inputs, node: process.version })
}
function identity(root) {
  return hashObject({ root, gitDir: text(root, ['rev-parse', '--absolute-git-dir']), common: text(root, ['rev-parse', '--git-common-dir']) })
}
function clean(root) {
  if (git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).stdout) throw new Error('upgrade requires a clean index and working tree')
  const flags = git(root, ['ls-files', '-v', '-z']).stdout.split('\0').filter(Boolean)
  if (flags.some((s) => !s.startsWith('H '))) throw new Error('special index flags unsupported')
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    if (fs.existsSync(path.resolve(root, text(root, ['rev-parse', '--git-path', name])))) throw new Error('Git operation already in progress')
  }
}
function lease(root, body) {
  const state = privateRoot(root)
  if (inventory(state).reduce((sum, x) => sum + fs.statSync(path.join(state, x.path)).size, 0) > MAX_BYTES / 2) throw new Error('local evidence capacity exhausted; export and verify before retention maintenance')
  const lock = path.join(state, 'writer')
  fs.mkdirSync(lock) // No time-based stealing, including after an interrupted run.
  publish(path.join(lock, 'owner.json'), jsonText({ pid: process.pid, startedAt: new Date().toISOString() }))
  syncDirectory(state)
  try { return body() } finally { fs.rmSync(lock, { recursive: true }); syncDirectory(state) }
}
function allowedPaths(project) {
  const paths = ['atelier.lock.json', project.graphPath, path.join(project.outputRoot, 'index.html'), path.join(project.outputRoot, 'atelier.manifest.json'), project.readinessPath].map((p) => path.isAbsolute(p) ? path.relative(project.configDir, p) : p)
  if (new Set(paths).size !== 5 || paths.slice(1).some((p) => !p.startsWith('atelier-output/'))) throw new Error('slice 1 generated writes must be distinct files inside atelier-output')
  paths.forEach((p) => contained(project.configDir, p))
  return paths
}
function boundaryCheck(project, staged = false) {
  const loaded = loadBoundaryPolicy(project)
  if (!loaded.ok) throw new Error('boundary policy unavailable')
  const report = checkBoundaryPolicy({ project, policy: loaded.policy, staged, gitExecutable: resolveGitExecutable(), allowNetworkActorResolution: false, forceActorErrors: true })
  if (!report.ok) throw new Error(`boundary postcheck refused: ${report.errors.map((e) => e.code).join(', ')}`)
}
function preservedLock(project, generatedAt) {
  const file = path.join(project.configDir, 'atelier.lock.json')
  const previous = fs.existsSync(file) ? validateUpgradeDocument('lock', readJson(file)) : null
  // Pack adoption and template changes are separate participants.
  const next = buildAtelierLock({ project })
  if (previous && !same(previous.boundaryPolicy, next.boundaryPolicy)) throw new Error('boundary policy adoption requires a separate participant')
  if (previous && !same(previous.extensionPacks, next.extensionPacks)) throw new Error('pack adoption requires a separate participant')
  next.generatedAt = generatedAt
  if (previous) { next.appliedMigrations = previous.appliedMigrations; next.template = previous.template; next.lastSuccessfulUpgrade = previous.lastSuccessfulUpgrade }
  return validateUpgradeDocument('lock', next)
}
function render(project, readSet, createdAt) {
  const root = project.configDir
  const scratch = fs.mkdtempSync(path.join(privateRoot(root), 'prepare-'))
  const allowed = allowedPaths(project)
  try {
    for (const entry of readSet) {
      if (entry.path.split('/').includes('.gitattributes')) throw new Error('Git attribute transformations unsupported in slice 1')
      const dest = contained(scratch, entry.path)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, readBytes(contained(root, entry.path)), { mode: entry.state.mode === '100755' ? 0o755 : 0o644 })
    }
    // Private preparation has no commits or hooks. Keep Git ignore semantics
    // for the existing graph builder without sharing the enrolled index.
    const empty = path.join(scratch, '.atelier-local', 'empty-template')
    fs.mkdirSync(empty, { recursive: true })
    git(scratch, ['init', `--template=${empty}`])
    const [exclude, , globalIgnore] = gitAuxiliary(root)
    if (exclude.state) { fs.mkdirSync(path.join(scratch, '.git/info'), { recursive: true }); fs.writeFileSync(path.join(scratch, '.git/info/exclude'), readBytes(exclude.path)) }
    git(scratch, ['config', 'core.excludesFile', globalIgnore.path])
    const tracked = git(root, ['ls-files', '-z']).stdout.split('\0').filter(Boolean)
    for (let start = 0; start < tracked.length; start += 100) git(scratch, ['add', '-f', '--', ...tracked.slice(start, start + 100)])
    const clone = resolveProjectConfig({ cwd: scratch, argv: ['--project', path.join(scratch, path.basename(project.configPath))], env: {}, writeLocalState: false })
    if (clone.workspaceRoot !== scratch || clone.repoOpsRoot !== scratch || clone.repos.length !== 1 || clone.repos[0].path !== scratch || clone.localOverlay.paths.length) throw new Error('preparation inputs escape isolated workspace')
    for (const file of [clone.configPath, clone.repoAccessPath, clone.boundaryPolicyPath, clone.graphPath, clone.readinessPath, path.join(clone.outputRoot, 'index.html')]) contained(scratch, path.relative(scratch, file))
    const before = snapshot(scratch)
    const write = (rel, bytes) => {
      if (!allowed.includes(rel)) throw new Error('undeclared preparation write')
      const file = contained(scratch, rel)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, bytes)
    }
    const lock = preservedLock(project, createdAt)
    write('atelier.lock.json', jsonText(lock))
    const graph = buildGraph(clone)
    graph.project = path.basename(root)
    if (graph.errors.length) throw new Error('graph postcheck failed')
    write(path.relative(scratch, clone.graphPath), jsonText(graph))
    const projection = buildProjectProjection(clone)
    write(path.relative(scratch, projection.output), projection.html)
    write(path.relative(scratch, path.join(clone.outputRoot, 'atelier.manifest.json')), jsonText(buildProjectManifest(clone, projection)))
    const readiness = buildReadiness({ project: clone, graph })
    readiness.graph.path = project.graphPath
    readiness.projection.outputRoot = project.outputRoot
    readiness.projection.entry = path.join(project.outputRoot, 'index.html')
    if (!readiness.ready) throw new Error('readiness postcheck failed')
    write(path.relative(scratch, clone.readinessPath), jsonText(readiness))
    const after = snapshot(scratch)
    const writes = after.filter((entry) => !same(entry.state, before.find((p) => p.path === entry.path)?.state ?? null)).map((entry) => {
      if (!allowed.includes(entry.path)) throw new Error('unaccounted preparation write')
      const previous = before.find((p) => p.path === entry.path)?.state ?? null
      return { path: entry.path, owner: entry.path === 'atelier.lock.json' ? 'lock' : 'generated', action: previous ? 'update' : 'create', before: previous, after: entry.state, content: readBytes(contained(scratch, entry.path)).toString('base64') }
    })
    if (before.some((entry) => !after.some((p) => p.path === entry.path))) throw new Error('unaccounted preparation deletion')
    return { writes, allowed }
  } finally { fs.rmSync(scratch, { recursive: true }); syncDirectory(privateRoot(root)) }
}

function planDigest(plan) { const { digest, ...authority } = plan; return hashObject(authority) }
function requireDurableHost() {
  if (!['linux', 'darwin'].includes(process.platform)) throw new Error('exact upgrade transactions require a qualified Linux or macOS filesystem; this host is unsupported')
}
export function prepareUpgrade({ project, now = new Date() }) {
  requireDurableHost()
  project = canonicalProject(project)
  const root = checkProject(project)
  return lease(root, () => {
    clean(root)
    const adopted = policy(root)
    const readSet = snapshot(root)
    boundaryCheck(project)
    const createdAt = now.toISOString()
    const evidence = gitEvidence(root)
    const head = text(root, ['rev-parse', 'HEAD'])
    const branch = text(root, ['symbolic-ref', 'HEAD'])
    const executor = executorDigest()
    const { writes, allowed } = render(project, readSet, createdAt)
    if (!same(snapshot(root), readSet) || text(root, ['rev-parse', 'HEAD']) !== head || !same(gitEvidence(root), evidence)) throw new Error('inputs changed during preparation')
    clean(root)
    const plan = {
      schema: 'mnstry.atelier-upgrade-plan@v2', digest: '', operation: 'prepare-local-candidate', workspace: root,
      repositoryId: identity(root), configPath: path.basename(project.configPath), baseHead: head, baseTree: text(root, ['rev-parse', 'HEAD^{tree}']), branch,
      createdAt, expiresAt: new Date(now.getTime() + adopted.maxAgeSeconds * 1000).toISOString(),
      policy: adopted, policyDigest: hashObject(adopted), executorDigest: executor, ...evidence, readSet,
      migration: { schema: 'mnstry.atelier-migration@v2', id: 'local-lock-projections@1', executorDigest: executor, readScope: 'whole-enrolled-repository', allowedWrites: allowed, sideEffects: ['git-index', 'git-commit'], postChecks: ['exact-inventory', 'lock-schema', 'exact-index', 'commit-parent-tree-message'] },
      writes, releaseEvidence: null, dependencyInstallation: 'excluded', mode: 'manual-exact-plan', recoveryCoverage: 'local-only', message: 'Prepare Atelier local lock and projections',
    }
    plan.digest = planDigest(plan)
    validateUpgradeDocument('plan', plan)
    const dir = privateDirectory(root, `${PRIVATE}/plans`)
    const savedPlan = path.join(dir, `${plan.digest.slice(7)}.json`)
    if (Buffer.byteLength(jsonText(plan)) > 8 * 1024 * 1024) throw new Error('saved plan exceeds 8 MiB capacity')
    publish(savedPlan, jsonText(plan))
    return { ok: true, savedPlan, plan, confirmationIsAuthenticatedIdentity: false }
  })
}

function loadPlan(root, file) {
  const location = path.resolve(file)
  const relative = path.relative(root, location)
  if (!/^\.atelier-local\/upgrades\/plans\/[a-f0-9]{64}\.json$/.test(relative)) throw new Error('plan must be the saved local digest-addressed file')
  const plan = validateUpgradeDocument('plan', readJson(contained(root, relative)))
  if (planDigest(plan) !== plan.digest || path.basename(file) !== `${plan.digest.slice(7)}.json`) throw new Error('plan digest mismatch')
  if (plan.workspace !== root || plan.repositoryId !== identity(root)) throw new Error('plan belongs to another workspace')
  const allowed = plan.migration.allowedWrites
  if (new Set(plan.writes.map((w) => w.path)).size !== plan.writes.length || new Set(plan.readSet.map((r) => r.path)).size !== plan.readSet.length) throw new Error('duplicate plan paths')
  for (const entry of plan.readSet) contained(root, entry.path)
  for (const entry of plan.writes) {
    contained(root, entry.path)
    if (!allowed.includes(entry.path) || (entry.owner === 'lock' ? entry.path !== 'atelier.lock.json' : !entry.path.startsWith('atelier-output/'))) throw new Error('unregistered write path')
    const content = Buffer.from(entry.content, 'base64')
    if (content.toString('base64') !== entry.content || !entry.after || hashBytes(content) !== entry.after.digest || !same(entry.before, plan.readSet.find((r) => r.path === entry.path)?.state ?? null) || entry.action !== (entry.before ? 'update' : 'create')) throw new Error('invalid write evidence')
  }
  return plan
}
function expectedSnapshot(plan, count) {
  const entries = new Map(plan.readSet.map((entry) => [entry.path, entry.state]))
  for (const write of plan.writes.slice(0, count)) entries.set(write.path, write.after)
  return [...entries].map(([file, state]) => ({ path: file, state })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}
function liveBindings(root, plan, count, now = new Date()) {
  for (const rel of ['.atelier-local/readiness', '.atelier-local/atelier.local.json', 'atelier.local.json', 'atelier.workspace.local.json']) if (fs.existsSync(contained(root, rel))) throw new Error('unsupported local context appeared')
  if (now < new Date(plan.createdAt) || now >= new Date(plan.expiresAt) || new Date(plan.expiresAt) - new Date(plan.createdAt) > plan.policy.maxAgeSeconds * 1000) throw new Error('plan expired or clock moved backward')
  if (!same(policy(root), plan.policy) || hashObject(plan.policy) !== plan.policyDigest) throw new Error('policy changed or revoked')
  if (executorDigest() !== plan.executorDigest || plan.migration.executorDigest !== plan.executorDigest) throw new Error('executor changed')
  if (!same(gitEvidence(root), Object.fromEntries(['gitDigest', 'gitConfigDigest', 'gitAuxDigest', 'hooksPath', 'hooksDigest'].map((k) => [k, plan[k]])))) throw new Error('Git or hook identity changed')
  if (text(root, ['rev-parse', 'HEAD']) !== plan.baseHead || text(root, ['symbolic-ref', 'HEAD']) !== plan.branch || !same(snapshot(root), expectedSnapshot(plan, count))) throw new Error('repository changed from saved plan')
}
function operationDirectory(root, id) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid operation ID')
  return contained(root, `${PRIVATE}/operations/${id}`)
}
function events(root, id) {
  const dir = contained(root, `${PRIVATE}/operations/${id}/events`)
  const records = []
  let previous = null
  for (const name of fs.readdirSync(dir).sort()) {
    const record = validateUpgradeDocument('event', readJson(contained(root, `${PRIVATE}/operations/${id}/events/${name}`)))
    const digest = hashObject(record)
    if (name !== `${String(records.length).padStart(6, '0')}-${digest.slice(7)}.json` || record.sequence !== records.length || record.previous !== previous || record.operationId !== id || record.planDigest !== `sha256:${id}` || record.confirmation !== record.planDigest || (records.length && new Date(record.time) < new Date(records.at(-1).time))) throw new Error('broken upgrade journal; recovery required')
    if ((!records.length && record.phase !== 'accepted') || ['completed', 'commit-refused', 'recovery-required'].includes(records.at(-1)?.phase)) throw new Error('invalid journal transition')
    records.push(record); previous = digest
  }
  return records
}
function append(root, plan, phase, { step = null, expected = null, observed = null } = {}) {
  const id = plan.digest.slice(7)
  const chain = events(root, id)
  const event = {
    schema: 'mnstry.atelier-upgrade-receipt@v1', kind: 'private-event', operationId: id, planDigest: plan.digest,
    sequence: chain.length, previous: chain.length ? hashObject(chain.at(-1)) : null,
    time: new Date().toISOString(), phase, step, expected, observed, confirmation: plan.digest,
  }
  if (chain.length && new Date(event.time) < new Date(chain.at(-1).time)) throw new Error('clock moved backward during operation')
  validateUpgradeDocument('event', event)
  publish(path.join(operationDirectory(root, id), 'events', `${String(chain.length).padStart(6, '0')}-${hashObject(event).slice(7)}.json`), jsonText(event))
  events(root, id)
}
function indexManifest(root) {
  return git(root, ['ls-files', '--stage', '-z']).stdout.split('\0').filter(Boolean).map((record) => {
    const match = /^(\d+) ([a-f0-9]+) 0\t(.+)$/.exec(record)
    if (!match) throw new Error('unmerged or malformed index')
    return { path: match[3], mode: match[1], oid: match[2] }
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}
function plannedIndex(root, plan) {
  const entries = git(root, ['ls-tree', '-r', '-z', plan.baseHead]).stdout.split('\0').filter(Boolean).map((record) => {
    const match = /^(100644|100755) blob ([a-f0-9]+)\t(.+)$/.exec(record)
    if (!match) throw new Error('unsupported base tree entry')
    return { path: match[3], mode: match[1], oid: match[2] }
  })
  const byPath = new Map(entries.map((e) => [e.path, e]))
  for (const entry of plan.writes) byPath.set(entry.path, { path: entry.path, mode: entry.after.mode, oid: git(root, ['hash-object', '--stdin', '--no-filters'], { input: Buffer.from(entry.content, 'base64') }).stdout.trim() })
  return [...byPath.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}
function verifyCommit(root, plan, commit, tree) {
  if (!/^[a-f0-9]{40,64}$/.test(commit) || text(root, ['show', '-s', '--format=%P', commit]) !== plan.baseHead || text(root, ['show', '-s', '--format=%T', commit]) !== tree || text(root, ['show', '-s', '--format=%B', commit]) !== plan.message) throw new Error('commit parent/tree/message mismatch')
}
export function applySavedUpgrade({ project, planFile, confirm }) {
  requireDurableHost()
  project = canonicalProject(project)
  const root = checkProject(project)
  return lease(root, () => {
    const plan = loadPlan(root, planFile)
    if (confirm !== plan.digest) throw new Error('exact plan confirmation required')
    clean(root)
    liveBindings(root, plan, 0)
    if (!same(allowedPaths(project), plan.migration.allowedWrites) || path.basename(project.configPath) !== plan.configPath) throw new Error('project binding changed')
    const id = plan.digest.slice(7)
    privateDirectory(root, `${PRIVATE}/operations`)
    const operation = operationDirectory(root, id)
    fs.mkdirSync(operation) // A prior attempt consumes this plan, even if interrupted.
    syncDirectory(path.dirname(operation))
    privateDirectory(root, `${PRIVATE}/operations/${id}/events`)
    privateDirectory(root, `${PRIVATE}/operations/${id}/backups`)
    append(root, plan, 'accepted', { expected: plan.digest, observed: 'manual content selection; local recovery only' })
    try {
      const baseIndex = indexManifest(root)
      for (const [i, entry] of plan.writes.entries()) {
        liveBindings(root, plan, i)
        if (!same(indexManifest(root), baseIndex)) throw new Error('index changed before staging')
        if (entry.before) publish(path.join(operation, 'backups', `${i}.bin`), readBytes(contained(root, entry.path)))
        append(root, plan, 'write-intent', { step: entry.path, expected: hashObject({ before: entry.before, after: entry.after }) })
        replaceExpected(root, entry)
        append(root, plan, 'write-complete', { step: entry.path, observed: entry.after.digest })
      }
      liveBindings(root, plan, plan.writes.length)
      validateUpgradeDocument('lock', readJson(path.join(root, 'atelier.lock.json')))
      boundaryCheck(project)
      const expectedIndex = plannedIndex(root, plan)
      if (!same(indexManifest(root), baseIndex)) throw new Error('index changed before staging')
      append(root, plan, 'stage-intent', { expected: hashObject(expectedIndex) })
      // Literal, concrete paths only. Explicitly planned ignored outputs are
      // admitted here; no stage-all, glob expansion or implicit authored files.
      for (const entry of plan.writes) git(root, ['add', '-f', '--', entry.path])
      if (!same(indexManifest(root), expectedIndex)) throw new Error('staged blobs differ from saved plan')
      liveBindings(root, plan, plan.writes.length)
      boundaryCheck(project, true)
      const tree = text(root, ['write-tree'])
      append(root, plan, 'commit-intent', { expected: tree })
      const result = git(root, ['commit', '-m', plan.message], { allowFailure: true, timeout: 30_000 })
      const head = text(root, ['rev-parse', 'HEAD'])
      const unchanged = same(indexManifest(root), expectedIndex) && same(snapshot(root), expectedSnapshot(plan, plan.writes.length))
      if (!result.ok) {
        append(root, plan, head === plan.baseHead && unchanged && !result.error && !result.signal ? 'commit-refused' : 'recovery-required', { expected: tree, observed: `Git exit ${result.status}; ${result.error || result.stderr}` })
        return { ok: false, operationId: id, status: events(root, id).at(-1).phase }
      }
      if (!unchanged || text(root, ['symbolic-ref', 'HEAD']) !== plan.branch) throw new Error('hook changed unreviewed state')
      verifyCommit(root, plan, head, tree)
      // Hooks may alter policy, their own bytes, or configuration too.
      if (!same(gitEvidence(root), Object.fromEntries(['gitDigest', 'gitConfigDigest', 'gitAuxDigest', 'hooksPath', 'hooksDigest'].map((k) => [k, plan[k]])))) throw new Error('hook or Git configuration changed during commit')
      clean(root)
      append(root, plan, 'completed', { expected: tree, observed: head })
      return { ok: true, operationId: id, status: 'completed', commit: head, activated: false, lockSuccessMetadata: 'historical; terminal receipt is authoritative' }
    } catch (error) {
      // Never reset user files or retry a commit. A failing journal write
      // remains a nonterminal/broken chain and status refuses success.
      if (!['completed', 'commit-refused', 'recovery-required'].includes(events(root, id).at(-1)?.phase)) append(root, plan, 'recovery-required', { observed: error.message })
      return { ok: false, operationId: id, status: 'recovery-required', reason: error.message }
    }
  })
}
export function upgradeOperationStatus({ project, operationId }) {
  const root = fs.realpathSync(project.configDir)
  privateRoot(root)
  const plan = loadPlan(root, path.join(root, PRIVATE, 'plans', `${operationId}.json`))
  const chain = events(root, operationId)
  const last = chain.at(-1)
  const phase = ['completed', 'commit-refused', 'recovery-required'].includes(last?.phase) ? last.phase : 'recovery-required'
  if (phase === 'completed') verifyCommit(root, plan, last.observed, last.expected)
  return { ok: phase === 'completed', operationId, status: phase, lastEvent: last ?? null, events: chain.length, activated: false, recoveryCoverage: 'local-only', lockSuccessMetadata: 'historical; terminal receipt is authoritative', writerLeasePresent: fs.existsSync(path.join(root, PRIVATE, 'writer')) }
}
export function recoverUpgradeDryRun({ project, operationId }) {
  const root = fs.realpathSync(project.configDir)
  const status = upgradeOperationStatus({ project, operationId })
  const plan = loadPlan(root, path.join(root, PRIVATE, 'plans', `${operationId}.json`))
  const chain = events(root, operationId)
  const head = text(root, ['rev-parse', 'HEAD'])
  const index = indexManifest(root)
  const planned = plannedIndex(root, plan)
  const base = plannedIndex(root, { ...plan, writes: [] })
  const entries = plan.writes.map((entry, i) => {
    const current = fileState(contained(root, entry.path))
    const began = chain.some((e) => e.phase === 'write-intent' && e.step === entry.path)
    const backup = path.join(operationDirectory(root, operationId), 'backups', `${i}.bin`)
    const validBackup = !entry.before || (fs.existsSync(backup) && hashBytes(readBytes(backup)) === entry.before.digest)
    const staged = index.find((e) => e.path === entry.path)
    const stagedExpected = planned.find((e) => e.path === entry.path)
    const safe = began && head === plan.baseHead && same(current, entry.after) && validBackup && (same(staged ?? null, stagedExpected ?? null) || same(staged ?? null, base.find((e) => e.path === entry.path) ?? null))
    return { path: entry.path, state: same(current, entry.before) ? 'already-original' : safe ? 'restorable-after-new-confirmation' : 'conflict', restore: safe ? entry.before ? 'backup' : 'remove-created-file' : null }
  })
  const current = snapshot(root)
  const knownWrites = new Set(plan.writes.map((w) => w.path))
  const observedPaths = new Set([...current, ...plan.readSet].map((e) => e.path))
  const unexpected = [...observedPaths].filter((file) => !knownWrites.has(file) && !same(current.find((e) => e.path === file)?.state ?? null, plan.readSet.find((e) => e.path === file)?.state ?? null))
  const proposal = { operationId, status: status.status, head, indexDigest: hashObject(index), entries, unexpected, mutation: false, requiresNewConfirmation: true }
  return { ...proposal, digest: hashObject(proposal), note: head === plan.baseHead ? 'No files or index entries restored. Review conflicts and exact current state before a separately authorized recovery.' : 'HEAD moved; preserve committed history. No automatic reset or rollback is offered.' }
}
