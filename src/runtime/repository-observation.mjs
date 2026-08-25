import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { validateJsonSchema } from '../export/atelier-export-contract.mjs'
import {
  classifyRemoteAuthentication,
  gitText,
  inspectGitEngine,
  parseNullConfig,
  runGit,
  sanitizeRemoteUrl,
} from './git-adapter.mjs'

export const ATELIER_REPOSITORY_OBSERVATION_SCHEMA = 'atelier-repository-observation@v1'
const OBSERVATION_CONTRACT = JSON.parse(fs.readFileSync(new URL('../../contracts/atelier-repository-observation.v1.schema.json', import.meta.url), 'utf8'))

const CLOUD_PATH_PATTERNS = [
  { code: 'provider-managed-onedrive', pattern: /(?:^|[\\/])OneDrive(?:\s*-[^\\/]+)?(?:[\\/]|$)/i },
  { code: 'provider-managed-dropbox', pattern: /(?:^|[\\/])Dropbox(?:[\\/]|$)/i },
  { code: 'provider-managed-google-drive', pattern: /(?:^|[\\/])Google Drive(?:[\\/]|$)/i },
  { code: 'provider-managed-icloud', pattern: /(?:^|[\\/])(?:iCloud Drive|Mobile Documents)(?:[\\/]|$)/i },
  { code: 'provider-managed-cloudstorage', pattern: /(?:^|[\\/])Library[\\/]CloudStorage(?:[\\/]|$)/i },
]

function normalizeRelative(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '')
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function firstLine(value) {
  return String(value || '').split(/\r?\n/)[0].trim()
}

function optionalText(gitExecutable, repoRoot, args, { failures = null, label = args[0], allowMissing = false } = {}) {
  const result = runGit(gitExecutable, repoRoot, args, { allowFailure: true })
  if (result.ok) return result.stdout.trim()
  if (!allowMissing && failures) failures.push(blocker('observation-evidence-unavailable', `required Git evidence is unavailable: ${label}`, { probe: label }))
  return null
}

function boolConfig(config, key) {
  const item = config.find((entry) => entry.key.toLowerCase() === key.toLowerCase())
  return /^(?:true|yes|on|1)$/i.test(item?.value || '')
}

function configValues(config, pattern, { includeValue = false } = {}) {
  return config.filter((entry) => pattern.test(entry.key)).map((entry) => includeValue ? { key: entry.key, value: entry.value } : { key: entry.key })
}

export function classifyFilesystemRoot(candidate, { platform = process.platform } = {}) {
  const requested = String(candidate || '')
  if (!requested) return { supported: false, code: 'path-missing', requested, resolved: null }
  if (/^(?:\\\\|\/\/)/.test(requested)) {
    return { supported: false, code: 'network-unc-root', requested, resolved: null }
  }
  if (platform === 'linux' && /^\/mnt\/[a-z](?:\/|$)/i.test(requested)) {
    return { supported: false, code: 'wsl-cross-boundary-root', requested, resolved: null }
  }
  const cloud = CLOUD_PATH_PATTERNS.find(({ pattern }) => pattern.test(requested))
  if (cloud) return { supported: false, code: cloud.code, requested, resolved: null }

  let resolved
  try {
    resolved = fs.realpathSync.native(requested)
  } catch (error) {
    return { supported: false, code: 'path-unresolvable', requested, resolved: null, detail: error.code || error.message }
  }
  const resolvedCloud = CLOUD_PATH_PATTERNS.find(({ pattern }) => pattern.test(resolved))
  if (resolvedCloud) return { supported: false, code: resolvedCloud.code, requested, resolved }
  if (platform === 'darwin' && /^\/Volumes\//.test(resolved)) {
    return { supported: false, code: 'external-volume-unclassified', requested, resolved }
  }

  let statfs = null
  try {
    const value = fs.statfsSync(resolved)
    statfs = { type: String(value.type), blockSize: Number(value.bsize), blocks: Number(value.blocks) }
  } catch {
    // Filesystem metadata is useful evidence, but absence is not proof of a
    // remote root. The lexical refusal boundary remains deterministic.
  }
  return { supported: true, code: 'local-filesystem', requested, resolved, statfs }
}

