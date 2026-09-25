import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
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

// Regression: a busy port reached the person as "[internal-error] command
// failed without a safe diagnostic", hiding the one message that says what to
// do. Spawned through the CLI so the assertion is on what the person reads.
test('dev on a busy port names the port and the --port remedy without ATELIER_DEBUG', async (t) => {
  const sample = makeSampleProject(t)
  runGraphCommand([`--project=${sample.config}`])
  runProjectCommand([`--project=${sample.config}`])

  const blocker = net.createServer()
  await new Promise((resolve, reject) => {
    blocker.once('error', reject)
    blocker.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((resolve) => blocker.close(resolve)))
  const busy = blocker.address().port

  const bin = fileURLToPath(new URL('../bin/mnstry-atelier.mjs', import.meta.url))
  const { ATELIER_DEBUG, PORT, ...env } = process.env
  // The reported case passed no --port; a supervisor's PORT takes that path.
  for (const [label, flags, extraEnv] of [
    ['PORT', [], { PORT: String(busy) }],
    ['--port', [`--port=${busy}`], {}],
  ]) {
    const result = spawnSync(process.execPath, [bin, 'dev', '--project', sample.config, ...flags], {
      cwd: sample.dir,
      env: { ...env, ...extraEnv },
      encoding: 'utf8',
      timeout: 60000,
    })
    assert.equal(result.status, 2, `${label}: ${result.stderr}`)
    assert.match(result.stderr, new RegExp(`^\\[port-in-use\\] port ${busy} is already in use$`, 'm'), label)
    assert.match(result.stderr, /^Next: Pass --port=<free port> to choose another\.$/m, label)
    assert.doesNotMatch(result.stderr, /internal-error|ATELIER_DEBUG/, label)
    assert.doesNotMatch(result.stderr, /\n\s+at /, label)
    assert.doesNotMatch(result.stdout, /listening on/, label)
  }
})

test('dev refuses an unusable port by naming the flag or variable it came from', (t) => {
  const sample = makeSampleProject(t)
  const bin = fileURLToPath(new URL('../bin/mnstry-atelier.mjs', import.meta.url))
  const { ATELIER_DEBUG, PORT, ...env } = process.env
  for (const [flags, extraEnv, expected] of [
    [['--port=abc'], {}, /^\[port-invalid\] --port must be a whole number from 0 to 65535, got "abc"$/m],
    [['--port=70000'], {}, /^\[port-invalid\] --port must be a whole number from 0 to 65535, got "70000"$/m],
    [[], { PORT: 'abc' }, /^\[port-invalid\] PORT must be a whole number from 0 to 65535, got "abc"$/m],
  ]) {
    const result = spawnSync(process.execPath, [bin, 'dev', '--project', sample.config, ...flags], {
      cwd: sample.dir,
      env: { ...env, ...extraEnv },
      encoding: 'utf8',
      timeout: 60000,
    })
    assert.equal(result.status, 2, result.stderr)
    assert.match(result.stderr, expected)
    assert.match(result.stderr, /^Next: .*--port=/m)
    assert.doesNotMatch(result.stderr, /ERR_SOCKET_BAD_PORT|\n\s+at /)
  }
})
