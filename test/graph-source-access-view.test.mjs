import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createGraphAccess, digestAccessCandidate } from '../src/graph-access/index.mjs'
import { adaptRepositoryContribution } from '../src/graph-access/source-adapter.mjs'
import { buildRepositoryContribution, validateRepositoryContribution } from '../src/graph/repo-contribution.mjs'
import { digestJson } from '../src/graph-view/contracts.mjs'
import { createGraphViewReader, parseGraphView } from '../src/graph-view/index.mjs'

test('source, access and view preserve cited bytes and refuse stale or revoked delivery', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-source-view-'))
  try {
    const git = args => execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    git(['init', '-q'])
    git(['config', 'user.name', 'Synthetic Fixture'])
    git(['config', 'user.email', 'synthetic@example.test'])

    const note = (id, title, body) => [
      '---',
      'title: ' + title,
      'summary: Synthetic source summary.',
      'kg:',
      '  id: ' + id,
      '  type: document',
      '  status: active',
      '  audience: private',
      '---',
      body,
      '',
    ].join('\n')
    fs.writeFileSync(path.join(root, 'a.md'), note('synthetic:a', 'First source', '[second](b.md)\nSYNTHETIC_BODY_SENTINEL'))
    fs.writeFileSync(path.join(root, 'b.md'), note('synthetic:b', 'Second source', 'A synthetic body.'))
    git(['add', '.'])
    git(['commit', '-q', '-m', 'Synthetic source fixture'])

    const source = () => buildRepositoryContribution({
      name: 'synthetic-source',
      path: root,
      identity: { provider: 'github', id: '900000001' },
    })
    let native = source()
    let current = true
    assert.equal(validateRepositoryContribution(native).ok, true)

    const normalized = () => adaptRepositoryContribution(native, { ownerRef: 'synthetic-owner' })

    const now = () => Date.parse('2030-01-01T00:00:00Z')
    const access = createGraphAccess({
      resolveAccess: async (_, options) => ({
        principalRef: 'synthetic-only',
        proofRef: 'synthetic-proof',
        grantRevision: 'synthetic-g1',
        policyRevision: 'synthetic-p1',
        expiresAt: Date.parse('2031-01-01T00:00:00Z'),
        operation: options.operation,
        repositories: [{
          repoId: native.repository.repoId,
          ownerRef: 'synthetic-owner',
          scope: native.snapshot.scope,
          head: native.snapshot.head,
          tree: native.snapshot.tree,
          snapshotDigest: native.snapshot.digest,
          contributionDigest: digestAccessCandidate(normalized()),
        }],
      }),
      loadContribution: async () => normalized(),
      verifyContribution: async () => validateRepositoryContribution(native).ok,
      evaluateEdge: async edge => edge.family !== 'hyperlink' || edge.predicate !== 'links_to' ? { eligible: false } : ({
        edgeId: edge.edgeId,
        source: edge.source,
        target: edge.target,
        predicate: edge.predicate,
        family: edge.family,
        acceptanceState: 'active',
        eligible: true,
        assurance: 'navigation',
        qualifications: [],
        supportRefs: edge.supportRefs,
        sourceRef: edge.supportRefs[0],
        reviewRefs: [],
        recordDigest: digestJson(edge),
        policyDigest: digestJson({ policy: 'synthetic-only' }),
      }),
      revalidate: async () => current,
    }, { now })
    const reader = createGraphViewReader({
      loadAuthorizedGraph: options => access.loadAuthorizedGraph({ synthetic: true }, options),
      revalidate: binding => access.revalidate(binding),
      now,
    })

    const bytes = await reader.exportGraphView()
    const view = parseGraphView(bytes)
    assert.equal(view.nodes.length, 2)
    assert.equal(view.edges.length, 1)
    assert.equal(view.evidence.length, 1)
    assert.equal(view.evidence[0].sourceRef.locator.rangeDigest, native.ordinaryLinks[0].provenance.locator.rangeDigest)
    assert.doesNotMatch(bytes, /SYNTHETIC_BODY_SENTINEL|principalRef|cacheKey|bindingId/)

    fs.appendFileSync(path.join(root, 'a.md'), 'Changed body observation.\n')
    native = source()
    assert.equal(native.snapshot.dirty, true)
    await assert.rejects(reader.readGraphView({ snapshot: view.snapshot }), error => error.code === 'stale_source')

    current = false
    await assert.rejects(reader.exportGraphView(), error => error.code === 'policy_refusal')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
