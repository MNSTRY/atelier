# Changelog

## 0.2.0-alpha.8

- Add a tenant-neutral HTML control system at `@mnstry/atelier/ui`. The shared
  geometry, variants, focus treatment, motion, action-group layouts, and safe
  renderers are used by Atelier's generated project UI and are available to
  downstream publication kits without importing publication semantics into
  Atelier.
- Preserve the graph command's open Markdown ontology during canonical-engine
  consolidation: core `kg.type` values remain portable recommendations while
  adopter-defined lowercase kebab-case types remain valid.
- Keep unclassified Markdown graph-visible and fail-closed without treating
  its synthetic private projection audience as an authored boundary-placement
  declaration.

## 0.2.0-alpha.6

- Add Deliverable Zero for Atelier Sync: explicit single-repository
  enrollment, a pinned direct-process Git adapter, executable repository
  completeness observations, fast-forward-only reconciliation, per-repository
  locking, hash-chained local operation traces, pause/resume control, and a
  two-phase user-confirmed commit-and-publish path. No desktop shell, watcher
  dependency, semantic conflict resolution, force operation, browser apply
  endpoint, telemetry, or hidden upload is introduced.
- Raise the Sync Git floor to 2.40 so default global and system attributes can
  be observed, bind publication to the single resolved push URL, refuse URL
  rewrite ambiguity, strip every inherited `GIT_*` process control, keep
  read-only commands mutation-free, and return non-zero exits for paused status
  and failed publication.

## 0.2.0-alpha.5

- Harden boundary enforcement so path globs use segment-aware matching, an
  explicitly empty or malformed content-rule policy is invalid, staged and
  pushed binary evidence is scanned within bounded budgets, incomplete Git
  reads fail closed, linked worktrees install hooks in the correct Git common
  directory, and `boundary audit` defaults to the current working tree with an
  explicit `--head` snapshot mode.
- Consolidate graph classification in one canonical engine. Markdown without a
  `kg` block is now represented as `unclassified` with a private audience and
  diagnostics; empty, partial, or malformed declarations remain blocking.
  Generated projection directories remain derived from the file-class manifest
  so graph validation and generated-only upgrade recovery cannot drift apart.
- Bind release egress verification to the exact `npm pack` inventory, including
  test-shaped paths that are actually published, and make the legacy egress
  checker a thin delegate to the canonical scanner. Packed fixture-suppression
  markers are refused and reviewed local-computed suppressions are counted.
- Harden `atelier dev` so it binds only to loopback, requires a generated
  `atelier.manifest.json`, serves only enrolled safe static files after
  realpath validation, and applies host, fetch-site, origin, method, and nonce
  checks to the relevant read and mutation routes.
- Make collaboration records fail closed with typed corrupt-record results,
  bounded ledger reads, POSIX no-follow and cross-platform state-leaf identity
  validation, content-bound event identifiers, write locking, explicit
  compaction, and one-pass proposal-list materialization. Compatibility
  snapshots are best-effort projections of committed events rather than a
  second authority. Proposal authority now follows declared capabilities and
  apply endpoints rather than action-like words, and the never-released
  provider-analysis experiment was removed before it became part of a
  published API.
- Render expected project and JSON failures as typed, actionable CLI messages
  without stacks by default; set `ATELIER_DEBUG=1` to include diagnostic stacks.
- Strengthen release proof with negative-control mutations and a bare consumer
  that installs without publisher overrides, validates its dependency tree,
  and imports every declared package export. A candidate is packed once, bound
  by SHA-256, and passed unchanged through tarball audit, consumer, and branded
  distribution gates. The trusted-publishing workflow publishes that same
  retained, audited tarball rather than repacking the source directory.
- Pin every JavaScript subpath and named export from `v0.2.0-alpha.4` in a
  registry-verified compatibility baseline with immutable tag-commit and
  public-artifact provenance. Release tooling refuses removals, provenance
  drift, and binding modified source to an already-tagged package version.
