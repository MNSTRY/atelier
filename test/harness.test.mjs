import assert from 'node:assert/strict'
import test from 'node:test'
import { contextEnvelope } from '../src/harness/context.mjs'
import { resolveProjectConfig } from '../src/project/config.mjs'
import { makeSampleProject } from './helpers/sample-project.mjs'

test('harness context is advisory and refuses runtime/browser writes', (t) => {
  const sample = makeSampleProject(t)
  const project = resolveProjectConfig({ argv: [`--project=${sample.config}`], cwd: sample.dir })
  const context = contextEnvelope(project, { path: 'index.html', expectedWorkspaceId: 'atelier:sample-workspace' })
  assert.equal(context.schema, 'atelier-context@v1')
  assert.equal(context.workspaceVerified, true)
  assert.equal(context.authority.runtimeMutation, false)
  assert.equal(context.authority.browserWrites, false)
})
