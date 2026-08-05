// Single source of truth for the structural forbidden-content patterns shared
// by the release tarball audit and the repo-wide disclosure checker. These are
// deliberately committed (they disclose nothing); private name patterns live
// only in the maintainer-held denylist.
// Compile denylist pattern docs ({ pattern, flags?, label }) into scan-ready
// [{ pattern, label }] entries. The g and y flags are stripped because a
// global/sticky RegExp carries lastIndex across .test() calls and would
// silently skip matches in alternating files.
export function compileScanPatterns(patternDocs) {
  return patternDocs.map(
    ({ pattern, flags = '', label }) => ({ pattern: new RegExp(pattern, flags.replace(/[gy]/g, '')), label }),
  )
}

export const STRUCTURAL_FORBIDDEN_CONTENT = [
  { pattern: /\/Users\//, label: 'absolute user path' },
  { pattern: /\/var\/folders\//, label: 'machine-local temp path' },
  { pattern: /\.codex/, label: 'agent-local state path' },
  { pattern: /BEGIN (RSA|OPENSSH|PRIVATE) KEY/, label: 'private key material' },
  { pattern: /\b(api[_-]?key|secret|password|token)\b\s*[:=]/i, label: 'secret-like assignment' },
]
