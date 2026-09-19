import { randomBytes as cryptoRandomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LOCAL_STATE_DIR, localStateRoot } from '../../project/config.mjs'
import { checkManagedRoots } from '../../project/file-class.mjs'
import { atomicReplacePrivateText, ensureContainedPrivateDirectory, readRegularTextNoFollow } from '../../project/private-state.mjs'
import { OBSIDIAN_EXT_KEY, ObsidianContractRefusal, assertObsidianContract } from '../../projection/obsidian/contracts.mjs'
import { refuse } from './errors.mjs'
import { canonicalJson, closedObject, isPlainObject } from './documents.mjs'

// Machine-private settings of the Obsidian maintenance runtime.
//
//   <data>/obsidian/<workspace-id>/state/settings/machine.json       mode, audiences, policy reference
//   <data>/obsidian/<workspace-id>/state/settings/apply-policy.json  the installed apply policy
//   <project>/.atelier-local/obsidian.json                           pointer: workspace id, optional data root
//
// Nothing here is project configuration and nothing here is ever serialized
// into a note. The data directory sits outside every enrolled repository. The
// pointer is the one ignored file a project gains: it holds the persisted
// random workspace identity (never a hash of a checkout path, so moving a
// checkout keeps its vaults) and, optionally, where this machine keeps the
// data directory.

export const MACHINE_SETTINGS_SCHEMA = 'atelier-obsidian-machine-settings/v1'
export const LOCAL_POINTER_SCHEMA = 'atelier-obsidian-local-pointer/v1'
export const LOCAL_POINTER_FILE = 'obsidian.json'
export const MAINTENANCE_MODES = Object.freeze(['manual', 'automatic'])

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const DIGEST = /^sha256:[0-9a-f]{64}$/
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/

const segment = (identifier) => identifier.replaceAll(':', '_')

// ---------------------------------------------------------------------------
// Where the data directory is
// ---------------------------------------------------------------------------

