import assert from 'node:assert/strict'
import test from 'node:test'
import { runGraphCommand } from '../src/graph/graph.mjs'
import { runProjectCommand } from '../src/projection/project.mjs'
import { runServerCommand } from '../src/server/server.mjs'
import { makeSampleProject } from './helpers/sample-project.mjs'

test('dev smoke serves generated projection over loopback sidecar', async (t) => {
  const sample = makeSampleProject(t)
  runGraphCommand([`--project=${sample.config}`])
  runProjectCommand([`--project=${sample.config}`])
  await assert.doesNotReject(() => runServerCommand([`--project=${sample.config}`, '--smoke']))
})
