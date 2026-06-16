import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { runGraphCommand } from '../src/graph/graph.mjs'
import { runProjectCommand } from '../src/projection/project.mjs'
import { buildReadiness, runReadinessCommand } from '../src/readiness/readiness.mjs'
import { resolveProjectConfig } from '../src/project/config.mjs'
import { makeSampleProject } from './helpers/sample-project.mjs'

test('readiness reports live graph and projection state', (t) => {
  const sample = makeSampleProject(t)
  const project = resolveProjectConfig({ argv: [`--project=${sample.config}`], cwd: sample.dir })
  let readiness = buildReadiness({ project })
  assert.equal(readiness.ready, false)
  assert.ok(readiness.blockers.includes('knowledge-graph-missing-or-invalid'))

  runGraphCommand([`--project=${sample.config}`])
  runProjectCommand([`--project=${sample.config}`])
  readiness = buildReadiness({ project })
  assert.equal(readiness.ready, true)
  assert.equal(readiness.graph.nodes, 2)
  runReadinessCommand([`--project=${sample.config}`])
  assert.ok(fs.existsSync(project.readinessPath))
  assert.doesNotThrow(() => runReadinessCommand([`--project=${sample.config}`, '--check']))
})
