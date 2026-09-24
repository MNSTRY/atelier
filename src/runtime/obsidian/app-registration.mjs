import { randomBytes as cryptoRandomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { OBSIDIAN_SETTINGS_FILE, findVaultEntry, readObsidianSettings } from '../../projection/obsidian/publication/vault-list.mjs'
import { openRegularFileNoFollow, syncPrivateDirectory } from '../../project/private-state.mjs'

// Adding a view's vault to Obsidian's own vault list while Obsidian is not
// running, so that `obsidian://open?path=` finds it when the app starts.
//
// Outside Atelier's own storage, it is the only file of another application
// Atelier writes. The list is `obsidian.json` in the app's user-data directory
// (see vault-list.mjs). The app reads it when it starts and rewrites all of it
// whenever its list changes, so while it runs the file is the app's: a vault
// is then added through the app itself (`open` does that through its command
// line), never here. Here, the file is written only while the injected process
// probe says, positively, that no Obsidian runs, read immediately before and
// again immediately before the rename, and:
//
//   - only an existing file, in an existing user-data directory, both this
//     user's own, a real directory and a regular file (no link), holding a
//     JSON object: a file Obsidian has not written is never created;
//   - every other key and every other vault entry is kept as the app wrote
//     it, as values: the app itself rewrites the file with JSON.stringify;
//   - the new entry is { path: the vault root's real path, ts: now, open:
//     true } under a fresh 16-hex id that no entry has;
//   - the bytes as they were are kept beside it in
//     `obsidian.json.atelier-backup-<UTC time>`, fsynced, before the file is
//     replaced; the replacement is a temporary file in the same directory,
//     fsynced, renamed over it, and the directory is fsynced;
//   - a file that changed since it was read is not replaced.
//
// Every refusal writes nothing, leaves nothing behind and is typed.

const refused = (code, message) => ({ ok: false, code, message })
const currentUid = () => (typeof process.getuid === 'function' ? process.getuid() : null)
const compactUtc = (ms) => new Date(ms).toISOString().replace(/[-:.]/g, '')

function writeNewFile(file, bytes, mode) {
  const descriptor = openRegularFileNoFollow(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode)
  try {
    fs.writeFileSync(descriptor, bytes)
    fs.fchmodSync(descriptor, mode)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

function readBytesNoFollow(file) {
  const descriptor = openRegularFileNoFollow(file)
  try { return fs.readFileSync(descriptor) } finally { fs.closeSync(descriptor) }
}

// { ok: true, registered: 'already' | 'written', entry: { id, path, open }, confirmed, backupPath?, reason? }
// or a typed refusal { ok: false, code, message }. `confirmed` is false when an
// app appeared right after the rename: it may have read the list before it,
// so whoever asked verifies through the app. `processProbe()` answers
// 'absent', 'running' or 'unknown'; only 'absent' allows a write.
export function registerVaultInObsidianSettings({ userDataDir, vaultRoot, processProbe, now = () => Date.now(), randomBytes = cryptoRandomBytes, uid = currentUid() } = {}) {
  if (typeof processProbe !== 'function') throw new TypeError('registering a vault needs a process probe')
  if (typeof vaultRoot !== 'string' || !path.isAbsolute(vaultRoot) || vaultRoot.includes('\u0000')) throw new TypeError('vaultRoot must be an absolute path')
  const absent = () => { try { return processProbe() === 'absent' } catch { return false } }
  if (!absent()) return refused('app-may-be-running', 'an Obsidian process may be running, and its vault list belongs to it')
  const settings = readObsidianSettings({ userDataDir, uid })
  if (!settings.ok) return settings
  const known = findVaultEntry(settings.vaults, vaultRoot)
  if (known) return { ok: true, registered: 'already', entry: known, confirmed: true }

  let folder
  try { folder = fs.realpathSync(vaultRoot) } catch { return refused('vault-root-missing', 'the view\'s vault folder does not exist') }
  if (!fs.statSync(folder).isDirectory()) return refused('vault-root-missing', 'the view\'s vault folder is not a directory')
  let id
  do { id = randomBytes(8).toString('hex') } while (Object.hasOwn(settings.vaults, id))
  const at = now()
  const document = { ...settings.document, vaults: { ...settings.vaults, [id]: { path: folder, ts: at, open: true } } }
  const bytes = Buffer.from(JSON.stringify(document), 'utf8')
  const directory = path.dirname(settings.file)
  const backupPath = path.join(directory, `${OBSIDIAN_SETTINGS_FILE}.atelier-backup-${compactUtc(at)}`)
  const temporary = path.join(directory, `.${OBSIDIAN_SETTINGS_FILE}.atelier-${randomBytes(6).toString('hex')}.tmp`)
  const created = []
  const removeCreated = () => { for (const file of created.splice(0)) try { fs.unlinkSync(file) } catch { /* already gone */ } }
  try {
    writeNewFile(temporary, bytes, settings.mode)
    created.push(temporary)
    writeNewFile(backupPath, settings.bytes, settings.mode)
    created.push(backupPath)
  } catch (error) {
    removeCreated()
    return refused(error.code === 'EEXIST' ? 'obsidian-settings-changed' : 'obsidian-settings-unwritable', 'the Obsidian settings directory cannot be written')
  }
  // Immediately before the rename: still no app, and still the bytes that were read.
  if (!absent()) { removeCreated(); return refused('app-may-be-running', 'an Obsidian process appeared, and its vault list belongs to it') }
  let current
  try { current = readBytesNoFollow(settings.file) } catch { current = null }
  if (current === null || !current.equals(settings.bytes)) { removeCreated(); return refused('obsidian-settings-changed', 'the Obsidian settings file changed while the vault was being added') }
  try {
    fs.renameSync(temporary, settings.file)
  } catch {
    removeCreated()
    return refused('obsidian-settings-unwritable', 'the Obsidian settings file cannot be replaced')
  }
  created.splice(0)
  try { syncPrivateDirectory(directory) } catch { /* the rename is done; a directory that cannot be fsynced is not undone */ }
  const stillAbsent = absent()
  const written = readObsidianSettings({ userDataDir, uid })
  const entry = written.ok ? findVaultEntry(written.vaults, vaultRoot) : null
  return {
    ok: true, registered: 'written', entry: entry ?? { id, path: folder, open: true }, backupPath, confirmed: stillAbsent && entry !== null,
    ...(stillAbsent ? {} : { reason: 'app-started-during-registration' }),
  }
}

// What the app looked like, as one comparable text: whether it runs, how it
// qualified, and which vaults its list shows open. The engine tries a view
// that did not settle again as soon as this changes. `qualification` is a
// `qualifyApp` answer; `settings` a `readObsidianSettings` answer or null.
export function appStateSignature({ qualification = null, settings = null } = {}) {
  const open = settings?.ok === true
    ? Object.values(settings.vaults).filter((entry) => entry !== null && typeof entry === 'object' && entry.open === true && typeof entry.path === 'string').map((entry) => entry.path).sort()
    : null
  return JSON.stringify([qualification?.running ?? null, qualification?.outcome ?? null, qualification?.reason ?? null, open])
}
