# Capability stewardship

Status: source implementation for the next release. The published alpha.7
package does not include the `capability` command. From this checkout, use
`node bin/atelier.mjs capability ...`; the examples below use the installed
command spelling for a package built from this source.

Atelier can package a useful workflow, introduce it alongside a person's
existing skills, and keep each repository's adoption explainable over time.
The Skill Steward coordinates this work. People choose the purpose, boundaries
and acceptance criteria; agents prepare, inspect and exercise the work within
that authority; people validate consequential interpretations and publication.

The foundation is local and provider-independent. A package can travel through
Git, an offline copy or an existing distribution service. Atelier reads an
explicit local directory. It does not download packages, execute their scripts,
call a model, probe credentials, send telemetry or publish a release remotely.

## The objects and their owners

| Object | Purpose | Authority |
| --- | --- | --- |
| Capability | An outcome with inputs, outputs and limits | Publisher describes it; adopter judges its usefulness |
| Skill | A standard `SKILL.md` bundle that teaches a procedure | Its instructions remain subject to the current task and host |
| Package | Publisher/package ID, exact version, skills, dependencies, requirements and evidence | Publisher owns the source |
| Release | Complete payload inventory and immutable digest | Integrity evidence; identity and quality remain separate |
| Adoption | Repository ID, release pins, modes, aliases and admitted requirements | Repository owner |
| Binding | A skill projected into one named host profile | Repository owner chooses placement; host controls actual discovery |
| Observation | A version-, binding- and session-bound evidence reference | Caller reports it; reviewer evaluates the evidence |

Stable package identity looks like `example.publisher/research`. Capability and
skill IDs are local to that package. Display titles and installed aliases can
change without making two publishers the same owner. Existing `atelier skills`
commands and contracts remain compatible. The new public API is
`@mnstry/atelier/capabilities`; its contract is
`contracts/atelier-capability.v1.schema.json`.

## Begin with the environment somebody already has

Run `atelier capability inventory --surfaces surfaces.json`. The file is an
array of explicit `{ "id", "scope", "root" }` entries. Scope is `personal`,
`organization`, `repository`, `nested`, `plugin` or `other`. Machine paths stay
in local configuration. There is no implicit home-directory or repository crawl.

Inventory reports names, declared names, complete bundle digests, unreadable
entries and name overlaps. It neither executes nor adopts what it finds. An
overlap is a reason to inspect resolution and purpose; it is not a merge or
deletion decision. Similar descriptions alone are insufficient to infer that
two skills are equivalent. Missing surfaces and unreadable bundles remain gaps.

The adoption modes are:

| Mode | Result |
| --- | --- |
| `reference` | Record a pinned package without installing a binding or acquiring existing skills |
| `managed` | Install selected bindings and track their exact projected bytes |
| `customized` | Preserve an existing binding's current local bytes, its upstream release and its original projected digest |
| `retired` | Remove clean managed bindings from discovery into preserved quarantine |

Choose a new alias when an existing skill owns the desired name. Replacing a
third-party skill is an owner-controlled migration outside this installer.
Publish an intentional fork under a new publisher/package ID and retain its
source provenance. A customized binding can return to management after its
original projected bytes are deliberately restored; otherwise reconcile or
fork it. No automatic merge of instructions is attempted.

## Publish a portable package

Author `capability-package.json` alongside self-contained skill directories.
The supplied research and evidence-review examples under
`fixtures/capability-packages/` demonstrate the complete layout. Their publisher
identity is invented and their behavioral evaluations are explicitly unexecuted.

The descriptor declares:

- Identity, exact version, license and source provenance.
- Capabilities and their inputs and outputs; skills providing those outcomes.
- Supported host profiles and required tools and effects.
- Exact required or optional dependency versions, release digests and capabilities.
- Evaluation evidence, known limitations and migration guidance.

Keep a skill's resources inside its own directory. An independently installed
skill must not depend on a sibling directory the recipient might not receive.
Publish shared executable dependencies as explicit packages or tools. Every
relative inline Markdown resource link is checked, including links in nested
Markdown resources. Other reference conventions and program behavior still
require author review. Scripts are copied as inert, non-executable-mode payloads;
this packaging code never runs them or their installation hooks.

