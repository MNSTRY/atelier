import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { runGraphCommand } from '../src/graph/graph.mjs'
import { buildProjectProjection, runProjectCommand } from '../src/projection/project.mjs'
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
  // Default branding output: MNSTRY eyebrow, no theme override block appended.
  assert.match(html, /MNSTRY Atelier · local projection/)
  assert.equal(html.match(/:root\{/g).length, 1)
})

test('project projection applies distribution branding from ext', (t) => {
  const sample = makeSampleProject(t)
  runGraphCommand([`--project=${sample.config}`])
  const project = resolveProjectConfig({ argv: [`--project=${sample.config}`], cwd: sample.dir })
  project.config.ext = {
    'mnstry.atelier': {
      distribution: { name: 'Loomworks Studio', eyebrow: 'studio projection', theme: { accent: '#7a9e7e' } },
    },
  }
  const projection = buildProjectProjection(project)
  assert.match(projection.html, /Loomworks Studio · studio projection/)
  assert.match(projection.html, /:root\{--atelier-accent:#7a9e7e\}/)
  // Bundled pack attribution and the stable smoke hook survive rebranding.
  assert.match(projection.html, /MNSTRY Tenant Readiness/)
  assert.match(projection.html, /<meta name="mnstry:atelier" content="project-projection">/)
})

test('project projection rejects non-hex distribution theme values', (t) => {
  const sample = makeSampleProject(t)
  runGraphCommand([`--project=${sample.config}`])
  const project = resolveProjectConfig({ argv: [`--project=${sample.config}`], cwd: sample.dir })
  project.config.ext = {
    'mnstry.atelier': {
      distribution: { theme: { accent: 'red;}</style>' } },
    },
  }
  assert.throws(() => buildProjectProjection(project), /distribution theme values must be hex colors/)
})