- Add a portable `atelier disclosure check` command that scans tracked or
  staged consumer content, requires private denylist coverage by default, and
  refuses tracked repository-local denylist files. Portable and repository
  sweeps now detect the full bounded family of private-key headers and refuse
  binary or invalid-UTF-8 evidence instead of omitting it. Fork sweeps require
  the trusted denylist secret and cannot fall back to the untrusted checkout.
  Repository release sweeps also inspect every bounded blob introduced by the
  commit range, so content added and deleted before the final tree cannot
  become public history unseen.
- Add public agent instructions and mirrored skills for extracting reusable
  mechanisms from private implementations without carrying tenant material
  into Atelier, plus a managed local-service contract for durable loopback
  authoring and review tools.
- Document the client-zero adapter rule that exact package identity, installed
  dependency resolution, CLI version, and `atelier.lock.json` must agree. This
  prevents a stale sibling checkout from satisfying a current adapter proof.
- Declare the audited `fast-uri` pin as a direct runtime dependency so packed
  offline consumer installs resolve the same dependency closure as the source
  checkout.

## 0.2.0-alpha.4

Presentation release. No contract changes and no runtime behaviour changes:
documents valid against `0.2.0-alpha.0` remain valid.

- **The README now explains the system before the package.** It begins with
  the repository as a durable substrate, then shows how ontology, enforcement,
  governed projections, and a local runtime make the same work usable by
  people, teams, agents, and tools.
- **The story progresses with the reader.** Stewards and collaborators get the
  purpose and working loop first; builders get the graph and library surfaces;
  technical readers retain the exact, test-gated claims, limitations, and
  conformance boundaries.
- **Methodology authoring is presented as the proving ground, not the
  category.** The package can support any file-based body of work whose
  structure, relationships, disclosure, and readiness must remain portable and
  enforceable.
- **Package and installation metadata match the new public presentation.** The
  prerelease remains explicitly pinned, and the coordinated MNSTRY developer
  documentation carries the same conceptual spine.
- **Bundled client instructions match the released CLI.** The Codex and Claude
  open-Atelier skills use `atelier dev` and point registry users to the scoped,
  collision-free install path.

## 0.2.0-alpha.3

Documentation and metadata release. No contract changes and no runtime
behaviour changes: documents valid against `0.2.0-alpha.0` remain valid.

- **The package's promises are now under a gate.** The checkable claims,
  the will-not-do list, the conformance/admission separation, and the
  audience/visibility rule live canonically in `docs/blocks/`, the README
  embeds them verbatim between markers, and a test fails when they drift.
  Promises converge by machinery; framing diverges by audience.
- **The README is restructured as a depth ramp** — category and trust
  posture first, the working loop with its visible result second, the
  checkable claims third, boundaries fourth, architecture fifth, reference
  last — and a new "Where the Atelier stops" section states the boundary
  with MNSTRY's managed platform as a literal table.
- **Overbroad claims are corrected.** "Trustworthy enough for whatever you
  govern with it" is gone from the README and `docs/design.md` — controls
  shaped for one demanding case do not establish adequacy everywhere; the
  agent-runtime passage now states the narrow, testable control rather
  than a general safety claim; "does not contact external services" now
  carries its documented `gh` exception inline; contract and test counts
  are stated by command, not by number; the contributions text now matches
  `CONTRIBUTING.md`'s outside-PRs-not-open-yet posture; and
  `docs/continuity.md` speaks of npm publication in the present tense.
- **`npx` examples use the collision-free `mnstry-atelier` form.** The
  unscoped npm name `atelier` belongs to an unrelated third-party package,
  so a bare `npx atelier` outside an installed workspace runs someone
  else's code. Every `npx` example on every surface now uses the branded
  binary, `atelier` remains the documented command inside installed
  workspaces, and `docs/install.md` no longer calls `mnstry-atelier` a
  legacy alias — it is the safe form.
- **npm metadata describes the package from the outside.** A concrete
  description, registry keywords, and a homepage that resolves to the
  published documentation page.

## 0.2.0-alpha.2

