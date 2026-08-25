import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { checkBoundaryPolicy, loadBoundaryPolicy } from '../boundary/policy.mjs'
import { commandProject } from '../project/config.mjs'
import { classifyRemoteAuthentication, inspectGitEngine, redactGitDiagnostic, resolveGitExecutable, runGit, sanitizeRemoteUrl } from './git-adapter.mjs'
import {
  ATELIER_RUNTIME_ENROLLMENT_SCHEMA,
  ATELIER_RUNTIME_PLAN_MAX_AGE_MS,
  ATELIER_RUNTIME_PLAN_MAX_BYTES,
  ATELIER_RUNTIME_PLAN_MAX_FILES,
  acquireRepositoryLock,
  appendOperationTrace,
  atomicWriteJson,
  ensureRuntimeStateRoot,
  readJsonIfPresent,
  readOperationTrace,
  readRuntimeControl,
  removeRuntimeLeaf,
  runtimePlanInventory,
  runtimePaths,
  writeRuntimeControl,
  writeRuntimeState,
} from './local-state.mjs'
import { observeRepository, resolveRepositoryRoot } from './repository-observation.mjs'

export const ATELIER_COMMIT_PLAN_SCHEMA = 'atelier-commit-plan@v1'

const ENROLLMENT_KEYS = ['schema', 'enrolledAt', 'repoRoot', 'projectConfig', 'git', 'mode']
const ENROLLMENT_GIT_KEYS = ['executable', 'version', 'supported', 'minimum', 'executableSha256']

function nowIso() {
  return new Date().toISOString()
}

function hash(value, length = 32) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length)
}

function fileSha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!value || typeof value !== 'object') return JSON.stringify(value)
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

function gitFailure(result) {
  return redactGitDiagnostic(result?.stderr?.trim() || result?.error || 'Git operation failed')
}

function normalizePath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '')
}

function unique(values) {
  return [...new Set(values)]
}

function cleanMessage(value) {
  const message = String(value || '').trim()
  if (!message) throw new Error('commit message is required')
  if (message.length > 500) throw new Error('commit message must not exceed 500 characters')
  if (/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(message)) throw new Error('commit message contains unsupported control characters')
  return message
}

function validateSelectedPaths(paths, observation) {
  const selected = unique((paths || []).map(normalizePath).filter(Boolean)).sort((a, b) => a.localeCompare(b, 'en'))
  if (!selected.length) throw new Error('at least one explicit changed file is required')
  for (const item of selected) {
    if (path.isAbsolute(item) || item === '..' || item.startsWith('../') || item.includes('/../') || item.includes('\0')) {
      throw new Error(`commit path escapes repository: ${item}`)
    }
  }
  const changed = new Set()
  for (const entry of observation.status?.entries || []) {
    changed.add(entry.path)
    if (entry.originalPath) changed.add(entry.originalPath)
  }
  const missing = selected.filter((item) => !changed.has(item))
  if (missing.length) throw new Error(`commit paths are not present in the observed change set: ${missing.join(', ')}`)
  return selected
}

function stagedPaths(observation) {
  const values = []
  for (const entry of observation.status?.entries || []) {
    if (entry.code?.[0] && ![' ', '?', '!'].includes(entry.code[0])) {
      values.push(entry.path)
      if (entry.originalPath) values.push(entry.originalPath)
    }
  }
  return unique(values).sort((a, b) => a.localeCompare(b, 'en'))
}

function attentionState(code, message, observation = null, details = {}) {
  const incidentId = `incident-${hash(JSON.stringify({ code, root: observation?.root, head: observation?.branch?.head, digest: observation?.status?.digest, details }))}`
  return { status: 'attention', code, message, incidentId, observation, details }
}

function healthyState(code, message, observation, details = {}) {
  return { status: 'healthy', code, message, incidentId: null, observation, details }
}

function pausedState(control, observation = null) {
  return { status: 'paused', code: 'user-paused', message: control.reason || 'paused by user', incidentId: null, observation, details: {} }
}

function persistState(paths, state, clock = nowIso) {
  let observation = state.observation
  if (observation?.status) {
    const { entries = [], fingerprints = [], ...status } = observation.status
    observation = {
      ...observation,
      status: { ...status, entryCount: entries.length, fingerprintCount: fingerprints.length },
    }
  }
  return writeRuntimeState(paths, { ...state, observation, updatedAt: clock() })
}

function trace(paths, event, clock = nowIso) {
  return appendOperationTrace(paths.trace, { at: clock(), ...event })
}

function enrollmentProjectConfig(repoRoot, value) {
  if (!value) {
    const candidate = path.join(repoRoot, 'atelier.project.json')
    return fs.existsSync(candidate) ? candidate : null
  }
  const resolved = path.resolve(repoRoot, value)
  if (!fs.existsSync(resolved)) throw new Error(`project config not found: ${resolved}`)
  return resolved
}

