import { randomBytes as cryptoRandomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { MAX_OBSIDIAN_SETTINGS_BYTES, OBSIDIAN_SETTINGS_FILE, enclosingVaults, findVaultEntry, readObsidianSettings } from '../../projection/obsidian/publication/vault-list.mjs'
import { openRegularFileNoFollow, realPathAsStored, syncPrivateDirectory } from '../../project/private-state.mjs'

// Adding a view's vault to Obsidian's own vault list while Obsidian is not
// running, so that the app opens it when it starts.
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
//   - an existing file only in an existing user-data directory, both this
//     user's own, a real directory and a regular file (no link, and no second
//     name: a hard link would keep the old list), holding a JSON object;
//   - a file that does not exist (Obsidian never started on this account) is
//     created, and only then: see createObsidianSettings below;
//   - never for a vault inside a folder the list has as a vault already: the
//     app would show its notes in that vault too, and a call run in its folder
//     would reach that vault (see vault-list.mjs);
//   - every other key and every other vault entry is kept as the app wrote
//     it, as values: the app itself rewrites the file with JSON.stringify;
//   - the new entry is { path: the vault root's real path, ts: now, open:
//     true } under a fresh 16-hex id that no entry has;
//   - the command-line switch: whenever the list is written, `cli` is set to
//     true when it is not (the default of a new installation is off, and
//     `open` needs the command line while the app holds the vault). A vault the
//     list has already, with `cli` not true, is written for the switch alone.
//     Only here, so only while no Obsidian runs: a running app keeps its
//     switch in memory and would write it back;
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

// Creates the settings file of an Obsidian that never started on this account:
// the file does not exist, and the process table says, positively, that no
// Obsidian runs, read before and again immediately before the file appears.
// The app reads the file when it starts (a missing or unreadable one reads as
// no settings) and opens every vault flagged open, so a plain start opens this
// one, with its command line on. Only:
//
//   - in the user-data directory as it is when that is this user's own real
//     directory, or, when it does not exist, in one created here with mode
//     0700 inside an existing real parent directory (a missing parent is
//     `obsidian-settings-missing`: nothing is created above the directory);
//   - with exactly { "vaults": { "<16 hex>": { path, ts, open: true } },
//     "cli": true }, mode 0600;
//   - by an exclusive create: the complete bytes are written, fsynced, to a
//     temporary file in the directory, which is then linked to the file's name
//     (a link fails on any name there, a file the app wrote meanwhile
//     included, which is kept: `obsidian-settings-changed`), and the
//     temporary name removed. A reader never sees a part of the file.
//
// There is nothing to back up. A refusal removes what it created, the
// directory included.
function createObsidianSettings({ userDataDir, vaultRoot, absent, now, randomBytes, uid }) {
  const owned = (stat) => uid === null || stat.uid === uid
  let directory = null
  try { directory = fs.lstatSync(userDataDir) } catch (error) { if (error.code !== 'ENOENT') return refused('obsidian-settings-unreadable', 'the Obsidian settings directory cannot be read') }
  let folder
  try { folder = realPathAsStored(vaultRoot) } catch { return refused('vault-root-missing', 'the view\'s vault folder does not exist') }
  if (!fs.statSync(folder).isDirectory()) return refused('vault-root-missing', 'the view\'s vault folder is not a directory')
  let madeDirectory = false
  if (directory === null) {
    const parent = path.dirname(userDataDir)
    let above
    try { above = fs.lstatSync(parent) } catch { above = null }
    if (above === null || above.isSymbolicLink() || !above.isDirectory() || !owned(above)) return refused('obsidian-settings-missing', 'Obsidian has no settings directory on this account, and the folder it would be in is missing, a link or not this user\'s own')
    try { fs.mkdirSync(userDataDir, { mode: 0o700 }) } catch (error) {
      return refused(error.code === 'EEXIST' ? 'obsidian-settings-changed' : 'obsidian-settings-unwritable', 'the Obsidian settings directory cannot be created')
    }
    madeDirectory = true
    directory = fs.lstatSync(userDataDir)
  }
  const removeDirectory = () => { if (madeDirectory) try { fs.rmdirSync(userDataDir) } catch { /* something else is in it now: it stays */ } }
  if (directory.isSymbolicLink() || !directory.isDirectory()) return refused('obsidian-settings-unsafe', 'the Obsidian settings directory is a link or not a directory')
  if (!owned(directory)) return refused('obsidian-settings-not-owned', 'the Obsidian settings directory belongs to another user')
  const id = randomBytes(8).toString('hex')
  const at = now()
  const document = { vaults: { [id]: { path: folder, ts: at, open: true } }, cli: true }
  const bytes = Buffer.from(JSON.stringify(document), 'utf8')
  if (bytes.length > MAX_OBSIDIAN_SETTINGS_BYTES) { removeDirectory(); return refused('obsidian-settings-too-large', 'with this vault the Obsidian settings file would be larger than a settings file can be') }
  const file = path.join(userDataDir, OBSIDIAN_SETTINGS_FILE)
  const temporary = path.join(userDataDir, `.${OBSIDIAN_SETTINGS_FILE}.atelier-${randomBytes(6).toString('hex')}.tmp`)
  const undo = () => { try { fs.unlinkSync(temporary) } catch { /* already gone */ } removeDirectory() }
  try { writeNewFile(temporary, bytes, 0o600) } catch { undo(); return refused('obsidian-settings-unwritable', 'the Obsidian settings directory cannot be written') }
  // Immediately before the file appears: still no app.
  if (!absent()) { undo(); return refused('app-may-be-running', 'an Obsidian process appeared, and its settings belong to it') }
  try { fs.linkSync(temporary, file) } catch (error) {
    undo()
    return refused(error.code === 'EEXIST' ? 'obsidian-settings-changed' : 'obsidian-settings-unwritable', error.code === 'EEXIST' ? 'an Obsidian settings file appeared while it was being created, and it was kept as it is' : 'the Obsidian settings file cannot be created')
  }
  try { fs.unlinkSync(temporary) } catch { /* the file is complete; a second name is refused by the next write */ }
  try { syncPrivateDirectory(userDataDir); if (madeDirectory) syncPrivateDirectory(path.dirname(userDataDir)) } catch { /* the file exists; a directory that cannot be fsynced is not undone */ }
  const stillAbsent = absent()
  const written = readObsidianSettings({ userDataDir, uid })
  const entry = written.ok ? findVaultEntry(written.vaults, vaultRoot) : null
  const reason = !stillAbsent ? 'app-started-during-registration' : entry === null ? 'registration-not-read-back' : null
  return {
    ok: true, registered: 'created', entry: entry ?? { id, path: folder, open: true }, confirmed: reason === null, vaults: written.ok ? written.vaults : document.vaults,
    file, created: { directory: madeDirectory }, cliTurnedOn: true, ...(reason === null ? {} : { reason }),
  }
}

// { ok: true, registered: 'already' | 'written' | 'created', entry: { id, path, open }, confirmed, vaults, file, cliTurnedOn,
// backupPath?, created?, reason? } or a typed refusal { ok: false, code, message }. `registered` is 'already' when the
// list had the vault (then the file was written only to turn the command line on, `cliTurnedOn`), 'written' when this
// vault was added to an existing file, 'created' when the file was created (createObsidianSettings). `confirmed` is
// false when an app appeared right after the rename (`app-started-during-registration`): it may have read the list
// before it, so whoever asked verifies through the app; and when the written file could not be read back to find the
// entry (`registration-not-read-back`). `vaults` is the list as it was found or written. `processProbe()` answers
// 'absent', 'running' or 'unknown'; only 'absent' allows a write. `sandbox` names a Flatpak or snap build found for
// this account, which refuses (`obsidian-sandboxed`).
export function registerVaultInObsidianSettings({ userDataDir, vaultRoot, processProbe, sandbox = null, now = () => Date.now(), randomBytes = cryptoRandomBytes, uid = currentUid() } = {}) {
  if (typeof processProbe !== 'function') throw new TypeError('registering a vault needs a process probe')
  if (typeof vaultRoot !== 'string' || !path.isAbsolute(vaultRoot) || vaultRoot.includes('\u0000')) throw new TypeError('vaultRoot must be an absolute path')
  if (sandbox !== null) return refused('obsidian-sandboxed', `this Obsidian is a ${sandbox} build, which reads its vault list inside its sandbox, where Atelier does not write`)
  const absent = () => { try { return processProbe() === 'absent' } catch { return false } }
  if (!absent()) return refused('app-may-be-running', 'an Obsidian process may be running, and its vault list belongs to it')
  const settings = readObsidianSettings({ userDataDir, uid })
  // No file: Obsidian never started on this account. A missing directory is refused as missing when it has no parent.
  if (!settings.ok && settings.code === 'obsidian-settings-missing' && typeof userDataDir === 'string' && path.isAbsolute(userDataDir)) return createObsidianSettings({ userDataDir, vaultRoot, absent, now, randomBytes, uid })
  if (!settings.ok) return settings
  const known = findVaultEntry(settings.vaults, vaultRoot)
  const switchOn = settings.document.cli !== true
  if (known && !switchOn) return { ok: true, registered: 'already', entry: known, confirmed: true, vaults: settings.vaults, file: settings.file, cliTurnedOn: false }
  if (settings.links > 1) return refused('obsidian-settings-unsafe', 'the Obsidian settings file has a second name (a hard link), which a replacement would leave with the old list')
  if (!known && enclosingVaults({ vaults: settings.vaults, vaultRoot }).length > 0) return refused('vault-inside-another-vault', 'Obsidian lists a vault at a folder that contains this vault\'s folder')

  let folder = null
  let id = null
  if (!known) {
    try { folder = realPathAsStored(vaultRoot) } catch { return refused('vault-root-missing', 'the view\'s vault folder does not exist') }
    if (!fs.statSync(folder).isDirectory()) return refused('vault-root-missing', 'the view\'s vault folder is not a directory')
    do { id = randomBytes(8).toString('hex') } while (Object.hasOwn(settings.vaults, id))
  }
  const at = now()
  // The switch keeps its place when the file has one; otherwise it is added last, as the app would.
  const document = { ...settings.document, ...(known ? {} : { vaults: { ...settings.vaults, [id]: { path: folder, ts: at, open: true } } }), ...(switchOn ? { cli: true } : {}) }
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
    ok: true, registered: known ? 'already' : 'written', entry: entry ?? known ?? { id, path: folder, open: true }, backupPath, confirmed: reason === null, vaults: written.ok ? written.vaults : document.vaults,
    file: settings.file, cliTurnedOn: switchOn, ...(reason === null ? {} : { reason }),
  }
}

