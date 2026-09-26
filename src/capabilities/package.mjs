import fs from 'node:fs'
import path from 'node:path'
import { validateJsonSchema } from '../export/atelier-export-contract.mjs'
import { parseSkillFrontmatter } from '../skills/steward.mjs'
import { bytesAt, canonical, digest, fileInventory, jsonAt, jsonText, objectDigest, relativeFile, stat, tree, treeDigest, within, writeNew } from './files.mjs'

const schema = JSON.parse(fs.readFileSync(new URL('../../contracts/atelier-capability.v1.schema.json', import.meta.url), 'utf8'))
export const PACKAGE_FILE = 'capability-package.json'
export const RELEASE_FILE = 'capability-release.json'
export const HOST_PROFILES = Object.freeze({
  'codex-repo-v1': Object.freeze({ target: '.agents/skills', adapterVersion: 1, discovery: 'repository SKILL.md projection', precedence: 'host-owned; overlapping names require inspection', permissions: 'advisory declarations only', reload: 're-observe in the intended host session after every adoption' }),
  'claude-repo-v1': Object.freeze({ target: '.claude/skills', adapterVersion: 1, discovery: 'project SKILL.md projection', precedence: 'host-owned; personal, enterprise and plugin surfaces may change resolution', permissions: 'advisory declarations only', reload: 're-observe in the intended host session after every adoption' }),
})

export function validateCapabilityDocument(document, shape) {
  return validateJsonSchema({ $schema: schema.$schema, $defs: schema.$defs, $ref: `#/$defs/${shape}` }, document)
}
export function assertDocument(document, shape) {
  const errors = validateCapabilityDocument(document, shape)
  if (errors.length) throw new Error(`invalid capability ${shape}: ${errors.join('; ')}`)
  return document
}
export function unique(values, label) {
  if (new Set(values).size !== values.length) throw new Error(`duplicate ${label}`)
}

function validatePackage(descriptor, files) {
  assertDocument(descriptor, 'package')
  unique(descriptor.skills.map(skill => skill.id), 'skill identity')
  unique(descriptor.skills.map(skill => skill.path.toLowerCase()), 'skill path')
  unique(descriptor.capabilities.map(capability => capability.id), 'capability identity')
  unique(descriptor.dependencies.map(dependency => dependency.id), 'dependency identity')
  unique(files.map(file => file.path.toLowerCase()), 'case-insensitive payload path')
  const paths = new Set(files.map(file => file.path))
  for (const evaluation of descriptor.evaluations) if (!paths.has(evaluation.path)) throw new Error('evaluation evidence is missing from package')
  for (const migration of descriptor.migrations) if (!paths.has(migration.path)) throw new Error('migration guidance is missing from package')
  for (const skill of descriptor.skills) {
    relativeFile(skill.path)
    if (!skill.path.startsWith('skills/')) throw new Error('skill path must be below skills/')
    if (descriptor.skills.some(other => other !== skill && other.path.startsWith(`${skill.path}/`))) throw new Error('overlapping skill roots')
    if (skill.capabilities.some(id => !descriptor.capabilities.some(item => item.id === id))) throw new Error('skill refers to an unknown capability')
    const skillFiles = files.filter(file => file.path.startsWith(`${skill.path}/`))
    const entry = skillFiles.find(file => file.path === `${skill.path}/SKILL.md`)
    if (!entry) throw new Error('skill entrypoint missing')
    const parsed = parseSkillFrontmatter(new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes))
    if (!parsed.ok || parsed.values.name !== skill.name || !parsed.values.description || ['|', '>'].includes(parsed.values.description)) throw new Error('portable skill requires matching name and a single-line description')
    // References in every Markdown resource are checked, not just SKILL.md.
    // Scripts remain inert payloads; this is not static program verification.
    for (const file of skillFiles.filter(file => file.path.endsWith('.md'))) {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes)
      for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const link = match[1].replace(/^<|>$/g, '').split('#')[0]
        if (!link || /^[a-z][a-z0-9+.-]*:/i.test(link)) continue
        const decoded = decodeURIComponent(link)
        if (path.posix.isAbsolute(decoded) || decoded.includes('\\')) throw new Error('skill resource escapes its bundle')
        const normalized = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), decoded))
        if (!normalized.startsWith(`${skill.path}/`) || !paths.has(normalized)) throw new Error('skill resource is missing or escapes its bundle')
      }
    }
  }
}

