import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  BOUNDARY_POLICY_SCHEMA,
  checkBoundaryPolicy,
  createPromoteEvent,
  diffFileSections,
  installBoundaryHooks,
  runBoundaryCheckCommand,
  semanticChangesInFile,
  validateBoundaryPolicy,
} from '../src/boundary/policy.mjs'
import { generatedFrontmatter } from '../src/graph/knowledge-graph.mjs'
import { commandProject, writeJson } from '../src/project/config.mjs'

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
}

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-boundary-'))
  const privateRepo = path.join(root, 'mnstry-private-author')
  const sharedRepo = path.join(root, 'mystery-example')
  fs.mkdirSync(privateRepo, { recursive: true })
  fs.mkdirSync(sharedRepo, { recursive: true })
  for (const repo of [privateRepo, sharedRepo]) {
    git(repo, ['init'])
    git(repo, ['config', 'user.email', 'author@example.invalid'])
    git(repo, ['config', 'user.name', 'Author'])
  }
  writeJson(path.join(root, 'atelier.project.json'), {
    schema: 'mnstry.atelier-project-config@v1',
    name: 'boundary-fixture',
    roots: { workspace: '.', repoOps: '.' },
    graph: {
      repoAccessPath: 'repo-access.v1.json',
      outputPath: 'atelier-output/knowledge.graph.json',
    },
    projection: {
      outputRoot: 'atelier-output',
      readinessPath: 'atelier-output/atelier-readiness.json',
    },
    boundaries: {
      policyPath: 'boundary-policy.v1.json',
      governanceLedgerPath: 'governance/repo-boundary-ledger.md',
      strictNewRepos: true,
    },
    repos: [
      { name: 'mnstry-private-author', path: 'mnstry-private-author', readBoundary: 'private' },
      { name: 'mystery-example', path: 'mystery-example', readBoundary: 'team' },
    ],
  })
  writeJson(path.join(root, 'repo-access.v1.json'), {
    schema: 'mnstry.atelier-repo-access@v1',
    defaultReadBoundary: 'team',
    repos: {
      'mnstry-private-author': { readBoundary: 'private' },
      'mystery-example': { readBoundary: 'team' },
    },
  })
  const policy = boundaryPolicy()
  writeJson(path.join(root, 'boundary-policy.v1.json'), policy)
  return { root, privateRepo, sharedRepo, policy, project: project(root) }
}

function project(root) {
  return commandProject({ argv: ['--project', path.join(root, 'atelier.project.json')], cwd: root, env: {} })
}

function boundaryPolicy(overrides = {}) {
  return {
    schema: BOUNDARY_POLICY_SCHEMA,
    mode: 'strict',
    actors: {
      author: {
        githubLogin: 'AUTHOR_GITHUB_LOGIN_PLACEHOLDER',
        gitEmails: ['author@example.invalid'],
        privateDomainRepo: 'mnstry-private-author',
      },
    },
    repos: {
      'mnstry-private-author': {
        kind: 'private_domain',
        ownerActor: 'author',
        readBoundary: 'private',
        allowedAudiences: ['private', 'sensitive', 'team', 'operator', 'staff', 'public'],
        forbiddenAudiences: [],
        autoCommit: 'guarded',
      },
      'mystery-example': {
        kind: 'shared',
        readBoundary: 'team',
        allowedAudiences: ['team', 'operator', 'staff', 'public'],
        forbiddenAudiences: ['private', 'sensitive'],
        autoCommit: 'guarded',
      },
    },
    promotion: {
      requiresGitPromote: true,
      recordsPath: 'governance/git-promote-events.jsonl',
    },
    forbiddenPaths: ['.mnstry-local/**', '.atelier-proposals/**', 'support-bundles/**', 'prompts/**', 'transcripts/**'],
    governanceLedgerPath: 'governance/repo-boundary-ledger.md',
    ...overrides,
  }
}

