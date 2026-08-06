import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  ATELIER_LOCK_SCHEMA,
  ATELIER_MIGRATION_SCHEMA,
  BASE_MIGRATIONS,
  applyMigration,
  applyUpgrade,
  checkAtelierLock,
  planUpgrade,
  validateMigrationRecord,
  writeAtelierLock,
} from '../src/upgrade/upgrade.mjs'
import { computePackDigest, loadExtensionPacks } from '../src/extension-packs/loader.mjs'
import { resolveProjectConfig, writeJson } from '../src/project/config.mjs'

const PACK_FIXTURES = path.join(fileURLToPath(new URL('..', import.meta.url)), 'fixtures', 'atelier-extension-pack')

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

// Copies the committed valid pack fixture into the temp project and declares
// it in the tracked config; returns a freshly resolved project.
function declarePack(root, { enabled = true } = {}) {
  fs.mkdirSync(path.join(root, 'packs', 'protocols'), { recursive: true })
  fs.copyFileSync(path.join(PACK_FIXTURES, 'valid', 'sample-pack.v1.json'), path.join(root, 'packs', 'sample.readiness.v1.json'))
  fs.copyFileSync(path.join(PACK_FIXTURES, 'valid', 'protocols', 'contract-gate.v1.json'), path.join(root, 'packs', 'protocols', 'contract-gate.v1.json'))
  const configPath = path.join(root, 'atelier.project.json')
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  config.ext = {
    'mnstry.atelier': {
      extensionPacks: [{ id: 'sample.readiness', version: 'v1', path: 'packs/sample.readiness.v1.json', enabled }],
    },
  }
  writeJson(configPath, config)
  return resolveProjectConfig({ cwd: root, argv: ['--project', configPath] })
}

