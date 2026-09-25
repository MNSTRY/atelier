import fs from 'node:fs'
import path from 'node:path'
import { readRegularTextNoFollow } from '../../project/private-state.mjs'
import { OBSIDIAN_EXT_KEY } from '../../projection/obsidian/contracts.mjs'
import { sha256Digest } from '../../projection/obsidian/materialize/byte-lens.mjs'
import { readFileBytes, readFileDigest } from '../../projection/obsidian/recovery/store.mjs'
import { viewVaultRoot } from './plugin-choice.mjs'

// Whether the plugin files a view's committed generation pins are on disk as
// pinned. A person may remove one, change one, or repair a path Atelier had to
// leave (a folder where a file goes, say). The publisher then publishes the
// same generation again (publisher.mjs), but only when the view is prepared
// again, which nothing else asks for while its sources are unchanged.
//
// `observe(scopeIds)` looks at each view once per tick and returns the views
// to prepare again: those whose files differ from their pins and look
// different from the last look. A drift Atelier leaves for the person (a link
// where a file goes) is asked about once, not at every tick; a change to it is
// asked about again. Where the plugin is turned off in the vault, a pinned
// file that is gone is no drift: the publisher never makes one again.

const segment = (identifier) => identifier.replaceAll(':', '_')
const TURNED_OFF = 'turned-off-in-this-vault'

// The plugin record of the view's committed manifest, read as the store reads
// it: the pointer names the manifest and its digest. Null when there is none.
function pinnedPlugin(workspaceRoot, workspaceId, scopeId) {
  const manifests = path.join(workspaceRoot, 'state', 'manifests', segment(scopeId))
  try {
    const pointer = JSON.parse(readRegularTextNoFollow(path.join(manifests, 'current.json')))
    if (pointer?.workspaceId !== workspaceId || pointer?.scopeId !== scopeId || typeof pointer.manifestFile !== 'string' || pointer.manifestFile.includes('/')) return null
    const bytes = readFileBytes(path.join(manifests, pointer.manifestFile))
    if (sha256Digest(bytes) !== pointer.manifestDigest) return null
    const owned = JSON.parse(bytes.toString('utf8'))?.ext?.[OBSIDIAN_EXT_KEY]?.settings?.pluginOwned
    if (!Array.isArray(owned?.files)) return null
    return { files: owned.files.filter((file) => typeof file?.path === 'string' && typeof file?.digest === 'string'), off: owned.withheldBecause === TURNED_OFF }
  } catch {
    return null
  }
}

// What one pinned path holds: its digest, 'absent', or 'unreadable' (a link, a
// folder where a file goes, a path nobody may read).
function onDisk(vaultRoot, relativePath) {
  let current = vaultRoot
  for (const part of relativePath.split('/').slice(0, -1)) {
    current = path.join(current, part)
    let stat
    try { stat = fs.lstatSync(current, { throwIfNoEntry: false }) } catch { return 'unreadable' }
    if (!stat) return 'absent'
    if (stat.isSymbolicLink() || !stat.isDirectory()) return 'unreadable'
  }
  try { return readFileDigest(path.join(vaultRoot, relativePath)) ?? 'absent' } catch { return 'unreadable' }
}

export function createPluginDriftObserver({ workspaceRoot, workspaceId }) {
  const looked = new Map()
  return {
    observe(scopeIds) {
      const drifted = []
      for (const scopeId of scopeIds) {
        const pinned = pinnedPlugin(workspaceRoot, workspaceId, scopeId)
        if (pinned === null || pinned.files.length === 0) { looked.delete(scopeId); continue }
        const vaultRoot = viewVaultRoot(workspaceRoot, scopeId)
        let root = 'absent'
        try { const stat = fs.lstatSync(vaultRoot); root = stat.isSymbolicLink() ? 'link' : (stat.mode & 0o777).toString(8) } catch { root = 'absent' }
        const disk = pinned.files.map((file) => onDisk(vaultRoot, file.path))
        const differs = disk.some((found, index) => found !== pinned.files[index].digest && !(pinned.off && found === 'absent'))
        const signature = JSON.stringify([root, pinned.files.map((file) => file.digest), disk])
        if (differs && looked.get(scopeId) !== signature) drifted.push(scopeId)
        looked.set(scopeId, signature)
      }
      return drifted
    },
  }
}
