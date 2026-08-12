# Security policy

The Atelier is an authoring tool for private material. Its guarantees are
enforcement claims, not aspirations — so a way around a guarantee is a
vulnerability here even when nothing crashes and no data is lost.

## Reporting a vulnerability

**Use GitHub private vulnerability reporting**:
<https://github.com/MNSTRY/atelier/security/advisories/new>. That channel is
private, gives you a tracked advisory, and lets a fix and a disclosure be
prepared together.

If that is unavailable to you, email **erik@mnstry.ai** with `atelier security`
in the subject line.

Do not open a public issue for a vulnerability, and do not include client
material, private methodology, or key material in a report. A report needs the
mechanism, not your real data — if you cannot demonstrate the finding without
sensitive content, say so and describe the shape instead.

### What to expect

Maintenance is small and deliberate, so these are honest targets rather than
guarantees:

- Acknowledgement within 3 business days.
- An initial assessment — accepted, needs more information, or out of scope,
  with reasoning — within 10 business days.
- Fixes released as a new tagged version. Where a fix changes a published
  contract, it follows the same compatibility rules as any other change:
  a new contract version and a recorded migration.
- Credit in the advisory and changelog under the name you choose, or no
  credit if you prefer. You will be asked before being named.

Coordinated disclosure is the expectation. Give a fix a reasonable window
before publishing; you keep the right to publish, and there is no embargo
you have to sign.

## In scope

These are the claims the package makes. Defeating any of them is a
vulnerability, and the more quietly it can be defeated, the more severe:

- **Egress.** Any network send path in first-party code, or any way to make
  the local sidecar reachable off loopback or serve a policy that authorizes
  an external origin.
- **Boundary guard.** Any way to get private or sensitive source into a
  shared repo, to stage a protected local file, or to promote private-domain
  material without the required disclosure record — while the guard reports
  clean.
- **Disclosure scanners.** Any way to get denylisted or structurally
  forbidden content past `repo:check` or `release:audit`, including through
  encoding, line splitting, file types the scanner skips, or symlinks.
- **Audience and visibility.** Any export accepted as `public` that
  references a source whose audience is not public.
- **Attestation.** Signature or verification flaws in `attestation verify`,
  or announcement verification accepting content the published key did not
  sign.
- **Upgrade.** Any path where `upgrade --apply` overwrites authored content,
  weakens boundary policy, or runs an unregistered migration.
- **Contract compatibility.** Any way to widen a schema outside `ext`
  containers without the compatibility gate refusing it.

Supply-chain reports about this repository's own release and CI machinery are
in scope: workflow injection, secret exposure to untrusted code, or a way to
make a released tarball differ from the reviewed tag.

## Out of scope

- **The sidecar is loopback-only and unauthenticated by design.** Someone who
  already has a local account and can reach loopback is inside the trust
  boundary. A way to reach it from off-host is in scope; using it from on-host
  is not.
- **Local file access.** The Atelier reads and writes files you point it at,
  with your own permissions. That is the design.
- **Vulnerabilities in your own authored content** or in extension packs and
  distributions maintained outside this repository.
- **Dependency advisories with no reachable path** through this package.
  Report them anyway if you are unsure — but a bare scanner dump against
  `ajv` with no exploitation path is not a finding.
- **Missing hardening with no demonstrated impact.** Show the mechanism.

## Supported versions

The package is alpha. Only the latest tagged release receives fixes; there
are no backports to earlier tags. Published contracts carry a separate and
stronger promise — `docs/contract-stability.md` and `docs/continuity.md`
record it — and that promise is not weakened by a security fix.

## Received advisories

None to date.
