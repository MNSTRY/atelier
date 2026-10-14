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
  resolveCurrentActor,
  runBoundaryCheckCommand,
  semanticChangesInFile,
  semanticFieldOnLine,
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

test('immutable clone history does not identify the current actor', () => {
  const { project: cfg, policy, privateRepo, sharedRepo } = makeWorkspace()
  for (const repo of [privateRepo, sharedRepo]) {
    fs.writeFileSync(path.join(repo, 'README.md'), '# Boundary fixture\n')
    git(repo, ['add', 'README.md'])
    git(repo, ['commit', '-m', 'seed actor identity'])
    git(repo, ['config', '--unset', 'user.email'])
    git(repo, ['config', '--unset', 'user.name'])
  }

  const resolved = resolveCurrentActor({ policy, project: cfg, env: {}, allowNetworkActorResolution: false })
  assert.equal(resolved.actorId, null)
  assert.equal(resolved.source, 'unverified')
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


test('shared-only work does not require ownership of every declared private domain', () => {
  const { project: cfg, policy } = makeWorkspace()
  policy.actors.other = { githubLogin: 'other-login', gitEmails: ['other@example.invalid'], privateDomainRepo: 'other-private' }
  policy.repos['other-private'] = { ...policy.repos['mnstry-private-author'], ownerActor: 'other' }
  const shared = { ...cfg, repos: cfg.repos.filter((repo) => repo.name === 'mystery-example') }
  for (const actor of ['author', 'other']) {
    const report = checkBoundaryPolicy({ project: shared, policy, actor, allowNetworkActorResolution: false })
    assert.equal(report.ok, true, JSON.stringify(report.errors))
  }
  const privateReport = checkBoundaryPolicy({ project: cfg, policy, actor: 'other', allowNetworkActorResolution: false })
  assert.ok(privateReport.errors.some((item) => item.code === 'private-domain-actor-mismatch'))
})

test('platform attribution wins over previous commit metadata and refuses conflicting declarations', () => {
  const { project: cfg, policy, privateRepo } = makeWorkspace()
  policy.actors.other = { githubLogin: 'other-login', gitEmails: ['other@example.invalid'], privateDomainRepo: 'mnstry-private-author' }
  git(privateRepo, ['commit', '--allow-empty', '-m', 'previous author'])
  const resolve = (env, actor = null) => resolveCurrentActor({ policy, project: cfg, env, actor, allowNetworkActorResolution: false })
  assert.equal(resolve({ GITHUB_ACTOR: 'other-login' }).actorId, 'other')
  assert.equal(resolve({}, 'unknown').actorId, null)
  assert.equal(resolve({ MNSTRY_ATELIER_ACTOR: 'other' }, 'author').reason, 'conflicting-explicit-actors')
  assert.equal(resolve({ GITHUB_ACTOR: 'other-login' }, 'author').actorId, 'author')
  assert.equal(resolve({ GITHUB_ACTOR: 'unknown-login' }).actorId, null)
  policy.actors.author.githubLogin = 'author-login'
  policy.actors.other.githubLogin = policy.actors.author.githubLogin
  assert.equal(resolve({ GITHUB_ACTOR: policy.actors.author.githubLogin }).reason, 'ambiguous-platform-actor')
  policy.actors.other.gitEmails = policy.actors.author.gitEmails
  assert.equal(resolve({}).reason, 'ambiguous-git-actor')
})

test('shared-only checks ignore ambient identities but still reject invalid explicit selectors', (t) => {
  const { project: cfg, policy } = makeWorkspace()
  const shared = { ...cfg, repos: cfg.repos.filter((repo) => repo.name === 'mystery-example') }
  const previous = process.env.GITHUB_ACTOR
  process.env.GITHUB_ACTOR = 'undeclared-contributor'
  t.after(() => { if (previous === undefined) delete process.env.GITHUB_ACTOR; else process.env.GITHUB_ACTOR = previous })
  for (const stagedOnly of [false, true]) {
    const result = checkBoundaryPolicy({ project: shared, policy, stagedOnly, forceActorErrors: true })
    assert.equal(result.ok, true, JSON.stringify(result.errors))
  }
  assert.equal(checkBoundaryPolicy({ project: shared, policy, actor: 'unknown' }).ok, false)
  policy.mode = 'legacy-warning'
  const privateReport = checkBoundaryPolicy({ project: cfg, policy, allowNetworkActorResolution: false })
  assert.equal(privateReport.ok, true)
  assert.ok(privateReport.warnings.some((item) => item.code === 'private-domain-actor-unverified' && item.message.includes('unknown-platform-actor')))
  assert.equal(checkBoundaryPolicy({ project: cfg, policy, forceActorErrors: true }).ok, false)
})

test('a declared GitHub login cannot be replaced by a matching local actor key', () => {
  const { project: cfg, policy } = makeWorkspace()
  policy.actors.author.githubLogin = 'actual-platform-login'
  const result = resolveCurrentActor({ project: cfg, policy, env: { GITHUB_ACTOR: 'author' }, allowNetworkActorResolution: false })
  assert.equal(result.actorId, null)
  assert.equal(result.reason, 'unknown-platform-actor')
})

test('prototype properties do not count as declared repositories or owners', () => {
  const { project: cfg, policy } = makeWorkspace()
  for (const name of ['constructor', 'toString', '__proto__']) {
    const project = { ...cfg, repos: [{ name, path: cfg.repos[0].path }] }
    assert.ok(validateBoundaryPolicy(policy, project).some((message) => message.includes('must be declared')))
    const invalidOwner = structuredClone(policy)
    invalidOwner.repos['mnstry-private-author'].ownerActor = name
    assert.ok(validateBoundaryPolicy(invalidOwner).some((message) => message.includes('is not declared')))
  }
})

test('shared-only boundary check never invokes the optional gh fallback', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX executable marker; identity scoping has portable coverage')
  const { root, project: cfg, policy } = makeWorkspace()
  policy.actors.author.gitEmails = ['unmapped@example.invalid']
  const bin = path.join(root, 'fake-bin')
  const marker = path.join(root, 'gh-invoked')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nprintf invoked > "$ATELIER_TEST_GH_MARKER"\nprintf outside-login\n')
  fs.chmodSync(path.join(bin, 'gh'), 0o755)
  const keys = ['PATH', 'GITHUB_ACTOR', 'MNSTRY_ATELIER_ACTOR', 'ATELIER_TEST_GH_MARKER']
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  t.after(() => { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key] } })
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
  process.env.ATELIER_TEST_GH_MARKER = marker
  delete process.env.GITHUB_ACTOR
  delete process.env.MNSTRY_ATELIER_ACTOR
  const shared = { ...cfg, repos: cfg.repos.filter((repo) => repo.name === 'mystery-example') }
  assert.equal(checkBoundaryPolicy({ project: shared, policy }).ok, true)
  assert.equal(fs.existsSync(marker), false)
})