Documentation and release-lane release. No contract changes and no runtime
behaviour changes: documents valid against `0.2.0-alpha.0` remain valid.

- **The README is rebuilt around the system rather than its first
  application.** New `docs/design.md` states the design in five movements —
  a repository with an ontology, rules that refuse, collaboration as governed
  disclosure, a local runtime for humans and for agents, and a platform for
  your own tool — each ending with the command that proves it. Methodology
  authoring is stated as the first application, not the ceiling.
- **Publishing is automated on tag push** via npm trusted publishing (OIDC),
  so releases carry a provenance attestation and no registry token is stored
  anywhere. Two fail-closed guards: the tagged commit must be an ancestor of
  `main`, and the tag must equal `package.json`'s version.
- **The disclosure scanner no longer flags the OIDC permission key.**
  `id-token` is a GitHub Actions permission, not a credential; the exemption
  is the literal `id-` prefix only, and every other compound still matches.
- **`0.2.0` was published in error and unpublished the same day.** A
  `npm version patch` against an alpha resolves the prerelease to `0.2.0`
  rather than advancing it, and `git push --follow-tags` delivered the tag
  even though branch protection rejected the commit, so a release published
  from a commit that never landed on `main`. That number is permanently
  retired on npm. The ancestry guard above exists so this cannot recur.

## 0.2.0-alpha.1

First release published to the npm registry, under `@mnstry/atelier` with
public access. Prior versions were installable only from the repository.

- **Removed `docs/format-ontologies.md`.** It documented mnstry.org's
  editorial composition system rather than the Atelier, and named a private
  repository, an unpublished package with a version pin, and dated internal
  review decisions. Nothing referenced it. No private repository content was
  exposed by it.
- **A request can no longer end the local sidecar.** An unusable proposal id
  or an unreadable proposal file used to throw out of the request handler and
  exit the process; both are now answered with a response, and a busy port is
  reported instead of crashing. Regression tests cover both shapes.
- **Claims narrowed to what the gates enforce.** `boundary check` and `doctor`
  may call the `gh` CLI to resolve a GitHub login when no actor is configured;
  the egress gate scans `src/`, `bin/`, `scripts/` and `examples/` and does not
  model `child_process`; the compatibility differ does not resolve `$ref`
  pointers. All three are stated in the README rather than implied away.
- **Install path corrected.** The registry is now the channel of record.
  `v0.2.0-alpha.0` remains the contract epoch marker that
  `contracts/compat-baseline.json` pins to, and is not an install target.
- **Agent skills no longer suggest `npx atelier`**, which resolves to an
  unrelated third-party package on npm.
- **Removed the undocumented bare `mnstry` bin alias.** The package installs
  `atelier` (primary) and `mnstry-atelier` (legacy alias). It no longer claims
  the bare `mnstry` command name, which no documentation mentioned and nothing
  used, and which belongs to whatever MNSTRY ships under that name in the
  future rather than to this authoring kit.

This release also carries the open-source readiness work that landed between
the epoch tag and the public flip, previously listed as unreleased:

- `SECURITY.md` states the vulnerability reporting
  channel, what counts as a vulnerability against this package's claims
  (egress, boundary guard, disclosure scanners, audience/visibility,
  attestation, upgrade, contract compatibility), and what is deliberately out
  of scope — the loopback sidecar's on-host trust boundary is the design, not
  a finding. It ships in the tarball alongside `NOTICE` and `TRADEMARKS.md`,
  so a consumer who only has the package still has a reporting path.
