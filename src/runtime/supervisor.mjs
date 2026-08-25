import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { checkBoundaryPolicy, loadBoundaryPolicy } from '../boundary/policy.mjs'
import { commandProject } from '../project/config.mjs'
import { inspectGitEngine, redactGitDiagnostic, resolveGitExecutable, runGit } from './git-adapter.mjs'
import {
  ATELIER_RUNTIME_ENROLLMENT_SCHEMA,
  acquireRepositoryLock,
  appendOperationTrace,
  atomicWriteJson,
  ensureRuntimeStateRoot,
  readJsonIfPresent,
  readOperationTrace,
  readRuntimeControl,
  runtimePaths,
  writeRuntimeControl,
  writeRuntimeState,
} from './local-state.mjs'
import { observeRepository, resolveRepositoryRoot } from './repository-observation.mjs'

export const ATELIER_COMMIT_PLAN_SCHEMA = 'atelier-commit-plan@v1'

function nowIso() {
  return new Date().toISOString()
}

function hash(value, length = 32) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length)
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
  return writeRuntimeState(paths, { ...state, updatedAt: clock() })
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
  const git = gitExecutable || resolveGitExecutable()
  const resolved = resolveRepositoryRoot(repoPath, git)
  if (!resolved.ok) throw new Error(resolved.error || `unsupported repository root: ${resolved.filesystem?.code || 'unknown'}`)
  const paths = ensureRuntimeStateRoot(resolved.root, git)
  const observation = observeRepository({ repoRoot: resolved.root, gitExecutable: git, observedAt: clock() })
  if (observation.bare) throw new Error('bare repositories cannot be enrolled')
  const engine = inspectGitEngine(git)
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
}

export function loadEnrollment(repoPath = process.cwd()) {
  let root = path.resolve(repoPath)
  try {
    root = fs.realpathSync.native(root)
  } catch {
    root = fs.realpathSync(root)
  }
  const paths = runtimePaths(root)
  const enrollment = readJsonIfPresent(paths.enrollment)
  if (!enrollment) throw new Error(`repository is not enrolled: ${root}`)
  if (enrollment.schema !== ATELIER_RUNTIME_ENROLLMENT_SCHEMA) throw new Error('runtime enrollment schema is unsupported')
  if (path.resolve(enrollment.repoRoot) !== root) throw new Error('runtime enrollment root does not match the requested repository')
  if (!path.isAbsolute(enrollment.git?.executable || '')) throw new Error('runtime enrollment does not pin an absolute Git executable')
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
  return { ok: state.status !== 'attention', enrollment, control, state, traceLength: readOperationTrace(paths.trace).length }
}

function fetchWithRetries({ enrollment, attempts = 3 }) {
  let last = null
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
    last = runGit(enrollment.git.executable, enrollment.repoRoot, ['fetch', '--prune'], { allowFailure: true, timeout: 60_000 })
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
    url: remote.url,
    identityDigest: remote.identityDigest,
    authentication: remote.authentication,
  }
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

function validateStoredPlan(plan, operationId, confirmation) {
  const allowed = [
    'schema', 'operationId', 'mode', 'createdAt', 'repoRoot', 'gitExecutable',
    'observedHead', 'observedBranch', 'observedStatusDigest', 'paths', 'message',
    'diff', 'reviewedManifest', 'publish', 'confirmation',
  ]
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error(`commit plan not found: ${operationId}`)
  const unknown = Object.keys(plan).filter((key) => !allowed.includes(key))
  if (unknown.length) throw new Error(`commit plan contains unsupported fields: ${unknown.join(', ')}`)
  if (plan.schema !== ATELIER_COMMIT_PLAN_SCHEMA || plan.mode !== 'user-confirmed') throw new Error('commit plan schema or mode is unsupported')
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
    const result = runGit(gitExecutable, root, ['ls-files', '--stage', '-z', '--', itemPath])
    const records = result.stdout.split('\0').filter(Boolean)
    if (!records.length) return { path: itemPath, worktree: null }
    if (records.length !== 1) throw new Error(`staged path has unresolved index stages: ${itemPath}`)
    const match = records[0].match(/^(\d{6}) ([0-9a-f]{40,64}) 0\t/)
    if (!match) throw new Error(`staged path evidence is malformed: ${itemPath}`)
    return { path: itemPath, worktree: { mode: match[1], blob: match[2] } }
  })
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
    if (publish) {
      const fetched = fetchWithRetries({ enrollment, attempts: fetchAttempts })
      if (!fetched.ok) throw new Error(`cannot prepare a publish plan because fetch failed: ${gitFailure(fetched.result)}`)
    }
    const observed = fullStateOrAttention(enrollment, clock)
    if (observed.attention) throw new Error(observed.attention.message)
    const observation = observed.observation
    if (observation.status.conflictCount) throw new Error('cannot plan a commit while conflicts exist')
    if (observation.branch.behind) throw new Error('cannot plan a commit while the branch is behind its upstream')
    if (observation.branch.ahead && observation.branch.behind) throw new Error('cannot plan a commit on a diverged branch')
    if (observation.status.stagedCount) throw new Error('pre-existing staged changes must be committed or unstaged before Atelier can prepare a bounded change set')
    const selected = validateSelectedPaths(selectedPaths, observation)
    const target = publishTarget(observation)
    if (publish && !target) throw new Error('publish was requested but the current branch has no supported upstream target')
    const commitMessage = cleanMessage(message)
    const plan = {
      schema: ATELIER_COMMIT_PLAN_SCHEMA,
      mode: 'user-confirmed',
      createdAt: clock(),
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
    atomicWriteJson(path.join(paths.plans, `${operationId}.json`), plan)
    trace(paths, { operation: 'commit-plan-created', operationId, outcome: 'awaiting-user-confirmation', mode: 'user-confirmed', details: { paths: selected, publish: Boolean(plan.publish) } }, clock)
    return { ok: true, plan }
  } finally {
    lock.release()
  }
}