test('a hand-set platform actor cannot resolve a placeholder login', () => {
  const { project: cfg, policy } = makeWorkspace()
  policy.actors.author.githubLogin = 'AUTHOR_GITHUB_LOGIN_PLACEHOLDER'
  const result = resolveCurrentActor({ project: cfg, policy,
    env: { GITHUB_ACTOR: 'AUTHOR_GITHUB_LOGIN_PLACEHOLDER' }, allowNetworkActorResolution: false })
  assert.equal(result.actorId, null)
  assert.equal(result.reason, 'unknown-platform-actor')
})

test('a removed review marker, or one in a file name, approves nothing', () => {
  const { project: cfg, policy, privateRepo } = makeWorkspace()
  const marker = '\n<!-- Atelier-Boundary-Review: approved — an earlier change -->\n'
  writeDoc(privateRepo, 'doc.md', 'mnstry-private-author:doc', 'private')
  fs.appendFileSync(path.join(privateRepo, 'doc.md'), marker)
  const named = process.platform !== 'win32' ? 'notes/boundary-review: approved.md' : null
  if (named) writeDoc(privateRepo, named, 'mnstry-private-author:named', 'private')
  git(privateRepo, ['add', '.'])
  git(privateRepo, ['commit', '-m', 'seed'])

  const doc = path.join(privateRepo, 'doc.md')
  fs.writeFileSync(doc, fs.readFileSync(doc, 'utf8').replace('audience: "private"', 'audience: "team"').replace(marker, '\n'))
  if (named) {
    const file = path.join(privateRepo, named)
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('audience: "private"', 'audience: "team"'))
  }
  git(privateRepo, ['add', '.'])
  const report = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true })
  const flagged = report.errors.filter((item) => item.code === 'semantic-field-change-needs-review').map((item) => item.path).sort()
  assert.deepEqual(flagged, named ? ['doc.md', named] : ['doc.md'])
})

test('a staged forbidden path with a quoted name is still forbidden', () => {
  const { project: cfg, policy, privateRepo } = makeWorkspace()
  writeDoc(privateRepo, 'doc.md', 'mnstry-private-author:doc', 'private')
  git(privateRepo, ['add', '.'])
  git(privateRepo, ['commit', '-m', 'seed'])
  fs.mkdirSync(path.join(privateRepo, 'transcripts'))
  // Non-ASCII, so Git quotes the name unless it is listed NUL-separated; legal on every platform.
  fs.writeFileSync(path.join(privateRepo, 'transcripts', 'café notes.txt'), 'a session\n')
  git(privateRepo, ['add', '.'])
  const report = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true })
  assert.ok(report.errors.some((item) => item.path === 'transcripts/café notes.txt'), JSON.stringify(report.errors))
})