export function enrollRepository({ repoPath = process.cwd(), projectConfig = null, gitExecutable = null, clock = nowIso } = {}) {
  const selectedGit = gitExecutable || resolveGitExecutable()
  const git = fs.realpathSync.native ? fs.realpathSync.native(selectedGit) : fs.realpathSync(selectedGit)
  const lexicalRepo = fs.realpathSync.native ? fs.realpathSync.native(repoPath) : fs.realpathSync(repoPath)
  let candidateBoundary = lexicalRepo
  let repositoryBoundary = null
  while (true) {
    if (fs.existsSync(path.join(candidateBoundary, '.git'))) {
      repositoryBoundary = candidateBoundary
      break
    }
    if (path.dirname(candidateBoundary) === candidateBoundary) break
    candidateBoundary = path.dirname(candidateBoundary)
  }
  if (repositoryBoundary && isContainedPath(repositoryBoundary, git)) throw new Error('enrollment Git executable must live outside the repository before it can be inspected')
  const resolved = resolveRepositoryRoot(repoPath, git)
  if (!resolved.ok) throw new Error(resolved.error || `unsupported repository root: ${resolved.filesystem?.code || 'unknown'}`)
  if (isContainedPath(resolved.root, git)) throw new Error('enrollment Git executable must live outside the repository')
  const paths = ensureRuntimeStateRoot(resolved.root, git)
  const lock = acquireRepositoryLock(paths, { operation: 'enroll', clock })
  if (!lock.ok) throw new Error('repository is busy with another Atelier operation')
  try {
    const observation = observeRepository({ repoRoot: resolved.root, gitExecutable: git, observedAt: clock() })
    if (observation.bare) throw new Error('bare repositories cannot be enrolled')
    const engine = { ...inspectGitEngine(git), executableSha256: fileSha256(git) }
    if (!engine.supported) throw new Error(`Git ${engine.version} is unsupported; Atelier requires ${engine.minimum} or newer`)
    const enrollment = {
      schema: ATELIER_RUNTIME_ENROLLMENT_SCHEMA,
      enrolledAt: clock(),
      repoRoot: resolved.root,
      projectConfig: enrollmentProjectConfig(resolved.root, projectConfig),
      git: engine,
      mode: 'explicit-single-repository',
    }
    atomicWriteJson(paths.enrollment, enrollment)
    const state = observation.complete
      ? healthyState('enrolled', 'repository enrolled and fully observed', observation)
      : attentionState('repository-incomplete', 'repository enrolled but completeness blockers require review', observation, { blockers: observation.blockers })
    persistState(paths, state, clock)
    trace(paths, { operation: 'enroll', outcome: observation.complete ? 'healthy' : 'attention', details: { root: resolved.root, blockers: observation.blockers.map((item) => item.code) } }, clock)
    return { ok: true, enrollment, state }
  } finally {
    lock.release()
  }
}

function isContainedPath(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function requireClosedObject(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length) throw new Error(`${label} contains unsupported fields: ${unknown.join(', ')}`)
}

export function loadEnrollment(repoPath = process.cwd(), { env = process.env } = {}) {
  let root = path.resolve(repoPath)
  try {
    root = fs.realpathSync.native(root)
  } catch {
    root = fs.realpathSync(root)
  }
  const paths = runtimePaths(root)
  try {
    fs.lstatSync(paths.enrollment)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`repository is not enrolled: ${root}`)
    throw error
  }
  const enrollment = readJsonIfPresent(paths.enrollment)
  if (!enrollment) throw new Error(`repository is not enrolled: ${root}`)
  requireClosedObject(enrollment, ENROLLMENT_KEYS, 'runtime enrollment')
  if (enrollment.schema !== ATELIER_RUNTIME_ENROLLMENT_SCHEMA) throw new Error('runtime enrollment schema is unsupported')
  if (enrollment.mode !== 'explicit-single-repository') throw new Error('runtime enrollment mode is unsupported')
  if (!Number.isFinite(Date.parse(enrollment.enrolledAt))) throw new Error('runtime enrollment timestamp is invalid')
  if (path.resolve(enrollment.repoRoot) !== root) throw new Error('runtime enrollment root does not match the requested repository')
  if (enrollment.projectConfig != null && (!path.isAbsolute(enrollment.projectConfig) || !isContainedPath(root, path.resolve(enrollment.projectConfig)))) {
    throw new Error('runtime enrollment project config escapes the enrolled repository')
  }
  requireClosedObject(enrollment.git, ENROLLMENT_GIT_KEYS, 'runtime enrollment Git identity')
  if (!path.isAbsolute(enrollment.git?.executable || '')) throw new Error('runtime enrollment does not pin an absolute Git executable')
  const expectedGit = resolveGitExecutable({ env })
  if (enrollment.git.executable !== expectedGit) throw new Error('runtime enrollment Git executable does not match the current trusted Git selection')
  if (isContainedPath(root, enrollment.git.executable)) throw new Error('runtime enrollment Git executable must live outside the enrolled repository')
  const engine = { ...inspectGitEngine(expectedGit, { env }), executableSha256: fileSha256(expectedGit) }
  if (stableJson(engine) !== stableJson(enrollment.git)) throw new Error('runtime enrollment Git identity no longer matches the inspected executable')
  if (!engine.supported) throw new Error(`Git ${engine.version} is unsupported; Atelier requires ${engine.minimum} or newer`)
  const ignored = runGit(expectedGit, root, ['check-ignore', '-q', '--', '.atelier-local/runtime/enrollment.json'], { allowFailure: true, env })
  const tracked = runGit(expectedGit, root, ['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', '.atelier-local/runtime/enrollment.json'], { allowFailure: true, env })
  if (!ignored.ok || tracked.ok) throw new Error('runtime enrollment must remain Git-ignored and untracked')
  return { enrollment, paths }
}

