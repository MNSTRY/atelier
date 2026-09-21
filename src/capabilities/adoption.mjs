import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { syncPrivateDirectory } from '../project/private-state.mjs'
import { assertDocument, HOST_PROFILES, projectSkill, unique, verifyCapabilityRelease } from './package.mjs'
import { canonical, currentTree, digest, jsonAt, jsonText, objectDigest, replaceJson, stat, tree, within, workspaceRoot, writeNew } from './files.mjs'

export const CAPABILITY_STATE = '.atelier-local/capabilities/state.json'
const ACTIVE = '.atelier-local/capabilities/active.json'
const OPERATION_LOCK = '.atelier-local/skill-steward/.operation.lock'
const TX = '.atelier-local/capabilities/transactions'

export function readCapabilityState(root) {
  const file = within(root, CAPABILITY_STATE)
  if (!stat(file)) return null
  const state = assertDocument(jsonAt(root, CAPABILITY_STATE), 'state')
  if (state.workspace !== digest(root)) throw new Error('capability state belongs to a different workspace')
  unique(state.packages.map(item => item.id), 'installed package')
  unique(state.packages.flatMap(item => item.bindings.map(binding => binding.target.toLowerCase())), 'installed target')
  for (const item of state.packages) {
    if (item.id !== item.release.package.id) throw new Error('installed package identity mismatch')
    for (const binding of item.bindings) validateTarget(binding)
  }
  return state
}

function validateTarget(binding) {
  if (`${HOST_PROFILES[binding.host]?.target}/${binding.alias}` !== binding.target) throw new Error('binding target differs from the host profile')
}

function activeJournal(root) {
  if (!stat(within(root, ACTIVE))) return null
  const pointer = jsonAt(root, ACTIVE)
  if (Object.keys(pointer).length !== 1 || !/^[a-f0-9-]{36}$/.test(pointer.id)) throw new Error('invalid active capability transaction')
  const journal = assertDocument(jsonAt(root, `${TX}/${pointer.id}/journal.json`), 'journal')
  if (journal.id !== pointer.id || journal.workspace !== digest(root)) throw new Error('transaction belongs to a different workspace')
  for (const action of journal.actions) {
    if (!/^\.(agents|claude)\/skills\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(action.target)) throw new Error('transaction target is outside host profiles')
  }
  return journal
}

