import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  BOUNDARY_POLICY_SCHEMA,
  auditContentRules,
  boundaryHookScript,
  checkBoundaryPolicy,
  checkPushContent,
  hookIndexFromEnvironment,
  installBoundaryHooks,
  readBoundaryPushInput,
  resolveBoundaryAuditSource,
  validateBoundaryPolicy,
} from '../src/boundary/policy.mjs'
import {
  DEFAULT_CONTENT_RULES,
  BINARY_FILE_MAX_BYTES,
  parsePushRefInput,
  diffHeaderPath,
  parseAddedContent,
  parseDiffSections,
  parsePushRefUpdates,
  scanAddedContent,
  scanPushUpdate,
  scanStagedRepository,
  validateContentRuleExceptions,
} from '../src/boundary/content-rules.mjs'
import { PROJECT_CONFIG_SCHEMA, commandProject, parseArgs, writeJson } from '../src/project/config.mjs'

// A client-zero private-domain site shipped an owner-authorized mock cart whose
// whole design is localStorage. The whole-tree guard matched it, so every push failed
// at the hook — real work would have stranded locally — and the only fix available
// was a hardcoded pathspec inside shared fleet infrastructure.
const CART = 'src/scripts/cart.ts'
const CART_SOURCE = 'export const save = (items) => localStorage.setItem("cart", JSON.stringify(items))\n'

function git(repo, args, options = {}) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', ...options }).trim()
}

function makeWorkspace(t, { exceptions = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-content-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const site = path.join(root, 'example-site')
  const upstream = path.join(root, 'example-site.git')
  fs.mkdirSync(site, { recursive: true })
  execFileSync('git', ['init', '--quiet', '--bare', upstream])
  git(site, ['init', '--quiet'])
  git(site, ['config', 'user.email', 'author@example.invalid'])
  git(site, ['config', 'user.name', 'Author'])
  git(site, ['remote', 'add', 'origin', upstream])

  // The accepted usage is already in history, exactly as it was at client zero.
  fs.mkdirSync(path.join(site, 'src/scripts'), { recursive: true })
  fs.writeFileSync(path.join(site, CART), CART_SOURCE)
  git(site, ['add', '.'])
  git(site, ['commit', '--quiet', '-m', 'mock cart'])
  git(site, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main'])

  writeJson(path.join(root, 'atelier.project.json'), {
    schema: PROJECT_CONFIG_SCHEMA,
    roots: { workspace: '.', repoOps: '.' },
    boundaries: { policyPath: 'boundary-policy.v1.json' },
    repos: [{ name: 'example-site', path: 'example-site', readBoundary: 'team' }],
  })
  const policy = {
    schema: BOUNDARY_POLICY_SCHEMA,
    mode: 'strict',
    actors: { author: { gitEmails: ['author@example.invalid'], privateDomainRepo: 'example-site' } },
    repos: {
      'example-site': {
        kind: 'private_domain',
        ownerActor: 'author',
        readBoundary: 'private',
        allowedAudiences: ['private', 'team'],
        forbiddenAudiences: [],
        autoCommit: 'guarded',
      },
    },
    contentRuleExceptions: exceptions,
  }
  writeJson(path.join(root, 'boundary-policy.v1.json'), policy)
  return { root, site, policy, project: commandProject({ argv: ['--project', path.join(root, 'atelier.project.json')], cwd: root, env: {} }) }
}

function pushUpdate(site) {
  const remoteSha = git(site, ['rev-parse', 'origin/main'])
  return [{ localRef: 'refs/heads/main', localSha: git(site, ['rev-parse', 'HEAD']), remoteRef: 'refs/heads/main', remoteSha }]
}

function commit(site, rel, contents, message) {
  const abs = path.join(site, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, contents)
  git(site, ['add', '.'])
  git(site, ['commit', '--quiet', '-m', message])
}

test('an unrelated change pushes cleanly past a pre-existing accepted usage', (t) => {
  const { site, policy, project } = makeWorkspace(t)
  commit(site, 'README.md', '# Site\n\nUnrelated copy edit.\n', 'docs')

  const report = checkPushContent({ project, policy, updates: pushUpdate(site), cwd: site })
  assert.equal(report.ok, true, report.findings.map((item) => item.message).join('\n'))
  assert.deepEqual(report.findings, [], 'the guard must judge the push, not the tree')
})

test('a new violation in the same push is still blocked', (t) => {
  const { site, policy, project } = makeWorkspace(t)
  commit(site, 'src/scripts/tracker.ts', 'sessionStorage.setItem("seen", "1")\n', 'tracker')

  const report = checkPushContent({ project, policy, updates: pushUpdate(site), cwd: site })
  assert.equal(report.ok, false)
  const found = report.errors.find((item) => item.rule === 'browser-persistence')
  assert.equal(found.path, 'src/scripts/tracker.ts')
  assert.equal(found.line, 1)
})

test('environment templates require an exact reasoned exception and credentials still block', () => {
  const templateFiles = ['.env.example', '.env.sample', '.env.template'].map((filePath) => ({
    path: filePath,
    added: true,
    addedLines: [],
  }))
  const templateFindings = scanAddedContent({ files: templateFiles, repo: 'site' })
  assert.equal(templateFindings.length, 3)
  assert.ok(templateFindings.every((finding) => finding.rule === 'private-financial-filename'))

  const exceptions = [{
    rule: 'private-financial-filename',
    repo: 'site',
    paths: ['.env.example'],
    reason: 'reviewed public variable-name template with no values',
  }]
  const excepted = scanAddedContent({
    files: [{
      path: '.env.example',
      added: true,
      addedLines: [{ number: 1, text: ['gh', 'p_', 'a'.repeat(36)].join('') }],
    }],
    exceptions,
    repo: 'site',
  })
  assert.ok(excepted.some((finding) => finding.rule === 'secret-material'), 'a path exception must not suppress credential content')
  assert.equal(excepted.some((finding) => finding.rule === 'private-financial-filename'), false)

  const findings = scanAddedContent({
    files: [
      { path: '.env', added: true, addedLines: [] },
      { path: '.env.local', added: true, addedLines: [] },
      { path: '.env.production', added: true, addedLines: [] },
    ],
    repo: 'site',
  })
  assert.equal(findings.length, 3)
  assert.ok(findings.every((finding) => finding.rule === 'private-financial-filename'))
})

test('a declared exception unblocks exactly its rule and path, and removing it re-blocks', (t) => {
  const exceptions = [
    {
      rule: 'browser-persistence',
      repo: 'example-site',
      paths: [CART],
      reason: 'owner-authorized mock cart on a public demo site; localStorage is its whole design',
    },
  ]
  const { site, policy, project } = makeWorkspace(t, { exceptions })

  // Touching the excepted file itself is fine.
  commit(site, CART, `${CART_SOURCE}export const clear = () => localStorage.removeItem("cart")\n`, 'cart tweak')
  let report = checkPushContent({ project, policy, updates: pushUpdate(site), cwd: site })
  assert.equal(report.ok, true, report.findings.map((item) => item.message).join('\n'))

  // A sibling file is not covered by the exception.
  commit(site, 'src/scripts/other.ts', 'localStorage.setItem("x", "1")\n', 'other')
  report = checkPushContent({ project, policy, updates: pushUpdate(site), cwd: site })
  assert.equal(report.ok, false)
  assert.equal(report.errors[0].path, 'src/scripts/other.ts')

  // Removing the exception re-blocks the excepted path.
  const without = { ...policy, contentRuleExceptions: [] }
  report = checkPushContent({ project, policy: without, updates: pushUpdate(site), cwd: site })
  assert.ok(report.errors.some((item) => item.path === CART))
})

test('the exception appears in a human-readable audit that never blocks', (t) => {
  const exceptions = [
    {
      rule: 'browser-persistence',
      repo: 'example-site',
      paths: [CART],
      reason: 'owner-authorized mock cart; localStorage is its whole design',
    },
  ]
  const { policy, project } = makeWorkspace(t, { exceptions })
  const report = auditContentRules({ project, policy })

  assert.deepEqual(report.findings, [], 'the excepted usage is accepted, not reported as a violation')
  assert.deepEqual(report.accepted, [{ repo: 'example-site', rule: 'browser-persistence', paths: [CART], reason: exceptions[0].reason }])

  const withoutException = auditContentRules({ project, policy: { ...policy, contentRuleExceptions: [] } })
  assert.ok(
    withoutException.findings.some((item) => item.path === CART),
    'the whole-tree view still shows the usage when it is not declared',
  )
})

test('audit defaults to the working tree and keeps HEAD as an explicit snapshot', (t) => {
  const { site, policy, project } = makeWorkspace(t)
  fs.writeFileSync(path.join(site, 'unstaged.ts'), 'sessionStorage.setItem("draft", "1")\n')

  const working = auditContentRules({ project, policy })
  assert.equal(working.source, 'working-tree')
  assert.ok(working.findings.some((item) => item.path === 'unstaged.ts'))

  const snapshot = auditContentRules({ project, policy, source: 'head' })
  assert.equal(snapshot.source, 'head')
  assert.equal(snapshot.findings.some((item) => item.path === 'unstaged.ts'), false)
  assert.equal(resolveBoundaryAuditSource(parseArgs(['--head'])), 'head')
  assert.equal(resolveBoundaryAuditSource(parseArgs(['--source=head'])), 'head')
  assert.equal(resolveBoundaryAuditSource(parseArgs([])), 'working-tree')
})

test('exceptions must name a rule, a repo, real paths, and a reason', () => {
  const ok = [{ rule: 'browser-persistence', repo: 'site', paths: ['src/a.ts'], reason: 'documented product decision' }]
  assert.deepEqual(validateContentRuleExceptions(ok, DEFAULT_CONTENT_RULES), [])

  const blanket = [{ rule: 'browser-persistence', repo: 'site', paths: ['**'], reason: 'documented product decision' }]
  assert.match(validateContentRuleExceptions(blanket, DEFAULT_CONTENT_RULES).join('\n'), /must not be a blanket "\*\*"/)

  const noReason = [{ rule: 'browser-persistence', repo: 'site', paths: ['src/a.ts'], reason: 'n/a' }]
  assert.match(validateContentRuleExceptions(noReason, DEFAULT_CONTENT_RULES).join('\n'), /must explain why this usage is accepted/)

  const unknownRule = [{ rule: 'invented', repo: 'site', paths: ['src/a.ts'], reason: 'documented product decision' }]
  assert.match(validateContentRuleExceptions(unknownRule, DEFAULT_CONTENT_RULES).join('\n'), /is not a declared content rule/)

  const noPaths = [{ rule: 'browser-persistence', repo: 'site', reason: 'documented product decision' }]
  assert.match(validateContentRuleExceptions(noPaths, DEFAULT_CONTENT_RULES).join('\n'), /paths is required/)
})

test('policy validation rejects exceptions for repos it does not declare', (t) => {
  const { policy, project } = makeWorkspace(t)
  policy.contentRuleExceptions = [
    { rule: 'browser-persistence', repo: 'some-other-repo', paths: ['src/a.ts'], reason: 'documented product decision' },
  ]
  assert.match(validateBoundaryPolicy(policy, project).join('\n'), /contentRuleExceptions\[0\]\.repo some-other-repo is not declared in repos/)
})

test('an empty content-rule list is invalid and cannot bypass default exception validation', (t) => {
  const { policy, project } = makeWorkspace(t)
  policy.contentRules = []
  policy.contentRuleExceptions = [
    { rule: 'invented', repo: 'example-site', paths: ['src/a.ts'], reason: 'documented product decision' },
  ]
  const errors = validateBoundaryPolicy(policy, project).join('\n')
  assert.match(errors, /contentRules must contain at least one rule/)
  assert.match(errors, /is not a declared content rule/)
})

test('the shared guard script contains no repo-specific paths', (t) => {
  const { project, site } = makeWorkspace(t)
  installBoundaryHooks({ project })
  const hook = fs.readFileSync(path.join(site, '.git/hooks/pre-push'), 'utf8')

  assert.match(hook, /boundary push-check/, 'pre-push must judge the pushed range')
  assert.match(hook, /--remote="\$\{1:-\}"/, 'pre-push passes the remote Git names')
  assert.doesNotMatch(hook, /cart\.ts|localStorage|:!/, 'repo-specific carve-outs belong in policy, not in shared infrastructure')
  const preCommit = fs.readFileSync(path.join(site, '.git/hooks/pre-commit'), 'utf8')
  assert.match(preCommit, /boundary check --staged/)
})

test('a brand new branch is scanned in full rather than silently skipped', (t) => {
  const { site, policy, project } = makeWorkspace(t)
  git(site, ['checkout', '--quiet', '-b', 'feature'])
  commit(site, 'src/scripts/new.ts', 'indexedDB.open("db")\n', 'new branch work')

  const updates = [{ localRef: 'refs/heads/feature', localSha: git(site, ['rev-parse', 'HEAD']), remoteRef: 'refs/heads/feature', remoteSha: '0'.repeat(40) }]
  const report = checkPushContent({ project, policy, updates, cwd: site })
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((item) => item.path === 'src/scripts/new.ts'))
})

test('ref updates parse, and branch deletions carry no content to judge', () => {
  const zero = '0'.repeat(40)
  const local = 'a'.repeat(40)
  const remote = 'b'.repeat(40)
  const updates = parsePushRefUpdates(`refs/heads/main ${local} refs/heads/main ${remote}\nrefs/heads/gone ${zero} refs/heads/gone ${remote}\n\n`)
  assert.equal(updates.length, 1)
  assert.equal(updates[0].localSha, local)
  assert.equal(parsePushRefInput('   \n').kind, 'empty')
  const invalid = parsePushRefInput('refs/heads/main short refs/heads/main also-short\n')
  assert.equal(invalid.ok, false)
  assert.equal(invalid.kind, 'invalid')
  assert.deepEqual(readBoundaryPushInput(() => { throw new Error('unreadable') }), {
    ok: false,
    text: '',
    error: 'stdin-read-failed',
  })
})

test('Git evidence acquisition reports ENOBUFS as a blocking completeness diagnostic', () => {
  const error = Object.assign(new Error('buffer exceeded'), { code: 'ENOBUFS' })
  const result = scanStagedRepository({
    repoRoot: '.',
    repo: 'site',
    gitRunner: () => ({ status: null, stdout: '', stderr: '', error }),
  })
  assert.equal(result.findings.length, 0)
  assert.equal(result.diagnostics[0].code, 'content-scan-incomplete')
  assert.equal(result.diagnostics[0].details.reason, 'git-output-limit-exceeded')

  const update = {
    localRef: 'refs/heads/main',
    localSha: 'a'.repeat(40),
    remoteRef: 'refs/heads/main',
    remoteSha: 'b'.repeat(40),
  }
  const pushed = scanPushUpdate({
    repoRoot: '.',
    repo: 'site',
    update,
    gitRunner: () => ({ status: null, stdout: '', stderr: '', error }),
  })
  assert.equal(pushed.findings.length, 0)
  assert.equal(pushed.diagnostics[0].code, 'content-scan-incomplete')
  assert.equal(pushed.diagnostics[0].details.reason, 'git-output-limit-exceeded')
})

test('the terminal push report blocks when push evidence acquisition exceeds its buffer', (t) => {
  const { site, policy, project } = makeWorkspace(t)
  commit(site, 'README.md', '# Site\n', 'docs')
  const error = Object.assign(new Error('buffer exceeded'), { code: 'ENOBUFS' })
  const report = checkPushContent({
    project,
    policy,
    updates: pushUpdate(site),
    cwd: site,
    gitRunner: () => ({ status: null, stdout: '', stderr: '', error }),
  })
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((item) => item.code === 'content-scan-incomplete'))
})

