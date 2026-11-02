import { canonicalize } from '../attestation/jcs.mjs'
import { compareGraphSnapshots } from './compare.mjs'

const clone = value => value === null ? null : JSON.parse(canonicalize(value))
const validBinding = (binding, now) => binding && typeof binding.key === 'string' && binding.key.length > 0 &&
  Number.isSafeInteger(binding.expiresAtMs) && binding.expiresAtMs > now
const qualifiedKey = ref => ref && typeof ref.repoId === 'string' && ref.repoId &&
  typeof ref.localId === 'string' && ref.localId ? canonicalize([ref.repoId, ref.localId]) : null

// One foreground host owns this controller. Binding and revalidate are trusted
// host ports, never browser-supplied grants. Builds compute in isolation; only
// the synchronous commit below may replace the published projection.
export function createGraphRefresh({
  build, validate, revalidate, stage = () => ({ commit() {}, discard() {} }),
  clear = () => {}, debounceMs = 40, historyLimit = 3, now = Date.now,
} = {}) {
  for (const port of [build, validate, revalidate, stage, clear]) {
    if (typeof port !== 'function') throw new TypeError('Graph refresh requires host ports')
  }
  if (!Number.isSafeInteger(debounceMs) || debounceMs < 0 || debounceMs > 60_000 ||
      !Number.isSafeInteger(historyLimit) || historyLimit < 0 || historyLimit > 20) {
    throw new TypeError('Invalid graph refresh bounds')
  }
  let running = false
  let generation = 0
  let binding = null
  let current = null
  let history = []
  let selectedRef = null
  let phase = 'stopped'
  let failure = null
  let pending = false
  let timer = null
  let expiryTimer = null
  let job = null
  let active = null
  const listeners = new Set()

  function status() {
    expire()
    return { phase, generation, stale: current !== null && current.generation !== generation, failure }
  }

  function emit(type) {
    const event = { type, phase, generation, stale: current !== null && current.generation !== generation, failure }
    // Events contain no private refs, diagnostics or former projection digests.
    for (const listener of [...listeners]) {
      try { listener(Object.freeze({ ...event })) } catch { /* one consumer cannot block another's invalidation */ }
    }
  }

  function purge(nextPhase) {
    generation += 1
    active?.abort()
    clearTimeout(timer)
    clearTimeout(expiryTimer)
    timer = expiryTimer = null
    pending = false
    binding = null
    current = selectedRef = null
    history = []
    phase = nextPhase
    failure = null
    try {
      const result = clear()
      if (result && typeof result.then === 'function') {
        result.catch?.(() => {})
        throw new Error('cache clear must be synchronous')
      }
    } catch { failure = 'cache-clear-failed' }
    emit('clear')
  }

  function expire() {
    if (binding && !validBinding(binding, now())) purge(running ? 'denied' : 'stopped')
  }

  function armExpiry() {
    clearTimeout(expiryTimer)
    if (!binding) return
    // Re-arm long grants; node timers use a signed 32-bit delay.
    expiryTimer = setTimeout(() => { expire(); if (binding) armExpiry() }, Math.min(2_147_483_647, Math.max(1, binding.expiresAtMs - now())))
    expiryTimer.unref?.()
  }

  function eligible(expectedGeneration, expectedBinding) {
    expire()
    return running && generation === expectedGeneration && binding === expectedBinding && validBinding(binding, now())
  }

  async function permitted(expectedBinding, projection) {
    try { return (await revalidate(expectedBinding, clone(projection))) === true } catch { return false }
  }

  async function runBuild() {
    const expectedGeneration = generation
    const expectedBinding = binding
    const controller = new AbortController()
    active = controller
    let transaction = null
    let committed = false
    try {
      if (!eligible(expectedGeneration, expectedBinding)) return
      phase = 'building'
      failure = null
      emit('state')
      if (!(await permitted(expectedBinding, null))) {
        if (eligible(expectedGeneration, expectedBinding)) purge('denied')
        return
      }
      if (!eligible(expectedGeneration, expectedBinding)) return
      const built = await build({ generation: expectedGeneration, binding: expectedBinding, signal: controller.signal })
      if (!eligible(expectedGeneration, expectedBinding)) return
      const projection = clone(built)
      if ((await validate(projection)) !== true) throw new Error('unsupported')
      if (!eligible(expectedGeneration, expectedBinding)) return
      if (!(await permitted(expectedBinding, projection))) {
        if (eligible(expectedGeneration, expectedBinding)) purge('denied')
        return
      }
      if (!eligible(expectedGeneration, expectedBinding)) return
      transaction = await stage({ projection: clone(projection), generation: expectedGeneration, signal: controller.signal })
      if (!transaction || typeof transaction.commit !== 'function' || typeof transaction.discard !== 'function') {
        throw new Error('stage-failed')
      }
      if (!eligible(expectedGeneration, expectedBinding)) return
      if (!(await permitted(expectedBinding, projection))) {
        if (eligible(expectedGeneration, expectedBinding)) purge('denied')
        return
      }
      if (!eligible(expectedGeneration, expectedBinding)) return
      // No await between the final fence, host commit, and pointer replacement.
      // Commit is a synchronous atomic host operation; asynchronous writes are
      // unsupported because they cannot be fenced by this controller.
      const result = transaction.commit()
      if (result && typeof result.then === 'function') {
        result.catch?.(() => {})
        throw new Error('commit-must-be-synchronous')
      }
      if (!eligible(expectedGeneration, expectedBinding)) return
      committed = true
      if (current && current.projection.projectionDigest !== projection.projectionDigest) {
        history = [current, ...history.filter(entry => entry.projection.projectionDigest !== current.projection.projectionDigest)].slice(0, historyLimit)
      }
      current = { projection, generation: expectedGeneration }
      if (selectedRef && !projection.nodes.some(node => qualifiedKey(node.ref) === qualifiedKey(selectedRef))) selectedRef = null
      phase = 'current'
      failure = null
      emit('publish')
    } catch (error) {
      if (eligible(expectedGeneration, expectedBinding)) {
        phase = error?.message === 'unsupported' ? 'unsupported' : 'failed'
        // Arbitrary build errors may contain paths or private source content.
        failure = phase === 'unsupported' ? 'projection-unsupported' : 'build-or-save-failed'
        emit('state')
      }
    } finally {
      if (!committed && transaction && typeof transaction.discard === 'function') {
        try { await transaction.discard() } catch {
          if (eligible(expectedGeneration, expectedBinding)) { phase = 'failed'; failure = 'stage-cleanup-failed'; emit('state') }
        }
      }
      if (active === controller) active = null
    }
  }

  function launch() {
    clearTimeout(timer)
    timer = null
    expire()
    if (!running || !binding || job || !pending) return
    pending = false
    // One build/stage at a time: an abort-ignoring builder cannot create an
    // unbounded queue of writers. Its return is still fenced by generation.
    job = runBuild().finally(() => {
      job = null
      if (pending && running && binding) schedule()
    })
  }

  function schedule() {
    if (!timer) timer = setTimeout(launch, debounceMs)
  }

  function invalidate() {
    expire()
    if (!running || !binding) return
    generation += 1
    active?.abort()
    pending = true
    failure = null
    phase = current ? 'stale' : 'pending'
    emit('invalidate')
    // A fixed coalescing window avoids starvation under continuous edits.
    schedule()
  }

  async function read(digest = null) {
    expire()
    const expectedBinding = binding
    if (!running || !expectedBinding) return { ...status(), projection: null, selectedRef: null, historical: false }
    const entry = digest === null ? current : [current, ...history].find(item => item?.projection.projectionDigest === digest)
    if (!entry) return { ...status(), projection: null, selectedRef: null, historical: false }
    const allowed = await permitted(expectedBinding, entry.projection)
    expire()
    if (binding !== expectedBinding || !running) return { ...status(), projection: null, selectedRef: null, historical: false }
    if (!allowed) {
      purge('denied')
      return { ...status(), projection: null, selectedRef: null, historical: false }
    }
    // A source-only edit may happen while access is checked: label that view
    // stale. Access changes and stop purge the captured entry altogether.
    return { ...status(), stale: entry.generation !== generation, projection: clone(entry.projection), selectedRef: entry === current ? clone(selectedRef) : null, historical: entry !== current }
  }

  return {
    start() {
      if (running) return
      running = true
      phase = binding ? 'pending' : 'denied'
      invalidate()
    },
    stop() {
      running = false
      purge('stopped')
    },
    // Call only with a trusted host binding whose key binds principal, exact
    // repository set, grant revision/expiry, policy and filter. Every call
    // clears history, selection, and caches before accepting a replacement.
    setAccess(nextBinding) {
      purge(running ? 'denied' : 'stopped')
      if (failure || !validBinding(nextBinding, now())) return
      binding = Object.freeze({ ...nextBinding })
      armExpiry()
      if (running) invalidate()
    },
    invalidateAccess() { purge(running ? 'denied' : 'stopped') },
    invalidate,
    read,
    status,
    async select(ref, digest) {
      const result = await read()
      if (!result.projection || result.generation !== generation || result.stale || digest !== current?.projection.projectionDigest ||
          digest !== result.projection.projectionDigest ||
          !qualifiedKey(ref) || !result.projection.nodes.some(node => qualifiedKey(node.ref) === qualifiedKey(ref))) return false
      selectedRef = clone(ref)
      return true
    },
    async compare(beforeDigest, afterDigest) {
      const expectedBinding = binding
      const expectedGeneration = generation
      const before = await read(beforeDigest)
      const after = await read(afterDigest)
      if (!expectedBinding || binding !== expectedBinding || expectedGeneration !== generation || !before.projection || !after.projection) return null
      return compareGraphSnapshots(before.projection, after.projection)
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Refresh listener must be a function')
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async flush() {
      clearTimeout(timer)
      timer = null
      while (running && (job || pending)) {
        if (!job) launch()
        if (job) await job
        else break
      }
      return status()
    },
  }
}