function prepare(options) {
  const { adoption, sources = [], availableTools = [], notices = [] } = options
  const root = workspaceRoot(options.workspaceRoot ?? process.cwd())
  assertDocument(adoption, 'adoption')
  unique(adoption.packages.map(item => item.id), 'adoption package')
  unique(availableTools, 'tool observation')
  if (availableTools.length > 64 || availableTools.some(tool => !/^[a-z][a-z0-9.-]{0,63}$/.test(tool))) throw new Error('invalid available tools')
  if (!Array.isArray(sources) || sources.length > 32) throw new Error('too many release sources')
  if (!Array.isArray(notices) || notices.length > 256) throw new Error('too many release notices')
  for (const notice of notices) assertDocument(notice, 'notice')
  const before = readCapabilityState(root)
  const blockers = [], actions = [], changes = [], projected = new Map(), releases = new Map()
  if (activeJournal(root)) blockers.push('unfinished-transaction: inspect recovery before applying')
  if (before && before.enrollment !== adoption.id) blockers.push('enrollment-identity-changed')
  for (const packageRoot of sources) {
    const realSource = fs.realpathSync(path.resolve(packageRoot))
    for (const profile of Object.values(HOST_PROFILES)) {
      const target = path.join(root, profile.target)
      if (realSource === target || realSource.startsWith(`${target}${path.sep}`) || target.startsWith(`${realSource}${path.sep}`)) throw new Error('release source overlaps a managed host surface')
    }
    const release = verifyCapabilityRelease({ packageRoot: realSource })
    if (releases.has(release.package.id)) throw new Error('multiple sources for the same package')
    releases.set(release.package.id, { release, root: realSource })
  }
  const versions = [...(before?.versions ?? [])]
  const nextPackages = []
  const claimed = new Set()
  for (const desired of adoption.packages) {
    const old = before?.packages.find(item => item.id === desired.id)
    const supplied = releases.get(desired.id)
    const release = supplied?.release ?? (['retired', 'customized'].includes(desired.mode) ? old?.release : null)
    if (!release || release.digest !== desired.digest) { blockers.push(`${desired.id}: missing-or-unpinned-release`); continue }
    const descriptor = release.package
    if (['managed', 'customized'].includes(desired.mode) && notices.some(notice => notice.id === desired.id && notice.digest === release.digest && notice.status === 'withdrawn')) blockers.push(`${desired.id}: release-withdrawn-by-supplied-notice`)
    const version = versions.find(item => item.id === desired.id && item.version === descriptor.version)
    if (version && version.digest !== release.digest) blockers.push(`${desired.id}: immutable-version-reused`)
    if (!version) versions.push({ id: desired.id, version: descriptor.version, digest: release.digest })
    if (['customized', 'retired'].includes(desired.mode) && (!old || old.release.digest !== desired.digest)) blockers.push(`${desired.id}: ${desired.mode}-requires-current-adopted-release`)
    if (['reference', 'retired'].includes(desired.mode) && desired.bindings.length) blockers.push(`${desired.id}: inactive-mode-has-bindings`)
    if (desired.mode === 'managed' && !desired.bindings.length) blockers.push(`${desired.id}: managed-package-has-no-bindings`)
    const toolsAdded = descriptor.requirements.tools.filter(tool => !old?.release.package.requirements.tools.includes(tool))
    const effectsAdded = descriptor.requirements.effects.filter(effect => !old?.release.package.requirements.effects.includes(effect))
    changes.push({ package: desired.id, fromDigest: old?.release.digest ?? null, toDigest: release.digest, fromMode: old?.mode ?? null, toMode: desired.mode, toolsAdded, effectsAdded })
    if (['managed', 'customized'].includes(desired.mode)) {
      for (const tool of descriptor.requirements.tools) {
        if (!desired.allowedTools.includes(tool)) blockers.push(`${desired.id}: tool-not-admitted:${tool}`)
        if (!availableTools.includes(tool)) blockers.push(`${desired.id}: tool-not-observed:${tool}`)
      }
      for (const effect of descriptor.requirements.effects) if (!desired.allowedEffects.includes(effect)) blockers.push(`${desired.id}: effect-not-admitted:${effect}`)
    }
    const bindings = []
    for (const binding of desired.bindings) {
      const target = `${HOST_PROFILES[binding.host].target}/${binding.alias}`
      if (claimed.has(target.toLowerCase())) blockers.push(`${desired.id}: alias-collision:${target}`)
      claimed.add(target.toLowerCase())
      const currentDigest = currentTree(root, target)
      const prior = old?.bindings.find(item => item.target === target)
      // A different managed publisher cannot acquire an old binding by renaming.
      const otherOwner = before?.packages.find(item => item.id !== desired.id && item.bindings.some(entry => entry.target === target))
      if (otherOwner) blockers.push(`${desired.id}: target-owned-by-another-package:${target}`)
      if (!prior && currentDigest) blockers.push(`${desired.id}: unmanaged-collision:${target}`)
      const legacyLock = `${HOST_PROFILES[binding.host].target}/.atelier-skill-lock.json`
      if (stat(within(root, legacyLock)) && jsonAt(root, legacyLock)?.skills?.some(item => item.name === binding.alias)) blockers.push(`${desired.id}: target-owned-by-legacy-steward:${target}`)
      if (prior && !currentDigest) blockers.push(`${desired.id}: managed-target-missing:${target}`)
      if (desired.mode === 'customized') {
        if (!prior || prior.skill !== binding.skill || old.release.digest !== release.digest) {
          blockers.push(`${desired.id}: customization-requires-existing-binding:${target}`)
          continue
        }
        bindings.push({ ...prior, digest: currentDigest ?? prior.digest })
        actions.push({ type: 'customize', package: desired.id, target, currentDigest, nextDigest: currentDigest })
        continue
      }
      const restored = old?.mode === 'customized' && currentDigest === prior?.parentDigest
      if (old?.mode === 'customized' && !restored) blockers.push(`${desired.id}: customization-requires-explicit-fork-or-restoration:${target}`)
      if (prior && currentDigest !== prior.digest && !restored) blockers.push(`${desired.id}: local-drift:${target}`)
      if (!supplied) { blockers.push(`${desired.id}: managed-source-required`); continue }
      const projection = projectSkill({ packageRoot: supplied.root, release, skillId: binding.skill, alias: binding.alias, host: binding.host })
      projected.set(target, projection.files)
      bindings.push({ ...binding, target, digest: projection.digest, parentDigest: projection.digest })
      actions.push({ type: !currentDigest ? 'add' : currentDigest === projection.digest ? 'keep' : 'update', package: desired.id, target, currentDigest, nextDigest: projection.digest })
    }
    for (const prior of old?.bindings ?? []) {
      if (bindings.some(binding => binding.target === prior.target)) continue
      const currentDigest = currentTree(root, prior.target)
      const restored = old.mode === 'customized' && currentDigest === prior.parentDigest
      if (currentDigest !== prior.digest && !restored) blockers.push(`${desired.id}: local-drift:${prior.target}`)
      if (old.mode === 'customized' && !restored) blockers.push(`${desired.id}: customized-binding-must-be-preserved:${prior.target}`)
      actions.push({ type: 'retire', package: desired.id, target: prior.target, currentDigest, nextDigest: null })
    }
    nextPackages.push({ id: desired.id, release, mode: desired.mode, bindings })
  }
  for (const old of before?.packages ?? []) if (!adoption.packages.some(item => item.id === old.id)) blockers.push(`${old.id}: explicit-retirement-required-before-removal`)
  for (const item of nextPackages.filter(item => ['managed', 'customized'].includes(item.mode))) {
    for (const dependency of item.release.package.dependencies) {
      const target = nextPackages.find(entry => entry.id === dependency.id && ['managed', 'customized'].includes(entry.mode))
      if (!target && dependency.optional) continue
      if (!target || target.release.digest !== dependency.digest || target.release.package.version !== dependency.version) blockers.push(`${item.id}: unsatisfied-dependency:${dependency.id}`)
      if (target) {
        for (const host of new Set(item.bindings.map(binding => binding.host))) {
          const provided = new Set(target.bindings.filter(binding => binding.host === host)
            .flatMap(binding => target.release.package.skills.find(skill => skill.id === binding.skill)?.capabilities ?? []))
          for (const required of dependency.capabilities) if (!provided.has(required)) blockers.push(`${item.id}: dependency-capability-not-bound:${dependency.id}:${required}:${host}`)
        }
      }
    }
  }
  const visiting = new Set(), visited = new Set()
  function visit(id) {
    if (visiting.has(id)) { blockers.push(`${id}: dependency-cycle`); return }
    if (visited.has(id)) return
    visiting.add(id)
    const entry = nextPackages.find(item => item.id === id && ['managed', 'customized'].includes(item.mode))
    for (const dependency of entry?.release.package.dependencies ?? []) visit(dependency.id)
    visiting.delete(id); visited.add(id)
  }
  for (const item of nextPackages) visit(item.id)
  const payload = {
    schema: 'mnstry.atelier-capability-plan@v1', workspace: digest(root), enrollment: adoption.id,
    policyDigest: objectDigest(adoption), stateDigest: before ? objectDigest(before) : null,
    sources: [...releases.values()].map(item => ({ id: item.release.package.id, digest: item.release.digest })).sort((a, b) => a.id.localeCompare(b.id)),
    tools: [...availableTools].sort(), notices, actions, changes, blockers: [...new Set(blockers)], applyAllowed: blockers.length === 0,
  }
  const plan = { ...payload, planDigest: objectDigest(payload) }
  assertDocument(plan, 'plan')
  const after = { schema: 'mnstry.atelier-capability-state@v1', workspace: digest(root), enrollment: adoption.id, generation: plan.planDigest, policyDigest: objectDigest(adoption), packages: nextPackages, versions }
  if (plan.applyAllowed) assertDocument(after, 'state')
  return { root, plan, before, after, projected }
}