export function runtimeStatus({ repoPath = process.cwd(), clock = nowIso } = {}) {
  const { enrollment, paths } = loadEnrollment(repoPath)
  const control = readRuntimeControl(paths)
  const observation = observeRepository({ repoRoot: enrollment.repoRoot, gitExecutable: enrollment.git.executable, observedAt: clock() })
  let state
  if (control.paused) state = pausedState(control, observation)
  else if (!observation.complete) state = attentionState('repository-incomplete', 'repository completeness blockers require review', observation, { blockers: observation.blockers })
  else if (observation.status.conflictCount) state = attentionState('git-conflict', 'repository contains unresolved Git conflicts', observation)
  else if (observation.branch.detached) state = attentionState('detached-head', 'repository is not on a named branch', observation)
  else if (observation.branch.ahead && observation.branch.behind) state = attentionState('branch-diverged', 'local and upstream histories have diverged', observation)
  else if (observation.branch.behind && !observation.status.clean) state = attentionState('update-blocked-by-local-changes', 'upstream changes cannot fast-forward over local work', observation)
  else if (observation.branch.ahead) state = attentionState('local-commits-unpublished', 'local commits are waiting for a user-driven publish action', observation)
  else state = healthyState('observed', 'repository observation is healthy', observation)
  let operations = null
  let traceError = null
  try {
    operations = readOperationTrace(paths.trace)
  } catch (error) {
    traceError = redactGitDiagnostic(error.message)
  }
  return { ok: state.status === 'healthy', enrollment, control, state, traceLength: operations?.length ?? null, traceError }
}

function fetchWithRetries({ enrollment, attempts = 3 }) {
  let last = null
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
    last = runGit(enrollment.git.executable, enrollment.repoRoot, ['fetch', '--prune', '--no-tags', '--recurse-submodules=no'], { allowFailure: true, timeout: 60_000 })
    if (last.ok) return { ok: true, attempts: attempt, result: last }
  }
  return { ok: false, attempts: Math.max(1, attempts), result: last }
}

function fullStateOrAttention(enrollment, clock = nowIso) {
  const observation = observeRepository({ repoRoot: enrollment.repoRoot, gitExecutable: enrollment.git.executable, observedAt: clock() })
  if (!observation.complete) return { observation, attention: attentionState('repository-incomplete', 'repository completeness blockers require review', observation, { blockers: observation.blockers }) }
  if (observation.status.conflictCount) return { observation, attention: attentionState('git-conflict', 'repository contains unresolved Git conflicts', observation) }
  if (observation.branch.detached) return { observation, attention: attentionState('detached-head', 'repository is not on a named branch', observation) }
  return { observation, attention: null }
}

export function reconcileRepository({ repoPath = process.cwd(), fetchAttempts = 3, clock = nowIso } = {}) {
  const { enrollment, paths } = loadEnrollment(repoPath)
  const lock = acquireRepositoryLock(paths, { operation: 'reconcile', clock })
  if (!lock.ok) return { ok: false, state: attentionState(lock.code, 'another Atelier operation is using this repository', null, lock.owner) }
  try {
    const control = readRuntimeControl(paths)
    if (control.paused) {
      const state = pausedState(control)
      persistState(paths, state, clock)
      return { ok: true, state }
    }
    const before = fullStateOrAttention(enrollment, clock)
    if (before.attention) {
      persistState(paths, before.attention, clock)
      return { ok: false, state: before.attention }
    }
    const fetched = fetchWithRetries({ enrollment, attempts: fetchAttempts })
    if (!fetched.ok) {
      const state = attentionState('fetch-unavailable', 'Git fetch did not succeed after bounded retries', before.observation, { attempts: fetched.attempts, error: gitFailure(fetched.result) })
      persistState(paths, state, clock)
      trace(paths, { operation: 'reconcile', outcome: 'attention', details: { code: state.code, attempts: fetched.attempts } }, clock)
      return { ok: false, state }
    }
    const after = fullStateOrAttention(enrollment, clock)
    if (after.attention) {
      persistState(paths, after.attention, clock)
      return { ok: false, state: after.attention }
    }
    const observation = after.observation
    let state
    let action = 'no-op'
    if (observation.branch.ahead && observation.branch.behind) {
      state = attentionState('branch-diverged', 'local and upstream histories have diverged', observation)
    } else if (observation.branch.behind && !observation.status.clean) {
      state = attentionState('update-blocked-by-local-changes', 'upstream changes cannot fast-forward over local work', observation)
    } else if (observation.branch.behind) {
      const merged = runGit(enrollment.git.executable, enrollment.repoRoot, ['merge', '--ff-only', '@{upstream}'], { allowFailure: true })
      if (!merged.ok) state = attentionState('fast-forward-refused', 'Git refused a fast-forward-only reconciliation', observation, { error: gitFailure(merged) })
      else {
        action = 'fast-forward'
        const final = fullStateOrAttention(enrollment, clock)
        state = final.attention || healthyState('fast-forwarded', 'repository fast-forwarded to its upstream', final.observation)
      }
    } else if (observation.branch.ahead) {
      state = attentionState('local-commits-unpublished', 'local commits are waiting for a user-driven publish action', observation)
    } else {
      state = healthyState('reconciled', 'repository already matches its upstream', observation)
    }
    persistState(paths, state, clock)
    trace(paths, { operation: 'reconcile', outcome: state.status, details: { action, code: state.code, fetchAttempts: fetched.attempts } }, clock)
    return { ok: state.status !== 'attention', state }
  } finally {
    lock.release()
  }
}

