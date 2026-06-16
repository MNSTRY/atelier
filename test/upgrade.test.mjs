import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import {
  ATELIER_LOCK_SCHEMA,
  ATELIER_MIGRATION_SCHEMA,
  applyUpgrade,
  checkAtelierLock,
  planUpgrade,
  validateMigrationRecord,
  writeAtelierLock,
} from '../src/upgrade/upgrade.mjs'
import { resolveProjectConfig, writeJson } from '../src/project/config.mjs'

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-upgrade-'))
  const repo = path.join(root, 'content')
  fs.mkdirSync(repo, { recursive: true })
  git(repo, ['init'])
  git(repo, ['config', 'user.email', 'author@example.invalid'])
  git(repo, ['config', 'user.name', 'Author Preview'])
  fs.writeFileSync(path.join(repo, 'README.md'), `---
title: Seed
kg:
  id: "content:seed"
  type: "document"
  status: "active"
  audience: "private"
---
# Seed
`)
  writeJson(path.join(root, 'repo-access.v1.json'), {
    schema: 'mnstry.atelier-repo-access@v1',
    defaultReadBoundary: 'private',
    repos: {
      content: { readBoundary: 'private' },
    },
  })
  writeJson(path.join(root, 'boundary-policy.v1.json'), boundaryPolicy())
  writeJson(path.join(root, 'atelier.project.json'), {
    schema: 'mnstry.atelier-project-config@v1',
    name: 'upgrade-fixture',
    roots: { workspace: '.' },
    graph: { repoAccessPath: 'repo-access.v1.json', outputPath: 'atelier-output/knowledge.graph.json' },
    projection: { outputRoot: 'atelier-output', readinessPath: 'atelier-output/atelier-readiness.json' },
    boundaries: { policyPath: 'boundary-policy.v1.json' },
    repos: [{ name: 'content', path: 'content', readBoundary: 'private' }],
  })
  git(repo, ['add', '.'])
  git(repo, ['commit', '-m', 'seed'])
  const project = resolveProjectConfig({ cwd: root, argv: ['--project', path.join(root, 'atelier.project.json')] })
  return { root, repo, project }
}

function boundaryPolicy(overrides = {}) {
  return {
    schema: 'mnstry.atelier-boundary-policy@v1',
    mode: 'strict',
    actors: {
      author: {
        githubLogin: 'author',
        gitEmails: ['author@example.invalid'],
        privateDomainRepo: 'content',
      },
    },
    repos: {
      content: {
        kind: 'private_domain',
        ownerActor: 'author',
        readBoundary: 'private',
        allowedAudiences: ['private', 'sensitive', 'team', 'operator', 'staff', 'public'],
        forbiddenAudiences: [],
        autoCommit: 'guarded',
      },
    },
    promotion: { requiresGitPromote: true, recordsPath: 'governance/git-promote-events.jsonl' },
    forbiddenPaths: [],
    ...overrides,
  }
}

function writeOldLock(project) {
  const lock = writeAtelierLock({ project, templateId: 'test-template' })
  lock.package.version = '0.0.0'
  writeJson(path.join(project.configDir, 'atelier.lock.json'), lock)
  return lock
}

test('missing lock can be written without source mutation', () => {
  const { repo, project } = fixture()
  const lock = writeAtelierLock({ project, templateId: 'test-template' })
  assert.equal(lock.schema, ATELIER_LOCK_SCHEMA)
  const status = git(repo, ['status', '--porcelain'])
  assert.equal(status, '')
  assert.equal(checkAtelierLock(project).ok, true)
})

test('stale lock produces a dry-run migration plan', () => {
  const { project } = fixture()
  writeOldLock(project)
  const plan = planUpgrade({ project })
  assert.equal(plan.ok, true)
  assert.ok(plan.migrations.some((migration) => migration.id.startsWith('generated-refresh@')))
  assert.ok(plan.migrations.some((migration) => migration.id.startsWith('boundary-hook-update@')))
})

test('dirty authored repo blocks upgrade apply', () => {
  const { repo, project } = fixture()
  writeOldLock(project)
  fs.appendFileSync(path.join(repo, 'README.md'), '\nAuthored change\n')
  const plan = planUpgrade({ project })
  assert.equal(plan.ok, false)
  assert.match(plan.blockers.join('\n'), /dirty authored files block upgrade apply/)
})

test('dirty generated-only repo can apply with explicit generated allowance', () => {
  const { repo, project } = fixture()
  writeOldLock(project)
  fs.mkdirSync(path.join(repo, 'atelier-output'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'atelier-output', 'index.html'), 'stale generated')
  const blocked = planUpgrade({ project })
  assert.equal(blocked.ok, true)
  assert.match(blocked.warnings.join('\n'), /generated files are dirty/)
  const result = applyUpgrade({ project, branch: 'codex/test-upgrade', allowDirtyGenerated: true })
  assert.equal(result.ok, true)
  assert.equal(git(repo, ['branch', '--show-current']), 'codex/test-upgrade')
  assert.equal(git(repo, ['status', '--porcelain']), '')
})