- `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1) governs conduct;
  `CONTRIBUTING.md` continues to govern contributions, and boundary
  violations stay an operational matter handled there rather than a conduct
  dispute.
- The DCO sign-off that `CONTRIBUTING.md` requires is now enforced by a `dco`
  workflow instead of being documentation only. Merge commits are exempt —
  a contributor cannot sign a merge a maintainer made.
- Issue forms and a pull-request template carry the disclosure rules to the
  point of submission: no client material, no private methodology, no key
  material, no absolute home paths. The issue chooser routes vulnerabilities
  to private reporting and routes contract, dependency, guard, and network
  changes to the conversation-first proposal form. Blank issues are off.
- Dependabot watches npm and the SHA-pinned actions weekly. Its pull requests
  receive Dependabot-scoped secrets rather than Actions secrets, so the
  denylist must also be stored as a Dependabot secret or every Dependabot
  pull request blocks on `secret-sweep` exactly as a fork does.

## 0.2.0-alpha.0

- **Breaking:** the internal analysis-engine codename is fully removed from
  the contract surface. The adapter contract is `analysis-adapter@v1`
  (schema const `analysis-adapter-manifest@v1`, provider const `analysis`,
  output root `.mnstry/atelier/analysis`); the lock and migration schemas
  say `analysisExecution`; the readiness contract's section and the claim
  proposer enum value are `analysis`; the package export is
  `./analysis/adapter`; the CLI command is `analysis` (alias `analyze`).
  The `v0.2.0-alpha.0` baseline tag is re-cut at this commit — it was hours
  old, unpublished, and had no external consumer.
- **Security:** an independent external audit deleted both enforcement sites
  of the public-projectability boundary with every gate green — the invalid
  fixtures named for the property fail earlier, at resolution, so the branch
  had no witness. Resolved-private and resolved-sensitive fixtures now assert
  the registered `is not public-projectable` reason, and the export path uses
  the tested projection-policy verdict instead of a near-copy that could
  drift.
- **Security:** the served CSP authorized two Google Fonts origins nothing in
  the kit uses. Workspace HTML is author-controlled, so the dead permission
  was an exfiltration channel; it is removed and the security test refuses
  any external origin in the policy.
- The egress gate detects the shapes the same audit showed it missed —
  `https.get`, `http2.connect`, dynamic import of a URL, beacons, XHR/Image,
  third-party HTTP client imports, CSP directives naming external origins,
  and markup resource attributes — and its scan-path list names directories
  that exist (eight of eleven were `src/` subdirectories listed as top level,
  silently scanning nothing). Every previously-missed probe is pinned in a
  permanent test.
- `LICENSE` ships the full Apache-2.0 text instead of the 18-line short-form
  notice, so the section 6 that `TRADEMARKS.md` cites exists. CI actions are
  pinned to commit SHAs, the `fast-uri` advisory is closed with an override,
  and `portableText` scrubs Linux and Windows home paths, not only macOS.
- The `typecheck` script is renamed `syntax:check` — it runs `node --check`
  and never was a type system. The quickstart's boundary check step works on
  the sample workspace it creates, the fresh-clone denylist skip is
  documented, and the unread `#atelier-data` script block is gone.
- Every attacker-reachable label is sanitized, including the key path: a key
  file whose *name* carried an escape sequence could erase the key-identity
  line and rewrite it, and an over-long basename wrapped the header so the
  true provenance landed on a later visual line.
- The key-material patterns match material rather than prose. A document may
  discuss `privateKeyJwk` or show a redacted example and still be attachable
  to a feedback report; the scalar floor is the length of a real key, so a
  short identifier under a member named `d` no longer fires. A JSON
  attachment is scanned as the structure it decodes to as well as the text it
  is, so escaped member names cannot smuggle a key past the scan.
- **Security:** the widened private-key pattern repeated a repeated group,
  which is quadratic — 256 KiB of header-shaped text took about ten seconds
  to reject, reachable through `--message`, a capped `--context`, and the
  release audit. The repetition is bounded at four algorithm words, which
  still matches every real header, and a timing guard pins it.
- **Security:** JWK private key material had no coverage anywhere, though it
  is the only key format the kit writes. The private scalar and the
  `privateKeyJwk` wrapper are now banned values, the repo sweep looks for the
  scalar, and the release audit rejects any packed JSON that carries one —
  not only announcements documents.
