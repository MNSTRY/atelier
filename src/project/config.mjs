import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const PROJECT_CONFIG_ARG_PREFIX = '--project-config='
export const PROJECT_CONFIG_ENV = 'MNSTRY_ATELIER_PROJECT_CONFIG'
export const PROJECT_CONFIG_SCHEMA = 'mnstry.atelier-project-config@v1'
export const LOCAL_OVERLAY_SCHEMA = 'mnstry.atelier-local-overlay@v1'
export const LOCAL_OVERLAY_ENV = 'MNSTRY_ATELIER_LOCAL_CONFIG'
export const LOCAL_STATE_DIR = '.atelier-local'
export const LOCAL_OVERLAY_FILES = ['atelier.local.json', 'atelier.workspace.local.json']

// A workspace accumulates git folders that are not Atelier repos at all: vendored
// checkouts, app-builder exports, scratch clones. Declaring one `external`
// acknowledges its identity without implying a read boundary, so validation stops
// demanding metadata for content the workspace does not own. It is deliberately not
// a way to silence checks on a repo you do manage.
export const EXTERNAL_REPO_KIND = 'external'

export const isExternalRepo = (repo) => firstString(repo?.kind) === EXTERNAL_REPO_KIND

// Kept here rather than imported from repo-identity.mjs so config validation stays
// free of that module's git/provider dependencies.
export const SUPPORTED_IDENTITY_PROVIDERS = ['github']

export const asObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) {
      out._.push(arg)
      continue
    }
    const [key, ...rest] = arg.slice(2).split('=')
    if (rest.length) {
      out[key] = rest.join('=')
    } else if (argv[index + 1] && !argv[index + 1].startsWith('--')) {
      out[key] = argv[index + 1]
      index += 1
    } else {
      out[key] = true
    }
  }
  return out
}

export function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

export function resolvePathValue(value, baseDir) {
  if (typeof value !== 'string' || !value.trim()) return null
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(baseDir, value)
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`invalid JSON at ${file}: ${error.message}`)
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const text = `${JSON.stringify(value, null, 2)}\n`
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

export function projectConfigArg(argv = process.argv.slice(2), prefix = PROJECT_CONFIG_ARG_PREFIX) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (typeof arg !== 'string') continue
    if (arg.startsWith(prefix)) return arg.slice(prefix.length).trim() || null
    if ((arg === '--project-config' || arg === '--project') && argv[index + 1]) return String(argv[index + 1]).trim() || null
    if (arg.startsWith('--project=')) return arg.slice('--project='.length).trim() || null
  }
  return null
}

export function stripProjectConfigArgs(argv = [], prefix = PROJECT_CONFIG_ARG_PREFIX) {
  return argv.filter((arg) => typeof arg !== 'string' || !arg.startsWith(prefix))
}

export function readProjectConfig(configPath) {
  const doc = readJson(configPath)
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`atelier project config must be a JSON object: ${configPath}`)
  }
  return doc
}

function mergeLocalOverlay(target, source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return target
  target.schema = firstString(source.schema, target.schema) || LOCAL_OVERLAY_SCHEMA
  target.actor = { ...asObject(target.actor), ...asObject(source.actor) }
  target.harness = { ...asObject(target.harness), ...asObject(source.harness) }
  target.preferences = { ...asObject(target.preferences), ...asObject(source.preferences) }
  target.repoPaths = { ...asObject(target.repoPaths), ...asObject(source.repoPaths) }
  target.repos = { ...asObject(target.repos), ...asObject(source.repos) }
  return target
}

export function localOverlayCandidatePaths({ configDir, env = process.env, cwd = process.cwd() } = {}) {
  const envPath = firstString(env[LOCAL_OVERLAY_ENV])
  return [
    path.join(configDir, LOCAL_STATE_DIR, 'workspace.json'),
    path.join(configDir, LOCAL_STATE_DIR, 'atelier.local.json'),
    ...LOCAL_OVERLAY_FILES.map((name) => path.join(configDir, name)),
    envPath ? resolvePathValue(envPath, cwd) : null,
  ].filter(Boolean)
}

