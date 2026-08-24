import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { buildGraph, runGraphCommand } from '../src/graph/graph.mjs'
import { resolveProjectConfig } from '../src/project/config.mjs'
import { runProjectCommand } from '../src/projection/project.mjs'
import { loadPublishedWorkspaceManifest } from '../src/server/security.mjs'
import { runServerCommand } from '../src/server/server.mjs'
import { makeSampleProject } from './helpers/sample-project.mjs'

test('dev smoke serves generated projection over loopback sidecar', async (t) => {
  const sample = makeSampleProject(t)
  runGraphCommand([`--project=${sample.config}`])
  runProjectCommand([`--project=${sample.config}`])
  await assert.doesNotReject(() => runServerCommand([`--project=${sample.config}`, '--smoke']))
})

test('generated output is excluded from graph census but enrolled and servable by the sidecar', async (t) => {
  const sample = makeSampleProject(t)
  const config = JSON.parse(fs.readFileSync(sample.config, 'utf8'))
  config.projection.outputRoot = 'content/atelier-output'
  fs.writeFileSync(sample.config, `${JSON.stringify(config, null, 2)}\n`)

  runGraphCommand([`--project=${sample.config}`])
  runProjectCommand([`--project=${sample.config}`])
  const project = resolveProjectConfig({ argv: [`--project=${sample.config}`], cwd: sample.dir })
  const rebuilt = buildGraph(project)
  assert.equal(rebuilt.nodes.some((node) => node.path.startsWith('atelier-output/')), false)

  const publication = loadPublishedWorkspaceManifest(path.join(sample.dir, 'content', 'atelier-output'))
  assert.equal(publication.paths.has('index.html'), true)
  await assert.doesNotReject(() => runServerCommand([`--project=${sample.config}`, '--smoke']))
})
