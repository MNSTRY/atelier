import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { VAULT_ALLOCATION_SCHEMA, allocationFile, createRecoveryStore, hasCommittedGeneration, readVaultAllocation, vaultRootFor, writeVaultAllocation } from '../src/projection/obsidian/recovery/index.mjs'
import {
  MAX_PROJECT_NAME_BYTES, checkVaultParent, ensureVaultAllocation, projectDisplayName, protectedFolderOf, safeFolderPart, syncedFolderOf, vaultFolderName,
} from '../src/runtime/obsidian/vault-location.mjs'

// Where a workspace's vaults live once a person decided it, and the folder
// each view gets there: names, the checks on the folder that holds them, the
// allocation and its record, and the store that reads it. Temporary
// directories only; nothing here starts a process or reaches an app.

const TMP = fs.realpathSync(os.tmpdir())
const WORKSPACE_ID = `ws-${'07'.repeat(12)}`
const NOW = '2026-01-05T10:00:00.000Z'
const POSIX = process.platform !== 'win32'

function world(t) {
  const dir = fs.mkdtempSync(path.join(TMP, 'atelier-vault-location-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const workspaceRoot = path.join(dir, 'data', 'obsidian', WORKSPACE_ID)
  fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 })
  const repository = path.join(dir, 'project', 'east-wing')
  fs.mkdirSync(repository, { recursive: true })
  return { dir, workspaceRoot, repository, repositoryRoots: [path.join(dir, 'project'), repository], parent: path.join(dir, 'Atelier') }
}

test('a vault folder is named `<project> (<view>)`, made safe for every system and for the app', () => {
  assert.equal(vaultFolderName({ projectName: 'harbor-notes', scopeId: 'everything' }), 'harbor-notes (everything)')
  assert.equal(vaultFolderName({ projectName: 'harbor-notes', scopeId: 'everything', number: 2 }), 'harbor-notes (everything 2)')
  assert.equal(vaultFolderName({ projectName: 'pier', scopeId: 'scope:full' }), 'pier (scope_full)', 'a colon cannot be in a file name everywhere')
  const cases = [
    ['harbor-notes', 'harbor-notes'],
    ['Pier · North quay notes', 'Pier · North quay notes'],
    ['  .hidden. ', 'hidden', 'a leading dot hides a folder from the app; a trailing dot or space is not allowed on Windows'],
    ['a/b\\c:d*e?f"g<h>i|j#k^l[m]n', 'a b c d e f g h i j k l m n', 'separators, reserved and link characters'],
    ['draft (old)', 'draft old', 'parentheses end the view part, so a project never carries one'],
    ['tab\there\nline', 'tab here line'],
    ['e\u0301te', '\u00e9te', 'NFC'],
    ['bi\u202edi', 'bidi', 'bidirectional controls are removed'],
    ['CON', '_CON', 'a Windows device name'],
    ['con.txt', '_con.txt'],
    ['', ''],
  ]
  for (const [given, expected, label] of cases) assert.equal(safeFolderPart(given), expected, label ?? given)
  const long = safeFolderPart('é'.repeat(100))
  assert.equal(Buffer.byteLength(long, 'utf8') <= MAX_PROJECT_NAME_BYTES, true)
  assert.equal(long, 'é'.repeat(40), 'cut on a character boundary')
  assert.equal(safeFolderPart(`${'a'.repeat(79)}e\u0301`), 'a'.repeat(79), 'NFC makes one character of the accented letter, and a character that does not fit is left out')
  assert.equal(safeFolderPart(`${'a'.repeat(78)}q\u0307\u0323`), 'a'.repeat(78), 'a letter and its accents stay together or go together')
  assert.equal(safeFolderPart(`${'a'.repeat(75)}\u{1F469}\u200d\u{1F4BB}`), 'a'.repeat(75), 'so does an emoji sequence')
  assert.equal(safeFolderPart(`${'a'.repeat(69)}\u{1F469}\u200d\u{1F4BB}`), `${'a'.repeat(69)}\u{1F469}\u200d\u{1F4BB}`, 'a sequence that fits stays whole')
  assert.equal(projectDisplayName({ config: { name: 'harbor-notes' }, configDir: '/x/other' }), 'harbor-notes')
  assert.equal(projectDisplayName({ config: {}, configDir: '/x/field-notes' }), 'field-notes', 'without a name, the project folder')
  assert.equal(projectDisplayName({ config: { name: '...' }, configDir: '/' }), 'project')
})