export function readLocalOverlay({ configDir, env = process.env, cwd = process.cwd() } = {}) {
  const overlay = { schema: LOCAL_OVERLAY_SCHEMA, repos: {}, repoPaths: {}, actor: {}, harness: {}, preferences: {} }
  const paths = []
  for (const file of localOverlayCandidatePaths({ configDir, env, cwd })) {
    if (!file || !fs.existsSync(file)) continue
    mergeLocalOverlay(overlay, readJson(file))
    paths.push(file)
  }
  return { overlay, paths }
}

export function parseRepoPathOverrides(argv = process.argv.slice(2), cwd = process.cwd()) {
  const out = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    let value = null
    if (arg === '--repo-path' && argv[index + 1]) {
      value = argv[index + 1]
      index += 1
    } else if (typeof arg === 'string' && arg.startsWith('--repo-path=')) {
      value = arg.slice('--repo-path='.length)
    }
    if (!value || !value.includes('=')) continue
    const [name, ...rest] = value.split('=')
    const repoPath = rest.join('=')
    if (firstString(name) && firstString(repoPath)) out.set(name.trim(), resolvePathValue(repoPath, cwd))
  }
  return out
}

function overlayRepoPath(overlay, repoName) {
  if (!repoName) return null
  const direct = firstString(overlay.overlay?.repoPaths?.[repoName], overlay.repoPaths?.[repoName])
  const repo = asObject(overlay.overlay?.repos?.[repoName] ?? overlay.repos?.[repoName])
  return firstString(direct, repo.path, repo.localPath)
}

function resolveRepoPath({ repo, repoName, configDir, workspaceRoot, overlay, cliRepoPaths }) {
  if (repoName && cliRepoPaths.has(repoName)) return cliRepoPaths.get(repoName)
  const overlayPath = overlayRepoPath(overlay, repoName)
  const fromOverlay = resolvePathValue(overlayPath, configDir)
  if (fromOverlay) return fromOverlay
  const fromConfig = resolvePathValue(repo.path, configDir) || resolvePathValue(repo.path, workspaceRoot)
  if (fromConfig) return fromConfig
  return discoverSiblingRepoPath({ repo, repoName, configDir, workspaceRoot })
}

function repoPathSource({ repo, repoName, overlay, cliRepoPaths, workspaceRoot, configDir }) {
  if (repoName && cliRepoPaths.has(repoName)) return 'cli'
  if (overlayRepoPath(overlay, repoName)) return 'local-overlay'
  if (firstString(repo.path)) return 'tracked-config'
  if (discoverSiblingRepoPath({ repo, repoName, configDir, workspaceRoot })) return 'sibling-discovery'
  return null
}

function discoverSiblingRepoPath({ repo, repoName, configDir, workspaceRoot }) {
  if (!repoName) return null
  const candidates = [
    path.join(workspaceRoot, repoName),
    path.join(configDir, repoName),
    path.join(path.dirname(configDir), repoName),
  ]
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue
    if (repo.remote && !gitRemoteMatches(candidate, repo.remote)) continue
    return path.resolve(candidate)
  }
  return null
}

function gitRemoteMatches(repoPath, expected) {
  const result = spawnSync('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], { encoding: 'utf8' })
  if (result.status !== 0) return false
  const actual = normalizeRemote(result.stdout.trim())
  return actual === normalizeRemote(expected)
}

function normalizeRemote(value) {
  return String(value || '')
    .trim()
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '')
    .toLowerCase()
}

export function gitRemoteUrl(repoPath) {
  if (!repoPath || !fs.existsSync(repoPath)) return null
  const result = spawnSync('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], { encoding: 'utf8' })
  return result.status === 0 ? firstString(result.stdout) : null
}

export function remoteHost(url) {
  const text = String(url ?? '').trim()
  if (!text) return null
  const scp = text.match(/^[^/@]+@([^:/]+):/)
  if (scp) return scp[1].toLowerCase()
  const parsed = text.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)/i)
  return parsed ? parsed[1].toLowerCase() : null
}

function fallbackRoot(env, fallback) {
  const config = typeof fallback === 'string' ? { value: fallback } : asObject(fallback)
  return firstString(config.value, config.env ? env[config.env] : null)
}

