import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { upgradeTestGit } from './upgrade-test-git.mjs'

const git = (root, args) => {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
const put = (root, name, value) => fs.writeFileSync(path.join(root, name), `${JSON.stringify(value, null, 2)}\n`)
function fixture(consumerRoot) {
  const parent = fs.mkdtempSync(path.join(consumerRoot, 'upgrade-proof-'))
  const source = path.join(parent, 'source')
  const root = path.join(parent, 'candidate')
  fs.mkdirSync(source)
  git(source, ['init'])
  git(source, ['config', 'user.name', 'Example Author'])
  git(source, ['config', 'user.email', 'author@example.invalid'])
  git(source, ['config', 'commit.gpgsign', 'false'])
  fs.writeFileSync(path.join(source, '.gitignore'), '.atelier-local/\natelier-output/\n')
  fs.writeFileSync(path.join(source, 'seed.md'), '---\ntitle: Seed\nkg:\n  id: "workspace:seed"\n  type: "document"\n  status: "active"\n  audience: "private"\n---\n# Seed\n')
  put(source, 'atelier.project.json', { schema: 'mnstry.atelier-project-config@v1', name: 'Example Workshop', roots: { workspace: '.' }, graph: { repoAccessPath: 'repo-access.v1.json', outputPath: 'atelier-output/knowledge.graph.json' }, projection: { outputRoot: 'atelier-output', readinessPath: 'atelier-output/atelier-readiness.json' }, boundaries: { policyPath: 'boundary-policy.v1.json' }, repos: [{ name: 'workspace', path: '.', readBoundary: 'private' }], ext: { 'mnstry.atelier': { distribution: { name: 'Example Workshop', theme: { accent: '#abcdef' } } } } })
  put(source, 'repo-access.v1.json', { schema: 'mnstry.atelier-repo-access@v1', defaultReadBoundary: 'private', repos: { workspace: { readBoundary: 'private' } } })
  put(source, 'boundary-policy.v1.json', { schema: 'mnstry.atelier-boundary-policy@v1', mode: 'strict', actors: { author: { githubLogin: 'author', gitEmails: ['author@example.invalid'], privateDomainRepo: 'workspace' } }, repos: { workspace: { kind: 'private_domain', ownerActor: 'author', readBoundary: 'private', allowedAudiences: ['private'], forbiddenAudiences: [], autoCommit: 'guarded' } }, promotion: { requiresGitPromote: true, recordsPath: 'governance/events.jsonl' }, forbiddenPaths: [] })
  put(source, 'atelier.adoption-policy.json', { schema: 'mnstry.atelier-adoption-policy@v1', enabled: true, mode: 'manual-exact-plan', maxAgeSeconds: 86400, recoveryCoverage: 'local-only', allowedEffects: ['lock-and-projections', 'git-commit'] })
  git(source, ['add', '.'])
  git(source, ['commit', '-m', 'Seed synthetic workspace'])
  git(source, ['worktree', 'add', '-b', 'example-upgrade', root])
  return { source, root }
}
// Runs against the installed tarball, including npm's ordinary hoisted layout.
export function verifyInstalledUpgrade({ installedRoot, consumerRoot }) {
  const previous = Object.fromEntries(['HOME', 'XDG_CONFIG_HOME', 'PATH', 'ATELIER_GIT_PATH'].map((key) => [key, process.env[key]]))
  const environment = fs.mkdtempSync(path.join(consumerRoot, 'upgrade-git-'))
  try {
    if (process.platform !== 'win32') Object.assign(process.env, upgradeTestGit(environment).env)
    verifyUpgrade({ installedRoot, consumerRoot })
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(environment, { recursive: true, force: true })
  }
}

function verifyUpgrade({ installedRoot, consumerRoot }) {
  const { source, root } = fixture(consumerRoot)
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key) && key !== 'MNSTRY_ATELIER_ACTOR'))
  env.GITHUB_ACTOR = 'author'
  const cli = (...args) => spawnSync(process.execPath, [path.join(installedRoot, 'bin/atelier.mjs'), 'upgrade', ...args, '--project', path.join(root, 'atelier.project.json')], { cwd: root, env, encoding: 'utf8', timeout: 60000 })
  const before = git(source, ['rev-parse', 'HEAD'])
  const prepared = cli('plan', '--save')
  if (process.platform === 'win32') {
    assert.notEqual(prepared.status, 0)
    assert.match(prepared.stderr, /host is unsupported/)
    assert.equal(fs.existsSync(path.join(root, '.atelier-local/upgrades')), false)
    console.log('[upgrade:consumer] unsupported host refused before transaction state creation')
    return
  }
  assert.equal(prepared.status, 0, prepared.stderr)
  const plan = JSON.parse(prepared.stdout)
  const applied = cli('apply', '--plan', plan.savedPlan, '--confirm', plan.plan.digest)
  assert.equal(applied.status, 0, applied.stderr + applied.stdout)
  const result = JSON.parse(applied.stdout)
  assert.equal(result.ok, true)
  assert.equal(git(source, ['rev-parse', 'HEAD']), before)
  const status = cli('status', '--operation', result.operationId)
  assert.equal(status.status, 0, status.stderr)
  assert.equal(JSON.parse(status.stdout).activated, false)
  console.log('[upgrade:consumer] installed exact plan, protected commit, source preservation and receipt passed')
}
