import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const cli = fileURLToPath(new URL('../bin/atelier.mjs', import.meta.url))
const workspaceId = 'sample-workspace'
const scope = { project: 'sample-project', activity: 'inventory-summary' }
const actor = { id: 'local-owner', kind: 'human' }
function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-learning-cli-'))
  execFileSync('git', ['init', '-q', root])
  fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n')
  t.after(() => fs.rmSync(root, { force: true, recursive: true }))
  return root
}
function invoke(root, command, body, status = 0) {
  const result = spawnSync(process.execPath, [cli, 'learn', command], {
    cwd: root, input: typeof body === 'string' ? body : JSON.stringify(body), encoding: 'utf8',
  })
  assert.equal(result.status, status, result.stderr || result.stdout)
  return JSON.parse(status === 0 ? result.stdout : result.stderr)
}
const observation = { id: 'observation-one', signal: 'user-correction',
  text: 'Put shortages first in the inventory summary.', interpretation: 'explicit', scope,
  source: { ref: 'manual-user-entry', digest: null } }
const lesson = { id: 'lesson-one', title: 'Lead with shortages',
  principle: 'Lead inventory summaries with shortages.', rationale: 'The first decision is what to replenish.',
  exceptions: ['A location audit can lead with storage locations.'], evidenceIds: [observation.id], scope,
  artifact: { kind: 'instruction', name: 'inventory-summary', content: 'For inventory summaries, list shortages before storage locations.' } }

test('terminal CLI carries one correction through acceptance, activation, restart and withdrawal', t => {
  const root = workspace(t)
  let revision = 0
  function write(command, input, requestId = `${command}-${revision}`) {
    const reply = invoke(root, command, { workspaceId, actor, requestId, expectedRevision: revision, input })
    revision = reply.revision
    return reply
  }
  const captured = write('capture', observation)
  assert.equal(captured.record.source.digest, null)
  const proposed = write('propose', lesson)
  const query = { scope, harnessId: 'sample-harness' }
  assert.equal(invoke(root, 'context', { workspaceId, query }).lessons.length, 0)
  const accepted = write('decide', { lessonId: lesson.id, lessonDigest: proposed.record.digest,
    verdict: 'accepted', reason: 'Fits this reporting task.' })
  assert.equal(invoke(root, 'context', { workspaceId, query }).lessons.length, 0)
  const rendered = invoke(root, 'render', { workspaceId,
    query: { lessonId: lesson.id, lessonDigest: proposed.record.digest } })
  assert.equal(rendered.artifact.content, lesson.artifact.content)
  const active = write('activate', { id: 'activation-one', lessonId: lesson.id,
    lessonDigest: proposed.record.digest, decisionId: accepted.record.id, harnessId: query.harnessId })
  // Every invocation above and below is a new process reading durable history.
  const context = invoke(root, 'context', { workspaceId, query })
  assert.equal(context.lessons[0].artifact.content, lesson.artifact.content)
  assert.equal(context.lessons[0].evidence[0].id, observation.id)
  assert.equal(invoke(root, 'context', { workspaceId, query: { ...query, harnessId: 'another-harness' } }).lessons.length, 0)
  assert.equal(invoke(root, 'context', { workspaceId, query: { ...query, scope: { ...scope, project: 'other-project' } } }).lessons.length, 0)
  const graph = invoke(root, 'graph', { workspaceId })
  assert.ok(graph.nodes.length >= 4)
  assert.ok(graph.edges.length >= 3)
  const archive = invoke(root, 'export', { workspaceId })
  assert.match(archive.schema, /learning/)
  write('withdraw', { activationId: active.record.id, reason: 'The next report needs a different order.' })
  assert.equal(invoke(root, 'context', { workspaceId, query }).lessons.length, 0)
  const state = invoke(root, 'list', { workspaceId })
  assert.equal(state.observations.length, 1)
  assert.equal(state.lessons.length, 1)
  assert.equal(state.decisions.length, 1)
  assert.equal(state.activations.length, 1)
  assert.equal(state.withdrawals.length, 1)
  assert.equal(state.revision, revision)
  assert.equal(fs.existsSync(path.join(root, 'AGENTS.md')), false)
})

test('CLI retries are idempotent and invalid identities, stale writes and extra fields refuse', t => {
  const root = workspace(t)
  const body = { workspaceId, actor, requestId: 'capture-one', expectedRevision: 0, input: observation }
  const first = invoke(root, 'capture', body)
  const again = invoke(root, 'capture', body)
  assert.equal(again.duplicate, true)
  assert.equal(again.eventId, first.eventId)
  invoke(root, 'capture', { ...body, input: { ...observation, text: 'Changed content' } }, 1)
  invoke(root, 'capture', { ...body, requestId: 'stale', input: { ...observation, id: 'other' } }, 1)
  invoke(root, 'list', { workspaceId: 'foreign-workspace' }, 1)
  invoke(root, 'list', { workspaceId, execute: true }, 1)
  assert.equal(invoke(root, 'list', { workspaceId }).revision, first.revision)
})

test('CLI bounds input and hides malformed input text from diagnostics', t => {
  const root = workspace(t)
  const marker = 'DO_NOT_ECHO_INVALID_INPUT'
  const invalid = invoke(root, 'capture', `{"${marker}`, 1)
  assert.doesNotMatch(JSON.stringify(invalid), new RegExp(marker))
  const huge = invoke(root, 'capture', ' '.repeat(256 * 1024 + 1), 1)
  assert.match(huge.error, /byte limit/)
})

test('public help distinguishes local learning from support feedback', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /learn capture/)
  assert.match(result.stdout, /feedback.*local, never-sent feedback report/)
})
