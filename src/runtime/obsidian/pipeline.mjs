import { createHash } from 'node:crypto'
import path from 'node:path'
import { buildCanonicalGraph } from '../../graph/graph.mjs'
import { EMITTER_VERSION, prepareView, withEligibility } from '../../projection/obsidian/materialize/index.mjs'
import { publishView } from '../../projection/obsidian/publication/publisher.mjs'
import { recheckDisplacedFiles } from '../../projection/obsidian/recovery/late-writer.mjs'
import { createRecoveryStore, readFileBytes } from '../../projection/obsidian/recovery/store.mjs'
import { compareText } from './documents.mjs'
import { refuse } from './errors.mjs'
import { readFileFacts, sha256Digest, sourceKey } from './observation.mjs'

// The production seams between the engine and the projection modules:
//
//   canonical graph -> source snapshot -> prepareView -> publishView
//
// The engine receives these as one object and tests replace single members.
// Nothing here talks to a network, and nothing here asks git anything; the
// canonical graph builder reads local ignore rules through the local git
// executable and that is all.

// An unclassified document has no declared audience; it is never eligible.
export const DEFAULT_ELIGIBILITY = Object.freeze({
  revision: () => 'classified-documents/v1',
  isEligible: (node) => node.classification !== 'unclassified',
})

const posix = (value) => value.split(path.sep).join('/')

// The corpus profile of a loaded project. Repository roots are recorded
// relative to the workspace root, since a profile is a portable shape; a
// repository kept elsewhere on this machine is recorded by name only.
export function profileFor({ project, workspaceId, audienceAllow }) {
  const repositories = (project.repos ?? []).filter((repo) => !repo.external && typeof repo.path === 'string').map((repo) => {
    const relative = posix(path.relative(project.workspaceRoot, repo.path))
    const inside = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
    return { repoId: repo.name, root: relative === '' ? '.' : inside ? relative : `elsewhere/${repo.name}`, enrollment: 'enrolled' }
  })
  return { schema: 'atelier-obsidian-corpus-profile/v1', workspaceId, repositories, audience: { allow: [...audienceAllow] } }
}

export function buildGraph({ project, eligibility }) {
  const canonical = buildCanonicalGraph(project)
  if (!canonical.ok) refuse('canonical-graph-invalid', 'the canonical graph has errors; no view is prepared from it', { errorCount: canonical.errors.length })
  return withEligibility(canonical, eligibility.isEligible)
}

// A source snapshot pinned to the digests observation decided on. prepareView
// reads every source again and refuses with `mixed-read` when the bytes it
// gets are not the pinned ones, so a file that changed after observation can
// never be emitted under a stale digest.
export function captureSnapshot({ project, graph, workspaceId, index, configDigest, capturedAt }) {
  const roots = new Map((project.repos ?? []).filter((repo) => !repo.external).map((repo) => [repo.name, repo.path]))
  const absolute = (repoId, relative) => {
    const root = roots.get(repoId)
    if (!root) refuse('source-not-in-snapshot', 'a node names a repository the project does not enrol')
    return path.join(root, ...relative.split('/'))
  }
  const byRepo = new Map([...roots.keys()].map((repoId) => [repoId, []]))
  for (const node of graph.nodes) {
    if (!byRepo.has(node.repo)) refuse('source-not-in-snapshot', 'a node names a repository the project does not enrol')
    const file = absolute(node.repo, node.path)
    const observed = index.get(sourceKey(node.repo, node.path))
    const facts = observed?.digest ? observed : readFileFacts(file)
    if (!facts) refuse('mixed-read', 'a source the graph read is no longer there')
    byRepo.get(node.repo).push({ path: node.path, rawDigest: facts.digest, byteLength: facts.byteLength })
  }
  const repositories = [...byRepo].sort(([left], [right]) => compareText(left, right))
    .map(([repoId, files]) => ({ repoId, head: null, dirty: true, files: files.sort((left, right) => compareText(left.path, right.path)) }))
  const graphDigest = sha256Digest(Buffer.from(JSON.stringify([graph.nodes, graph.edges])))
  const identity = createHash('sha256').update(JSON.stringify([workspaceId, graphDigest, configDigest, repositories])).digest('hex').slice(0, 32)
  return {
    document: {
      schema: 'atelier-obsidian-source-snapshot/v1',
      contractVersion: '1.0.0',
      snapshotId: `snap-${identity}`,
      workspaceId,
      capturedAt,
      readConsistency: 'single-read',
      graphPin: { graphDigest, nodeCount: graph.nodes.length, edgeCount: graph.edges.length },
      versions: { source: '1', config: configDigest.slice('sha256:'.length, 'sha256:'.length + 16), emitter: EMITTER_VERSION },
      repositories,
    },
    graph,
    readSource: (repoId, relative) => readFileBytes(absolute(repoId, relative)),
  }
}

export function createProductionSeams() {
  return { buildGraph, captureSnapshot, profileFor, prepareView, publishView, createRecoveryStore, recheckDisplacedFiles }
}