function writeDoc(repo, rel, id, audience, relations = '') {
  const abs = path.join(repo, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, `---
title: "${id}"
kg:
  id: "${id}"
  type: "document"
  status: "active"
  audience: "${audience}"
${relations}
---

# ${id}
`)
  return abs
}

test('boundary policy semantic validation catches missing project repo coverage', () => {
  const { project: cfg } = makeWorkspace()
  const policy = boundaryPolicy({ repos: { 'mnstry-private-author': boundaryPolicy().repos['mnstry-private-author'] } })
  assert.match(validateBoundaryPolicy(policy, cfg).join('\n'), /policy repos\.mystery-example must be declared/)
})

test('strict boundary blocks private and sensitive material in shared repos', () => {
  const { project: cfg, policy, sharedRepo } = makeWorkspace()
  writeDoc(sharedRepo, 'private.md', 'mystery-example:private', 'private')
  writeDoc(sharedRepo, 'sensitive.md', 'mystery-example:sensitive', 'sensitive')
  const report = checkBoundaryPolicy({ project: cfg, policy, actor: 'author' })
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((item) => item.code === 'private-audience-in-shared-repo' && item.path === 'private.md'))
  assert.ok(report.errors.some((item) => item.code === 'private-audience-in-shared-repo' && item.path === 'sensitive.md'))
})

test('strict boundary permits private material in the owner private domain repo', () => {
  const { project: cfg, policy, privateRepo } = makeWorkspace()
  writeDoc(privateRepo, 'private.md', 'mnstry-private-author:private', 'private')
  writeDoc(privateRepo, 'sensitive.md', 'mnstry-private-author:sensitive', 'sensitive')
  const report = checkBoundaryPolicy({ project: cfg, policy, actor: 'author' })
  assert.equal(report.ok, true, report.errors.map((item) => item.message).join('\n'))
})

test('legacy-warning mode reports placement problems without failing', () => {
  const { project: cfg, policy, sharedRepo } = makeWorkspace()
  policy.mode = 'legacy-warning'
  writeDoc(sharedRepo, 'private.md', 'mystery-example:private', 'private')
  const report = checkBoundaryPolicy({ project: cfg, policy, actor: 'author' })
  assert.equal(report.ok, true)
  assert.ok(report.warnings.some((item) => item.code === 'private-audience-in-shared-repo'))
})

test('invalid policy remains blocking in legacy mode and does not suppress staged judging', () => {
  const { project: cfg, policy, privateRepo } = makeWorkspace()
  policy.mode = 'legacy-warning'
  policy.contentRules = []
  fs.mkdirSync(path.join(privateRepo, '.atelier-local'), { recursive: true })
  fs.writeFileSync(path.join(privateRepo, '.atelier-local/session.json'), '{}\n')
  git(privateRepo, ['add', '.'])

  const report = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true })
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((item) => item.code === 'boundary-policy-invalid'))
  assert.ok(report.errors.some((item) => item.code === 'forbidden-path-staged'))
})

test('staged guard blocks forbidden paths and semantic field changes without review marker', () => {
  const { project: cfg, policy, privateRepo } = makeWorkspace()
  writeDoc(privateRepo, 'doc.md', 'mnstry-private-author:doc', 'private')
  git(privateRepo, ['add', 'doc.md'])
  git(privateRepo, ['commit', '-m', 'seed'])
  fs.mkdirSync(path.join(privateRepo, '.mnstry-local'), { recursive: true })
  fs.writeFileSync(path.join(privateRepo, '.mnstry-local/session.json'), '{}\n')
  fs.mkdirSync(path.join(privateRepo, '.atelier-local'), { recursive: true })
  fs.writeFileSync(path.join(privateRepo, '.atelier-local/workspace.json'), '{}\n')
  fs.writeFileSync(path.join(privateRepo, 'atelier.local.json'), '{}\n')
  let text = fs.readFileSync(path.join(privateRepo, 'doc.md'), 'utf8')
  text = text.replace('audience: "private"', 'audience: "team"')
  fs.writeFileSync(path.join(privateRepo, 'doc.md'), text)
  git(privateRepo, ['add', '.'])
  const report = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true })
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((item) => item.code === 'forbidden-path-staged' && item.path === '.atelier-local/workspace.json'))
  assert.ok(report.errors.some((item) => item.code === 'forbidden-path-staged' && item.path === 'atelier.local.json'))
  assert.ok(report.errors.some((item) => item.code === 'semantic-field-change-needs-review'))
})