test('no vault name of this form is the beginning of another one\'s path, whatever the projects, views and numbers', () => {
  const projects = ['h', 'ha', 'harbor', 'harbor 2', 'harbor lab', 'a b', 'pier · x']
  const views = ['e', 'every', 'everything', 'everything-2', 'scope_full', 'north-quay', 'x.y']
  const names = []
  for (const project of projects) for (const scopeId of views) for (const number of [1, 2, 3, 12, 23]) names.push(vaultFolderName({ projectName: safeFolderPart(project), scopeId, number }))
  assert.equal(new Set(names).size, names.length)
  for (const left of names) for (const right of names) {
    if (left !== right) assert.equal(`${right}/`.startsWith(left), false, `${left} begins ${right}`)
    if (left !== right) assert.equal(right.startsWith(left), false, `${left} begins ${right}`)
  }
})

test('a folder a sync client keeps in step, and one macOS protects, are recognised by name', () => {
  const home = path.join(TMP, 'home-someone')
  const at = (...parts) => path.join(home, ...parts)
  const exists = (target) => target === at('Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Documents')
  const synced = (target) => syncedFolderOf(target, { homedir: home, exists })
  assert.equal(synced(at('Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Vaults')), 'iCloud Drive')
  assert.equal(synced(at('Library', 'CloudStorage', 'Dropbox', 'Vaults')), 'a cloud storage provider')
  assert.equal(synced(at('Dropbox', 'Vaults')), 'Dropbox')
  assert.equal(synced(at('OneDrive')), 'OneDrive')
  assert.equal(synced(at('Documents', 'Vaults')), 'iCloud (Documents)', 'Desktop & Documents Folders syncs Documents')
  assert.equal(synced(at('Desktop', 'Vaults')), null, 'Desktop is not synced here')
  assert.equal(synced(at('Atelier')), null)
  assert.equal(synced(at('DropboxOld', 'Vaults')), null, 'a folder whose name only begins like one is not one')
  assert.equal(syncedFolderOf(at('Dropbox'), { homedir: undefined }), null)
  assert.equal(protectedFolderOf(at('Documents', 'Atelier'), { homedir: home, platform: 'darwin' }), 'Documents')
  assert.equal(protectedFolderOf(at('Downloads'), { homedir: home, platform: 'darwin' }), 'Downloads')
  assert.equal(protectedFolderOf(at('Atelier'), { homedir: home, platform: 'darwin' }), null)
  assert.equal(protectedFolderOf(at('Documents', 'Atelier'), { homedir: home, platform: 'linux' }), null)
})

test('the folder that holds the vaults is never inside a repository, a vault Atelier publishes, a vault the app lists, or on another volume', (t) => {
  const w = world(t)
  const check = (parent, extra = {}) => { try { return checkVaultParent({ parent, workspaceRoot: w.workspaceRoot, repositoryRoots: w.repositoryRoots, ...extra }) } catch (error) { return error.code } }
  assert.deepEqual(check(w.parent), { synced: null, protected: null })
  assert.deepEqual(check(w.dir), { synced: null, protected: null }, 'a folder above the repositories is no overlap: each vault folder is checked again')
  assert.equal(check(path.join(w.repository, 'vaults')), 'vault-location-inside-repository')
  assert.equal(check(path.join(w.dir, 'project', 'vaults')), 'vault-location-inside-repository', 'inside the project')
  assert.equal(check('relative/Atelier'), 'vault-location-not-absolute')
  assert.equal(check(`${w.parent}${path.sep}..${path.sep}Atelier`), 'vault-location-not-absolute', 'written plainly')
  // A vault Atelier published (its lock folder is there), or one allocated to another view of this workspace.
  const published = path.join(w.dir, 'published vault')
  fs.mkdirSync(path.join(published, '.atelier-publication'), { recursive: true })
  assert.equal(check(path.join(published, 'inner')), 'vault-location-inside-vault')
  assert.equal(check(path.join(w.parent, 'x (y)', 'deeper'), { allocatedPaths: [path.join(w.parent, 'x (y)')] }), 'vault-location-inside-vault')
  // A vault the app lists, when its list is known: at the folder or above it.
  assert.equal(check(w.parent, { vaults: { aaaaaaaaaaaaaaaa: { path: w.dir } } }), 'vault-location-inside-vault')
  assert.equal(check(w.parent, { vaults: { aaaaaaaaaaaaaaaa: { path: w.parent } } }), 'vault-location-inside-vault')
  assert.deepEqual(check(w.parent, { vaults: { aaaaaaaaaaaaaaaa: { path: path.join(w.parent, 'harbor-notes (everything)') } } }), { synced: null, protected: null }, 'a vault below it is no enclosing vault')
  // Another volume than the private state: the exchange that publishes a note cannot cross it.
  const deviceOf = (target) => (target.startsWith(w.workspaceRoot) || target.startsWith(path.join(w.dir, 'data')) ? 1 : 2)
  assert.equal(check(w.parent, { deviceOf }), 'vault-location-other-volume')
  assert.deepEqual(check(path.join(w.dir, 'data', 'Atelier'), { deviceOf }), { synced: null, protected: null })
  // A synced folder only when asked for; a protected one with a warning.
  const home = path.join(w.dir, 'home')
  fs.mkdirSync(path.join(home, 'Dropbox'), { recursive: true })
  assert.equal(check(path.join(home, 'Dropbox', 'Atelier'), { homedir: home }), 'vault-location-synced')
  assert.deepEqual(check(path.join(home, 'Dropbox', 'Atelier'), { homedir: home, allowSynced: true }), { synced: 'Dropbox', protected: null })
  assert.deepEqual(check(path.join(home, 'Documents', 'Atelier'), { homedir: home, platform: 'darwin' }), { synced: null, protected: 'Documents' })
})