function publishTarget(observation) {
  const upstream = observation.branch?.upstream
  if (!upstream) return null
  const remotes = [...(observation.remotes || [])].sort((left, right) => right.name.length - left.name.length)
  const remote = remotes.find((item) => upstream === item.name || upstream.startsWith(`${item.name}/`))
  if (!remote || upstream === remote.name) return null
  return {
    remote: remote.name,
    branch: upstream.slice(remote.name.length + 1),
    url: remote.pushUrl,
    identityDigest: remote.pushIdentityDigest,
    authentication: remote.pushAuthentication,
  }
}

function currentPushDestination(enrollment, remoteName) {
  const result = runGit(enrollment.git.executable, enrollment.repoRoot, ['remote', 'get-url', '--push', '--all', remoteName], { allowFailure: true })
  if (!result.ok) throw new Error('publish destination could not be resolved; commit remains local and was not published')
  const urls = result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
  if (urls.length !== 1) throw new Error('publish destination is ambiguous; commit remains local and was not published')
  return urls[0]
}

function diffSummary(gitExecutable, root, selected) {
  const tracked = runGit(gitExecutable, root, ['--literal-pathspecs', 'diff', '--numstat', '--', ...selected], { allowFailure: true })
  const lines = tracked.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const [added, deleted, ...name] = line.split('\t')
    return { path: normalizePath(name.join('\t')), added: added === '-' ? null : Number(added), deleted: deleted === '-' ? null : Number(deleted) }
  })
  const covered = new Set(lines.map((item) => item.path))
  for (const item of selected) {
    if (covered.has(item)) continue
    const absolute = path.join(root, item)
    if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) lines.push({ path: item, added: null, deleted: null, bytes: fs.statSync(absolute).size, untracked: true })
  }
  return lines.sort((left, right) => left.path.localeCompare(right.path, 'en'))
}

function reviewedManifest(observation, selected) {
  return selected.map((itemPath) => {
    const entry = (observation.status?.fingerprints || []).find((item) => item.path === itemPath || item.originalPath === itemPath)
    if (!entry) throw new Error(`review fingerprint is unavailable for ${itemPath}`)
    return {
      path: itemPath,
      worktree: entry.path === itemPath && entry.worktree
        ? { mode: entry.worktree.mode, blob: entry.worktree.indexBlob }
        : null,
    }
  })
}

function planAuthority(plan) {
  return {
    schema: plan.schema,
    mode: plan.mode,
    createdAt: plan.createdAt,
    repoRoot: plan.repoRoot,
    gitExecutable: plan.gitExecutable,
    observedHead: plan.observedHead,
    observedBranch: plan.observedBranch,
    observedStatusDigest: plan.observedStatusDigest,
    paths: plan.paths,
    message: plan.message,
    diff: plan.diff,
    reviewedManifest: plan.reviewedManifest,
    publish: plan.publish,
  }
}

function operationIdFor(plan) {
  return `operation-${hash(stableJson(planAuthority(plan)), 64)}`
}

function sameToken(left, right) {
  const first = Buffer.from(String(left || ''))
  const second = Buffer.from(String(right || ''))
  return first.length === second.length && crypto.timingSafeEqual(first, second)
}