- Attacker-controlled labels are sanitized before they reach a terminal. A
  keyId carrying an escape sequence could erase the `!! UNVERIFIED` warning
  above it and print a forged listing in its place; keyIds, algorithms, and
  announcement filenames are now capped and stripped of control characters.
- `announcements verify` and `show` name the key that vouched for a document,
  as `list` already did — `show` prints it before any attacker-authored
  content, and `verify --json` carries the key path, keyId, and whether the
  anchor was explicit.
- `atelier feedback` refuses a `--context` that is not a regular file (a FIFO
  or character device never returned from the read, so the size cap could not
  fire) and bounds `--message` the way file inputs were already bounded.
- The release audit decodes packed files strictly: a NUL-free binary used to
  scan as harmless text through a lossy decode while still carrying
  recoverable content.
- **Security:** the private-key disclosure pattern matched only the bare
  PKCS#8 header, so an ssh-keygen OPENSSH private key — and the RSA, EC, DSA,
  ENCRYPTED, and PGP block headers — passed the support-bundle scan, the
  repo-wide sweep, and the tarball audit untouched. It now matches any PEM
  private-key header. The banned-value email pattern also backtracked for
  about a minute on large non-email input and is bounded to the RFC 5321
  local-part and domain limits.
- `atelier feedback create` refuses `--context` and `--message-file` input
  over 262144 bytes or that is not valid UTF-8 rather than embedding it, and
  warns when the report lands where `.atelier-local/` is not git-ignored. The
  success message states that the scan is a backstop, not clearance to share.
- `atelier announcements list` takes its trust anchor from the committed
  MNSTRY key, never from the directory being listed: `--dir` relocates only
  where documents are read. Every run names the key and keyId it verified
  against. A tree carrying its own key can no longer present forged
  announcements as verified.
- A git-ignored `.kg.json` sidecar can no longer enroll a file in the census
  or describe one. Membership is a function of tracked state alone, so a
  clean checkout and a working tree build the same graph.
- The announcements documents and public key now ship in the package, so
  `announcements verify` works for consumers; the release audit asserts the
  key is present, rejects any announcements document carrying a private key
  member, and refuses to pack a binary file it cannot content-scan.
- The knowledge-graph census is now sidecar-first: a `.kg.json` sidecar
  attaches any sibling file — JSON, YAML, CSV, binaries — as a first-class
  node with its own audience, without atelier ever parsing the foreign
  format. Document extensions keep their existing semantics, and non-Markdown
  documents still fail closed without a sidecar.
- Adds `atelier feedback` — a local, never-sent feedback report on the
  support-bundle chassis: assembled under ignored `.atelier-local/feedback/`,
  scanned against the banned key and value patterns before writing, refused
  on any match. The kit has no send path; sharing is always the user's act.
- Adds the signed announcements channel: pull-only JSON documents under
  `announcements/`, signed with the published MNSTRY announcements key and
  verified by `atelier announcements list|verify|show`. The kit never
  fetches them; receiving an announcement is the `git pull` you chose to
  run. Generic detached document signing joins `@mnstry/atelier/attestation`.
- `TRADEMARKS.md` gains the quiet-software clause (no commercially motivated
  interruptions for anything carrying the MNSTRY marks, MNSTRY bound to the same
  standard) and the applications attribution rule for apps without a CLI.
  A `NOTICE` file ships in the tarball; Apache-2.0 section 4(d) makes its
  reproduction a license obligation in every derivative redistribution.
- **Breaking:** the `atelier-export@v1` runtime owner vocabulary is now
  vendor-neutral. The closed `runtimeOwnerName` enum, the `RUNTIME_OWNERS`
  constant, the bundled readiness protocols, and the fixtures all move to the
  domain terms `identity`, `catalog`, `commitments`, `events`, `projection`,
  `consent`, `messaging`, `providers`, `audit` (see `docs/ontology.md`).
  Documents and validators from earlier tags do not interoperate across this
  change; regenerate exports rather than hand-editing owner values.