test('a semantic field change in a document Git reads as binary is still reviewed', () => {
  const { project: cfg, policy, privateRepo } = makeWorkspace()
  writeDoc(privateRepo, 'doc.md', 'mnstry-private-author:doc', 'private')
  git(privateRepo, ['add', '.'])
  git(privateRepo, ['commit', '-m', 'seed'])
  fs.writeFileSync(path.join(privateRepo, '.git', 'info', 'attributes'), '*.md -diff\n')
  const doc = path.join(privateRepo, 'doc.md')
  fs.writeFileSync(doc, fs.readFileSync(doc, 'utf8').replace('audience: "private"', 'audience: "team"'))
  git(privateRepo, ['add', '.'])
  const report = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true })
  assert.ok(report.errors.some((item) => item.code === 'semantic-field-change-needs-review' && item.path === 'doc.md'), JSON.stringify(report.errors))
})

test('an unmerged document blocks the semantic review instead of being skipped', () => {
  const { project: cfg, policy, privateRepo } = makeWorkspace()
  writeDoc(privateRepo, 'doc.md', 'mnstry-private-author:doc', 'private')
  git(privateRepo, ['add', '.'])
  git(privateRepo, ['commit', '-m', 'seed'])
  const base = git(privateRepo, ['rev-parse', '--abbrev-ref', 'HEAD'])
  git(privateRepo, ['checkout', '-q', '-b', 'side'])
  const doc = path.join(privateRepo, 'doc.md')
  fs.appendFileSync(doc, '\nSide text.\n')
  git(privateRepo, ['commit', '-qam', 'side'])
  git(privateRepo, ['checkout', '-q', base])
  fs.appendFileSync(doc, '\nMain text.\n')
  git(privateRepo, ['commit', '-qam', 'main'])
  assert.throws(() => git(privateRepo, ['merge', '-q', 'side']))
  const report = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true })
  assert.ok(report.errors.some((item) => item.code === 'semantic-field-scan-incomplete' && item.path === 'doc.md'), JSON.stringify(report.errors))
})

test('a forbidden path whose name holds a newline is still forbidden', { skip: process.platform === 'win32' && 'names Windows cannot hold' }, () => {
  const { project: cfg, policy, privateRepo } = makeWorkspace()
  writeDoc(privateRepo, 'doc.md', 'mnstry-private-author:doc', 'private')
  git(privateRepo, ['add', '.'])
  git(privateRepo, ['commit', '-m', 'seed'])
  fs.mkdirSync(path.join(privateRepo, 'transcripts'))
  fs.writeFileSync(path.join(privateRepo, 'transcripts', 'a\nb.txt'), 'a session\n')
  git(privateRepo, ['add', '.'])
  const report = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true })
  assert.ok(report.errors.some((item) => item.code === 'forbidden-path-staged' && item.path === 'transcripts/a\nb.txt'), JSON.stringify(report.errors))
})

test('a repo whose staged paths cannot be listed blocks the commit', { skip: process.platform === 'win32' && 'POSIX wrapper script' }, () => {
  const { root, project: cfg, policy, privateRepo } = makeWorkspace()
  writeDoc(privateRepo, 'doc.md', 'mnstry-private-author:doc', 'private')
  git(privateRepo, ['add', '.'])
  git(privateRepo, ['commit', '-m', 'seed'])
  const wrapper = path.join(root, 'git-without-listing')
  fs.writeFileSync(wrapper, '#!/bin/sh\nfor arg in "$@"; do [ "$arg" = "--name-only" ] && exit 128; done\nexec git "$@"\n')
  fs.chmodSync(wrapper, 0o755)
  const report = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true, gitExecutable: wrapper })
  assert.ok(report.errors.some((item) => item.code === 'repo-unscannable' && /staged paths could not be listed/.test(item.message)), JSON.stringify(report.errors))
})



test('ordinary prose and unrelated values containing boundary words are not declarations', () => {
  const file = { hunks: [{ removed: [], added: [
    'title: Audience research notebook',
    '**Context**: Market sensitivity varies by season.',
    'A prompt: how are you handling this today?',
    '- "topic:objection-handling"',
    '### Step 4: Test with a new audience',
    '{"title":"Ordinary sensitivity research","description":"Understanding an audience"}',
  ] }] }
  assert.deepEqual(semanticChangesInFile(file), [])
})

test('compact sidecar JSON requires review when a later field changes', () => {
  const file = { hunks: [{
    removed: ['{"kg":{"audience":"private"},"handling":"restricted"}'],
    added: ['{"kg":{"audience":"private"},"handling":"open"}'],
  }] }
  assert.ok(semanticChangesInFile(file).length)
  assert.ok(semanticChangesInFile({ hunks: [{ removed: [], added: ['  audience: team'] }] }).length)
  assert.ok(semanticChangesInFile({ hunks: [{ removed: ['  sensitivity: high'], added: [] }] }).length)
})