// Read-only, for `open` before it quits a running app to restart it: whether registerVaultInObsidianSettings would
// write this vault into the settings file `settings` (a readObsidianSettings answer, read while the app runs), as far
// as a read can tell. { ok: true } or { ok: false, code } with the refusal the write would give: an unreadable,
// linked, foreign, sandboxed or too large file, a vault inside another listed vault, a vault folder that is missing.
// What only the moment of the write can tell (an app that appears, a file that changes) is still checked then.
export function settingsWriteOutlook({ settings, vaultRoot, now = () => Date.now() } = {}) {
  const no = (code) => ({ ok: false, code })
  if (settings?.ok !== true) return no(typeof settings?.code === 'string' ? settings.code : 'obsidian-settings-unreadable')
  if (typeof vaultRoot !== 'string' || !path.isAbsolute(vaultRoot)) return no('vault-root-missing')
  if (typeof settings.links === 'number' && settings.links > 1) return no('obsidian-settings-unsafe')
  const size = Buffer.isBuffer(settings.bytes) ? settings.bytes.length : 0
  const known = findVaultEntry(settings.vaults, vaultRoot)
  if (known) return size + 16 > MAX_OBSIDIAN_SETTINGS_BYTES ? no('obsidian-settings-too-large') : { ok: true }
  if (enclosingVaults({ vaults: settings.vaults, vaultRoot }).length > 0) return no('vault-inside-another-vault')
  let folder
  try { folder = realPathAsStored(vaultRoot); if (!fs.statSync(folder).isDirectory()) return no('vault-root-missing') } catch { return no('vault-root-missing') }
  const entry = Buffer.byteLength(JSON.stringify({ '0123456789abcdef': { path: folder, ts: now(), open: true } }), 'utf8')
  return size + entry + 16 > MAX_OBSIDIAN_SETTINGS_BYTES ? no('obsidian-settings-too-large') : { ok: true }
}

