import assert from 'node:assert/strict'
import test from 'node:test'
import { createGraphRefresh } from '../src/graph-refresh/controller.mjs'
import { binding, deferred, ref, validate, view } from './graph-refresh-fixtures.mjs'

function host(t, overrides = {}) {
  const refresh = createGraphRefresh({ build: async () => view(), validate, revalidate: () => true, debounceMs: 0, ...overrides })
  refresh.setAccess(binding())
  refresh.start()
  t.after(() => refresh.stop())
  return refresh
}

test('coalesces edits and publishes one complete projection without sharing mutable objects', async t => {
  let builds = 0
  const refresh = host(t, { build: () => { builds += 1; return view(builds) } })
  for (let edit = 0; edit < 20; edit += 1) refresh.invalidate()
  await refresh.flush()
  assert.equal(builds, 1)
  const delivered = await refresh.read()
  assert.equal(delivered.phase, 'current')
  assert.equal(delivered.stale, false)
  delivered.projection.nodes[0].title = 'mutated browser copy'
  assert.equal((await refresh.read()).projection.nodes[0].title, 'Shared title')
})

test('an abort-ignoring superseded build cannot commit and the latest edit is rebuilt', async t => {
  const entered = deferred(), release = deferred()
  const committed = []
  let builds = 0, oldSignal
  const refresh = host(t, {
    async build({ signal }) {
      builds += 1
      if (builds === 1) { oldSignal = signal; entered.resolve(); await release.promise }
      return view(builds)
    },
    stage({ projection }) { return { commit() { committed.push(projection.projectionDigest) }, discard() {} } },
  })
  const completion = refresh.flush()
  await entered.promise
  refresh.invalidate()
  assert.equal(oldSignal.aborted, true)
  release.resolve()
  await completion
  assert.equal(builds, 2)
  assert.deepEqual(committed, [view(2).projectionDigest])
  assert.equal((await refresh.read()).projection.projectionDigest, view(2).projectionDigest)
})

test('failed rebuild and failed save retain an authorized historical view as stale with redacted errors', async t => {
  let failure = null
  const refresh = host(t, {
    build() { if (failure === 'build') throw new Error('private source path and body'); return view(2) },
    stage() { if (failure === 'save') throw new Error('private output path'); return { commit() {}, discard() {} } },
  })
  await refresh.flush()
  for (const mode of ['build', 'save']) {
    failure = mode
    refresh.invalidate()
    await refresh.flush()
    const result = await refresh.read()
    assert.equal(result.phase, 'failed')
    assert.equal(result.stale, true)
    assert.equal(result.projection.projectionDigest, view(2).projectionDigest)
    assert.equal(result.failure, 'build-or-save-failed')
    assert.equal(JSON.stringify(result).includes('private output'), false)
  }
})

test('revocation during staging discards incomplete work and synchronously clears reader caches and selection', async t => {
  let staged = false, discarded = 0, commits = 0, cached = null
  const entered = deferred(), release = deferred()
  const refresh = host(t, {
    clear() { cached = null },
    async stage() {
      if (staged) { entered.resolve(); await release.promise }
      return { commit() { commits += 1 }, discard() { discarded += 1 } }
    },
  })
  refresh.subscribe(event => { if (event.type === 'clear') cached = null })
  await refresh.flush()
  assert.equal(await refresh.select(ref('repo-a'), view().projectionDigest), true)
  cached = (await refresh.read()).projection
  staged = true
  refresh.invalidate()
  const completion = refresh.flush()
  await entered.promise
  refresh.invalidateAccess()
  assert.equal(cached, null)
  assert.equal((await refresh.read()).selectedRef, null)
  assert.equal((await refresh.read()).projection, null)
  release.resolve()
  await completion
  assert.equal(commits, 1)
  assert.equal(discarded, 1)
  assert.equal(refresh.status().phase, 'denied')
})

test('source failure cannot keep an old private graph visible after a grant refusal', async t => {
  let permitted = true
  const refresh = host(t, { revalidate: () => permitted })
  await refresh.flush()
  assert.ok((await refresh.read()).projection)
  permitted = false
  assert.equal((await refresh.read()).projection, null)
  assert.equal((await refresh.read(view().projectionDigest)).projection, null)
  assert.equal(refresh.status().phase, 'denied')
})

test('revocation races a pending read and stale selection; no captured graph or selection escapes', async t => {
  let delay = false
  const entered = deferred(), release = deferred()
  const refresh = host(t, { async revalidate() { if (delay) { entered.resolve(); await release.promise } return true } })
  await refresh.flush()
  delay = true
  const reading = refresh.read()
  const selecting = refresh.select(ref('repo-a'), view().projectionDigest)
  await entered.promise
  refresh.invalidateAccess()
  release.resolve()
  assert.equal((await reading).projection, null)
  assert.equal(await selecting, false)
  assert.equal((await refresh.read()).selectedRef, null)
})

test('history is bounded and revalidated; principal or grant changes purge every former digest', async t => {
  let revision = 1
  const refresh = host(t, { build: () => view(revision), historyLimit: 1 })
  await refresh.flush()
  revision = 2; refresh.invalidate(); await refresh.flush()
  assert.equal((await refresh.read(view(1).projectionDigest)).historical, true)
  assert.ok(await refresh.compare(view(1).projectionDigest, view(2).projectionDigest))
  revision = 3; refresh.invalidate(); await refresh.flush()
  assert.equal((await refresh.read(view(1).projectionDigest)).projection, null)
  refresh.setAccess(binding('another-principal'))
  assert.equal((await refresh.read(view(2).projectionDigest)).projection, null)
  assert.equal(await refresh.compare(view(2).projectionDigest, view(3).projectionDigest), null)
})