// Pure: computes a path from its arguments and touches nothing.
export function defaultDataRoot({ platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  const flavor = platform === 'win32' ? path.win32 : path.posix
  const absolute = (value) => typeof value === 'string' && value !== '' && flavor.isAbsolute(value)
  if (platform === 'win32') {
    if (!absolute(env.LOCALAPPDATA)) refuse('data-root-unresolvable', 'LOCALAPPDATA does not name an absolute directory')
    return flavor.join(env.LOCALAPPDATA, 'Atelier')
  }
  if (!absolute(homedir)) refuse('data-root-unresolvable', 'the home directory is not an absolute path')
  if (platform === 'darwin') return flavor.join(homedir, 'Library', 'Application Support', 'Atelier')
  // A relative XDG_DATA_HOME is invalid by its specification and is ignored.
  return flavor.join(absolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : flavor.join(homedir, '.local', 'share'), 'atelier')
}

// The data root for this run: an injected root, else the project's pointer,
// else the local overlay preference, else the platform default. Pure. Under
// the Node test runner the platform default refuses, so a test that forgot to
// inject a root can never reach a person's real data directory.
export function resolveDataRoot({ dataRoot, pointer = null, project = null, platform = process.platform, env = process.env, homedir } = {}) {
  const preference = project?.localOverlay?.overlay?.preferences?.[OBSIDIAN_EXT_KEY]
  const configured = dataRoot ?? pointer?.dataRoot ?? (isPlainObject(preference) ? preference.dataRoot : undefined)
  if (configured !== undefined) {
    if (typeof configured !== 'string' || !path.isAbsolute(configured)) refuse('data-root-not-absolute', 'a configured data root must be an absolute path')
    return path.resolve(configured)
  }
  if (env.NODE_TEST_CONTEXT !== undefined) refuse('real-data-root-under-test', 'the platform data directory is never used under the test runner; inject a data root')
  return defaultDataRoot({ platform, env, ...(homedir === undefined ? {} : { homedir }) })
}

export function workspaceStateRoot(dataRoot, workspaceId) {
  if (typeof workspaceId !== 'string' || !IDENTIFIER.test(workspaceId)) refuse('invalid-workspace-identity', 'a workspace identity must be a contract identifier')
  return path.join(dataRoot, 'obsidian', segment(workspaceId))
}

// Every enrolled repository root plus the directories the project itself
// occupies. Private state may overlap none of them, in either direction.
export function protectedRoots(project) {
  const roots = new Set()
  for (const repo of project?.repos ?? []) if (!repo.external && typeof repo.path === 'string') roots.add(path.resolve(repo.path))
  if (typeof project?.configDir === 'string') roots.add(path.resolve(project.configDir))
  return [...roots].sort()
}

export function assertOutsideRepositories({ managedRoot, repositoryRoots }) {
  const guard = checkManagedRoots({ managedRoots: [managedRoot], repositoryRoots })
  if (!guard.ok) refuse(guard.refusals[0].code, guard.refusals[0].message, { refusals: guard.refusals.map(({ code }) => code) })
}

// ---------------------------------------------------------------------------
// The pointer a project keeps in its ignored local state
// ---------------------------------------------------------------------------

function validatePointer(document) {
  closedObject(document, { required: ['schema', 'workspaceId'], optional: ['dataRoot'] }, 'invalid-local-pointer', 'the Obsidian pointer')
  if (document.schema !== LOCAL_POINTER_SCHEMA) refuse('invalid-local-pointer', 'the Obsidian pointer names an unknown schema')
  if (typeof document.workspaceId !== 'string' || !IDENTIFIER.test(document.workspaceId)) refuse('invalid-local-pointer', 'the Obsidian pointer carries no usable workspace identity')
  if (document.dataRoot !== undefined && (typeof document.dataRoot !== 'string' || !path.isAbsolute(document.dataRoot))) {
    refuse('invalid-local-pointer', 'the Obsidian pointer names a data root that is not an absolute path')
  }
  return document
}

export const localPointerPath = (project) => path.join(localStateRoot(project), LOCAL_POINTER_FILE)

function readJsonFile(file, code, label) {
  let text
  try { text = readRegularTextNoFollow(file) } catch (error) {
    if (error.code === 'ENOENT') return null
    refuse(code, `${label} cannot be read`, { cause: error.code ?? String(error.message) })
  }
  try { return JSON.parse(text) } catch { return refuse(code, `${label} is not JSON`) }
}

export function readLocalPointer(project) {
  const document = readJsonFile(localPointerPath(project), 'invalid-local-pointer', 'the Obsidian pointer')
  return document === null ? null : validatePointer(document)
}

// The pointer is written only where the project's local state is proven
// ignored, so a machine-local value can never be committed by accident.
export function writeLocalPointer(project, pointer) {
  validatePointer(pointer)
  if (project?.localState?.ignored !== true) refuse('local-state-not-ignored', `${LOCAL_STATE_DIR}/ is not ignored in this project; the Obsidian pointer is not written`)
  const directory = ensureContainedPrivateDirectory({ workspaceRoot: project.configDir, directory: localStateRoot(project), label: 'project local state' })
  atomicReplacePrivateText(path.join(directory, LOCAL_POINTER_FILE), canonicalJson(pointer))
  return pointer
}

// Reads the persisted workspace identity, or issues a random one and persists
// it. `randomBytes` is injectable so tests are deterministic.
export function ensureWorkspaceIdentity({ project, dataRoot, randomBytes = cryptoRandomBytes } = {}) {
  const existing = readLocalPointer(project)
  if (existing) return existing
  const pointer = { schema: LOCAL_POINTER_SCHEMA, workspaceId: `ws-${randomBytes(12).toString('hex')}`, ...(dataRoot === undefined ? {} : { dataRoot: path.resolve(dataRoot) }) }
  return writeLocalPointer(project, pointer)
}

// ---------------------------------------------------------------------------
// Machine settings
// ---------------------------------------------------------------------------

function validateMachineSettings(document, workspaceId) {
  closedObject(document, { required: ['schema', 'workspaceId', 'maintenanceMode', 'audienceAllow', 'applyPolicy', 'updatedAt'] }, 'invalid-machine-settings', 'machine settings')
  if (document.schema !== MACHINE_SETTINGS_SCHEMA) refuse('invalid-machine-settings', 'machine settings name an unknown schema')
  if (document.workspaceId !== workspaceId) refuse('invalid-machine-settings', 'machine settings belong to another workspace')
  if (!MAINTENANCE_MODES.includes(document.maintenanceMode)) refuse('invalid-machine-settings', 'maintenanceMode must be manual or automatic')
  if (!Array.isArray(document.audienceAllow) || document.audienceAllow.length > 64 || document.audienceAllow.some((item) => typeof item !== 'string' || !IDENTIFIER.test(item))
    || new Set(document.audienceAllow).size !== document.audienceAllow.length) {
    refuse('invalid-machine-settings', 'audienceAllow must be a list of distinct audience identifiers')
  }
  if (document.applyPolicy !== null) {
    closedObject(document.applyPolicy, { required: ['policyId', 'version', 'digest'] }, 'invalid-machine-settings', 'the apply policy reference')
    const { policyId, version, digest } = document.applyPolicy
    if (typeof policyId !== 'string' || !IDENTIFIER.test(policyId) || !Number.isInteger(version) || version < 1 || typeof digest !== 'string' || !DIGEST.test(digest)) {
      refuse('invalid-machine-settings', 'the apply policy reference is malformed')
    }
  }
  if (typeof document.updatedAt !== 'string' || !TIMESTAMP.test(document.updatedAt)) refuse('invalid-machine-settings', 'updatedAt must be a UTC timestamp')
  return document
}

// The defaults fail closed: edits are only queued, no audience is visible and
// no apply policy is installed until the person says otherwise.
export function defaultMachineSettings({ workspaceId, updatedAt }) {
  return { schema: MACHINE_SETTINGS_SCHEMA, workspaceId, maintenanceMode: 'manual', audienceAllow: [], applyPolicy: null, updatedAt }
}

const settingsDirectory = (workspaceRoot) => ensureContainedPrivateDirectory({ workspaceRoot, directory: path.join(workspaceRoot, 'state', 'settings'), label: 'Obsidian machine settings' })
const settingsFile = (workspaceRoot, name) => path.join(workspaceRoot, 'state', 'settings', name)

export function readMachineSettings({ workspaceRoot, workspaceId }) {
  const document = readJsonFile(settingsFile(workspaceRoot, 'machine.json'), 'invalid-machine-settings', 'machine settings')
  return document === null ? null : validateMachineSettings(document, workspaceId)
}

export function writeMachineSettings({ workspaceRoot, workspaceId, settings, repositoryRoots }) {
  validateMachineSettings(settings, workspaceId)
  assertOutsideRepositories({ managedRoot: workspaceRoot, repositoryRoots })
  fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 })
  atomicReplacePrivateText(path.join(settingsDirectory(workspaceRoot), 'machine.json'), canonicalJson(settings))
  return settings
}