test('private domain actor mismatch fails closed in strict mode', () => {
  const { project: cfg, policy, privateRepo } = makeWorkspace()
  policy.actors.other = {
    githubLogin: 'other',
    gitEmails: ['other@example.invalid'],
    privateDomainRepo: 'mnstry-private-author',
  }
  writeDoc(privateRepo, 'private.md', 'mnstry-private-author:private', 'private')
  const report = checkBoundaryPolicy({ project: cfg, policy, actor: 'other' })
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((item) => item.code === 'private-domain-actor-mismatch'))
})

test('private-to-shared supersession requires a git.promote record and passes after one exists', () => {
  const { root, project: cfg, policy, privateRepo, sharedRepo } = makeWorkspace()
  writeDoc(privateRepo, 'private.md', 'mnstry-private-author:source', 'private')
  writeDoc(
    sharedRepo,
    'summary.md',
    'mystery-example:summary',
    'team',
    `  relations:
    supersedes:
      - "mnstry-private-author:source"`,
  )
  let report = checkBoundaryPolicy({ project: cfg, policy, actor: 'author' })
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((item) => item.code === 'git-promote-required'))

  const event = createPromoteEvent({
    project: cfg,
    policy,
    sourceRepo: 'mnstry-private-author',
    targetRepo: 'mystery-example',
    kgId: 'mnstry-private-author:source',
    targetKgId: 'mystery-example:summary',
    actor: 'author',
  })
  fs.mkdirSync(path.join(root, 'governance'), { recursive: true })
  fs.writeFileSync(path.join(root, 'governance/git-promote-events.jsonl'), `${JSON.stringify(event)}\n`)
  report = checkBoundaryPolicy({ project: cfg, policy, actor: 'author' })
  assert.equal(report.ok, true, report.errors.map((item) => item.message).join('\n'))
})

test('hook installer writes sidecar hook when user hook already exists', () => {
  const { project: cfg, privateRepo } = makeWorkspace()
  const hook = path.join(privateRepo, '.git/hooks/pre-commit')
  fs.writeFileSync(hook, '#!/usr/bin/env bash\necho custom\n')
  fs.chmodSync(hook, 0o755)
  const result = installBoundaryHooks({ project: cfg })
  assert.ok(result.skipped.some((item) => item.repo === 'mnstry-private-author' && item.hook === 'pre-commit'))
  assert.ok(fs.existsSync(`${hook}.mnstry-atelier-boundary`))
  assert.ok(result.installed.some((item) => item.repo === 'mystery-example'))
  const sharedHook = fs.readFileSync(path.join(path.dirname(privateRepo), 'mystery-example', '.git/hooks/pre-commit'), 'utf8')
  assert.match(sharedHook, /command -v atelier/)
  assert.match(sharedHook, /node_modules\/\.bin\/atelier/)
})

