import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveGitExecutable, runGit } from '../src/runtime/git-adapter.mjs'
import {
  ATELIER_REPOSITORY_OBSERVATION_SCHEMA,
  ATELIER_REPOSITORY_OBSERVATION_MAX_ENTRIES,
  classifyFilesystemRoot,
  observeRepository,
  parsePorcelainStatus,
  validateRepositoryObservation,
} from '../src/runtime/repository-observation.mjs'

const git = resolveGitExecutable()

function repository(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-observation-'))
  const remote = path.join(base, 'remote.git')
  const root = path.join(base, 'workspace')
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  runGit(git, null, ['init', '--bare', remote])
  fs.mkdirSync(root)
  runGit(git, root, ['init', '--initial-branch=main'])
  runGit(git, root, ['config', 'user.name', 'Atelier Test'])
  runGit(git, root, ['config', 'user.email', 'atelier@example.invalid'])
  fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n')
  fs.writeFileSync(path.join(root, 'README.md'), '# Test\n')
  runGit(git, root, ['add', '.'])
  runGit(git, root, ['commit', '-m', 'initial'])
  runGit(git, root, ['remote', 'add', 'origin', remote])
  runGit(git, root, ['push', '-u', 'origin', 'main'])
  return { base, remote, root }
}

test('full observation proves a normal local clone complete', (t) => {
  const { remote, root } = repository(t)
  const report = observeRepository({ repoRoot: root, gitExecutable: git })
  assert.equal(report.schema, ATELIER_REPOSITORY_OBSERVATION_SCHEMA)
  assert.equal(report.complete, true)
  assert.equal(report.status.clean, true)
  assert.equal(report.branch.branch, 'main')
  assert.equal(report.branch.upstream, 'origin/main')
  assert.equal(report.remotes[0].authentication, 'local')
  assert.match(report.remotes[0].identityDigest, /^[0-9a-f]{64}$/)
  assert.equal(report.remotes[0].pushUrl, remote)
  assert.equal(report.remotes[0].pushTargetCount, 1)
  assert.match(report.remotes[0].pushIdentityDigest, /^[0-9a-f]{64}$/)
  assert.deepEqual(validateRepositoryObservation(report), [])
})

test('gitlinks without .gitmodules fail repository completeness closed', (t) => {
  const { root } = repository(t)
  const gitlink = runGit(git, root, ['rev-parse', 'HEAD']).stdout.trim()
  runGit(git, root, ['update-index', '--add', '--cacheinfo', `160000,${gitlink},vendor/missing`])
  const report = observeRepository({ repoRoot: root, gitExecutable: git })
  assert.equal(report.submodules.declared, true)
  assert.equal(report.submodules.complete, false)
  assert.equal(report.submodules.error, 'gitlink entries exist without .gitmodules')
  assert.equal(report.blockers.some((item) => item.code === 'submodules-incomplete'), true)
})

test('remote identity binds the credential-free target without creating a secret digest oracle', (t) => {
  const { root } = repository(t)
  const firstMaterial = ['sentinel', '-remote-one'].join('')
  const secondMaterial = ['sentinel', '-remote-two'].join('')
  const queryKey = ['to', 'ken'].join('')
  runGit(git, root, ['remote', 'set-url', 'origin', `https://user:${firstMaterial}@example.test/org/repo.git?${queryKey}=${firstMaterial}`])
  const first = observeRepository({ repoRoot: root, gitExecutable: git })
  runGit(git, root, ['remote', 'set-url', 'origin', `https://user:${secondMaterial}@example.test/org/repo.git?${queryKey}=${secondMaterial}`])
  const second = observeRepository({ repoRoot: root, gitExecutable: git })
  assert.equal(first.remotes[0].url, second.remotes[0].url)
  assert.equal(first.remotes[0].identityDigest, second.remotes[0].identityDigest)
  assert.equal(JSON.stringify(first).includes(firstMaterial), false)
  assert.equal(JSON.stringify(second).includes(secondMaterial), false)
})

test('symlink fingerprints hash the link text rather than following its target', (t) => {
  const { root } = repository(t)
  const target = path.join(root, 'target.txt')
  const link = path.join(root, 'linked.txt')
  fs.writeFileSync(target, 'first target bytes\n')
  try {
    fs.symlinkSync('target.txt', link, 'file')
  } catch (error) {
    if (process.platform === 'win32' && error?.code === 'EPERM') return t.skip('symlink privilege unavailable')
    throw error
  }
  const report = observeRepository({ repoRoot: root, gitExecutable: git })
  const fingerprint = report.status.fingerprints.find((item) => item.path === 'linked.txt')
  const expected = runGit(git, root, ['hash-object', '--stdin'], { input: 'target.txt' }).stdout.trim()
  assert.equal(fingerprint.worktree.mode, '120000')
  assert.equal(fingerprint.worktree.blob, expected)
  assert.equal(fingerprint.worktree.indexBlob, expected)
  fs.writeFileSync(target, 'different target bytes\n')
  const after = observeRepository({ repoRoot: root, gitExecutable: git })
  assert.equal(after.status.fingerprints.find((item) => item.path === 'linked.txt').worktree.indexBlob, expected)
})