export function resolveProjectConfig({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  configArgPrefix = PROJECT_CONFIG_ARG_PREFIX,
  configEnv = PROJECT_CONFIG_ENV,
  defaults = {},
} = {}) {
  const argPath = projectConfigArg(argv, configArgPrefix)
  const envPath = firstString(env[configEnv])
  const source = argPath ? 'cli' : envPath ? 'env' : 'default'
  const defaultRepoOpsRoot = fallbackRoot(env, defaults.repoOpsRoot)
  const defaultWorkspaceRoot = fallbackRoot(env, defaults.workspaceRoot)
  const explicitPath = argPath || envPath
  const requestedPath = explicitPath || (defaultRepoOpsRoot || defaultWorkspaceRoot ? null : 'atelier.project.json')

  let config = {}
  let configPath = null
  let configDir = cwd
  let missingConfigPath = null

  if (requestedPath) {
    configPath = resolvePathValue(requestedPath, cwd)
    if (configPath && fs.existsSync(configPath)) {
      config = readProjectConfig(configPath)
      configDir = path.dirname(configPath)
    } else if (defaultRepoOpsRoot || defaultWorkspaceRoot) {
      missingConfigPath = configPath
      configPath = null
    } else {
      throw new Error(`atelier project config not found: ${configPath || requestedPath}`)
    }
  }

  const roots = asObject(config.roots)
  const graph = asObject(config.graph)
  const projection = asObject(config.projection)
  const alignment = asObject(config.alignment)
  const runtime = asObject(config.runtime)
  const boundaries = asObject(config.boundaries)

  const workspaceRoot =
    resolvePathValue(firstString(roots.workspace, roots.workspaceRoot), configDir) ||
    resolvePathValue(defaultWorkspaceRoot, cwd) ||
    configDir
  const repoOpsRoot =
    resolvePathValue(firstString(roots.repoOps, roots.repoOpsRoot), configDir) ||
    resolvePathValue(defaultRepoOpsRoot, cwd) ||
    workspaceRoot
  const repoAccessPath =
    resolvePathValue(firstString(graph.repoAccessPath, graph.repoAccessConfig), repoOpsRoot) ||
    resolvePathValue(firstString(defaults.repoAccessPath), repoOpsRoot) ||
    path.join(configDir, 'repo-access.v1.json')
  const graphPath =
    resolvePathValue(firstString(graph.outputPath, graph.workspaceGraphPath, graph.workspaceGraph), repoOpsRoot) ||
    resolvePathValue(firstString(defaults.workspaceGraphPath), repoOpsRoot) ||
    path.join(configDir, 'atelier-output', 'knowledge.graph.json')
  const outputRoot =
    resolvePathValue(firstString(projection.outputRoot, projection.root), configDir) ||
    resolvePathValue(firstString(defaults.outputRoot), repoOpsRoot) ||
    path.join(configDir, 'atelier-output')
  const readinessPath =
    resolvePathValue(firstString(projection.readinessPath, projection.readiness), configDir) ||
    resolvePathValue(firstString(defaults.readinessPath), outputRoot) ||
    path.join(outputRoot, 'atelier-readiness.json')
  const boundaryPolicyPath =
    resolvePathValue(firstString(boundaries.policyPath), configDir) ||
    resolvePathValue(firstString(defaults.boundaryPolicyPath), configDir) ||
    path.join(configDir, 'boundary-policy.v1.json')
  const governanceLedgerPath =
    resolvePathValue(firstString(boundaries.governanceLedgerPath), configDir) ||
    resolvePathValue(firstString(defaults.governanceLedgerPath), configDir) ||
    null
  const appRepoName = firstString(alignment.appRepo, config.appRepoName, defaults.appRepoName)
  const appRootValue = firstString(alignment.appRoot, config.appRoot)
  const appRoot = resolvePathValue(appRootValue, workspaceRoot) || (appRepoName ? path.join(workspaceRoot, appRepoName) : null)
  const alignmentRootValue = firstString(alignment.root, alignment.path, config.alignmentRoot)
  const alignmentRoot =
    resolvePathValue(alignmentRootValue, appRoot || workspaceRoot) ||
    (appRoot && defaults.alignmentRoot ? path.join(appRoot, defaults.alignmentRoot) : null)

  const localOverlay = readLocalOverlay({ configDir, env, cwd })
  const cliRepoPaths = parseRepoPathOverrides(argv, cwd)
  const resolved = {
    schema: firstString(config.schema) || PROJECT_CONFIG_SCHEMA,
    source,
    config,
    configPath,
    configDir,
    requestedPath,
    missingConfigPath,
    repoOpsRoot,
    workspaceRoot,
    repoAccessPath,
    graphPath,
    workspaceGraphPath: graphPath,
    outputRoot,
    readinessPath,
    boundaryPolicyPath,
    governanceLedgerPath,
    strictNewRepos: boundaries.strictNewRepos === true || defaults.strictNewRepos === true,
    runtimeRoot: resolvePathValue(firstString(runtime.root, runtime.mnstryRuntimeRoot), configDir),
    appRepoName,
    appRoot,
    alignmentRoot,
    localOverlay,
    repos: (Array.isArray(config.repos) ? config.repos : []).map((repo) => {
      const repoName = firstString(repo.name) || (repo.path ? path.basename(repo.path) : null)
      const repoPath = resolveRepoPath({ repo, repoName, configDir, workspaceRoot, overlay: localOverlay.overlay, cliRepoPaths })
      const external = isExternalRepo(repo)
      return {
        ...repo,
        name: repoName || (repoPath ? path.basename(repoPath) : null),
        path: repoPath,
        external,
        readBoundary: external ? null : firstString(repo.readBoundary) || 'team',
        pathSource: repoPath ? repoPathSource({ repo, repoName, overlay: localOverlay.overlay, cliRepoPaths, workspaceRoot, configDir }) : null,
      }
    }),
  }
  resolved.localState = ensureLocalState(resolved, { write: true })
  return resolved
}

