import { createHash } from 'node:crypto'
import path from 'node:path'
import { buildCanonicalGraph, createGraphFileCache } from '../../graph/graph.mjs'
import { markdownMetadata } from '../../graph/knowledge-graph.mjs'
import { EMITTER_VERSION, createPreparationCache, prepareView, readMarkdownLens, withEligibility } from '../../projection/obsidian/materialize/index.mjs'
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

// Fails closed twice. A document is eligible only when the census classified
// it: an unclassified one, or one that carries no classification at all, is
// withheld. An embedded asset has no audience of its own, so it is eligible
// only when at least one note that embeds it is itself eligible; a file that
// only withheld notes embed never reaches a view, a snapshot or a state
// document. `isAssetEligible(asset, { embeds, isEligibleSource })` may be
// supplied to replace the asset rule; only an exact `true` admits an asset, and
// `revision()` must change whenever either rule does.
export const DEFAULT_ELIGIBILITY = Object.freeze({
  revision: () => 'classified-documents/v2+assets-embedded-by-eligible-documents/v1',
  isEligible: (node) => node.classification === 'classified',
})

// A vault that is the person's own also shows the notes that carry no classification, when they decided so: the
// audience decision `only-you` with `unclassified: 'shown'`, which no other audience decision may carry. Those notes
// are the person's own files, in a vault only they see. One is admitted only when its bytes read as a note (the byte
// lens the emitter reads it with), so a file the emitter would refuse never stops the vault: it stays withheld, as does
// one that cannot be read. A note whose labels are unknown is never admitted: front matter Atelier could not read
// (`malformed-frontmatter`: a block scalar, a wrapped value, a flow mapping), or any top-level `kg` key that is not a
// block, may carry an audience such as `sensitive` that "only you" leaves out. Only a note with no front matter, or
// front matter that reads and has no `kg` key at all, is the person's plain note. Assets follow the documents that
// embed them, as always.
export function onlyYouEligibility({ project }) {
  const roots = new Map((project.repos ?? []).filter((repo) => !repo.external && typeof repo.path === 'string').map((repo) => [repo.name, repo.path]))
  const readsAsNote = (node) => {
    const root = roots.get(node.repo)
    if (root === undefined || node.extension !== 'md' || typeof node.path !== 'string') return false
    let bytes
    try { bytes = readFileBytes(path.join(root, ...node.path.split('/'))); readMarkdownLens(bytes) } catch { return false }
    if (node.classificationReason === 'absent-frontmatter') return true
    if (node.classificationReason !== 'missing-kg-block') return false
    const text = bytes.toString('utf8')
    const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
    if (block === null) return false
    if (/^kg[ \t]*:/m.test(block[1])) return false
    try { return !Object.hasOwn(markdownMetadata(text), 'kg') } catch { return false }
  }
  return Object.freeze({
    revision: () => 'classified-documents/v2+unclassified-notes-read-as-notes-for-only-you/v2+assets-embedded-by-eligible-documents/v1',
    isEligible: (node) => node.classification === 'classified' || (node.classification === 'unclassified' && readsAsNote(node)),
  })
}

// The eligibility a workspace's machine settings decide: the one above only for "only you" with unclassified notes
// shown, and the default, which withholds them, for every other decision and for none.
export function eligibilityFor({ machine, project }) {
  const audience = machine?.decisions?.audience
  return audience?.choice === 'only-you' && audience.unclassified === 'shown' ? onlyYouEligibility({ project }) : DEFAULT_ELIGIBILITY
}

export function assetEligibilityFor({ graph, eligibility }) {
  const eligibleSources = new Set(graph.nodes.filter((node) => eligibility.isEligible(node) === true).map((node) => node.id))
  const embeds = Array.isArray(graph.embeds) ? graph.embeds : []
  if (typeof eligibility.isAssetEligible === 'function') {
    return (asset) => eligibility.isAssetEligible(asset, { embeds: embeds.filter((embed) => embed?.asset?.id === asset.id), isEligibleSource: (id) => eligibleSources.has(id) }) === true
  }
  const embedded = new Set(embeds.filter((embed) => eligibleSources.has(embed?.source)).map((embed) => embed?.asset?.id))
  return (asset) => embedded.has(asset.id)
}

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

