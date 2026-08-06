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
  // Every PEM private-key header, not only the bare PKCS#8 one. The previous
  // form allowed exactly one word between BEGIN and KEY, so it matched
  // the bare header form and nothing else real: ssh-keygen's default header is
  // OPENSSH PRIVATE KEY, and RSA/EC/DSA/ENCRYPTED private keys and the PGP
  // "PRIVATE KEY BLOCK" form all carry extra words. Any number of algorithm
  // words is allowed now; the bare RSA/OPENSSH KEY forms the old pattern
  // happened to cover are kept so this stays a strict superset.
  // The literal must not match itself: this module is excluded from the
  // repo:check structural pass, but nothing it scans is.
  { pattern: /BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?|BEGIN (?:RSA|OPENSSH) KEY/, label: 'private key material' },
  { pattern: /\b(api[_-]?key|secret|password|token)\b\s*[:=]/i, label: 'secret-like assignment' },
]
