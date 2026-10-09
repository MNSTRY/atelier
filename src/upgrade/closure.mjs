// Read-only planner for a consumer's own dependency closure (`upgrade closure`).
//
// It reads the candidate's package.json and package-lock.json, the installed
// manifest of every lockfile copy of the selected package, the package.json of
// each directory above the npm root (to refuse a parent that declares
// workspaces) and, when no package is named, this package's own package.json
// for the default name. It classifies what an offline reinstall proof would
// need. It never runs npm, never uses the network, never reads npm
// configuration or credentials, and never writes. A completed plan is not a
// proof: `proof` is always 'not-run', and no path here exits 0.
//
// Refusals reuse the existing typed codes. `usage` covers an input this plan
// does not support, `consumer-closure-incomplete` a lockfile entry that an
// offline reinstall could not be proven for, and `override-not-inherited` a
// copy the lockfile holds away from the selected package's pin. Each refusal
// also carries one `reason` from the bounded list in HINTS below.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { AtelierDiagnosticError } from '../project/config.mjs'
import {
  CONSUMER_CLOSURE_INCOMPLETE,
  OVERRIDE_NOT_INHERITED,
  capturedClosure,
  npmTreeLines,
  overrideFindings,
} from './closure-diagnostics.mjs'

const USAGE = 'usage'

export const CLOSURE_PLAN_EXIT = 3
export const CLOSURE_REFUSAL_EXIT = 2

