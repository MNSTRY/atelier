import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { buildGraph } from '../graph/graph.mjs'
import { commandProject, firstString, parseArgs, readJson, resolvePathValue, writeJson } from '../project/config.mjs'
import { matchesPathPattern } from '../project/path-match.mjs'
import {
  diffForPushRange,
  parseAddedContent,
  parsePushRefUpdates,
  resolveContentRules,
  scanAddedContent,
  scanTree,
  stagedDiff,
  validateContentRuleExceptions,
  validateContentRules,
} from './content-rules.mjs'

export const BOUNDARY_POLICY_SCHEMA = 'mnstry.atelier-boundary-policy@v1'
export const PROMOTE_EVENT_SCHEMA = 'mnstry.git-promote-event@v1'
export const VALID_BOUNDARY_MODES = new Set(['strict', 'legacy-warning'])
export const VALID_REPO_KINDS = new Set(['private_domain', 'shared', 'generated', 'archive'])
export const VALID_AUDIENCES = new Set(['private', 'team', 'operator', 'staff', 'public', 'sensitive'])
export const VALID_AUTOCOMMIT = new Set(['allowed', 'blocked', 'guarded'])
export const PRIVATE_AUDIENCES = new Set(['private', 'sensitive'])

export const DEFAULT_FORBIDDEN_PATHS = [
  '.atelier-local',
  '.atelier-local/**',
  'atelier.local.json',
  'atelier.workspace.local.json',
  '.mnstry-local',
  '.mnstry-local/**',
  '.atelier-proposals',
  '.atelier-proposals/**',
  '.atelier-current',
  '.atelier-current.json',
  '.atelier-presence.json',
  '.atelier-nonce',
  '.atelier-capability-grants.json',
  '.atelier-events.jsonl',
  '.atelier-audit.jsonl',
  '.atelier-session.json',
  '.atelier-session.jsonl',
  '.atelier-sessions/**',
  '.atelier-support',
  '.atelier-support/**',
  'support-bundle',
  'support-bundle/**',
  'support-bundles/**',
  'support-bundle.*',
  '*support-bundle*',
  'transcripts/**',
  '**/transcripts/**',
  'prompts/**',
  '**/prompts/**',
]

