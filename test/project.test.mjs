import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { runGraphCommand } from '../src/graph/graph.mjs'
import { runProjectCommand } from '../src/projection/project.mjs'
import { resolveProjectConfig, validateProjectConfigDoc } from '../src/project/config.mjs'
import { makeSampleProject } from './helpers/sample-project.mjs'

test('neutral project config resolves without adapter-specific names', (t) => {
  const sample = makeSampleProject(t)
  const doc = JSON.parse(fs.readFileSync(sample.config, 'utf8'))
  assert.deepEqual(validateProjectConfigDoc(doc, { neutralTemplate: true }), [])
  const project = resolveProjectConfig({ argv: [`--project=${sample.config}`], cwd: sample.dir })
  assert.equal(project.config.name, 'sample-workspace')
  assert.equal(project.repos[0].name, 'content')
  assert.match(project.graphPath, /atelier-output\/knowledge\.graph\.json$/)
})

test('project projection writes a readable local GUI from the graph', (t) => {
  const sample = makeSampleProject(t)
  runGraphCommand([`--project=${sample.config}`])
  runProjectCommand([`--project=${sample.config}`])
  const html = fs.readFileSync(path.join(sample.dir, 'atelier-output/index.html'), 'utf8')
  assert.match(html, /MNSTRY Atelier/)
  assert.match(html, /Sample Workspace/)
  assert.match(html, /sample-workspace:readme/)
})