```bash
atelier capability seal --package ./my-capability
atelier capability verify --package ./my-capability --digest sha256:REVIEWED_DIGEST
```

Sealing exclusively creates `capability-release.json`. It includes the complete
descriptor and the digest and size of every other file. Re-sealing into an
existing release refuses; author the next version in a new source directory.
Verification checks the full file closure and declared digest. Symlinks, special
files, case-colliding payload names, unsafe paths and oversized bundles refuse.
The limits are 512 files, 256 directories, depth 16 and 8 MiB per package.

A matching digest proves the bytes match a reviewed pin. It does not authenticate
the publisher or prove the source revision, license rights, host compatibility
or behavioral quality. Obtain pins through your existing trusted distribution
and review process. Signing-key discovery and a hosted registry are separate
integrations; this implementation does not invent a new trust root.

## Adopt into a repository

Keep the desired adoption in a reviewed repository file, for example
`capabilities.adoption.json`. A minimal entry is:

```json
{
  "schema": "mnstry.atelier-capability-adoption@v1",
  "id": "research-workspace",
  "packages": [{
    "id": "example.publisher/research",
    "digest": "sha256:REPLACE_WITH_THE_REVIEWED_RELEASE_DIGEST",
    "mode": "managed",
    "bindings": [{
      "skill": "inquire",
      "host": "codex-repo-v1",
      "alias": "team-research"
    }],
    "allowedTools": [],
    "allowedEffects": ["read-workspace"]
  }]
}
```

The example digest above is a placeholder, deliberately not contract-valid.
Use the actual release digest. All dependencies must be supplied and explicitly
adopted; no dependency is downloaded or installed implicitly. Missing required
pins and dependency cycles block the plan. Optional dependencies may be absent;
if present, their exact pins must match.
Each required dependency capability must have a selected provider skill bound to
every host used by its dependent. A Codex-only dependency cannot silently satisfy
a Claude binding. This proves declared placement, not actual host resolution.

```bash
atelier capability plan --adoption capabilities.adoption.json --source ./my-capability
atelier capability apply --adoption capabilities.adoption.json --source ./my-capability --confirm sha256:REVIEWED_PLAN_DIGEST
atelier capability status --session current-session
```

Repeat `--source` for multiple packages. Use `--tool TOOL_ID` only for tools the
caller has observed as available. These are reported observations, not probes or
permission grants. Missing tool observations or unadmitted declared effects block
managed adoption. The plan shows requirement expansion alongside old and new
release pins and modes. Effect declarations describe required authority; admitting
them to a repository never grants execution permission in a host.

The plan binds the repository's actual root identity, desired policy, source
releases, observed tools, previous adoption state, notices and target bytes.
Apply recomputes it under the shared steward operation lock and again after
staging. Drift, unmanaged collisions, legacy-steward ownership, stale confirmation
and reuse of an already-seen publisher/version for different bytes all refuse.
The version-history check is local to this adopter; it is not a global registry.

Local state lives in ignored `.atelier-local/capabilities/`. The repository must
be a Git root with that private directory untracked and ignored before writes.
Authored adoption files remain the desired source of record; status reports
the last applied policy digest, and planning compares it with the supplied file.

## Host profiles and evidence

`codex-repo-v1` projects into `.agents/skills/ALIAS`; `claude-repo-v1` projects
into `.claude/skills/ALIAS`. Both preserve the bundle and rewrite only its
frontmatter name to the selected alias. There is no assertion that identical
instruction bytes produce identical behavior. Each profile describes its
placement, discovery limits, advisory permissions and required re-observation.

