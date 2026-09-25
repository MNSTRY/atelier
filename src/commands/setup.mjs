#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import {
  LOCAL_OVERLAY_SCHEMA,
  LOCAL_STATE_DIR,
  commandProject,
  ensureLocalState,
  firstString,
  parseArgs,
  resolveProjectConfig,
  validateProjectConfigDoc,
  writeJson,
} from '../project/config.mjs'
import { writeAtelierLock, loadAtelierLock, checkAtelierLock } from '../upgrade/upgrade.mjs'
import { loadBoundaryPolicy, validateBoundaryPolicy } from '../boundary/policy.mjs'
import { auditRepoIdentities } from '../project/repo-identity.mjs'
import {
  DEFAULT_ENROLLMENT_AUDIENCE,
  assertAudienceAllowed,
  assertEnrollmentAudience,
  enrollmentReport,
  planDocumentEnrollment,
  writeDocumentEnrollment,
} from '../graph/enroll.mjs'

const PROFILE_SET = new Set(['single-repo', 'private-domain', 'shared-project', 'multi-repo', 'monorepo', 'control-workspace'])
const IGNORE_LINES = [
  '.atelier-local/',
  'atelier.local.json',
  'atelier.workspace.local.json',
  'atelier-attestation-key.local.json',
  '.mnstry-local/',
  '.atelier-proposals/',
  '.atelier-current',
  '.atelier-current.json',
  '.atelier-presence.json',
  '.atelier-nonce',
  '.atelier-capability-grants.json',
  '.atelier-events.jsonl',
  '.atelier-audit.jsonl',
  '.atelier-session.json',
  '.atelier-session.jsonl',
  '.atelier-sessions/',
  '.atelier-support/',
  'atelier-output/',
  'support-bundle*',
  'support-bundles/',
  'transcripts/',
  'prompts/',
  'node_modules/',
  'npm-debug.log*',
  '.DS_Store',
]

function slug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'atelier-project'
}

function appendIgnoreLines(root) {
  const file = path.join(root, '.gitignore')
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const lines = new Set(existing.split('\n').map((line) => line.trim()).filter(Boolean))
  const missing = IGNORE_LINES.filter((line) => !lines.has(line))
  if (!missing.length) return { file, changed: false, added: [] }
  const prefix = existing && !existing.endsWith('\n') ? '\n' : ''
  fs.appendFileSync(file, `${prefix}${missing.join('\n')}\n`)
  return { file, changed: true, added: missing }
}

function localOverlayFor(project) {
  const repos = {}
  for (const repo of project.repos ?? []) {
    if (!repo.name || !repo.path) continue
    repos[repo.name] = {
      path: path.relative(project.configDir, repo.path).split(path.sep).join('/') || '.',
      pathSource: repo.pathSource || 'tracked-config',
    }
  }
  return {
    schema: LOCAL_OVERLAY_SCHEMA,
    generatedBy: 'atelier setup',
    generatedAt: new Date().toISOString(),
    repos,
  }
}

function writeLocalOverlay(project, { dryRun = false } = {}) {
  const root = path.join(project.configDir, LOCAL_STATE_DIR)
  const file = path.join(root, 'workspace.json')
  const overlay = localOverlayFor(project)
  if (!dryRun) {
    fs.mkdirSync(root, { recursive: true })
    writeJson(file, overlay)
  }
  return { file, overlay, wrote: !dryRun }
}

function runSetup(argv) {
  const args = parseArgs(argv)
  const dryRun = Boolean(args['dry-run'])
  const repair = Boolean(args.yes || args.fix || args._[0] === 'doctor')
  const project = commandProject({ argv })
  let ignore = { changed: false, added: [] }
  let state = ensureLocalState(project, { write: false })
  if (!state.ignored && repair && !dryRun) {
    ignore = appendIgnoreLines(project.configDir)
    state = ensureLocalState(project, { write: false })
  }
  if (!state.ignored) {
    console.error(`Atelier local state is not ignored at ${state.root}`)
    console.error('Run: atelier setup --yes --project ./atelier.project.json')
    process.exit(1)
  }
  if (!dryRun) state = ensureLocalState(project, { write: true })
  const overlay = writeLocalOverlay(project, { dryRun })
  const report = {
    ok: true,
    command: 'setup',
    dryRun,
    configPath: project.configPath,
    localState: state,
    ignore,
    overlay,
    repos: project.repos.map((repo) => ({ name: repo.name, path: repo.path, pathSource: repo.pathSource })),
  }
  console.log(JSON.stringify(report, null, 2))
}