export function resolveRepositoryRoot(candidate, gitExecutable) {
  const filesystem = classifyFilesystemRoot(candidate)
  if (!filesystem.supported) return { ok: false, filesystem, root: filesystem.resolved }
  const rootResult = runGit(gitExecutable, filesystem.resolved, ['rev-parse', '--show-toplevel'], { allowFailure: true })
  if (!rootResult.ok) return { ok: false, filesystem, root: null, error: 'path is not inside a Git worktree' }
  let root
  try {
    root = fs.realpathSync.native(rootResult.stdout.trim())
  } catch {
    root = fs.realpathSync(rootResult.stdout.trim())
  }
  const rootFilesystem = classifyFilesystemRoot(root)
  if (!rootFilesystem.supported) return { ok: false, filesystem: rootFilesystem, root }
  return { ok: true, filesystem: rootFilesystem, root }
}

export function parsePorcelainStatus(text) {
  const records = String(text || '').split('\0')
  const entries = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record) continue
    const code = record.slice(0, 2)
    const item = { code, path: normalizeRelative(record.slice(3)), originalPath: null }
    if (code[0] === 'R' || code[0] === 'C') {
      item.originalPath = normalizeRelative(records[index + 1] || '')
      index += 1
    }
    entries.push(item)
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path, 'en'))
}

