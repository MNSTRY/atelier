import { execFileSync, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { buildGraph } from '../graph/graph.mjs'
import { buildProjectProjection } from '../projection/project.mjs'
import { buildReadiness } from '../readiness/readiness.mjs'
import { validateJsonSchema } from '../export/atelier-export-contract.mjs'
import {
  commandProject,
  firstString,
  parseArgs,
  readJson,
  resolvePathValue,
  writeJson,
} from '../project/config.mjs'
import { packageRootFrom } from '../project/package-root.mjs'
import {
  BOUNDARY_POLICY_SCHEMA,
  checkBoundaryPolicy,
  installBoundaryHooks,
  loadBoundaryPolicy,
} from '../boundary/policy.mjs'
import { bundledMnstryReadinessPackV1 } from '../readiness-protocols/bundled-pack.mjs'
import { loadExtensionPacks } from '../extension-packs/loader.mjs'

export const ATELIER_LOCK_SCHEMA = 'mnstry.atelier-lock@v1'
export const ATELIER_MIGRATION_SCHEMA = 'mnstry.atelier-migration@v1'
export const LOCK_FILE = 'atelier.lock.json'
export const MIGRATION_CLASSES = new Set([
  'generated_refresh',
  'config_schema',
  'hook_update',
  'template_scaffold',
  'extension_pack',
  'semantic_review',
  'breaking',
])

const packageRoot = packageRootFrom(import.meta.url)
const packageJson = readJson(path.join(packageRoot, 'package.json'))
const lockSchema = readJson(path.join(packageRoot, 'contracts', 'atelier-lock.v1.schema.json'))
const REVIEW_MARKER_RE = /(Atelier-Boundary-Review|boundary-review)\s*:\s*(approved|reviewed)/i
const SEMANTIC_FIELD_RE = /(^|["'\s.-])(kg[.]audience|audience|handling|sensitivity|data_boundary)(["'\s:.-]|$)/i
const FORBIDDEN_AUTHORITY_FLAGS = [
  'telemetry',
  'egress',
  'sendPath',
  'runtimeMutation',
  'runtimeImport',
  'runtimeApply',
  'analysisExecution',
  'hiddenProvider',
]

const normalize = (value) => String(value ?? '').replaceAll('\\', '/').replace(/^\.\/+/, '')
const asArray = (value) => (Array.isArray(value) ? value : [])
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value)

function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
}

function git(root, args, { allowFail = true } = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (!allowFail && result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`)
  return result.status === 0 ? result.stdout.trim() : null
}

function packageGitRoot() {
  const root = git(packageRoot, ['rev-parse', '--show-toplevel'])
  return root && path.resolve(root) === path.resolve(packageRoot) ? root : null
}

function packageGitSha() {
  return packageGitRoot() ? git(packageRoot, ['rev-parse', 'HEAD']) || null : null
}

function packageSource() {
  const gitSha = packageGitSha()
  const repository = packageGitRoot()
    ? git(packageRoot, ['config', '--get', 'remote.origin.url']) || packageJson.repository?.url || null
    : packageJson.repository?.url || null
  if (repository && gitSha) return { type: 'git', repository, gitSha }
  if (repository) return { type: 'private_github', repository, gitSha: null }
  return {
    type: 'local_path',
    path: '.',
    gitSha,
    repository,
  }
}

export function lockPathForProject(project) {
  return path.join(project.configDir, LOCK_FILE)
}

function readOptionalJson(file) {
  if (!fs.existsSync(file)) return null
  return readJson(file)
}

function safeRead(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function loadPolicyForLock(project) {
  const loaded = loadBoundaryPolicy(project)
  if (!loaded.ok) return { policy: null, policyPath: loaded.policyPath, digest: null, errors: loaded.errors }
  return {
    policy: loaded.policy,
    policyPath: loaded.policyPath,
    digest: `sha256:${sha256(`${JSON.stringify(loaded.policy, null, 2)}\n`)}`,
    errors: [],
  }
}

export function buildAtelierLock({ project, templateId = 'existing-workspace', appliedMigrations = [], packs = [] } = {}) {
  const policy = loadPolicyForLock(project)
  return {
    schema: ATELIER_LOCK_SCHEMA,
    generatedAt: new Date().toISOString(),
    package: {
      name: packageJson.name,
      version: packageJson.version,
      source: packageSource(),
    },
    template: {
      id: templateId,
      version: packageJson.version,
    },
    runtime: {
      node: {
        range: packageJson.engines?.node || '>=22.18.0 <23',
      },
      telemetry: 'none',
      egress: 'local-only',
      mutation: 'not-implemented',
      runtimeImport: false,
      analysisExecution: false,
    },
    contracts: {
      projectConfig: 'mnstry.atelier-project-config@v1',
      knowledgeGraph: 'mnstry.atelier-knowledge-graph@v1',
      boundaryPolicy: BOUNDARY_POLICY_SCHEMA,
      exportContract: 'atelier-export@v1',
    },
    // Digest asymmetry, on purpose: the bundled pack is an in-memory object,
    // so its digest covers JSON.stringify of that object; loaded file packs
    // carry raw-byte digests computed by the loader (computePackDigest) over
    // the manifest bytes plus every referenced protocol file's bytes, so any
    // on-disk edit to the manifest or a protocol is visible byte-for-byte.
    extensionPacks: [
      {
        id: bundledMnstryReadinessPackV1.id,
        version: bundledMnstryReadinessPackV1.version,
        digest: `sha256:${sha256(bundledMnstryReadinessPackV1)}`,
      },
      ...packs.map((pack) => ({ id: pack.id, version: pack.version, digest: pack.digest })),
    ],
    boundaryPolicy: {
      path: policy.policyPath ? path.relative(project.configDir, policy.policyPath) : null,
      digest: policy.digest,
      snapshot: policy.policy,
    },
    lastSuccessfulUpgrade: null,
    appliedMigrations,
  }
}

export function writeAtelierLock({ project, templateId = 'existing-workspace' } = {}) {
  const lockPath = lockPathForProject(project)
  // Packs load in throwing mode on purpose: a broken extension pack cannot be
  // locked. Lock verification is disabled for this one load so re-pinning is
  // not blocked by the very drift it records; the previous lock is never
  // moved or set aside, so it exists at every observable point, and writeJson
  // replaces it atomically (temp file + renameSync). A load failure throws
  // before any write and leaves the previous lock untouched.
  const { packs } = loadExtensionPacks(project, { verifyLock: false })
  const lock = buildAtelierLock({ project, templateId, packs })
  writeJson(lockPath, lock)
  return lock
}

export function loadAtelierLock(project) {
  const lockPath = lockPathForProject(project)
  return { lockPath, lock: readOptionalJson(lockPath) }
}

export function validateMigrationRecord(migration) {
  const errors = []
  if (!isObject(migration)) return ['migration must be an object']
  if (migration.schema !== ATELIER_MIGRATION_SCHEMA) errors.push(`schema must be ${ATELIER_MIGRATION_SCHEMA}`)
  if (!firstString(migration.id)) errors.push('id is required')
  if (!MIGRATION_CLASSES.has(migration.class)) errors.push('class is invalid')
  if (!firstString(migration.title)) errors.push('title is required')
  if (!firstString(migration.description)) errors.push('description is required')
  if (!Array.isArray(migration.files)) errors.push('files must be a list')
  if (!Array.isArray(migration.requiredPostChecks)) errors.push('requiredPostChecks must be a list')
  for (const flag of FORBIDDEN_AUTHORITY_FLAGS) {
    if (migration.authority?.[flag] === true) errors.push(`migration authority.${flag} must not be true`)
  }
  if (migration.class === 'breaking' && migration.explicitConfirmationRequired !== true) {
    errors.push('breaking migrations require explicitConfirmationRequired true')
  }
  return errors
}

export const BASE_MIGRATIONS = [
  {
    schema: ATELIER_MIGRATION_SCHEMA,
    id: 'atelier-lock-create@0.1.0-alpha.0',
    from: '*',
    to: packageJson.version,
    class: 'config_schema',
    title: 'Create Atelier lockfile',
    description: 'Record the installed package, template, contract versions, and boundary policy digest.',
    files: [LOCK_FILE],
    safety: 'safe',
    reviewMarkerRequired: false,
    explicitConfirmationRequired: false,
    apply: 'writeLock',
    requiredPostChecks: ['lock check'],
    authority: safeAuthority(),
  },
  {
    schema: ATELIER_MIGRATION_SCHEMA,
    id: 'generated-refresh@0.1.0-alpha.0',
    from: '*',
    to: packageJson.version,
    class: 'generated_refresh',
    title: 'Refresh generated Atelier read models',
    description: 'Regenerate graph, projection, manifest, and readiness artifacts from source files.',
    files: ['knowledge graph output', 'project projection output', 'readiness output'],
    safety: 'safe-generated',
    reviewMarkerRequired: false,
    explicitConfirmationRequired: false,
    apply: 'refreshGenerated',
    requiredPostChecks: ['graph --check', 'project --check', 'readiness --check'],
    authority: safeAuthority(),
  },
  {
    schema: ATELIER_MIGRATION_SCHEMA,
    id: 'boundary-hook-update@0.1.0-alpha.0',
    from: '*',
    to: packageJson.version,
    class: 'hook_update',
    title: 'Install or refresh boundary hooks',
    description: 'Install staged boundary guards without overwriting unrelated user hooks.',
    files: ['.git/hooks/pre-commit', '.git/hooks/pre-push'],
    safety: 'guarded-local',
    reviewMarkerRequired: false,
    explicitConfirmationRequired: false,
    apply: 'installBoundaryHooks',
    requiredPostChecks: ['boundary check --staged'],
    authority: safeAuthority(),
  },
  {
    schema: ATELIER_MIGRATION_SCHEMA,
    id: 'template-scaffold@0.1.0-alpha.0',
    from: '*',
    to: packageJson.version,
    class: 'template_scaffold',
    title: 'Add missing upgrade documentation scaffold',
    description: 'Add upgrade guidance only when the target file is absent.',
    files: ['docs/upgrade.md'],
    safety: 'additive',
    reviewMarkerRequired: false,
    explicitConfirmationRequired: false,
    apply: 'templateScaffold',
    requiredPostChecks: ['lock check'],
    authority: safeAuthority(),
  },
  {
    schema: ATELIER_MIGRATION_SCHEMA,
    id: 'extension-pack-sync@0.2.0-alpha.0',
    from: '*',
    to: packageJson.version,
    class: 'extension_pack',
    title: 'Sync extension pack lock entries',
    description: 'Re-verify declared extension packs and record their digests in the lock.',
    files: [LOCK_FILE],
    safety: 'safe',
    reviewMarkerRequired: false,
    explicitConfirmationRequired: false,
    apply: 'syncExtensionPacks',
    requiredPostChecks: ['lock check'],
    authority: safeAuthority(),
  },
  {
    schema: ATELIER_MIGRATION_SCHEMA,
    id: 'boundary-policy-schema-pin@0.1.0-alpha.0',
    from: '*',
    to: packageJson.version,
    class: 'config_schema',
    title: 'Pin boundary policy schema',
    description: 'Verify boundary policies remain on the current MNSTRY Atelier boundary schema.',
    files: ['boundary-policy.v1.json'],
    safety: 'check-only',
    reviewMarkerRequired: false,
    explicitConfirmationRequired: false,
    apply: 'validateBoundarySchema',
    requiredPostChecks: ['boundary check'],
    authority: safeAuthority(),
  },
  {
    schema: ATELIER_MIGRATION_SCHEMA,
    id: 'semantic-review-guard@0.1.0-alpha.0',
    from: '*',
    to: packageJson.version,
    class: 'semantic_review',
    title: 'Verify semantic review markers',
    description: 'Fail closed when staged audience or sensitivity changes lack an approved review marker.',
    files: ['*.md', '*.kg.json'],
    safety: 'semantic-fail-closed',
    reviewMarkerRequired: true,
    explicitConfirmationRequired: false,
    apply: 'semanticReviewCheck',
    requiredPostChecks: ['boundary check --staged'],
    authority: safeAuthority(),
  },
  {
    schema: ATELIER_MIGRATION_SCHEMA,
    id: 'breaking-placeholder@0.1.0-alpha.0',
    from: '<0.1.0-alpha.0',
    to: packageJson.version,
    class: 'breaking',
    title: 'Breaking migration placeholder',
    description: 'Reserved fixture for explicit-confirmation behavior; not selected for current locks.',
    files: [],
    safety: 'breaking',
    reviewMarkerRequired: false,
    explicitConfirmationRequired: true,
    apply: 'none',
    requiredPostChecks: [],
    authority: safeAuthority(),
    active: false,
  },
]

function safeAuthority() {
  return {
    telemetry: false,
    egress: false,
    sendPath: false,
    runtimeMutation: false,
    runtimeImport: false,
    runtimeApply: false,
    analysisExecution: false,
    hiddenProvider: false,
  }
}

function validateMigrationRegistry(migrations = BASE_MIGRATIONS) {
  return migrations.flatMap((migration) => validateMigrationRecord(migration).map((message) => `${migration.id ?? '(unknown migration)'}: ${message}`))
}

function currentState(project) {
  const { lock, lockPath } = loadAtelierLock(project)
  const loadedPolicy = loadBoundaryPolicy(project)
  const boundaryReport = loadedPolicy.ok ? checkBoundaryPolicy({ project, policy: loadedPolicy.policy, staged: true }) : null
  const gitStatus = projectGitStatus(project)
  return { lock, lockPath, loadedPolicy, boundaryReport, gitStatus }
}

function selectedMigrations({ lock, migrations = BASE_MIGRATIONS } = {}) {
  const selected = []
  if (!lock) {
    selected.push(migrations.find((migration) => migration.id.startsWith('atelier-lock-create@')))
    selected.push(migrations.find((migration) => migration.id.startsWith('generated-refresh@')))
    return selected.filter(Boolean)
  }
  if (lock.package?.version !== packageJson.version || lock.package?.name !== packageJson.name) {
    selected.push(...migrations.filter((migration) => migration.active !== false && ['generated_refresh', 'hook_update', 'template_scaffold', 'config_schema', 'extension_pack', 'breaking'].includes(migration.class)))
  }
  return selected.filter(Boolean)
}

function weakeningFindings({ lock, currentPolicy }) {
  const findings = []
  const previous = lock?.boundaryPolicy?.snapshot
  if (!previous || !currentPolicy) return findings
  if (previous.mode === 'strict' && currentPolicy.mode !== 'strict') findings.push('boundary policy mode changed from strict to non-strict')
  for (const [repoName, previousRepo] of Object.entries(previous.repos ?? {})) {
    const currentRepo = currentPolicy.repos?.[repoName]
    if (!currentRepo) {
      findings.push(`boundary policy removed repo ${repoName}`)
      continue
    }
    for (const audience of asArray(previousRepo.forbiddenAudiences)) {
      if (!asArray(currentRepo.forbiddenAudiences).includes(audience)) {
        findings.push(`boundary policy removed forbidden audience ${audience} from ${repoName}`)
      }
    }
    if (previousRepo.kind === 'shared' && currentRepo.kind !== 'shared') {
      findings.push(`boundary policy changed ${repoName} from shared to ${currentRepo.kind}`)
    }
  }
  return findings
}

function stagedSemanticFindings(project) {
  const findings = []
  for (const repo of project.repos ?? []) {
    if (!isGitRepo(repo.path)) continue
    const result = spawnSync('git', ['-C', repo.path, 'diff', '--cached', '--unified=0', '--', '*.md', '*.kg.json'], { encoding: 'utf8' })
    if (result.status !== 0 || !result.stdout.trim()) continue
    const diff = result.stdout
    const changedSemantic = diff
      .split('\n')
      .some((line) => /^[+-](?![+-])/.test(line) && SEMANTIC_FIELD_RE.test(line))
    if (changedSemantic && !REVIEW_MARKER_RE.test(diff)) findings.push(`${repo.name}: staged semantic field change needs Atelier-Boundary-Review marker`)
  }
  return findings
}

export function planUpgrade({ project, migrations = BASE_MIGRATIONS, allowDirtyGenerated = false, confirmBreaking = [] } = {}) {
  const state = currentState(project)
  const registryErrors = validateMigrationRegistry(migrations)
  const planned = selectedMigrations({ lock: state.lock, migrations })
  const blockers = []
  const warnings = []
  const requiredConfirmations = []

  blockers.push(...registryErrors)
  if (!state.loadedPolicy.ok) blockers.push(...state.loadedPolicy.errors)
  if (state.boundaryReport && !state.boundaryReport.ok) blockers.push(...state.boundaryReport.errors.map((item) => item.message))
  blockers.push(...weakeningFindings({ lock: state.lock, currentPolicy: state.loadedPolicy.policy }))
  blockers.push(...stagedSemanticFindings(project))

  const dirtyAuthored = state.gitStatus.flatMap((repo) => repo.dirty.filter((item) => !item.generated).map((item) => `${repo.name}/${item.path}`))
  const dirtyGenerated = state.gitStatus.flatMap((repo) => repo.dirty.filter((item) => item.generated).map((item) => `${repo.name}/${item.path}`))
  if (dirtyAuthored.length) blockers.push(`dirty authored files block upgrade apply: ${dirtyAuthored.join(', ')}`)
  if (dirtyGenerated.length && !allowDirtyGenerated) warnings.push(`generated files are dirty; apply requires --allow-dirty-generated: ${dirtyGenerated.join(', ')}`)

  for (const migration of planned) {
    if (migration.class === 'breaking' && !confirmBreaking.includes(migration.id)) {
      requiredConfirmations.push(migration.id)
    }
  }

  return {
    ok: blockers.length === 0,
    schema: 'mnstry.atelier-upgrade-plan@v1',
    generatedAt: new Date().toISOString(),
    package: {
      name: packageJson.name,
      version: packageJson.version,
      gitSha: packageGitSha(),
    },
    lock: {
      path: state.lockPath,
      present: Boolean(state.lock),
      version: state.lock?.package?.version ?? null,
      packageName: state.lock?.package?.name ?? null,
    },
    migrations: planned,
    blockers,
    warnings,
    requiredConfirmations,
    dirty: state.gitStatus,
  }
}

function isGitRepo(repoPath) {
  return Boolean(repoPath && fs.existsSync(path.join(repoPath, '.git')))
}

function projectGitStatus(project) {
  return (project.repos ?? []).map((repo) => {
    if (!isGitRepo(repo.path)) return { name: repo.name, path: repo.path, git: false, dirty: [] }
    const result = spawnSync('git', ['-C', repo.path, 'status', '--porcelain'], { encoding: 'utf8' })
    const dirty = result.status === 0
      ? result.stdout
          .split('\n')
          .map((line) => line.trimEnd())
          .filter(Boolean)
          .map((line) => {
            const rel = normalize(line.slice(3).replace(/^"|"$/g, ''))
            return { path: rel, status: line.slice(0, 2), generated: isGeneratedPath(project, repo, rel) }
          })
      : []
    return { name: repo.name, path: repo.path, git: true, dirty }
  })
}

function isGeneratedPath(project, repo, rel) {
  const generatedRoots = [
    'atelier-output',
    '.mnstry-local',
    relativeInside(repo.path, project.outputRoot),
    relativeInside(repo.path, path.dirname(project.graphPath)),
    relativeInside(repo.path, path.dirname(project.readinessPath)),
  ].filter(Boolean).map(normalize)
  const generatedFiles = [
    relativeInside(repo.path, project.graphPath),
    relativeInside(repo.path, project.readinessPath),
    'knowledge.graph.json',
    'atelier-readiness.json',
    'atelier.manifest.json',
  ].filter(Boolean).map(normalize)
  return generatedFiles.includes(rel) || generatedRoots.some((root) => root && (rel === root || rel.startsWith(`${root}/`)))
}

function relativeInside(root, target) {
  if (!root || !target) return null
  const rel = path.relative(root, target)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel
}

function runGeneratedRefresh(project) {
  const graph = buildGraph(project)
  writeJson(project.graphPath, graph)
  const projection = buildProjectProjection(project)
  fs.mkdirSync(path.dirname(projection.output), { recursive: true })
  fs.writeFileSync(projection.output, projection.html)
  writeJson(path.join(project.outputRoot, 'atelier.manifest.json'), {
    schema: 'mnstry.atelier-manifest@v1',
    generatedAt: 'deterministic',
    graphPath: project.graphPath,
    entry: 'index.html',
    nodes: projection.graph.nodes.map((node) => ({ id: node.id, title: node.title, audience: node.audience, path: node.path })),
  })
  writeJson(project.readinessPath, buildReadiness({ project, graph }))
}

function runTemplateScaffold(project) {
  const docsDir = path.join(project.configDir, 'docs')
  const target = path.join(docsDir, 'upgrade.md')
  if (fs.existsSync(target)) return
  fs.mkdirSync(docsDir, { recursive: true })
  fs.writeFileSync(target, `# Atelier Upgrade\n\nRun \`atelier upgrade --dry-run --project ./atelier.project.json\` before applying upstream Atelier changes.\n`)
}

export function applyMigration(project, migration) {
  if (migration.apply === 'writeLock') {
    writeAtelierLock({ project })
  } else if (migration.apply === 'refreshGenerated') {
    runGeneratedRefresh(project)
  } else if (migration.apply === 'installBoundaryHooks') {
    installBoundaryHooks({ project, force: false })
  } else if (migration.apply === 'templateScaffold') {
    runTemplateScaffold(project)
  } else if (migration.apply === 'validateBoundarySchema') {
    const loaded = loadBoundaryPolicy(project)
    if (!loaded.ok) throw new Error(loaded.errors.join('\n'))
  } else if (migration.apply === 'syncExtensionPacks') {
    // Re-verify declared packs and re-pin their digests. writeAtelierLock
    // loads packs in throwing mode, so a broken pack fails the migration
    // closed instead of being recorded; drifted digests are re-pinned for the
    // 'lock check' post-check.
    writeAtelierLock({ project })
  } else if (migration.apply === 'semanticReviewCheck') {
    const findings = stagedSemanticFindings(project)
    if (findings.length) throw new Error(findings.join('\n'))
  } else if (migration.apply === 'none') {
    // explicit no-op reserved for inactive placeholder migrations
  } else {
    throw new Error(`migration ${migration.id} has unrecognized apply action "${migration.apply}"`)
  }
}

function checkoutBranch(project, branch) {
  const repos = (project.repos ?? []).filter((repo) => isGitRepo(repo.path))
  for (const repo of repos) {
    const current = git(repo.path, ['branch', '--show-current']) || ''
    if (current === branch) continue
    const exists = git(repo.path, ['rev-parse', '--verify', branch])
    if (exists) git(repo.path, ['switch', branch], { allowFail: false })
    else git(repo.path, ['switch', '-c', branch], { allowFail: false })
  }
}

function commitRepos(project, message) {
  for (const repo of project.repos ?? []) {
    if (!isGitRepo(repo.path)) continue
    git(repo.path, ['add', '-A'], { allowFail: false })
    const diff = git(repo.path, ['diff', '--cached', '--name-only'])
    if (!diff) continue
    git(repo.path, ['commit', '--no-verify', '-m', message], { allowFail: false })
  }
}

export function applyUpgrade({ project, branch, allowDirtyGenerated = false, confirmBreaking = [] } = {}) {
  const plan = planUpgrade({ project, allowDirtyGenerated, confirmBreaking })
  const dirtyGeneratedOnly = plan.dirty.every((repo) => repo.dirty.every((item) => item.generated))
  if (!plan.ok) throw new Error(plan.blockers.join('\n'))
  if (!dirtyGeneratedOnly && plan.dirty.some((repo) => repo.dirty.length)) throw new Error('upgrade apply requires clean repos')
  if (plan.requiredConfirmations.length) throw new Error(`breaking migrations require confirmation: ${plan.requiredConfirmations.join(', ')}`)
  if (branch) checkoutBranch(project, branch)
  for (const migration of plan.migrations) applyMigration(project, migration)
  if (!plan.migrations.some((migration) => migration.apply === 'writeLock')) writeAtelierLock({ project })
  const nextLock = loadAtelierLock(project).lock || writeAtelierLock({ project })
  nextLock.lastSuccessfulUpgrade = new Date().toISOString()
  nextLock.appliedMigrations = [
    ...asArray(nextLock.appliedMigrations),
    ...plan.migrations.map((migration) => ({ id: migration.id, hash: sha256(migration), appliedAt: nextLock.lastSuccessfulUpgrade })),
  ]
  writeJson(lockPathForProject(project), nextLock)
  runGeneratedRefresh(project)
  commitRepos(project, `Apply MNSTRY Atelier upgrade ${packageJson.version}`)
  return { ok: true, plan, lock: nextLock }
}

export function checkAtelierLock(project) {
  const { lock, lockPath } = loadAtelierLock(project)
  const errors = []
  if (!lock) errors.push(`lockfile not found: ${lockPath}`)
  if (lock && lock.schema !== ATELIER_LOCK_SCHEMA) errors.push(`lock schema must be ${ATELIER_LOCK_SCHEMA}`)
  if (lock) errors.push(...validateJsonSchema(lockSchema, lock).map((error) => `lock schema ${error}`))
  if (lock && lock.package?.name !== packageJson.name) errors.push(`lock package name ${lock.package?.name} does not match ${packageJson.name}`)
  if (lock && lock.package?.version !== packageJson.version) errors.push(`lock package version ${lock.package?.version} does not match ${packageJson.version}`)
  if (lock && lock.contracts?.boundaryPolicy !== BOUNDARY_POLICY_SCHEMA) errors.push(`lock boundary policy contract must be ${BOUNDARY_POLICY_SCHEMA}`)
  const loadedPolicy = loadPolicyForLock(project)
  if (lock?.boundaryPolicy?.digest && loadedPolicy.digest && lock.boundaryPolicy.digest !== loadedPolicy.digest) {
    errors.push('boundary policy digest has changed; run upgrade --dry-run before applying')
  }
  if (lock) {
    // Pack drift, both directions. The loader treats a declared pack missing
    // from the lock as a warning; lock check turns it into an error.
    const packReport = loadExtensionPacks(project, { report: true })
    for (const item of packReport.errors) {
      errors.push(item.packId ? `extension pack ${item.packId}: ${item.message}` : `extension packs: ${item.message}`)
    }
    const lockPacks = asArray(lock.extensionPacks)
    for (const pack of packReport.packs) {
      const entry = lockPacks.find((item) => item?.id === pack.id)
      if (!entry) {
        errors.push(`extension pack ${pack.id} is not recorded in the lock; run upgrade --dry-run before applying`)
      } else if (entry.version !== pack.version || entry.digest !== pack.digest) {
        errors.push(`extension pack ${pack.id} has drifted from the lock; run upgrade --dry-run before applying`)
      }
    }
    // Declared covers loaded packs, disabled (skipped) packs, and packs whose
    // load failed — those failures are already reported above.
    const declaredIds = new Set([
      ...packReport.packs.map((pack) => pack.id),
      ...packReport.skipped.map((item) => item.packId),
      ...packReport.errors.map((item) => item.packId).filter(Boolean),
    ])
    for (const entry of lockPacks) {
      if (!isObject(entry) || entry.id === bundledMnstryReadinessPackV1.id) continue
      if (!declaredIds.has(entry.id)) {
        errors.push(`lock records extension pack ${entry.id} that is no longer declared; run upgrade --dry-run before applying`)
      }
    }
  }
  return { ok: errors.length === 0, lockPath, errors, lock }
}

export function runLockCommand(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const subcommand = args._[0] || 'check'
  const project = commandProject({ argv })
  if (subcommand === 'write') {
    const lock = writeAtelierLock({ project, templateId: firstString(args.template, args['template-id'], project.config?.template?.id) || 'existing-workspace' })
    console.log(JSON.stringify({ ok: true, path: lockPathForProject(project), lock }, null, 2))
    process.exit(0)
  }
  if (subcommand === 'check') {
    const report = checkAtelierLock(project)
    console.log(JSON.stringify(report, null, 2))
    process.exit(report.ok ? 0 : 1)
  }
  console.error(`Unknown lock command: ${subcommand}`)
  process.exit(1)
}

export function runUpgradeCommand(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const project = commandProject({ argv })
  const confirmBreaking = asArray(args['confirm-breaking']).concat(firstString(args['confirm-breaking']) ? [String(args['confirm-breaking'])] : [])
  const allowDirtyGenerated = Boolean(args['allow-dirty-generated'])
  if (args.check) {
    const report = checkAtelierLock(project)
    console.log(JSON.stringify(report, null, 2))
    process.exit(report.ok ? 0 : 1)
  }
  if (args.apply) {
    try {
      const report = applyUpgrade({
        project,
        branch: firstString(args.branch) || `codex/atelier-upgrade-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`,
        allowDirtyGenerated,
        confirmBreaking,
      })
      console.log(JSON.stringify(report, null, 2))
      process.exit(0)
    } catch (error) {
      console.error(error.message)
      process.exit(1)
    }
  }
  const plan = planUpgrade({ project, allowDirtyGenerated, confirmBreaking })
  console.log(JSON.stringify(plan, null, 2))
  process.exit(plan.blockers.length ? 1 : 0)
}