function projectBoundaryCheck(enrollment) {
  if (!enrollment.projectConfig) return { ok: true, configured: false, report: null }
  const project = commandProject({ argv: ['--project', enrollment.projectConfig], cwd: enrollment.repoRoot })
  const loaded = loadBoundaryPolicy(project)
  if (!loaded.ok) return { ok: false, configured: true, report: { errors: loaded.errors.map((message) => ({ code: 'boundary-policy-missing', message })) } }
  const report = checkBoundaryPolicy({ project, policy: loaded.policy, staged: true, stagedOnly: true })
  return { ok: report.ok, configured: true, report }
}

function unstage(gitExecutable, root, selected) {
  const reset = runGit(gitExecutable, root, ['--literal-pathspecs', 'reset', '--quiet', 'HEAD', '--', ...selected], { allowFailure: true })
  if (reset.ok) return
  runGit(gitExecutable, root, ['--literal-pathspecs', 'rm', '--cached', '--ignore-unmatch', '--', ...selected], { allowFailure: true })
}

function restoreIndex(gitExecutable, root) {
  runGit(gitExecutable, root, ['reset', '--mixed', '--quiet', 'HEAD'], { allowFailure: true })
}

export function executeUserConfirmedCommit({ repoPath = process.cwd(), operationId, confirmation, clock = nowIso } = {}) {
  if (!/^operation-[0-9a-f]{64}$/.test(String(operationId || '')) || !sameToken(confirmation, operationId)) throw new Error('exact operation confirmation token is required')
  const { enrollment, paths } = loadEnrollment(repoPath)
  const planFile = path.join(paths.plans, `${operationId}.json`)
  const plan = validateStoredPlan(readJsonIfPresent(planFile), operationId, confirmation)
  if (plan.repoRoot !== enrollment.repoRoot || plan.gitExecutable !== enrollment.git.executable) throw new Error('commit plan does not match the current enrollment')
  const lock = acquireRepositoryLock(paths, { operation: `execute-${operationId}`, clock })
  if (!lock.ok) throw new Error('repository is busy with another Atelier operation')
  let staged = false
  try {
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
    runGit(enrollment.git.executable, enrollment.repoRoot, ['--literal-pathspecs', 'add', '--', ...plan.paths])
    staged = true
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
    const committed = runGit(enrollment.git.executable, enrollment.repoRoot, ['commit', '-m', plan.message], { allowFailure: true, allowPrompt: true })
    if (!committed.ok) throw new Error(`Git commit failed: ${gitFailure(committed)}`)
    const commit = runGit(enrollment.git.executable, enrollment.repoRoot, ['rev-parse', 'HEAD']).stdout.trim()
    const committedTree = runGit(enrollment.git.executable, enrollment.repoRoot, ['rev-parse', `${commit}^{tree}`]).stdout.trim()
    if (committedTree !== expectedTree) {
      runGit(enrollment.git.executable, enrollment.repoRoot, ['update-ref', 'HEAD', plan.observedHead, commit])
      restoreIndex(enrollment.git.executable, enrollment.repoRoot)
      staged = false
      throw new Error('Git hook or concurrent index change altered the reviewed commit tree; commit was rolled back')
    }
    staged = false
    trace(paths, { operation: 'commit-created', operationId, outcome: 'committed', mode: 'user-confirmed', details: { commit, paths: plan.paths, boundaryConfigured: boundary.configured } }, clock)
    let publish = null
    if (plan.publish) {
      const beforePublish = fullStateOrAttention(enrollment, clock)
      if (beforePublish.attention) throw new Error(`repository became incomplete before publish: ${beforePublish.attention.message}`)
      if (stableJson(publishTarget(beforePublish.observation)) !== stableJson(plan.publish)) throw new Error('publish target changed after review; commit remains local and was not published')
      const pushed = runGit(enrollment.git.executable, enrollment.repoRoot, ['push', plan.publish.remote, `HEAD:refs/heads/${plan.publish.branch}`], { allowFailure: true, allowPrompt: true, timeout: 120_000 })
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
    lock.release()
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