test('a view\'s vault is allocated once, private to this user, under the first free name, and recorded', (t) => {
  const w = world(t)
  const allocate = (scopeId, extra = {}) => ensureVaultAllocation({ workspaceRoot: w.workspaceRoot, workspaceId: WORKSPACE_ID, scopeId, location: { parent: w.parent }, projectName: 'harbor-notes', repositoryRoots: w.repositoryRoots, now: NOW, ...extra })
  // Nothing decided: the vault stays under the data root, as before, and nothing is created.
  assert.equal(ensureVaultAllocation({ workspaceRoot: w.workspaceRoot, workspaceId: WORKSPACE_ID, scopeId: 'everything', location: null, projectName: 'harbor-notes', repositoryRoots: w.repositoryRoots, now: NOW }), null)
  assert.equal(fs.existsSync(w.parent), false)

  const first = allocate('everything')
  assert.deepEqual(first, { schema: VAULT_ALLOCATION_SCHEMA, workspaceId: WORKSPACE_ID, scopeId: 'everything', path: path.join(w.parent, 'harbor-notes (everything)'), name: 'harbor-notes (everything)', parent: w.parent, allocatedAt: NOW })
  assert.equal(fs.statSync(first.path).isDirectory(), true)
  if (POSIX) {
    assert.equal(fs.statSync(first.path).mode & 0o777, 0o700)
    assert.equal(fs.statSync(w.parent).mode & 0o777, 0o700, 'a folder Atelier creates to hold the vaults is private too')
    assert.equal(fs.statSync(allocationFile(w.workspaceRoot, 'everything')).mode & 0o777, 0o600)
  }
  assert.deepEqual(readVaultAllocation({ workspaceRoot: w.workspaceRoot, workspaceId: WORKSPACE_ID, scopeId: 'everything' }), first)
  // Once: a later call, even after the location changed, answers the record and makes nothing.
  assert.deepEqual(allocate('everything', { location: { parent: path.join(w.dir, 'Elsewhere') } }), first)
  assert.equal(fs.existsSync(path.join(w.dir, 'Elsewhere')), false)

  // A name taken on the disk, or by a vault the app lists in any letter case, goes to the next number.
  fs.mkdirSync(path.join(w.parent, 'harbor-notes (tides)'))
  fs.writeFileSync(path.join(w.parent, 'harbor-notes (tides)', 'somebody.md'), 'mine')
  assert.equal(allocate('tides').name, 'harbor-notes (tides 2)')
  assert.equal(fs.readFileSync(path.join(w.parent, 'harbor-notes (tides)', 'somebody.md'), 'utf8'), 'mine', 'a folder somebody else has is never touched')
  const listed = { aaaaaaaaaaaaaaaa: { path: path.join(TMP, 'elsewhere', 'Harbor-Notes (Charts)') } }
  assert.equal(allocate('charts', { vaults: listed }).name, 'harbor-notes (charts 2)')

  // A view published under the data root keeps its vault there.
  fs.mkdirSync(path.join(w.workspaceRoot, 'state', 'manifests', 'published'), { recursive: true })
  fs.writeFileSync(path.join(w.workspaceRoot, 'state', 'manifests', 'published', 'current.json'), '{}')
  assert.equal(hasCommittedGeneration({ workspaceRoot: w.workspaceRoot, scopeId: 'published' }), true)
  assert.equal(allocate('published'), null)

  // Every check of the holding folder applies.
  assert.throws(() => allocate('inside', { location: { parent: path.join(w.repository, 'vaults') } }), (error) => error.code === 'vault-location-inside-repository')
  assert.throws(() => allocate('listed', { vaults: { bbbbbbbbbbbbbbbb: { path: w.parent } } }), (error) => error.code === 'vault-location-inside-vault')
})