test('private or sensitive material in a shared repo blocks upgrade', () => {
  const { root, project } = fixture()
  writeJson(path.join(root, 'boundary-policy.v1.json'), boundaryPolicy({
    repos: {
      content: {
        kind: 'shared',
        readBoundary: 'team',
        allowedAudiences: ['team', 'public'],
        forbiddenAudiences: ['private', 'sensitive'],
        autoCommit: 'guarded',
      },
    },
  }))
  const plan = planUpgrade({ project })
  assert.equal(plan.ok, false)
  assert.match(plan.blockers.join('\n'), /must reference a private_domain repo|private material must live in a private domain repo|audience private/)
})

test('boundary policy weakening blocks upgrade', () => {
  const { root, project } = fixture()
  const previous = boundaryPolicy({
    actors: {
      author: {
        githubLogin: 'author',
        gitEmails: ['author@example.invalid'],
        privateDomainRepo: 'private-domain',
      },
    },
    repos: {
      'private-domain': {
        kind: 'private_domain',
        ownerActor: 'author',
        readBoundary: 'private',
        allowedAudiences: ['private', 'sensitive', 'team', 'operator', 'staff', 'public'],
        forbiddenAudiences: [],
        autoCommit: 'guarded',
      },
      content: {
        kind: 'shared',
        readBoundary: 'team',
        allowedAudiences: ['team', 'public'],
        forbiddenAudiences: ['private', 'sensitive'],
        autoCommit: 'guarded',
      },
    },
  })
  const lock = writeAtelierLock({ project })
  lock.boundaryPolicy.snapshot = previous
  writeJson(path.join(root, 'atelier.lock.json'), lock)
  const weakened = structuredClone(previous)
  weakened.repos.content.forbiddenAudiences = ['sensitive']
  writeJson(path.join(root, 'boundary-policy.v1.json'), weakened)
  const plan = planUpgrade({ project })
  assert.equal(plan.ok, false)
  assert.match(plan.blockers.join('\n'), /changed content from shared|removed forbidden audience|boundary policy/)
})

test('semantic field change without review marker blocks upgrade', () => {
  const { repo, project } = fixture()
  writeAtelierLock({ project })
  const file = path.join(repo, 'README.md')
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('audience: "private"', 'audience: "team"'))
  git(repo, ['add', 'README.md'])
  const plan = planUpgrade({ project })
  assert.equal(plan.ok, false)
  assert.match(plan.blockers.join('\n'), /Atelier-Boundary-Review/)
})

test('hook update preserves unrelated user hook via sidecar', () => {
  const { repo, project } = fixture()
  writeOldLock(project)
  const hooks = path.join(repo, '.git', 'hooks')
  fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/usr/bin/env bash\necho user hook\n')
  const result = applyUpgrade({ project, branch: 'codex/hook-upgrade' })
  assert.equal(result.ok, true)
  assert.ok(fs.existsSync(path.join(hooks, 'pre-commit.mnstry-atelier-boundary')))
})

test('template scaffold adds missing file but does not overwrite authored file', () => {
  const { root, project } = fixture()
  writeOldLock(project)
  const docs = path.join(root, 'docs')
  fs.mkdirSync(docs, { recursive: true })
  fs.writeFileSync(path.join(docs, 'upgrade.md'), 'custom upgrade note')
  applyUpgrade({ project, branch: 'codex/template-upgrade' })
  assert.equal(fs.readFileSync(path.join(docs, 'upgrade.md'), 'utf8'), 'custom upgrade note')
})

test('breaking migrations require explicit confirmation', () => {
  const { project } = fixture()
  writeOldLock(project)
  const breaking = {
    schema: ATELIER_MIGRATION_SCHEMA,
    id: 'breaking-test@1',
    class: 'breaking',
    title: 'Breaking test',
    description: 'Used for confirmation coverage.',
    files: [],
    explicitConfirmationRequired: true,
    requiredPostChecks: [],
    apply: 'none',
    authority: {
      telemetry: false,
      egress: false,
      runtimeMutation: false,
      runtimeImport: false,
      analysisExecution: false,
    },
  }
  const plan = planUpgrade({ project, migrations: [breaking] })
  assert.deepEqual(plan.requiredConfirmations, ['breaking-test@1'])
})

test('migration authority cannot introduce deferred non-goals', () => {
  const errors = validateMigrationRecord({
    schema: ATELIER_MIGRATION_SCHEMA,
    id: 'unsafe@1',
    class: 'generated_refresh',
    title: 'Unsafe',
    description: 'Unsafe migration fixture',
    files: [],
    requiredPostChecks: [],
    authority: { telemetry: true, runtimeMutation: true, analysisExecution: true },
  })
  assert.match(errors.join('\n'), /telemetry/)
  assert.match(errors.join('\n'), /runtimeMutation/)
  assert.match(errors.join('\n'), /analysisExecution/)
})
