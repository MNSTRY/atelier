import { randomBytes as cryptoRandomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { MAX_OBSIDIAN_SETTINGS_BYTES, OBSIDIAN_SETTINGS_FILE, enclosingVaults, findVaultEntry, readObsidianSettings } from '../../projection/obsidian/publication/vault-list.mjs'
import { openRegularFileNoFollow, realPathAsStored, syncPrivateDirectory } from '../../project/private-state.mjs'

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
//   - never for a Flatpak or snap build, which reads its list inside its
//     sandbox and never this file (`sandbox`, see obsidianSandboxedBuild);
//   - only an existing file, in an existing user-data directory, both this
//     user's own, a real directory and a regular file (no link, and no second
//     name: a hard link would keep the old list), holding a JSON object: a file
//     Obsidian has not written is never created;
//   - never for a vault inside a folder the list has as a vault already: the
//     app would show its notes in that vault too, and a call run in its folder
//     would reach that vault (see vault-list.mjs);
//   - every other key and every other vault entry is kept as the app wrote
//     it, as values: the app itself rewrites the file with JSON.stringify;
//   - the new entry is { path: the vault root's real path, ts: now, open:
//     true } under a fresh 16-hex id that no entry has;
//   - the new file is no larger than a settings file this module reads;
//   - the bytes as they were are kept beside it in
//     `obsidian.json.atelier-backup-<UTC time>`, fsynced, before the file is
//     replaced; the replacement is a temporary file in the same directory,
//     fsynced, renamed over it, and the directory is fsynced. Of these
//     backups, the first (the list as it was before Atelier wrote it) and the
//     latest are kept, and any between them removed;
//   - a file that changed since it was read is not replaced.
//
// Every refusal writes nothing, leaves nothing behind and is typed: a file
// created on the way is removed again whichever step after its creation fails.

const refused = (code, message) => ({ ok: false, code, message })
const currentUid = () => (typeof process.getuid === 'function' ? process.getuid() : null)
const compactUtc = (ms) => new Date(ms).toISOString().replace(/[-:.]/g, '')
const BACKUP = new RegExp(`^${OBSIDIAN_SETTINGS_FILE.replaceAll('.', '\\.')}\\.atelier-backup-\\d{8}T\\d{9}Z$`)

// Keeps the first backup, the list as it was before Atelier ever wrote it, and `latest`; removes the ones between.
// Their names sort as their times. A backup that cannot be removed stays.
function pruneBackups(directory, latest) {
  let names
  try { names = fs.readdirSync(directory).filter((name) => BACKUP.test(name)).sort() } catch { return }
  for (const name of names.slice(1)) {
    if (name === latest) continue
    const file = path.join(directory, name)
    try { if (fs.lstatSync(file).isFile()) fs.unlinkSync(file) } catch { /* it stays */ }
  }
}

// Creates `file`, which must not exist (an exclusive create fails on anything
// there, a link included), with these bytes, fsynced. The file exists exactly
// when the create returned; any failure after it removes the file again.
function writeNewFile(file, bytes, mode) {
  const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), mode)
  try {
    try {
      fs.writeFileSync(descriptor, bytes)
      fs.fchmodSync(descriptor, mode)
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
  } catch (error) {
    try { fs.unlinkSync(file) } catch { /* already gone */ }
    throw error
  }
}

function readBytesNoFollow(file) {
  const descriptor = openRegularFileNoFollow(file)
  try { return fs.readFileSync(descriptor) } finally { try { fs.closeSync(descriptor) } catch { /* read already, or failed */ } }
}

