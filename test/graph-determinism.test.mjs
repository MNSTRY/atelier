import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildGraph } from '../src/graph/graph.mjs'
import { buildKnowledgeGraph, writeKnowledgeGraphs } from '../src/graph/knowledge-graph.mjs'
import { commandProject, writeJson } from '../src/project/config.mjs'

// Regression guard for the 2026-07-15 census incident: the builder walked
// git-ignored, machine-local paths into committed artifacts, so every machine
// produced different bytes on every tick and the fleet rebase-conflicted
// forever. The contract is DETERMINISTIC and MACHINE-INVARIANT:
//   1. building twice changes nothing (idempotent), and
//   2. git-ignored files on disk change nothing (machine-invariant).
// If this fails, fix the walker — do not relax the test.

const ENGINE_RANGE = { min: 22, maxExclusive: 23 }

// Each entry must be git-ignored (asserted below) so a dropped .gitignore
// pattern fails loudly instead of silently reintroducing the churn. The
// markdown and sidecar entries are the ones that actually reach the census.
const IGNORED_JUNK = [
  { rel: '.mnstry-local/adapter-state.json', content: '{"local":true}\n' },
  { rel: '.atelier-local/workspace.json', content: '{"local":true}\n' },
  { rel: 'support-bundles/bundle-1/notes.md', content: '# machine-local bundle\n' },
  { rel: 'machine-notes/scratch.md', content: '---\ntitle: "Scratch"\nkg:\n  id: "docs:scratch"\n  audience: "private"\n---\n\n# Scratch\n' },
  { rel: 'machine-notes/report.pdf.kg.json', content: '{"schema":"mnstry.source-sidecar@v1"}\n' },
  { rel: 'vendor-cache/index.html', content: '<!doctype html><title>cache</title>\n' },
]

const GITIGNORE = ['.mnstry-local/', '.atelier-local/', 'support-bundles/', 'machine-notes/', 'vendor-cache/', 'atelier-output/'].join('\n')

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
}

function writeDoc(repo, rel, id, audience = 'team') {
  const abs = path.join(repo, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, `---\ntitle: "${id}"\nkg:\n  id: "${id}"\n  type: "document"\n  status: "active"\n  audience: "${audience}"\n---\n\n# ${id}\n`)
}

function makeWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-determinism-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repo = path.join(root, 'docs')
  fs.mkdirSync(repo, { recursive: true })
  git(repo, ['init', '--quiet'])
  git(repo, ['config', 'user.email', 'builder@example.invalid'])
  git(repo, ['config', 'user.name', 'Builder'])
  fs.writeFileSync(path.join(repo, '.gitignore'), `${GITIGNORE}\n`)
  writeDoc(repo, 'README.md', 'docs:readme')
  writeDoc(repo, 'guides/setup.md', 'docs:guides-setup')
  git(repo, ['add', '.'])
  git(repo, ['commit', '--quiet', '-m', 'seed'])

  writeJson(path.join(root, 'atelier.project.json'), {
    schema: 'mnstry.atelier-project-config@v1',
    name: 'determinism-fixture',
    roots: { workspace: '.', repoOps: '.' },
    graph: { repoAccessPath: 'repo-access.v1.json', outputPath: 'atelier-output/knowledge.graph.json' },
    projection: { outputRoot: 'atelier-output', readinessPath: 'atelier-output/atelier-readiness.json' },
    repos: [{ name: 'docs', path: 'docs', readBoundary: 'team' }],
  })
  writeJson(path.join(root, 'repo-access.v1.json'), {
    schema: 'mnstry.atelier-repo-access@v1',
    defaultReadBoundary: 'team',
    repos: { docs: { readBoundary: 'team' } },
  })
  return { root, repo }
}

function plantIgnoredJunk(repo) {
  for (const junk of IGNORED_JUNK) {
    const abs = path.join(repo, junk.rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, junk.content)
    const ignored = spawnSync('git', ['-C', repo, 'check-ignore', '--quiet', junk.rel], { encoding: 'utf8' })
    assert.equal(ignored.status, 0, `${junk.rel} is no longer git-ignored — restore the .gitignore pattern or update IGNORED_JUNK`)
  }
}

function hashArtifacts(paths) {
  const hash = crypto.createHash('sha256')
  for (const abs of paths) {
    hash.update(abs)
    hash.update(fs.existsSync(abs) ? fs.readFileSync(abs) : 'MISSING')
  }
  return hash.digest('hex')
}

test('supported engine range covers the running node major', () => {
  const major = Number(process.versions.node.split('.')[0])
  assert.ok(
    major >= ENGINE_RANGE.min && major < ENGINE_RANGE.maxExclusive,
    `byte-determinism is only asserted on the kit engine range (>=${ENGINE_RANGE.min} <${ENGINE_RANGE.maxExclusive}); running ${process.versions.node}`,
  )
})

test('knowledge graph build is idempotent and invariant to git-ignored machine-local files', (t) => {
  const { root, repo } = makeWorkspace(t)
  const workspaceGraphPath = path.join(root, 'atelier-output', 'knowledge.graph.json')
  const artifacts = [path.join(repo, 'knowledge.graph.json'), workspaceGraphPath]

  const build = () => {
    const result = buildKnowledgeGraph({ workspaceRoot: root, repoRoots: [repo] })
    assert.equal(result.ok, true, result.errors.join('\n'))
    writeKnowledgeGraphs({ ...result, workspaceGraphPath })
  }

  build()
  const first = hashArtifacts(artifacts)
  build()
  assert.equal(hashArtifacts(artifacts), first, 'second build changed committed artifacts (build is not idempotent)')

  plantIgnoredJunk(repo)
  build()
  assert.equal(
    hashArtifacts(artifacts),
    first,
    'git-ignored files changed committed artifacts (census is not machine-invariant — adopters will churn)',
  )
})

test('workspace graph build ignores git-ignored machine-local files', (t) => {
  const { root, repo } = makeWorkspace(t)
  const project = commandProject({ argv: ['--project', path.join(root, 'atelier.project.json')], cwd: root, env: {} })

  const before = buildGraph(project)
  assert.deepEqual(before.errors, [])
  plantIgnoredJunk(repo)
  const after = buildGraph(project)

  assert.deepEqual(after.errors, [], 'git-ignored files must not raise graph validation errors')
  assert.deepEqual(
    after.nodes.map((node) => node.path),
    before.nodes.map((node) => node.path),
    'git-ignored files entered the graph census',
  )
})

test('an orphan sidecar in a git-ignored directory is not a workspace error', (t) => {
  const { root, repo } = makeWorkspace(t)
  const project = commandProject({ argv: ['--project', path.join(root, 'atelier.project.json')], cwd: root, env: {} })
  plantIgnoredJunk(repo)
  assert.deepEqual(buildGraph(project).errors, [])

  // The same sidecar outside an ignored path is still a real error.
  fs.writeFileSync(path.join(repo, 'report.pdf.kg.json'), '{"schema":"mnstry.source-sidecar@v1"}\n')
  assert.match(buildGraph(project).errors.join('\n'), /report\.pdf\.kg\.json: sidecar has no matching source asset/)
})
