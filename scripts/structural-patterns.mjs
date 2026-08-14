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
  // form allowed exactly one word between the opening keyword and KEY, so it
  // matched the bare header and nothing else real: ssh-keygen's default, the
  // RSA/EC/DSA/ENCRYPTED forms, and the PGP block form all carry extra words.
  // The count is bounded at four: real headers carry at most two algorithm
  // words, and an unbounded repetition of a repeated group is quadratic —
  // 256 KiB of header-shaped text took ten seconds to reject. The bare
  // RSA/OPENSSH forms the old pattern covered are kept, so this stays a
  // strict superset.
  // Prose here deliberately avoids writing a matching header: this module is
  // excluded from the repo:check structural pass, but nothing it scans is,
  // and that exclusion should never be what keeps the repo clean.
  { pattern: /"d"\s*:\s*"[A-Za-z0-9_-]{20,}"/, label: 'JWK private key material' },
  { pattern: /BEGIN (?:[A-Z0-9]+ ){0,4}PRIVATE KEY(?: BLOCK)?|BEGIN (?:RSA|OPENSSH) KEY/, label: 'private key material' },
  // `id-token` is exempt because it is a GitHub Actions *permission key*, not a
  // credential: `id-token: write` requests an OIDC token be minted at runtime
  // and carries no secret material. The exemption is deliberately the single
  // literal `id-` prefix rather than a value allowlist — exempting on the value
  // (`: write`) would let any `token: write` line through, and every other
  // compound still matches, including `auth-token:`, `refresh-token:`, and a
  // bare `token:`. Residual, stated plainly: any `id-token:` line is exempt
  // whatever its value. That is proportionate — this pattern only ever caught
  // conventionally-named assignments, and a value hidden under a name nobody
  // uses for credentials was already invisible to it.
  {
    pattern: /\b(api[_-]?key|secret|password|(?<!id-)token)\b\s*[:=]/i,
    label: 'secret-like assignment',
  },
]
