import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Shared contract corpus: one entry per validated document shape, consumed by
// test/contract-registry.test.mjs (fixture wiring for otherwise-unreferenced
// contracts) and scripts/check-contract-compat.mjs (epoch compatibility gate).
//
// Entry shape:
// - name           stable entry id (unique)
// - contractFile   repo-relative contract path
// - docPointer     optional JSON pointer fragment ('#/$defs/...') when the
//                  validated document shape is a subschema rather than the root
// - fixtureRoot    repo-relative directory containing valid/ and invalid/ subdirs
// - validFiles     explicit repo-relative valid documents (used instead of
//                  fixtureRoot when fixtures live in place next to other assets)
// - invalidFiles   explicit repo-relative invalid documents
// - registry       true when test/contract-registry.test.mjs owns positive and
//                  negative coverage for the entry (contracts with no dedicated
//                  test file); entries covered by an existing dedicated test
//                  carry registry: false and exist for the compat gate
// - loadGeneratedDocs  optional async loader returning generated documents that
//                  must also satisfy the contract (generated docs drift first)
//
// The semantic profile (contracts/mnstry-atelier-semantic-profile.v1.json) is a
// document, not a schema, and is deliberately absent.

export const CONTRACT_CORPUS = [
  {
    name: 'atelier-lock',
    contractFile: 'contracts/atelier-lock.v1.schema.json',
    fixtureRoot: 'fixtures/atelier-lock',
    registry: false,
  },
  {
    name: 'atelier-migration',
    contractFile: 'contracts/atelier-migration.v1.schema.json',
    fixtureRoot: 'fixtures/atelier-migration',
    registry: false,
  },
  {
    name: 'atelier-boundary-policy',
    contractFile: 'contracts/atelier-boundary-policy.v1.schema.json',
    fixtureRoot: 'fixtures/boundary-policy',
    registry: false,
  },
  {
    name: 'atelier-export',
    contractFile: 'contracts/atelier-export.v1.schema.json',
    validFiles: ['fixtures/atelier-export/sample-studio-offer.v1.json'],
    registry: false,
  },
  {
    name: 'atelier-kit-manifest',
    contractFile: 'contracts/atelier-kit-manifest.v1.schema.json',
    fixtureRoot: 'fixtures/atelier-kit-manifest',
    registry: false,
  },
  {
    name: 'atelier-extension-pack',
    contractFile: 'contracts/atelier-extension-pack.v1.schema.json',
    fixtureRoot: 'fixtures/readiness-protocols/extension-pack',
    registry: false,
  },
  {
    name: 'atelier-readiness-protocol',
    contractFile: 'contracts/atelier-readiness-protocol.v1.schema.json',
    fixtureRoot: 'fixtures/readiness-protocols/protocol',
    registry: false,
    loadGeneratedDocs: async () =>
      (await import('../readiness-protocols/bundled-pack.mjs')).bundledReadinessProtocols,
  },
  {
    name: 'atelier-readiness-run',
    contractFile: 'contracts/atelier-readiness-run.v1.schema.json',
    fixtureRoot: 'fixtures/readiness-protocols/run',
    registry: false,
  },
  {
    name: 'atelier-claim',
    contractFile: 'contracts/atelier-claim.v1.schema.json',
    fixtureRoot: 'fixtures/atelier-claim',
    registry: true,
  },
  {
    name: 'atelier-project-config',
    contractFile: 'contracts/atelier-project-config.v1.schema.json',
    fixtureRoot: 'fixtures/atelier-project-config',
    registry: true,
  },
  {
    name: 'atelier-readiness',
    contractFile: 'contracts/atelier-readiness.v1.schema.json',
    fixtureRoot: 'fixtures/atelier-readiness',
    registry: true,
  },
  {
    name: 'atelier-action-intent',
    contractFile: 'contracts/atelier-action-intent.v1.schema.json',
    fixtureRoot: 'fixtures/atelier-action-intent',
    registry: true,
  },
  {
    name: 'atelier-analysis-adapter',
    contractFile: 'contracts/atelier-analysis-adapter.v1.schema.json',
    fixtureRoot: 'fixtures/atelier-analysis-adapter',
    registry: true,
  },
  {
    name: 'knowledge-source-sidecar',
    contractFile: 'contracts/knowledge-source-sidecar.v1.schema.json',
    fixtureRoot: 'fixtures/knowledge-source-sidecar',
    registry: true,
  },
  {
    name: 'git-promote-event',
    contractFile: 'contracts/git-promote-event.v1.schema.json',
    validFiles: ['fixtures/git-promote/private-to-team.v1.json'],
    invalidFiles: ['fixtures/git-promote/invalid/provision-named-revocable.v1.json'],
    registry: true,
  },
  {
    name: 'analysis-adapter-manifest',
    contractFile: 'contracts/analysis-adapter.v1.schema.json',
    docPointer: '#/$defs/manifest',
    validFiles: [
      'fixtures/analysis-adapter/manifest.disabled.v1.json',
      'fixtures/analysis-adapter/manifest.enabled-local.v1.json',
    ],
    invalidFiles: ['fixtures/analysis-adapter/invalid/manifest-hidden-provider.v1.json'],
    registry: true,
  },
  {
    name: 'analysis-adapter-claim-output',
    contractFile: 'contracts/analysis-adapter.v1.schema.json',
    docPointer: '#/$defs/claimOutput',
    validFiles: ['fixtures/analysis-adapter/output.claims.v1.json'],
    invalidFiles: [
      'fixtures/analysis-adapter/invalid/output-frontmatter-mutation.v1.json',
      'fixtures/analysis-adapter/invalid/output-native-graph.v1.json',
    ],
    registry: true,
  },
]

export const CORPUS_ROOT = fileURLToPath(new URL('../..', import.meta.url))

function listJsonFiles(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => path.join(dir, name))
}

export function corpusValidFiles(entry, root = CORPUS_ROOT) {
  if (entry.validFiles) return entry.validFiles.map((file) => path.join(root, file))
  return listJsonFiles(path.join(root, entry.fixtureRoot, 'valid'))
}

export function corpusInvalidFiles(entry, root = CORPUS_ROOT) {
  if (entry.invalidFiles) return entry.invalidFiles.map((file) => path.join(root, file))
  if (!entry.fixtureRoot) return []
  return listJsonFiles(path.join(root, entry.fixtureRoot, 'invalid'))
}
