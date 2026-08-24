#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs, resolveProjectConfig, writeJson } from '../project/config.mjs'
import { packageRootFrom } from '../project/package-root.mjs'
import { writeAtelierLock } from '../upgrade/upgrade.mjs'

const packageRoot = packageRootFrom(import.meta.url)

function slug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'owner'
}

function gitConfig(name) {
  const result = spawnSync('git', ['config', '--get', name], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : ''
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function copyDir(source, target, { renameGitignore = true } = {}) {
  fs.mkdirSync(target, { recursive: true })
  for (const ent of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, ent.name)
    // npm pack strips files named .gitignore, so templates ship the file as
    // `gitignore` at the template root; nested files keep their literal names.
    const rename = renameGitignore && ent.name === 'gitignore' && ent.isFile()
    const to = path.join(target, rename ? '.gitignore' : ent.name)
    if (ent.isDirectory()) copyDir(from, to, { renameGitignore: false })
    else fs.copyFileSync(from, to)
  }
}

function personalizeBoundaryPolicy(target, { actor, githubLogin, gitEmail } = {}) {
  const policyPath = path.join(target, 'boundary-policy.v1.json')
  if (!fs.existsSync(policyPath)) return
  const policy = readJson(policyPath)
  const actorId = slug(actor || 'owner')
  const privateDomainRepo = Object.entries(policy.repos || {}).find(([, repo]) => repo?.kind === 'private_domain')?.[0] || `mnstry-private-${actorId}`
  const login = githubLogin || process.env.GITHUB_ACTOR || actorId
  const email = gitEmail || gitConfig('user.email') || `${actorId}@example.invalid`

  policy.actors = {
    [actorId]: {
      githubLogin: login,
      gitEmails: [email],
      privateDomainRepo,
    },
  }
  if (policy.repos?.[privateDomainRepo]) policy.repos[privateDomainRepo].ownerActor = actorId
  writeJson(policyPath, policy)
}

const args = parseArgs(process.argv.slice(2))
const target = path.resolve(args.target || process.cwd())
const template = args.template || args.fixture
let templateId = template || 'default'
if (template === 'sample-workspace') {
  copyDir(path.join(packageRoot, 'fixtures/projects/sample-workspace'), target)
  console.log(`created sample Atelier workspace at ${target}`)
} else if (template === 'private-domain') {
  copyDir(path.join(packageRoot, 'templates/private-domain-workspace'), target)
  personalizeBoundaryPolicy(target, {
    actor: args.actor,
    githubLogin: args['github-login'],
    gitEmail: args['git-email'],
  })
  console.log(`created private domain Atelier workspace at ${target}`)
} else if (template === 'shared-project') {
  copyDir(path.join(packageRoot, 'templates/shared-project-workspace'), target)
  personalizeBoundaryPolicy(target, {
    actor: args.actor,
    githubLogin: args['github-login'],
    gitEmail: args['git-email'],
  })
  console.log(`created shared project Atelier workspace at ${target}`)
} else if (template === 'distribution') {
  copyDir(path.join(packageRoot, 'templates/distribution-workspace'), target)
  personalizeBoundaryPolicy(target, {
    actor: args.actor,
    githubLogin: args['github-login'],
    gitEmail: args['git-email'],
  })
  console.log(`created distribution Atelier workspace at ${target}`)
} else if (template) {
  // Unknown template names fail closed: a typo must not silently produce a
  // blank scaffold that lacks the boundary policy the caller asked for.
  console.error(`Unknown template: ${template}. Valid templates: private-domain, shared-project, sample-workspace, distribution.`)
  process.exit(1)
} else {
  fs.mkdirSync(target, { recursive: true })
  fs.mkdirSync(path.join(target, 'content'), { recursive: true })
  writeJson(path.join(target, 'atelier.project.json'), {
    schema: 'mnstry.atelier-project-config@v1',
    name: path.basename(target),
    roots: { workspace: '.' },
    graph: { repoAccessPath: 'repo-access.v1.json', outputPath: 'atelier-output/knowledge.graph.json' },
    projection: { outputRoot: 'atelier-output', readinessPath: 'atelier-output/atelier-readiness.json' },
    repos: [{ name: 'content', path: 'content', readBoundary: 'private' }],
  })
  writeJson(path.join(target, 'repo-access.v1.json'), {
    schema: 'mnstry.atelier-repo-access@v1',
    defaultReadBoundary: 'private',
    repos: { content: { readBoundary: 'private' } },
  })
  console.log(`created Atelier project scaffold at ${target}`)
}

// Every workspace gets a preview launch config, whichever template made it.
// autoPort matters: a workspace usually keeps a long-lived instance on the
// canonical port, and a preview that cannot take a free port evicts it.
const launchTemplate = path.join(packageRoot, 'templates/launch.json')
const launchTarget = path.join(target, '.claude/launch.json')
if (fs.existsSync(launchTemplate) && !fs.existsSync(launchTarget)) {
  fs.mkdirSync(path.dirname(launchTarget), { recursive: true })
  fs.copyFileSync(launchTemplate, launchTarget)
}

const projectPath = path.join(target, 'atelier.project.json')
if (fs.existsSync(projectPath)) {
  const project = resolveProjectConfig({ cwd: target, argv: ['--project', projectPath] })
  writeAtelierLock({ project, templateId })
  console.log(`wrote Atelier lock at ${path.join(target, 'atelier.lock.json')}`)
}
