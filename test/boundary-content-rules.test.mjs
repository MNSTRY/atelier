import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
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
  installBoundaryHooks,
  readBoundaryPushInput,
  resolveBoundaryAuditSource,
  validateBoundaryPolicy,
} from '../src/boundary/policy.mjs'
import {
  DEFAULT_CONTENT_RULES,
  BINARY_FILE_MAX_BYTES,
  parsePushRefInput,
  parseAddedContent,
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