test('staged binary credentials block and oversized binary evidence cannot pass incomplete', (t) => {
  const { site, policy, project } = makeWorkspace(t)
  const signature = Buffer.from(['-----BEGIN ', 'PRIVATE KEY-----'].join(''))
  fs.writeFileSync(path.join(site, 'opaque.bin'), Buffer.concat([Buffer.from([0]), signature]))
  git(site, ['add', 'opaque.bin'])
  let report = checkBoundaryPolicy({ project, policy, actor: 'author', staged: true, stagedOnly: true })
  assert.ok(report.errors.some((item) => item.rule === 'secret-material' && item.path === 'opaque.bin' && item.binary === true))

  git(site, ['reset', '--quiet', 'opaque.bin'])
  fs.writeFileSync(path.join(site, 'large.bin'), Buffer.alloc(BINARY_FILE_MAX_BYTES + 1, 0))
  git(site, ['add', 'large.bin'])
  report = checkBoundaryPolicy({ project, policy, actor: 'author', staged: true, stagedOnly: true })
  assert.ok(report.errors.some((item) => item.code === 'content-scan-incomplete' && item.path === 'large.bin'))
})

test('a staged or pushed deletion of a tracked binary has nothing to read and does not block', (t) => {
  const { site, policy, project } = makeWorkspace(t)
  fs.writeFileSync(path.join(site, 'retired.bin'), Buffer.from([0, 1, 2, 3]))
  git(site, ['add', 'retired.bin'])
  git(site, ['commit', '--quiet', '-m', 'binary asset'])
  git(site, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main'])

  // The deletion is staged beside a binary added in the same change. Git orders
  // sections by path, so the added zz-opaque.bin comes after the deleted file:
  // a deleted section that did not reset would leave the addition unscanned.
  git(site, ['rm', '--quiet', 'retired.bin'])
  const signature = Buffer.from(['-----BEGIN ', 'PRIVATE KEY-----'].join(''))
  fs.writeFileSync(path.join(site, 'zz-opaque.bin'), Buffer.concat([Buffer.from([0]), signature]))
  git(site, ['add', 'zz-opaque.bin'])
  const report = checkBoundaryPolicy({ project, policy, actor: 'author', staged: true, stagedOnly: true })
  assert.ok(!report.errors.some((item) => item.path === 'retired.bin'), JSON.stringify(report.errors))
  assert.ok(report.errors.some((item) => item.rule === 'secret-material' && item.path === 'zz-opaque.bin' && item.binary === true))

  // The same holds across a push range.
  git(site, ['commit', '--quiet', '-m', 'retire one binary, add another'])
  let pushed = checkPushContent({ project, policy, updates: pushUpdate(site), cwd: site })
  assert.equal(pushed.ok, false)
  assert.ok(!pushed.errors.some((item) => item.path === 'retired.bin'), JSON.stringify(pushed.errors))
  assert.ok(pushed.errors.some((item) => item.rule === 'secret-material' && item.path === 'zz-opaque.bin'))

  // A deletion on its own passes both checks.
  git(site, ['reset', '--quiet', '--hard', 'HEAD~1'])
  git(site, ['rm', '--quiet', 'retired.bin'])
  const deletionOnly = checkBoundaryPolicy({ project, policy, actor: 'author', staged: true, stagedOnly: true })
  assert.ok(!deletionOnly.errors.some((item) => item.code === 'content-scan-incomplete'), JSON.stringify(deletionOnly.errors))
  git(site, ['commit', '--quiet', '-m', 'retire binary asset'])
  pushed = checkPushContent({ project, policy, updates: pushUpdate(site), cwd: site })
  assert.equal(pushed.ok, true, JSON.stringify(pushed.errors))
})

const KEY_MATERIAL = ['-----BEGIN ', 'PRIVATE KEY-----'].join('')
const POSIX_NAMES = process.platform !== 'win32'

function stagedSecretErrors(site, project, policy) {
  return checkBoundaryPolicy({ project, policy, actor: 'author', staged: true, stagedOnly: true }).errors
}

test('repository diff configuration cannot blind the staged or pushed scan', (t) => {
  const configs = [
    ['diff.noprefix', 'true'],
    ['diff.mnemonicPrefix', 'true'],
    ['diff.srcPrefix', 'b/'],
    ['diff.dstPrefix', 'b/sub/'],
    ['color.ui', 'always'],
    ['color.diff', 'always'],
    ['diff.external', 'true'],
  ]
  for (const [key, value] of configs) {
    const { site, policy, project } = makeWorkspace(t)
    git(site, ['config', key, value])
    fs.writeFileSync(path.join(site, 'note.txt'), `plain line\n${KEY_MATERIAL}\n`)
    fs.writeFileSync(path.join(site, 'blob.bin'), Buffer.concat([Buffer.from([0]), Buffer.from(KEY_MATERIAL)]))
    git(site, ['add', 'note.txt', 'blob.bin'])
    const errors = stagedSecretErrors(site, project, policy)
    assert.ok(errors.some((item) => item.path === 'note.txt' && item.line === 2), `${key}: ${JSON.stringify(errors)}`)
    assert.ok(errors.some((item) => item.path === 'blob.bin' && item.binary === true), `${key}: ${JSON.stringify(errors)}`)
    git(site, ['commit', '--quiet', '-m', 'material'])
    const pushed = checkPushContent({ project, policy, updates: pushUpdate(site), cwd: site })
    assert.ok(pushed.errors.some((item) => item.path === 'note.txt'), `${key} push: ${JSON.stringify(pushed.errors)}`)
  }
})

test('a textconv driver declared in attributes cannot hide a binary', (t) => {
  const { site, policy, project } = makeWorkspace(t)
  git(site, ['config', 'diff.hide.textconv', 'true'])
  fs.writeFileSync(path.join(site, '.gitattributes'), '*.bin diff=hide\n')
  fs.writeFileSync(path.join(site, 'blob.bin'), Buffer.concat([Buffer.from([0]), Buffer.from(KEY_MATERIAL)]))
  git(site, ['add', '.gitattributes', 'blob.bin'])
  const errors = stagedSecretErrors(site, project, policy)
  assert.ok(errors.some((item) => item.path === 'blob.bin' && item.binary === true), JSON.stringify(errors))
})

test('quoted paths and paths containing " b/" are scanned under their own names', (t) => {
  const { site, policy, project } = makeWorkspace(t)
  fs.mkdirSync(path.join(site, 'x b'), { recursive: true })
  fs.writeFileSync(path.join(site, 'x b', 'y.bin'), Buffer.concat([Buffer.from([0]), Buffer.from(KEY_MATERIAL)]))
  fs.writeFileSync(path.join(site, 'y.bin'), Buffer.from([0, 1, 2]))
  fs.writeFileSync(path.join(site, 'caf\u00e9.txt'), `${KEY_MATERIAL}\n`)
  const expectedPaths = ['x b/y.bin', 'caf\u00e9.txt']
  if (POSIX_NAMES) {
    // Names Windows cannot hold: a tab, a double quote.
    for (const name of ['tab\tname.txt', 'say "hi".txt']) {
      fs.writeFileSync(path.join(site, name), `${KEY_MATERIAL}\n`)
      expectedPaths.push(name)
    }
  }
  git(site, ['add', '.'])
  const errors = stagedSecretErrors(site, project, policy)
  for (const expected of expectedPaths) {
    assert.ok(errors.some((item) => item.path === expected && item.rule === 'secret-material'), `${expected}: ${JSON.stringify(errors)}`)
  }
  assert.ok(!errors.some((item) => item.path === 'y.bin'), JSON.stringify(errors))
})

test('an added line that itself starts with "+" is scanned', (t) => {
  const { site, policy, project } = makeWorkspace(t)
  fs.writeFileSync(path.join(site, 'list.md'), `# Notes\n+ ${KEY_MATERIAL}\n++ more\n`)
  git(site, ['add', 'list.md'])
  const errors = stagedSecretErrors(site, project, policy)
  assert.ok(errors.some((item) => item.path === 'list.md' && item.line === 2), JSON.stringify(errors))
})

test('text declared binary by attributes is still scanned', (t) => {
  const { site, policy, project } = makeWorkspace(t)
  fs.writeFileSync(path.join(site, '.gitattributes'), '*.cfg binary\n')
  fs.writeFileSync(path.join(site, 'app.cfg'), `name = example\n${KEY_MATERIAL}\n`)
  git(site, ['add', '.gitattributes', 'app.cfg'])
  const errors = stagedSecretErrors(site, project, policy)
  assert.ok(errors.some((item) => item.path === 'app.cfg' && item.line === 2 && item.rule === 'secret-material'), JSON.stringify(errors))
})

test('fused hunks and submodule summaries from Git configuration do not block clean work', (t) => {
  const { site, policy, project } = makeWorkspace(t)
  commit(site, 'notes.txt', 'one\ntwo\nthree\nfour\nfive\n', 'notes')
  git(site, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main'])
  git(site, ['config', 'diff.interHunkContext', '3'])
  fs.writeFileSync(path.join(site, 'notes.txt'), 'one\nTWO\nthree\nFOUR\nfive\n')
  git(site, ['add', 'notes.txt'])
  assert.deepEqual(stagedSecretErrors(site, project, policy), [])

  // The same edit with material on the second changed line is still found there.
  fs.writeFileSync(path.join(site, 'notes.txt'), `one\nTWO\nthree\n${KEY_MATERIAL}\nfive\n`)
  git(site, ['add', 'notes.txt'])
  const errors = stagedSecretErrors(site, project, policy)
  assert.ok(errors.some((item) => item.path === 'notes.txt' && item.line === 4), JSON.stringify(errors))
  git(site, ['reset', '--quiet', '--hard', 'HEAD'])

  // A submodule pointer bump beside another change, with summaries configured.
  const library = path.join(path.dirname(site), 'library')
  fs.mkdirSync(library)
  git(library, ['init', '--quiet'])
  git(library, ['config', 'user.email', 'author@example.invalid'])
  git(library, ['config', 'user.name', 'Author'])
  commit(library, 'lib.txt', 'first\n', 'library first')
  git(site, ['-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'add', library, 'vendor-lib'])
  git(site, ['commit', '--quiet', '-m', 'add library'])
  commit(library, 'lib.txt', 'second\n', 'library second')
  git(path.join(site, 'vendor-lib'), ['-c', 'protocol.file.allow=always', 'pull', '--quiet', 'origin', 'HEAD'])
  git(site, ['config', 'diff.submodule', 'log'])
  fs.writeFileSync(path.join(site, 'notes.txt'), 'one\nTWO\nthree\nfour\nfive\n')
  git(site, ['add', 'notes.txt', 'vendor-lib'])
  assert.deepEqual(stagedSecretErrors(site, project, policy), [])
})

test('names holding a backslash or shaped like an index stage are read as themselves', { skip: !POSIX_NAMES && 'names Windows cannot hold' }, (t) => {
  const exceptions = [{ rule: 'secret-material', repo: 'example-site', paths: ['x/z.txt'], reason: 'invented sibling exception for the test', approvedBy: 'author' }]
  const { site, policy, project } = makeWorkspace(t, { exceptions })
  fs.mkdirSync(path.join(site, 'x'))
  const secretBinary = Buffer.concat([Buffer.from([0]), Buffer.from(KEY_MATERIAL)])
  fs.writeFileSync(path.join(site, 'x', 'y.bin'), Buffer.from([0, 1, 2]))
  fs.writeFileSync(path.join(site, 'x\\y.bin'), secretBinary)
  fs.writeFileSync(path.join(site, 'x', 'z.txt'), 'harmless\n')
  fs.writeFileSync(path.join(site, 'x\\z.txt'), `${KEY_MATERIAL}\n`)
  fs.writeFileSync(path.join(site, 'evil.bin'), Buffer.from([0, 9]))
  fs.writeFileSync(path.join(site, '0:evil.bin'), secretBinary)
  git(site, ['add', '.'])
  const errors = stagedSecretErrors(site, project, policy)
  for (const expected of ['x\\y.bin', 'x\\z.txt', '0:evil.bin']) {
    assert.ok(errors.some((item) => item.path === expected && item.rule === 'secret-material'), `${expected}: ${JSON.stringify(errors)}`)
  }
  for (const benign of ['x/y.bin', 'x/z.txt', 'evil.bin']) {
    assert.ok(!errors.some((item) => item.path === benign), `${benign}: ${JSON.stringify(errors)}`)
  }
})

test('text declared binary is judged by its added lines, not its whole content', (t) => {
  const { site, policy, project } = makeWorkspace(t)
  fs.writeFileSync(path.join(site, '.gitattributes'), '*.min.js -diff\n')
  fs.writeFileSync(path.join(site, 'app.min.js'), 'const a = 1\nlocalStorage.setItem("k", "v")\nconst c = 3\n')
  git(site, ['add', '.'])
  git(site, ['commit', '--quiet', '-m', 'accepted usage already in history'])

  fs.writeFileSync(path.join(site, 'app.min.js'), 'const a = 1\nlocalStorage.setItem("k", "v")\nconst c = 4\n')
  git(site, ['add', 'app.min.js'])
  assert.deepEqual(stagedSecretErrors(site, project, policy), [])

  fs.writeFileSync(path.join(site, 'app.min.js'), `const a = 1\nlocalStorage.setItem("k", "v")\nconst c = 4\n${KEY_MATERIAL}\n`)
  git(site, ['add', 'app.min.js'])
  const errors = stagedSecretErrors(site, project, policy)
  assert.ok(errors.some((item) => item.path === 'app.min.js' && item.line === 4 && item.rule === 'secret-material'), JSON.stringify(errors))
  assert.ok(!errors.some((item) => item.line === 2), JSON.stringify(errors))
})

test('declared-binary text with a decomposed name, or renamed with an edit, is judged by its added lines', (t) => {
  const { site, policy, project } = makeWorkspace(t)
  fs.writeFileSync(path.join(site, '.gitattributes'), '*.json -diff\n*.cfg -diff\n')
  // Stored decomposed (NFD), as an older checkout or another platform leaves it.
  const decomposed = 'r\u0065\u0301sume\u0301.json'
  fs.writeFileSync(path.join(site, decomposed), '{"name": "example"}\n')
  fs.writeFileSync(path.join(site, 'old.cfg'), `alpha = 1\n${KEY_MATERIAL}\nbeta = 2\ngamma = 3\ndelta = 4\nepsilon = 5\nzeta = 6\n`)
  git(site, ['-c', 'core.precomposeUnicode=false', 'add', '.'])
  git(site, ['commit', '--quiet', '-m', 'existing files, one with an accepted earlier use'])
  git(site, ['config', 'core.precomposeUnicode', 'true'])

  // A new branch that only adds a README pushes its whole history from the empty tree.
  git(site, ['checkout', '--quiet', '-b', 'feature'])
  commit(site, 'README.md', '# Site\n', 'readme')
  const branchPush = [{ localRef: 'refs/heads/feature', localSha: git(site, ['rev-parse', 'HEAD']), remoteRef: 'refs/heads/feature', remoteSha: '0'.repeat(40) }]
  let pushed = checkPushContent({ project, policy, updates: branchPush, cwd: site })
  assert.ok(!pushed.errors.some((item) => item.code === 'content-scan-incomplete'), JSON.stringify(pushed.errors))

  // Renamed with one appended line: the earlier use at line 2 is not judged again.
  git(site, ['mv', 'old.cfg', 'new.cfg'])
  fs.appendFileSync(path.join(site, 'new.cfg'), 'eta = 7\n')
  git(site, ['add', 'new.cfg'])
  assert.deepEqual(stagedSecretErrors(site, project, policy), [])
  fs.appendFileSync(path.join(site, 'new.cfg'), `${KEY_MATERIAL}\n`)
  git(site, ['add', 'new.cfg'])
  const errors = stagedSecretErrors(site, project, policy)
  assert.ok(errors.some((item) => item.path === 'new.cfg' && item.line === 9 && item.rule === 'secret-material'), JSON.stringify(errors))
  assert.ok(!errors.some((item) => item.line === 2), JSON.stringify(errors))
})

test('declared-binary text that a narrowed diff pairs differently is read again on its own', (t) => {
  const settings = (prefix, count) => Array.from({ length: count }, (_, index) => `${prefix}_${index + 3} = value_${index + 3}`).join('\n')

  // Git pairs a unique basename first, and narrowing the paths changes which is unique.
  const moved = makeWorkspace(t)
  fs.writeFileSync(path.join(moved.site, '.gitattributes'), '*.cfg -diff\n')
  const original = `head = 0\n${KEY_MATERIAL}\n${settings('setting_number', 18)}\n`
  for (const dir of ['a', 'b', 'c', 'd']) fs.mkdirSync(path.join(moved.site, dir))
  fs.writeFileSync(path.join(moved.site, 'a/x.cfg'), original)
  fs.writeFileSync(path.join(moved.site, 'b/x.cfg'), `${settings('unrelated', 20)}\n`)
  git(moved.site, ['add', '.'])
  git(moved.site, ['commit', '--quiet', '-m', 'accepted earlier use in a/x.cfg'])
  git(moved.site, ['rm', '--quiet', 'a/x.cfg', 'b/x.cfg'])
  fs.writeFileSync(path.join(moved.site, 'c/p.cfg'), `head = 0\n${settings('setting_number', 18)}\ntail = p\n`)
  fs.writeFileSync(path.join(moved.site, 'd/x.cfg'), `head = 0\n${KEY_MATERIAL}\n${settings('setting_number', 15)}\nd1 = 1\nd2 = 2\nd3 = 3\n`)
  git(moved.site, ['add', '.'])
  // The main diff renames a/x.cfg to c/p.cfg, so d/x.cfg is new and judged whole.
  let errors = stagedSecretErrors(moved.site, moved.project, moved.policy)
  assert.ok(errors.some((item) => item.path === 'd/x.cfg' && item.line === 2 && item.rule === 'secret-material'), JSON.stringify(errors))
  assert.ok(!errors.some((item) => item.code === 'content-scan-incomplete'), JSON.stringify(errors))

  // A copy found only by the narrowed diff, past a rename limit the main diff hit.
  const copied = makeWorkspace(t)
  fs.writeFileSync(path.join(copied.site, '.gitattributes'), '*.cfg -diff\n')
  fs.writeFileSync(path.join(copied.site, 'm1.cfg'), `head = 0\n${KEY_MATERIAL}\n${settings('setting', 28)}\n`)
  git(copied.site, ['add', '.'])
  git(copied.site, ['commit', '--quiet', '-m', 'accepted earlier use in m1.cfg'])
  fs.appendFileSync(path.join(copied.site, 'm1.cfg'), 'tail = 1\n')
  fs.copyFileSync(path.join(copied.site, 'm1.cfg'), path.join(copied.site, 'd.cfg'))
  fs.appendFileSync(path.join(copied.site, 'd.cfg'), 'extra = 1\n')
  fs.writeFileSync(path.join(copied.site, 'x.txt'), 'note one\n')
  git(copied.site, ['add', '.'])
  git(copied.site, ['config', 'diff.renames', 'copies'])
  git(copied.site, ['config', 'diff.renameLimit', '1'])
  errors = stagedSecretErrors(copied.site, copied.project, copied.policy)
  assert.ok(errors.some((item) => item.path === 'd.cfg' && item.line === 2 && item.rule === 'secret-material'), JSON.stringify(errors))
  assert.ok(!errors.some((item) => item.code === 'content-scan-incomplete'), JSON.stringify(errors))
})

test('a file that replaces a directory is never judged by a pairing the main diff did not make', (t) => {
  const { site, policy, project } = makeWorkspace(t)
  fs.writeFileSync(path.join(site, '.gitattributes'), '*.cfg -diff\n')
  const contents = `head = 0\n${KEY_MATERIAL}\n${Array.from({ length: 18 }, (_, index) => `setting_${index} = value_${index}`).join('\n')}\n`
  fs.mkdirSync(path.join(site, 'conf.cfg'))
  fs.writeFileSync(path.join(site, 'conf.cfg', 'main.cfg'), contents)
  git(site, ['add', '.'])
  git(site, ['commit', '--quiet', '-m', 'accepted earlier use in conf.cfg/main.cfg'])
  // The directory moves away unchanged and a file takes its name. Narrowed to
  // conf.cfg, Git sees the old conf.cfg/main.cfg as the new file's source; the
  // main diff does not, so the file is new and its key is never an accepted use.
  fs.mkdirSync(path.join(site, 'conf.d'))
  git(site, ['mv', 'conf.cfg/main.cfg', 'conf.d/main.cfg'])
  fs.rmSync(path.join(site, 'conf.cfg'), { recursive: true, force: true })
  fs.writeFileSync(path.join(site, 'conf.cfg'), `${contents}extra = 1\n`)
  git(site, ['add', '.'])
  // The directory's files are not read with it, so the file is judged whole, as the main diff has it.
  const errors = stagedSecretErrors(site, project, policy)
  assert.ok(errors.some((item) => item.path === 'conf.cfg' && item.line === 2 && item.rule === 'secret-material'), JSON.stringify(errors))
  assert.ok(!errors.some((item) => item.code === 'content-scan-incomplete'), JSON.stringify(errors))
})

test('a file that replaces a directory is paired as the main diff pairs it, whatever else moved out', (t) => {
  const { site, policy, project } = makeWorkspace(t)
  fs.writeFileSync(path.join(site, '.gitattributes'), '*.cfg -diff\n')
  const settings = Array.from({ length: 18 }, (_, index) => `setting_${index} = value_${index}`).join('\n')
  fs.mkdirSync(path.join(site, 'conf.cfg'))
  fs.writeFileSync(path.join(site, 'conf.cfg', 'main.cfg'), `head = 0\n${settings}\n`)
  fs.writeFileSync(path.join(site, 'conf.cfg', 'other.cfg'), `head = 0\n${KEY_MATERIAL}\n${settings}\n`)
  git(site, ['add', '.'])
  git(site, ['commit', '--quiet', '-m', 'accepted earlier use in conf.cfg/other.cfg'])
  // other.cfg moves out unchanged; main.cfg becomes the file conf.cfg, gaining the key.
  fs.mkdirSync(path.join(site, 'w'))
  git(site, ['mv', 'conf.cfg/other.cfg', 'w/other.cfg'])
  git(site, ['rm', '--quiet', 'conf.cfg/main.cfg'])
  fs.rmSync(path.join(site, 'conf.cfg'), { recursive: true, force: true })
  fs.writeFileSync(path.join(site, 'conf.cfg'), `head = 0\n${KEY_MATERIAL}\n${settings}\nx = 1\n`)
  git(site, ['add', '.'])
  const errors = stagedSecretErrors(site, project, policy)
  assert.ok(errors.some((item) => item.path === 'conf.cfg' && item.line === 2 && item.rule === 'secret-material'), JSON.stringify(errors))
  assert.ok(!errors.some((item) => item.code === 'content-scan-incomplete'), JSON.stringify(errors))
})

test('a file renamed into a directory of its own name is read with its source', (t) => {
  const { site, policy, project } = makeWorkspace(t)
  fs.writeFileSync(path.join(site, '.gitattributes'), '*.cfg -diff\n')
  const settings = Array.from({ length: 20 }, (_, index) => `setting_${index} = value_${index}`).join('\n')
  fs.writeFileSync(path.join(site, 'conf.cfg'), `${settings}\n`)
  git(site, ['add', '.'])
  git(site, ['commit', '--quiet', '-m', 'a file'])
  git(site, ['mv', 'conf.cfg', 'moving.cfg'])
  fs.mkdirSync(path.join(site, 'conf.cfg'))
  git(site, ['mv', 'moving.cfg', 'conf.cfg/main.cfg'])
  fs.appendFileSync(path.join(site, 'conf.cfg', 'main.cfg'), `${KEY_MATERIAL}\n`)
  git(site, ['add', '.'])
  const errors = stagedSecretErrors(site, project, policy)
  assert.ok(errors.some((item) => item.path === 'conf.cfg/main.cfg' && item.line === 21 && item.rule === 'secret-material'), JSON.stringify(errors))
  assert.ok(!errors.some((item) => item.code === 'content-scan-incomplete'), JSON.stringify(errors))
})

test('a file that replaces a large directory is read with one exclusion, not one per entry', (t) => {
  const { site } = makeWorkspace(t)
  fs.writeFileSync(path.join(site, '.gitattributes'), '*.cfg -diff\n')
  fs.mkdirSync(path.join(site, 'big.cfg'))
  for (let index = 0; index < 400; index += 1) fs.writeFileSync(path.join(site, 'big.cfg', `entry-${index}.txt`), `entry ${index}\n`)
  git(site, ['add', '.'])
  git(site, ['commit', '--quiet', '-m', 'a large directory'])
  git(site, ['rm', '--quiet', '-r', 'big.cfg'])
  fs.writeFileSync(path.join(site, 'big.cfg'), `name = big\n${KEY_MATERIAL}\n`)
  git(site, ['add', '.'])
  const exclusions = []
  const result = scanStagedRepository({
    repoRoot: site,
    repo: 'site',
    gitRunner: (exe, args, options) => {
      if (args.some((value) => value.startsWith(':(literal)'))) exclusions.push(args.filter((value) => value.startsWith(':(exclude,literal)')))
      return spawnSync(exe, args, options)
    },
  })
  assert.deepEqual(exclusions, [[':(exclude,literal)big.cfg/']])
  assert.deepEqual(result.findings.filter((item) => item.rule === 'secret-material').map((item) => `${item.path}|${item.line}`), ['big.cfg|2'])
  assert.deepEqual(result.diagnostics, [])
})

test('declared-binary text batches are split by size as well as count', (t) => {
  const { site } = makeWorkspace(t)
  fs.writeFileSync(path.join(site, '.gitattributes'), '*.cfg -diff\n')
  const line = `${'x'.repeat(63)}\n`
  for (const name of ['a.cfg', 'b.cfg']) fs.writeFileSync(path.join(site, name), `${KEY_MATERIAL}\n${line.repeat(80 * 1024)}`)
  git(site, ['add', '.'])
  const textDiffs = []
  const result = scanStagedRepository({
    repoRoot: site,
    repo: 'site',
    gitRunner: (exe, args, options) => {
      const literal = args.filter((value) => value.startsWith(':(literal)'))
      if (literal.length > 0) textDiffs.push(literal.length)
      return spawnSync(exe, args, options)
    },
  })
  // Each file holds about 5 MiB, so two would pass half the 16 MiB diff limit together.
  assert.deepEqual(textDiffs, [1, 1])
  assert.deepEqual(result.findings.filter((item) => item.rule === 'secret-material').map((item) => item.path).sort(), ['a.cfg', 'b.cfg'])
  assert.deepEqual(result.diagnostics, [])
})

test('declared-binary text is read in batches, and file by file when a batch cannot be read', (t) => {
  const { site } = makeWorkspace(t)
  fs.writeFileSync(path.join(site, '.gitattributes'), '*.cfg -diff\n')
  const names = Array.from({ length: 205 }, (_, index) => `f${String(index).padStart(3, '0')}.cfg`)
  const planted = new Set(['f000.cfg', 'f199.cfg', 'f200.cfg', 'f204.cfg'])
  for (const name of names) fs.writeFileSync(path.join(site, name), `name = ${name}\n${planted.has(name) ? `${KEY_MATERIAL}\n` : ''}`)
  git(site, ['add', '.'])
  const textDiffs = []
  const scan = (fails = () => false) => scanStagedRepository({
    repoRoot: site,
    repo: 'site',
    gitRunner: (exe, args, options) => {
      const literal = args.filter((value) => value.startsWith(':(literal)'))
      if (literal.length > 0) {
        textDiffs.push(literal.length)
        if (fails(literal)) return { status: null, error: Object.assign(new Error('output limit'), { code: 'ENOBUFS' }), stdout: '' }
      }
      return spawnSync(exe, args, options)
    },
  })
  const flagged = (result) => result.findings.filter((item) => item.rule === 'secret-material').map((item) => `${item.path}|${item.line}`).sort()
  const expected = [...planted].map((name) => `${name}|2`).sort()

  let result = scan()
  assert.deepEqual(flagged(result), expected)
  assert.deepEqual(result.diagnostics, [])
  assert.deepEqual(textDiffs, [200, 5])

  // A batch over the output limit is read again one file at a time.
  textDiffs.length = 0
  result = scan((literal) => literal.length > 1)
  assert.deepEqual(flagged(result), expected)
  assert.deepEqual(result.diagnostics, [])
  assert.equal(textDiffs.length, 2 + 205)

  // A file that cannot be read on its own blocks, naming the cause.
  result = scan((literal) => literal.length > 1 || literal[0] === ':(literal)f201.cfg')
  assert.deepEqual(result.diagnostics.map((item) => [item.path, item.details.reason, item.details.cause]), [['f201.cfg', 'declared-binary-text-unreadable', 'git-output-limit-exceeded']])
  assert.match(result.diagnostics[0].message, /byte limit/)
})

const PACKAGE_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

/** Run git as a person would, with installed hooks answered only by this checkout's CLI. */
function hookedGit(t, cwd) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-hook-bin-'))
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }))
  fs.symlinkSync(process.execPath, path.join(bin, 'node'))
  fs.symlinkSync(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(), path.join(bin, 'git'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')))
  // The person at the terminal names themselves with the supported local selector, so a
  // platform login in the environment (GITHUB_ACTOR on CI) is not mistaken for them.
  Object.assign(env, { PATH: [bin, '/usr/bin', '/bin'].join(':'), MNSTRY_ATELIER_PACKAGE_ROOT: PACKAGE_ROOT, MNSTRY_ATELIER_ACTOR: 'author' })
  return (args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env })
}

test('the pre-commit hook judges the index Git is committing, in every commit form', { skip: process.platform === 'win32' && 'POSIX hook shell' }, (t) => {
  const { site, project } = makeWorkspace(t)
  installBoundaryHooks({ project })
  const run = hookedGit(t, site)
  const head = () => git(site, ['rev-parse', 'HEAD'])

  // A clean change commits, so a refusal below is the scan's.
  fs.appendFileSync(path.join(site, CART), '// clean\n')
  let result = run(['commit', '--quiet', '-am', 'clean'])
  assert.equal(result.status, 0, result.stderr)

  for (const form of [['-am', 'with -a'], ['-m', 'named path', '--', CART]]) {
    const before = head()
    fs.appendFileSync(path.join(site, CART), `${KEY_MATERIAL}\n`)
    result = run(['commit', '--quiet', ...form])
    assert.notEqual(result.status, 0, `${form[1]}: committed a key`)
    assert.match(result.stderr + result.stdout, /secret-material|content-rule-violation/, form[1])
    assert.equal(head(), before)
    git(site, ['checkout', '--', CART])
  }

  // A linked worktree of the managed repo is judged as that repo.
  const linked = path.join(path.dirname(site), 'example-site-linked')
  git(site, ['worktree', 'add', '--quiet', '-b', 'linked', linked])
  const inLinked = hookedGit(t, linked)
  fs.appendFileSync(path.join(linked, CART), `${KEY_MATERIAL}\n`)
  const before = git(linked, ['rev-parse', 'HEAD'])
  result = inLinked(['commit', '--quiet', '-am', 'linked worktree'])
  assert.notEqual(result.status, 0, 'a linked worktree committed a key')
  assert.equal(git(linked, ['rev-parse', 'HEAD']), before)
})

test('a commit with -a is judged for semantic fields, forbidden paths and declared-binary text', { skip: process.platform === 'win32' && 'POSIX hook shell' }, (t) => {
  const { site, project } = makeWorkspace(t)
  fs.mkdirSync(path.join(site, 'docs'))
  fs.writeFileSync(path.join(site, 'docs', 'note.md'), '---\naudience: "private"\n---\n\nA note.\n')
  fs.writeFileSync(path.join(site, '.gitattributes'), '*.cfg -diff\n')
  fs.writeFileSync(path.join(site, 'conf.cfg'), 'name = site\n')
  git(site, ['add', '.'])
  git(site, ['commit', '--quiet', '-m', 'seed'])
  installBoundaryHooks({ project })
  const run = hookedGit(t, site)
  const refuses = (label, change, code) => {
    const before = git(site, ['rev-parse', 'HEAD'])
    change()
    const result = run(['commit', '--quiet', '-am', label])
    assert.notEqual(result.status, 0, `${label}: committed`)
    assert.match(result.stderr + result.stdout, code, label)
    assert.equal(git(site, ['rev-parse', 'HEAD']), before)
    git(site, ['reset', '--quiet', '--hard'])
  }
  refuses('semantic field', () => fs.writeFileSync(path.join(site, 'docs', 'note.md'), '---\naudience: "team"\n---\n\nA note.\n'), /semantic-field-change-needs-review/)
  refuses('forbidden path', () => {
    fs.mkdirSync(path.join(site, '.atelier-local'))
    fs.writeFileSync(path.join(site, '.atelier-local', 'notes.txt'), 'local\n')
    git(site, ['add', '-N', '.atelier-local/notes.txt'])
  }, /forbidden-path-staged/)
  fs.rmSync(path.join(site, '.atelier-local'), { recursive: true, force: true })
  refuses('declared-binary text', () => fs.appendFileSync(path.join(site, 'conf.cfg'), `${KEY_MATERIAL}\n`), /secret-material|content-rule-violation/)
})

test('a pre-commit hook chained from a subdirectory judges the same commit', { skip: process.platform === 'win32' && 'POSIX hook shell' }, (t) => {
  const { site, project } = makeWorkspace(t)
  installBoundaryHooks({ project })
  const hooks = path.join(site, '.git', 'hooks')
  fs.renameSync(path.join(hooks, 'pre-commit'), path.join(hooks, 'pre-commit-atelier'))
  fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/usr/bin/env bash\ncd src && exec ../.git/hooks/pre-commit-atelier\n')
  fs.chmodSync(path.join(hooks, 'pre-commit'), 0o755)
  const run = hookedGit(t, site)
  fs.appendFileSync(path.join(site, CART), '// clean\n')
  let result = run(['commit', '--quiet', '-am', 'clean'])
  assert.equal(result.status, 0, result.stderr + result.stdout)
  fs.appendFileSync(path.join(site, CART), `${KEY_MATERIAL}\n`)
  result = run(['commit', '--quiet', '-am', 'key'])
  assert.notEqual(result.status, 0, 'committed a key')
  assert.match(result.stderr + result.stdout, /secret-material|content-rule-violation/)
  git(site, ['checkout', '--', CART])

  // Hooks are shared with linked worktrees, where Git exports GIT_DIR without a
  // work tree; the chained hook there judges the worktree's own commit.
  fs.writeFileSync(path.join(hooks, 'pre-commit'), `#!/usr/bin/env bash\ncd src && exec '${path.join(hooks, 'pre-commit-atelier')}'\n`)
  const linked = path.join(path.dirname(site), 'example-site-chained')
  git(site, ['worktree', 'add', '--quiet', '-b', 'chained', linked])
  const inLinked = hookedGit(t, linked)
  fs.appendFileSync(path.join(linked, CART), '// clean in the worktree\n')
  result = inLinked(['commit', '--quiet', '-am', 'clean in the worktree'])
  assert.equal(result.status, 0, result.stderr + result.stdout)
  fs.appendFileSync(path.join(linked, CART), `${KEY_MATERIAL}\n`)
  result = inLinked(['commit', '--quiet', '-am', 'key in the worktree'])
  assert.notEqual(result.status, 0, 'a linked worktree committed a key')
  assert.match(result.stderr + result.stdout, /secret-material|content-rule-violation/)
})

test('a commit no single declared repo accounts for is refused', { skip: process.platform === 'win32' && 'POSIX hook shell' }, (t) => {
  const { root, site, project } = makeWorkspace(t)
  // Two declared repos share one Git directory: the checkout and a linked worktree of it.
  const declared = path.join(root, 'example-site-declared')
  git(site, ['worktree', 'add', '--quiet', '-b', 'declared', declared])
  const config = JSON.parse(fs.readFileSync(path.join(root, 'atelier.project.json'), 'utf8'))
  config.repos.push({ name: 'example-site-declared', path: 'example-site-declared', readBoundary: 'team' })
  writeJson(path.join(root, 'atelier.project.json'), config)
  installBoundaryHooks({ project })
  // A third worktree, declared nowhere, commits.
  const third = path.join(root, 'example-site-third')
  git(site, ['worktree', 'add', '--quiet', '-b', 'third', third])
  fs.appendFileSync(path.join(third, CART), '// a change\n')
  const result = hookedGit(t, third)(['commit', '--quiet', '-am', 'from an undeclared worktree'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr + result.stdout, /pre-commit-repo-unresolved/)
})

test('a declared path that differs only in case still names the repo being committed', { skip: process.platform === 'win32' && 'POSIX hook shell' }, (t) => {
  const { root, site, project } = makeWorkspace(t)
  if (!fs.existsSync(path.join(root, 'EXAMPLE-SITE'))) return t.skip('case-sensitive file system')
  const config = JSON.parse(fs.readFileSync(path.join(root, 'atelier.project.json'), 'utf8'))
  config.repos[0].path = 'EXAMPLE-SITE'
  writeJson(path.join(root, 'atelier.project.json'), config)
  installBoundaryHooks({ project })
  fs.appendFileSync(path.join(site, CART), `${KEY_MATERIAL}\n`)
  const result = hookedGit(t, site)(['commit', '--quiet', '-am', 'key'])
  assert.notEqual(result.status, 0, 'committed a key')
  assert.match(result.stderr + result.stdout, /secret-material|content-rule-violation/)
  assert.doesNotMatch(result.stderr + result.stdout, /pre-commit-repo-unresolved/)
})

test('a hook index is resolved against the work tree the hook runs in', (t) => {
  const { site } = makeWorkspace(t)
  // The file system's own spelling: on Windows a temp path can carry an 8.3 short name.
  const real = fs.realpathSync.native(site)
  assert.equal(hookIndexFromEnvironment({ env: {}, cwd: site }), null)
  const plain = hookIndexFromEnvironment({ env: { GIT_INDEX_FILE: '.git/index' }, cwd: site })
  assert.equal(plain.workTree, real)
  assert.equal(plain.indexFile, path.join(real, '.git', 'index'))
  assert.equal(plain.commonDir, fs.realpathSync.native(path.join(site, '.git')))
  // A chained hook that moved into a subdirectory still names the top of the work tree.
  const nested = hookIndexFromEnvironment({ env: { GIT_INDEX_FILE: '.git/index' }, cwd: path.join(site, 'src') })
  assert.deepEqual(nested, plain)
})

test('content added and removed again within one push is judged in the commit that added it', (t) => {
  const { site, policy, project } = makeWorkspace(t)
  commit(site, 'notes/key.txt', `${KEY_MATERIAL}\n`, 'adds a key')
  const added = git(site, ['rev-parse', 'HEAD'])
  fs.rmSync(path.join(site, 'notes', 'key.txt'))
  commit(site, 'notes/readme.txt', 'nothing here\n', 'removes it again')
  const report = checkPushContent({ project, policy, updates: pushUpdate(site), cwd: site })
  assert.equal(report.ok, false)
  const found = report.errors.filter((item) => item.rule === 'secret-material')
  assert.deepEqual(found.map((item) => [item.path, item.line, item.commit]), [['notes/key.txt', 1, added]])
  assert.match(found[0].message, new RegExp(`in commit ${added.slice(0, 12)}`))

  // A binary added and deleted again within the push is read as well.
  const second = makeWorkspace(t)
  commit(second.site, 'assets/blob.bin', Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(`${KEY_MATERIAL}\n`)]), 'adds a binary')
  const binaryCommit = git(second.site, ['rev-parse', 'HEAD'])
  fs.rmSync(path.join(second.site, 'assets', 'blob.bin'))
  commit(second.site, 'assets/readme.txt', 'nothing here\n', 'removes it again')
  const binaryReport = checkPushContent({ project: second.project, policy: second.policy, updates: pushUpdate(second.site), cwd: second.site })
  assert.ok(binaryReport.errors.some((item) => item.path === 'assets/blob.bin' && item.binary === true && item.commit === binaryCommit), JSON.stringify(binaryReport.errors))

  // A key that reaches the pushed tip is reported once, by the endpoint change.
  const kept = makeWorkspace(t)
  commit(kept.site, 'notes/key.txt', `${KEY_MATERIAL}\n`, 'adds a key')
  commit(kept.site, 'notes/other.txt', 'more\n', 'another commit')
  const keptReport = checkPushContent({ project: kept.project, policy: kept.policy, updates: pushUpdate(kept.site), cwd: kept.site })
  const keys = keptReport.errors.filter((item) => item.rule === 'secret-material')
  assert.deepEqual(keys.map((item) => [item.path, item.line, item.commit ?? null]), [['notes/key.txt', 1, null]])
  // The report still says which commits carry it.
  assert.deepEqual(keys[0].commits, [git(kept.site, ['rev-parse', 'HEAD~1'])])
})