test('initial staged metadata diff larger than the default subprocess buffer is fully checked', () => {
  const { project: cfg, policy, privateRepo } = makeWorkspace()
  writeDoc(privateRepo, 'large.md', 'mnstry-private-author:large', 'private')
  fs.appendFileSync(path.join(privateRepo, 'large.md'), 'Ordinary synthetic note.\n'.repeat(60000))
  git(privateRepo, ['add', '.'])
  let report = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true })
  assert.equal(report.ok, true, report.errors.map((item) => item.message).join('\n'))
  writeDoc(privateRepo, 'tail.md', 'mnstry-private-author:tail', 'team')
  git(privateRepo, ['add', '.'])
  report = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true })
  assert.ok(report.errors.some((item) => item.code === 'semantic-field-change-needs-review' && item.path === 'tail.md'))
})

test('JSON property fragments and YAML kg flow declarations retain the review gate', () => {
  for (const line of [
    '"title":"Example", "audience":"team"',
    '"title":"Example", "audience":"team",',
    'kg: { audience: team }',
    'kg: { title: "Example, audience: prose", audience: team }',
    "kg: { title: 'Example, audience: prose', audience: team }",
  ]) {
    const changes = semanticChangesInFile({ hunks: [{ removed: [], added: [line] }] })
    assert.ok(changes.some((item) => item.includes('audience introduced')), line)
  }
  for (const line of [
    '"title":"Example, audience: prose",',
    'kg: { title: "Example, audience: prose" }',
    "kg: { title: 'Example, audience: prose' }",
  ]) assert.ok(semanticChangesInFile({ hunks: [{ removed: [], added: [line] }] }).length, line)
})

test('partial, nested and collection declarations cannot silently remove the review gate', () => {
  const forms = [
    '{ "audience": "team",',
    '"id": "x", "audience": "team" }',
    '"kg": { "audience": "team",',
    'kg: { id: x, audience: team,',
    'kg: { access: { audience: team } }',
    'access: { audience: team }',
    '- { audience: team }',
    '{ kg: { audience: team } }',
    '[{"audience":"team"}]',
    '}, "audience": "team"',
    '], "audience": "team"',
    '{ "audience": "team',
  ]
  for (const line of forms) {
    const file = { hunks: [{ removed: [], added: [line] }] }
    assert.ok(semanticChangesInFile(file).some(item => item.startsWith('audience introduced')), line)
    assert.ok(semanticChangesInFile({ hunks: [{ removed: [line], added: [] }] }).some(item => item.startsWith('audience removed')), line)
    assert.ok(semanticChangesInFile({ hunks: [{ removed: [line.replace('team', 'private')], added: [line] }] }).some(item => item.startsWith('audience changed')), line)
  }
  for (const line of [
    '{ "title": "audience: team",',
    'kg: { title: "audience: team",',
    '["audience: team"]',
    "{ title: 'It''s prose, audience: team' }",
  ]) assert.ok(semanticChangesInFile({ hunks: [{ removed: [], added: [line] }] }).length, line)
})

test('semanticFieldOnLine preserves the legacy public helper and conservative fallback', () => {
  assert.deepEqual(semanticFieldOnLine('Audience research: an ordinary title'), { field: null, value: null, raw: 'Audience research: an ordinary title' })
  assert.equal(semanticFieldOnLine('Ordinary audience research'), null)
  assert.deepEqual(semanticFieldOnLine('  audience: private'), { field: 'audience', value: 'private', raw: 'audience: private' })
  assert.equal(semanticFieldOnLine('{"handling":"restricted","audience":"team"}').field, 'handling')
  assert.equal(semanticFieldOnLine('{"\\u0061udience":"team"}'), null)
  assert.equal(semanticFieldOnLine('{ "audience": "team",').field, 'audience')
  assert.equal(semanticFieldOnLine('{"audience":"team","title":"Example"}').value, '"team","title":"Example"}')
})

test('literal assignment coverage is preserved across unknown prefix and quote contexts', () => {
  for (const prefix of ['', '# note ', 'issue #4", ', 'title: "', '],', '{ ?', '!<tag:yaml.org,2002:str> ', 'a quoted value:\", ']) {
    for (const field of ['audience', 'kg.audience', 'handling', 'sensitivity', 'data_boundary']) {
      const line = `${prefix}${field}: team }`
      const legacy = semanticFieldOnLine(line)
      if (!legacy?.field) continue
      assert.ok(semanticChangesInFile({ hunks: [{ added: [line], removed: [] }] }).length, line)
      assert.ok(semanticChangesInFile({ hunks: [{ added: [], removed: [line] }] }).length, line)
    }
  }
})