export function planCapabilityAdoption(options) { return prepare(options).plan }

function withOperationLock(root, callback) {
  const operationId = crypto.randomUUID()
  writeNew(root, OPERATION_LOCK, jsonText({ owner: 'capability-steward', operationId, pid: process.pid }))
  try { return callback() } finally {
    if (jsonAt(root, OPERATION_LOCK).operationId === operationId) {
      fs.unlinkSync(within(root, OPERATION_LOCK))
      syncPrivateDirectory(path.dirname(path.join(root, OPERATION_LOCK)))
    }
  }
}

function move(root, from, to) {
  const source = within(root, from, { directory: true })
  const parent = path.posix.dirname(to)
  within(root, parent, { directory: true, create: true })
  const target = within(root, to, { directory: true })
  if (stat(target)) throw new Error('move destination already exists')
  fs.renameSync(source, target)
  syncPrivateDirectory(path.dirname(source))
  syncPrivateDirectory(path.dirname(target))
}

export function applyCapabilityAdoption(options) {
  const initial = prepare(options)
  if (initial.plan.planDigest !== options.confirm) throw new Error('confirmation must exactly match the current adoption plan')
  if (!initial.plan.applyAllowed) throw new Error(initial.plan.blockers.join('; '))
  const root = workspaceRoot(initial.root, { write: true })
  return withOperationLock(root, () => {
    const prepared = prepare(options)
    if (prepared.plan.planDigest !== options.confirm) throw new Error('adoption changed before the operation lock')
    const { plan, before, after, projected } = prepared
    if (before && canonical({ ...before, generation: null }) === canonical({ ...after, generation: null })) return { changed: false, plan, state: before }
    const id = crypto.randomUUID(), base = `${TX}/${id}`
    const journal = { schema: 'mnstry.atelier-capability-journal@v1', id, workspace: digest(root), planDigest: plan.planDigest, phase: 'prepared', before, after, actions: plan.actions }
    assertDocument(journal, 'journal')
    for (const action of plan.actions.filter(item => ['add', 'update'].includes(item.type))) {
      for (const file of projected.get(action.target)) writeNew(root, `${base}/staged/${action.target}/${file.path}`, file.bytes)
      if (currentTree(root, `${base}/staged/${action.target}`) !== action.nextDigest) throw new Error('staged binding verification failed')
    }
    // Re-read both supplied release bytes and repository state after staging.
    if (prepare(options).plan.planDigest !== plan.planDigest) throw new Error('adoption changed during staging')
    replaceJson(root, `${base}/journal.json`, journal)
    writeNew(root, ACTIVE, jsonText({ id }))
    try {
      journal.phase = 'applying'; replaceJson(root, `${base}/journal.json`, journal)
      for (const action of plan.actions) {
        if (currentTree(root, action.target) !== action.currentDigest) throw new Error('binding changed during adoption')
        if (['update', 'retire'].includes(action.type)) move(root, action.target, `${base}/before/${action.target}`)
        if (['add', 'update'].includes(action.type)) move(root, `${base}/staged/${action.target}`, action.target)
      }
      for (const action of plan.actions) if (currentTree(root, action.target) !== action.nextDigest) throw new Error('installed binding readback failed')
      if (objectDigest(readCapabilityState(root)) !== objectDigest(before)) throw new Error('adoption state changed during publication')
      replaceJson(root, CAPABILITY_STATE, after)
      if (objectDigest(readCapabilityState(root)) !== objectDigest(after)) throw new Error('adoption state readback failed')
      journal.phase = 'committed'; replaceJson(root, `${base}/journal.json`, journal)
      fs.unlinkSync(within(root, ACTIVE)); syncPrivateDirectory(path.dirname(path.join(root, ACTIVE)))
      return { changed: true, plan, state: after, transaction: id, quarantine: `${base}/before` }
    } catch (error) {
      journal.phase = 'recovery-required'
      replaceJson(root, `${base}/journal.json`, journal)
      throw new Error(`adoption interrupted; inspect capability recovery: ${error.message}`)
    }
  })
}

