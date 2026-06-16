import fs from 'node:fs'
import path from 'node:path'

export const PROJECT_CONFIG_ARG_PREFIX = '--project-config='
export const PROJECT_CONFIG_ENV = 'MNSTRY_ATELIER_PROJECT_CONFIG'
export const PROJECT_CONFIG_SCHEMA = 'mnstry.atelier-project-config@v1'

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

function normalizedRepos(config, configDir, workspaceRoot) {
  const repos = Array.isArray(config.repos) ? config.repos : []
  return repos.map((repo) => {
    const repoPath = resolvePathValue(repo.path, configDir) || resolvePathValue(repo.path, workspaceRoot)
    return {
      ...repo,
      name: firstString(repo.name) || (repoPath ? path.basename(repoPath) : null),
      path: repoPath,
      readBoundary: firstString(repo.readBoundary) || 'team',
    }
  })
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

  return {
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
    repos: normalizedRepos(config, configDir, workspaceRoot),
  }
}

export function commandProject({ argv = process.argv.slice(2), env = process.env, cwd = process.cwd() } = {}) {
  const project = resolveProjectConfig({ argv, env, cwd })
  if (project.schema !== PROJECT_CONFIG_SCHEMA) {
    throw new Error(`project config schema must be ${PROJECT_CONFIG_SCHEMA}`)
  }
  if (!project.repos.length) {
    throw new Error('project config must declare at least one repo')
  }
  return project
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
  errors.push(...unknownKeyErrors(doc, '/', new Set(['schema', 'name', 'roots', 'graph', 'projection', 'alignment', 'runtime', 'boundaries', 'repos'])))
  if (doc.schema !== PROJECT_CONFIG_SCHEMA) errors.push(`schema must be ${PROJECT_CONFIG_SCHEMA}`)

  const roots = asObject(doc.roots)
  const graph = asObject(doc.graph)
  const projection = asObject(doc.projection)
  const alignment = asObject(doc.alignment)
  const runtime = asObject(doc.runtime)
  const boundaries = asObject(doc.boundaries)
  if (doc.roots != null && roots !== doc.roots) errors.push('roots must be an object')
  if (doc.graph != null && graph !== doc.graph) errors.push('graph must be an object')
  if (doc.projection != null && projection !== doc.projection) errors.push('projection must be an object')
  if (doc.alignment != null && alignment !== doc.alignment) errors.push('alignment must be an object')
  if (doc.runtime != null && runtime !== doc.runtime) errors.push('runtime must be an object')
  if (doc.boundaries != null && boundaries !== doc.boundaries) errors.push('boundaries must be an object')
  const hasRepoArray = Array.isArray(doc.repos) && doc.repos.length > 0
  const hasAlignmentScaffold = Boolean(firstString(alignment.appRepo) && firstString(alignment.root, alignment.path))
  if (!hasRepoArray && !hasAlignmentScaffold) errors.push('repos must be a non-empty array or alignment must define appRepo and root')

  errors.push(...unknownKeyErrors(roots, 'roots', new Set(['workspace', 'workspaceRoot', 'repoOps', 'repoOpsRoot'])))
  errors.push(...unknownKeyErrors(graph, 'graph', new Set(['repoAccessPath', 'repoAccessConfig', 'outputPath', 'workspaceGraphPath', 'workspaceGraph', 'externalRelationPrefixes', 'externalRelationIds'])))
  errors.push(...unknownKeyErrors(projection, 'projection', new Set(['outputRoot', 'root', 'readinessPath', 'readiness'])))
  errors.push(...unknownKeyErrors(alignment, 'alignment', new Set(['appRepo', 'appRoot', 'root', 'path'])))
  errors.push(...unknownKeyErrors(runtime, 'runtime', new Set(['root', 'mnstryRuntimeRoot'])))
  errors.push(...unknownKeyErrors(boundaries, 'boundaries', new Set(['policyPath', 'governanceLedgerPath', 'strictNewRepos'])))
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
  if (alignment.appRepo != null && !firstString(alignment.appRepo)) errors.push('alignment.appRepo must be a non-empty string')

  for (const [index, repo] of (Array.isArray(doc.repos) ? doc.repos : []).entries()) {
    if (!repo || typeof repo !== 'object' || Array.isArray(repo)) {
      errors.push(`repos[${index}] must be an object`)
      continue
    }
    errors.push(...unknownKeyErrors(repo, `repos[${index}]`, new Set(['name', 'path', 'readBoundary'])))
    if (!firstString(repo.name)) errors.push(`repos[${index}].name is required`)
    if (!firstString(repo.path)) errors.push(`repos[${index}].path is required`)
    if (repo.readBoundary && !['private', 'team', 'operator', 'staff', 'public'].includes(repo.readBoundary)) {
      errors.push(`repos[${index}].readBoundary is invalid`)
    }
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
