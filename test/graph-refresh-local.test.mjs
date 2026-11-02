import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createLocalGraphRefresh } from '../src/graph-refresh/local.mjs'
import { binding, deferred, validate, view } from './graph-refresh-fixtures.mjs'

async function deadline(promise, milliseconds) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('refresh event deadline')), milliseconds) })])
  } finally { clearTimeout(timer) }
}

test('real local file edit, stop and restart reuse a single watcher and publish the new source', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-refresh-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'note.md')
  fs.writeFileSync(file, '1')
  const refresh = createLocalGraphRefresh({
    roots: [{ id: 'repo-a', path: root }],
    build: () => view(Number(fs.readFileSync(file, 'utf8'))), validate, revalidate: () => true,
    debounceMs: 0, reconcileMs: 40,
  })
  t.after(() => refresh.stop())
  refresh.setAccess(binding())
  refresh.start()
  refresh.start()
  await refresh.flush()
  const edited = deferred()
  const unsubscribe = refresh.subscribe(event => { if (event.type === 'invalidate') edited.resolve() })
  fs.writeFileSync(file, '2')
  await deadline(edited.promise, 5_000)
  unsubscribe()
  await refresh.flush()
  assert.equal((await refresh.read()).projection.projectionDigest, view(2).projectionDigest)
  refresh.stop()
  fs.writeFileSync(file, '3')
  assert.equal(refresh.status().watchState, 'stopped')
  refresh.start()
  assert.equal((await refresh.read()).projection, null)
  refresh.setAccess(binding('fresh-host-revalidation'))
  await refresh.flush()
  assert.equal((await refresh.read()).projection.projectionDigest, view(3).projectionDigest)
})

test('unavailable watcher is visible and periodic reconciliation still updates source', async t => {
  let revision = 1
  const refresh = createLocalGraphRefresh({
    roots: [{ id: 'repo-a', path: os.tmpdir() }],
    watcherFactory() { throw new Error('watch unavailable') },
    build: () => view(revision), validate, revalidate: () => true, debounceMs: 0, reconcileMs: 10,
  })
  t.after(() => refresh.stop())
  refresh.setAccess(binding())
  refresh.start()
  await refresh.flush()
  assert.equal(refresh.status().watchState, 'unavailable')
  const published = deferred()
  revision = 2
  refresh.subscribe(event => { if (event.type === 'publish') published.resolve() })
  await deadline(published.promise, 1_000)
  assert.equal((await refresh.read()).projection.projectionDigest, view(2).projectionDigest)
})

test('grant loss closes old watches and delayed denied-root events cannot affect replacement reader', async t => {
  const callbacks = [], watched = []
  let closed = 0
  const rootA = { id: 'repo-a', path: os.tmpdir() }, rootB = { id: 'repo-b', path: os.tmpdir() }
  const refresh = createLocalGraphRefresh({
    roots: [rootA],
    watcherFactory({ roots, onEvent }) { callbacks.push(onEvent); watched.push(roots.map(root => root.id)); return { close() { closed += 1 } } },
    build: () => view(), validate, revalidate: () => true, debounceMs: 0,
  })
  t.after(() => refresh.stop())
  refresh.setAccess(binding())
  refresh.start()
  await refresh.flush()
  refresh.invalidateAccess()
  assert.equal(closed, 1)
  assert.equal(refresh.status().watchState, 'stopped')
  refresh.setAccess(binding('reader-b'), [rootB])
  await refresh.flush()
  const generation = refresh.status().generation
  callbacks[0]({ rootId: 'repo-a', relative: 'private-edit.md' })
  assert.equal(refresh.status().generation, generation)
  assert.deepEqual(watched, [['repo-a'], ['repo-b']])
})
