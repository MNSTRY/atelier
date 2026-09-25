import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { atomicReplacePrivateText, ensureContainedPrivateDirectory, readRegularTextNoFollow } from '../../project/private-state.mjs'
import { canonicalJson, closedObject, isoTime } from './documents.mjs'
import { refuse } from './errors.mjs'
import { ensureServiceSettings } from './lifecycle.mjs'
import { ensureWorkspaceIdentity } from './machine-settings.mjs'
import { SERVICE_MANAGER_KINDS } from './service-managers.mjs'
import { readLastStartup, readServiceSettings, serviceNameFor, servicePaths, writeServiceSettings } from './service-record.mjs'
import { resolveServiceWorkspace } from './service.mjs'
import { STARTUP_PLATFORMS, buildStartupAdapter, startupSearchPath } from './startup-adapters.mjs'

// A login item: the operating system starts this workspace's maintenance
// service when the person logs in, so a vault is fresh after a restart
// without anything being run.
//
//   macOS  a launchd user agent: ~/Library/LaunchAgents/ai.mnstry.atelier.<project>.<workspace-id>.plist
//   Linux  a systemd user unit:  ~/.config/systemd/user/atelier-obsidian-<workspace-id>.service
//   Windows not offered (startup-platform-unqualified)
//
// One per workspace, each with its own label, port, log and consent, each
// running its own project's installed release. The unit runs the service
// entry of the package installed in the project, named by its path, so an
// upgrade in the project is what the next start runs; the Node that ran the
// installing command, by its real path, so a per-shell link of a version
// manager is never named; the search path the person had then, absolute
// entries only; and `--startup`, under which the service refuses to run
// without a consent that covers startup.
//
// Installing records that consent first, since the manager starts the
// service as soon as it loads the unit, then hands the text to the injected
// service manager (service-managers.mjs) and keeps
//
//   state/service/login-item.json   atelier-obsidian-login-item/v1
//
// { label, file, digest of the text, program: { node, entry }, searchPath }.
// The label is allocated once and kept. Once installed, the service is
// started through the manager (loginItemStarter), never as a child beside
// it; a unit that differs from what would be written now (a Node that was
// removed, another entry, an earlier release's format) is written again on
// that way and reloaded, keeping the search path recorded at installation.
// Removing lowers the consent to the service alone first, so a unit left
// behind by a failed removal could only refuse, then removes the unit and
// the record. A person who switched the item off in System Settings is not
// overridden: the manager does not start it, and the service is started as
// a child for that command only.

export const LOGIN_ITEM_SCHEMA = 'atelier-obsidian-login-item/v1'
export const LOGIN_ITEM_PACKAGE = '@mnstry/atelier'
const ENTRY_IN_PACKAGE = Object.freeze(['src', 'runtime', 'obsidian', 'service-main.mjs'])
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const DIGEST = /^sha256:[0-9a-f]{64}$/
const CONTROL = /[\u0000-\u001f\u007f]/
// A package runner's cache: npx, pnpm dlx, bunx. A package there can be removed by the runner at any time.
const RUNNER_CACHES = Object.freeze([/[\\/]_npx[\\/]/, /[\\/]pnpm[\\/]dlx[\\/]/, /[\\/]\.bun[\\/]install[\\/]cache[\\/]/])

