import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { buildGraph, runGraphCommand } from '../src/graph/graph.mjs'
import { resolveProjectConfig } from '../src/project/config.mjs'
import { makeSampleProject } from './helpers/sample-project.mjs'

test('knowledge graph builds with stable Markdown and sidecar identities', (t) => {
  const sample = makeSampleProject(t)
  const project = resolveProjectConfig({ argv: [`--project=${sample.config}`], cwd: sample.dir })
  const graph = buildGraph(project)
  assert.deepEqual(graph.errors, [])
  assert.equal(graph.counts.nodes, 2)
  assert.equal(graph.counts.edges, 1)
  assert.ok(graph.nodes.some((node) => node.id === 'sample-workspace:readme'))
  assert.ok(graph.nodes.some((node) => node.id === 'sample-workspace:source-html'))

  fs.renameSync(path.join(sample.dir, 'content/source.html'), path.join(sample.dir, 'content/source-renamed.html'))
  fs.renameSync(path.join(sample.dir, 'content/source.html.kg.json'), path.join(sample.dir, 'content/source-renamed.html.kg.json'))
  const sidecar = path.join(sample.dir, 'content/source-renamed.html.kg.json')
  const meta = JSON.parse(fs.readFileSync(sidecar, 'utf8'))
  meta.asset = 'source-renamed.html'
  fs.writeFileSync(sidecar, `${JSON.stringify(meta, null, 2)}\n`)
  const moved = buildGraph(project)
  assert.deepEqual(moved.errors, [])
  assert.ok(moved.nodes.some((node) => node.id === 'sample-workspace:source-html' && node.path === 'source-renamed.html'))
})

test('graph validation fails closed for missing id, legacy visibility, missing sidecar, and orphan sidecar', (t) => {
  const sample = makeSampleProject(t)
  const readme = path.join(sample.dir, 'content/README.md')
  fs.writeFileSync(readme, fs.readFileSync(readme, 'utf8').replace('  id: "sample-workspace:readme"\n', ''))
  let project = resolveProjectConfig({ argv: [`--project=${sample.config}`], cwd: sample.dir })
  assert.match(buildGraph(project).errors.join('\n'), /kg\.id is required/)

  fs.writeFileSync(readme, fs.readFileSync(readme, 'utf8').replace('  audience: "private"\n', '  visibility: "private"\n'))
  assert.match(buildGraph(project).errors.join('\n'), /kg\.audience is required|kg\.visibility is invalid/)

  const sample2 = makeSampleProject(t)
  fs.rmSync(path.join(sample2.dir, 'content/source.html.kg.json'))
  project = resolveProjectConfig({ argv: [`--project=${sample2.config}`], cwd: sample2.dir })
  assert.match(buildGraph(project).errors.join('\n'), /non-Markdown source requires sidecar/)

  const sample3 = makeSampleProject(t)
  fs.writeFileSync(path.join(sample3.dir, 'content/orphan.html.kg.json'), '{}\n')
  project = resolveProjectConfig({ argv: [`--project=${sample3.config}`], cwd: sample3.dir })
  assert.match(buildGraph(project).errors.join('\n'), /sidecar has no matching source asset/)
})

test('graph check mode is deterministic after generation', (t) => {
  const sample = makeSampleProject(t)
  runGraphCommand([`--project=${sample.config}`])
  assert.doesNotThrow(() => runGraphCommand([`--project=${sample.config}`, '--check']))
})