test('expiry, unsupported projections and restart are truthful and cannot revive a prior view', async t => {
  let clock = 100, supported = true
  const refresh = host(t, { now: () => clock, validate: value => supported && validate(value) })
  refresh.setAccess({ key: 'short-grant', expiresAtMs: 200 })
  await refresh.flush()
  clock = 201
  assert.equal((await refresh.read()).projection, null)
  assert.equal(refresh.status().phase, 'denied')
  refresh.setAccess({ key: 'new-grant', expiresAtMs: 300 })
  supported = false
  await refresh.flush()
  assert.equal(refresh.status().phase, 'unsupported')
  assert.equal((await refresh.read()).projection, null)
  refresh.stop()
  refresh.start()
  assert.equal(refresh.status().phase, 'denied')
  supported = true
  refresh.setAccess({ key: 'after-restart', expiresAtMs: 300 })
  await refresh.flush()
  assert.equal(refresh.status().phase, 'current')
})

test('stop fences an outstanding build and no further publication occurs', async t => {
  const entered = deferred(), release = deferred()
  let commits = 0
  const refresh = host(t, {
    async build() { entered.resolve(); await release.promise; return view() },
    stage() { return { commit() { commits += 1 }, discard() {} } },
  })
  const completion = refresh.flush()
  await entered.promise
  refresh.stop()
  release.resolve()
  await completion
  assert.equal(commits, 0)
  assert.equal(refresh.status().phase, 'stopped')
  assert.equal((await refresh.read()).projection, null)
})

test('failed or asynchronous cache invalidation refuses a replacement binding', async t => {
  let fail = false
  const refresh = host(t, { clear() { if (fail) throw new Error('host cache could not clear') } })
  await refresh.flush()
  fail = true
  refresh.setAccess(binding('replacement'))
  await refresh.flush()
  assert.equal((await refresh.read()).projection, null)
  assert.equal(refresh.status().failure, 'cache-clear-failed')
  fail = false
  refresh.setAccess(binding('recovered'))
  await refresh.flush()
  assert.equal(refresh.status().phase, 'current')
  const asynchronous = createGraphRefresh({ build: () => view(), validate, revalidate: () => true, clear: async () => {} })
  t.after(() => asynchronous.stop())
  asynchronous.setAccess(binding())
  asynchronous.start()
  await asynchronous.flush()
  assert.equal(asynchronous.status().failure, 'cache-clear-failed')
  assert.equal((await asynchronous.read()).projection, null)
})

for (const retirement of ['source supersession', 'access replacement', 'stop']) {
  test(`failed staging cleanup retains host custody after ${retirement}`, async t => {
    const entered = deferred(), release = deferred(), outcomes = [], readerEvents = []
    let stageCalls = 0, commits = 0, discardCalls = 0, failCleanup = true, revision = 1
    const refresh = host(t, {
      build: () => view(revision),
      onCleanup: outcome => outcomes.push(outcome),
      async stage() {
        stageCalls += 1
        if (stageCalls === 2) {
          entered.resolve()
          await release.promise
          return {
            commit() { commits += 1 },
            discard() { discardCalls += 1; if (failCleanup) throw new Error('retired-private-stage-details') },
          }
        }
        return { commit() { commits += 1 }, discard() {} }
      },
    })
    refresh.subscribe(event => readerEvents.push(event))
    await refresh.flush()
    revision = 2
    refresh.invalidate()
    const completion = refresh.flush()
    await entered.promise
    revision = 3
    if (retirement === 'source supersession') refresh.invalidate()
    else if (retirement === 'access replacement') refresh.setAccess(binding('replacement-reader'))
    else refresh.stop()
    release.resolve()
    await completion
    assert.equal(commits, 1, 'neither retired work nor a successor publishes before cleanup is resolved')
    assert.equal(outcomes.filter(outcome => outcome.state === 'failed').length, 1)
    const [cleanup] = refresh.cleanupStatus()
    assert.equal(cleanup.state, 'failed')
    assert.equal(JSON.stringify([outcomes, refresh.cleanupStatus()]).includes('retired-private'), false)
    assert.equal(JSON.stringify(readerEvents).includes('cleanupId'), false)
    if (retirement !== 'source supersession') assert.equal((await refresh.read()).projection, null)
    if (retirement === 'stop') {
      refresh.start()
      refresh.setAccess(binding('after-restart'))
      await refresh.flush()
      assert.equal(commits, 1)
    }
    failCleanup = false
    assert.deepEqual(await Promise.all([refresh.retryCleanup(cleanup.cleanupId), refresh.retryCleanup(cleanup.cleanupId)]), [true, true])
    await refresh.flush()
    assert.equal(discardCalls, 2, 'concurrent host retries share one discard attempt')
    assert.deepEqual(refresh.cleanupStatus(), [])
    assert.equal((await refresh.read()).projection.projectionDigest, view(3).projectionDigest)
    assert.equal(commits, 2)
    assert.equal(outcomes.at(-1).state, 'resolved')
  })
}