export function prepareCapabilityRelease({ packageRoot }) {
  const root = fs.realpathSync(path.resolve(packageRoot))
  const files = tree(root).filter(file => file.path !== RELEASE_FILE)
  const entry = files.find(file => file.path === PACKAGE_FILE)
  if (!entry) throw new Error('capability-package.json is missing')
  const descriptor = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes))
  validatePackage(descriptor, files)
  const payload = { schema: 'mnstry.atelier-capability-release@v1', package: descriptor, files: fileInventory(files) }
  const release = { ...payload, digest: objectDigest(payload) }
  assertDocument(release, 'release')
  return release
}

export function sealCapabilityRelease(options) {
  const release = prepareCapabilityRelease(options)
  const root = fs.realpathSync(path.resolve(options.packageRoot))
  // Exclusive creation prevents a release identifier from silently changing.
  writeNew(root, RELEASE_FILE, jsonText(release))
  return release
}

export function verifyCapabilityRelease({ packageRoot, expectedDigest }) {
  const root = fs.realpathSync(path.resolve(packageRoot))
  const release = assertDocument(jsonAt(root, RELEASE_FILE), 'release')
  const actual = prepareCapabilityRelease({ packageRoot: root })
  if (canonical(release) !== canonical(actual)) throw new Error('release payload or manifest integrity mismatch')
  if (expectedDigest && release.digest !== expectedDigest) throw new Error('release does not match the adopted digest')
  return release
}

export function projectSkill({ packageRoot, release, skillId, alias, host }) {
  if (!HOST_PROFILES[host] || !release.package.hosts.includes(host)) throw new Error('package does not support the selected host profile')
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(alias) || alias.length > 64) throw new Error('invalid skill alias')
  const skill = release.package.skills.find(item => item.id === skillId)
  if (!skill) throw new Error('binding selects an unknown skill')
  const root = fs.realpathSync(packageRoot)
  const files = tree(within(root, skill.path, { directory: true }))
  const entry = files.find(file => file.path === 'SKILL.md')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes).replaceAll('\r\n', '\n')
  const end = text.indexOf('\n---\n', 4)
  const header = text.slice(0, end)
  if ((header.match(/^name:/gm) ?? []).length !== 1) throw new Error('ambiguous skill name metadata')
  entry.bytes = Buffer.from(header.replace(/^name:.*$/m, `name: ${alias}`) + text.slice(end))
  return { files, digest: treeDigest(files), target: `${HOST_PROFILES[host].target}/${alias}` }
}

export function inventorySkillSurfaces({ surfaces }) {
  if (!Array.isArray(surfaces) || surfaces.length > 32) throw new Error('inventory requires at most 32 explicit surfaces')
  unique(surfaces.map(surface => surface.id), 'surface id')
  const entries = [], findings = []
  for (const surface of surfaces) {
    if (!/^[a-z][a-z0-9.-]{0,63}$/.test(surface.id)) throw new Error('invalid inventory surface id')
    if (!['personal', 'organization', 'repository', 'nested', 'plugin', 'other'].includes(surface.scope)) throw new Error('invalid inventory scope')
    if (!stat(surface.root)) { findings.push({ surface: surface.id, code: 'surface-missing' }); continue }
    if (stat(surface.root).isSymbolicLink() || !stat(surface.root).isDirectory()) { findings.push({ surface: surface.id, code: 'surface-redirected-or-not-directory' }); continue }
    const root = fs.realpathSync(surface.root)
    const names = fs.readdirSync(root).filter(name => !name.startsWith('.')).sort()
    if (names.length > 256) throw new Error('inventory surface ceiling exceeded')
    for (const name of names) {
      try {
        const skillRoot = within(root, name, { directory: true })
        if (!stat(skillRoot)?.isDirectory()) continue
        const files = tree(skillRoot)
        const entry = files.find(file => file.path === 'SKILL.md')
        if (!entry) { findings.push({ surface: surface.id, name, code: 'no-entrypoint' }); continue }
        const parsed = parseSkillFrontmatter(new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes))
        entries.push({ surface: surface.id, scope: surface.scope, name, declaredName: parsed.values.name ?? null, digest: treeDigest(files), ownership: 'unclaimed', hostLoaded: 'unknown' })
      } catch { findings.push({ surface: surface.id, name, code: 'unreadable-or-unsafe-bundle' }) }
    }
  }
  const collisions = entries.filter((entry, index) => entries.some((other, otherIndex) => index !== otherIndex && other.declaredName === entry.declaredName))
    .map(entry => ({ surface: entry.surface, name: entry.name, code: 'name-overlap-requires-host-inspection' }))
  return { schema: 'mnstry.atelier-capability-inventory@v1', entries, findings: [...findings, ...collisions], scope: 'explicit-surfaces-only', mutation: false }
}
