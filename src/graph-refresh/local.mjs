import { createFsWatcherFactory } from '../runtime/obsidian/watchers.mjs'
import { createGraphRefresh } from './controller.mjs'

// Attach to the existing sidecar's start/close, never to a second listener or
// daemon. Watch events are hints. Periodic rebuilds reconcile dropped events;
// the canonical builder/file cache remains the source of incremental reuse.
export function createLocalGraphRefresh({ roots, watcherFactory, reconcileMs = 30_000, ...ports } = {}) {
  if (!Array.isArray(roots) || roots.length === 0 || roots.some(root => !root ||
      typeof root.id !== 'string' || !root.id || typeof root.path !== 'string' || !root.path) ||
      new Set(roots.map(root => root.id)).size !== roots.length ||
      !Number.isSafeInteger(reconcileMs) || reconcileMs < 10 || reconcileMs > 2_147_483_647) {
    throw new TypeError('Invalid local graph refresh roots or interval')
  }
  const controller = createGraphRefresh(ports)
  let authorizedRoots = roots.map(root => ({ ...root }))
  let watcher = null
  let interval = null
  let watchState = 'stopped'
  let started = false
  let resourceEpoch = 0

  function stopResources() {
    resourceEpoch += 1
    clearInterval(interval)
    interval = null
    try { watcher?.close() } catch { /* stopped state still purges delivery */ }
    watcher = null
    watchState = 'stopped'
  }

  function startResources() {
    if (!started || watcher || interval || ['denied', 'stopped'].includes(controller.status().phase)) return
    watchState = 'watching'
    const epoch = resourceEpoch
    const onUnavailable = () => { if (started && epoch === resourceEpoch) watchState = 'unavailable' }
    const watch = watcherFactory ?? createFsWatcherFactory({ onUnavailable })
    try {
      watcher = watch({ roots: authorizedRoots, onEvent() { if (started && epoch === resourceEpoch) controller.invalidate() }, onUnavailable })
      if (!watcher || typeof watcher.close !== 'function') throw new Error('watcher unavailable')
    } catch { watchState = 'unavailable' }
    interval = setInterval(() => {
      // Reconciliation must not repeatedly cancel a healthy long build.
      if (!['building', 'pending', 'stale'].includes(controller.status().phase)) controller.invalidate()
    }, reconcileMs)
    interval.unref?.()
  }

  controller.subscribe(event => { if (event.type === 'clear') stopResources() })
  return {
    ...controller,
    start() {
      if (started) return
      started = true
      controller.start()
      startResources()
    },
    stop() {
      started = false
      stopResources()
      controller.stop()
    },
    setAccess(nextBinding, nextRoots = roots) {
      // Roots are supplied by the trusted host for this exact decision. They
      // do not establish permission. Closing old watchers prevents an event
      // from a formerly permitted root invalidating a different reader view.
      controller.invalidateAccess()
      if (!Array.isArray(nextRoots) || !nextRoots.length || nextRoots.some(root => !root ||
          typeof root.id !== 'string' || !root.id || typeof root.path !== 'string' || !root.path) ||
          new Set(nextRoots.map(root => root.id)).size !== nextRoots.length) {
        throw new TypeError('Invalid authorized refresh roots')
      }
      authorizedRoots = nextRoots.map(root => ({ ...root }))
      controller.setAccess(nextBinding)
      startResources()
    },
    status() { return { ...controller.status(), watchState } },
  }
}