// `cache` (createGraphFileCache) is the engine's per-file census cache; without it every source is parsed again.
// `index` is the engine's observation index. With both, a source whose observed digest is the cached one is not
// opened: observation already decided by digest that it did not change, under the stat-hint bound observation
// documents, and a full reconciliation hashes it again. Without an index every source is read and hashed here.
export function buildGraph({ project, eligibility, cache = null, index = null }) {
  const observedDigest = cache && index ? (repoId, relative) => index.get(sourceKey(repoId, relative))?.digest ?? null : null
  const canonical = buildCanonicalGraph(project, { fileCache: cache, observedDigest })
  if (!canonical.ok) refuse('canonical-graph-invalid', 'the canonical graph has errors; no view is prepared from it', { errorCount: canonical.errors.length })
  return withEligibility(canonical, eligibility.isEligible, assetEligibilityFor({ graph: canonical, eligibility }))
}

// A source snapshot pinned to the digests observation decided on. prepareView
// reads every source it emits again and refuses with `mixed-read` when the
// bytes it gets are not the pinned ones, so an emitted note never carries a
// stale digest. A note reused from the preparation cache is not read again:
// its pinned digest is unchanged and the cached bytes are the ones that digest
// describes, so bytes that drift under an unchanged pin are not consulted
// until observation hashes the file again (the same bound as the graph stage).
export function captureSnapshot({ project, graph, workspaceId, index, configDigest, capturedAt }) {
  const roots = new Map((project.repos ?? []).filter((repo) => !repo.external).map((repo) => [repo.name, repo.path]))
  const absolute = (repoId, relative) => {
    const root = roots.get(repoId)
    if (!root) refuse('source-not-in-snapshot', 'a node names a repository the project does not enrol')
    return path.join(root, ...relative.split('/'))
  }
  const byRepo = new Map([...roots.keys()].map((repoId) => [repoId, new Map()]))
  // Every node, and every asset a view may copy. A withheld asset is never pinned: it is in no snapshot document.
  const pinned = [...graph.nodes, ...(Array.isArray(graph.assets) ? graph.assets.filter((asset) => asset.eligible === true) : [])]
  for (const item of pinned) {
    if (!byRepo.has(item.repo)) refuse('source-not-in-snapshot', 'the graph names a repository the project does not enrol')
    const observed = index.get(sourceKey(item.repo, item.path))
    const facts = observed?.digest ? observed : readFileFacts(absolute(item.repo, item.path))
    if (!facts) refuse('mixed-read', 'a file the graph read is no longer there')
    byRepo.get(item.repo).set(item.path, { path: item.path, rawDigest: facts.digest, byteLength: facts.byteLength })
  }
  const repositories = [...byRepo].sort(([left], [right]) => compareText(left, right))
    .map(([repoId, files]) => ({ repoId, head: null, dirty: true, files: [...files.values()].sort((left, right) => compareText(left.path, right.path)) }))
  // Embeds and assets are part of what was read: an embed that changes alone yields another snapshot.
  const graphDigest = sha256Digest(Buffer.from(JSON.stringify([graph.nodes, graph.edges, graph.embeds ?? [], graph.assets ?? []])))
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

// The engine keeps one graph file cache and one preparation cache per scope
// for as long as it runs, and hands them to buildGraph and prepareView on
// every tick, so a tick after a one-note change parses that source and emits
// that note and reuses the rest. Both caches are derived, in-memory state: a
// test may replace either seam with `() => null` to build or prepare in full.
export function createProductionSeams() {
  return { buildGraph, captureSnapshot, profileFor, prepareView, publishView, createRecoveryStore, recheckDisplacedFiles, createGraphCache: createGraphFileCache, createPreparationCache }
}