export function inspectCapabilityRecovery({ workspaceRoot: input }) {
  const root = workspaceRoot(input ?? process.cwd())
  const journal = activeJournal(root)
  if (!journal) return { pending: false, planDigest: null, blockers: [], actions: [] }
  const blockers = []
  const actions = journal.actions.filter(item => ['add', 'update', 'retire'].includes(item.type)).map(action => {
    const current = currentTree(root, action.target)
    const backup = currentTree(root, `${TX}/${journal.id}/before/${action.target}`)
    const held = currentTree(root, `${TX}/${journal.id}/rolled-back/${action.target}`)
    // Accept each crash boundary, including an interrupted recovery itself.
    const untouched = current === action.currentDigest && backup === null
    const exchanged = backup === action.currentDigest && (current === action.nextDigest || current === null) && (held === null || held === action.nextDigest)
    const added = action.type === 'add' && backup === null && (current === action.nextDigest || current === null) && (held === null || held === action.nextDigest)
    if (!untouched && !exchanged && !added) blockers.push(`ambiguous-binding:${action.target}`)
    return { ...action, observedDigest: current, backupDigest: backup, heldDigest: held }
  })
  const currentState = readCapabilityState(root)
  if (![objectDigest(journal.before), objectDigest(journal.after)].includes(objectDigest(currentState))) blockers.push('adoption-state-changed')
  const payload = { pending: true, transaction: journal.id, phase: journal.phase, actions, blockers, stateDigest: objectDigest(currentState), journalDigest: objectDigest(journal) }
  return { ...payload, planDigest: objectDigest(payload) }
}

