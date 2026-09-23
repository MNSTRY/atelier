import fs from 'node:fs'
import path from 'node:path'
import { validateJsonSchema } from '../export/atelier-export-contract.mjs'
import { createTemplateProjectView } from '../template-bindings/project.mjs'
import { validateTemplateDefinition, validateTemplateBinding, templateReference } from '../templates/profile.mjs'
import { contained, readBytes, fileState, inventory, hashBytes, same, jsonText } from './transaction-files.mjs'

export const TEMPLATE_PARTICIPANT = 'local-template-profile@1'
const ROOT = 'atelier-template'
const ADOPTION = ROOT + '/adoption.json'
const MANAGED = [ROOT + '/profile.json', ROOT + '/selection.json', 'atelier-output/template.html', 'atelier-output/template-binding.json']
const adoptionSchema = JSON.parse(fs.readFileSync(new URL('../../contracts/atelier-template-adoption.v1.schema.json', import.meta.url)))
const parse = bytes => JSON.parse(bytes.toString('utf8'))
const historyPath = digest => ROOT + '/history/' + digest.slice(7) + '.json'
const regularData = (root, name) => {
  const file = contained(root, name), state = fileState(file)
  if (!state || state.mode !== '100644') throw new Error('template input must be a regular non-executable file')
  const bytes = readBytes(file)
  if (bytes.length > 1048576) throw new Error('template JSON input exceeds limit')
  return { bytes, state, value: parse(bytes) }
}
function manifest(bytes) {
  const value = parse(bytes)
  if (validateJsonSchema(adoptionSchema, value).length || !same(value.managed.map(x => x.path).sort(), [...MANAGED].sort())) throw new Error('invalid template adoption manifest')
  inputPaths(value.inputs.profile.path, value.inputs.selection.path)
  for (const [key, name] of [['profile', MANAGED[0]], ['selection', MANAGED[1]]]) {
    if (value.inputs[key].digest !== value.managed.find(entry => entry.path === name).state.digest) throw new Error('template adoption input digest mismatch')
  }
  return value
}
function inputPaths(profileFile, selectionFile) {
  for (const name of [profileFile, selectionFile]) {
    if (typeof name !== 'string' || name.length > 512 || name.startsWith('atelier-output/') || name === ROOT || name.startsWith(ROOT + '/') || name === 'atelier.lock.json' || name.startsWith('.atelier-local/') || name === '.atelier-local') throw new Error('template input overlaps reserved state')
  }
  if (profileFile === selectionFile) throw new Error('template input paths must be distinct')
}
function selection(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(k => !['projectRef', 'roleNodeIds', 'target', 'theme'].includes(k)) || !['projectRef', 'roleNodeIds', 'target'].every(k => Object.hasOwn(value, k))) throw new Error('invalid template selection')
  return value
}
function compose(project, profile, selected) {
  if (!validateTemplateDefinition(profile).ok || profile.runtimeProfileRef !== null || profile.compatibility.packRefs.length || profile.extensions.length) throw new Error('unsupported template profile participant')
  const view = createTemplateProjectView(project, JSON.stringify({ profile, ...selection(selected) }))
  if (!view.ok) throw new Error('template composition refused')
  if (!validateTemplateBinding(profile, view.binding, view.records).ok) throw new Error('template binding invalid')
  return view
}
function bindingBytes(view) {
  return Buffer.from(jsonText({ templateRef: view.templateRef, bindingRef: view.bindingRef, binding: view.binding, records: view.records, target: view.target }))
}

/** Validate reserved preimages, including all immutable history, without
 * treating installed state as authenticated approval or publication. */