test('the store publishes a view into its allocated vault, makes it again when it has gone, and refuses a record it cannot trust', (t) => {
  const w = world(t)
  const storeOf = (scopeId) => createRecoveryStore({ workspaceRoot: w.workspaceRoot, workspaceId: WORKSPACE_ID, scopeId, repositoryRoots: w.repositoryRoots })
  // Without a record: under the data root, as before.
  const legacy = storeOf('scope-legacy')
  assert.deepEqual([legacy.vaultRoot, legacy.vaultOrigin], [path.join(w.workspaceRoot, 'vaults', 'scope-legacy'), 'legacy-data-root'])
  assert.deepEqual(vaultRootFor({ workspaceRoot: w.workspaceRoot, workspaceId: WORKSPACE_ID, scopeId: 'scope-legacy' }).origin, 'legacy-data-root')

  const allocation = ensureVaultAllocation({ workspaceRoot: w.workspaceRoot, workspaceId: WORKSPACE_ID, scopeId: 'everything', location: { parent: w.parent }, projectName: 'harbor-notes', repositoryRoots: w.repositoryRoots, now: NOW })
  const placed = storeOf('everything')
  assert.deepEqual([placed.vaultRoot, placed.vaultOrigin, placed.allocation], [allocation.path, 'allocated', allocation])
  assert.equal(fs.existsSync(path.join(w.workspaceRoot, 'vaults', 'everything')), false, 'nothing is made under the data root for it')
  // A folder somebody removed is made again, private, where the record says.
  fs.rmSync(allocation.path, { recursive: true })
  assert.equal(storeOf('everything').vaultRoot, allocation.path)
  if (POSIX) assert.equal(fs.statSync(allocation.path).mode & 0o777, 0o700)
  // An explicit vault root still wins.
  const explicit = path.join(w.dir, 'explicit vault')
  const named = createRecoveryStore({ workspaceRoot: w.workspaceRoot, workspaceId: WORKSPACE_ID, scopeId: 'everything', vaultRoot: explicit, repositoryRoots: w.repositoryRoots })
  assert.deepEqual([named.vaultRoot, named.vaultOrigin], [explicit, 'explicit'])

  // A record that names a folder inside a repository is refused before anything is created; so is one that is not a record.
  const file = allocationFile(w.workspaceRoot, 'everything')
  const inside = path.join(w.repository, 'vault')
  fs.writeFileSync(file, JSON.stringify({ ...allocation, path: inside, parent: w.repository, name: 'vault' }))
  assert.throws(() => storeOf('everything'), (error) => error.code === 'managed-root-inside-repository')
  assert.equal(fs.existsSync(inside), false)
  for (const broken of [{ ...allocation, surprise: 1 }, { ...allocation, scopeId: 'another' }, { ...allocation, path: 'relative' }, { ...allocation, name: 'other' }, { ...allocation, allocatedAt: 'now' }]) {
    fs.writeFileSync(file, JSON.stringify(broken))
    assert.throws(() => storeOf('everything'), (error) => error.code === 'invalid-vault-allocation', JSON.stringify(broken))
  }
  fs.writeFileSync(file, 'not json')
  assert.throws(() => vaultRootFor({ workspaceRoot: w.workspaceRoot, workspaceId: WORKSPACE_ID, scopeId: 'everything' }), (error) => error.code === 'invalid-vault-allocation')
  assert.throws(() => writeVaultAllocation({ workspaceRoot: w.workspaceRoot, allocation: { ...allocation, parent: w.dir } }), (error) => error.code === 'invalid-vault-allocation')
})

