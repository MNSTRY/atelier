import { execFileSync } from 'node:child_process'
import { SUPPORTED_IDENTITY_PROVIDERS, gitRemoteUrl, remoteHost } from './config.mjs'

export const SUPPORTED_PROVIDERS = Object.freeze([...SUPPORTED_IDENTITY_PROVIDERS])

const PROVIDER_HOSTS = Object.freeze({ 'github.com': 'github' })

const lower = (value) => String(value ?? '').trim().toLowerCase()

/**
 * Parse owner/name out of a remote URL. This is the *recorded* name, which after a
 * rename is the stale one — hosting providers redirect the old URL indefinitely, so
 * a clone keeps fetching happily under a name that no longer exists.
 */
export function parseRemoteRef(url) {
  const host = remoteHost(url)
  if (!host) return null
  const text = String(url).trim().replace(/\.git$/, '')
  const tail = text.match(/^[^/@]+@[^:/]+:(.+)$/) ?? text.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i)
  if (!tail) return null
  const parts = tail[1].split('/').filter(Boolean)
  if (parts.length < 2) return null
  return { host, provider: PROVIDER_HOSTS[host] ?? null, owner: lower(parts[0]), name: lower(parts.slice(1).join('/')) }
}

// Ask the provider to resolve the recorded ref. GitHub follows the rename redirect
// and answers with the stable numeric id plus the current full name, which is the
// only signal that survives a rename.
export function githubLookup({ owner, name }) {
  try {
    const out = execFileSync('gh', ['api', `repos/${owner}/${name}`, '--jq', '{id: .id, fullName: .full_name}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const parsed = JSON.parse(out)
    if (!parsed?.id) return null
    return { id: String(parsed.id), fullName: lower(parsed.fullName), currentName: lower(String(parsed.fullName).split('/').pop()) }
  } catch {
    return null
  }
}

const defaultLookups = { github: githubLookup }

/**
 * Resolve a clone's stable identity.
 *
 * Never keys on the root commit: repos created from a shared template have
 * identical root commits, so that heuristic reports false duplicates, and it
 * cannot see a rename at all. Never keys on the folder name either. When the
 * provider is unreachable it falls back to the recorded identity and then to
 * declared aliases, and says so in `source` rather than guessing.
 */
export function resolveRepoIdentity(cloneDir, { repo = {}, lookups = defaultLookups, remoteUrl = null } = {}) {
  const url = remoteUrl ?? gitRemoteUrl(cloneDir)
  const ref = parseRemoteRef(url)
  const declared = repo.identity ?? null
  const aliases = (Array.isArray(repo.aliases) ? repo.aliases : []).map(lower)
  const base = {
    path: cloneDir ?? null,
    remoteUrl: url,
    provider: ref?.provider ?? declared?.provider ?? null,
    owner: ref?.owner ?? null,
    remoteName: ref?.name ?? null,
    declaredId: declared?.id ? String(declared.id) : null,
    aliases,
  }

  const lookup = base.provider ? lookups[base.provider] : null
  if (ref && lookup) {
    const found = lookup(ref)
    if (found) {
      return {
        ...base,
        ok: true,
        id: found.id,
        currentName: found.currentName,
        fullName: found.fullName,
        renamed: Boolean(ref.name && found.currentName && ref.name !== found.currentName),
        source: 'provider',
        reachable: true,
      }
    }
  }

  if (base.declaredId) {
    return { ...base, ok: true, id: base.declaredId, currentName: lower(repo.name) || base.remoteName, renamed: false, source: 'recorded-identity', reachable: false }
  }
  if (base.remoteName && aliases.includes(base.remoteName)) {
    return { ...base, ok: true, id: null, currentName: lower(repo.name), renamed: true, source: 'alias', reachable: false }
  }
  if (base.remoteName) {
    return { ...base, ok: true, id: null, currentName: base.remoteName, renamed: false, source: 'remote-url', reachable: false }
  }
  return { ...base, ok: false, id: null, currentName: null, renamed: false, source: 'unresolved', reachable: false }
}

export function identityKey(identity) {
  if (identity?.id) return `${identity.provider ?? 'unknown'}:${identity.id}`
  if (identity?.owner && identity?.currentName) return `${identity.provider ?? identity.remoteUrl ?? 'unknown'}:${identity.owner}/${identity.currentName}`
  return null
}

/**
 * Report identity problems a workspace cannot see on its own: stale folder names
 * after a rename, two clones that are really the same repo, and config entries
 * pointing at a repo the provider does not know.
 */
export function auditRepoIdentities(project, { lookups = defaultLookups } = {}) {
  const findings = []
  const byKey = new Map()

  for (const repo of project.repos ?? []) {
    if (repo.external || !repo.path) continue
    const identity = resolveRepoIdentity(repo.path, { repo, lookups })

    if (!identity.ok) {
      findings.push({
        severity: 'warning',
        code: 'repo-identity-unresolved',
        repo: repo.name,
        message: `${repo.name}: no origin remote, so the workspace cannot tell this clone apart from any other`,
      })
      continue
    }
    if (identity.source === 'provider' && identity.renamed) {
      findings.push({
        severity: 'warning',
        code: 'repo-renamed-upstream',
        repo: repo.name,
        message: `${repo.name}: remote still says "${identity.remoteName}" but the provider now calls it "${identity.currentName}" — a rename is a metadata update, not a new identity`,
        details: { from: identity.remoteName, to: identity.currentName, id: identity.id },
      })
    }
    if (identity.currentName && repo.name && lower(repo.name) !== identity.currentName) {
      const viaAlias = identity.aliases.includes(lower(repo.name)) || identity.aliases.includes(identity.remoteName ?? '')
      findings.push({
        severity: viaAlias ? 'warning' : 'error',
        code: viaAlias ? 'repo-name-alias-deprecated' : 'repo-folder-name-stale',
        repo: repo.name,
        message: viaAlias
          ? `${repo.name}: resolved through a recorded alias; update the config name to "${identity.currentName}"`
          : `${repo.name}: config name does not match the canonical name "${identity.currentName}"; record it under aliases if this rename is intentional`,
        details: { configured: repo.name, canonical: identity.currentName },
      })
    }
    if (identity.id && !identity.declaredId) {
      findings.push({
        severity: 'warning',
        code: 'repo-identity-undeclared',
        repo: repo.name,
        message: `${repo.name}: record identity { provider: "${identity.provider}", id: "${identity.id}" } so this repo survives a rename while the provider is unreachable`,
        details: { provider: identity.provider, id: identity.id },
      })
    }

    const key = identityKey(identity)
    if (!key) continue
    const first = byKey.get(key)
    if (first) {
      // A retired clone left behind by a rename. It fetches fine through the
      // provider redirect, which is exactly why it goes unnoticed.
      findings.push({
        severity: 'error',
        code: 'repo-identity-duplicate',
        repo: repo.name,
        message: `${repo.name} and ${first.repo} resolve to one repository (${key}); park the retired clone instead of syncing both`,
        details: { key, clones: [first.path, repo.path] },
      })
      continue
    }
    byKey.set(key, { repo: repo.name, path: repo.path })
  }

  return { ok: !findings.some((item) => item.severity === 'error'), findings }
}