const sha256 = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`
const isAbsolutePlain = (value) => typeof value === 'string' && path.isAbsolute(value) && !CONTROL.test(value)

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

function validateLoginItem(document, workspaceId) {
  const code = 'invalid-login-item'
  closedObject(document, { required: ['schema', 'workspaceId', 'kind', 'label', 'file', 'digest', 'program', 'searchPath', 'installedAt', 'updatedAt'] }, code, 'the login item record')
  closedObject(document.program, { required: ['node', 'entry'] }, code, 'the program of the login item')
  const ok = document.schema === LOGIN_ITEM_SCHEMA && document.workspaceId === workspaceId && SERVICE_MANAGER_KINDS.includes(document.kind)
    && typeof document.label === 'string' && IDENTIFIER.test(document.label) && isAbsolutePlain(document.file) && path.basename(document.file).startsWith(document.label)
    && typeof document.digest === 'string' && DIGEST.test(document.digest) && isAbsolutePlain(document.program.node) && isAbsolutePlain(document.program.entry)
    && (document.searchPath === null || (typeof document.searchPath === 'string' && document.searchPath.split(':').every(isAbsolutePlain)))
    && TIMESTAMP.test(document.installedAt) && TIMESTAMP.test(document.updatedAt)
  if (!ok) refuse(code, 'the login item record is malformed')
  return document
}

export function readLoginItemRecord({ workspaceRoot, workspaceId }) {
  let text
  try { text = readRegularTextNoFollow(servicePaths(workspaceRoot).loginItem) } catch (error) {
    if (error.code === 'ENOENT') return null
    return refuse('invalid-login-item', 'the login item record cannot be read', { cause: error.code ?? 'unreadable' })
  }
  let document
  try { document = JSON.parse(text) } catch { return refuse('invalid-login-item', 'the login item record is not JSON') }
  return validateLoginItem(document, workspaceId)
}

function writeLoginItemRecord({ workspaceRoot, workspaceId, record }) {
  validateLoginItem(record, workspaceId)
  const directory = ensureContainedPrivateDirectory({ workspaceRoot, directory: servicePaths(workspaceRoot).directory, label: 'Obsidian service state' })
  atomicReplacePrivateText(path.join(directory, 'login-item.json'), canonicalJson(record))
  return record
}

function removeLoginItemRecord({ workspaceRoot }) {
  try { fs.unlinkSync(servicePaths(workspaceRoot).loginItem); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

// ---------------------------------------------------------------------------
// What a unit is made of
// ---------------------------------------------------------------------------

// The part of a launchd label that stands for the project: lower-case letters, digits and dashes, at most 40, from
// its name, so a person who looks in ~/Library/LaunchAgents can tell whose it is. Pure.
export function labelSlug(name) {
  const slug = String(name ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')
  return slug === '' ? 'project' : slug
}

// The label of this workspace's login item, as it is allocated the first time. Pure.
export function loginItemLabel({ platform, projectName, workspaceId }) {
  const id = String(workspaceId).replaceAll(':', '_')
  return platform === 'darwin' ? `ai.mnstry.atelier.${labelSlug(projectName)}.${id}` : serviceNameFor(workspaceId).replaceAll(':', '_')
}

// The name people read for a project: its configured `name`, else the name of its folder.
export const projectNameOf = (project) => (typeof project?.config?.name === 'string' && project.config.name.trim() !== '' ? project.config.name : path.basename(project?.configDir ?? 'project'))

// Absolute folders whose contents do not outlive a restart, or not for long.
export function temporaryRoots({ tmpdir = os.tmpdir() } = {}) {
  const roots = new Set(['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp'])
  if (isAbsolutePlain(tmpdir)) { roots.add(path.resolve(tmpdir)); try { roots.add(fs.realpathSync(tmpdir)) } catch { /* only as given */ } }
  return [...roots]
}

const inside = (file, root) => file === root || file.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`)
const isFile = (file) => { try { return fs.statSync(file).isFile() } catch { return false } }

// The entry a login item runs: the service entry of the package installed for this project, found as Node finds a
// package from the project's folder (in its node_modules or a folder's above), named by that path and not its real
// path, so an upgrade in place is what the next start runs; else `ownEntry`, the entry of the package this command
// runs from, unless that one is in a package runner's cache (npx) or a temporary folder, which are gone after a
// restart (`login-item-needs-installed-package`). { entryPath, source: 'project' | 'command' }.
export function resolveLoginItemEntry({ project, ownEntry, temporary = temporaryRoots(), exists = isFile } = {}) {
  if (typeof project?.configDir === 'string' && path.isAbsolute(project.configDir)) {
    for (let directory = path.resolve(project.configDir); ; directory = path.dirname(directory)) {
      const candidate = path.join(directory, 'node_modules', ...LOGIN_ITEM_PACKAGE.split('/'), ...ENTRY_IN_PACKAGE)
      if (exists(candidate)) return { entryPath: candidate, source: 'project' }
      if (path.dirname(directory) === directory) break
    }
  }
  const transient = typeof ownEntry !== 'string' || !path.isAbsolute(ownEntry) || RUNNER_CACHES.some((pattern) => pattern.test(ownEntry)) || temporary.some((root) => inside(path.resolve(ownEntry), root))
  if (transient) refuse('login-item-needs-installed-package', 'a login item runs the package installed in the project, and this project has none; the command runs from a package runner\'s cache or a temporary folder, which may be gone after a restart')
  return { entryPath: ownEntry, source: 'command' }
}

// The Node a unit names: the one running this command, by its real path.
export const realNodePath = (execPath = process.execPath) => { try { return fs.realpathSync(execPath) } catch { return execPath } }

// The unit this workspace's login item would have now. `entryArgs` follow `--project` and `--data-root`. Pure but
// for the builder's refusals.
export function planLoginItem({ platform, project, workspaceRoot, dataRoot, label, entryPath, entryArgs = [], nodePath, searchPath = null }) {
  const args = [`--project=${project.configPath}`, ...(dataRoot === undefined ? [] : [`--data-root=${dataRoot}`]), ...entryArgs]
  const unit = buildStartupAdapter({ platform, label, nodePath, entryPath, args, logPath: servicePaths(workspaceRoot).loginItemLog, searchPath })
  return { ...unit, label, digest: sha256(unit.text), program: { node: nodePath, entry: entryPath }, searchPath }
}