// ---------------------------------------------------------------------------
// Installed apply policy
// ---------------------------------------------------------------------------

export function installApplyPolicy({ workspaceRoot, workspaceId, policy, repositoryRoots, updatedAt }) {
  try { assertObsidianContract('apply-policy', policy) } catch (error) {
    if (error instanceof ObsidianContractRefusal) refuse('invalid-apply-policy', 'the apply policy does not satisfy its contract', { errors: error.detail?.errors ?? [] })
    throw error
  }
  if (policy.workspaceId !== workspaceId) refuse('invalid-apply-policy', 'the apply policy belongs to another workspace')
  const current = readMachineSettings({ workspaceRoot, workspaceId }) ?? defaultMachineSettings({ workspaceId, updatedAt })
  assertOutsideRepositories({ managedRoot: workspaceRoot, repositoryRoots })
  fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 })
  atomicReplacePrivateText(path.join(settingsDirectory(workspaceRoot), 'apply-policy.json'), canonicalJson(policy))
  return writeMachineSettings({ workspaceRoot, workspaceId, repositoryRoots, settings: { ...current, applyPolicy: { policyId: policy.policyId, version: policy.version, digest: policy.digest }, updatedAt } })
}

// Whether an automatic dispatch is authorized right now. Reads both files
// from disk on every call; the engine calls this immediately before each
// dispatch, so a revocation or a pause takes effect for the very next edit.
// Anything missing, malformed or mismatched is "not authorized", never an
// error that could be mistaken for permission.
// `assumeAutomatic` answers "would automatic mode be authorized": the check `mode set automatic` makes before it writes.
export function authorizeAutomaticApply({ workspaceRoot, workspaceId, assumeAutomatic = false }) {
  const denied = (reason) => ({ authorized: false, reason, policy: null })
  let settings
  try { settings = readMachineSettings({ workspaceRoot, workspaceId }) } catch { return denied('machine-settings-invalid') }
  if (!settings) return denied('machine-settings-absent')
  if (settings.maintenanceMode !== 'automatic' && assumeAutomatic !== true) return denied('maintenance-mode-manual')
  if (settings.applyPolicy === null) return denied('no-apply-policy-installed')
  let policy
  try {
    policy = readJsonFile(settingsFile(workspaceRoot, 'apply-policy.json'), 'invalid-apply-policy', 'the apply policy')
    if (policy !== null) assertObsidianContract('apply-policy', policy)
  } catch { return denied('apply-policy-invalid') }
  if (policy === null) return denied('apply-policy-absent')
  const reference = settings.applyPolicy
  if (policy.workspaceId !== workspaceId || policy.policyId !== reference.policyId || policy.version !== reference.version || policy.digest !== reference.digest) {
    return denied('apply-policy-reference-mismatch')
  }
  if (policy.mode !== 'automatic') return denied('apply-policy-manual')
  if (policy.status !== 'active') return denied(`apply-policy-${policy.status}`)
  return { authorized: true, reason: 'apply-policy-active', policy }
}

