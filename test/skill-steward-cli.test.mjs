import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BIN = path.join(ROOT, 'bin', 'atelier.mjs')

function run(args, cwd = ROOT) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function tempWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-skill-cli-'))
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0)
  fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

test('skills command is discoverable and its bundled audit is clean', () => {
  const help = run(['skills', 'audit', '--help'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /Usage:\s+atelier skills/)

  const audited = run(['skills', 'audit', '--json'])
  assert.equal(audited.status, 0, audited.stderr)
  const report = JSON.parse(audited.stdout)
  assert.equal(report.ok, true)
  assert.equal(report.authority.promptCapture, false)
})

test('skills CLI records only enumerated observations and exposes thresholded candidates', (t) => {
  const root = tempWorkspace(t)
  for (const signal of ['repeated-task', 'missing-workflow', 'repeated-task']) {
    const observed = run(['skills', 'observe', '--workflow', 'weekly.release', '--signal', signal, '--outcome', 'success'], root)
    assert.equal(observed.status, 0, observed.stderr)
  }
  const candidates = run(['skills', 'candidates', '--json'], root)
  assert.equal(candidates.status, 0, candidates.stderr)
  const report = JSON.parse(candidates.stdout)
  assert.equal(report.candidates[0].kind, 'create')
  assert.equal(report.candidates[0].status, 'eligible')

  const refused = run(['skills', 'observe', '--workflow', 'weekly.release', '--signal', 'raw-note', '--prompt', 'private'], root)
  assert.equal(refused.status, 2)
  assert.match(refused.stderr, /unknown option --prompt/)
})

test('skills sync apply refuses a missing exact confirmation as a usage error', (t) => {
  const root = tempWorkspace(t)
  const result = run(['skills', 'sync', '--apply'], root)
  assert.equal(result.status, 2)
  assert.match(result.stderr, /--apply requires --confirm PLAN_DIGEST/)
})
