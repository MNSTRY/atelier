import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { PROJECT_CONFIG_SCHEMA, commandProject, validateProjectConfigDoc, writeJson } from '../src/project/config.mjs'
import { auditRepoIdentities, identityKey, parseRemoteRef, resolveRepoIdentity } from '../src/project/repo-identity.mjs'

// The 2026-07 client-zero rename chains (repo names fictionalized here): press ->
// journal -> studio-journal, and product-development -> catalog -> studio-catalog.
// Stale clones kept fetching through the provider redirect, so nothing looked
// broken while two repos silently stopped syncing for weeks.
const RENAMED_ID = '900001'
const SIBLING_A_ID = '900002'
const SIBLING_B_ID = '900003'

const REGISTRY = {
  // Old and new names resolve to one stable id, exactly as the provider redirect does.
  'acme/journal': { id: RENAMED_ID, fullName: 'acme/studio-journal' },
  'acme/studio-journal': { id: RENAMED_ID, fullName: 'acme/studio-journal' },
  'acme/site-one': { id: SIBLING_A_ID, fullName: 'acme/site-one' },
  'acme/site-two': { id: SIBLING_B_ID, fullName: 'acme/site-two' },
}

const lookups = {
  github: ({ owner, name }) => {
    const found = REGISTRY[`${owner}/${name}`]
    if (!found) return null
    return { id: found.id, fullName: found.fullName, currentName: found.fullName.split('/').pop() }
  },
}

const offline = { github: () => null }

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
}

// Clones made from one template share a root commit. The old duplicate guard keyed
// on that and conflated genuinely different repos.
function makeClone(root, folder, remote, { rootCommitFrom = null } = {}) {
  const dir = path.join(root, folder)
  if (rootCommitFrom) {
    execFileSync('git', ['clone', '--quiet', '--local', '--no-hardlinks', rootCommitFrom, dir], { encoding: 'utf8' })
    git(dir, ['remote', 'remove', 'origin'])
  } else {
    fs.mkdirSync(dir, { recursive: true })
    git(dir, ['init', '--quiet'])
    git(dir, ['config', 'user.email', 'author@example.invalid'])
    git(dir, ['config', 'user.name', 'Author'])
    fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n')
    git(dir, ['add', '.'])
    git(dir, ['commit', '--quiet', '-m', 'seed'])
  }
  git(dir, ['remote', 'add', 'origin', remote])
  return dir
}

function makeProject(t, repos, clones) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-identity-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const clone of clones) makeClone(root, clone.folder, clone.remote, clone)
  writeJson(path.join(root, 'atelier.project.json'), {
    schema: PROJECT_CONFIG_SCHEMA,
    roots: { workspace: '.', repoOps: '.' },
    repos,
  })
  return { root, project: commandProject({ argv: ['--project', path.join(root, 'atelier.project.json')], cwd: root, env: {} }) }
}

test('a renamed repo keeps its identity and reports the new canonical name', (t) => {
  const { project } = makeProject(
    t,
    [{ name: 'journal', path: 'journal', readBoundary: 'team' }],
    [{ folder: 'journal', remote: 'https://github.com/acme/journal.git' }],
  )
  const identity = resolveRepoIdentity(project.repos[0].path, { repo: project.repos[0], lookups })

  assert.equal(identity.id, RENAMED_ID)
  assert.equal(identity.remoteName, 'journal')
  assert.equal(identity.currentName, 'studio-journal')
  assert.equal(identity.renamed, true)
  assert.equal(identity.source, 'provider')

  const audit = auditRepoIdentities(project, { lookups })
  assert.ok(audit.findings.some((item) => item.code === 'repo-renamed-upstream'))
  assert.ok(audit.findings.some((item) => item.code === 'repo-folder-name-stale'))
})

test('a stale clone left by a rename is reported once as a duplicate, not as two repos', (t) => {
  const { project } = makeProject(
    t,
    [
      { name: 'studio-journal', path: 'studio-journal', readBoundary: 'team', identity: { provider: 'github', id: RENAMED_ID } },
      { name: 'studio-journal-old', path: 'studio-journal-old', readBoundary: 'team', aliases: ['journal'] },
    ],
    [
      { folder: 'studio-journal', remote: 'https://github.com/acme/studio-journal.git' },
      { folder: 'studio-journal-old', remote: 'https://github.com/acme/journal.git' },
    ],
  )
  const audit = auditRepoIdentities(project, { lookups })
  const duplicates = audit.findings.filter((item) => item.code === 'repo-identity-duplicate')

  assert.equal(duplicates.length, 1, 'exactly one warning, not one per tick per clone')
  assert.equal(audit.ok, false)
  assert.match(duplicates[0].message, /resolve to one repository \(github:900001\)/)
  assert.equal(duplicates[0].repo, 'studio-journal-old', 'the canonical clone is kept, the retired one is flagged')
})