for (const [label, line] of [
  ['wrapped quoted value', '"A long title", "audience": "team"}'],
  ['wrapped collection value', 'gamma], audience: team }'],
  ['wrapped plain value', 'title, audience: team }'],
  ['wrapped numeric value', '2], "audience": "team"'],
  ['ambiguous closing quote', '\", audience: team }'],
  ['ambiguous closing quote before JSON key', '\", "audience": "team"}'],
  ['ambiguous leading apostrophe', "'s notes, audience: team }"],
  ['anchored key', '&example audience: team'],
  ['tagged key', '!!str audience: team'],
  ['nested tagged key', 'kg: { !!str audience: team }'],
  ['plain apostrophe', "kg: { title: Rowan's notes, audience: team }"],
  ['plain double quote', 'kg: { title: a 12" ruler, audience: team }'],
  ['plain URL fragment', 'kg: { source: https://example.invalid/a#b, audience: team }'],
  ['plain hash', 'kg: { title: issue#12, audience: team }'],
  ['continuation beginning with hash', '#12 follow-up", audience: team }'],
  ['continuation with spaced hash', 'issue #4", audience: team }'],
  ['continuation with colon', 'related reading list:", audience: team }'],
  ['plain value ending with colon quote', 'kg: { title: Note:", audience: team }'],
  ['compact ambiguous key', '",audience: team }'],
  ['compact nested ambiguous key', '", {audience: team}'],
  ['explicit flow key', '{ ? audience : team }'],
  ['verbatim tagged key', '!<tag:yaml.org,2002:str> audience: team'],
  ['list declaration', '- audience: team'],
  ['list mapping', '- { audience: team }'],
]) {
  test(`real staged diff requires review for ${label} addition, removal and narrowing`, () => {
    const { project: cfg, policy, privateRepo } = makeWorkspace()
    const file = path.join(privateRepo, 'fragment.md')
    const write = value => fs.writeFileSync(file, `---\n${value}\n---\n\n# Example\n`)
    const check = operation => {
      git(privateRepo, ['add', 'fragment.md'])
      const result = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true })
      assert.ok(result.errors.some(item => item.code === 'semantic-field-change-needs-review' && item.path === 'fragment.md'), `${operation}: ${line}`)
    }
    write('title: Example')
    git(privateRepo, ['add', '.'])
    git(privateRepo, ['commit', '-m', 'seed'])
    write(line)
    check('addition')
    git(privateRepo, ['commit', '-m', 'fixture declaration'])
    write(line.replace('team', 'private'))
    check('narrowing')
    write('title: Example')
    check('removal')
  })
}

test('assignment-looking text stays conservative in ambiguous and quoted contexts', () => {
  for (const line of ['Research notes, audience: readers', '{"\\u0061udience":"team"}']) {
    assert.ok(semanticChangesInFile({ hunks: [{ removed: [], added: [line] }] }).length, line)
  }
  for (const line of ['title: "Rowan\'s notes, audience: prose"', 'kg: { title: "issue#12, audience: prose" }']) {
    assert.ok(semanticChangesInFile({ hunks: [{ removed: [], added: [line] }] }).length, line)
  }
  assert.ok(semanticChangesInFile({ hunks: [{ removed: [], added: ['audience: private#suffix'] }] }).length)
  assert.ok(semanticChangesInFile({ hunks: [{ removed: [], added: ['audience: private, team'] }] }).length)
})

test('an oversized staged diff is refused as unscannable rather than scanning truncated bytes', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX synthetic git executable')
  const { root, project: cfg, policy, privateRepo } = makeWorkspace()
  writeDoc(privateRepo, 'note.md', 'mnstry-private-author:note', 'private')
  git(privateRepo, ['add', '.'])
  const executable = path.join(root, 'bounded-git')
  fs.writeFileSync(executable, `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');\nif(process.argv.includes('--unified=0')) process.stdout.write('x'.repeat(65*1024*1024));\nelse {const r=spawnSync('git',process.argv.slice(2),{stdio:'inherit'});process.exit(r.status??1);}\n`, { mode: 0o755 })
  const report = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true, gitExecutable: executable })
  assert.equal(report.ok, false)
  assert.ok(report.errors.some(item => item.code === 'repo-unscannable' && item.message.includes('git diff --cached failed')))
})

for (const suffix of ['md', 'kg.json']) {
  for (const classification of ['NUL body', 'binary attribute']) {
    test(`semantic review inspects ${suffix} despite ${classification}`, () => {
      const { project: cfg, policy, privateRepo } = makeWorkspace()
      const name = `metadata.${suffix}`
      const file = path.join(privateRepo, name)
      const write = audience => fs.writeFileSync(file, suffix === 'md'
        ? `---\naudience: ${audience}\n---\n${classification === 'NUL body' ? '\0' : ''}\n`
        : `{"audience":"${audience}"}\n${classification === 'NUL body' ? '\0' : ''}`)
      if (classification === 'binary attribute') fs.writeFileSync(path.join(privateRepo, '.gitattributes'), `${name} -diff\n`)
      write('private')
      git(privateRepo, ['add', '.'])
      git(privateRepo, ['commit', '-m', 'seed metadata'])
      write('team')
      git(privateRepo, ['add', name])
      assert.match(git(privateRepo, ['diff', '--cached']), /Binary files/)
      const result = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true })
      assert.ok(result.errors.some(item => item.code === 'semantic-field-change-needs-review' && item.path === name))
    })
  }
}