function validateStoredPlan(plan, operationId, confirmation, currentAt = nowIso()) {
  const allowed = [
    'schema', 'operationId', 'mode', 'createdAt', 'repoRoot', 'gitExecutable',
    'observedHead', 'observedBranch', 'observedStatusDigest', 'paths', 'message',
    'diff', 'reviewedManifest', 'publish', 'confirmation',
  ]
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error(`commit plan not found: ${operationId}`)
  const unknown = Object.keys(plan).filter((key) => !allowed.includes(key))
  if (unknown.length) throw new Error(`commit plan contains unsupported fields: ${unknown.join(', ')}`)
  if (plan.schema !== ATELIER_COMMIT_PLAN_SCHEMA || plan.mode !== 'user-confirmed') throw new Error('commit plan schema or mode is unsupported')
  const createdMs = Date.parse(plan.createdAt)
  const currentMs = Date.parse(currentAt)
  if (!Number.isFinite(createdMs) || !Number.isFinite(currentMs)) throw new Error('commit plan timestamp is invalid')
  if (createdMs > currentMs + 60_000 || currentMs - createdMs > ATELIER_RUNTIME_PLAN_MAX_AGE_MS) throw new Error('commit plan expired; create a new commit plan')
  const expected = operationIdFor(plan)
  if (!sameToken(expected, operationId) || !sameToken(plan.operationId, operationId)) throw new Error('commit plan content does not match its operation id')
  if (plan.confirmation?.required !== true || !sameToken(plan.confirmation?.operationId, confirmation)) throw new Error('commit plan is not eligible for user-confirmed execution')
  const expectedInstruction = `Run atelier sync commit --operation ${operationId} --confirm ${operationId}`
  if (plan.confirmation?.instruction !== expectedInstruction) throw new Error('commit plan confirmation instruction is invalid')
  if (plan.repoRoot == null || !path.isAbsolute(plan.repoRoot) || !path.isAbsolute(plan.gitExecutable || '')) throw new Error('commit plan repository or Git identity is invalid')
  if (!Array.isArray(plan.paths) || !Array.isArray(plan.reviewedManifest)) throw new Error('commit plan path evidence is invalid')
  return plan
}