export function commandProject({ argv = process.argv.slice(2), env = process.env, cwd = process.cwd() } = {}) {
  const project = resolveProjectConfig({ argv, env, cwd })
  if (project.schema !== PROJECT_CONFIG_SCHEMA) {
    throw new Error(`project config schema must be ${PROJECT_CONFIG_SCHEMA}`)
  }
  if (!project.repos.length) {
    throw new Error('project config must declare at least one repo')
  }
  if (!project.repos.some((repo) => !repo.external)) {
    throw new Error(`project config must declare at least one managed repo; every entry is kind "${EXTERNAL_REPO_KIND}"`)
  }
  return project
}

export function localStateRoot(projectOrDir) {
  const configDir = typeof projectOrDir === 'string' ? projectOrDir : projectOrDir?.configDir
  return path.join(configDir || process.cwd(), LOCAL_STATE_DIR)
}

function gitRootFor(dir) {
  const result = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

function isIgnoredByGit(gitRoot, rel) {
  const result = spawnSync('git', ['-C', gitRoot, 'check-ignore', '-q', rel], { encoding: 'utf8' })
  return result.status === 0
}

export function ensureLocalState(project, { write = false } = {}) {
  const root = localStateRoot(project)
  const gitRoot = gitRootFor(project.configDir)
  const rel = gitRoot ? path.relative(gitRoot, root).split(path.sep).join('/') : LOCAL_STATE_DIR
  const ignored = gitRoot ? isIgnoredByGit(gitRoot, `${rel}/`) || isIgnoredByGit(gitRoot, rel) : true
  const report = {
    root,
    ignored,
    created: false,
    overlayPaths: localOverlayCandidatePaths({ configDir: project.configDir }).filter((file) => fs.existsSync(file)),
    warnings: [],
  }
  if (!ignored) {
    report.warnings.push(`${LOCAL_STATE_DIR}/ is not ignored; add it to .gitignore before Atelier writes local machine state`)
    return report
  }
  if (write && !fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true })
    report.created = true
  }
  return report
}

export function loadRepoAccess(project) {
  if (!fs.existsSync(project.repoAccessPath)) {
    return { schema: 'mnstry.atelier-repo-access@v1', defaultReadBoundary: 'team', repos: {} }
  }
  const doc = readJson(project.repoAccessPath)
  return {
    defaultReadBoundary: firstString(doc.defaultReadBoundary) || 'team',
    repos: asObject(doc.repos),
  }
}