export function inspectTemplateAdoption(root) {
  const directory = contained(root, ROOT)
  const files = fs.existsSync(directory) ? inventory(directory).map(x => ROOT + '/' + x.path) : []
  if (fs.existsSync(directory)) {
    const children = fs.readdirSync(directory, { withFileTypes: true })
    if (children.some(entry => entry.isDirectory() && entry.name !== 'history')) throw new Error('unknown reserved template directory')
    if (fs.existsSync(contained(root, ROOT + '/history')) && fs.readdirSync(contained(root, ROOT + '/history'), { withFileTypes: true }).some(entry => entry.isDirectory())) throw new Error('unknown template history directory')
  }
  if (files.some(name => ![ADOPTION, ...MANAGED].includes(name) && !/^atelier-template\/history\/[a-f0-9]{64}\.json$/.test(name))) throw new Error('unknown reserved template file')
  const active = fileState(contained(root, ADOPTION))
  if (!active) {
    if (files.length || MANAGED.some(name => fileState(contained(root, name)))) throw new Error('orphan reserved template state')
    return { digest: null, bytes: null, manifest: null }
  }
  if (active.mode !== '100644') throw new Error('invalid adoption file mode')
  const bytes = readBytes(contained(root, ADOPTION)), value = manifest(bytes)
  for (const entry of value.managed) {
    if (!same(fileState(contained(root, entry.path)), entry.state)) throw new Error('template managed preimage changed or missing')
  }
  const history = new Set(files.filter(name => name.startsWith(ROOT + '/history/')))
  let previous = value.previousAdoptionDigest
  const seen = new Set()
  while (previous !== null) {
    if (seen.has(previous)) throw new Error('template history cycle')
    seen.add(previous)
    const name = historyPath(previous)
    if (!history.delete(name)) throw new Error('template history missing')
    const entry = regularData(root, name)
    if (hashBytes(entry.bytes) !== previous) throw new Error('template history digest mismatch')
    previous = manifest(entry.bytes).previousAdoptionDigest
  }
  if (history.size) throw new Error('unrelated template history')
  return { digest: hashBytes(bytes), bytes, manifest: value }
}

export function templateManagedPaths(previousAdoptionDigest) {
  return [...MANAGED, ADOPTION, ...(previousAdoptionDigest ? [historyPath(previousAdoptionDigest)] : [])]
}

/** Called inside the engine's isolated preparation. No writes or callbacks. */
export function prepareTemplateParticipant(project, { profileFile, selectionFile }) {
  const root = project.configDir
  inputPaths(profileFile, selectionFile)
  const profile = regularData(root, profileFile), selected = regularData(root, selectionFile)
  const prior = inspectTemplateAdoption(root)
  const view = compose(project, profile.value, selected.value)
  const outputs = new Map([
    [MANAGED[0], profile.bytes], [MANAGED[1], selected.bytes],
    [MANAGED[2], Buffer.from(view.html)], [MANAGED[3], bindingBytes(view)],
  ])
  const adoption = {
    schema: 'mnstry.atelier-template-adoption@v1', participant: TEMPLATE_PARTICIPANT,
    templateRef: view.templateRef, bindingRef: view.bindingRef,
    inputs: { profile: { path: profileFile, digest: profile.state.digest }, selection: { path: selectionFile, digest: selected.state.digest } },
    previousAdoptionDigest: prior.digest,
    managed: [...outputs].map(([name, bytes]) => ({ path: name, state: { digest: hashBytes(bytes), mode: '100644' } })),
  }
  const adoptionBytes = Buffer.from(jsonText(adoption))
  manifest(adoptionBytes)
  outputs.set(ADOPTION, adoptionBytes)
  if (prior.digest) outputs.set(historyPath(prior.digest), prior.bytes)
  const participant = {
    id: TEMPLATE_PARTICIPANT, profileFile, selectionFile,
    profileDigest: profile.state.digest, selectionDigest: selected.state.digest,
    templateRef: view.templateRef, bindingRef: view.bindingRef,
    previousAdoptionDigest: prior.digest, adoptionDigest: hashBytes(adoptionBytes),
  }
  return { participant, outputs, template: { id: profile.value.id, version: profile.value.version } }
}