// The installed policy as stored, validated, or null. A stored policy that does not validate refuses.
export function readInstalledApplyPolicy({ workspaceRoot, workspaceId }) {
  const policy = readJsonFile(settingsFile(workspaceRoot, 'apply-policy.json'), 'invalid-apply-policy', 'the apply policy')
  if (policy === null) return null
  try { assertObsidianContract('apply-policy', policy) } catch (error) {
    if (error instanceof ObsidianContractRefusal) refuse('invalid-apply-policy', 'the stored apply policy does not satisfy its contract', { errors: error.detail?.errors ?? [] })
    throw error
  }
  if (policy.workspaceId !== workspaceId) refuse('invalid-apply-policy', 'the stored apply policy belongs to another workspace')
  return policy
}

// Revocation. The stored policy is marked revoked first: from that write on, every authorization read denies, so an
// apply that is queued behind it is never dispatched. Then maintenance goes back to manual, so installing a policy
// later does not resume automatic apply by itself.
export function revokeApplyPolicy({ workspaceRoot, workspaceId, repositoryRoots, updatedAt }) {
  const policy = readInstalledApplyPolicy({ workspaceRoot, workspaceId })
  const current = readMachineSettings({ workspaceRoot, workspaceId })
  if (policy === null && (current === null || current.applyPolicy === null)) return { revoked: false, reason: 'no-apply-policy-installed', policy: null }
  assertOutsideRepositories({ managedRoot: workspaceRoot, repositoryRoots })
  const revoked = policy === null ? null : { ...policy, status: 'revoked' }
  if (revoked !== null) atomicReplacePrivateText(path.join(settingsDirectory(workspaceRoot), 'apply-policy.json'), canonicalJson(revoked))
  if (current !== null) writeMachineSettings({ workspaceRoot, workspaceId, repositoryRoots, settings: { ...current, maintenanceMode: 'manual', updatedAt } })
  return { revoked: true, reason: policy?.status === 'revoked' ? 'already-revoked' : 'revoked', policy: revoked }
}