// Rewrites the pack file with identical content but different bytes, so its
// raw-byte digest drifts from the lock while the pack stays loadable.
function reindentPack(root) {
  const packFile = path.join(root, 'packs', 'sample.readiness.v1.json')
  const doc = JSON.parse(fs.readFileSync(packFile, 'utf8'))
  fs.writeFileSync(packFile, `${JSON.stringify(doc, null, 4)}\n`)
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

test('lock write records a declared extension pack and lock check round-trips', () => {
  const { root } = fixture()
  const project = declarePack(root)
  const lock = writeAtelierLock({ project })
  assert.equal(lock.extensionPacks[0].id, 'mnstry-readiness-pack')
  const entry = lock.extensionPacks.find((item) => item.id === 'sample.readiness')
  assert.ok(entry, 'declared pack must be recorded in the lock')
  assert.equal(entry.version, 'v1')
  const rawBytes = fs.readFileSync(path.join(root, 'packs', 'sample.readiness.v1.json'))
  const protocolBytes = fs.readFileSync(path.join(root, 'packs', 'protocols', 'contract-gate.v1.json'))
  assert.equal(entry.digest, computePackDigest(rawBytes, [protocolBytes]))
  const report = checkAtelierLock(project)
  assert.deepEqual(report.errors, [])
  assert.equal(report.ok, true)
})

test('a disabled pack is not pinned and does not fail lock check', () => {
  const { root } = fixture()
  const project = declarePack(root, { enabled: false })
  const lock = writeAtelierLock({ project })
  assert.equal(lock.extensionPacks.some((item) => item.id === 'sample.readiness'), false)
  assert.equal(checkAtelierLock(project).ok, true)
})

test('a tampered pack file is detected as lock drift', () => {
  const { root } = fixture()
  const project = declarePack(root)
  writeAtelierLock({ project })
  reindentPack(root)
  const report = checkAtelierLock(project)
  assert.equal(report.ok, false)
  assert.match(report.errors.join('\n'), /lock digest mismatch for extension pack sample\.readiness/)
})

// M1 replay at the lock-check level: the reviewer edited a protocol's
// ui.agentPrompt behind a written lock; lock check passed and the tampered
// prompt was served. The pinned digest now covers protocol file bytes.
test('a tampered protocol file behind a written lock is detected as lock drift', () => {
  const { root } = fixture()
  const project = declarePack(root)
  writeAtelierLock({ project })
  assert.equal(checkAtelierLock(project).ok, true)
  const protocolFile = path.join(root, 'packs', 'protocols', 'contract-gate.v1.json')
  const doc = JSON.parse(fs.readFileSync(protocolFile, 'utf8'))
  doc.ui.agentPrompt = 'Tampered agent prompt the lock must catch.'
  writeJson(protocolFile, doc)
  const report = checkAtelierLock(project)
  assert.equal(report.ok, false)
  assert.match(report.errors.join('\n'), /lock digest mismatch for extension pack sample\.readiness/)
})

// N1 replay: the old set-aside left no lock on disk if the process died
// mid-load and strayed a .repin.tmp. The lock is now never moved; its
// replacement lands atomically via temp file + renameSync.
test('lock rewrite keeps the lock present throughout and never creates a set-aside', (t) => {
  const { root } = fixture()
  const project = declarePack(root)
  writeAtelierLock({ project })
  const lockPath = path.join(root, 'atelier.lock.json')
  // Digest drift: the old implementation could only re-pin past this by
  // renaming the lock out of the way.
  reindentPack(root)

  const writes = []
  const renames = []
  const realRename = fs.renameSync.bind(fs)
  const realWrite = fs.writeFileSync.bind(fs)
  t.mock.method(fs, 'renameSync', (from, to) => {
    renames.push({ from: String(from), to: String(to) })
    if (String(to) === lockPath) {
      // At the instant the replacement lands, the previous lock still exists:
      // there is no observable point without a lock file.
      assert.equal(fs.existsSync(lockPath), true, 'the previous lock must still be present when its replacement lands')
    }
    return realRename(from, to)
  })
  t.mock.method(fs, 'writeFileSync', (file, ...rest) => {
    writes.push(String(file))
    return realWrite(file, ...rest)
  })

  const lock = writeAtelierLock({ project })
  const touched = [...writes, ...renames.flatMap((item) => [item.from, item.to])]
  assert.equal(touched.some((item) => item.endsWith('.repin.tmp')), false, 'no set-aside path may ever be created')
  assert.equal(renames.some((item) => item.from === lockPath), false, 'the lock file must never be renamed away')
  assert.equal(writes.includes(lockPath), false, 'the lock must not be written in place; it lands via rename')
  assert.equal(renames.filter((item) => item.to === lockPath).length, 1, 'exactly one atomic rename produces the new lock')
  assert.equal(fs.existsSync(lockPath), true)
  assert.ok(lock.extensionPacks.some((item) => item.id === 'sample.readiness'))
  assert.equal(checkAtelierLock(project).ok, true, 'the rewrite must re-pin the drifted digest')
})

test('a declared pack absent from the lock is a loader warning and a lock check error', () => {
  const { root, project } = fixture()
  writeAtelierLock({ project })
  const declared = declarePack(root)
  const loaded = loadExtensionPacks(declared, { report: true })
  assert.deepEqual(loaded.errors, [])
  assert.match(loaded.warnings.map((item) => item.message).join('\n'), /is not recorded in atelier\.lock\.json/)
  const report = checkAtelierLock(declared)
  assert.equal(report.ok, false)
  assert.match(report.errors.join('\n'), /extension pack sample\.readiness is not recorded in the lock; run upgrade --dry-run/)
})

test('a lock entry for a pack that is no longer declared is drift', () => {
  const { root } = fixture()
  const project = declarePack(root)
  writeAtelierLock({ project })
  const configPath = path.join(root, 'atelier.project.json')
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  delete config.ext
  writeJson(configPath, config)
  const undeclared = resolveProjectConfig({ cwd: root, argv: ['--project', configPath] })
  const report = checkAtelierLock(undeclared)
  assert.equal(report.ok, false)
  assert.match(report.errors.join('\n'), /lock records extension pack sample\.readiness that is no longer declared; run upgrade --dry-run/)
})

test('a package version change selects the extension pack sync migration', () => {
  const { project } = fixture()
  writeOldLock(project)
  const plan = planUpgrade({ project })
  const sync = plan.migrations.find((migration) => migration.id.startsWith('extension-pack-sync@'))
  assert.ok(sync, 'version change must select extension-pack-sync')
  assert.equal(sync.class, 'extension_pack')
  assert.equal(sync.apply, 'syncExtensionPacks')
})

test('syncExtensionPacks re-verifies packs and re-pins drifted digests', () => {
  const { root } = fixture()
  const project = declarePack(root)
  writeAtelierLock({ project })
  reindentPack(root)
  assert.equal(checkAtelierLock(project).ok, false)
  const sync = BASE_MIGRATIONS.find((migration) => migration.apply === 'syncExtensionPacks')
  assert.ok(sync, 'registry must carry the extension-pack-sync migration')
  applyMigration(project, sync)
  const report = checkAtelierLock(project)
  assert.deepEqual(report.errors, [])
  assert.equal(report.ok, true)
})

test('syncExtensionPacks fails closed on a broken pack and preserves the lock', () => {
  const { root } = fixture()
  const project = declarePack(root)
  const before = writeAtelierLock({ project })
  fs.writeFileSync(path.join(root, 'packs', 'sample.readiness.v1.json'), 'not json')
  const sync = BASE_MIGRATIONS.find((migration) => migration.apply === 'syncExtensionPacks')
  assert.throws(() => applyMigration(project, sync), /extension pack loading failed/)
  const after = JSON.parse(fs.readFileSync(path.join(root, 'atelier.lock.json'), 'utf8'))
  assert.deepEqual(after.extensionPacks, before.extensionPacks, 'a failed sync must leave the lock untouched')
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