for (const context of ['removed marker', 'path header', 'hunk heading']) {
  test(`a ${context} cannot approve a semantic change`, { skip: process.platform === 'win32' && context === 'path header' && 'names Windows cannot hold' }, () => {
    const { project: cfg, policy, privateRepo } = makeWorkspace()
    const marker = 'Atelier-Boundary-Review: approved'
    const name = context === 'path header' ? `${marker}.md` : 'metadata.md'
    const file = path.join(privateRepo, name)
    const prefix = context === 'hunk heading' ? `${marker}\n\n` : ''
    if (context === 'hunk heading') {
      fs.writeFileSync(path.join(privateRepo, '.gitattributes'), '*.md diff=review\n')
      git(privateRepo, ['config', 'diff.review.xfuncname', `^${marker}$`])
    }
    fs.writeFileSync(file, `${prefix}audience: private\n${context === 'removed marker' ? marker + '\n' : ''}`)
    git(privateRepo, ['add', '.'])
    git(privateRepo, ['commit', '-m', 'seed marker context'])
    fs.writeFileSync(file, `${prefix}audience: team\n`)
    git(privateRepo, ['add', name])
    const diff = git(privateRepo, ['diff', '--cached', '--unified=0'])
    if (context === 'hunk heading') assert.ok(diff.split('\n').some(line => line.startsWith('@@') && line.includes(marker)))
    const result = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true })
    assert.ok(result.errors.some(item => item.code === 'semantic-field-change-needs-review' && item.path === name))
  })
}

test('quoted metadata paths retain added-content review markers', { skip: process.platform === 'win32' && 'names Windows cannot hold' }, () => {
  const { project: cfg, policy, privateRepo } = makeWorkspace()
  const name = 'quoted"name.md'
  fs.writeFileSync(path.join(privateRepo, name), 'audience: team\nAtelier-Boundary-Review: approved\n')
  git(privateRepo, ['add', '.'])
  const result = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true })
  assert.equal(result.ok, true)
})

test('semantic acquisition retains canonical prefixes despite repository diff configuration', () => {
  const { project: cfg, policy, privateRepo } = makeWorkspace()
  git(privateRepo, ['config', 'diff.noprefix', 'true'])
  git(privateRepo, ['config', 'color.diff', 'always'])
  fs.writeFileSync(path.join(privateRepo, 'metadata.md'), 'audience: team\n')
  git(privateRepo, ['add', '.'])
  const result = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true })
  assert.ok(result.errors.some(item => item.code === 'semantic-field-change-needs-review' && item.path === 'metadata.md'))
})

for (const name of ['café.md', 'notes b/odd.md']) {
  test(`semantic declarations retain the exact decoded ${JSON.stringify(name)} path`, () => {
    const { project: cfg, policy, privateRepo } = makeWorkspace()
    fs.mkdirSync(path.dirname(path.join(privateRepo, name)), { recursive: true })
    fs.writeFileSync(path.join(privateRepo, name), 'audience: team\n')
    git(privateRepo, ['add', '.'])
    const result = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true })
    assert.ok(result.errors.some(item => item.code === 'semantic-field-change-needs-review' && item.path === name))
    assert.equal(result.errors.some(item => item.code === 'repo-unscannable'), false)
  })
}

test('NUL-delimited paths preserve forbidden paths containing newlines', { skip: process.platform === 'win32' && 'names Windows cannot hold' }, () => {
  const { project: cfg, policy, privateRepo } = makeWorkspace()
  const name = 'transcripts/café\nnotes.txt'
  fs.mkdirSync(path.dirname(path.join(privateRepo, name)), { recursive: true })
  fs.writeFileSync(path.join(privateRepo, name), 'ordinary\n')
  git(privateRepo, ['add', '.'])
  const result = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true })
  assert.ok(result.errors.some(item => item.code === 'forbidden-path-staged' && item.path === name))
})

for (const mode of ['failure', 'oversized', 'unterminated']) {
  test(`staged path evidence ${mode} fails closed`, (t) => {
    if (process.platform === 'win32') return t.skip('POSIX synthetic git executable')
    const { root, project: cfg, policy, privateRepo } = makeWorkspace()
    fs.writeFileSync(path.join(privateRepo, 'ordinary.md'), 'ordinary\n')
    git(privateRepo, ['add', '.'])
    const executable = path.join(root, 'path-git')
    const action = mode === 'failure' ? 'process.exit(1)' : mode === 'oversized' ? "process.stdout.write('x'.repeat(65*1024*1024))" : "process.stdout.write('unfinished')"
    fs.writeFileSync(executable, `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');\nif(process.argv.includes('--name-only')) {${action};} else {const r=spawnSync('git',process.argv.slice(2),{stdio:'inherit'});process.exit(r.status??1);}\n`, { mode: 0o755 })
    const report = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true, gitExecutable: executable })
    assert.ok(report.errors.some(item => item.code === 'repo-unscannable' && item.message.includes('staged paths could not be listed')))
  })
}

test('whole Markdown retirement needs no impossible marker in the deleted file', () => {
  const { project: cfg, policy, privateRepo } = makeWorkspace()
  fs.writeFileSync(path.join(privateRepo, 'retired.md'), 'audience: private\n')
  git(privateRepo, ['add', '.'])
  git(privateRepo, ['commit', '-m', 'seed document'])
  git(privateRepo, ['rm', 'retired.md'])
  const report = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true })
  assert.equal(report.ok, true)
})