/** Saved plan shape validation only. It does not run a renderer or mutate. */
export function validateTemplatePlan(plan) {
  const p = plan.participant
  inputPaths(p.profileFile, p.selectionFile)
  for (const name of [p.profileFile, p.selectionFile]) contained(plan.workspace, name)
  if (plan.migration.id !== TEMPLATE_PARTICIPANT || plan.policy.participant !== TEMPLATE_PARTICIPANT) throw new Error('template participant mismatch')
  const before = name => plan.readSet.find(x => x.path === name)?.state ?? null
  const templatePaths = new Set(templateManagedPaths(p.previousAdoptionDigest))
  if (plan.writes.some(entry => (entry.owner === 'template' || entry.owner === 'template-history') && !templatePaths.has(entry.path))) throw new Error('unregistered template write')
  if (before(p.profileFile)?.digest !== p.profileDigest || before(p.selectionFile)?.digest !== p.selectionDigest || before(ADOPTION)?.digest !== (p.previousAdoptionDigest ?? undefined)) throw new Error('template input or adoption preimage mismatch')
  const adoptionWrite = plan.writes.find(x => x.path === ADOPTION)
  if (!adoptionWrite || adoptionWrite.after.digest !== p.adoptionDigest) throw new Error('template adoption output missing')
  const adopted = manifest(Buffer.from(adoptionWrite.content, 'base64'))
  if (!same(adopted.templateRef, p.templateRef) || !same(adopted.bindingRef, p.bindingRef) || adopted.previousAdoptionDigest !== p.previousAdoptionDigest || adopted.inputs.profile.path !== p.profileFile || adopted.inputs.selection.path !== p.selectionFile || adopted.inputs.profile.digest !== p.profileDigest || adopted.inputs.selection.digest !== p.selectionDigest) throw new Error('template adoption plan binding mismatch')
  for (const entry of adopted.managed) {
    const write = plan.writes.find(x => x.path === entry.path)
    if (!same(write?.after ?? before(entry.path), entry.state)) throw new Error('template managed output binding mismatch')
  }
  if (p.previousAdoptionDigest) {
    const history = plan.writes.find(x => x.path === historyPath(p.previousAdoptionDigest))
    if (!history || history.before !== null || history.after.digest !== p.previousAdoptionDigest) throw new Error('template history must be exclusive exact prior manifest')
    manifest(Buffer.from(history.content, 'base64'))
  }
}

/** Before mutation, recompute from actual owner source; no saved arbitrary
 * template bytes can become installed simply by rehashing a plan. */
export function verifyTemplatePreparation(project, plan) {
  const prepared = prepareTemplateParticipant(project, plan.participant)
  if (!same(prepared.participant, plan.participant)) throw new Error('template preparation identity changed')
  for (const [name, bytes] of prepared.outputs) {
    const write = plan.writes.find(x => x.path === name)
    const actual = write ? Buffer.from(write.content, 'base64') : readBytes(contained(project.configDir, name))
    if (!actual.equals(bytes)) throw new Error('template saved output differs from prepared source')
  }
}

/** Postcheck only. Uses installed inert profile and selection over current
 * canonical source; no network or runtime grant is introduced. */
export function verifyTemplateInstallation(project, participant) {
  const root = project.configDir, installed = inspectTemplateAdoption(root)
  if (installed.digest !== participant.adoptionDigest) throw new Error('installed adoption digest mismatch')
  const profile = regularData(root, MANAGED[0]), selected = regularData(root, MANAGED[1])
  if (hashBytes(profile.bytes) !== participant.profileDigest || hashBytes(selected.bytes) !== participant.selectionDigest) throw new Error('installed input mismatch')
  const view = compose(project, profile.value, selected.value)
  if (!same(view.templateRef, participant.templateRef) || !same(view.bindingRef, participant.bindingRef) || !readBytes(contained(root, MANAGED[2])).equals(Buffer.from(view.html)) || !readBytes(contained(root, MANAGED[3])).equals(bindingBytes(view))) throw new Error('installed template differs from current source')
  if (!same(templateReference('TemplateRef', profile.value.id, profile.value.version, profile.value), participant.templateRef)) throw new Error('installed template reference mismatch')
}