function stagedManifest(gitExecutable, root, selected) {
  return selected.map((itemPath) => {
    const result = runGit(gitExecutable, root, ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', itemPath])
    const records = result.stdout.split('\0').filter(Boolean)
    if (!records.length) return { path: itemPath, worktree: null }
    if (records.length !== 1) throw new Error(`staged path has unresolved index stages: ${itemPath}`)
    const match = records[0].match(/^(\d{6}) ([0-9a-f]{40,64}) 0\t/)
    if (!match) throw new Error(`staged path evidence is malformed: ${itemPath}`)
    return { path: itemPath, worktree: { mode: match[1], blob: match[2] } }
  })
}

function treeManifest(gitExecutable, root, tree, selected) {
  return selected.map((itemPath) => {
    const result = runGit(gitExecutable, root, ['--literal-pathspecs', 'ls-tree', '-z', tree, '--', itemPath])
    const records = result.stdout.split('\0').filter(Boolean)
    if (!records.length) return { path: itemPath, worktree: null }
    if (records.length !== 1) throw new Error(`reviewed tree path evidence is ambiguous: ${itemPath}`)
    const match = records[0].match(/^(\d{6}) blob ([0-9a-f]{40,64})\t/)
    if (!match) throw new Error(`reviewed tree path evidence is malformed: ${itemPath}`)
    return { path: itemPath, worktree: { mode: match[1], blob: match[2] } }
  })
}

function treeChangedPaths(gitExecutable, root, base, tree) {
  const result = runGit(gitExecutable, root, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', base, tree])
  return unique(result.stdout.split('\0').filter(Boolean).map(normalizePath)).sort((left, right) => left.localeCompare(right, 'en'))
}

function pruneAndBoundPlans(paths, currentAt) {
  const now = Date.parse(currentAt)
  if (!Number.isFinite(now)) throw new Error('commit plan timestamp is invalid')
  let inventory = runtimePlanInventory(paths.plans)
  for (const item of inventory.files) {
    let createdAt = item.mtimeMs
    try {
      const stored = readJsonIfPresent(item.file)
      const parsed = Date.parse(stored?.createdAt)
      if (Number.isFinite(parsed)) createdAt = parsed
    } catch {
      // Corrupt or redirected plan state fails closed below; it is never pruned as authority.
    }
    if (now - createdAt > ATELIER_RUNTIME_PLAN_MAX_AGE_MS) removeRuntimeLeaf(item.file)
  }
  inventory = runtimePlanInventory(paths.plans)
  if (inventory.files.length >= ATELIER_RUNTIME_PLAN_MAX_FILES || inventory.bytes >= ATELIER_RUNTIME_PLAN_MAX_BYTES) {
    throw new Error('runtime commit plan storage reached its resident ceiling; remove or consume existing plans')
  }
}

export function planUserConfirmedCommit({
  repoPath = process.cwd(),
  paths: selectedPaths,
  message,
  publish = false,
  fetchAttempts = 3,
  clock = nowIso,
} = {}) {
  const { enrollment, paths } = loadEnrollment(repoPath)
  const lock = acquireRepositoryLock(paths, { operation: 'plan-user-confirmed-commit', clock })
  if (!lock.ok) throw new Error('repository is busy with another Atelier operation')
  try {
    const control = readRuntimeControl(paths)
    if (control.paused) throw new Error(`repository is paused: ${control.reason || 'paused by user'}`)
    let observed = fullStateOrAttention(enrollment, clock)
    if (observed.attention) throw new Error(observed.attention.message)
    if (publish) {
      if (observed.observation.branch.ahead > 0) throw new Error('cannot prepare a publish plan while prior local commits are unpublished')
      const fetched = fetchWithRetries({ enrollment, attempts: fetchAttempts })
      if (!fetched.ok) throw new Error(`cannot prepare a publish plan because fetch failed: ${gitFailure(fetched.result)}`)
      observed = fullStateOrAttention(enrollment, clock)
      if (observed.attention) throw new Error(observed.attention.message)
    }
    const observation = observed.observation
    if (observation.status.conflictCount) throw new Error('cannot plan a commit while conflicts exist')
    if (observation.branch.ahead && observation.branch.behind) throw new Error('cannot plan a commit on a diverged branch')
    if (observation.branch.behind) throw new Error('cannot plan a commit while the branch is behind its upstream')
    if (publish && observation.branch.ahead > 0) throw new Error('cannot prepare a publish plan while prior local commits are unpublished')
    if (observation.status.stagedCount) throw new Error('pre-existing staged changes must be committed or unstaged before Atelier can prepare a bounded change set')
    const selected = validateSelectedPaths(selectedPaths, observation)
    const target = publishTarget(observation)
    if (publish && !target) throw new Error('publish was requested but the current branch has no supported upstream target')
    const commitMessage = cleanMessage(message)
    const createdAt = clock()
    pruneAndBoundPlans(paths, createdAt)
    const plan = {
      schema: ATELIER_COMMIT_PLAN_SCHEMA,
      mode: 'user-confirmed',
      createdAt,
      repoRoot: enrollment.repoRoot,
      gitExecutable: enrollment.git.executable,
      observedHead: observation.branch.head,
      observedBranch: observation.branch.branch,
      observedStatusDigest: observation.status.digest,
      paths: selected,
      message: commitMessage,
      diff: diffSummary(enrollment.git.executable, enrollment.repoRoot, selected),
      reviewedManifest: reviewedManifest(observation, selected),
      publish: publish ? target : null,
    }
    const operationId = operationIdFor(plan)
    plan.operationId = operationId
    plan.confirmation = {
        required: true,
        operationId,
        instruction: `Run atelier sync commit --operation ${operationId} --confirm ${operationId}`,
    }
    const encodedBytes = Buffer.byteLength(`${JSON.stringify(plan, null, 2)}\n`)
    const inventory = runtimePlanInventory(paths.plans)
    if (encodedBytes > ATELIER_RUNTIME_PLAN_MAX_BYTES || inventory.bytes + encodedBytes > ATELIER_RUNTIME_PLAN_MAX_BYTES) {
      throw new Error('runtime commit plan storage would exceed its resident byte ceiling')
    }
    atomicWriteJson(path.join(paths.plans, `${operationId}.json`), plan)
    trace(paths, { operation: 'commit-plan-created', operationId, outcome: 'awaiting-user-confirmation', mode: 'user-confirmed', details: { paths: selected, publish: Boolean(plan.publish) } }, clock)
    return { ok: true, plan }
  } finally {
    lock.release()
  }
}

function projectBoundaryCheck(enrollment) {
  if (!enrollment.projectConfig) return { ok: true, configured: false, report: null }
  const project = commandProject({ argv: ['--project', enrollment.projectConfig], cwd: enrollment.repoRoot, gitExecutable: enrollment.git.executable })
  const scannedRepoRoots = (project.repos || [])
    .filter((repo) => !repo.external && repo.path)
    .map((repo) => {
      try { return fs.realpathSync.native ? fs.realpathSync.native(repo.path) : fs.realpathSync(repo.path) } catch { return path.resolve(repo.path) }
    })
  if (!scannedRepoRoots.includes(enrollment.repoRoot)) {
    return { ok: false, configured: true, scannedRepoRoots, report: { errors: [{ code: 'boundary-scope-mismatch', message: 'configured boundary policy does not include the enrolled repository' }] } }
  }
  const loaded = loadBoundaryPolicy(project)
  if (!loaded.ok) return { ok: false, configured: true, scannedRepoRoots, report: { errors: loaded.errors.map((message) => ({ code: 'boundary-policy-missing', message })) } }
  const report = checkBoundaryPolicy({
    project,
    policy: loaded.policy,
    staged: true,
    stagedOnly: true,
    gitExecutable: enrollment.git.executable,
    allowNetworkActorResolution: false,
    forceActorErrors: true,
  })
  return { ok: report.ok, configured: true, scannedRepoRoots, report }
}

function restoreIndex(gitExecutable, root) {
  runGit(gitExecutable, root, ['reset', '--mixed', '--quiet', 'HEAD'], { allowFailure: true })
}

function normalizeCommitMessage(value) {
  return String(value || '').replaceAll('\r\n', '\n').replace(/\n+$/, '')
}

function rollbackCommit(gitExecutable, root, priorHead, createdCommit) {
  const rolledBack = runGit(gitExecutable, root, ['update-ref', 'HEAD', priorHead, createdCommit], { allowFailure: true })
  if (!rolledBack.ok) return false
  restoreIndex(gitExecutable, root)
  return true
}

export function executeUserConfirmedCommit({ repoPath = process.cwd(), operationId, confirmation, clock = nowIso } = {}) {
  if (!/^operation-[0-9a-f]{64}$/.test(String(operationId || '')) || !sameToken(confirmation, operationId)) throw new Error('exact operation confirmation token is required')
  const { enrollment, paths } = loadEnrollment(repoPath)
  const planFile = path.join(paths.plans, `${operationId}.json`)
  const lock = acquireRepositoryLock(paths, { operation: `execute-${operationId}`, clock })
  if (!lock.ok) throw new Error('repository is busy with another Atelier operation')
  let staged = false
  try {
    const executionAt = clock()
    const plan = validateStoredPlan(readJsonIfPresent(planFile), operationId, confirmation, executionAt)
    if (plan.repoRoot !== enrollment.repoRoot || plan.gitExecutable !== enrollment.git.executable) throw new Error('commit plan does not match the current enrollment')
    const control = readRuntimeControl(paths)
    if (control.paused) throw new Error(`repository is paused: ${control.reason || 'paused by user'}`)
    const observed = fullStateOrAttention(enrollment, clock)
    if (observed.attention) throw new Error(observed.attention.message)
    const observation = observed.observation
    if (observation.branch.head !== plan.observedHead || observation.branch.branch !== plan.observedBranch || observation.status.digest !== plan.observedStatusDigest) {
      throw new Error('repository changed after review; create a new commit plan')
    }
    if (observation.status.stagedCount) throw new Error('repository gained staged changes after review; create a new commit plan')
    validateSelectedPaths(plan.paths, observation)
    if (plan.publish && stableJson(publishTarget(observation)) !== stableJson(plan.publish)) throw new Error('publish target changed after review; create a new commit plan')
    staged = true
    runGit(enrollment.git.executable, enrollment.repoRoot, ['--literal-pathspecs', 'add', '--', ...plan.paths])
    const stagedObservation = observeRepository({ repoRoot: enrollment.repoRoot, gitExecutable: enrollment.git.executable, observedAt: clock() })
    const actualStaged = stagedPaths(stagedObservation)
    const expectedStaged = unique(plan.paths).sort((a, b) => a.localeCompare(b, 'en'))
    if (JSON.stringify(actualStaged) !== JSON.stringify(expectedStaged)) {
      throw new Error(`staged change set does not match the reviewed plan: expected ${expectedStaged.join(', ')}, got ${actualStaged.join(', ')}`)
    }
    const actualManifest = stagedManifest(enrollment.git.executable, enrollment.repoRoot, expectedStaged)
    if (stableJson(actualManifest) !== stableJson(plan.reviewedManifest)) throw new Error('staged bytes or modes do not match the reviewed plan')
    const boundary = projectBoundaryCheck(enrollment)
    if (!boundary.ok) {
      const messages = (boundary.report?.errors || []).map((item) => item.message).join('; ')
      throw new Error(`boundary validation refused the commit: ${messages || 'unknown boundary failure'}`)
    }
    const expectedTree = runGit(enrollment.git.executable, enrollment.repoRoot, ['write-tree']).stdout.trim()
    const expectedTreePaths = treeChangedPaths(enrollment.git.executable, enrollment.repoRoot, plan.observedHead, expectedTree)
    if (JSON.stringify(expectedTreePaths) !== JSON.stringify(expectedStaged)) {
      throw new Error(`reviewed tree change set drifted before commit: expected ${expectedStaged.join(', ')}, got ${expectedTreePaths.join(', ')}`)
    }
    const expectedTreeManifest = treeManifest(enrollment.git.executable, enrollment.repoRoot, expectedTree, expectedStaged)
    if (stableJson(expectedTreeManifest) !== stableJson(plan.reviewedManifest)) throw new Error('reviewed tree bytes or modes drifted before commit')
    const committed = runGit(enrollment.git.executable, enrollment.repoRoot, ['commit', '-m', plan.message], { allowFailure: true, allowPrompt: true })
    if (!committed.ok) {
      const headAfterFailure = runGit(enrollment.git.executable, enrollment.repoRoot, ['rev-parse', 'HEAD'], { allowFailure: true }).stdout.trim()
      if (headAfterFailure && headAfterFailure !== plan.observedHead) {
        const rolledBack = rollbackCommit(enrollment.git.executable, enrollment.repoRoot, plan.observedHead, headAfterFailure)
        staged = false
        if (!rolledBack) {
          const state = attentionState('commit-rollback-failed', 'Git commit failed after HEAD moved and automatic rollback could not prove recovery', null, { operationId, headAfterFailure })
          persistState(paths, state, clock)
          throw new Error('Git commit failed after HEAD moved; automatic rollback failed and repository attention is required')
        }
        throw new Error('Git hook moved HEAD while the reviewed commit failed; the unexpected commit was rolled back')
      }
      throw new Error(`Git commit failed: ${gitFailure(committed)}`)
    }
    const commit = runGit(enrollment.git.executable, enrollment.repoRoot, ['rev-parse', 'HEAD']).stdout.trim()
    const committedTree = runGit(enrollment.git.executable, enrollment.repoRoot, ['rev-parse', `${commit}^{tree}`]).stdout.trim()
    const parentFields = runGit(enrollment.git.executable, enrollment.repoRoot, ['rev-list', '--parents', '-n', '1', commit]).stdout.trim().split(/\s+/)
    const committedMessage = runGit(enrollment.git.executable, enrollment.repoRoot, ['show', '-s', '--format=%B', commit]).stdout
    const postCommitFailures = []
    if (committedTree !== expectedTree) postCommitFailures.push('tree')
    if (parentFields.length !== 2 || parentFields[1] !== plan.observedHead) postCommitFailures.push('parent')
    if (normalizeCommitMessage(committedMessage) !== normalizeCommitMessage(plan.message)) postCommitFailures.push('message')
    if (postCommitFailures.length) {
      const rolledBack = rollbackCommit(enrollment.git.executable, enrollment.repoRoot, plan.observedHead, commit)
      staged = false
      if (!rolledBack) {
        const state = attentionState('commit-rollback-failed', 'Git altered reviewed commit authority and automatic rollback could not prove recovery', null, { operationId, commit, failures: postCommitFailures })
        persistState(paths, state, clock)
        throw new Error(`Git altered reviewed commit ${postCommitFailures.join(', ')}; automatic rollback failed and repository attention is required`)
      }
      throw new Error(`Git hook or concurrent change altered the reviewed commit ${postCommitFailures.join(', ')}; commit was rolled back`)
    }
    staged = false
    trace(paths, { operation: 'commit-created', operationId, outcome: 'committed', mode: 'user-confirmed', details: { commit, paths: plan.paths, boundaryConfigured: boundary.configured, boundaryRepoRoots: boundary.scannedRepoRoots || [] } }, clock)
    let publish = null
    if (plan.publish) {
      const beforePublish = fullStateOrAttention(enrollment, clock)
      if (beforePublish.attention) throw new Error(`repository became incomplete before publish: ${beforePublish.attention.message}`)
      if (stableJson(publishTarget(beforePublish.observation)) !== stableJson(plan.publish)) throw new Error('publish target changed after review; commit remains local and was not published')
      if (beforePublish.observation.branch.head !== commit) throw new Error('repository HEAD changed after the reviewed commit; commit remains local and was not published')
      const pushDestination = currentPushDestination(enrollment, plan.publish.remote)
      const sanitizedPushDestination = sanitizeRemoteUrl(pushDestination)
      const executionTarget = {
        remote: plan.publish.remote,
        branch: plan.publish.branch,
        url: sanitizedPushDestination,
        identityDigest: crypto.createHash('sha256').update(sanitizedPushDestination).digest('hex'),
        authentication: classifyRemoteAuthentication(pushDestination),
      }
      if (stableJson(executionTarget) !== stableJson(plan.publish)) throw new Error('publish target changed at execution; commit remains local and was not published')
      const pushed = runGit(enrollment.git.executable, enrollment.repoRoot, ['push', '--no-follow-tags', '--recurse-submodules=no', '--', pushDestination, `${commit}:refs/heads/${plan.publish.branch}`], { allowFailure: true, allowPrompt: true, timeout: 120_000 })
      publish = { ok: pushed.ok, remote: plan.publish.remote, branch: plan.publish.branch, error: pushed.ok ? null : gitFailure(pushed) }
      trace(paths, { operation: 'commit-publish', operationId, outcome: pushed.ok ? 'published' : 'attention', mode: 'user-confirmed', details: { commit, ...publish } }, clock)
      if (!pushed.ok) {
        const observationAfterCommit = observeRepository({ repoRoot: enrollment.repoRoot, gitExecutable: enrollment.git.executable, observedAt: clock() })
        const state = attentionState('publish-failed', 'commit was created locally but Git push failed', observationAfterCommit, publish)
        persistState(paths, state, clock)
        return { ok: false, committed: true, commit, publish, state }
      }
    }
    const final = fullStateOrAttention(enrollment, clock)
    const state = final.attention || healthyState(plan.publish ? 'committed-and-published' : 'committed-locally', plan.publish ? 'reviewed change set was committed and published' : 'reviewed change set was committed locally', final.observation, { operationId, commit })
    persistState(paths, state, clock)
    return { ok: state.status !== 'attention', committed: true, commit, publish, state }
  } catch (error) {
    if (staged) restoreIndex(enrollment.git.executable, enrollment.repoRoot)
    trace(paths, { operation: 'commit-execution', operationId, outcome: 'refused', mode: 'user-confirmed', details: { reason: redactGitDiagnostic(error.message) } }, clock)
    throw error
  } finally {
    try {
      removeRuntimeLeaf(planFile)
    } finally {
      lock.release()
    }
  }
}

export function setRepositoryPaused({ repoPath = process.cwd(), paused, reason = null, clock = nowIso } = {}) {
  const { paths } = loadEnrollment(repoPath)
  const lock = acquireRepositoryLock(paths, { operation: paused ? 'pause' : 'resume', clock })
  if (!lock.ok) throw new Error('repository is busy with another Atelier operation')
  try {
    const control = writeRuntimeControl(paths, { paused, reason, updatedAt: clock() })
    const state = paused ? pausedState(control) : healthyState('resumed', 'repository supervision resumed', null)
    persistState(paths, state, clock)
    trace(paths, { operation: paused ? 'pause' : 'resume', outcome: state.status, details: { reason: control.reason } }, clock)
    return { ok: true, control, state }
  } finally {
    lock.release()
  }
}

export function operationTrace({ repoPath = process.cwd() } = {}) {
  const { paths } = loadEnrollment(repoPath)
  return readOperationTrace(paths.trace)
}