// Keeps a copy of the settings file as it is, beside it, under the backup name the write uses
// (`obsidian.json.atelier-backup-<UTC time>`), fsynced, with the file's mode. Read-only for the file itself. `open`
// takes it before it sends a running app any signal, so a list the app was writing when it ended can be restored.
// { ok: true, backupPath } or a typed refusal (readObsidianSettings's, or `obsidian-settings-unwritable`). A later
// write of the list that succeeds keeps the first and the latest backup, as always, and removes this one when it is
// neither: that write read the file whole, and its own backup holds it.
export function backupObsidianSettings({ userDataDir, now = () => Date.now(), uid = currentUid() } = {}) {
  const settings = readObsidianSettings({ userDataDir, uid })
  if (!settings.ok) return settings
  const directory = path.dirname(settings.file)
  for (let offset = 0; offset < 3; offset += 1) {
    const backupPath = path.join(directory, `${OBSIDIAN_SETTINGS_FILE}.atelier-backup-${compactUtc(now() + offset)}`)
    try {
      writeNewFile(backupPath, settings.bytes, settings.mode)
    } catch (error) {
      if (error.code === 'EEXIST') continue
      return refused('obsidian-settings-unwritable', 'a copy of the Obsidian settings file cannot be kept beside it')
    }
    try { syncPrivateDirectory(directory) } catch { /* the copy is written */ }
    return { ok: true, backupPath }
  }
  return refused('obsidian-settings-unwritable', 'a copy of the Obsidian settings file cannot be kept beside it')
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