test('observation fails closed on sparse and partial workspace state', (t) => {
  const { root } = repository(t)
  runGit(git, root, ['config', 'core.sparseCheckout', 'true'])
  runGit(git, root, ['config', 'remote.origin.promisor', 'true'])
  const report = observeRepository({ repoRoot: root, gitExecutable: git })
  assert.equal(report.complete, false)
  assert.deepEqual(report.blockers.map((item) => item.code).sort(), ['partial-clone-unsupported', 'sparse-checkout-unsupported'])
})

test('observation binds the resolved push destination and refuses ambiguous or rewritten targets', (t) => {
  const { base, remote, root } = repository(t)
  const redirected = path.join(base, 'redirected.git')
  runGit(git, null, ['init', '--bare', redirected])
  runGit(git, root, ['remote', 'set-url', '--push', 'origin', redirected])
  let report = observeRepository({ repoRoot: root, gitExecutable: git })
  assert.equal(report.complete, true)
  assert.equal(report.remotes[0].url, remote)
  assert.equal(report.remotes[0].pushUrl, redirected)

  runGit(git, root, ['remote', 'set-url', '--add', '--push', 'origin', remote])
  report = observeRepository({ repoRoot: root, gitExecutable: git })
  assert.equal(report.complete, false)
  assert.equal(report.blockers.some((item) => item.code === 'remote-push-destination-ambiguous'), true)

  runGit(git, root, ['remote', 'set-url', '--delete', '--push', 'origin', redirected])
  runGit(git, root, ['config', `url.${redirected}.pushInsteadOf`, remote])
  report = observeRepository({ repoRoot: root, gitExecutable: git })
  assert.equal(report.complete, false)
  assert.equal(report.blockers.some((item) => item.code === 'url-rewrite-unclassified'), true)
})

test('filesystem classifier refuses provider-managed, UNC, and WSL boundary roots before enrollment', () => {
  assert.equal(classifyFilesystemRoot('C:\\Users\\person\\OneDrive\\project', { platform: 'win32' }).code, 'provider-managed-onedrive')
  assert.equal(classifyFilesystemRoot('\\\\server\\share\\project', { platform: 'win32' }).code, 'network-unc-root')
  assert.equal(classifyFilesystemRoot('/mnt/c/accounts/person/project', { platform: 'linux' }).code, 'wsl-cross-boundary-root')
})

test('porcelain parser preserves spaces, renames, and conflict codes without line splitting', () => {
  const parsed = parsePorcelainStatus(' M file with spaces.md\0R  new name.md\0old name.md\0UU conflict.md\0')
  assert.deepEqual(parsed, [
    { code: 'UU', path: 'conflict.md', originalPath: null },
    { code: ' M', path: 'file with spaces.md', originalPath: null },
    { code: 'R ', path: 'new name.md', originalPath: 'old name.md' },
  ])
})

test('runtime observation validation is exactly contract-backed', (t) => {
  const { root } = repository(t)
  const report = observeRepository({ repoRoot: root, gitExecutable: git })
  assert.notDeepEqual(validateRepositoryObservation({ ...report, unexpected: true }), [])
  assert.deepEqual(validateRepositoryObservation({ ...report, root: 'relative/by-contract' }), [])
})

test('configuration evidence is label-only and secrets never enter the observation', (t) => {
  const { root } = repository(t)
  const material = ['sentinel', '-proxy-credential'].join('')
  const option = ['--to', 'ken'].join('')
  runGit(git, root, ['config', 'http.proxy', `https://user:${material}@proxy.example.test`])
  runGit(git, root, ['config', 'filter.private.process', `helper ${option}=${material}`])
  const report = observeRepository({ repoRoot: root, gitExecutable: git })
  const encoded = JSON.stringify(report)
  assert.equal(encoded.includes(material), false)
  assert.deepEqual(report.features.proxy, [{ key: 'http.proxy' }])
  assert.equal(report.features.customFilters[0].key, 'filter.[subsection].process')
  assert.equal(report.complete, false)
})