function checkManager(manager, platform) {
  if (!STARTUP_PLATFORMS.includes(platform)) buildStartupAdapter({ platform })
  const operations = ['readUnit', 'install', 'start', 'remove', 'inspect']
  if (manager === null || typeof manager !== 'object' || !operations.every((name) => typeof manager[name] === 'function') || !SERVICE_MANAGER_KINDS.includes(manager.kind)) {
    throw new TypeError('a login item needs an injected service manager')
  }
  if (manager.platform !== platform) throw new TypeError('the service manager is not this platform\'s')
}

// ---------------------------------------------------------------------------
// Install, remove, start through it, and what it looks like
// ---------------------------------------------------------------------------

// Installs, or installs again, this workspace's login item. `consent` ({ actor }) is the person's consent to the
// service running at login; without it, a recorded consent must already cover startup (`startup-consent-required`).
// `ownEntry` and `entryArgs` are the entry this command would start and its arguments (`--adapter=...`).
// { installed: true, label, file, kind, entry: { path, source }, node, searchPath } or, when the manager did not take
// the unit, { installed: false, reason, label } with the consent as it was.
export async function installLoginItem(options = {}) {
  const { loadProject, dataRoot, env = process.env, platform = process.platform, manager, consent, ownEntry, entryArgs = [], nodePath = realNodePath(), pathValue = env.PATH, clock = () => new Date(), temporary = temporaryRoots() } = options
  checkManager(manager, platform)
  const project = loadProject()
  ensureWorkspaceIdentity({ project, ...(dataRoot === undefined ? {} : { dataRoot }) })
  const workspace = resolveServiceWorkspace({ project, dataRoot, env, platform, create: true })
  const { entryPath, source } = resolveLoginItemEntry({ project, ownEntry, temporary })
  const recorded = readLoginItemRecord(workspace)
  const label = recorded?.label ?? loginItemLabel({ platform, projectName: projectNameOf(project), workspaceId: workspace.workspaceId })
  const plan = planLoginItem({ platform, project, workspaceRoot: workspace.workspaceRoot, dataRoot, label, entryPath, entryArgs, nodePath, searchPath: startupSearchPath(pathValue, { temporary }) })

  // The consent first: the manager starts the service as soon as it loads the unit.
  const now = isoTime(clock)
  const before = readServiceSettings(workspace)
  if (consent === undefined && before?.consent.coverage !== 'service-and-startup') refuse('startup-consent-required', 'a login item needs a consent that covers the service starting at login; name who gives it')
  if (consent !== undefined && (typeof consent?.actor !== 'string' || consent.actor === '')) refuse('startup-consent-required', 'a consent names its actor')
  await ensureServiceSettings(workspace, { consent: consent === undefined ? undefined : { actor: consent.actor, coverage: 'service-and-startup' }, now })

  const installed = await manager.install({ label, fileName: plan.fileName, text: plan.text })
  if (!installed.ok) {
    restoreConsent(workspace, before, now)
    return { installed: false, reason: installed.code, label, message: installed.message ?? null }
  }
  writeLoginItemRecord({
    ...workspace,
    record: { schema: LOGIN_ITEM_SCHEMA, workspaceId: workspace.workspaceId, kind: manager.kind, label, file: installed.file, digest: plan.digest, program: plan.program, searchPath: plan.searchPath, installedAt: recorded?.installedAt ?? now, updatedAt: now },
  })
  return { installed: true, label, file: installed.file, kind: manager.kind, entry: { path: entryPath, source }, node: nodePath, searchPath: plan.searchPath }
}

// Back to the consent that was recorded before an installation the manager refused: the service may still run, as a
// child, under the consent it had.
function restoreConsent(workspace, before, now) {
  const current = readServiceSettings(workspace)
  if (current === null) return
  const consent = before?.consent ?? { ...current.consent, coverage: 'service' }
  if (JSON.stringify(consent) !== JSON.stringify(current.consent)) writeServiceSettings({ ...workspace, settings: { ...current, consent, updatedAt: now } })
}