test('repo-local project config follows the active worktree instead of the installer checkout', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-hook-worktree-'))
  git(repo, ['init'])
  writeJson(path.join(repo, 'atelier.project.json'), {
    schema: 'mnstry.atelier-project-config@v1',
    roots: { workspace: '.', repoOps: '.' },
    boundaries: { policyPath: 'boundary-policy.v1.json' },
    repos: [{ name: 'site', path: '.', readBoundary: 'team' }],
  })
  const cfg = commandProject({ argv: ['--project', path.join(repo, 'atelier.project.json')], cwd: repo, env: {} })

  installBoundaryHooks({ project: cfg })
  const hook = fs.readFileSync(path.join(repo, '.git/hooks/pre-commit'), 'utf8')
  assert.match(hook, /git rev-parse --show-toplevel/)
  assert.match(hook, /\$ATELIER_HOOK_REPO_ROOT"\/'atelier\.project\.json'/)
  assert.doesNotMatch(hook, new RegExp(repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('hook installation resolves the real Git hook path from a linked worktree', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-linked-hook-'))
  const main = path.join(root, 'main')
  const linked = path.join(root, 'linked')
  fs.mkdirSync(main)
  git(main, ['init'])
  git(main, ['config', 'user.email', 'author@example.invalid'])
  git(main, ['config', 'user.name', 'Author'])
  writeJson(path.join(main, 'atelier.project.json'), {
    schema: 'mnstry.atelier-project-config@v1',
    roots: { workspace: '.', repoOps: '.' },
    boundaries: { policyPath: 'boundary-policy.v1.json' },
    repos: [{ name: 'site', path: '.', readBoundary: 'team' }],
  })
  git(main, ['add', '.'])
  git(main, ['commit', '-m', 'seed'])
  execFileSync('git', ['-C', main, 'worktree', 'add', '--quiet', '-b', 'linked-hook-test', linked])
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const cfg = commandProject({ argv: ['--project', path.join(linked, 'atelier.project.json')], cwd: linked, env: {} })
  installBoundaryHooks({ project: cfg })
  const gitPath = git(linked, ['rev-parse', '--git-path', 'hooks'])
  const hooksDir = path.isAbsolute(gitPath) ? gitPath : path.resolve(linked, gitPath)
  const hook = fs.readFileSync(path.join(hooksDir, 'pre-push'), 'utf8')
  assert.match(hook, /ATELIER_HOOK_REPO_ROOT="\$\(git rev-parse --show-toplevel\)"/)
  assert.doesNotMatch(hook, new RegExp(main.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('applying the kit fail-closed front-matter default does not need a review marker', () => {
  const { project: cfg, policy, privateRepo } = makeWorkspace()
  const rel = 'notes/unlabelled.md'
  const abs = path.join(privateRepo, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, '# Unlabelled\n\nBody text.\n')
  git(privateRepo, ['add', '.'])
  git(privateRepo, ['commit', '-m', 'seed'])

  const frontmatter = generatedFrontmatter({
    id: 'mnstry-private-author:notes-unlabelled',
    repoName: 'mnstry-private-author',
    rel,
    title: 'Unlabelled',
    summary: '',
    domain: 'notes',
    lifecycle: 'active',
    status: 'active',
    audience: '',
    surfaced: false,
    tags: ['notes'],
  })
  fs.writeFileSync(abs, `---\n${frontmatter}\n---\n\n# Unlabelled\n\nBody text.\n`)
  git(privateRepo, ['add', '.'])

  const report = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true })
  assert.deepEqual(
    report.findings.filter((item) => item.code === 'semantic-field-change-needs-review'),
    [],
  )
  assert.equal(report.ok, true, report.errors.map((item) => item.message).join('\n'))
})

test('a brand new file initialized to the fail-closed audience needs no marker', () => {
  const { project: cfg, policy, privateRepo } = makeWorkspace()
  writeDoc(privateRepo, 'seed.md', 'mnstry-private-author:seed', 'private')
  git(privateRepo, ['add', '.'])
  git(privateRepo, ['commit', '-m', 'seed'])
  writeDoc(privateRepo, 'fresh.md', 'mnstry-private-author:fresh', 'private')
  git(privateRepo, ['add', '.'])

  const report = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true })
  assert.equal(report.ok, true, report.errors.map((item) => item.message).join('\n'))
})

test('a brand new file introduced at a disclosing audience still needs a marker', () => {
  const { project: cfg, policy, privateRepo } = makeWorkspace()
  writeDoc(privateRepo, 'seed.md', 'mnstry-private-author:seed', 'private')
  git(privateRepo, ['add', '.'])
  git(privateRepo, ['commit', '-m', 'seed'])
  writeDoc(privateRepo, 'fresh.md', 'mnstry-private-author:fresh', 'public')
  git(privateRepo, ['add', '.'])

  const report = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true })
  assert.equal(report.ok, false)
  const found = report.errors.find((item) => item.code === 'semantic-field-change-needs-review')
  assert.equal(found.path, 'fresh.md')
  assert.match(found.message, /audience introduced as "public"/)
})

test('widening an existing audience without a marker still fails', () => {
  const { project: cfg, policy, privateRepo } = makeWorkspace()
  writeDoc(privateRepo, 'doc.md', 'mnstry-private-author:doc', 'private')
  git(privateRepo, ['add', '.'])
  git(privateRepo, ['commit', '-m', 'seed'])
  const abs = path.join(privateRepo, 'doc.md')
  fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').replace('audience: "private"', 'audience: "team"'))
  git(privateRepo, ['add', '.'])

  const report = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true })
  assert.equal(report.ok, false)
  const found = report.errors.find((item) => item.code === 'semantic-field-change-needs-review')
  assert.equal(found.path, 'doc.md')
  assert.match(found.message, /audience changed from "private" to "team"/)
})