// { ok: true, registered: 'already' | 'written', entry: { id, path, open }, confirmed, vaults, backupPath?, reason? }
// or a typed refusal { ok: false, code, message }. `confirmed` is false when an
// app appeared right after the rename (`app-started-during-registration`): it
// may have read the list before it, so whoever asked verifies through the
// app; and when the written file could not be read back to find the entry
// (`registration-not-read-back`). `vaults` is the list as it was found or
// written. `processProbe()` answers 'absent', 'running' or 'unknown'; only
// 'absent' allows a write. `sandbox` names a Flatpak or snap build found for
// this account, which refuses (`obsidian-sandboxed`).
export function registerVaultInObsidianSettings({ userDataDir, vaultRoot, processProbe, sandbox = null, now = () => Date.now(), randomBytes = cryptoRandomBytes, uid = currentUid() } = {}) {
  if (typeof processProbe !== 'function') throw new TypeError('registering a vault needs a process probe')
  if (typeof vaultRoot !== 'string' || !path.isAbsolute(vaultRoot) || vaultRoot.includes('\u0000')) throw new TypeError('vaultRoot must be an absolute path')
  if (sandbox !== null) return refused('obsidian-sandboxed', `this Obsidian is a ${sandbox} build, which reads its vault list inside its sandbox, where Atelier does not write`)
  const absent = () => { try { return processProbe() === 'absent' } catch { return false } }
  if (!absent()) return refused('app-may-be-running', 'an Obsidian process may be running, and its vault list belongs to it')
  const settings = readObsidianSettings({ userDataDir, uid })
  if (!settings.ok) return settings
  const known = findVaultEntry(settings.vaults, vaultRoot)
  if (known) return { ok: true, registered: 'already', entry: known, confirmed: true, vaults: settings.vaults }
  if (settings.links > 1) return refused('obsidian-settings-unsafe', 'the Obsidian settings file has a second name (a hard link), which a replacement would leave with the old list')
  if (enclosingVaults({ vaults: settings.vaults, vaultRoot }).length > 0) return refused('vault-inside-another-vault', 'Obsidian lists a vault at a folder that contains this vault\'s folder')

  let folder
  try { folder = realPathAsStored(vaultRoot) } catch { return refused('vault-root-missing', 'the view\'s vault folder does not exist') }
  if (!fs.statSync(folder).isDirectory()) return refused('vault-root-missing', 'the view\'s vault folder is not a directory')
  let id
  do { id = randomBytes(8).toString('hex') } while (Object.hasOwn(settings.vaults, id))
  const at = now()
  const document = { ...settings.document, vaults: { ...settings.vaults, [id]: { path: folder, ts: at, open: true } } }
  const bytes = Buffer.from(JSON.stringify(document), 'utf8')
  if (bytes.length > MAX_OBSIDIAN_SETTINGS_BYTES) return refused('obsidian-settings-too-large', 'with this vault the Obsidian settings file would be larger than a settings file can be')
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
  pruneBackups(directory, path.basename(backupPath))
  const stillAbsent = absent()
  const written = readObsidianSettings({ userDataDir, uid })
  const entry = written.ok ? findVaultEntry(written.vaults, vaultRoot) : null
  const reason = !stillAbsent ? 'app-started-during-registration' : entry === null ? 'registration-not-read-back' : null
  return {
    ok: true, registered: 'written', entry: entry ?? { id, path: folder, open: true }, backupPath, confirmed: reason === null, vaults: written.ok ? written.vaults : document.vaults,
    ...(reason === null ? {} : { reason }),
  }
}

// What the app looks like, as one comparable text, from what can be seen
// without asking it anything: whether an Obsidian process runs (`processes`, a
// process probe's 'running', 'absent' or 'unknown'), and which vaults its list
// shows open (`settings`, a `readObsidianSettings` answer or null). The app
// writes that list whenever a vault window opens or closes. The engine tries a
// view that did not settle again as soon as this changes; the app itself is
// asked only when a view is published.
export function appStateSignature({ processes = null, settings = null } = {}) {
  const open = settings?.ok === true
    ? Object.values(settings.vaults).filter((entry) => entry !== null && typeof entry === 'object' && entry.open === true && typeof entry.path === 'string').map((entry) => entry.path).sort()
    : null
  return JSON.stringify([typeof processes === 'string' ? processes : null, open])
}
