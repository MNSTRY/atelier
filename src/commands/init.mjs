#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs, resolveProjectConfig, writeJson } from '../project/config.mjs'
import { writeAtelierLock } from '../upgrade/upgrade.mjs'

const packageRoot = path.resolve(new URL('../..', import.meta.url).pathname)

function slug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'author'
}

function gitConfig(name) {
  const result = spawnSync('git', ['config', '--get', name], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : ''
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function copyDir(source, target) {
  fs.mkdirSync(target, { recursive: true })
  for (const ent of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, ent.name)
    const to = path.join(target, ent.name)
    if (ent.isDirectory()) copyDir(from, to)
    else fs.copyFileSync(from, to)
  }
}

function personalizeBoundaryPolicy(target, { actor, githubLogin, gitEmail } = {}) {
  const policyPath = path.join(target, 'boundary-policy.v1.json')
  if (!fs.existsSync(policyPath)) return
  const policy = readJson(policyPath)
  const actorId = slug(actor || 'author')
  const privateDomainRepo = Object.entries(policy.repos || {}).find(([, repo]) => repo?.kind === 'private_domain')?.[0] || `mnstry-private-${actorId}`
  const login = githubLogin || process.env.GITHUB_ACTOR || (actorId === 'author' ? 'AUTHOR_GITHUB_LOGIN_PLACEHOLDER' : actorId)
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
} else if (template === 'shared-project' || template === 'mystery-shared') {
  copyDir(path.join(packageRoot, 'templates/shared-project-workspace'), target)
  personalizeBoundaryPolicy(target, {
    actor: args.actor,
    githubLogin: args['github-login'],
    gitEmail: args['git-email'],
  })
  console.log(`created shared project Atelier workspace at ${target}`)
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

const projectPath = path.join(target, 'atelier.project.json')
if (fs.existsSync(projectPath)) {
  const project = resolveProjectConfig({ cwd: target, argv: ['--project', projectPath] })
  writeAtelierLock({ project, templateId })
  console.log(`wrote Atelier lock at ${path.join(target, 'atelier.lock.json')}`)
}
