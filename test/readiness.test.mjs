import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
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

// A stale check exits the process, so the checks run through the CLI.
const atelier = fileURLToPath(new URL('../bin/atelier.mjs', import.meta.url))
const cli = (dir, ...args) => spawnSync(process.execPath, [atelier, ...args, '--project', './atelier.project.json'], { cwd: dir, encoding: 'utf8', timeout: 60000 })

test('readiness written in one checkout is fresh in another and names no checkout path', (t) => {
  const first = makeSampleProject(t)
  const second = makeSampleProject(t)
  for (const command of ['graph', 'build', 'readiness']) {
    const result = cli(first.dir, command)
    assert.equal(result.status, 0, result.stderr)
  }
  const written = fs.readFileSync(path.join(first.dir, 'atelier-output', 'atelier-readiness.json'), 'utf8')
  const readiness = JSON.parse(written)
  assert.equal(readiness.graph.path, 'atelier-output/knowledge.graph.json')
  assert.deepEqual(readiness.projection, { outputRoot: 'atelier-output', entry: 'atelier-output/index.html' })
  for (const root of new Set([first.dir, fs.realpathSync(first.dir)])) assert.ok(!written.includes(root), `readiness names ${root}`)

  fs.cpSync(path.join(first.dir, 'atelier-output'), path.join(second.dir, 'atelier-output'), { recursive: true })
  for (const args of [['readiness', '--check'], ['generated', 'check']]) {
    const result = cli(second.dir, ...args)
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`)
  }
})