export function recoverCapabilityAdoption({ workspaceRoot: input, confirm }) {
  const root = workspaceRoot(input ?? process.cwd(), { write: true })
  const initial = inspectCapabilityRecovery({ workspaceRoot: root })
  if (!initial.pending || initial.planDigest !== confirm || initial.blockers.length) throw new Error('recovery requires the exact unblocked recovery plan')
  // A killed process may have left the shared operation lock. Only reclaim a
  // recognizably owned lock whose process no longer exists, never legacy locks.
  if (stat(within(root, OPERATION_LOCK))) {
    const lock = jsonAt(root, OPERATION_LOCK)
    if (lock.owner !== 'capability-steward' || !Number.isInteger(lock.pid) || lock.pid < 1 || !/^[a-f0-9-]{36}$/.test(lock.operationId)) throw new Error('operation lock requires its owner')
    try { process.kill(lock.pid, 0); throw new Error('operation owner is still alive') } catch (error) { if (error.code !== 'ESRCH') throw error }
    if (canonical(jsonAt(root, OPERATION_LOCK)) !== canonical(lock)) throw new Error('operation lock changed')
    fs.unlinkSync(within(root, OPERATION_LOCK))
  }
  return withOperationLock(root, () => {
    const plan = inspectCapabilityRecovery({ workspaceRoot: root })
    if (plan.planDigest !== confirm || plan.blockers.length) throw new Error('recovery plan changed')
    const journal = activeJournal(root), base = `${TX}/${journal.id}`
    for (const action of [...plan.actions].reverse()) {
      if (currentTree(root, action.target) !== action.observedDigest) throw new Error('binding changed during recovery')
      if (action.observedDigest === action.currentDigest && action.backupDigest === null) continue
      if (action.observedDigest !== null) move(root, action.target, `${base}/rolled-back/${action.target}`)
      if (action.backupDigest !== null) move(root, `${base}/before/${action.target}`, action.target)
    }
    for (const action of plan.actions) if (currentTree(root, action.target) !== action.currentDigest) throw new Error('recovery binding readback failed')
    if (journal.before) replaceJson(root, CAPABILITY_STATE, journal.before)
    else if (stat(within(root, CAPABILITY_STATE))) { fs.unlinkSync(within(root, CAPABILITY_STATE)); syncPrivateDirectory(path.dirname(path.join(root, CAPABILITY_STATE))) }
    journal.phase = 'rolled-back'; replaceJson(root, `${base}/journal.json`, journal)
    fs.unlinkSync(within(root, ACTIVE)); syncPrivateDirectory(path.dirname(path.join(root, ACTIVE)))
    return { recovered: true, transaction: journal.id, state: readCapabilityState(root), preserved: `${base}/rolled-back` }
  })
}

export function inspectCapabilityAdoption({ workspaceRoot: input }) {
  const root = workspaceRoot(input ?? process.cwd())
  const state = readCapabilityState(root)
  const packages = (state?.packages ?? []).map(item => ({
    id: item.id, version: item.release.package.version, digest: item.release.digest, mode: item.mode,
    bindings: item.bindings.map(binding => {
      const observedDigest = currentTree(root, binding.target)
      return { ...binding, observedDigest, installed: observedDigest === binding.digest ? 'current' : observedDigest === null ? 'missing' : 'drifted', hostObserved: 'unknown', exercised: 'unknown' }
    }),
  }))
  return { schema: 'mnstry.atelier-capability-status@v1', workspace: digest(root), enrollment: state?.enrollment ?? null, generation: state?.generation ?? null, policyDigest: state?.policyDigest ?? null, recovery: inspectCapabilityRecovery({ workspaceRoot: root }), packages }
}

export function inspectCapabilityFleet({ workspaces }) {
  if (!Array.isArray(workspaces) || workspaces.length > 64) throw new Error('fleet requires at most 64 explicitly enrolled repositories')
  const repositories = workspaces.map(input => {
    try { return { ok: true, status: inspectCapabilityAdoption({ workspaceRoot: input }) } }
    catch { return { ok: false, workspace: digest(path.resolve(input)), error: 'repository-inspection-failed' } }
  })
  const ids = repositories.filter(item => item.ok && item.status.enrollment).map(item => item.status.enrollment)
  return { schema: 'mnstry.atelier-capability-fleet@v1', repositories, duplicateEnrollments: [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))], atomicAcrossRepositories: false }
}

export { withOperationLock }
