import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildCanonicalGraph } from '../../../src/graph/graph.mjs'
import { resolveProjectConfig, writeJson } from '../../../src/project/config.mjs'
import { prepareView, sha256Digest, withEligibility } from '../../../src/projection/obsidian/materialize/index.mjs'

// Builds an invented workspace in a temporary directory, reads it with the
// real canonical graph builder and prepares a full view with the real
// prepareView, so the edit lens is tested against real emitter output.

export const EXT = 'mnstry.atelier.obsidian'
export const WORKSPACE_ID = 'ws-synthetic-0003'
const clock = () => '2026-01-05T10:00:05.000Z'
const bytesOf = (file) => (file.hex ? Buffer.from(file.hex, 'hex') : Buffer.from(file.text, 'utf8'))

export function prepareWorkspace(t, { repositories, files }) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-edits-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  for (const [relative, file] of Object.entries(files)) {
    const absolute = path.join(dir, ...relative.split('/'))
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, bytesOf(file))
  }
  for (const name of repositories) fs.mkdirSync(path.join(dir, name, '.git'), { recursive: true })
  writeJson(path.join(dir, 'atelier.project.json'), {
    schema: 'mnstry.atelier-project-config@v1',
    name: 'edit-lens-fixture',
    roots: { workspace: '.', repoOps: '.' },
    graph: { repoAccessPath: 'repo-access.v1.json', outputPath: 'atelier-output/knowledge.graph.json' },
    projection: { outputRoot: 'atelier-output', readinessPath: 'atelier-output/atelier-readiness.json' },
    repos: repositories.map((name) => ({ name, path: name, readBoundary: 'team' })),
  })
  writeJson(path.join(dir, 'repo-access.v1.json'), {
    schema: 'mnstry.atelier-repo-access@v1',
    defaultReadBoundary: 'team',
    repos: Object.fromEntries(repositories.map((name) => [name, { readBoundary: 'team' }])),
  })
  const canonical = buildCanonicalGraph(resolveProjectConfig({ argv: [`--project=${path.join(dir, 'atelier.project.json')}`], cwd: dir }))
  assert.equal(canonical.ok, true, canonical.errors.join('\n'))
  const graph = withEligibility(canonical, () => true, () => true)
  const read = (repoId, relative) => fs.readFileSync(path.join(dir, repoId, ...relative.split('/')))
  const profile = {
    schema: 'atelier-obsidian-corpus-profile/v1',
    workspaceId: WORKSPACE_ID,
    repositories: repositories.map((repoId) => ({ repoId, root: `repos/${repoId}`, enrollment: 'enrolled' })),
    audience: { allow: ['team', 'private'] },
  }
  const snapshot = {
    document: {
      schema: 'atelier-obsidian-source-snapshot/v1',
      snapshotId: 'snap-0003',
      workspaceId: WORKSPACE_ID,
      capturedAt: '2026-01-05T10:00:00Z',
      readConsistency: 'single-read',
      graphPin: { graphDigest: sha256Digest(Buffer.from(JSON.stringify([graph.nodes, graph.edges]))), nodeCount: graph.nodes.length, edgeCount: graph.edges.length },
      versions: { source: '1', config: '1', emitter: '1.0.0' },
      repositories: repositories.map((repoId) => ({
        repoId, head: null, dirty: true,
        files: [...graph.nodes, ...(graph.assets ?? [])].filter((item) => item.repo === repoId).map((item) => ({ path: item.path, rawDigest: sha256Digest(read(repoId, item.path)), byteLength: read(repoId, item.path).length })),
      })),
    },
    graph,
    readSource: read,
  }
  const scope = { schema: 'atelier-obsidian-scope/v1', scopeId: 'scope-full', mode: 'full', selector: { all: true } }
  const prepared = prepareView({ snapshot, profile, scope, clock })
  // One case per Markdown or wrapper note, keyed by its source path.
  const cases = new Map()
  for (const note of prepared.manifest.notes) {
    const record = note.ext[EXT].source
    cases.set(record.path, {
      manifest: prepared.manifest,
      note,
      repoId: note.repoId,
      nodeId: note.nodeId,
      publishedNoteBytes: prepared.files.find((file) => file.path === note.path).bytes,
      baseSourceBytes: read(note.repoId, record.path),
    })
  }
  return { prepared, cases, dir }
}