test('two repos created from one template are never conflated', (t) => {
  const seedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-template-'))
  t.after(() => fs.rmSync(seedRoot, { recursive: true, force: true }))
  const template = makeClone(seedRoot, 'template', 'https://github.com/acme/template.git')

  const { project } = makeProject(
    t,
    [
      { name: 'site-one', path: 'site-one', readBoundary: 'team' },
      { name: 'site-two', path: 'site-two', readBoundary: 'team' },
    ],
    [
      { folder: 'site-one', remote: 'https://github.com/acme/site-one.git', rootCommitFrom: template },
      { folder: 'site-two', remote: 'https://github.com/acme/site-two.git', rootCommitFrom: template },
    ],
  )

  const roots = project.repos.map((repo) => git(repo.path, ['rev-list', '--max-parents=0', 'HEAD']))
  assert.equal(roots[0], roots[1], 'fixture must actually share a root commit')

  const audit = auditRepoIdentities(project, { lookups })
  assert.deepEqual(audit.findings.filter((item) => item.code === 'repo-identity-duplicate'), [])
  const keys = project.repos.map((repo) => identityKey(resolveRepoIdentity(repo.path, { repo, lookups })))
  assert.notEqual(keys[0], keys[1])
})

test('a recorded identity resolves the repo when the provider is unreachable', (t) => {
  const { project } = makeProject(
    t,
    [{ name: 'studio-journal', path: 'studio-journal', readBoundary: 'team', identity: { provider: 'github', id: RENAMED_ID } }],
    [{ folder: 'studio-journal', remote: 'https://github.com/acme/journal.git' }],
  )
  const identity = resolveRepoIdentity(project.repos[0].path, { repo: project.repos[0], lookups: offline })

  assert.equal(identity.ok, true)
  assert.equal(identity.id, RENAMED_ID)
  assert.equal(identity.source, 'recorded-identity')
  assert.equal(identity.reachable, false, 'the resolver must say it is guessing offline, not pretend it confirmed')
})

test('an old name resolves through a declared alias with a deprecation notice', (t) => {
  const { project } = makeProject(
    t,
    [{ name: 'studio-journal', path: 'studio-journal', readBoundary: 'team', aliases: ['journal', 'press'] }],
    [{ folder: 'studio-journal', remote: 'https://github.com/acme/journal.git' }],
  )
  const identity = resolveRepoIdentity(project.repos[0].path, { repo: project.repos[0], lookups: offline })
  assert.equal(identity.source, 'alias')
  assert.equal(identity.currentName, 'studio-journal')

  const audit = auditRepoIdentities(project, { lookups: offline })
  assert.equal(audit.ok, true, 'a declared alias is not an error')
})

test('a clone with no origin remote is reported rather than assumed unique', (t) => {
  const { project } = makeProject(t, [{ name: 'orphan', path: 'orphan', readBoundary: 'team' }], [])
  const dir = path.join(project.repos[0].path)
  fs.mkdirSync(dir, { recursive: true })
  git(dir, ['init', '--quiet'])

  const audit = auditRepoIdentities(project, { lookups })
  assert.ok(audit.findings.some((item) => item.code === 'repo-identity-unresolved'))
})

test('remote refs parse across url shapes and reject non-repo urls', () => {
  assert.deepEqual(parseRemoteRef('git@github.com:Acme/Site-One.git'), {
    host: 'github.com',
    provider: 'github',
    owner: 'acme',
    name: 'site-one',
  })
  assert.equal(parseRemoteRef('https://github.com/acme/site.git').provider, 'github')
  assert.equal(parseRemoteRef('https://git.example.test/acme/site.git').provider, null, 'unknown hosts have no provider lookup')
  assert.equal(parseRemoteRef('https://github.com/acme'), null)
  assert.equal(parseRemoteRef(''), null)
})

test('identity and aliases are validated in the project contract', () => {
  const base = (repo) => ({ schema: PROJECT_CONFIG_SCHEMA, roots: { workspace: '.', repoOps: '.' }, repos: [repo] })

  assert.deepEqual(validateProjectConfigDoc(base({ name: 'a', path: 'a', identity: { provider: 'github', id: '12' }, aliases: ['b'] })), [])
  assert.match(
    validateProjectConfigDoc(base({ name: 'a', path: 'a', identity: { provider: 'gitlab', id: '12' } })).join('\n'),
    /identity\.provider must be one of github/,
  )
  assert.match(
    validateProjectConfigDoc(base({ name: 'a', path: 'a', identity: { provider: 'github' } })).join('\n'),
    /identity\.id is required and must be the provider's stable id, not a name/,
  )
  assert.match(validateProjectConfigDoc(base({ name: 'a', path: 'a', aliases: ['a'] })).join('\n'), /must not repeat the current name/)
  assert.match(validateProjectConfigDoc(base({ name: 'a', path: 'a', aliases: ['b', 'B'] })).join('\n'), /must not repeat a name/)
})

test('external repos are outside identity management', (t) => {
  const { project } = makeProject(
    t,
    [
      { name: 'managed', path: 'managed', readBoundary: 'team', identity: { provider: 'github', id: SIBLING_A_ID } },
      { name: 'vendor', path: 'vendor', kind: 'external' },
    ],
    [
      { folder: 'managed', remote: 'https://github.com/acme/site-one.git' },
      { folder: 'vendor', remote: 'https://git.example.test/x/y.git' },
    ],
  )
  const audit = auditRepoIdentities(project, { lookups })
  assert.deepEqual(audit.findings.filter((item) => item.repo === 'vendor'), [])
})