function branchState(gitExecutable, root, failures) {
  const branch = optionalText(gitExecutable, root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { failures, label: 'current branch', allowMissing: true })
  const head = optionalText(gitExecutable, root, ['rev-parse', '--verify', 'HEAD'], { failures, label: 'HEAD identity' })
  const upstream = optionalText(gitExecutable, root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { failures, label: 'upstream identity', allowMissing: true })
  let ahead = 0
  let behind = 0
  if (upstream) {
    const counts = optionalText(gitExecutable, root, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`], { failures, label: 'upstream divergence counts' })
    const match = counts?.match(/^(\d+)\s+(\d+)$/)
    if (match) {
      ahead = Number(match[1])
      behind = Number(match[2])
    } else if (counts != null) {
      failures.push(blocker('observation-evidence-invalid', 'required Git evidence is malformed: upstream divergence counts', { probe: 'upstream divergence counts' }))
    }
  }
  return { branch, detached: !branch, head, upstream, ahead, behind }
}

function remoteState(gitExecutable, root, failures) {
  const names = (optionalText(gitExecutable, root, ['remote'], { failures, label: 'remote names' }) || '').split(/\r?\n/).filter(Boolean).sort()
  return names.map((name) => {
    const url = optionalText(gitExecutable, root, ['remote', 'get-url', name], { failures, label: `remote URL for ${name}` })
    return {
      name,
      url: sanitizeRemoteUrl(url),
      identityDigest: sha256(sanitizeRemoteUrl(url)),
      authentication: classifyRemoteAuthentication(url),
    }
  })
}

function submoduleState(gitExecutable, root) {
  if (!fs.existsSync(path.join(root, '.gitmodules'))) return { declared: false, entries: [], complete: true }
  const result = runGit(gitExecutable, root, ['submodule', 'status', '--recursive'], { allowFailure: true })
  const entries = result.stdout.split(/\r?\n/).filter(Boolean).map((line) => ({
    marker: line[0],
    value: line.slice(1).trim(),
  }))
  const complete = result.ok && entries.every((entry) => entry.marker === ' ')
  return { declared: true, entries, complete, error: result.ok ? null : firstLine(result.stderr) || 'submodule status failed' }
}

function lfsState(gitExecutable, root, failures) {
  const trackedAttributes = (optionalText(gitExecutable, root, ['ls-files', '--', '**/.gitattributes', '.gitattributes'], { failures, label: 'tracked attributes' }) || '')
    .split(/\r?\n/)
    .filter(Boolean)
  const attributeFiles = trackedAttributes.filter((file) => fs.existsSync(path.join(root, file)))
  const required = attributeFiles.some((file) => {
    const absolute = path.join(root, file)
    const stat = fs.lstatSync(absolute)
    if (stat.isSymbolicLink() || !stat.isFile()) {
      failures.push(blocker('observation-evidence-unavailable', 'tracked attributes evidence is redirected or not a regular file', { path: file }))
      return false
    }
    return /filter\s*=\s*lfs|filter=lfs/i.test(fs.readFileSync(absolute, 'utf8'))
  })
  const version = runGit(gitExecutable, root, ['lfs', 'version'], { allowFailure: true })
  if (!required) return { required: false, available: version.ok, complete: true, attributeFiles }
  if (!version.ok) return { required: true, available: false, complete: false, attributeFiles, error: 'Git LFS is required but unavailable' }
  const status = runGit(gitExecutable, root, ['lfs', 'fsck'], { allowFailure: true, timeout: 120_000 })
  return {
    required: true,
    available: true,
    complete: status.ok,
    attributeFiles,
    error: status.ok ? null : firstLine(status.stderr) || 'Git LFS object verification failed',
  }
}

function repositoryFeatures(gitExecutable, root, config, failures) {
  const gitDir = optionalText(gitExecutable, root, ['rev-parse', '--absolute-git-dir'], { failures, label: 'absolute Git directory' })
  const commonDirRaw = optionalText(gitExecutable, root, ['rev-parse', '--git-common-dir'], { failures, label: 'Git common directory' })
  const commonDir = commonDirRaw ? path.resolve(root, commonDirRaw) : null
  const worktrees = (optionalText(gitExecutable, root, ['worktree', 'list', '--porcelain'], { failures, label: 'worktree inventory' }) || '')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
  const filters = configValues(config, /^filter\./i)
  const customFilters = filters.filter((entry) => !/^filter\.lfs\./i.test(entry.key))
  const partialClone = configValues(config, /^(?:extensions\.partialclone|remote\..*\.promisor)$/i)
  const sparse = boolConfig(config, 'core.sparsecheckout') || Boolean(gitDir && fs.existsSync(path.join(gitDir, 'info', 'sparse-checkout')))
  return {
    gitDir,
    commonDir,
    linkedWorktree: Boolean(gitDir && commonDir && path.resolve(gitDir) !== path.resolve(commonDir)),
    worktrees,
    sparseCheckout: sparse,
    partialClone,
    filters,
    customFilters,
    hooksPathConfigured: config.some((entry) => entry.key.toLowerCase() === 'core.hookspath'),
    signing: {
      required: boolConfig(config, 'commit.gpgsign'),
      keyConfigured: config.some((entry) => entry.key.toLowerCase() === 'user.signingkey'),
      formatConfigured: config.some((entry) => entry.key.toLowerCase() === 'gpg.format'),
    },
    proxy: configValues(config, /^(?:http|https)\.proxy$/i),
  }
}

function gitMode(stat) {
  if (stat.isSymbolicLink()) return '120000'
  if (!stat.isFile()) return null
  return (stat.mode & 0o111) === 0 ? '100644' : '100755'
}

function indexEntry(gitExecutable, root, itemPath, failures) {
  const result = runGit(gitExecutable, root, ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', itemPath], { allowFailure: true })
  if (!result.ok) {
    failures.push(blocker('observation-evidence-unavailable', 'required Git index evidence is unavailable', { path: itemPath }))
    return null
  }
  const records = result.stdout.split('\0').filter(Boolean)
  if (!records.length) return null
  const parsed = records.map((record) => {
    const match = record.match(/^(\d{6}) ([0-9a-f]{40,64}) (\d)\t/)
    if (!match) return null
    return { mode: match[1], blob: match[2], stage: Number(match[3]) }
  })
  if (parsed.some((item) => !item)) {
    failures.push(blocker('observation-evidence-invalid', 'required Git index evidence is malformed', { path: itemPath }))
    return null
  }
  return parsed
}

function worktreeEntry(gitExecutable, root, itemPath, failures) {
  const absolute = path.join(root, itemPath)
  let stat
  try {
    stat = fs.lstatSync(absolute)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    failures.push(blocker('observation-evidence-unavailable', 'required worktree evidence is unavailable', { path: itemPath }))
    return null
  }
  const mode = gitMode(stat)
  if (!mode) {
    failures.push(blocker('observation-evidence-invalid', 'changed worktree path is not a regular file or symlink', { path: itemPath }))
    return null
  }
  const symlinkBytes = stat.isSymbolicLink() ? fs.readlinkSync(absolute, { encoding: 'buffer' }) : null
  const result = symlinkBytes
    ? runGit(gitExecutable, root, ['hash-object', '--stdin'], { allowFailure: true, input: symlinkBytes })
    : runGit(gitExecutable, root, ['--literal-pathspecs', 'hash-object', '--no-filters', '--', itemPath], { allowFailure: true })
  const blob = result.ok ? result.stdout.trim() : null
  if (!blob || !/^[0-9a-f]{40,64}$/.test(blob)) {
    failures.push(blocker('observation-evidence-unavailable', 'required worktree blob evidence is unavailable', { path: itemPath }))
    return null
  }
  const indexResult = symlinkBytes
    ? runGit(gitExecutable, root, ['hash-object', '--stdin'], { allowFailure: true, input: symlinkBytes })
    : runGit(gitExecutable, root, ['--literal-pathspecs', 'hash-object', `--path=${itemPath}`, '--', itemPath], { allowFailure: true })
  const indexBlob = indexResult.ok ? indexResult.stdout.trim() : null
  if (!indexBlob || !/^[0-9a-f]{40,64}$/.test(indexBlob)) {
    failures.push(blocker('observation-evidence-unavailable', 'required filtered blob evidence is unavailable', { path: itemPath }))
    return null
  }
  return { mode, blob, indexBlob }
}

function statusFingerprints(gitExecutable, root, entries, failures) {
  return entries.map((entry) => {
    const worktree = worktreeEntry(gitExecutable, root, entry.path, failures)
    const index = indexEntry(gitExecutable, root, entry.path, failures)
    const originalIndex = entry.originalPath ? indexEntry(gitExecutable, root, entry.originalPath, failures) : null
    return {
      code: entry.code,
      path: entry.path,
      originalPath: entry.originalPath,
      worktree,
      index,
      originalIndex,
    }
  })
}

function blocker(code, message, details = {}) {
  return { code, message, details }
}

function completenessFor({ filesystem, engine, bare, remotes, features, submodules, lfs, acquisitionFailures }) {
  const blockers = [...acquisitionFailures]
  const warnings = []
  if (!filesystem.supported) blockers.push(blocker(filesystem.code, 'repository root is not on a supported local filesystem'))
  if (!engine.supported) blockers.push(blocker('git-version-unsupported', `Git ${engine.version} is older than ${engine.minimum}`))
  if (bare) blockers.push(blocker('bare-repository-unsupported', 'a working tree is required'))
  if (features.sparseCheckout) blockers.push(blocker('sparse-checkout-unsupported', 'sparse workspaces are not complete observations'))
  if (features.partialClone.length) blockers.push(blocker('partial-clone-unsupported', 'partial clones may omit required Git objects', { config: features.partialClone }))
  if (!submodules.complete) blockers.push(blocker('submodules-incomplete', 'all declared submodules must be initialized and clean', { entries: submodules.entries }))
  if (!lfs.complete) blockers.push(blocker('lfs-incomplete', lfs.error || 'Git LFS content is not complete'))
  if (features.customFilters.length) blockers.push(blocker('custom-filter-unclassified', 'custom Git filters must be classified before synchronization', { filters: features.customFilters.map((entry) => entry.key) }))
  for (const remote of remotes) {
    if (remote.authentication === 'unknown') blockers.push(blocker('remote-authentication-unknown', `${remote.name} uses an unsupported remote URL shape`))
  }
  if (!remotes.length) warnings.push(blocker('remote-missing', 'repository has no remotes; local commits are possible but synchronization is not'))
  if (features.linkedWorktree) warnings.push(blocker('linked-worktree', 'repository is a linked worktree; the common Git directory is shared'))
  if (features.proxy.length) warnings.push(blocker('git-proxy-configured', 'Git proxy configuration is present and must be preserved'))
  return { complete: blockers.length === 0, blockers, warnings }
}

export function observeRepository({ repoRoot, gitExecutable, observedAt = new Date().toISOString() }) {
  const resolved = resolveRepositoryRoot(repoRoot, gitExecutable)
  if (!resolved.ok) {
    return {
      schema: ATELIER_REPOSITORY_OBSERVATION_SCHEMA,
      observedAt,
      complete: false,
      root: resolved.root,
      filesystem: resolved.filesystem,
      blockers: [blocker(resolved.filesystem?.code || 'repository-unresolved', resolved.error || 'repository could not be resolved')],
      warnings: [],
    }
  }
  const root = resolved.root
  const acquisitionFailures = []
  const engine = inspectGitEngine(gitExecutable)
  const bare = gitText(gitExecutable, root, ['rev-parse', '--is-bare-repository']) === 'true'
  const configResult = runGit(gitExecutable, root, ['config', '--null', '--list'], { allowFailure: true })
  const config = configResult.ok ? parseNullConfig(configResult.stdout) : []
  if (!configResult.ok) acquisitionFailures.push(blocker('observation-evidence-unavailable', 'required Git evidence is unavailable: configuration inventory', { probe: 'configuration inventory' }))
  const branch = branchState(gitExecutable, root, acquisitionFailures)
  const statusResult = runGit(gitExecutable, root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const entries = parsePorcelainStatus(statusResult.stdout)
  const remotes = remoteState(gitExecutable, root, acquisitionFailures)
  const features = repositoryFeatures(gitExecutable, root, config, acquisitionFailures)
  const submodules = submoduleState(gitExecutable, root)
  const lfs = lfsState(gitExecutable, root, acquisitionFailures)
  const conflicts = entries.filter((entry) => entry.code.includes('U') || ['AA', 'DD'].includes(entry.code))
  const staged = entries.filter((entry) => entry.code[0] && entry.code[0] !== '?' && entry.code[0] !== ' ')
  const unstaged = entries.filter((entry) => entry.code[1] && entry.code[1] !== ' ')
  const fingerprints = statusFingerprints(gitExecutable, root, entries, acquisitionFailures)
  const completeness = completenessFor({ filesystem: resolved.filesystem, engine, bare, remotes, features, submodules, lfs, acquisitionFailures })
  const statusDigest = sha256(JSON.stringify({ head: branch.head, branch: branch.branch, fingerprints }))
  return {
    schema: ATELIER_REPOSITORY_OBSERVATION_SCHEMA,
    observedAt,
    complete: completeness.complete,
    root,
    filesystem: resolved.filesystem,
    git: engine,
    bare,
    branch,
    remotes,
    features,
    submodules,
    lfs,
    status: {
      clean: entries.length === 0,
      digest: statusDigest,
      entries,
      fingerprints,
      stagedCount: staged.length,
      unstagedCount: unstaged.length,
      conflictCount: conflicts.length,
    },
    blockers: completeness.blockers,
    warnings: completeness.warnings,
  }
}

export function validateRepositoryObservation(doc) {
  return validateJsonSchema(OBSERVATION_CONTRACT, doc)
}
