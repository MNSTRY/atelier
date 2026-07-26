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
  writeJson,
} from '../project/config.mjs'
import { auditRepoIdentities } from '../project/repo-identity.mjs'

const PROFILE_SET = new Set(['single-repo', 'private-domain', 'shared-project', 'multi-repo', 'monorepo', 'control-workspace'])
const IGNORE_LINES = [
  '.atelier-local/',
  'atelier.local.json',
  'atelier.workspace.local.json',
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
  const privateDomain = profile === 'shared-project' ? `${actor}-private` : repoName
  const shared = profile === 'shared-project'
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
  fs.mkdirSync(target, { recursive: true })
  appendIgnoreLines(target)
  const repoName = slug(firstString(args.name) || path.basename(target))
  const actor = slug(firstString(args.actor) || process.env.USER || 'owner')
  const projectPath = path.join(target, 'atelier.project.json')
  if (!fs.existsSync(projectPath)) {
    writeJson(projectPath, {
      schema: 'mnstry.atelier-project-config@v1',
      name: repoName,
      roots: { workspace: '.', repoOps: '.' },
      graph: { repoAccessPath: 'repo-access.v1.json', outputPath: 'atelier-output/knowledge.graph.json' },
      projection: { outputRoot: 'atelier-output', readinessPath: 'atelier-output/atelier-readiness.json' },
      boundaries: { policyPath: 'boundary-policy.v1.json', governanceLedgerPath: 'governance/repo-boundary-ledger.md', strictNewRepos: true },
      setup: { profile, include: firstString(args.include, args.includes) || null, exclude: firstString(args.exclude, args.excludes) || null },
      repos: [{ name: repoName, path: '.', readBoundary: profile === 'shared-project' ? 'team' : 'private', role: profile }],
    })
  }
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
  ensureLocalState(project, { write: true })
  writeLocalOverlay(project)
  console.log(JSON.stringify({ ok: true, command: 'adopt', profile, target, projectPath }, null, 2))
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