test('sidecar retirement preserves the boundary of an asset retained in the index', () => {
  const { project: cfg, policy, privateRepo } = makeWorkspace()
  fs.writeFileSync(path.join(privateRepo, 'asset.txt'), 'ordinary\n')
  fs.writeFileSync(path.join(privateRepo, 'asset.txt.kg.json'), '{"audience":"private"}\n')
  git(privateRepo, ['add', '.'])
  git(privateRepo, ['commit', '-m', 'seed asset and sidecar'])
  git(privateRepo, ['rm', 'asset.txt.kg.json'])
  let report = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true })
  assert.ok(report.errors.some(item => item.code === 'sidecar-retirement-needs-asset-review'))
  git(privateRepo, ['rm', 'asset.txt'])
  report = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true })
  assert.equal(report.ok, true)
})

test('a heavily rewritten rename still requires review for the new wider declaration', () => {
  const { project: cfg, policy, privateRepo } = makeWorkspace()
  fs.writeFileSync(path.join(privateRepo, 'old.md'), 'audience: private\n' + 'old text\n'.repeat(30))
  git(privateRepo, ['add', '.'])
  git(privateRepo, ['commit', '-m', 'seed old document'])
  git(privateRepo, ['mv', 'old.md', 'new.md'])
  fs.writeFileSync(path.join(privateRepo, 'new.md'), 'audience: team\n' + 'new text\n'.repeat(30))
  git(privateRepo, ['add', '.'])
  const report = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true })
  assert.ok(report.errors.some(item => item.code === 'semantic-field-change-needs-review' && item.path === 'new.md'))
})

test('sidecar retirement judges the hook index instead of the ordinary index or working tree', () => {
  const { root, project: cfg, policy, privateRepo } = makeWorkspace()
  fs.writeFileSync(path.join(privateRepo, 'asset.txt'), 'ordinary asset\n')
  fs.writeFileSync(path.join(privateRepo, 'asset.txt.kg.json'), '{"kg":{"audience":"private"}}\n')
  git(privateRepo, ['add', '.'])
  git(privateRepo, ['commit', '-m', 'synthetic asset classification'])
  const indexFile = path.join(root, 'retirement-index')
  fs.copyFileSync(path.join(privateRepo, '.git', 'index'), indexFile)
  git(privateRepo, ['rm', 'asset.txt.kg.json'])
  execFileSync('git', ['-C', privateRepo, 'rm', '--cached', 'asset.txt', 'asset.txt.kg.json'], {
    env: { ...process.env, GIT_INDEX_FILE: indexFile },
  })
  const ordinary = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true })
  assert.ok(ordinary.errors.some(item => item.code === 'sidecar-retirement-needs-asset-review'))
  const committing = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true,
    hookIndex: { workTree: fs.realpathSync.native(privateRepo), indexFile, commonDir: null },
  })
  assert.equal(committing.ok, true)
})

test('forbidden paths remain visible when a tracked file changes type', (t) => {
  if (process.platform === 'win32') return t.skip('synthetic symlink requires an enabled Windows symlink privilege')
  const { project: cfg, policy, privateRepo } = makeWorkspace()
  const name = 'transcripts/item.txt'
  fs.mkdirSync(path.join(privateRepo, 'transcripts'), { recursive: true })
  fs.writeFileSync(path.join(privateRepo, name), 'ordinary\n')
  git(privateRepo, ['add', '.'])
  git(privateRepo, ['commit', '-m', 'synthetic historical path'])
  fs.unlinkSync(path.join(privateRepo, name))
  fs.symlinkSync('elsewhere.txt', path.join(privateRepo, name))
  git(privateRepo, ['add', name])
  assert.match(git(privateRepo, ['diff', '--cached', '--name-status']), /^T\s/)
  const report = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true })
  assert.ok(report.errors.some(item => item.code === 'forbidden-path-staged' && item.path === name))
})

test('sidecar retirement retains an NFD-stored asset with Unicode precomposition enabled', { skip: process.platform === 'win32' && 'POSIX filename/index fixture' }, () => {
  const { project: cfg, policy, privateRepo } = makeWorkspace()
  const name = 're\u0301sume\u0301.txt'
  fs.writeFileSync(path.join(privateRepo, name), 'ordinary asset\n')
  fs.writeFileSync(path.join(privateRepo, name + '.kg.json'), '{"audience":"private"}\n')
  git(privateRepo, ['-c', 'core.precomposeUnicode=false', 'add', '.'])
  git(privateRepo, ['commit', '-m', 'synthetic decomposed asset'])
  git(privateRepo, ['config', 'core.precomposeUnicode', 'true'])
  git(privateRepo, ['-c', 'core.precomposeUnicode=false', 'rm', name + '.kg.json'])
  const report = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true })
  assert.ok(report.errors.some(item => item.code === 'sidecar-retirement-needs-asset-review'), JSON.stringify(report.errors))
})

