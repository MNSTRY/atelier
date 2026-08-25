// @atelier-egress-allow-test-fixture
// Release-blocking defensive mutations: each assurance family must reject a
// deliberately broken, local-only fixture. No live service or remote target is exercised.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { validateContentRules } from '../src/boundary/content-rules.mjs'
import { forbiddenEgressFindingsForText } from '../src/egress/forbidden-egress.mjs'
import { validateKnowledgeGraph } from '../src/graph/knowledge-graph.mjs'
import { loadPublishedWorkspaceManifest } from '../src/server/security.mjs'
import { makeSampleProject } from './helpers/sample-project.mjs'

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const atelierBin = path.join(packageRoot, 'bin', 'atelier.mjs')

function runAtelier(args, cwd = packageRoot, env = process.env) {
  return spawnSync(process.execPath, [atelierBin, ...args], { cwd, env, encoding: 'utf8' })
}

test('assurance mutation: an empty boundary ruleset is refused by the boundary CLI', (t) => {
  assert.match(validateContentRules([]).join('\n'), /must contain at least one rule/)
  const sample = makeSampleProject(t)
  const policyPath = path.join(sample.dir, 'boundary-policy.v1.json')
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'))
  policy.contentRules = []
  fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`)
  const result = runAtelier(['boundary', 'check', `--project=${sample.config}`, '--actor=owner'], sample.dir)
  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /contentRules.*at least one rule/)
})

test('assurance mutation: malformed graph classification is refused by the graph CLI', (t) => {
  const errors = validateKnowledgeGraph([
    {
      id: '',
      repo: 'fixture',
      path: 'broken.md',
      extension: 'md',
      classification: 'classified',
      markdownHasKgBlock: true,
      markdownHasKgId: false,
      audience: 'public',
      status: 'active',
      kgType: 'document',
      relations: {},
    },
  ], [])
  assert.match(errors.join('\n'), /missing kg\.id/)
  assert.match(errors.join('\n'), /kg\.id is required/)
  const sample = makeSampleProject(t)
  const readme = path.join(sample.dir, 'content', 'README.md')
  fs.writeFileSync(readme, fs.readFileSync(readme, 'utf8').replace('  id: "sample-workspace:readme"\n', ''))
  const result = runAtelier(['graph', `--project=${sample.config}`], sample.dir)
  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /kg\.id is required/)
})

test('assurance mutation: a non-loopback fetch is rejected by the egress scanner', () => {
  const target = 'https:' + '//example.invalid/fixture'
  const findings = forbiddenEgressFindingsForText(`fetch("${target}")`, { file: 'fixture.mjs' })
  assert.equal(findings.some((finding) => finding.type === 'non-localhost-fetch'), true)
})

test('assurance mutation: a packed test-shaped egress fixture fails release audit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-release-egress-mutation-'))
  try {
    for (const rel of [
      'scripts/check-release-tarball.mjs',
      'scripts/npm-cli.mjs',
      'scripts/structural-patterns.mjs',
      'src/egress/forbidden-egress.mjs',
    ]) {
      const target = path.join(root, rel)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(path.join(packageRoot, rel), target)
    }
    const files = {
      'README.md': 'fixture 0.2.0-alpha.4\n',
      'CHANGELOG.md': '# Changelog\n\n## 0.2.0-alpha.4\n',
      LICENSE: 'Apache-2.0\n',
      NOTICE: 'fixture\n',
      'TRADEMARKS.md': 'powered by MNSTRY Atelier\n',
      'SECURITY.md': 'fixture\n',
      'bin/atelier.mjs': 'export {}\n',
      'bin/mnstry-atelier.mjs': 'export {}\n',
      'docs/local-services.md': '# Local services\n',
      'skills/codex/atelier-local-service/SKILL.md': '# Skill\n',
      'skills/claude/atelier-local-service/SKILL.md': '# Skill\n',
      'skills/codex/atelier-public-boundary/SKILL.md': '# Skill\n',
      'skills/claude/atelier-public-boundary/SKILL.md': '# Skill\n',
      'announcements/keys/mnstry-announcements.public.v1.json': '{}\n',
      'src/test/packed.test.mjs': `// ${'@atelier-egress-allow-test-fixture'}\nawait fetch("https://example.invalid/packed")\n`,
    }
    for (const [rel, text] of Object.entries(files)) {
      const target = path.join(root, rel)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, text)
    }
    fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({
      name: '@mnstry/atelier',
      version: '0.2.0-alpha.4',
      private: false,
      type: 'module',
      license: 'Apache-2.0',
      bin: { atelier: 'bin/atelier.mjs', 'mnstry-atelier': 'bin/mnstry-atelier.mjs' },
      files: ['README.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE', 'TRADEMARKS.md', 'SECURITY.md', 'bin/', 'docs/', 'skills/', 'announcements/', 'src/'],
    }, null, 2)}\n`)
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'check-release-tarball.mjs')], {
      cwd: root,
      env: { ...process.env, ATELIER_DENYLIST_JSON: '{"patterns":[]}' },
      encoding: 'utf8',
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /packed egress finding src\/test\/packed\.test\.mjs/)
    assert.match(result.stderr, /test-fixture egress suppression marker/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('assurance mutation: a workspace without a publication manifest is not servable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-sidecar-mutation-'))
  try {
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html>')
    assert.throws(() => loadPublishedWorkspaceManifest(root), /must contain generated atelier\.manifest\.json/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('assurance mutation: a distribution without attribution fails closed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-distribution-mutation-'))
  try {
    fs.writeFileSync(path.join(root, 'README.md'), 'intentionally incomplete fixture\n')
    const result = spawnSync(process.execPath, [path.join(packageRoot, 'bin', 'atelier.mjs'), 'distribution', 'check', '--target', root], {
      cwd: packageRoot,
      encoding: 'utf8',
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /does not contain the exact byte string/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