- **Breaking:** `protocol.outputs` on bundled readiness protocols is now the
  contract's object shape (`{ runSchema, artifacts }`) instead of an informal
  array of artifact slugs, and the undeclared `outputArtifacts` key is gone.
  All twelve bundled protocols now validate against
  `atelier-readiness-protocol@v1`.
- **Breaking:** every document contract enters the contract-stability epoch:
  each schema declares an optional root `contractVersion` and a reserved
  optional `ext` extension container on every closed object, and bundled
  readiness protocols emit `contractVersion: "1.0.0"`. Validators pinned to
  earlier tags reject documents that carry the new fields. See
  `docs/contract-stability.md`.
- **Breaking:** the `atelier-claim@v1` provider enum gains
  `atelier-readiness`, so claims emitted by readiness runs validate against
  the standalone claim contract. Claim validators pinned to earlier tags
  reject the new provider.
- **Breaking:** the analysis adapter manifest schema const is now
  `analysis-adapter-manifest@v1` (was
  `mnstry.atelier-analysis-adapter-manifest@v1`), matching the published
  contract and fixtures. Local manifests emitted before this change must
  update their `schema` field.
- **Breaking:** boundary promote events are now recorded with schema
  `git-promote-event@v1` (was `mnstry.git-promote-event@v1`), matching the
  published contract. Previously recorded ledger lines carrying the old
  const are not rewritten.
- **Breaking:** the agent-harness context envelope schema const is now
  `atelier-context@v1` (was `mnstry.atelier-context@v1`), matching the local
  sidecar contract.
- **Breaking:** the alignment projection ships no default root-graph name
  list; the default is empty and workspaces supply their own via
  `sduiMap.rootGraphs` in project configuration. Nodes previously classified
  by the built-in name list no longer match without configuration.
- **Breaking:** every command that resolves a project now
  validates loaded config files fail-closed. Unknown keys that earlier
  releases silently ignored are rejected, `ext` must be an object whose
  members are namespaced objects, and the closed sub-objects (`roots`,
  `graph`, `projection`, `alignment`, `runtime`, `boundaries`, `setup`)
  reject additional properties. A config with a misspelled or stray key now
  fails at CLI entry with the offending key named, instead of running with
  that key quietly dropped.
- Adds `atelier-attestation@v1`, a contract for recording admission
  decisions: issuer, attested payload with an RFC 8785 (JCS) + SHA-256
  payload hash, an admission-scoped verdict (a conformance-scoped verdict is
  structurally unexpressible), and a required-but-nullable signature where
  null means advisory and non-authoritative. See `docs/attestation.md`.
- Adds the contract compatibility gate: `scripts/check-contract-compat.mjs`
  (`npm run contract:compat`) validates the current fixture and
  generated-document corpus against validators from the baseline tag recorded
  in `contracts/compat-baseline.json`. The gate is inert until the first
  post-epoch tag is recorded as the baseline.
- Adds `docs/ontology.md` — the public export vocabulary: the nine runtime
  owners, the object classes and collections they govern, the six runtime
  targets, and the audience/visibility boundary — and
  `docs/contract-stability.md` — the stability epoch, `contractVersion`,
  `ext` and must-ignore rules, the widening ban, the deprecation policy, and
  the compatibility gate.
- Expunges client-zero-identifying names from tests, fixtures, docs, and the
  release audit. Name-based scrub patterns now load from the gitignored
  `release-denylist.local.json`; when that file is absent the audit warns and
  applies structural checks only, and the readiness-pack neutrality test skips
  the name assertions.

- Staged boundary guard now separates boundary-field *initialization* from
  *change*. A field added with no prior value, set to a non-disclosing default,
  commits without a review marker; widening, narrowing, and removal still
  require one. This removes the deadlock where the kit's own front-matter
  tooling produced changes the kit's own gate refused.
- `semantic-field-change-needs-review` findings now name the file and the exact
  field transition instead of failing a whole repo with one opaque message.
- Review markers are now scoped to the file they appear in. A marker in a
  sibling file no longer approves an unrelated boundary change.
