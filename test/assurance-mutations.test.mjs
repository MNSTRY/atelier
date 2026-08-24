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

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

test('assurance mutation: an empty boundary ruleset is rejected', () => {
  assert.match(validateContentRules([]).join('\n'), /must contain at least one rule/)
})

test('assurance mutation: malformed graph classification is rejected', () => {
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
})

test('assurance mutation: a non-loopback fetch is rejected by the egress scanner', () => {
  const target = 'https:' + '//example.invalid/fixture'
  const findings = forbiddenEgressFindingsForText(`fetch("${target}")`, { file: 'fixture.mjs' })
  assert.equal(findings.some((finding) => finding.type === 'non-localhost-fetch'), true)
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