test('credential-bearing Git config subsections never enter observation evidence', (t) => {
  const { root } = repository(t)
  const material = ['sentinel', '-config-subsection'].join('')
  runGit(git, root, ['config', `url.https://user:${material}@example.test/.insteadOf`, 'https://example.test/'])
  runGit(git, root, ['config', `http.https://user:${material}@proxy.example.test/.proxy`, 'https://proxy.example.test/'])
  const report = observeRepository({ repoRoot: root, gitExecutable: git })
  assert.equal(report.complete, false)
  assert.equal(JSON.stringify(report).includes(material), false)
  assert.equal(report.features.urlRewrites[0].key, 'url.[subsection].insteadof')
  assert.equal(report.features.proxy[0].key, 'http.[subsection].proxy')
})

test('custom hooksPath is a repository completeness blocker', (t) => {
  const { root } = repository(t)
  runGit(git, root, ['config', 'core.hooksPath', '.githooks'])
  const report = observeRepository({ repoRoot: root, gitExecutable: git })
  assert.equal(report.complete, false)
  assert.equal(report.blockers.some((item) => item.code === 'custom-hooks-path-unclassified'), true)
})

test('core.fileMode false preserves the tracked index mode in reviewed fingerprints', (t) => {
  const { root } = repository(t)
  const script = path.join(root, 'script.sh')
  fs.writeFileSync(script, '#!/bin/sh\nexit 0\n')
  fs.chmodSync(script, 0o755)
  runGit(git, root, ['add', 'script.sh'])
  runGit(git, root, ['commit', '-m', 'add executable'])
  runGit(git, root, ['config', 'core.fileMode', 'false'])
  fs.chmodSync(script, 0o644)
  fs.appendFileSync(script, '# changed\n')
  const report = observeRepository({ repoRoot: root, gitExecutable: git })
  assert.equal(report.status.fingerprints.find((item) => item.path === 'script.sh').worktree.mode, '100755')
})

test('an over-budget required Git evidence read makes the observation incomplete', (t) => {
  const { root } = repository(t)
  fs.appendFileSync(path.join(root, '.git', 'config'), `\n[oversized]\n\tvalue = ${'x'.repeat(17 * 1024 * 1024)}\n`)
  const report = observeRepository({ repoRoot: root, gitExecutable: git })
  assert.equal(report.complete, false)
  assert.equal(report.blockers.some((item) => item.code === 'observation-evidence-unavailable'), true)
})

test('an oversized change set fails closed before per-entry fingerprint subprocesses grow without bound', (t) => {
  const { root } = repository(t)
  for (let index = 0; index <= ATELIER_REPOSITORY_OBSERVATION_MAX_ENTRIES; index += 1) {
    fs.writeFileSync(path.join(root, `untracked-${String(index).padStart(4, '0')}.txt`), 'x\n')
  }
  const report = observeRepository({ repoRoot: root, gitExecutable: git })
  assert.equal(report.complete, false)
  assert.equal(report.status.entries.length, ATELIER_REPOSITORY_OBSERVATION_MAX_ENTRIES)
  assert.equal(report.status.fingerprints.length, 0)
  assert.equal(report.status.entriesTruncated, true)
  assert.equal(report.status.observedEntryCount, ATELIER_REPOSITORY_OBSERVATION_MAX_ENTRIES + 1)
  assert.equal(report.blockers.some((item) => item.code === 'observation-change-set-oversized'), true)
})

test('external Git attributes configuration is a completeness blocker', (t) => {
  const { base, root } = repository(t)
  const attributes = path.join(base, 'external-attributes')
  fs.writeFileSync(attributes, '*.bin filter=lfs\n')
  runGit(git, root, ['config', 'core.attributesFile', attributes])
  const report = observeRepository({ repoRoot: root, gitExecutable: git })
  assert.equal(report.complete, false)
  assert.equal(report.blockers.some((item) => item.code === 'external-attributes-file-unclassified'), true)
  assert.equal(JSON.stringify(report).includes(attributes), false)
})

test('untracked worktree attributes participate in LFS completeness', (t) => {
  const { root } = repository(t)
  fs.writeFileSync(path.join(root, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n')
  const report = observeRepository({ repoRoot: root, gitExecutable: git })
  assert.equal(report.lfs.required, true)
  assert.equal(report.lfs.attributeFiles.includes('.gitattributes'), true)
})

test('default global attributes participate in LFS completeness without persisting their path', (t) => {
  const { base, root } = repository(t)
  const xdg = path.join(base, 'xdg')
  const attributes = path.join(xdg, 'git', 'attributes')
  fs.mkdirSync(path.dirname(attributes), { recursive: true })
  fs.writeFileSync(attributes, '*.asset filter=lfs diff=lfs merge=lfs -text\n')
  const previous = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = xdg
  t.after(() => {
    if (previous == null) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
  })
  const report = observeRepository({ repoRoot: root, gitExecutable: git })
  assert.equal(report.lfs.required, true)
  assert.equal(report.lfs.attributeFiles.includes('global Git attributes'), true)
  assert.equal(JSON.stringify(report).includes(attributes), false)
})