test('a push judges each commit no remote has, once, and refuses one that carries too many', (t) => {
  const { site } = makeWorkspace(t)
  const diffs = []
  const scan = (update, options = {}) => scanPushUpdate({
    repoRoot: site,
    update,
    repo: 'site',
    gitRunner: (exe, args, opts) => {
      if (args.includes('diff')) diffs.push(args.slice(-2).join('..'))
      return spawnSync(exe, args, opts)
    },
    ...options,
  })
  // One commit on the remote's tip is the endpoint change itself: one diff.
  commit(site, 'a.txt', 'one\n', 'one')
  let result = scan(pushUpdate(site)[0])
  assert.equal(diffs.length, 1)
  assert.deepEqual(result.diagnostics, [])
  // Three new commits: the endpoints, then each commit against its parent.
  commit(site, 'b.txt', 'two\n', 'two')
  commit(site, 'c.txt', 'three\n', 'three')
  diffs.length = 0
  result = scan(pushUpdate(site)[0])
  assert.equal(diffs.length, 1 + 3)
  // A new branch from the pushed main carries only its own commit, not main's history.
  git(site, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main'])
  git(site, ['fetch', '--quiet', 'origin'])
  git(site, ['checkout', '--quiet', '-b', 'feature'])
  commit(site, 'd.txt', 'four\n', 'four')
  diffs.length = 0
  result = scan({ localRef: 'refs/heads/feature', localSha: git(site, ['rev-parse', 'HEAD']), remoteRef: 'refs/heads/feature', remoteSha: '0'.repeat(40) })
  assert.equal(diffs.length, 1 + 1)
  // Past the limit the push is refused, not judged only by its endpoints.
  commit(site, 'e.txt', 'five\n', 'five')
  result = scan({ localRef: 'refs/heads/feature', localSha: git(site, ['rev-parse', 'HEAD']), remoteRef: 'refs/heads/feature', remoteSha: '0'.repeat(40) }, { maxCommits: 1 })
  assert.deepEqual(result.diagnostics.map((item) => [item.code, item.details.reason, item.details.limit]), [['content-scan-incomplete', 'push-range-too-long', 1]])
  assert.match(result.diagnostics[0].message, /push it in smaller parts/)
})

test('a pull merge is not judged for what the remote already holds, but an evil merge is', (t) => {
  const { root, site, policy, project } = makeWorkspace(t)
  // A collaborator publishes a change the guard would refuse, without the hook.
  const collaborator = path.join(root, 'collaborator')
  execFileSync('git', ['clone', '--quiet', '--branch', 'main', path.join(root, 'example-site.git'), collaborator])
  git(collaborator, ['config', 'user.email', 'other@example.invalid'])
  git(collaborator, ['config', 'user.name', 'Other'])
  fs.appendFileSync(path.join(collaborator, CART), 'export const load = () => localStorage.getItem("cart")\n')
  git(collaborator, ['commit', '--quiet', '-am', 'published without the hook'])
  git(collaborator, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main'])
  commit(site, 'README.md', '# Site\n', 'readme')
  git(site, ['pull', '--quiet', '--no-rebase', '--no-edit', 'origin', 'main'])
  let report = checkPushContent({ project, policy, updates: pushUpdate(site), cwd: site })
  assert.deepEqual(report.errors, [], 'content the remote already holds is not judged again')

  // A key that only the merge introduces is new against every parent.
  fs.appendFileSync(path.join(site, 'README.md'), `${KEY_MATERIAL}\n`)
  git(site, ['add', 'README.md'])
  git(site, ['commit', '--quiet', '--amend', '--no-edit'])
  const merge = git(site, ['rev-parse', 'HEAD'])
  assert.equal(git(site, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ').length, 3)
  // Removed again afterwards, so only the merge itself carries it.
  fs.writeFileSync(path.join(site, 'README.md'), '# Site\n')
  commit(site, 'README.md', '# Site\n', 'removes the key')
  report = checkPushContent({ project, policy, updates: pushUpdate(site), cwd: site })
  assert.ok(report.errors.some((item) => item.rule === 'secret-material' && item.path === 'README.md' && item.commit === merge), JSON.stringify(report.errors))
  assert.ok(report.errors.every((item) => item.rule !== 'browser-persistence'), JSON.stringify(report.errors))
})

test('a key added and removed on a merged side branch is judged in its own commit', (t) => {
  const { site, policy, project } = makeWorkspace(t)
  git(site, ['checkout', '--quiet', '-b', 'side'])
  commit(site, 'side/key.txt', `${KEY_MATERIAL}\n`, 'adds a key on the side')
  const added = git(site, ['rev-parse', 'HEAD'])
  fs.rmSync(path.join(site, 'side', 'key.txt'))
  commit(site, 'side/readme.txt', 'nothing\n', 'removes it')
  git(site, ['checkout', '--quiet', '-'])
  commit(site, 'main.txt', 'main work\n', 'main work')
  git(site, ['merge', '--quiet', '--no-ff', '--no-edit', 'side'])
  const report = checkPushContent({ project, policy, updates: pushUpdate(site), cwd: site })
  assert.ok(report.errors.some((item) => item.rule === 'secret-material' && item.commit === added), JSON.stringify(report.errors))
})

test('an intermediate commit the push check cannot read refuses the push and names the commit', (t) => {
  // A binary over the per-file limit, added and removed again.
  const big = makeWorkspace(t)
  commit(big.site, 'assets/big.bin', Buffer.concat([Buffer.from([0]), Buffer.from(KEY_MATERIAL), Buffer.alloc(BINARY_FILE_MAX_BYTES + 1, 1)]), 'a large binary')
  const bigCommit = git(big.site, ['rev-parse', 'HEAD'])
  fs.rmSync(path.join(big.site, 'assets', 'big.bin'))
  commit(big.site, 'assets/readme.txt', 'gone\n', 'removes it')
  let report = checkPushContent({ project: big.project, policy: big.policy, updates: pushUpdate(big.site), cwd: big.site })
  assert.ok(report.errors.some((item) => item.code === 'content-scan-incomplete' && item.details.commit === bigCommit && new RegExp(bigCommit.slice(0, 12)).test(item.message)), JSON.stringify(report.errors))

  // A text change whose diff is over the limit, added and removed again.
  const wide = makeWorkspace(t)
  commit(wide.site, 'notes/huge.txt', `${KEY_MATERIAL}\n${'filler line of text\n'.repeat(900000)}`, 'a huge text file')
  const wideCommit = git(wide.site, ['rev-parse', 'HEAD'])
  fs.rmSync(path.join(wide.site, 'notes', 'huge.txt'))
  commit(wide.site, 'notes/readme.txt', 'gone\n', 'removes it')
  report = checkPushContent({ project: wide.project, policy: wide.policy, updates: pushUpdate(wide.site), cwd: wide.site })
  assert.ok(report.errors.some((item) => item.code === 'content-scan-incomplete' && item.details?.commit === wideCommit), JSON.stringify(report.errors))
  // Deleting it again is readable: a deletion's removed lines are not printed.
  assert.deepEqual(report.errors.filter((item) => item.code === 'content-scan-incomplete').map((item) => item.details?.commit), [wideCommit])
})

test('the push check refuses when it cannot list the commits or the evidence grows past its budget', (t) => {
  const { site } = makeWorkspace(t)
  commit(site, 'a.txt', 'one\n', 'one')
  commit(site, 'b.txt', 'two\n', 'two')
  const update = pushUpdate(site)[0]
  let result = scanPushUpdate({ repoRoot: site, update, repo: 'site', gitRunner: (exe, args, opts) => (args.includes('rev-list') ? { status: 128, stdout: '' } : spawnSync(exe, args, opts)) })
  assert.ok(result.diagnostics.some((item) => item.code === 'content-scan-incomplete' && /could not be listed/.test(item.message)), JSON.stringify(result.diagnostics))
  // Most of this push's evidence is in a commit that adds a large file and one that removes it.
  commit(site, 'notes/large.txt', 'a line of filler text\n'.repeat(5000), 'a large file')
  fs.rmSync(path.join(site, 'notes', 'large.txt'))
  commit(site, 'notes/readme.txt', 'gone\n', 'removes it')
  const wide = pushUpdate(site)[0]
  const endpoints = scanPushUpdate({ repoRoot: site, update: wide, repo: 'site', maxCommits: 0 })
  assert.ok(endpoints.bytes < 50000)
  result = scanPushUpdate({ repoRoot: site, update: wide, repo: 'site', maxBytes: 50000 })
  assert.ok(result.diagnostics.some((item) => item.details.reason === 'push-evidence-too-large'), JSON.stringify(result.diagnostics))
  assert.ok(result.bytes > 50000)
})

test('history only another remote holds is judged on its way to a new one', (t) => {
  const { root, site } = makeWorkspace(t)
  commit(site, 'notes/key.txt', `${KEY_MATERIAL}\n`, 'adds a key')
  const added = git(site, ['rev-parse', 'HEAD'])
  fs.rmSync(path.join(site, 'notes', 'key.txt'))
  commit(site, 'notes/readme.txt', 'nothing\n', 'removes it')
  // Published to origin earlier, without the hook.
  git(site, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main'])
  execFileSync('git', ['init', '--quiet', '--bare', path.join(root, 'public.git')])
  git(site, ['remote', 'add', 'public', path.join(root, 'public.git')])
  const update = { localRef: 'refs/heads/main', localSha: git(site, ['rev-parse', 'HEAD']), remoteRef: 'refs/heads/main', remoteSha: '0'.repeat(40) }
  const toPublic = scanPushUpdate({ repoRoot: site, update, repo: 'site', remote: 'public' })
  assert.ok(toPublic.findings.some((item) => item.rule === 'secret-material' && item.commit === added), JSON.stringify(toPublic.findings))
})

test('a blob judged at one path is judged again at another', (t) => {
  const { site, policy, project } = makeWorkspace(t, { exceptions: [{ rule: 'secret-material', repo: 'example-site', paths: ['fixtures/**'], reason: 'test fixture' }] })
  const blob = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(`${KEY_MATERIAL}\n`)])
  commit(site, 'fixtures/key.bin', blob, 'an excepted fixture')
  commit(site, 'src/key.bin', blob, 'the same bytes elsewhere')
  const report = checkPushContent({ project, policy, updates: pushUpdate(site), cwd: site })
  assert.ok(report.errors.some((item) => item.path === 'src/key.bin' && item.rule === 'secret-material'), JSON.stringify(report.errors))
  assert.ok(!report.errors.some((item) => item.path === 'fixtures/key.bin'), JSON.stringify(report.errors))
})

test('an evil merge over a type change is still judged', { skip: process.platform === 'win32' && 'symbolic links' }, (t) => {
  const { site, policy, project } = makeWorkspace(t)
  commit(site, 'notes/f.txt', 'one\n', 'a file')
  git(site, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main'])
  git(site, ['checkout', '--quiet', '-b', 'linked'])
  fs.rmSync(path.join(site, 'notes', 'f.txt'))
  fs.symlinkSync('elsewhere', path.join(site, 'notes', 'f.txt'))
  git(site, ['add', '-A'])
  git(site, ['commit', '--quiet', '-m', 'now a link'])
  git(site, ['checkout', '--quiet', '-'])
  commit(site, 'notes/f.txt', 'two\n', 'edited')
  assert.throws(() => git(site, ['merge', '--quiet', 'linked']))
  fs.rmSync(path.join(site, 'notes', 'f.txt'), { force: true })
  fs.writeFileSync(path.join(site, 'notes', 'f.txt'), `two\n${KEY_MATERIAL}\n`)
  git(site, ['add', '-A'])
  git(site, ['commit', '--quiet', '--no-edit'])
  const merge = git(site, ['rev-parse', 'HEAD'])
  commit(site, 'notes/f.txt', 'two\n', 'removes the key')
  const report = checkPushContent({ project, policy, updates: pushUpdate(site), cwd: site })
  assert.ok(report.errors.some((item) => item.rule === 'secret-material' && item.commit === merge), JSON.stringify(report.errors))
})

test('a pull merge over large upstream binaries passes, but a binary only the merge adds is judged', (t) => {
  const { root, site, policy, project } = makeWorkspace(t)
  const collaborator = path.join(root, 'collaborator')
  execFileSync('git', ['clone', '--quiet', '--branch', 'main', path.join(root, 'example-site.git'), collaborator])
  git(collaborator, ['config', 'user.email', 'other@example.invalid'])
  git(collaborator, ['config', 'user.name', 'Other'])
  // More binary content than one diff may read, all of it already published.
  for (let index = 0; index < 5; index += 1) {
    fs.mkdirSync(path.join(collaborator, 'photos'), { recursive: true })
    fs.writeFileSync(path.join(collaborator, 'photos', `photo-${index}.bin`), Buffer.concat([Buffer.from([0, index]), Buffer.alloc(7 * 1024 * 1024, index + 1)]))
    git(collaborator, ['add', '.'])
    git(collaborator, ['commit', '--quiet', '-m', `photo ${index}`])
    git(collaborator, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main'])
  }
  commit(site, 'README.md', '# Site\n', 'readme')
  git(site, ['pull', '--quiet', '--no-rebase', '--no-edit', 'origin', 'main'])
  let report = checkPushContent({ project, policy, updates: pushUpdate(site), cwd: site })
  assert.deepEqual(report.errors, [], 'published content neither refuses nor spends the budget')
  const budgeted = scanPushUpdate({ repoRoot: site, update: pushUpdate(site)[0], repo: 'site', maxBytes: 20 * 1024 * 1024 })
  assert.deepEqual(budgeted.diagnostics, [])

  // The merge alone adds a binary holding a key, removed again afterwards.
  fs.writeFileSync(path.join(site, 'z-evil.bin'), Buffer.concat([Buffer.from([0, 9]), Buffer.from(`${KEY_MATERIAL}\n`)]))
  git(site, ['add', 'z-evil.bin'])
  git(site, ['commit', '--quiet', '--amend', '--no-edit'])
  const merge = git(site, ['rev-parse', 'HEAD'])
  fs.rmSync(path.join(site, 'z-evil.bin'))
  commit(site, 'README.md', '# Site, again\n', 'removes it')
  report = checkPushContent({ project, policy, updates: pushUpdate(site), cwd: site })
  assert.ok(report.errors.some((item) => item.path === 'z-evil.bin' && item.binary === true && item.commit === merge), JSON.stringify(report.errors))
})

test('the push budget counts published binaries not at all and each new blob once', (t) => {
  const { root, site } = makeWorkspace(t)
  const collaborator = path.join(root, 'collaborator')
  execFileSync('git', ['clone', '--quiet', '--branch', 'main', path.join(root, 'example-site.git'), collaborator])
  git(collaborator, ['config', 'user.email', 'other@example.invalid'])
  git(collaborator, ['config', 'user.name', 'Other'])
  fs.mkdirSync(path.join(collaborator, 'photos'))
  for (let index = 0; index < 3; index += 1) fs.writeFileSync(path.join(collaborator, 'photos', `photo-${index}.bin`), Buffer.concat([Buffer.from([0, index]), Buffer.alloc(6 * 1024 * 1024, index + 1)]))
  git(collaborator, ['add', '.'])
  git(collaborator, ['commit', '--quiet', '-m', 'published photos'])
  git(collaborator, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main'])
  commit(site, 'README.md', '# Site\n', 'readme')
  git(site, ['pull', '--quiet', '--no-rebase', '--no-edit', 'origin', 'main'])
  let result = scanPushUpdate({ repoRoot: site, update: pushUpdate(site)[0], repo: 'site', maxBytes: 10 * 1024 * 1024 })
  assert.deepEqual(result.diagnostics, [], 'a pull merge is judged by the diff that leaves out what the remote published')

  // New binaries are read by the endpoint diff and by their commit, but count once.
  git(site, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main'])
  git(site, ['fetch', '--quiet', 'origin'])
  for (let index = 0; index < 3; index += 1) fs.writeFileSync(path.join(site, `asset-${index}.bin`), Buffer.concat([Buffer.from([0, 9, index]), Buffer.alloc(4 * 1024 * 1024, index + 5)]))
  git(site, ['add', '.'])
  git(site, ['commit', '--quiet', '-m', 'new assets'])
  commit(site, 'notes.txt', 'more\n', 'more')
  result = scanPushUpdate({ repoRoot: site, update: pushUpdate(site)[0], repo: 'site', maxBytes: 20 * 1024 * 1024 })
  assert.deepEqual(result.diagnostics, [])
  assert.ok(result.bytes < 20 * 1024 * 1024 && result.bytes > 12 * 1024 * 1024, String(result.bytes))
})

test('a merge that alone adds unreadable or keyed content is judged even when a parent diff fails', (t) => {
  // The merge alone adds a binary over the per-file limit, removed again: refused.
  const big = makeWorkspace(t)
  git(big.site, ['checkout', '--quiet', '-b', 'side'])
  commit(big.site, 'side.txt', 'side\n', 'side')
  git(big.site, ['checkout', '--quiet', '-'])
  commit(big.site, 'main.txt', 'main\n', 'main')
  git(big.site, ['merge', '--quiet', '--no-ff', '--no-commit', 'side'])
  fs.writeFileSync(path.join(big.site, 'evil.bin'), Buffer.concat([Buffer.from([0]), Buffer.from(KEY_MATERIAL), Buffer.alloc(BINARY_FILE_MAX_BYTES + 1, 1)]))
  git(big.site, ['add', 'evil.bin'])
  git(big.site, ['commit', '--quiet', '--no-edit'])
  const bigMerge = git(big.site, ['rev-parse', 'HEAD'])
  fs.rmSync(path.join(big.site, 'evil.bin'))
  commit(big.site, 'gone.txt', 'gone\n', 'removes it')
  let result = scanPushUpdate({ repoRoot: big.site, update: pushUpdate(big.site)[0], repo: 'site' })
  assert.ok(result.diagnostics.some((item) => item.details?.commit === bigMerge), JSON.stringify(result.diagnostics))

  // One parent diff is over the output limit; the merge's own key line is still found.
  const wide = makeWorkspace(t)
  const collaborator = path.join(wide.root, 'collaborator')
  execFileSync('git', ['clone', '--quiet', '--branch', 'main', path.join(wide.root, 'example-site.git'), collaborator])
  git(collaborator, ['config', 'user.email', 'other@example.invalid'])
  git(collaborator, ['config', 'user.name', 'Other'])
  fs.writeFileSync(path.join(collaborator, 'huge.txt'), 'published filler text\n'.repeat(900000))
  git(collaborator, ['add', '.'])
  git(collaborator, ['commit', '--quiet', '-m', 'a huge published file'])
  git(collaborator, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main'])
  commit(wide.site, 'README.md', '# Site\n', 'readme')
  git(wide.site, ['pull', '--quiet', '--no-rebase', '--no-edit', 'origin', 'main'])
  fs.appendFileSync(path.join(wide.site, 'README.md'), `${KEY_MATERIAL}\n`)
  git(wide.site, ['add', 'README.md'])
  git(wide.site, ['commit', '--quiet', '--amend', '--no-edit'])
  const wideMerge = git(wide.site, ['rev-parse', 'HEAD'])
  commit(wide.site, 'README.md', '# Site\n', 'removes the key')
  result = scanPushUpdate({ repoRoot: wide.site, update: pushUpdate(wide.site)[0], repo: 'site' })
  assert.ok(result.findings.some((item) => item.rule === 'secret-material' && item.commit === wideMerge), JSON.stringify(result.findings))
})

test('a remote named under another does not hide history from it', (t) => {
  const { root, site } = makeWorkspace(t)
  commit(site, 'notes/key.txt', `${KEY_MATERIAL}\n`, 'adds a key')
  const added = git(site, ['rev-parse', 'HEAD'])
  fs.rmSync(path.join(site, 'notes', 'key.txt'))
  commit(site, 'notes/readme.txt', 'nothing\n', 'removes it')
  // Newer Git refuses to add a remote named under another, but older Git and
  // hand-written configuration still produce one; set it up directly, with the
  // tracking ref a fetch from it would leave.
  execFileSync('git', ['init', '--quiet', '--bare', path.join(root, 'nested.git')])
  git(site, ['config', 'remote.origin/x.url', path.join(root, 'nested.git')])
  git(site, ['config', 'remote.origin/x.fetch', '+refs/heads/*:refs/remotes/origin/x/*'])
  git(site, ['update-ref', 'refs/remotes/origin/x/main', 'HEAD'])
  const result = scanPushUpdate({ repoRoot: site, update: pushUpdate(site)[0], repo: 'site', remote: 'origin' })
  assert.ok(result.findings.some((item) => item.rule === 'secret-material' && item.commit === added), JSON.stringify(result.findings))
})

test('a merge that cannot be read against any parent refuses the push', (t) => {
  const { site } = makeWorkspace(t)
  git(site, ['checkout', '--quiet', '-b', 'side'])
  commit(site, 'side.txt', 'side\n', 'side')
  git(site, ['checkout', '--quiet', '-'])
  commit(site, 'main.txt', 'main\n', 'main')
  git(site, ['merge', '--quiet', '--no-ff', '--no-edit', 'side'])
  const merge = git(site, ['rev-parse', 'HEAD'])
  const result = scanPushUpdate({
    repoRoot: site,
    update: pushUpdate(site)[0],
    repo: 'site',
    gitRunner: (exe, args, opts) => (args.includes('diff') && args.at(-1) === merge && args.length > 0 && args.at(-2) !== git(site, ['rev-parse', 'origin/main']) ? { status: 128, stdout: '' } : spawnSync(exe, args, opts)),
  })
  assert.ok(result.diagnostics.some((item) => item.details?.commit === merge), JSON.stringify(result.diagnostics))
})

test('a push to a URL or an unknown remote judges history other remotes hold', (t) => {
  const { root, site } = makeWorkspace(t)
  commit(site, 'notes/key.txt', `${KEY_MATERIAL}\n`, 'adds a key')
  const added = git(site, ['rev-parse', 'HEAD'])
  fs.rmSync(path.join(site, 'notes', 'key.txt'))
  commit(site, 'notes/readme.txt', 'nothing\n', 'removes it')
  git(site, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main'])
  const publicUrl = path.join(root, 'public.git')
  execFileSync('git', ['init', '--quiet', '--bare', publicUrl])
  git(site, ['remote', 'add', 'public', publicUrl])
  const update = { localRef: 'refs/heads/main', localSha: git(site, ['rev-parse', 'HEAD']), remoteRef: 'refs/heads/main', remoteSha: '0'.repeat(40) }
  for (const remote of [publicUrl, path.join(root, 'unconfigured.git')]) {
    const result = scanPushUpdate({ repoRoot: site, update, repo: 'site', remote })
    assert.ok(result.findings.some((item) => item.rule === 'secret-material' && item.commit === added), `${remote}: ${JSON.stringify(result.findings)}`)
  }
})

test('the pre-push hook passes its remote, and only rule violations suggest an exception', { skip: process.platform === 'win32' && 'POSIX hook shell' }, (t) => {
  const { root, site, project } = makeWorkspace(t)
  commit(site, 'notes/key.txt', `${KEY_MATERIAL}\n`, 'adds a key')
  fs.rmSync(path.join(site, 'notes', 'key.txt'))
  commit(site, 'notes/readme.txt', 'nothing\n', 'removes it')
  git(site, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main'])
  installBoundaryHooks({ project })
  // Setup commits below bypass the pre-commit hook; the push is what is under test.
  const setup = (rel, contents, message) => {
    fs.mkdirSync(path.dirname(path.join(site, rel)), { recursive: true })
    if (contents === null) fs.rmSync(path.join(site, rel))
    else fs.writeFileSync(path.join(site, rel), contents)
    git(site, ['add', '-A'])
    git(site, ['commit', '--quiet', '--no-verify', '-m', message])
  }
  execFileSync('git', ['init', '--quiet', '--bare', path.join(root, 'public.git')])
  git(site, ['remote', 'add', 'public', path.join(root, 'public.git')])
  const run = hookedGit(t, site)
  let result = run(['push', '--quiet', 'public', 'HEAD:refs/heads/main'])
  assert.notEqual(result.status, 0, 'legacy history reached a new remote unjudged')
  assert.match(result.stdout + result.stderr, /secret-material/)
  assert.match(result.stdout + result.stderr, /If this usage is intentional/)

  // Refused only because an intermediate commit cannot be read: no exception hint.
  setup('assets/big.bin', Buffer.concat([Buffer.from([0]), Buffer.alloc(BINARY_FILE_MAX_BYTES + 1, 1)]), 'a large binary')
  setup('assets/big.bin', null, 'removes it')
  result = run(['push', '--quiet', 'origin', 'HEAD:refs/heads/main'])
  assert.notEqual(result.status, 0)
  assert.match(result.stdout + result.stderr, /content-scan-incomplete/)
  assert.doesNotMatch(result.stdout + result.stderr, /If this usage is intentional/)
})

test('a new branch in a SHA-256 repository is scanned from its empty tree', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-sha256-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  git(root, ['init', '--quiet', '--object-format=sha256'])
  git(root, ['config', 'user.email', 'author@example.invalid'])
  git(root, ['config', 'user.name', 'Author'])
  commit(root, 'notes/key.txt', `${KEY_MATERIAL}\n`, 'a key on a new branch')
  const result = scanPushUpdate({ repoRoot: root, update: { localRef: 'refs/heads/main', localSha: git(root, ['rev-parse', 'HEAD']), remoteRef: 'refs/heads/main', remoteSha: '0'.repeat(64) }, repo: 'site' })
  assert.deepEqual(result.diagnostics, [])
  assert.ok(result.findings.some((item) => item.path === 'notes/key.txt' && item.rule === 'secret-material'), JSON.stringify(result.findings))
})

test('diff headers resolve quoted, ambiguous and renamed paths, and unreadable sections fail closed', () => {
  assert.equal(diffHeaderPath('diff --git a/docs/a.md b/docs/a.md'), 'docs/a.md')
  assert.equal(diffHeaderPath('diff --git a/x b/y.bin b/x b/y.bin'), 'x b/y.bin')
  assert.equal(diffHeaderPath('diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"'), 'caf\u00e9.txt')
  assert.equal(diffHeaderPath('diff --git a/plain.txt "b/tab\\tname.txt"'), 'tab\tname.txt')
  assert.equal(diffHeaderPath('diff --git a/old.txt b/new.txt'), null)
  assert.equal(diffHeaderPath('diff --git a/ b/'), null)
  assert.equal(diffHeaderPath('diff --git "a/bad\\400.txt" "b/bad\\400.txt"'), null)

  // A context line inside a hunk counts on both sides and does not end the hunk.
  const [fused] = parseDiffSections([
    'diff --git a/n.txt b/n.txt',
    `index ${'1'.repeat(40)}..${'2'.repeat(40)} 100644`,
    '--- a/n.txt',
    '+++ b/n.txt',
    '@@ -2,3 +2,3 @@',
    '-two',
    '+TWO',
    ' three',
    '-four',
    '+FOUR',
  ].join('\n'))
  assert.equal(fused.incomplete, null)
  assert.equal(fused.newBlob, '2'.repeat(40))
  assert.deepEqual(fused.addedLines, [{ number: 2, text: 'TWO' }, { number: 4, text: 'FOUR' }])

  const renamed = parseDiffSections([
    'diff --git a/old.txt b/new.txt',
    'similarity index 90%',
    'rename from old.txt',
    'rename to new.txt',
    '@@ -1 +1 @@',
    '-before',
    '+after',
  ].join('\n'))
  assert.equal(renamed[0].path, 'new.txt')
  assert.equal(renamed[0].incomplete, null)

  // Content that imitates a header inside a hunk stays content.
  const [inside] = parseDiffSections([
    'diff --git a/a.txt b/a.txt',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -0,0 +1,3 @@',
    '++++ b/elsewhere.txt',
    '+diff --git a/z b/z',
    '+last',
  ].join('\n'))
  assert.deepEqual(inside.addedLines.map((line) => line.text), ['+++ b/elsewhere.txt', 'diff --git a/z b/z', 'last'])

  const result = scanStagedRepository({
    repoRoot: '.',
    repo: 'site',
    gitRunner: (exe, args) => args.includes('diff')
      ? { status: 0, stdout: ['diff --git a/x b/y', '@@ -0,0 +1 @@', `+${KEY_MATERIAL}`].join('\n') }
      : { status: 1, stdout: '' },
  })
  assert.ok(result.diagnostics.some((item) => item.code === 'content-scan-incomplete' && item.details.reason === 'unreadable-file-path'), JSON.stringify(result))

  const short = parseDiffSections(['diff --git a/a.txt b/a.txt', '@@ -0,0 +1,2 @@', '+only one'].join('\n'))

  // An unmerged entry is its own unreadable section, not a line of the file before it.
  const unmerged = parseDiffSections([
    'diff --git a/a.txt b/a.txt',
    '@@ -0,0 +1 @@',
    '+fine',
    '* Unmerged path m.txt',
  ].join('\n'))
  assert.equal(unmerged[0].incomplete, null)
  assert.equal(unmerged[1].path, 'm.txt')
  assert.equal(unmerged[1].incomplete, 'unmerged-path')
  // Git prints an unmerged name as it is, never quoted.
  const [quotedName] = parseDiffSections('* Unmerged path "x".txt')
  assert.equal(quotedName.path, '"x".txt')
  assert.equal(quotedName.incomplete, 'unmerged-path')
  assert.equal(short[0].incomplete, 'hunk-shorter-than-its-header')
})

test('generated hooks single-quote config paths and reject control characters', () => {
  const config = '/tmp/project $(touch marker).json'
  const script = boundaryHookScript(config, 'pre-push', '/tmp/elsewhere')
  assert.match(script, /--project-config='\/tmp\/project \$\(touch marker\)\.json'/)
  assert.throws(
    () => boundaryHookScript('/tmp/project\nconfig.json', 'pre-push', '/tmp/elsewhere'),
    /unsupported control characters/,
  )
})

test('added lines are numbered against the new file', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -0,0 +12,2 @@',
    '+const a = 1',
    '+localStorage.setItem("k", "v")',
  ].join('\n')
  const [file] = parseAddedContent(diff)
  assert.equal(file.path, 'src/a.ts')
  assert.deepEqual(
    file.addedLines.map((line) => line.number),
    [12, 13],
  )
})

test('the push guard fails closed when it cannot identify the repo', (t) => {
  const { root, policy, project } = makeWorkspace(t)
  const report = checkPushContent({ project, policy, updates: [], cwd: root })

  assert.equal(report.ok, false, 'a guard that cannot tell what it is judging must not pass')
  assert.equal(report.errors[0].code, 'push-check-repo-unresolved')
})

test('boundary check and audit diagnose an unscannable configured repo', (t) => {
  const { root, policy, project } = makeWorkspace(t)
  project.repos[0].path = path.join(root, 'missing-repo')

  const checked = checkBoundaryPolicy({ project, policy, actor: 'author', staged: true, stagedOnly: true })
  assert.ok(checked.errors.some((item) => item.code === 'repo-unscannable'))

  const audited = auditContentRules({ project, policy })
  assert.ok(audited.diagnostics.some((item) => item.code === 'repo-unscannable'))
})

test('the push guard matches its repo through a symlinked path', (t) => {
  const { root, site, policy, project } = makeWorkspace(t)
  const link = path.join(root, 'site-link')
  fs.symlinkSync(site, link)
  commit(site, 'README.md', '# Site\n', 'docs')

  const report = checkPushContent({ project, policy, updates: pushUpdate(site), cwd: link })
  assert.equal(report.repo, 'example-site')
  assert.equal(report.ok, true, report.findings.map((item) => item.message).join('\n'))
})

test('the push guard works from a subdirectory of the repo', (t) => {
  const { site, policy, project } = makeWorkspace(t)
  commit(site, 'README.md', '# Site\n', 'docs')
  const report = checkPushContent({ project, policy, updates: pushUpdate(site), cwd: path.join(site, 'src/scripts') })
  assert.equal(report.repo, 'example-site')
})