test('the checks see through links and letter case: a folder reached through a link into a listed or synced vault is refused, whichever side is spelled which way', { skip: POSIX ? false : 'links need privileges on Windows' }, (t) => {
  const w = world(t)
  const check = (parent, extra = {}) => { try { return checkVaultParent({ parent, workspaceRoot: w.workspaceRoot, repositoryRoots: w.repositoryRoots, ...extra }) } catch (error) { return error.code } }
  // An Obsidian vault kept in iCloud, listed by the app, and a link to it in the home folder.
  const home = path.join(w.dir, 'home')
  const icloudVault = path.join(home, 'Library', 'Mobile Documents', 'iCloud~md~obsidian', 'Documents', 'Field Notes')
  fs.mkdirSync(icloudVault, { recursive: true })
  fs.symlinkSync(icloudVault, path.join(home, 'vault'))
  const listed = { aaaaaaaaaaaaaaaa: { path: icloudVault, ts: 1 } }
  // The location does not exist yet, below the link.
  assert.equal(check(path.join(home, 'vault', 'atelier'), { vaults: listed, homedir: home }), 'vault-location-inside-vault')
  // Without a list, the sync client is still seen through the link, and asks for consent.
  assert.equal(check(path.join(home, 'vault', 'atelier'), { homedir: home }), 'vault-location-synced')
  assert.deepEqual(check(path.join(home, 'vault', 'atelier'), { homedir: home, allowSynced: true }), { synced: 'iCloud Drive', protected: null })
  // The listed entry spelled through a link, the location through the real path.
  fs.symlinkSync(path.dirname(icloudVault), path.join(w.dir, 'docs-link'))
  assert.equal(check(path.join(icloudVault, 'atelier'), { vaults: { bbbbbbbbbbbbbbbb: { path: path.join(w.dir, 'docs-link', 'Field Notes') } }, homedir: home, allowSynced: true }), 'vault-location-inside-vault')
  // Another letter case of a listed folder, existing or not.
  const notes = path.join(w.dir, 'Notes')
  fs.mkdirSync(notes)
  const byCase = { cccccccccccccccc: { path: notes } }
  assert.equal(check(path.join(w.dir, 'notes', 'Atelier'), { vaults: byCase }), 'vault-location-inside-vault')
  assert.equal(check(path.join(w.dir, 'NOTES'), { vaults: byCase }), 'vault-location-inside-vault')
  // A home folder reached through a link.
  fs.symlinkSync(home, path.join(w.dir, 'home-link'))
  assert.equal(check(path.join(w.dir, 'home-link', 'Library', 'mobile documents', 'x'), { homedir: home }), 'vault-location-synced')
  // A published Atelier vault reached through a link.
  const published = path.join(w.dir, 'published vault')
  fs.mkdirSync(path.join(published, '.atelier-publication'), { recursive: true })
  fs.symlinkSync(published, path.join(w.dir, 'published-link'))
  assert.equal(check(path.join(w.dir, 'published-link', 'inner', 'deeper')), 'vault-location-inside-vault')

  // An allocation below a link records the real folder, so the link leads nowhere else later.
  fs.mkdirSync(path.join(w.dir, 'real-parent'))
  fs.symlinkSync(path.join(w.dir, 'real-parent'), path.join(w.dir, 'parent-link'))
  const allocation = ensureVaultAllocation({ workspaceRoot: w.workspaceRoot, workspaceId: WORKSPACE_ID, scopeId: 'everything', location: { parent: path.join(w.dir, 'parent-link', 'vaults') }, projectName: 'harbor-notes', repositoryRoots: w.repositoryRoots, now: NOW })
  assert.deepEqual([allocation.parent, allocation.path], [path.join(w.dir, 'real-parent', 'vaults'), path.join(w.dir, 'real-parent', 'vaults', 'harbor-notes (everything)')])
  const store = createRecoveryStore({ workspaceRoot: w.workspaceRoot, workspaceId: WORKSPACE_ID, scopeId: 'everything', repositoryRoots: w.repositoryRoots })
  assert.deepEqual([store.vaultRoot, store.managedVaultRoot], [allocation.path, true])
  // A listed name in another letter case or normalization is taken.
  const taken = ensureVaultAllocation({ workspaceRoot: w.workspaceRoot, workspaceId: WORKSPACE_ID, scopeId: 'tides', location: { parent: path.join(w.dir, 'real-parent') }, projectName: 'Café', repositoryRoots: w.repositoryRoots, vaults: { dddddddddddddddd: { path: path.join(TMP, 'x', 'CAFÉ (TIDES)') } }, now: NOW })
  assert.equal(taken.name, 'Café (tides 2)')
})