const SEMANTIC_FIELD_RE = /(^|["'\s.-])(kg[.]audience|audience|handling|sensitivity|data_boundary)(["'\s:.-]|$)/i
const SEMANTIC_ASSIGNMENT_RE = /(?:^|[^\w.])["']?(kg\.audience|audience|handling|sensitivity|data_boundary)["']?\s*:\s*(.*)$/i
const REVIEW_MARKER_RE = /(Atelier-Boundary-Review|boundary-review)\s*:\s*(approved|reviewed)/i

// Initializing a boundary field to a value that discloses nothing is not a disclosure
// decision, so the gate lets it through unreviewed. Widening, narrowing, or removing an
// existing value still needs a human. Keeping this in sync with the fail-closed default
// written by generatedFrontmatter() is what stops the kit's own apply tooling from
// producing changes the kit's own gate refuses.
export const SEMANTIC_INITIALIZATION_DEFAULTS = Object.freeze({
  audience: Object.freeze([...PRIVATE_AUDIENCES].sort()),
})

const managedRepos = (project) => (project?.repos ?? []).filter((repo) => !repo.external)

const normalize = (value) => String(value ?? '').replaceAll('\\', '/').replace(/^\.\/+/, '')
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value)
const asArray = (value) => (Array.isArray(value) ? value : [])
const unique = (values) => [...new Set(values.filter(Boolean))]

export function projectBoundaryPolicyPath(project) {
  const boundaries = project.config?.boundaries && typeof project.config.boundaries === 'object' ? project.config.boundaries : {}
  return (
    resolvePathValue(firstString(boundaries.policyPath), project.configDir) ||
    resolvePathValue(firstString(project.config?.boundaryPolicyPath), project.configDir) ||
    path.join(project.configDir, 'boundary-policy.v1.json')
  )
}

export function projectGovernanceLedgerPath(project, policy = null) {
  const boundaries = project.config?.boundaries && typeof project.config.boundaries === 'object' ? project.config.boundaries : {}
  return (
    resolvePathValue(firstString(boundaries.governanceLedgerPath), project.configDir) ||
    resolvePathValue(firstString(policy?.governanceLedgerPath), project.configDir) ||
    null
  )
}

export function loadBoundaryPolicy(project, policyPath = projectBoundaryPolicyPath(project)) {
  if (!fs.existsSync(policyPath)) {
    return { ok: false, policy: null, policyPath, errors: [`boundary policy not found: ${policyPath}`] }
  }
  try {
    return { ok: true, policy: readJson(policyPath), policyPath, errors: [] }
  } catch (error) {
    return { ok: false, policy: null, policyPath, errors: [error.message] }
  }
}

function unknownKeys(value, label, allowed) {
  if (!isObject(value)) return []
  return Object.keys(value)
    .filter((key) => !allowed.has(key))
    .map((key) => `${label} must not include additional property ${key}`)
}

function validAudienceList(value, label, required = false) {
  if (value == null && !required) return []
  if (!Array.isArray(value)) return [`${label} must be a list`]
  const errors = []
  for (const item of value) {
    if (!VALID_AUDIENCES.has(item)) errors.push(`${label} contains invalid audience ${item}`)
  }
  return errors
}

export function validateBoundaryPolicy(policy, project = null) {
  const errors = []
  if (!isObject(policy)) return ['boundary policy must be a JSON object']
  errors.push(...unknownKeys(policy, '/', new Set(['schema', 'mode', 'actors', 'repos', 'promotion', 'forbiddenPaths', 'contentRules', 'contentRuleExceptions', 'governanceLedgerPath'])))
  if (policy.schema !== BOUNDARY_POLICY_SCHEMA) errors.push(`schema must be ${BOUNDARY_POLICY_SCHEMA}`)
  if (!VALID_BOUNDARY_MODES.has(policy.mode)) errors.push('mode must be strict or legacy-warning')

  const actors = policy.actors
  const repos = policy.repos
  const promotion = isObject(policy.promotion) ? policy.promotion : {}
  if (!isObject(actors)) errors.push('actors must be an object')
  if (!isObject(repos)) errors.push('repos must be an object')
  if (policy.promotion != null && !isObject(policy.promotion)) errors.push('promotion must be an object')
  errors.push(...unknownKeys(promotion, 'promotion', new Set(['requiresGitPromote', 'recordsPath'])))
  if (policy.forbiddenPaths != null && !Array.isArray(policy.forbiddenPaths)) errors.push('forbiddenPaths must be a list')
  if (policy.contentRules != null) errors.push(...validateContentRules(policy.contentRules))
  if (policy.contentRuleExceptions != null) {
    errors.push(...validateContentRuleExceptions(policy.contentRuleExceptions, resolveContentRules(policy)))
    const declaredRepos = isObject(repos) ? repos : {}
    for (const [index, exception] of policy.contentRuleExceptions.entries()) {
      const name = firstString(exception?.repo)
      if (name && Object.keys(declaredRepos).length && !declaredRepos[name]) {
        errors.push(`contentRuleExceptions[${index}].repo ${name} is not declared in repos`)
      }
    }
  }

  for (const [actorId, actor] of Object.entries(isObject(actors) ? actors : {})) {
    errors.push(...unknownKeys(actor, `actors.${actorId}`, new Set(['githubLogin', 'gitEmails', 'privateDomainRepo'])))
    if (!isObject(actor)) {
      errors.push(`actors.${actorId} must be an object`)
      continue
    }
    if (!firstString(actor.githubLogin) && !asArray(actor.gitEmails).length) {
      errors.push(`actors.${actorId} must declare githubLogin or gitEmails`)
    }
    if (!firstString(actor.privateDomainRepo)) errors.push(`actors.${actorId}.privateDomainRepo is required`)
    if (firstString(actor.privateDomainRepo) && isObject(repos)) {
      const privateRepo = repos[actor.privateDomainRepo]
      if (!privateRepo) {
        errors.push(`actors.${actorId}.privateDomainRepo ${actor.privateDomainRepo} is not declared in repos`)
      } else if (privateRepo.kind !== 'private_domain') {
        errors.push(`actors.${actorId}.privateDomainRepo ${actor.privateDomainRepo} must reference a private_domain repo`)
      }
    }
    for (const email of asArray(actor.gitEmails)) {
      if (typeof email !== 'string' || !email.includes('@')) errors.push(`actors.${actorId}.gitEmails must contain email strings`)
    }
  }

  for (const [repoName, repo] of Object.entries(isObject(repos) ? repos : {})) {
    errors.push(...unknownKeys(repo, `repos.${repoName}`, new Set(['kind', 'ownerActor', 'readBoundary', 'allowedAudiences', 'forbiddenAudiences', 'autoCommit'])))
    if (!isObject(repo)) {
      errors.push(`repos.${repoName} must be an object`)
      continue
    }
    if (!VALID_REPO_KINDS.has(repo.kind)) errors.push(`repos.${repoName}.kind is invalid`)
    if (!VALID_AUDIENCES.has(repo.readBoundary)) errors.push(`repos.${repoName}.readBoundary is invalid`)
    if (!VALID_AUTOCOMMIT.has(repo.autoCommit)) errors.push(`repos.${repoName}.autoCommit is invalid`)
    errors.push(...validAudienceList(repo.allowedAudiences, `repos.${repoName}.allowedAudiences`, true))
    errors.push(...validAudienceList(repo.forbiddenAudiences, `repos.${repoName}.forbiddenAudiences`))
    if (repo.kind === 'private_domain') {
      if (!firstString(repo.ownerActor)) errors.push(`repos.${repoName}.ownerActor is required for private_domain repos`)
      if (repo.ownerActor && isObject(actors) && !actors[repo.ownerActor]) errors.push(`repos.${repoName}.ownerActor ${repo.ownerActor} is not declared`)
    }
  }

  if (project?.repos?.length && isObject(repos)) {
    for (const repo of project.repos) {
      if (repo.external) {
        // Declaring a boundary for a repo nobody manages is the confusion the
        // external kind exists to remove.
        if (repos[repo.name]) errors.push(`policy repos.${repo.name} must not be declared; it is an external (unmanaged) repo`)
        continue
      }
      if (!repos[repo.name]) errors.push(`policy repos.${repo.name} must be declared`)
    }
  }

  return errors
}

export function resolveCurrentActor({ policy, project, actor = null, env = process.env } = {}) {
  const actors = policy?.actors ?? {}
  const explicit = actor || env.MNSTRY_ATELIER_ACTOR || env.GITHUB_ACTOR
  if (explicit && actors[explicit]) return { actorId: explicit, source: 'explicit' }
  const gitEmails = gitEmailsForProject(project)
  for (const [actorId, info] of Object.entries(actors)) {
    const actorEmails = new Set(asArray(info.gitEmails).map((email) => email.toLowerCase()))
    if (gitEmails.some((email) => actorEmails.has(email.toLowerCase()))) return { actorId, source: 'git-email', gitEmails }
  }
  const login = env.GITHUB_ACTOR || ghLogin()
  if (login) {
    for (const [actorId, info] of Object.entries(actors)) {
      if (String(info.githubLogin || '').toLowerCase() === String(login).toLowerCase()) return { actorId, source: 'github-login', githubLogin: login }
    }
  }
  return { actorId: null, source: 'unverified', gitEmails, githubLogin: login || null }
}

function gitEmailsForProject(project) {
  const roots = unique([project?.repoOpsRoot, project?.workspaceRoot, ...managedRepos(project).map((repo) => repo.path)])
  const emails = []
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue
    const result = spawnSync('git', ['-C', root, 'config', 'user.email'], { encoding: 'utf8' })
    if (result.status === 0 && result.stdout.trim()) emails.push(result.stdout.trim())
  }
  return unique(emails)
}

function ghLogin() {
  try {
    return execFileSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

function repoPolicy(policy, repoName) {
  return policy?.repos?.[repoName] ?? null
}

function finding({ severity = 'error', code, message, repo = null, path: itemPath = null, node = null, details = {} }) {
  return { severity, code, message, repo, path: itemPath, node, details }
}

function severityFor(policy) {
  return policy?.mode === 'legacy-warning' ? 'warning' : 'error'
}

function nodePlacementFindings({ node, policy }) {
  const findings = []
  const repo = repoPolicy(policy, node.repo)
  const severity = severityFor(policy)
  if (!repo) {
    findings.push(finding({ severity, code: 'repo-policy-missing', repo: node.repo, path: node.path, node: node.id, message: `${node.repo} is missing boundary policy coverage` }))
    return findings
  }
  if (!repo.allowedAudiences?.includes(node.audience)) {
    findings.push(finding({ severity, code: 'audience-not-allowed-in-repo', repo: node.repo, path: node.path, node: node.id, message: `${node.repo}/${node.path}: audience ${node.audience} is not allowed in ${repo.kind} repo ${node.repo}` }))
  }
  if (repo.forbiddenAudiences?.includes(node.audience)) {
    findings.push(finding({ severity, code: 'audience-forbidden-in-repo', repo: node.repo, path: node.path, node: node.id, message: `${node.repo}/${node.path}: audience ${node.audience} is forbidden in ${repo.kind} repo ${node.repo}` }))
  }
  if (PRIVATE_AUDIENCES.has(node.audience) && repo.kind !== 'private_domain') {
    findings.push(finding({ severity, code: 'private-audience-in-shared-repo', repo: node.repo, path: node.path, node: node.id, message: `${node.repo}/${node.path}: ${node.audience} material must live in a private domain repo, not ${repo.kind}` }))
  }
  return findings
}

function actorFindings({ policy, project, actor }) {
  const findings = []
  const current = resolveCurrentActor({ policy, project, actor })
  const severity = severityFor(policy)
  for (const [repoName, repo] of Object.entries(policy.repos ?? {})) {
    if (repo.kind !== 'private_domain') continue
    if (!repo.ownerActor) continue
    if (!current.actorId) {
      findings.push(finding({ severity, code: 'private-domain-actor-unverified', repo: repoName, message: `${repoName}: could not verify local actor for private domain repo owned by ${repo.ownerActor}` }))
    } else if (current.actorId !== repo.ownerActor) {
      findings.push(finding({ severity, code: 'private-domain-actor-mismatch', repo: repoName, message: `${repoName}: private domain repo is owned by ${repo.ownerActor}, but current actor is ${current.actorId}` }))
    }
  }
  return findings
}

export function stagedPathsForProject(project) {
  const paths = []
  for (const repo of managedRepos(project)) {
    if (!repo.path || !fs.existsSync(path.join(repo.path, '.git'))) continue
    const result = spawnSync('git', ['-C', repo.path, 'diff', '--cached', '--name-only', '--diff-filter=ACMR'], { encoding: 'utf8' })
    if (result.status !== 0) continue
    for (const rel of result.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
      paths.push({ repo: repo.name, repoRoot: repo.path, path: normalize(rel) })
    }
  }
  return paths
}

function forbiddenPathFindings({ policy, stagedPaths }) {
  const patterns = [...DEFAULT_FORBIDDEN_PATHS, ...asArray(policy.forbiddenPaths)]
  const findings = []
  const severity = severityFor(policy)
  for (const item of stagedPaths) {
    const matched = patterns.find((pattern) => matchesPathPattern(pattern, item.path))
    if (matched) {
      findings.push(finding({ severity, code: 'forbidden-path-staged', repo: item.repo, path: item.path, message: `${item.repo}/${item.path}: staged path is protected by boundary policy pattern ${matched}` }))
    }
  }
  return findings
}

function unquoteValue(value) {
  const text = String(value ?? '')
    .trim()
    .replace(/,$/, '')
    .trim()
  const quoted = text.match(/^(["'])(.*)\1$/)
  return quoted ? quoted[2] : text
}

export function semanticFieldOnLine(line) {
  if (!SEMANTIC_FIELD_RE.test(line)) return null
  const assignment = line.match(SEMANTIC_ASSIGNMENT_RE)
  if (assignment) {
    return { field: assignment[1].toLowerCase().replace(/^kg\./, ''), value: unquoteValue(assignment[2]), raw: line.trim() }
  }
  // A boundary field is always declared as `field: value` in front matter and in sidecar
  // JSON. A bare mention with no colon is prose, not a declaration.
  if (!line.includes(':')) return null
  return { field: null, value: null, raw: line.trim() }
}

function isInitializationDefault(field, value) {
  const defaults = SEMANTIC_INITIALIZATION_DEFAULTS[field]
  return Array.isArray(defaults) && defaults.includes(value)
}

export function diffFileSections(diff) {
  const files = []
  let current = null
  let hunk = null
  for (const line of String(diff ?? '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      const header = line.match(/^diff --git a\/(.*) b\/(.*)$/)
      current = { path: header ? normalize(header[2]) : null, hunks: [], lines: [] }
      files.push(current)
      hunk = null
      continue
    }
    if (!current) continue
    current.lines.push(line)
    if (line.startsWith('@@')) {
      hunk = { added: [], removed: [] }
      current.hunks.push(hunk)
      continue
    }
    if (!hunk) continue
    if (/^\+(?!\+)/.test(line)) hunk.added.push(line.slice(1))
    else if (/^-(?!-)/.test(line)) hunk.removed.push(line.slice(1))
  }
  return files
}

export function semanticChangesInFile(file) {
  const changes = []
  for (const hunk of file.hunks ?? []) {
    const pending = hunk.removed.map(semanticFieldOnLine).filter(Boolean)
    for (const entry of hunk.added.map(semanticFieldOnLine).filter(Boolean)) {
      const index = pending.findIndex((item) => item.field === entry.field)
      const prior = index === -1 ? null : pending.splice(index, 1)[0]
      if (prior) {
        changes.push(entry.field ? `${entry.field} changed from "${prior.value}" to "${entry.value}"` : `boundary line changed to "${entry.raw}"`)
      } else if (!entry.field || !isInitializationDefault(entry.field, entry.value)) {
        changes.push(entry.field ? `${entry.field} introduced as "${entry.value}"` : `boundary line introduced: "${entry.raw}"`)
      }
    }
    for (const entry of pending) {
      changes.push(entry.field ? `${entry.field} removed (was "${entry.value}")` : `boundary line removed: "${entry.raw}"`)
    }
  }
  return changes
}

function semanticDiffFindings({ policy, project }) {
  const findings = []
  const severity = severityFor(policy)
  for (const repo of managedRepos(project)) {
    if (!repo.path || !fs.existsSync(path.join(repo.path, '.git'))) continue
    const result = spawnSync('git', ['-C', repo.path, 'diff', '--cached', '--unified=0', '--', '*.md', '*.kg.json'], { encoding: 'utf8' })
    if (result.status !== 0 || !result.stdout.trim()) continue
    for (const file of diffFileSections(result.stdout)) {
      const changes = semanticChangesInFile(file)
      if (!changes.length) continue
      // The marker has to travel in the same file's diff as the change it approves —
      // a marker elsewhere in the commit approves nothing.
      if (REVIEW_MARKER_RE.test(file.lines.join('\n'))) continue
      const label = `${repo.name}/${file.path ?? '(unknown path)'}`
      findings.push(
        finding({
          severity,
          code: 'semantic-field-change-needs-review',
          repo: repo.name,
          path: file.path,
          message: `${label}: ${changes.join('; ')} — add an Atelier-Boundary-Review: approved marker to this file's diff`,
          details: { changes },
        }),
      )
    }
  }
  return findings
}

function contentRuleFindings({ policy, project, files }) {
  const rules = resolveContentRules(policy)
  const exceptions = asArray(policy?.contentRuleExceptions)
  const findings = []
  for (const entry of files) {
    for (const item of scanAddedContent({ files: entry.files, rules, exceptions, repo: entry.repo })) {
      // The rule id and line stay on the finding: they are what a person needs to
      // either fix the line or write the exception.
      findings.push({ ...finding({ ...item, details: { rule: item.rule, line: item.line } }), rule: item.rule, line: item.line })
    }
  }
  return findings
}

function stagedContentFindings({ policy, project }) {
  const files = managedRepos(project)
    .filter((repo) => repo.path && fs.existsSync(path.join(repo.path, '.git')))
    .map((repo) => ({ repo: repo.name, files: parseAddedContent(stagedDiff(repo.path)) }))
  return contentRuleFindings({ policy, project, files })
}

function realPath(value) {
  try {
    return fs.realpathSync(path.resolve(value))
  } catch {
    return path.resolve(value)
  }
}

// Matched through realpath: a workspace reached via a symlink (a macOS temp dir, a
// linked checkout) otherwise fails to match its own configured path, and the guard
// silently judges nothing.
function repoForCwd(project, cwd) {
  const resolved = realPath(cwd)
  return (
    managedRepos(project).find((repo) => {
      if (!repo.path) return false
      const repoPath = realPath(repo.path)
      return resolved === repoPath || resolved.startsWith(`${repoPath}${path.sep}`)
    }) ?? null
  )
}

/**
 * Judge only what is being pushed. The whole-tree view lives in `boundary audit`,
 * which reports without blocking, so an accepted usage elsewhere in the repo can
 * never strand unrelated work on the machine.
 */
export function checkPushContent({ project, policy, repo, updates, cwd = process.cwd() } = {}) {
  const target = repo ?? repoForCwd(project, cwd)
  if (!target) {
    // Fail closed. This hook is only installed into managed repos, so failing to
    // identify one means the guard would judge nothing — a silent no-op is the
    // failure mode this whole guard exists to avoid.
    const unresolved = finding({
      code: 'push-check-repo-unresolved',
      repo: null,
      message: `${cwd} is not a repo declared in ${project?.configPath ?? 'the project config'}; the push guard cannot tell what it is judging`,
    })
    return { ok: false, repo: null, findings: [unresolved], errors: [unresolved], warnings: [] }
  }
  const files = []
  for (const update of updates) files.push(...parseAddedContent(diffForPushRange(target.path, update)))
  const findings = contentRuleFindings({ policy, project, files: [{ repo: target.name, files }] })
  const errors = findings.filter((item) => item.severity === 'error')
  return { ok: errors.length === 0, repo: target.name, updates, findings, errors, warnings: findings.filter((item) => item.severity !== 'error') }
}

export function auditContentRules({ project, policy } = {}) {
  const rules = resolveContentRules(policy)
  const exceptions = asArray(policy?.contentRuleExceptions)
  const findings = []
  for (const repo of managedRepos(project)) {
    if (!repo.path || !fs.existsSync(path.join(repo.path, '.git'))) continue
    findings.push(...scanTree(repo.path, { rules, exceptions, repo: repo.name }))
  }
  const accepted = []
  for (const repo of managedRepos(project)) {
    for (const exception of exceptions) {
      if (firstString(exception?.repo) !== repo.name) continue
      accepted.push({ repo: repo.name, rule: exception.rule, paths: exception.paths, reason: exception.reason })
    }
  }
  return { schema: BOUNDARY_POLICY_SCHEMA, findings, accepted }
}

function promotionRecords(project, policy) {
  const recordsPath = firstString(policy?.promotion?.recordsPath)
  if (!recordsPath) return []
  const abs = resolvePathValue(recordsPath, project.configDir)
  if (!abs || !fs.existsSync(abs)) return []
  return fs
    .readFileSync(abs, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return { invalid: true, line }
      }
    })
}

function promotionFindings({ policy, project, graph }) {
  if (!policy?.promotion?.requiresGitPromote) return []
  const records = promotionRecords(project, policy)
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
  const recordKeys = new Set(records.filter((record) => !record.invalid).map((record) => `${record.source?.repo}:${record.source?.kgId}->${record.target?.repo}:${record.target?.kgId}`))
  const findings = []
  const severity = severityFor(policy)
  for (const node of graph.nodes) {
    const targetRepo = repoPolicy(policy, node.repo)
    if (!targetRepo || targetRepo.kind === 'private_domain') continue
    for (const sourceId of asArray(node.relations?.supersedes)) {
      const sourceNode = nodeById.get(sourceId)
      if (!sourceNode) continue
      const sourceRepo = repoPolicy(policy, sourceNode.repo)
      if (sourceRepo?.kind !== 'private_domain') continue
      const key = `${sourceNode.repo}:${sourceNode.id}->${node.repo}:${node.id}`
      if (!recordKeys.has(key)) {
        findings.push(finding({ severity, code: 'git-promote-required', repo: node.repo, path: node.path, node: node.id, message: `${node.repo}/${node.path}: promotion from private ${sourceNode.id} requires git.promote record` }))
      }
    }
  }
  for (const [index, record] of records.entries()) {
    if (record.invalid) {
      findings.push(finding({ severity, code: 'git-promote-record-invalid-json', message: `git.promote record ${index + 1} is invalid JSON` }))
    } else if (record.schema && record.schema !== PROMOTE_EVENT_SCHEMA) {
      findings.push(finding({ severity, code: 'git-promote-record-invalid-schema', message: `git.promote record ${index + 1} has invalid schema ${record.schema}` }))
    } else if (record.event?.type !== 'git.promote' || record.event?.revocable !== false) {
      findings.push(finding({ severity, code: 'git-promote-record-invalid', message: `git.promote record ${index + 1} must be durable and non-revocable` }))
    }
  }
  return findings
}

export function checkBoundaryPolicy({ project, policy, staged = false, stagedOnly = false, actor = null } = {}) {
  const validationErrors = validateBoundaryPolicy(policy, project)
  let graph = null
  const findings = validationErrors.map((message) => finding({ severity: severityFor(policy), code: 'boundary-policy-invalid', message }))
  if (validationErrors.length === 0) {
    if (!stagedOnly) {
      graph = buildGraph(project)
      findings.push(...graph.errors.map((message) => finding({ severity: severityFor(policy), code: 'knowledge-graph-invalid', message })))
      for (const node of graph.nodes ?? []) findings.push(...nodePlacementFindings({ node, policy }))
      findings.push(...promotionFindings({ policy, project, graph }))
    }
    findings.push(...actorFindings({ policy, project, actor }))
    if (staged) {
      const stagedPaths = stagedPathsForProject(project)
      findings.push(...forbiddenPathFindings({ policy, stagedPaths }))
      findings.push(...semanticDiffFindings({ policy, project }))
      findings.push(...stagedContentFindings({ policy, project }))
    }
  }
  const errors = findings.filter((item) => item.severity === 'error')
  const warnings = findings.filter((item) => item.severity !== 'error')
  return {
    ok: errors.length === 0,
    mode: policy?.mode ?? null,
    schema: BOUNDARY_POLICY_SCHEMA,
    graphCounts: graph?.counts ?? null,
    findings,
    errors,
    warnings,
  }
}

export function runBoundaryCheckCommand(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const staged = Boolean(args.staged)
  const stagedOnly = Boolean(args['staged-only'])
  const json = Boolean(args.json)
  const project = commandProject({ argv })
  const loaded = loadBoundaryPolicy(project)
  const missingFindings = loaded.errors?.map((message) => finding({ code: 'boundary-policy-missing', message })) ?? []
  const report = loaded.ok
    ? checkBoundaryPolicy({ project, policy: loaded.policy, staged, stagedOnly, actor: firstString(args.actor) })
    : { ok: false, mode: null, schema: BOUNDARY_POLICY_SCHEMA, graphCounts: null, findings: missingFindings, errors: missingFindings, warnings: [] }

  if (json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    const label = report.ok ? 'passed' : 'failed'
    console.log(`[boundary:check] ${label} · ${report.errors.length ?? report.findings.filter((item) => item.severity === 'error').length} errors · ${report.warnings.length ?? report.findings.filter((item) => item.severity !== 'error').length} warnings`)
    for (const item of report.findings.slice(0, 50)) console.log(`${item.severity ?? 'error'} ${item.code}: ${item.message}`)
  }
  process.exit(report.ok ? 0 : 1)
}

export function installBoundaryHooks({ project, force = false } = {}) {
  const installed = []
  const skipped = []
  for (const repo of managedRepos(project)) {
    if (!repo.path || !fs.existsSync(path.join(repo.path, '.git'))) continue
    const hooksDir = path.join(repo.path, '.git', 'hooks')
    fs.mkdirSync(hooksDir, { recursive: true })
    for (const hookName of ['pre-commit', 'pre-push']) {
      const hookPath = path.join(hooksDir, hookName)
      const existing = fs.existsSync(hookPath) ? fs.readFileSync(hookPath, 'utf8') : ''
      const script = hookScript(project.configPath, hookName)
      if (existing && !existing.includes('MNSTRY_ATELIER_BOUNDARY_GUARD') && !force) {
        const sidecar = `${hookPath}.mnstry-atelier-boundary`
        fs.writeFileSync(sidecar, script)
        fs.chmodSync(sidecar, 0o755)
        skipped.push({ repo: repo.name, hook: hookName, path: hookPath, sidecar })
        continue
      }
      fs.writeFileSync(hookPath, script)
      fs.chmodSync(hookPath, 0o755)
      installed.push({ repo: repo.name, hook: hookName, path: hookPath })
    }
  }
  return { installed, skipped }
}

function hookScript(projectConfigPath, hookName) {
  const config = projectConfigPath ? `--project-config=${projectConfigPath.replaceAll('"', '\\"')}` : ''
  // pre-push reads the ref updates git writes to stdin and judges only that range;
  // pre-commit judges the staged diff. Neither scans the whole tree — that view is
  // `atelier boundary audit`, which reports without blocking.
  const invocation = hookName === 'pre-push' ? `boundary push-check ${config}` : `boundary check --staged ${config}`
  return `#!/usr/bin/env bash
# MNSTRY_ATELIER_BOUNDARY_GUARD ${hookName}
set -euo pipefail
if command -v atelier >/dev/null 2>&1; then
  exec atelier ${invocation}
elif [ -x "./node_modules/.bin/atelier" ]; then
  exec ./node_modules/.bin/atelier ${invocation}
elif command -v mnstry-atelier >/dev/null 2>&1; then
  exec mnstry-atelier ${invocation}
elif [ -x "./node_modules/.bin/mnstry-atelier" ]; then
  exec ./node_modules/.bin/mnstry-atelier ${invocation}
elif [ -n "\${MNSTRY_ATELIER_PACKAGE_ROOT:-}" ]; then
  exec node "$MNSTRY_ATELIER_PACKAGE_ROOT/bin/mnstry-atelier.mjs" ${invocation}
else
  echo "Atelier boundary guard is not installed on PATH" >&2
  exit 1
fi
`
}

export function runBoundaryPushCheckCommand(argv = process.argv.slice(2), { stdin = readStdin() } = {}) {
  const args = parseArgs(argv)
  const project = commandProject({ argv })
  const loaded = loadBoundaryPolicy(project)
  if (!loaded.ok) {
    console.error(loaded.errors.join('\n'))
    process.exit(1)
  }
  const updates = parsePushRefUpdates(stdin)
  if (!updates.length) {
    console.log('[boundary:push-check] no ref updates on stdin · nothing to judge')
    process.exit(0)
  }
  const report = checkPushContent({ project, policy: loaded.policy, updates, cwd: process.cwd() })
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(`[boundary:push-check] ${report.ok ? 'passed' : 'blocked'} · ${report.repo ?? 'unknown repo'} · ${report.errors.length} errors · ${report.warnings.length} warnings`)
    for (const item of report.findings.slice(0, 50)) console.log(`${item.severity} ${item.rule ?? item.code}: ${item.message}`)
    if (!report.ok && report.repo) {
      console.log('')
      console.log('If this usage is intentional, declare it in the boundary policy:')
      console.log('  contentRuleExceptions: [{ rule, repo, paths: [...], reason: "why this is accepted" }]')
    }
  }
  process.exit(report.ok ? 0 : 1)
}

export function runBoundaryAuditCommand(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const project = commandProject({ argv })
  const loaded = loadBoundaryPolicy(project)
  if (!loaded.ok) {
    console.error(loaded.errors.join('\n'))
    process.exit(1)
  }
  const report = auditContentRules({ project, policy: loaded.policy })
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(`[boundary:audit] ${report.findings.length} content-rule matches across the tree · ${report.accepted.length} declared exceptions`)
    for (const item of report.findings.slice(0, 100)) console.log(`${item.severity} ${item.rule}: ${item.message}`)
    for (const item of report.accepted) console.log(`accepted ${item.rule} in ${item.repo} (${item.paths.join(', ')}): ${item.reason}`)
  }
  // Reporting only. A pre-existing accepted usage must never block unrelated work.
  process.exit(0)
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

export function runBoundaryInstallHooksCommand(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const project = commandProject({ argv })
  const result = installBoundaryHooks({ project, force: Boolean(args.force) })
  console.log(JSON.stringify({ ok: result.skipped.length === 0, ...result }, null, 2))
  process.exit(result.skipped.length === 0 ? 0 : 1)
}

function parsePromoteArgs(argv) {
  const args = parseArgs(argv)
  const sourceRepo = firstString(args['source-repo'], args.sourceRepo)
  const targetRepo = firstString(args['target-repo'], args.targetRepo)
  const kgId = firstString(args['kg-id'], args.kgId)
  const targetKgId = firstString(args['target-kg-id'], args.targetKgId) || kgId
  const actor = firstString(args.actor, process.env.MNSTRY_ATELIER_ACTOR, process.env.GITHUB_ACTOR, process.env.USER) || 'unknown'
  return { args, sourceRepo, targetRepo, kgId, targetKgId, actor }
}

export function createPromoteEvent({ project, policy, sourceRepo, targetRepo, kgId, targetKgId = kgId, actor }) {
  if (!sourceRepo || !targetRepo || !kgId) throw new Error('promote requires --source-repo, --target-repo, and --kg-id')
  const source = project.repos.find((repo) => repo.name === sourceRepo)
  const target = project.repos.find((repo) => repo.name === targetRepo)
  if (!source) throw new Error(`source repo not configured: ${sourceRepo}`)
  if (!target) throw new Error(`target repo not configured: ${targetRepo}`)
  const sourcePolicy = repoPolicy(policy, sourceRepo)
  const targetPolicy = repoPolicy(policy, targetRepo)
  const sourceCommit = gitHead(source.path)
  const targetCommit = gitHead(target.path)
  return {
    schema: PROMOTE_EVENT_SCHEMA,
    source: {
      repo: sourceRepo,
      repoAccess: sourcePolicy?.readBoundary ?? source.readBoundary ?? 'private',
      kgId,
      audience: 'private',
      commit: sourceCommit,
    },
    target: {
      repo: targetRepo,
      repoAccess: targetPolicy?.readBoundary ?? target.readBoundary ?? 'team',
      kgId: targetKgId,
      audience: 'team',
      commit: targetCommit,
    },
    event: {
      type: 'git.promote',
      actor,
      disclosureClass: 'durable',
      revocable: false,
      recordedAt: new Date().toISOString(),
    },
  }
}

function gitHead(repoPath) {
  try {
    return execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return 'unknown'
  }
}

export function runPromoteCommand(argv = process.argv.slice(2)) {
  const parsed = parsePromoteArgs(argv)
  const project = commandProject({ argv })
  const loaded = loadBoundaryPolicy(project)
  if (!loaded.ok) {
    console.error(loaded.errors.join('\n'))
    process.exit(1)
  }
  const event = createPromoteEvent({ project, policy: loaded.policy, ...parsed })
  const recordsPath = firstString(loaded.policy.promotion?.recordsPath)
  if (!recordsPath) {
    console.error('boundary policy promotion.recordsPath is required')
    process.exit(1)
  }
  const abs = resolvePathValue(recordsPath, project.configDir)
  if (parsed.args['dry-run']) {
    console.log(JSON.stringify({ ok: true, dryRun: true, path: abs, event }, null, 2))
    process.exit(0)
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.appendFileSync(abs, `${JSON.stringify(event)}\n`)
  console.log(JSON.stringify({ ok: true, path: abs, event }, null, 2))
}
