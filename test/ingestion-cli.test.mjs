import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const cli = fileURLToPath(new URL('../bin/atelier.mjs', import.meta.url))
const workspaceId = 'sample-workspace'
const scope = { project: 'sample-project', activity: 'maintenance' }
function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-ingestion-cli-'))
  execFileSync('git', ['init', '-q', root])
  fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n')
  t.after(() => fs.rmSync(root, { force: true, recursive: true }))
  return root
}
function invoke(root, command, body, status = 0, family = 'ingest') {
  const result = spawnSync(process.execPath, [cli, family, command], {
    cwd: root, input: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body), encoding: 'utf8',
  })
  assert.equal(result.status, status, result.stderr || result.stdout)
  return JSON.parse(status === 0 ? result.stdout : result.stderr)
}
function plan(root, sources, budget = { maxInputBytes: 1048576, maxOutputBytes: 1048576, maxAttempts: 8 }) {
  return invoke(root, 'plan', { workspaceId, input: { sources, scope, purpose: 'Find maintenance evidence.', budget } })
}
const pins = plan => ({ planId: plan.planId, planDigest: plan.planDigest })

test('new processes resume a mixed selection, retrieve actual evidence and retain partial coverage', t => {
  const root = workspace(t)
  fs.writeFileSync(path.join(root, 'service.md'), 'Inspect the filter weekly.\nKeep spare belts dry.')
  fs.writeFileSync(path.join(root, 'parts.csv'), 'part,condition\nfilter,ready')
  fs.writeFileSync(path.join(root, 'scan.png'), Buffer.from([137, 80, 78, 71]))
  fs.writeFileSync(path.join(root, 'broken.json'), '{')
  const p = plan(root, [
    { id: 'service', ref: 'service.md' }, { id: 'parts', ref: 'parts.csv' },
    { id: 'scan', ref: 'scan.png' }, { id: 'missing', ref: 'missing.txt' }, { id: 'broken', ref: 'broken.json' },
  ])
  let state = invoke(root, 'run', { workspaceId, input: { ...pins(p), maxItems: 1 } })
  assert.equal(state.items.filter(i => i.status === 'complete').length, 1)
  state = invoke(root, 'run', { workspaceId, input: { ...pins(p), maxItems: 8 } })
  assert.equal(state.items.length, 5)
  assert.deepEqual(Object.fromEntries(state.items.map(i => [i.id, i.status])), {
    service: 'complete', parts: 'complete', scan: 'unsupported', missing: 'unavailable', broken: 'failed',
  })
  assert.equal(state.complete, false)
  const query = invoke(root, 'query', { workspaceId, input: { ...pins(p), query: 'filter' } })
  assert.equal(query.hits.length, 2)
  assert.equal(query.synthesized, false)
  assert.equal(query.semanticAcceptance, 'pending')
  assert.equal(query.hits.find(h => h.sourceId === 'parts').locator.value, 'row:2,column:1')
  assert.ok(query.omissions.some(o => o.sourceId === 'scan'))
  const unchanged = invoke(root, 'run', { workspaceId, input: pins(p) })
  assert.deepEqual(unchanged.usage, state.usage)
  // A changed original invalidates only its evidence, even after process restart.
  fs.writeFileSync(path.join(root, 'service.md'), 'Use the revised maintenance schedule.')
  const fresh = invoke(root, 'query', { workspaceId, input: { ...pins(p), query: 'filter' } })
  assert.deepEqual(fresh.hits.map(h => h.sourceId), ['parts'])
  assert.ok(fresh.omissions.some(o => o.sourceId === 'service' && o.status === 'stale'))
  assert.equal(fs.existsSync(path.join(root, 'atelier.project.json')), false)
})

test('retrieved evidence supports a correction, exact human decision, scoped activation and withdrawal', t => {
  const root = workspace(t)
  fs.writeFileSync(path.join(root, 'service.txt'), 'Check the filter monthly, except during winter storage.')
  const p = plan(root, [{ id: 'service', ref: 'service.txt' }])
  invoke(root, 'run', { workspaceId, input: pins(p) })
  const hit = invoke(root, 'query', { workspaceId, input: { ...pins(p), query: 'winter' } }).hits[0]
  const actor = { id: 'sample-owner', kind: 'human' }
  let revision = 0
  const write = (operation, input) => {
    const result = invoke(root, operation, { workspaceId, actor, requestId: `request-${revision}`, expectedRevision: revision, input }, 0, 'learn')
    revision = result.revision
    return result.record
  }
  const observation = write('capture', { id: 'exception-correction', signal: 'user-correction', interpretation: 'explicit', scope,
    text: 'Retain the storage exception when summarizing this maintenance note.',
    source: { ref: hit.ref, digest: `sha256:${hit.sourceDigest}`, locator: `${hit.locator.kind}:${hit.locator.value}` } })
  const lesson = write('propose', { id: 'retain-exceptions', title: 'Preserve maintenance exceptions',
    principle: 'A maintenance summary includes stated exceptions.', rationale: 'An omitted exception changes the required action.',
    exceptions: ['A quoted heading may omit detail when the full passage is shown beside it.'], evidenceIds: [observation.id], scope,
    artifact: { kind: 'instruction', name: 'maintenance-summary', content: 'Include the winter-storage exception when summarizing the filter schedule.' } })
  const decision = write('decide', { lessonId: lesson.id, lessonDigest: lesson.digest, verdict: 'accepted', reason: 'Matches the cited passage.' })
  const query = { scope, harnessId: 'sample-harness' }
  assert.equal(invoke(root, 'context', { workspaceId, query }, 0, 'learn').lessons.length, 0)
  const activation = write('activate', { id: 'maintenance-activation', lessonId: lesson.id, lessonDigest: lesson.digest, decisionId: decision.id, harnessId: query.harnessId })
  const context = invoke(root, 'context', { workspaceId, query }, 0, 'learn')
  assert.equal(context.lessons[0].evidence[0].source.digest, `sha256:${hit.sourceDigest}`)
  assert.equal(context.lessons[0].artifact.content, lesson.artifact.content)
  write('withdraw', { activationId: activation.id, reason: 'Replace this instruction after the next schedule revision.' })
  assert.equal(invoke(root, 'context', { workspaceId, query }, 0, 'learn').lessons.length, 0)
})

test('CLI refuses input overflow, invalid UTF-8, foreign envelope fields and changed plan pins', t => {
  const root = workspace(t)
  const marker = 'DO_NOT_ECHO_SOURCE'
  for (const input of [`{"${marker}`, Buffer.from([0xff]), ' '.repeat(256 * 1024 + 1), { workspaceId, input: {}, execute: true }]) {
    const report = invoke(root, 'plan', input, 1)
    assert.doesNotMatch(JSON.stringify(report), new RegExp(marker))
  }
  fs.writeFileSync(path.join(root, 'note.txt'), 'A note.')
  const p = plan(root, [{ id: 'note', ref: 'note.txt' }])
  invoke(root, 'run', { workspaceId, input: { ...pins(p), planDigest: `sha256:${'0'.repeat(64)}` } }, 1)
  invoke(root, 'status', { workspaceId: 'other-workspace', input: pins(p) }, 1)
  invoke(root, 'run', { workspaceId, input: { ...pins(p), execute: 'embedded instruction' } }, 1)
  invoke(root, 'query', { workspaceId, input: { ...pins(p), query: 'note', sourceRoot: 'elsewhere' } }, 1)
})