const HINTS = {
  'npm-root-required': 'Pass --npm-root with the absolute path of the staged candidate\'s npm root; this command has no default directory.',
  'npm-root-not-absolute': 'Pass --npm-root as an absolute path, so the plan cannot follow the current directory.',
  'npm-root-not-directory': 'Check the path: --npm-root must name an existing directory.',
  'npm-root-linked': 'Pass the real path of the npm root. npm works from the physical directory, so a path through a link can name a project whose parent directories this plan did not check.',
  'argument-unsupported': 'This command plans only and accepts --npm-root, --package and --registry-host, each once and each with a value. It does not fetch, install or prove.',
  'manifest-missing': 'Point --npm-root at the directory that holds the candidate\'s own package.json.',
  'lockfile-missing': 'Install the candidate with npm so it has its own package-lock.json, then plan again.',
  'lockfile-invalid': 'Regenerate the candidate\'s package-lock.json with npm; this plan reads it as a JSON object whose packages map holds one object per entry.',
  'lockfile-version': 'Regenerate the lockfile with a current npm (lockfileVersion 2 or 3); version 1 has no packages map to classify.',
  workspaces: 'npm workspaces are not supported by this plan. Check a single npm root project, or record the workspace as unchecked.',
  'prefix-mismatch': 'A parent directory declares npm workspaces, so npm would treat another directory as this project\'s root. Plan from a root that npm resolves to itself.',
  'linked-node-modules': 'The candidate needs its own node_modules directory; a link shares an installation with another project.',
  'missing-integrity': 'An offline reinstall needs every registry entry locked with both resolved and integrity; inspect how the candidate resolved these entries.',
  'git-source': 'A git dependency cannot be captured from the registry. Record it as unchecked, or replace it with a published version before proving the closure.',
  'other-host': 'This tarball is on a host that was not named as an approved registry. Name the host with --registry-host only if the owner approves it.',
  'outside-project': 'This entry points outside the candidate. Record it as unchecked, or bring the dependency inside the project or onto the registry.',
  'link-target-missing': 'A link entry must name the folder it resolves to. Regenerate the lockfile with npm, or record the linked dependency as unchecked.',
  'zero-copies': 'The lockfile lists no copy of a package it must hold, so nothing was checked. Reinstall the candidate and confirm the lockfile is the candidate\'s own.',
  'selected-package-unreadable': 'Install the selected package in the candidate, so its manifest and overrides can be read from the candidate\'s own node_modules.',
  'selected-package-mismatch': 'The installed manifest is not the package the lockfile records at that path, so its overrides were not used. Reinstall the candidate from its own lockfile, then plan again.',
  'selected-copies-differ': 'The lockfile installs the selected package more than once and the copies do not agree, so no single set of overrides applies. Deduplicate the selected package, or record its overrides as unchecked.',
  'copy-off-pin': 'npm applies overrides only in the root project, so consumers never receive them. Changing a pin or an override in the owner\'s project needs the owner\'s consent.',
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// A parsed JSON object, or the reason it could not be read.
function readJsonObject(file) {
  let bytes
  try {
    bytes = fs.readFileSync(file)
  } catch {
    return { missing: true }
  }
  try {
    const value = JSON.parse(bytes.toString('utf8'))
    return isObject(value) ? { value, bytes } : { invalid: true }
  } catch {
    return { invalid: true }
  }
}

// Lexical containment: `target` resolved against the npm root stays inside it.
// The target need not exist, so links are not followed here.
function insideProject(npmRoot, target) {
  const relative = path.relative(npmRoot, path.resolve(npmRoot, target))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

// A lockfile path under a node_modules directory names an installed package;
// any other path is a folder of the project itself, the target of a link.
const installedPath = (entryPath) => /(?:^|\/)node_modules\//.test(entryPath)

const declaresWorkspaces = (manifest) => {
  const workspaces = manifest?.workspaces
  if (Array.isArray(workspaces)) return workspaces.length > 0
  return isObject(workspaces)
}

// The nearest parent directory whose package.json declares workspaces, or null.
function workspaceAncestor(npmRoot) {
  let current = path.dirname(npmRoot)
  for (;;) {
    const manifest = readJsonObject(path.join(current, 'package.json'))
    if (manifest.value && declaresWorkspaces(manifest.value)) return current
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

// node_modules must be the candidate's own directory: absent is allowed here,
// a link or a directory that resolves elsewhere is not.
function nodeModulesIsLinked(npmRoot) {
  const own = path.join(npmRoot, 'node_modules')
  let stat
  try {
    stat = fs.lstatSync(own)
  } catch {
    return false
  }
  if (stat.isSymbolicLink()) return true
  try {
    return fs.realpathSync(own) !== path.join(fs.realpathSync(npmRoot), 'node_modules')
  } catch {
    return true
  }
}

// npm's rule for one platform field (as in npm-install-checks): the list must
// match none of its negated values and, when it has plain values, at least one
// of them. `any` alone allows everything.
function listAllows(value, list) {
  const values = (Array.isArray(list) ? list : [list]).filter((item) => typeof item === 'string')
  if (values.length === 0) return true
  if (values.length === 1 && values[0] === 'any') return true
  let negated = 0
  let matched = false
  for (const item of values) {
    if (item.startsWith('!')) {
      negated += 1
      if (item.slice(1) === value) return false
    } else if (item === value) {
      matched = true
    }
  }
  return matched || negated === values.length
}

// The lock field that provably excludes this host, or null. Only evidence
// counts: an unknown host value never excludes, and `libc` is compared only on
// a Linux host whose libc is known.
function platformExclusion(entry, host) {
  if (entry?.os !== undefined && typeof host?.os === 'string' && !listAllows(host.os, entry.os)) return 'os'
  if (entry?.cpu !== undefined && typeof host?.cpu === 'string' && !listAllows(host.cpu, entry.cpu)) return 'cpu'
  if (entry?.libc !== undefined && host?.os === 'linux' && typeof host?.libc === 'string' && !listAllows(host.libc, entry.libc)) return 'libc'
  return null
}

// Where each lockfile entry comes from, with the three source kinds
// `inspectPackageProvenance` already uses (`npm`, `git`, `local_path`), plus
// links and bundled entries. Unlike `capturedClosure`, which skips what it
// cannot cache, this names every entry an offline proof could not capture from
// an approved registry:
// - `git-source`: a git dependency;
// - `other-host`: a tarball on a host outside `approvedRegistryHosts`, when
//   the caller names approved hosts;
// - `outside-project`: a link, folder or local file outside the npm root, or a
//   source with a scheme this plan does not know;
// - `link-target-missing`: a link with no folder named in `resolved`.
// An installed entry with no `resolved` is counted as `unclassified`, so the
// counts always add up to the number of entries; refusing it is left to
// `capturedClosure`. `registrySchemes` counts http and https separately:
// approving a host says nothing about the transport. A registry URL that does
// not parse is counted under `unparseable` and, when approved hosts are named,
// is always a finding: no approved host can match it.
export function lockSourceFindings(lock, { npmRoot, approvedRegistryHosts = null } = {}) {
  const counts = { npm: 0, git: 0, local_path: 0, link: 0, bundled: 0, unclassified: 0 }
  const registryHosts = {}
  const registrySchemes = {}
  const findings = []
  const approved = Array.isArray(approvedRegistryHosts) && approvedRegistryHosts.length > 0 ? new Set(approvedRegistryHosts) : null
  const entries = Object.entries(lock?.packages ?? {}).sort(([left], [right]) => left.localeCompare(right))
  for (const [entryPath, entry] of entries) {
    if (entryPath === '') continue
    if (entry?.inBundle) {
      counts.bundled += 1
      continue
    }
    const resolved = typeof entry?.resolved === 'string' ? entry.resolved : null
    if (entry?.link) {
      counts.link += 1
      if (resolved === null || resolved.trim() === '') findings.push({ reason: 'link-target-missing', path: entryPath })
      else if (!insideProject(npmRoot, resolved)) findings.push({ reason: 'outside-project', path: entryPath })
      continue
    }
    if (!installedPath(entryPath)) {
      counts.local_path += 1
      if (!insideProject(npmRoot, entryPath)) findings.push({ reason: 'outside-project', path: entryPath })
      continue
    }
    if (resolved === null) {
      counts.unclassified += 1
      continue
    }
    if (/^(?:git\+|git:)/.test(resolved)) {
      counts.git += 1
      findings.push({ reason: 'git-source', path: entryPath })
      continue
    }
    if (/^https?:\/\//.test(resolved)) {
      counts.npm += 1
      let host = null
      try {
        host = new URL(resolved).host
      } catch {
        host = null
      }
      const scheme = resolved.slice(0, resolved.indexOf(':'))
      registrySchemes[scheme] = (registrySchemes[scheme] ?? 0) + 1
      // An empty host is as unusable as a URL that does not parse.
      const key = host || 'unparseable'
      registryHosts[key] = (registryHosts[key] ?? 0) + 1
      if (approved && (!host || !approved.has(host))) findings.push({ reason: 'other-host', path: entryPath, host: host || null })
      continue
    }
    counts.local_path += 1
    const local = resolved.startsWith('file:') ? resolved.slice('file:'.length) : null
    if (local === null || /^[a-z][a-z0-9+.-]*:\/\//i.test(resolved) || !insideProject(npmRoot, local)) {
      findings.push({ reason: 'outside-project', path: entryPath })
    }
  }
  return { counts, registryHosts, registrySchemes, findings }
}

// The names that link entries install: a link lives at a node_modules path and
// carries no version of its own, so an override for such a name cannot be
// compared by this plan.
function linkedNames(lock) {
  const names = new Set()
  for (const [entryPath, entry] of Object.entries(lock?.packages ?? {})) {
    if (entryPath === '' || !entry?.link || !installedPath(entryPath)) continue
    names.add(entryPath.slice(entryPath.lastIndexOf('node_modules/') + 'node_modules/'.length))
  }
  return names
}

// Every copy of `name` the lockfile installs, by the same rule the override
// classifier uses: one per node_modules path, named by the entry's own `name`
// (an npm: alias) or else by its path; links are not copies.
function lockCopies(lock, name) {
  return Object.entries(lock?.packages ?? {})
    .filter(([entryPath, entry]) => entryPath !== '' && !entry?.link && installedPath(entryPath)
      && (entry?.name ?? entryPath.slice(entryPath.lastIndexOf('node_modules/') + 'node_modules/'.length)) === name)
    .map(([entryPath, entry]) => ({ path: entryPath, version: entry?.version ?? null, dependencies: Object.keys(entry?.dependencies ?? {}) }))
    .sort((left, right) => left.path.localeCompare(right.path))
}

// `overrideFindings` compares unconditional exact pins only and throws on
// anything else. Each override is offered to it alone first, so what is later
// compared is exactly what that classifier accepts, and everything else is
// listed as unchecked instead of being silently skipped.
function splitOverrides(overrides) {
  const exact = {}
  const unchecked = []
  for (const [name, value] of Object.entries(isObject(overrides) ? overrides : {})) {
    try {
      overrideFindings({ publisherOverrides: { [name]: value }, consumerLock: { packages: {} } })
      exact[name] = value
    } catch (error) {
      if (!(error instanceof TypeError)) throw error
      const reason = isObject(value) ? 'nested' : /selects versions/.test(error.message) ? 'selector-key' : 'non-exact'
      unchecked.push({ name, reason })
    }
  }
  return { exact, unchecked }
}

// The lockfile path npm's resolution gives a dependency named by its ancestry
// (`a > b` is b as required by a): the nearest node_modules holding it, from
// the requiring package outwards. Null when the lockfile has no such entry.
function lockPathFor(lock, names) {
  const packages = lock?.packages ?? {}
  let current = ''
  for (const name of names) {
    let base = current
    let found = null
    for (;;) {
      const candidate = `${base ? `${base}/` : ''}node_modules/${name}`
      if (Object.hasOwn(packages, candidate)) {
        found = candidate
        break
      }
      if (base === '') break
      const cut = base.lastIndexOf('/node_modules/')
      base = cut === -1 ? '' : base.slice(0, cut)
    }
    if (found === null) return null
    const entry = packages[found]
    current = entry?.link && typeof entry.resolved === 'string' ? entry.resolved : found
  }
  return current
}

// One entry per dependency path in an `npm ls --all --json` tree, keyed by the
// names along the path. It is built from `npmTreeLines`, so a package with no
// installed version is read the same way the captured-closure check reads it.
function treeVersions(npmLsJson) {
  const versions = new Map()
  for (const line of npmTreeLines(npmLsJson)) {
    const names = []
    let version = null
    for (const segment of line.split(' > ')) {
      const at = segment.lastIndexOf('@')
      names.push(segment.slice(0, at))
      version = segment.slice(at + 1)
    }
    versions.set(names.join(' > '), { names, version: version === 'missing' ? null : version })
  }
  return versions
}

// The differences between the tree the lockfile describes (`npm ls --all
// --json --package-lock-only`) and the installed tree (`npm ls --all --json`),
// by dependency path and version, each classified on evidence:
// - `stale`: two different versions at one dependency path;
// - `otherPlatform`: no installed version, and the lockfile entry's `os`,
//   `cpu` or `libc` excludes this host;
// - `missing`: no installed version and no such evidence;
// - `extraneous`: installed, and not in the lockfile's tree.
// `agrees` is true only when both trees report no problems and nothing is
// stale, missing or extraneous. Both trees are passed in; nothing runs npm.
export function lockTreeDifferences({ lock, lockTree, installedTree, host } = {}) {
  const problems = [...(lockTree?.problems ?? []), ...(installedTree?.problems ?? [])].map(String)
  const locked = treeVersions(lockTree)
  const installed = treeVersions(installedTree)
  const stale = []
  const otherPlatform = []
  const missing = []
  const extraneous = []
  for (const [dependencyPath, want] of locked) {
    const have = installed.get(dependencyPath)
    if (have && have.version !== null) {
      if (have.version !== want.version) stale.push({ dependencyPath, locked: want.version, installed: have.version })
      continue
    }
    const lockPath = lockPathFor(lock, want.names)
    const excludedBy = lockPath === null ? null : platformExclusion(lock.packages[lockPath], host)
    if (excludedBy) otherPlatform.push({ dependencyPath, lockPath, excludedBy })
    else missing.push({ dependencyPath, lockPath })
  }
  for (const [dependencyPath, have] of installed) {
    if (!locked.has(dependencyPath)) extraneous.push({ dependencyPath, installed: have.version })
  }
  return {
    agrees: problems.length === 0 && stale.length === 0 && missing.length === 0 && extraneous.length === 0,
    problems,
    stale,
    otherPlatform,
    missing,
    extraneous,
  }
}

// This package's own name: the default selected package of a guided upgrade.
function ownPackageName() {
  return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).name
}

// The plan for one explicit npm root. It never throws for a classified case:
// every refusal is an entry in `refusals`, with the typed code, one bounded
// reason, a message and a next step. `status` is 'planned' or 'refused';
// `proof` is always 'not-run'.
//
// - `npmRoot`: absolute path of the staged candidate's npm root. Required.
// - `selectedPackage`: the package whose exact overrides are checked against
//   the candidate's lockfile. Defaults to this package.
// - `approvedRegistryHosts`: when given, a registry tarball on any other host
//   is refused. When absent, hosts are reported and left unverified, because
//   this plan does not read npm configuration.
// - `host`: `{ os, cpu, libc }` for the platform evidence. Defaults to this
//   process, with libc unknown.
export function planConsumerClosure({ npmRoot, selectedPackage = null, approvedRegistryHosts = null, host = null } = {}) {
  const plan = {
    command: 'upgrade closure',
    proof: 'not-run',
    status: 'refused',
    npmRoot: typeof npmRoot === 'string' ? npmRoot : null,
    prefixVerified: false,
    approvedRegistryVerified: false,
    refusals: [],
  }
  const refuse = (code, reason, message, detail = {}) => {
    plan.refusals.push({ code, reason, message, hint: HINTS[reason], ...detail })
    return plan
  }

  if (typeof npmRoot !== 'string' || npmRoot.trim() === '') {
    return refuse(USAGE, 'npm-root-required', '--npm-root is required: name the staged candidate\'s npm root explicitly')
  }
  if (!path.isAbsolute(npmRoot)) return refuse(USAGE, 'npm-root-not-absolute', '--npm-root must be an absolute path')
  const root = path.resolve(npmRoot)
  plan.npmRoot = root
  let rootIsDirectory = false
  try {
    rootIsDirectory = fs.statSync(root).isDirectory()
  } catch {
    rootIsDirectory = false
  }
  if (!rootIsDirectory) return refuse(USAGE, 'npm-root-not-directory', '--npm-root does not name an existing directory')
  // npm works from the physical directory. A path through a link would have
  // its own parents checked for workspaces here, not the parents npm sees.
  let realRoot = null
  try {
    realRoot = fs.realpathSync(root)
  } catch {
    realRoot = null
  }
  if (realRoot !== root) {
    return refuse(USAGE, 'npm-root-linked', '--npm-root is not the real path of the directory: it is a link or passes through one')
  }
  if (selectedPackage !== null && selectedPackage !== undefined && (typeof selectedPackage !== 'string' || selectedPackage.trim() === '')) {
    return refuse(USAGE, 'argument-unsupported', '--package needs a package name', { argument: '--package' })
  }
  if (approvedRegistryHosts !== null && approvedRegistryHosts !== undefined
    && (!Array.isArray(approvedRegistryHosts) || approvedRegistryHosts.length === 0
      || approvedRegistryHosts.some((item) => typeof item !== 'string' || item.trim() === ''))) {
    return refuse(USAGE, 'argument-unsupported', '--registry-host needs at least one host name', { argument: '--registry-host' })
  }

  const manifest = readJsonObject(path.join(root, 'package.json'))
  if (!manifest.value) return refuse(USAGE, 'manifest-missing', 'the npm root has no readable package.json')
  if (declaresWorkspaces(manifest.value)) return refuse(USAGE, 'workspaces', 'the npm root declares npm workspaces, which this plan does not support')
  if (workspaceAncestor(root) !== null) {
    return refuse(USAGE, 'prefix-mismatch', 'a parent directory declares npm workspaces, so npm would not treat this directory as its own root project')
  }
  if (nodeModulesIsLinked(root)) {
    return refuse(USAGE, 'linked-node-modules', 'node_modules in the npm root is a link or resolves inside another installation')
  }

  const lockFile = readJsonObject(path.join(root, 'package-lock.json'))
  if (lockFile.missing) return refuse(USAGE, 'lockfile-missing', 'the npm root has no package-lock.json')
  if (lockFile.invalid) return refuse(USAGE, 'lockfile-invalid', 'package-lock.json in the npm root is not a JSON object')
  const lock = lockFile.value
  if (![2, 3].includes(lock.lockfileVersion) || !isObject(lock.packages)) {
    return refuse(USAGE, 'lockfile-version', 'package-lock.json must be lockfileVersion 2 or 3 with a packages map')
  }
  // Every classifier below iterates the packages map, so its shape is checked
  // once here and a malformed entry is a typed refusal, never a TypeError.
  const malformed = Object.keys(lock.packages).filter((entryPath) => !isObject(lock.packages[entryPath])).sort((left, right) => left.localeCompare(right))
  if (malformed.length > 0) {
    return refuse(USAGE, 'lockfile-invalid', `package-lock.json records ${JSON.stringify(malformed[0])} as something other than a package entry`,
      { path: malformed[0], malformedEntries: malformed.length })
  }
  if (declaresWorkspaces(lock.packages[''])) {
    return refuse(USAGE, 'workspaces', 'the lockfile records npm workspaces, which this plan does not support')
  }

  plan.lock = {
    file: 'package-lock.json',
    sha256: sha256(lockFile.bytes),
    lockfileVersion: lock.lockfileVersion,
    entries: Object.keys(lock.packages).filter((entryPath) => entryPath !== '').length,
  }
  plan.host = { os: host?.os ?? process.platform, cpu: host?.cpu ?? process.arch, libc: host?.libc ?? null }

  const sources = lockSourceFindings(lock, { npmRoot: root, approvedRegistryHosts })
  plan.sources = { counts: sources.counts, registryHosts: sources.registryHosts, registrySchemes: sources.registrySchemes }
  plan.approvedRegistryVerified = Array.isArray(approvedRegistryHosts) && approvedRegistryHosts.length > 0
  const sourceMessages = {
    'git-source': (finding) => `the lockfile records ${finding.path} from a git source, which an offline reinstall from the registry cannot capture`,
    'other-host': (finding) => (finding.host === null
      ? `the lockfile records ${finding.path} from a registry URL with no readable host, which no approved registry host can match`
      : `the lockfile records ${finding.path} from ${finding.host}, which is not an approved registry host`),
    'link-target-missing': (finding) => `the lockfile records ${finding.path} as a link without the folder it resolves to`,
    'outside-project': (finding) => `the lockfile records ${finding.path} from a source outside the npm root`,
  }
  for (const finding of sources.findings) {
    const { reason, ...detail } = finding
    refuse(CONSUMER_CLOSURE_INCOMPLETE, reason, sourceMessages[reason](finding), detail)
  }

  const { tarballs, missing } = capturedClosure(lock)
  plan.capture = { registryTarballs: tarballs.length }
  for (const entryPath of missing.filter(installedPath)) {
    refuse(CONSUMER_CLOSURE_INCOMPLETE, 'missing-integrity',
      `the lockfile records ${entryPath} without a registry resolved URL or integrity`, { path: entryPath })
  }

  plan.otherPlatform = Object.entries(lock.packages)
    .filter(([entryPath, entry]) => entryPath !== '' && installedPath(entryPath) && !entry?.link)
    .map(([entryPath, entry]) => ({ path: entryPath, optional: entry?.optional === true, excludedBy: platformExclusion(entry, plan.host) }))
    .filter((item) => item.excludedBy !== null)
    .sort((left, right) => left.path.localeCompare(right.path))

  const selected = typeof selectedPackage === 'string' ? selectedPackage.trim() : ownPackageName()
  const copies = lockCopies(lock, selected)
  // `manifests` names every installed manifest this plan read for the selected
  // package, with the identity it declares, so a reader can see what the
  // override check was based on.
  plan.selectedPackage = { name: selected, copies: copies.map(({ path: copyPath, version }) => ({ path: copyPath, version })), manifests: [] }
  plan.overrides = { checked: [], notInstalled: [], unchecked: [], multipleCopiesAtPin: [] }
  if (copies.length === 0) {
    refuse(CONSUMER_CLOSURE_INCOMPLETE, 'zero-copies',
      `the lockfile lists no copy of the selected package ${selected}, so its overrides were not checked`, { package: selected })
  } else {
    // Each copy's manifest is bound to its own lockfile entry by name and
    // version. Overrides are used only when every copy is bound and all copies
    // agree; a refused or unreadable copy contributes nothing.
    const bound = []
    for (const copy of copies) {
      const manifestPath = `${copy.path}/package.json`
      const installedManifest = insideProject(root, copy.path)
        ? readJsonObject(path.join(root, copy.path, 'package.json'))
        : { missing: true }
      if (!installedManifest.value) {
        refuse(CONSUMER_CLOSURE_INCOMPLETE, 'selected-package-unreadable',
          `the manifest of the selected package ${selected} cannot be read at ${copy.path}, so its overrides were not checked`,
          { package: selected, path: copy.path })
        continue
      }
      const declared = {
        name: typeof installedManifest.value.name === 'string' ? installedManifest.value.name : null,
        version: typeof installedManifest.value.version === 'string' ? installedManifest.value.version : null,
      }
      plan.selectedPackage.manifests.push({ path: manifestPath, ...declared, sha256: sha256(installedManifest.bytes) })
      if (declared.name !== selected || copy.version === null || declared.version !== copy.version) {
        refuse(CONSUMER_CLOSURE_INCOMPLETE, 'selected-package-mismatch',
          `the manifest at ${manifestPath} declares ${declared.name ?? 'no name'}@${declared.version ?? 'no version'}, but the lockfile records ${selected}@${copy.version ?? 'no version'} there, so its overrides were not used`,
          { package: selected, path: copy.path, locked: { name: selected, version: copy.version }, manifest: declared })
        continue
      }
      bound.push({ copy, overrides: installedManifest.value.overrides })
    }
    const lockedVersions = [...new Set(copies.map((copy) => String(copy.version)))]
    const overrideSets = [...new Set(bound.map((item) => JSON.stringify(item.overrides ?? null)))]
    if (lockedVersions.length > 1 || (bound.length === copies.length && overrideSets.length > 1)) {
      refuse(CONSUMER_CLOSURE_INCOMPLETE, 'selected-copies-differ',
        `the lockfile installs the selected package ${selected} at ${copies.map((copy) => `${copy.path}@${copy.version}`).join(', ')}, and the copies do not agree, so its overrides were not checked`,
        { package: selected, copies: plan.selectedPackage.copies })
    } else if (bound.length === copies.length) {
      const { exact, unchecked } = splitOverrides(bound[0].overrides)
      plan.overrides.unchecked = unchecked
      const { findings, compared } = overrideFindings({ publisherOverrides: exact, consumerLock: lock })
      const required = new Set(copies.flatMap((copy) => copy.dependencies))
      const linked = linkedNames(lock)
      const offPin = new Set()
      for (const finding of findings) {
        const away = finding.found.filter((copy) => copy.version !== finding.pinned)
        if (away.length === 0) {
          // More than one copy, all at the pin: valid in an owner's tree.
          plan.overrides.multipleCopiesAtPin.push({ package: finding.package, pinned: finding.pinned, found: finding.found })
          continue
        }
        offPin.add(finding.package)
        refuse(OVERRIDE_NOT_INHERITED, 'copy-off-pin',
          `${finding.package} is pinned to ${finding.pinned} by the selected package's override, but the lockfile installs ${finding.found.map((copy) => `${copy.path}@${copy.version}`).join(', ')}`,
          { package: finding.package, pinned: finding.pinned, found: finding.found })
      }
      for (const name of Object.keys(exact)) {
        if (linked.has(name)) {
          // A link provides this package and the plan does not read the linked
          // folder's version: never checked and never "not installed". An
          // off-pin registry copy beside the link is still refused above.
          plan.overrides.unchecked.push({ name, reason: compared.includes(name) ? 'linked-copy' : 'link-only' })
        } else if (compared.includes(name)) {
          if (!offPin.has(name)) plan.overrides.checked.push(name)
        } else if (required.has(name)) {
          // The selected package depends on it, yet the lockfile holds no copy:
          // a failed listing, never a pass.
          refuse(CONSUMER_CLOSURE_INCOMPLETE, 'zero-copies',
            `the selected package ${selected} depends on ${name}, but the lockfile lists no copy of it`, { package: name })
        } else {
          plan.overrides.notInstalled.push(name)
        }
      }
    }
  }

  plan.status = plan.refusals.length === 0 ? 'planned' : 'refused'
  return plan
}

// The plan's first refusal as the typed error the CLI prints, or null.
export function closureRefusalError(plan) {
  const [first, ...rest] = plan?.refusals ?? []
  if (!first) return null
  const more = rest.length > 0 ? ` (and ${rest.length} more; see the JSON result)` : ''
  return new AtelierDiagnosticError(first.code, `${first.message}${more}`, { hint: first.hint, exitCode: CLOSURE_REFUSAL_EXIT })
}

const CLOSURE_FLAGS = ['npm-root', 'package', 'registry-host']

// How often each closure flag appears in the raw arguments, in either
// spelling (`--flag value` or `--flag=value`). The shared parser keeps only
// the last value of a repeated flag, so repeats are counted here.
function repeatedFlags(argv) {
  return CLOSURE_FLAGS.filter((flag) => argv.filter((item) => item === `--${flag}` || (typeof item === 'string' && item.startsWith(`--${flag}=`))).length > 1)
}

// `atelier upgrade closure --npm-root <absolute-dir>`. Prints exactly one JSON
// plan, then exits 3 for a completed plan or throws the typed refusal (exit
// 2). An argument this command does not accept is a refused plan too, so
// every run prints one document. It resolves no Atelier project and writes
// nothing. `argv` is the raw argument list, used only to refuse a flag given
// more than once.
export function runClosurePlanCommand(args, argv = []) {
  const unsupported = [
    ...Object.keys(args).filter((key) => key !== '_' && !CLOSURE_FLAGS.includes(key)).map((key) => `--${key}`),
    ...(args._ ?? []).slice(1).map((item) => (item === '' ? '(empty argument)' : item)),
  ]
  const valueless = CLOSURE_FLAGS.filter((flag) => args[flag] === true)
  const repeated = repeatedFlags(Array.isArray(argv) ? argv : [])
  const hosts = typeof args['registry-host'] === 'string'
    ? args['registry-host'].split(',').map((item) => item.trim()).filter(Boolean)
    : null
  let argumentProblem = null
  if (unsupported.length > 0) argumentProblem = [`upgrade closure does not accept ${unsupported.join(', ')}`, unsupported]
  else if (valueless.length > 0) argumentProblem = [`${valueless.map((flag) => `--${flag}`).join(', ')} needs a value`, valueless.map((flag) => `--${flag}`)]
  else if (repeated.length > 0) argumentProblem = [`${repeated.map((flag) => `--${flag}`).join(', ')} was given more than once`, repeated.map((flag) => `--${flag}`)]
  else if (typeof args.package === 'string' && args.package.trim() === '') argumentProblem = ['--package needs a package name', ['--package']]
  else if (hosts !== null && hosts.length === 0) argumentProblem = ['--registry-host needs at least one host name', ['--registry-host']]

  const plan = argumentProblem
    ? {
        command: 'upgrade closure',
        proof: 'not-run',
        status: 'refused',
        npmRoot: typeof args['npm-root'] === 'string' ? args['npm-root'] : null,
        prefixVerified: false,
        approvedRegistryVerified: false,
        refusals: [{ code: USAGE, reason: 'argument-unsupported', message: argumentProblem[0], hint: HINTS['argument-unsupported'], arguments: argumentProblem[1] }],
      }
    : planConsumerClosure({
        npmRoot: typeof args['npm-root'] === 'string' ? args['npm-root'] : null,
        selectedPackage: typeof args.package === 'string' ? args.package : null,
        approvedRegistryHosts: hosts,
      })
  console.log(JSON.stringify(plan, null, 2))
  const refusal = closureRefusalError(plan)
  if (refusal) throw refusal
  process.exitCode = CLOSURE_PLAN_EXIT
}