- Graph and sidecar walks now skip git-ignored paths via one batched
  `git ls-files --others --ignored --exclude-standard --directory` per repo
  root, so committed graph artifacts describe the repository rather than one
  machine's working tree. Multi-machine workspaces no longer churn.
- Adds `test/graph-determinism.test.mjs`, a mutation-tested regression guard
  that builds twice with git-ignored junk planted in between and fails on any
  byte change to a committed artifact.
- Adds the reserved repo kind `external` for git folders a workspace
  acknowledges but does not manage. External repos imply no read boundary, are
  excluded from graph walking, sidecar requirements, projection, the staged
  guard, and hook installation, and must not appear in repo-access or boundary
  policy. Undeclared git folders remain an error, and the message now names
  `external` as the resolution.
- `atelier graph` prints the remote host of each external repo so a workspace
  surfaces where its unmanaged folders push.
- **Breaking:** `fileClasses` is now required in the kit manifest. Every file
  the kit ships or generates is classified `source`, `generated-projection`, or
  `distributed-runtime-copy`, and a runtime copy must declare the repo role in
  which it is canonical. Adds `classifyPath(path, { repoRole })` so sync loops,
  merge policies, upgrade tooling, and CI guards read one declaration instead of
  each keeping a list that drifts.
- The graph walker's generated-file skip list and the boundary policy's glob
  matcher are now derived from shared modules rather than restated inline, with
  a drift test asserting the kit keeps no second copy of either.
- Repo entries accept `identity` (provider + stable id) and `aliases` (former
  names), so a repository survives a rename. Adds
  `resolveRepoIdentity(cloneDir)`, which resolves from the provider's stable id,
  then a recorded identity, then declared aliases — and never from a root commit
  or a folder name.
- `atelier doctor` now audits repo identity: upstream renames, stale config
  names, deprecated aliases, clones that are secretly the same repository, and
  repos with no recorded id or no origin remote.
- Adds boundary-policy `contentRules` and `contentRuleExceptions`. Rules judge
  added lines and added file paths rather than the whole tree, so a pre-existing
  accepted usage no longer blocks every push of everything in a repo. Exceptions
  are reviewable policy config — per repo, per path, per rule, each requiring a
  reason — instead of hardcoded pathspecs inside a fleet-wide guard script.
  Blanket wildcards are rejected.
- Adds `atelier boundary push-check`, which reads pre-push ref updates from
  stdin and judges only the pushed range (new branches diff against the empty
  tree), and `atelier boundary audit`, the whole-tree view that reports without
  blocking. The installed `pre-push` hook now uses `push-check`.
- The push guard fails closed when it cannot identify the repo it is running in,
  and matches its repo through symlinked paths and subdirectories.
- Adds extension packs. A project declares namespaced protocol packs under
  `ext["mnstry.atelier"].extensionPacks`, and the loader admits each one
  through a fixed fail-closed pipeline: entry shape, enablement, schema
  validation, identity, reserved-namespace rules, fixture and protocol path
  guards confined to the pack directory, the nine-point protocol safety
  posture, collision rules against the bundled pack, and lock pin-and-verify.
  Enablement is disable-only: the machine-local overlay can switch a declared
  pack off but can never switch an undeclared one on. Protocol resolution runs
  through an explicit registry — bundled protocols keep resolving by id, slug,
  or namespaced id, while pack protocols resolve by full namespaced id only,
  so a pack can never shadow or squat a bundled slug.
- Adds `atelier extension-pack validate` and `atelier extension-pack list`,
  which report per pack with version, resolved path, digest, protocol count,
  and lock status. Exit 0 means every enabled pack loaded clean, 1 that one
  failed, 2 a usage or project resolution error.
- Readiness composes pack protocols alongside the bundled twelve.
  `readiness protocols --project`, `readiness journey`, and `readiness run`
  resolve pack protocols through the project registry, and the tenant packet
  carries a generic per-pack contribution under `ext` built from run fields
  alone, where only `required`-gate pack protocols can block export and
  `advisory` ones report without blocking.