test('sidecar retirement compares opaque asset name bytes with quoting disabled', { skip: process.platform === 'win32' && 'POSIX byte filename fixture' }, () => {
  const { project: cfg, policy, privateRepo } = makeWorkspace()
  const raw = Buffer.concat([Buffer.from([255]), Buffer.from('.txt')])
  const sidecar = Buffer.concat([raw, Buffer.from('.kg.json')])
  setByteIndexEntry(privateRepo, raw, 'ordinary asset\n')
  setByteIndexEntry(privateRepo, sidecar, '{"audience":"private"}\n')
  git(privateRepo, ['commit', '-m', 'synthetic byte named asset'])
  git(privateRepo, ['config', 'core.quotePath', 'false'])
  setByteIndexEntry(privateRepo, sidecar)
  let report = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true })
  assert.ok(report.errors.some(item => item.code === 'sidecar-retirement-needs-asset-review'), JSON.stringify(report.errors))
  setByteIndexEntry(privateRepo, raw)
  report = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true })
  assert.equal(report.ok, true, JSON.stringify(report.errors))
})

for (const extension of ['md', 'txt']) {
  test(`opaque ${extension} filename additions refuse but whole-file retirement remains guarded`, { skip: process.platform === 'win32' && 'POSIX byte filename fixture' }, () => {
    const { project: cfg, policy, privateRepo } = makeWorkspace()
    const raw = Buffer.concat([Buffer.from([255]), Buffer.from('.' + extension)])
    setByteIndexEntry(privateRepo, raw, extension === 'md' ? 'audience: private\n' : 'ordinary\n')
    git(privateRepo, ['config', 'core.quotePath', 'false'])
    const added = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true })
    assert.equal(added.ok, false, JSON.stringify(added.errors))
    git(privateRepo, ['commit', '-m', 'synthetic historical byte name'])
    setByteIndexEntry(privateRepo, raw)
    const retired = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true })
    assert.equal(retired.ok, true, JSON.stringify(retired.errors))
  })
}

function setByteIndexEntry(repoRoot, nameBytes, content = null) {
  const oid = content === null ? '0'.repeat(40) : execFileSync('git', ['-C', repoRoot, 'hash-object', '-w', '--stdin'], { input: content }).toString().trim()
  execFileSync('git', ['-C', repoRoot, 'update-index', '-z', '--index-info'], {
    input: Buffer.concat([Buffer.from(`${content === null ? '0' : '100644'} ${oid}\t`), nameBytes, Buffer.from([0])]),
  })
}

for (const mode of ['failure', 'oversized', 'unterminated']) {
  test(`sidecar asset index evidence ${mode} fails closed`, { skip: process.platform === 'win32' && 'POSIX synthetic Git executable' }, () => {
    const { root, project: cfg, policy, privateRepo } = makeWorkspace()
    fs.writeFileSync(path.join(privateRepo, 'asset.txt'), 'ordinary\n')
    fs.writeFileSync(path.join(privateRepo, 'asset.txt.kg.json'), '{"audience":"private"}\n')
    git(privateRepo, ['add', '.'])
    git(privateRepo, ['commit', '-m', 'synthetic sidecar evidence'])
    git(privateRepo, ['rm', 'asset.txt.kg.json'])
    const executable = path.join(root, 'asset-evidence-git')
    const action = mode === 'failure' ? 'process.exit(1)' : mode === 'oversized' ? "process.stdout.write('x'.repeat(65*1024*1024))" : "process.stdout.write('unfinished')"
    fs.writeFileSync(executable, `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');\nif(process.argv.includes('ls-files')) {${action};} else {const r=spawnSync('git',process.argv.slice(2),{stdio:'inherit'});process.exit(r.status??1);}\n`, { mode: 0o755 })
    const report = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true, gitExecutable: executable })
    assert.ok(report.errors.some(item => item.code === 'repo-unscannable' && item.message.includes('sidecar retirement asset evidence')), JSON.stringify(report.errors))
  })
}

test('an opaque historical name can be renamed to a UTF-8 document through the guard', { skip: process.platform === 'win32' && 'POSIX byte filename fixture' }, () => {
  const { project: cfg, policy, privateRepo } = makeWorkspace()
  const raw = Buffer.concat([Buffer.from([255]), Buffer.from('.md')])
  setByteIndexEntry(privateRepo, raw, 'audience: private\n')
  git(privateRepo, ['commit', '-m', 'synthetic historical name'])
  setByteIndexEntry(privateRepo, raw)
  fs.writeFileSync(path.join(privateRepo, 'ordinary.md'), 'audience: private\n')
  git(privateRepo, ['add', 'ordinary.md'])
  const report = checkBoundaryPolicy({ project: cfg, policy, actor: 'author', staged: true, stagedOnly: true })
  assert.equal(report.ok, true, JSON.stringify(report.errors))
})