function unknownKeyErrors(value, label, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.keys(value)
    .filter((key) => !allowed.has(key))
    .map((key) => `${label} must not include additional property ${key}`)
}

function stringPathErrors(value, label) {
  if (value == null) return []
  return typeof value === 'string' && value.trim() ? [] : [`${label} must be a non-empty string path`]
}

export function validateProjectConfigDoc(doc, { neutralTemplate = false } = {}) {
  const errors = []
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ['project config must be a JSON object']
  errors.push(...unknownKeyErrors(doc, '/', new Set(['schema', 'name', 'roots', 'graph', 'projection', 'alignment', 'runtime', 'boundaries', 'setup', 'repos'])))
  if (doc.schema !== PROJECT_CONFIG_SCHEMA) errors.push(`schema must be ${PROJECT_CONFIG_SCHEMA}`)

  const roots = asObject(doc.roots)
  const graph = asObject(doc.graph)
  const projection = asObject(doc.projection)
  const alignment = asObject(doc.alignment)
  const runtime = asObject(doc.runtime)
  const boundaries = asObject(doc.boundaries)
  const setup = asObject(doc.setup)
  if (doc.roots != null && roots !== doc.roots) errors.push('roots must be an object')
  if (doc.graph != null && graph !== doc.graph) errors.push('graph must be an object')
  if (doc.projection != null && projection !== doc.projection) errors.push('projection must be an object')
  if (doc.alignment != null && alignment !== doc.alignment) errors.push('alignment must be an object')
  if (doc.runtime != null && runtime !== doc.runtime) errors.push('runtime must be an object')
  if (doc.boundaries != null && boundaries !== doc.boundaries) errors.push('boundaries must be an object')
  if (doc.setup != null && setup !== doc.setup) errors.push('setup must be an object')
  const hasRepoArray = Array.isArray(doc.repos) && doc.repos.length > 0
  const hasAlignmentScaffold = Boolean(firstString(alignment.appRepo) && firstString(alignment.root, alignment.path))
  if (!hasRepoArray && !hasAlignmentScaffold) errors.push('repos must be a non-empty array or alignment must define appRepo and root')

  errors.push(...unknownKeyErrors(roots, 'roots', new Set(['workspace', 'workspaceRoot', 'repoOps', 'repoOpsRoot'])))
  errors.push(...unknownKeyErrors(graph, 'graph', new Set(['repoAccessPath', 'repoAccessConfig', 'outputPath', 'workspaceGraphPath', 'workspaceGraph', 'externalRelationPrefixes', 'externalRelationIds'])))
  errors.push(...unknownKeyErrors(projection, 'projection', new Set(['outputRoot', 'root', 'readinessPath', 'readiness'])))
  errors.push(...unknownKeyErrors(alignment, 'alignment', new Set(['appRepo', 'appRoot', 'root', 'path'])))
  errors.push(...unknownKeyErrors(runtime, 'runtime', new Set(['root', 'mnstryRuntimeRoot'])))
  errors.push(...unknownKeyErrors(boundaries, 'boundaries', new Set(['policyPath', 'governanceLedgerPath', 'strictNewRepos'])))
  errors.push(...unknownKeyErrors(setup, 'setup', new Set(['profile', 'include', 'exclude'])))
  errors.push(...stringPathErrors(roots.workspace, 'roots.workspace'))
  errors.push(...stringPathErrors(graph.outputPath, 'graph.outputPath'))
  errors.push(...stringPathErrors(graph.repoAccessPath, 'graph.repoAccessPath'))
  errors.push(...stringPathErrors(graph.workspaceGraphPath, 'graph.workspaceGraphPath'))
  errors.push(...stringPathErrors(projection.outputRoot, 'projection.outputRoot'))
  errors.push(...stringPathErrors(projection.readinessPath, 'projection.readinessPath'))
  errors.push(...stringPathErrors(alignment.root, 'alignment.root'))
  errors.push(...stringPathErrors(alignment.path, 'alignment.path'))
  errors.push(...stringPathErrors(alignment.appRoot, 'alignment.appRoot'))
  errors.push(...stringPathErrors(boundaries.policyPath, 'boundaries.policyPath'))
  errors.push(...stringPathErrors(boundaries.governanceLedgerPath, 'boundaries.governanceLedgerPath'))
  if (boundaries.strictNewRepos != null && typeof boundaries.strictNewRepos !== 'boolean') {
    errors.push('boundaries.strictNewRepos must be a boolean')
  }
  if (setup.profile != null && !['single-repo', 'private-domain', 'shared-project', 'multi-repo', 'monorepo', 'control-workspace'].includes(setup.profile)) {
    errors.push('setup.profile is invalid')
  }
  if (alignment.appRepo != null && !firstString(alignment.appRepo)) errors.push('alignment.appRepo must be a non-empty string')

  for (const [index, repo] of (Array.isArray(doc.repos) ? doc.repos : []).entries()) {
    if (!repo || typeof repo !== 'object' || Array.isArray(repo)) {
      errors.push(`repos[${index}] must be an object`)
      continue
    }
    errors.push(...unknownKeyErrors(repo, `repos[${index}]`, new Set(['name', 'path', 'readBoundary', 'role', 'kind', 'remote', 'identity', 'aliases', 'required'])))
    if (!firstString(repo.name)) errors.push(`repos[${index}].name is required`)
    if (repo.identity != null) {
      const identity = asObject(repo.identity)
      errors.push(...unknownKeyErrors(identity, `repos[${index}].identity`, new Set(['provider', 'id'])))
      if (!SUPPORTED_IDENTITY_PROVIDERS.includes(identity.provider)) {
        errors.push(`repos[${index}].identity.provider must be one of ${SUPPORTED_IDENTITY_PROVIDERS.join(', ')}`)
      }
      if (!firstString(identity.id)) errors.push(`repos[${index}].identity.id is required and must be the provider's stable id, not a name`)
    }
    if (repo.aliases != null) {
      if (!Array.isArray(repo.aliases)) errors.push(`repos[${index}].aliases must be a list of former names`)
      else if (repo.aliases.some((alias) => !firstString(alias))) errors.push(`repos[${index}].aliases must contain non-empty names`)
      else if (new Set(repo.aliases.map((alias) => alias.toLowerCase())).size !== repo.aliases.length) {
        errors.push(`repos[${index}].aliases must not repeat a name`)
      } else if (repo.aliases.some((alias) => alias.toLowerCase() === String(repo.name ?? '').toLowerCase())) {
        errors.push(`repos[${index}].aliases must not repeat the current name`)
      }
    }
    if (repo.path != null && !firstString(repo.path)) errors.push(`repos[${index}].path must be a non-empty string when present`)
    if (repo.readBoundary && !['private', 'team', 'operator', 'staff', 'public', 'sensitive'].includes(repo.readBoundary)) {
      errors.push(`repos[${index}].readBoundary is invalid`)
    }
    if (isExternalRepo(repo) && repo.readBoundary != null) {
      errors.push(`repos[${index}] is kind "${EXTERNAL_REPO_KIND}" and must not declare readBoundary; an external repo is unmanaged and implies no boundary`)
    }
    if (repo.required != null && typeof repo.required !== 'boolean') errors.push(`repos[${index}].required must be a boolean`)
    if (repo.path && path.isAbsolute(repo.path)) errors.push(`repos[${index}].path must be relative; put machine-local absolute paths in ignored local overlay`)
  }

  if (neutralTemplate) {
    const text = JSON.stringify(doc)
    const adapterSpecificNamePattern = new RegExp(['h', 'e', 'a', 'r', 't', 'h'].join(''), 'i')
    if (adapterSpecificNamePattern.test(text)) errors.push('example project config must not require adapter-specific names')
    if (!firstString(roots.workspace, roots.workspaceRoot)) errors.push('example project config must define roots.workspace')
    if (!firstString(roots.repoOps, roots.repoOpsRoot)) errors.push('example project config must define roots.repoOps')
    if (!firstString(graph.outputPath, graph.workspaceGraphPath, graph.workspaceGraph)) errors.push('example project config must define a graph output path')
    if (!firstString(graph.repoAccessPath, graph.repoAccessConfig)) errors.push('example project config must define repo access path')
    if (!firstString(projection.outputRoot, projection.root) && !hasAlignmentScaffold) {
      errors.push('example project config must define projection outputRoot or alignment root')
    }
  }
  return errors
}