These profiles cover repository file placement. Personal, enterprise, nested,
plugin and session-specific discovery remain host-owned. Inspect the intended
session's actual loaded skill and tools after adoption. The
[Agent Skills specification](https://agentskills.io/specification) describes
portable bundles; [Claude's host documentation](https://code.claude.com/docs/en/skills)
describes its own discovery and precedence. An installed file alone proves neither.

`capability observe --event event.json` stores a content-free event with the
package/release, adoption generation, binding digest, host, session, observer,
outcome, reported cause and evidence digest. The event must identify the current
installed binding. Allowed kinds are `host-observed`, `exercise`, `feedback`
and `evaluation`; arbitrary text and extension payloads are refused. Never encode
source material or personal information into identifiers. Evidence stays at its
original destination; only its digest is recorded here.

`status --session ID` reports `installed: current` independently from
`hostObserved: reported-passed` and `exercised: reported-passed`. An old generation
or different session becomes historical evidence. These remain caller reports,
not authenticated host receipts. Changing the adoption generation conservatively
invalidates current-session claims, even when some binding bytes are unchanged.

`capability candidates` groups current-version observations by reported cause.
Repeated tool failures propose tool review; they do not automatically rewrite a
skill. Repeated reports of one session/evidence pair count once. Candidate output
does not prove causality, trigger an edit, certify quality, or retire rare skills.
Use the existing steward's authoring checks for direct and indirect triggers,
incomplete inputs, non-triggers, evidence gaps and boundary cases.

## Updates, withdrawal and recovery

Change the desired pin, review the new package and requirement delta, and repeat
plan/apply. Every repository decides separately. `capability fleet --repo DIR`
can inspect multiple explicitly supplied repositories and reports duplicate
enrollment IDs and unavailable repositories. It has no multi-repository apply
path or global atomicity claim.

An explicitly supplied `--notices notices.json` array can classify an exact release
`deprecated` or `withdrawn`, with an evidence digest. The notice contract is
included in the capability schema. These are adopter-supplied advisories, not
authenticated publisher announcements. Deprecation remains visible in the plan;
withdrawal blocks managed adoption and updates of that digest while preserving
installed files. Retirement still requires a separate exact plan. No background
fetch or automatic deletion occurs.

Successful replacement or retirement moves previous bundles into a transaction's
`before/` directory. A durable journal precedes binding changes. If interrupted,
future applies refuse until the operator inspects `capability recover`. Confirming
that exact recovery plan restores the prior generation and preserves newly
installed bundles too. Unknown bytes or changed state block recovery. A killed
operation's lock can be reclaimed only when it is recognizably owned by this
capability executor and its process is absent; other owners' locks remain theirs.

The next capability or harness operation also checks for a recognizable dead
owner when no adoption journal exists. Reclamation is serialized through the
existing durable lock; a live or uncertain process, unknown owner, or changed
lock refuses. A missing lock during cleanup never masks the original operation
error, and a replacement owner's lock is preserved.

This is a local POSIX, cooperating-writer transaction. It is not atomic across
multiple skill directories, repositories or host sessions, and it cannot prevent
an unrelated writer racing between filesystem checks and rename. Stop host file
writers while applying. Windows adoption and event writes refuse. Storage ceilings, disk failure,
permission failure and ambiguous filesystem state remain explicit refusal or
recovery cases. Retained transaction data has no automatic garbage collection.

## Research through graph integration

The portable research example composes research planning, evidence review,
synthesis and graph-integration preparation. It supplies independent inquiry
prompts and output contracts; it works with the user's chosen research tool or
manual execution. Its dependencies and host bindings use the same publisher and
adopter workflow as any other capability.

`capability graph --namespace ID` emits draft Markdown source documents as JSON.
It records capability/package/release/adoption/binding and observation relations
using Atelier's existing graph vocabulary. The command does not write canonical
content. Review the destination and audience, materialize the selected files
through normal authoring, then run that repository's graph build and retrieval
checks. Graph validity establishes structure; it does not accept a research
conclusion or grant execution authority.

## Verification and next integrations

`node --test test/capability-stewardship.test.mjs` exercises publisher integrity,
multi-publisher dependencies, two repositories and two projection profiles,
third-party coexistence, customization, clean updates, requirement admission,
version immutability, retirement, interrupted apply/recovery, metadata evidence,
CLI behavior and ingestion of generated documents through the real graph builder.
The example packages disclose that no live agent has evaluated their behavior.

Future adapters can add authenticated publisher evidence, actual host discovery
receipts, dependency migrations and registry transport without making any of
them implicit authority. A hosted service or new host needs its own integration
and acceptance evidence. Preserve these contract distinctions when extending the
foundation; do not turn a manifest, successful copy or reported outcome into a
claim of authenticated publication or successful human use.