// Removes this workspace's login item: the consent is lowered to the service alone first, then the manager unloads
// and deletes the unit (a service it runs is stopped as it stops it), then the record goes. { removed, label, file }
// or { removed: false, reason } when the manager kept it.
export async function removeLoginItem(options = {}) {
  const { loadProject, dataRoot, env = process.env, platform = process.platform, manager, clock = () => new Date() } = options
  checkManager(manager, platform)
  const project = loadProject()
  const workspace = resolveServiceWorkspace({ project, dataRoot, env, platform })
  if (!workspace?.workspaceRoot) return { removed: false, reason: 'workspace-not-prepared' }
  const record = readLoginItemRecord(workspace)
  const label = record?.label ?? loginItemLabel({ platform, projectName: projectNameOf(project), workspaceId: workspace.workspaceId })
  const fileName = record === null ? `${label}${manager.kind === 'launchd-user-agent' ? '.plist' : '.service'}` : path.basename(record.file)
  const now = isoTime(clock)
  const settings = readServiceSettings(workspace)
  if (settings?.consent.coverage === 'service-and-startup') await ensureServiceSettings(workspace, { consent: { actor: settings.consent.actor, coverage: 'service' }, now })
  const removed = await manager.remove({ label, fileName })
  if (!removed.ok) return { removed: false, reason: removed.code, label, message: removed.message ?? null }
  removeLoginItemRecord(workspace)
  return { removed: removed.removed === true || record !== null, label, file: manager.fileFor(fileName) }
}

// The unit this workspace's installed login item would have now, keeping its label and the search path recorded when
// it was installed; null when no entry for it can be found from here (the command runs from a package runner and the
// project has no package installed): what is installed then stays as it is.
export function currentLoginItemPlan({ record, project, workspaceRoot, dataRoot, platform, ownEntry, entryArgs = [], nodePath = realNodePath(), temporary = temporaryRoots() }) {
  try {
    const { entryPath } = resolveLoginItemEntry({ project, ownEntry, temporary })
    return planLoginItem({ platform, project, workspaceRoot, dataRoot, label: record.label, entryPath, entryArgs, nodePath, searchPath: record.searchPath })
  } catch (error) {
    if (error?.code === 'login-item-needs-installed-package' || error?.code === 'startup-adapter-input-invalid') return null
    throw error
  }
}

// { entryPath, start() } for startService: the entry the item runs, and a start through its manager. A unit that
// differs from `plan` is written again and reloaded first (the answer then carries `refreshed: true`); a unit whose
// file is gone was removed by somebody and is not put back.
export function loginItemStarter({ workspace, manager, record, plan = null, clock = () => new Date() }) {
  const fileName = path.basename(record.file)
  let entryPath = record.program.entry
  return {
    get entryPath() { return entryPath },
    async start() {
      let refreshed = false
      const text = manager.readUnit({ label: record.label, fileName })
      if (text === null) return { ok: false, code: 'login-item-file-missing', refreshed }
      if (plan !== null && plan.fileName === fileName && text !== plan.text) {
        const installed = await manager.install({ label: record.label, fileName, text: plan.text })
        if (!installed.ok) return { ok: false, code: installed.code, refreshed }
        writeLoginItemRecord({ ...workspace, record: { ...record, file: installed.file, digest: plan.digest, program: plan.program, updatedAt: isoTime(clock) } })
        entryPath = plan.program.entry
        refreshed = true
      }
      const started = await manager.start({ label: record.label, fileName })
      return { ...started, refreshed, entryPath }
    },
  }
}

// What this workspace's login item looks like: the record, what the manager says about it, and how the last start by
// it ended. `manager` is a manager, or a function that answers one (asked only when an item is recorded), or null
// (it cannot be asked from here): the record alone is reported then.
//   state  loaded | not-loaded | switched-off | file-missing | unknown
export async function loginItemStatus({ workspace, manager: given = null }) {
  const lastStartup = (() => { try { return readLastStartup(workspace) } catch { return null } })()
  let record
  try { record = readLoginItemRecord(workspace) } catch (error) { return { installed: null, reason: error.code ?? 'invalid-login-item', lastStartup } }
  if (record === null) return { installed: false, lastStartup }
  // A unit whose entry or Node is gone cannot start: its manager tries again every minute until it is removed or installed again.
  const present = (file) => { try { return fs.statSync(file).isFile() } catch { return false } }
  const shown = {
    installed: true, label: record.label, file: record.file, kind: record.kind, entry: record.program.entry, node: record.program.node, installedAt: record.installedAt,
    programPresent: present(record.program.entry) && present(record.program.node), lastStartup,
  }
  const manager = typeof given === 'function' ? await given() : given
  if (manager === null) return { ...shown, state: 'unknown', inspected: false }
  const fileName = path.basename(record.file)
  let seen = null
  try { seen = await manager.inspect({ label: record.label, fileName }) } catch { seen = null }
  let text = null
  try { text = manager.readUnit({ label: record.label, fileName }) } catch { text = null }
  const state = seen === null || seen.ok !== true ? 'unknown'
    : seen.present === false ? 'file-missing'
      : seen.disabled === true ? 'switched-off'
        : seen.loaded === true ? 'loaded'
          : seen.loaded === false ? 'not-loaded' : 'unknown'
  return { ...shown, state, inspected: true, running: seen?.running ?? null, pid: seen?.pid ?? null, lastExit: seen?.lastExit ?? null, changedOnDisk: typeof text === 'string' && sha256(text) !== record.digest }
}
