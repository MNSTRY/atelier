import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024

function executableNames(platform = process.platform, env = process.env) {
  if (platform !== 'win32') return ['git']
  const extensions = String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
  return ['git.exe', ...extensions.map((extension) => `git${extension}`).filter((name) => name !== 'git.exe')]
}

function isExecutable(file, platform = process.platform) {
  try {
    fs.accessSync(file, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

function canonicalExecutable(file) {
  try {
    return fs.realpathSync.native(file)
  } catch {
    return fs.realpathSync(file)
  }
}

/**
 * Resolve one exact Git executable without invoking a shell. The selected path
 * is carried through every later operation so PATH changes cannot swap engines
 * underneath a running supervisor.
 */
export function resolveGitExecutable({ env = process.env, platform = process.platform } = {}) {
  const configured = String(env.ATELIER_GIT_PATH || '').trim()
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error('ATELIER_GIT_PATH must be an absolute path')
    if (!isExecutable(configured, platform)) throw new Error(`configured Git executable is unavailable: ${configured}`)
    return canonicalExecutable(configured)
  }

  const searchPath = String(env.PATH || '')
  const delimiter = platform === 'win32' ? ';' : path.delimiter
  const names = executableNames(platform, env)
  for (const directory of searchPath.split(delimiter).filter(Boolean)) {
    const cleanDir = directory.replace(/^"|"$/g, '')
    for (const name of names) {
      const candidate = path.join(cleanDir, name)
      if (isExecutable(candidate, platform)) return canonicalExecutable(candidate)
    }
  }
  throw new Error('compatible system Git was not found on PATH')
}

const REPOSITORY_REDIRECT_ENV = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_QUARANTINE_PATH',
  'GIT_NAMESPACE',
  'GIT_SHALLOW_FILE',
  'GIT_GRAFT_FILE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_ATTR_NOSYSTEM',
])

export function sanitizedGitEnvironment(env = process.env, allowPrompt = false) {
  const next = { ...env }
  for (const key of Object.keys(next)) {
    if (REPOSITORY_REDIRECT_ENV.has(key) || key === 'GIT_CONFIG_NOSYSTEM' || key.startsWith('GIT_CONFIG_')) delete next[key]
  }
  if (!allowPrompt) next.GIT_TERMINAL_PROMPT = '0'
  next.GIT_OPTIONAL_LOCKS = next.GIT_OPTIONAL_LOCKS || '1'
  next.GIT_NO_REPLACE_OBJECTS = '1'
  return next
}

export function redactGitDiagnostic(value) {
  return String(value || '')
    .replace(/https?:\/\/[^\s]+/gi, (url) => sanitizeRemoteUrl(url))
    .replace(/\b((?:password|passwd|token|secret|authorization|proxy-authorization|extraheader)\s*[=:]\s*)[^\s]+/gi, '$1[redacted]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
}

export class GitCommandError extends Error {
  constructor(message, result) {
    super(message)
    this.name = 'GitCommandError'
    this.result = result
  }
}

export function runGit(gitExecutable, repoRoot, args, {
  allowFailure = false,
  allowPrompt = false,
  env = process.env,
  input = undefined,
  timeout = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!path.isAbsolute(gitExecutable)) throw new Error('Git executable must be an absolute path')
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
    throw new Error('Git arguments must be a string array')
  }
  const argv = repoRoot ? ['-C', repoRoot, ...args] : args
  const child = spawnSync(gitExecutable, argv, {
    encoding: 'utf8',
    env: sanitizedGitEnvironment(env, allowPrompt),
    input,
    maxBuffer: DEFAULT_MAX_BUFFER,
    shell: false,
    timeout,
    windowsHide: true,
  })
  const result = {
    ok: !child.error && child.status === 0,
    status: child.status,
    signal: child.signal ?? null,
    stdout: child.stdout || '',
    stderr: redactGitDiagnostic(child.stderr || ''),
    error: child.error?.message ? redactGitDiagnostic(child.error.message) : null,
    executable: gitExecutable,
    args: argv,
  }
  if (!result.ok && !allowFailure) {
    const detail = result.error || result.stderr.trim() || `exit ${String(result.status)}`
    throw new GitCommandError(`Git ${args[0] || 'command'} failed: ${detail}`, result)
  }
  return result
}

export function gitText(gitExecutable, repoRoot, args, options = {}) {
  return runGit(gitExecutable, repoRoot, args, options).stdout.trim()
}

export function parseGitVersion(text) {
  const match = String(text || '').match(/git version (\d+)\.(\d+)\.(\d+)/i)
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), text: match[0] }
}

export function inspectGitEngine(gitExecutable, { env = process.env } = {}) {
  const result = runGit(gitExecutable, null, ['--version'], { env })
  const version = parseGitVersion(result.stdout)
  if (!version) throw new Error(`unrecognized Git version output from ${gitExecutable}`)
  return {
    executable: gitExecutable,
    version: `${version.major}.${version.minor}.${version.patch}`,
    supported: version.major > 2 || (version.major === 2 && version.minor >= 39),
    minimum: '2.39.0',
  }
}

export function classifyRemoteAuthentication(url) {
  const value = String(url || '').trim()
  if (!value) return 'none'
  if (/^(?:ssh:\/\/|[^/@\s]+@[^:/\s]+:)/i.test(value)) return 'ssh'
  if (/^https?:\/\//i.test(value)) return 'https'
  if (/^(?:file:\/\/|\.{0,2}[\\/]|[a-z]:[\\/]|[\\/])/i.test(value)) return 'local'
  return 'unknown'
}

/**
 * Remote URLs are evidence, not authentication material. Git may carry HTTP
 * credentials in user-info or query fragments, so local observations retain
 * only the provider/repository address needed for diagnosis.
 */
export function sanitizeRemoteUrl(url) {
  const value = String(url || '').trim()
  const scpLike = value.match(/^[^/@\s]+@([^:/\s]+:.+)$/)
  if (scpLike) return scpLike[1]
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value
  try {
    const parsed = new URL(value)
    parsed.username = ''
    Reflect.set(parsed, 'password', '')
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return value.replace(/^((?:https?|ssh):\/\/)(?:[^/@:]+:)?[^/@]+@/i, '$1')
  }
}

export function parseNullConfig(text) {
  const entries = []
  for (const record of String(text || '').split('\0').filter(Boolean)) {
    const newline = record.indexOf('\n')
    if (newline === -1) entries.push({ key: record, value: '' })
    else entries.push({ key: record.slice(0, newline), value: record.slice(newline + 1) })
  }
  return entries
}
