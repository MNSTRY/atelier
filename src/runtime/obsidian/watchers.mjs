import fs from 'node:fs'

// Filesystem watchers, as hints only.
//
//   factory({ roots: [{ id, path, recursive }], onEvent }) -> { close() }
//   onEvent({ rootId, relative })   relative is a '/'-separated path under the
//                                   root, or null for "something under it"
//
// A watcher may drop, repeat or delay events and may fail to start at all; the
// engine never depends on one. It only hashes a named file sooner than the
// next stat scan would have. Tests inject a factory they drive by hand.

export function createNullWatcherFactory() {
  return () => ({ close() {} })
}

// fs.watch, recursive where the platform supports it. It does not keep the
// process alive, and a root that cannot be watched is reported, not thrown:
// digest reconciliation still covers it.
export function createFsWatcherFactory({ watch = fs.watch, onUnavailable = () => {} } = {}) {
  return ({ roots, onEvent }) => {
    const watchers = []
    for (const root of roots) {
      try {
        const watcher = watch(root.path, { recursive: root.recursive !== false, persistent: false }, (_eventType, filename) => {
          onEvent({ rootId: root.id, relative: typeof filename === 'string' && filename !== '' ? filename.split('\\').join('/') : null })
        })
        watcher.on('error', () => onUnavailable({ rootId: root.id }))
        watchers.push(watcher)
      } catch {
        onUnavailable({ rootId: root.id })
      }
    }
    return { close() { for (const watcher of watchers.splice(0)) try { watcher.close() } catch { /* already closed */ } } }
  }
}