function baseBoundaryPolicy({ repoName, profile, actor }) {
  const shared = profile === 'shared-project'
  const privateDomain = shared
    ? (repoName === `${actor}-private` ? `${actor}-private-domain` : `${actor}-private`)
    : repoName
  return {
    schema: 'mnstry.atelier-boundary-policy@v1',
    mode: 'strict',
    actors: {
      [actor]: {
        githubLogin: `${actor.toUpperCase()}_GITHUB_LOGIN_PLACEHOLDER`,
        gitEmails: [`${actor}@example.invalid`],
        privateDomainRepo: privateDomain,
      },
    },
    repos: {
      ...(shared ? { [privateDomain]: {
        kind: 'private_domain', ownerActor: actor, readBoundary: 'private',
        allowedAudiences: ['private', 'sensitive', 'team', 'operator', 'staff', 'public'],
        forbiddenAudiences: [], autoCommit: 'guarded',
      } } : {}),
      [repoName]: {
        kind: shared ? 'shared' : 'private_domain',
        ownerActor: shared ? undefined : actor,
        readBoundary: shared ? 'team' : 'private',
        allowedAudiences: shared ? ['team', 'operator', 'staff', 'public'] : ['private', 'sensitive', 'team', 'operator', 'staff', 'public'],
        forbiddenAudiences: shared ? ['private', 'sensitive'] : [],
        autoCommit: 'guarded',
      },
    },
    promotion: {
      requiresGitPromote: true,
      recordsPath: 'governance/git-promote-events.jsonl',
    },
    forbiddenPaths: [
      '.atelier-local/**',
      'atelier.local.json',
      'atelier.workspace.local.json',
      'atelier-attestation-key.local.json',
      '.mnstry-local/**',
      '.atelier-proposals/**',
      'support-bundles/**',
      'prompts/**',
      'transcripts/**',
    ],
    governanceLedgerPath: 'governance/repo-boundary-ledger.md',
  }
}

function cleanUndefined(value) {
  if (Array.isArray(value)) return value.map(cleanUndefined)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, cleanUndefined(item)]))
  }
  return value
}