- `atelier lock write` and `lock check` now cover extension packs. The lock
  records each pack's version and content digest, `lock check` reports drift
  in both directions (declared but unlocked, locked but changed), and the new
  `sync-extension-packs` upgrade migration re-verifies and re-pins declared
  packs. Locking loads packs in throwing mode, so a broken pack cannot be
  recorded.
- Adds attestation signing: `atelier attestation hash|sign|verify|keygen`,
  with RFC 8785 (JCS) canonicalization, sha-256 payload hashes, and ed25519 or
  es256 keys. `keygen` writes the signing key file at mode 0600, refuses to
  overwrite an existing one, and prints only the public key document; the
  default signing key file is gitignored. Adds `TRADEMARKS.md`, the normative
  home of the required attribution string, the naming rules for distributions,
  the sanctioned compatibility claim, and the reservation of "certified" and
  "admitted" to holders of a verifying signed attestation. `TRADEMARKS.md`
  ships in the published tarball and the release audit fails without it.
- The workspace projection reads `ext["mnstry.atelier"].distribution` for
  branding: `name` and `eyebrow` feed the title and eyebrow line, and `theme`
  overrides five CSS custom properties. Theme values must be hex colors —
  they are interpolated into a style block, so a non-hex value fails the build
  rather than reaching the page. Default output is unchanged, and the
  "MNSTRY Tenant Readiness" heading stays as it is because it names the
  bundled pack.
- Adds the `distribution` workspace template
  (`atelier init --template distribution`), which scaffolds a workspace
  carrying the branding block and the attribution line. Fixes a bug where an
  unrecognized `--template` silently produced a blank scaffold: init now exits
  1, names the valid templates, and writes nothing. The blank scaffold is
  reached by omitting `--template`.
- Adds `atelier distribution check`, which verifies a distribution package's
  attribution markers mechanically: the root `README.md` must contain the
  exact byte string `powered by MNSTRY Atelier` (blocking), and each
  extension-pack manifest is reported for the advisory
  `ext["mnstry.atelier/attribution"]` key. Its messages point at
  `TRADEMARKS.md` and `docs/attestation.md` rather than restating policy.
- Adds the exported CLI entry `@mnstry/atelier/cli`. `runCli({ argv, brand })`
  returns an exit code instead of calling `process.exit`, so a distribution
  wrapper is a brand object and one line of dispatch. Attribution is derived,
  not configurable: `runCli` renders `powered by MNSTRY Atelier <version>` in
  `--version` and help output whenever the brand is not the default, and the
  brand object has no field that could omit or reword it. Default-brand output
  is byte-identical apart from the new commands listed in help.
- Adds `docs/distributions.md` — the three-tier model, the invariant that a
  distribution adds and rebrands but never alters root semantics, the three
  attribution surfaces, a build walkthrough, and the
  `ext["mnstry.atelier"].distribution` field reference — plus
  `examples/loomworks-studio/`, a complete reference distribution exercised by
  the new `distribution:smoke` publish gate.

## 0.1.0-alpha.2

- Adds bundled `mnstry-readiness-pack@v1` with twelve claim-first readiness
  protocols for MNSTRY tenant preparation.
- Adds readiness protocol and readiness run contracts with AJV fixtures.
- Adds `atelier readiness protocols`, `journey`, `run`, `packet`, and
  `export --dry-run` commands.
- Adds tenant-readiness journey data to generated local projections.
- Adds neutral Codex and Claude readiness skill wrappers.
- Keeps readiness output local, proposal-first, non-importing, non-mutating,
  no-send, and free of project-specific package content.

## 0.1.0-alpha.0

- Introduces the alpha `@mnstry/atelier` package.
- Adds the `mnstry atelier ...` and `mnstry-atelier ...` local CLI entrypoints.
- Adds `atelier-export@v1` schema validation.
- Adds dry-run validation for export artifacts.
- Adds fictional sample fixtures and fail-closed negative fixtures.
- Keeps runtime import, runtime mutation, telemetry, and external egress out of
  scope.
