import { execFileSync } from 'node:child_process'

export const PROVIDER_HOSTS = Object.freeze({ 'github.com': 'github' })

const lower = (value) => String(value ?? '').trim().toLowerCase()

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

export const defaultLookups = { github: githubLookup }
