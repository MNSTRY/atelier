import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { obsidianSandboxedBuild, obsidianUserDataDir, readObsidianSettings } from '../../projection/obsidian/publication/vault-list.mjs'
import { realPathOfLocation } from './vault-location.mjs'

// Whether the Obsidian this account runs lists a vault Atelier is filling for
// the first time, as the publisher's `direct-unheld` path needs to know
// (publisher.mjs; docs/obsidian-contract.md, "First publication into a vault
// no Obsidian lists"). Read from the app's settings file, never from the app:
//
//   { unlisted: true }                   the file was read, and none of its entries is the vault root, a folder above
//                                        it or a folder inside it
//   { unlisted: false, reason, ... }     anything else, which gives no evidence
//
// It errs towards "no evidence": a file that is missing (an app that has shown
// only its starter window writes none), that cannot be read after `attempts`
// reads `delayMs` apart (the app rewrites it with a plain write, so a reader
// can find it empty or cut short while it writes), that is not a JSON object,
// or that has an entry whose folder is not an absolute path; and a Flatpak or
// snap build of the app anywhere on this account, whose list lives in its
// sandbox and not in this file. The root and every listed folder are compared
// as written and as their real paths, in any letter case, so a link on the way
// to either side, or another spelling, does not hide an entry.

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const folded = (target) => target.normalize('NFC').toLowerCase()
// The real path of a folder that may not exist, and its lexical path when it cannot be resolved (a volume that is gone).
const realOrLexical = (target) => { try { return realPathOfLocation(target) } catch { return path.resolve(target) } }
const spellings = (target) => [...new Set([path.resolve(target), realOrLexical(target)].map(folded))]
// Strictly inside: `..x` is a folder name, not a way up.
const inside = (parent, child) => { const relative = path.relative(parent, child); return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) }

// How a listed folder stands to the vault root, or null when it is neither the root, above it, nor inside it.
function relationOf(entryPath, root) {
  const listed = spellings(entryPath)
  if (listed.some((folder) => root.includes(folder))) return 'vault-listed'
  if (listed.some((folder) => root.some((candidate) => inside(folder, candidate)))) return 'vault-inside-listed-vault'
  if (listed.some((folder) => root.some((candidate) => inside(candidate, folder)))) return 'listed-vault-inside-vault'
  return null
}

const noEvidence = (reason, extra = {}) => ({ unlisted: false, reason, ...extra })

// `read` answers readObsidianSettings for the app's user-data directory; `sandboxed` answers whether a Flatpak or snap
// build is present. Either one that throws gives no evidence.
export async function readUnheldEvidence({ vaultRoot, read, sandboxed, attempts = 3, delayMs = 50, sleep = delay } = {}) {
  if (typeof vaultRoot !== 'string' || !path.isAbsolute(vaultRoot)) return noEvidence('vault-root-unknown')
  if (typeof read !== 'function' || typeof sandboxed !== 'function') return noEvidence('obsidian-settings-location-unknown')
  let present = true
  try { present = sandboxed() !== false } catch { present = true }
  if (present) return noEvidence('obsidian-sandboxed')
  let answer = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { answer = read() } catch { answer = { ok: false, code: 'obsidian-settings-unreadable' } }
    if (answer?.ok === true || answer?.code !== 'obsidian-settings-unreadable') break
    if (attempt < attempts) await sleep(delayMs)
  }
  if (answer?.ok !== true) return noEvidence(typeof answer?.code === 'string' ? answer.code : 'obsidian-settings-unreadable')
  const vaults = answer.vaults ?? {}
  if (!isPlainObject(vaults)) return noEvidence('obsidian-settings-not-object')
  const root = spellings(vaultRoot)
  for (const [id, entry] of Object.entries(vaults)) {
    if (!isPlainObject(entry) || typeof entry.path !== 'string' || !path.isAbsolute(entry.path)) return noEvidence('obsidian-settings-entry-unreadable', { id })
    const relation = relationOf(entry.path, root)
    if (relation !== null) return noEvidence(relation, { id, path: entry.path })
  }
  return { unlisted: true }
}

// The reader the maintenance service gives its engine: the settings file of the app for this account (HOME, and on
// Linux XDG_CONFIG_HOME), and any Flatpak or snap build, installed or having left its list, whichever wrote last.
export function createProductionUnheldEvidence({ platform = process.platform, env = process.env } = {}) {
  const userDataDir = obsidianUserDataDir({ platform, env })
  return ({ vaultRoot }) => readUnheldEvidence({
    vaultRoot,
    read: () => (userDataDir === null ? { ok: false, code: 'obsidian-settings-location-unknown' } : readObsidianSettings({ userDataDir })),
    // Present at all, not only when its list was written last: with no list time given, any installation or list counts.
    sandboxed: () => obsidianSandboxedBuild({ platform, env, modified: () => null }) !== null,
  })
}