function runAdopt(argv) {
  const args = parseArgs(argv)
  const target = path.resolve(firstString(args.target) || process.cwd())
  const profile = firstString(args.profile, args.template) || 'single-repo'
  if (!PROFILE_SET.has(profile)) throw new Error(`unsupported Atelier setup profile: ${profile}`)
  if (profile === 'monorepo' && !firstString(args.include, args.includes)) {
    throw new Error('monorepo adopt requires --include so Atelier does not scan the whole repo by accident')
  }
  const repoName = slug(firstString(args.name) || path.basename(target))
  const actor = slug(firstString(args.actor) || process.env.USER || 'owner')
  if (typeof args['enroll-documents'] === 'string') throw new Error('--enroll-documents takes no value')
  const enrollDocuments = args['enroll-documents'] === true
  const audience = args.audience === undefined ? DEFAULT_ENROLLMENT_AUDIENCE : args.audience
  if (args.audience !== undefined && !enrollDocuments) throw new Error('--audience applies only with --enroll-documents')
  if (enrollDocuments) assertEnrollmentAudience(audience)
  const include = firstString(args.include, args.includes)
  const exclude = firstString(args.exclude, args.excludes)
  const projectPath = path.join(target, 'atelier.project.json')
  const existingProject = fs.existsSync(projectPath)
    ? resolveProjectConfig({ cwd: target, argv: ['--project', projectPath], writeLocalState: false }) : null
  const proposedConfig = existingProject?.config || {
    schema: 'mnstry.atelier-project-config@v1',
    name: repoName,
    roots: { workspace: '.', repoOps: '.' },
    graph: { repoAccessPath: 'repo-access.v1.json', outputPath: 'atelier-output/knowledge.graph.json' },
    projection: { outputRoot: 'atelier-output', readinessPath: 'atelier-output/atelier-readiness.json' },
    boundaries: { policyPath: 'boundary-policy.v1.json', governanceLedgerPath: 'governance/repo-boundary-ledger.md', strictNewRepos: true },
    setup: { profile, ...(include ? { include } : {}), ...(exclude ? { exclude } : {}) },
    repos: [{ name: repoName, path: '.', readBoundary: profile === 'shared-project' ? 'team' : 'private', role: profile }],
  }
  const configErrors = validateProjectConfigDoc(proposedConfig)
  if (configErrors.length) throw new Error(`adopt requires a valid project config: ${configErrors.join('; ')}`)
  const proposedProject = existingProject || { configDir: target, config: proposedConfig, repos: proposedConfig.repos }
  // Parse and validate retained state before any scaffold or overlay writes.
  const prior = loadAtelierLock(existingProject || { configDir: target })
  if (fs.existsSync(prior.lockPath) && !prior.lock) throw new Error('existing lock must contain a valid lock object')
  if (prior.lock && !existingProject) throw new Error('existing lock requires an existing project configuration')
  const priorPolicy = loadBoundaryPolicy(proposedProject)
  if (existingProject || fs.existsSync(priorPolicy.policyPath)) {
    if (!priorPolicy.ok) throw new Error(`adopt requires a valid boundary policy: ${priorPolicy.errors.join('; ')}`)
  }
  const proposedPolicy = priorPolicy.ok ? priorPolicy.policy : cleanUndefined(baseBoundaryPolicy({ repoName, profile, actor }))
  const proposedPolicyErrors = validateBoundaryPolicy(proposedPolicy, proposedProject)
  if (proposedPolicyErrors.length) throw new Error(`adopt requires a valid boundary policy: ${proposedPolicyErrors.join('; ')}`)
  // An audience the policy would refuse is refused before any scaffold write.
  if (enrollDocuments) {
    assertAudienceAllowed({ policy: proposedPolicy, repoNames: (proposedProject.repos ?? []).map((repo) => repo.name), audience })
  }
  if (prior.lock) {
    const report = checkAtelierLock(existingProject)
    if (!report.ok) throw new Error(`adopt cannot accept existing lock drift: ${report.errors.join('; ')}`)
  }
  fs.mkdirSync(target, { recursive: true })
  appendIgnoreLines(target)
  if (!existingProject) writeJson(projectPath, proposedConfig)
  if (!fs.existsSync(path.join(target, 'repo-access.v1.json'))) {
    writeJson(path.join(target, 'repo-access.v1.json'), {
      schema: 'mnstry.atelier-repo-access@v1',
      defaultReadBoundary: profile === 'shared-project' ? 'team' : 'private',
      repos: { [repoName]: { readBoundary: profile === 'shared-project' ? 'team' : 'private' } },
    })
  }
  if (!fs.existsSync(path.join(target, 'boundary-policy.v1.json'))) {
    writeJson(path.join(target, 'boundary-policy.v1.json'), cleanUndefined(baseBoundaryPolicy({ repoName, profile, actor })))
  }
  const project = resolveProjectConfig({ cwd: target, argv: ['--project', projectPath] })
  const loadedPolicy = loadBoundaryPolicy(project)
  const policyErrors = loadedPolicy.ok ? validateBoundaryPolicy(loadedPolicy.policy, project) : loadedPolicy.errors
  if (policyErrors.length) throw new Error(`adopt requires a valid boundary policy: ${policyErrors.join('; ')}`)
  ensureLocalState(project, { write: true })
  writeLocalOverlay(project)
  // Adoption creates the first lock, but never accepts drift in an existing one.
  const { lockPath } = loadAtelierLock(project)
  if (!fs.existsSync(lockPath)) writeAtelierLock({ project, templateId: `adopt:${profile}` })
  const lockReport = checkAtelierLock(project)
  if (!lockReport.ok) throw new Error(`adopt lock check failed: ${lockReport.errors.join('; ')}`)
  const enrollment = enrollDocuments ? enrollmentReport(writeDocumentEnrollment(planDocumentEnrollment(project, { audience }))) : null
  console.log(JSON.stringify({ ok: true, command: 'adopt', profile, target, projectPath, ...(enrollment ? { enrollment } : {}) }, null, 2))
}

function runDoctor(argv) {
  const args = parseArgs(argv)
  const project = commandProject({ argv })
  const dryRun = Boolean(args['dry-run'])
  const fix = Boolean(args.fix)
  const stateBefore = ensureLocalState(project, { write: false })
  let setup = null
  if (fix) {
    runSetup(['--project', project.configPath, '--yes', ...(dryRun ? ['--dry-run'] : [])])
    return
  }
  setup = { localState: stateBefore }
  const identity = auditRepoIdentities(project)
  const ok = stateBefore.ignored && identity.ok
  console.log(JSON.stringify({
    ok,
    command: 'doctor',
    configPath: project.configPath,
    repos: project.repos.map((repo) => ({ name: repo.name, path: repo.path, pathSource: repo.pathSource, external: Boolean(repo.external) })),
    identity,
    setup,
  }, null, 2))
  process.exit(ok ? 0 : 1)
}

const argv = process.argv.slice(2)
const args = parseArgs(argv)
const subcommand = args._[0] || 'setup'
try {
  if (subcommand === 'setup') runSetup(argv.filter((arg) => arg !== 'setup'))
  else if (subcommand === 'adopt') runAdopt(argv.filter((arg) => arg !== 'adopt'))
  else if (subcommand === 'doctor') runDoctor(argv.filter((arg) => arg !== 'doctor'))
  else throw new Error(`unknown setup command: ${subcommand}`)
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