test('removing an existing audience declaration still fails', () => {
  const { project: cfg, policy, privateRepo } = makeWorkspace()
  writeDoc(privateRepo, 'doc.md', 'mnstry-private-author:doc', 'private')
  git(privateRepo, ['add', '.'])
  git(privateRepo, ['commit', '-m', 'seed'])
  const abs = path.join(privateRepo, 'doc.md')
  fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').replace('  audience: "private"\n', ''))
  git(privateRepo, ['add', '.'])

  const report = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true })
  assert.equal(report.ok, false)
  assert.match(
    report.errors.find((item) => item.code === 'semantic-field-change-needs-review').message,
    /audience removed \(was "private"\)/,
  )
})

test('a review marker in the same file approves the change, in another file it does not', () => {
  const { project: cfg, policy, privateRepo } = makeWorkspace()
  writeDoc(privateRepo, 'doc.md', 'mnstry-private-author:doc', 'private')
  writeDoc(privateRepo, 'other.md', 'mnstry-private-author:other', 'private')
  git(privateRepo, ['add', '.'])
  git(privateRepo, ['commit', '-m', 'seed'])

  const other = path.join(privateRepo, 'other.md')
  fs.appendFileSync(other, '\n<!-- Atelier-Boundary-Review: approved — reviewed by author -->\n')
  const doc = path.join(privateRepo, 'doc.md')
  fs.writeFileSync(doc, fs.readFileSync(doc, 'utf8').replace('audience: "private"', 'audience: "team"'))
  git(privateRepo, ['add', '.'])

  let report = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true })
  assert.equal(report.ok, false, 'a marker in a sibling file must not approve doc.md')
  assert.ok(report.errors.some((item) => item.code === 'semantic-field-change-needs-review' && item.path === 'doc.md'))

  fs.appendFileSync(doc, '\n<!-- Atelier-Boundary-Review: approved — widened for the team handbook -->\n')
  git(privateRepo, ['add', '.'])
  report = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true })
  assert.equal(report.ok, true, report.errors.map((item) => item.message).join('\n'))
})

test('semantic diff parsing reads sidecar JSON and ignores prose mentions', () => {
  const diff = [
    'diff --git a/asset.pdf.kg.json b/asset.pdf.kg.json',
    '--- a/asset.pdf.kg.json',
    '+++ b/asset.pdf.kg.json',
    '@@ -6 +6 @@',
    '-    "audience": "team",',
    '+    "audience": "public",',
    'diff --git a/notes.md b/notes.md',
    '--- a/notes.md',
    '+++ b/notes.md',
    '@@ -0,0 +1 @@',
    '+Our audience loved the launch',
  ].join('\n')
  const [sidecar, prose] = diffFileSections(diff)
  assert.equal(sidecar.path, 'asset.pdf.kg.json')
  assert.deepEqual(semanticChangesInFile(sidecar), ['audience changed from "team" to "public"'])
  assert.deepEqual(semanticChangesInFile(prose), [])
})
