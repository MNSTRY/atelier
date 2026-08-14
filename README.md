# MNSTRY Atelier

**The Atelier makes a repository mean something.** An ordinary file gains
a small structured header: what this is, who it is for, what it relates
to. That is the entire enrollment. From those declarations the Atelier
builds a knowledge graph over your work, projects a local review surface,
checks readiness against published protocols, and rejects what must never
happen — like a public export that quietly references a private source.

Git is the database. The ontology is the schema. The validators are the
constraints. The runtime is local. There is no telemetry, no send path,
and no account — and every promise on this page ends in a command you can
run.

It exists because some bodies of work are too important to live inside
someone else's platform. MNSTRY builds the technology platform for human
transformation, for practitioners whose method is their life's work and
whose client material is held in trust; the Atelier is that platform's
front porch, not the house. MNSTRY authors its own workspaces with it and
publishes it under Apache-2.0, and everything here runs without ever
talking to a MNSTRY runtime — so it can govern a methodology, a research
corpus, an editorial pipeline, or any body of work that must outlive the
tools that touch it.

## What authoring looks like

Here is a complete, working source document — fictional, like every
fixture in this package:

```markdown
---
title: "Grounding practice"
summary: "The opening practice every offer in this catalog builds on."
kg:
  id: "my-studio:grounding-practice"
  type: "document"
  status: "active"
  audience: "team"
  relations:
    supports: "my-studio:flagship-offer"
---

# Grounding practice

The practice itself, in your words, in your file, in your repository.
```

That header is the entire enrollment. The graph builder reads front matter
like this, and `.kg.json` sidecars for files that are not Markdown — JSON,
YAML, CSV, media, anything — without ever parsing the foreign format. From
there the working loop is four commands:

```bash
atelier graph --project ./atelier.project.json      # build the knowledge graph
atelier project --project ./atelier.project.json    # generate the local review surface
atelier readiness --project ./atelier.project.json  # check against published protocols
atelier dry-run ./atelier-export.json               # validate against the public contracts
```

Each one reads local files and writes local files. The `audience` field in
the header is the load-bearing word: it declares who a source is written
for (`public`, `team`, `operator`, `staff`, `private`, `sensitive`), and
the machinery downstream refuses to let material travel further than its
audience allows. A public export that references a non-public source is
rejected — that check is fixture-pinned and mutation-tested.

## The system

The design is five movements, each grounded in shipped machinery.
[`docs/design.md`](docs/design.md) states them in full, ending each one
with the command that proves it.

**A repository with an ontology.** Front matter — or a `.kg.json` sidecar
beside any format the kit never parses — declares a file's identity, type,
audience, and relations. The graph builder compiles the repository into a
deterministic knowledge graph. No import step, no database: the repository
is the store, and Git is the history, the review process, and the read
boundary.

**Rules that refuse.** Eighteen JSON Schema contracts under a compatibility
epoch define the vocabulary; fail-closed validators enforce it. The
load-bearing separation is local `audience` versus runtime `visibility`: a
public export that references a non-public source is rejected, and that
check is pinned by fixtures and mutation tests. Dry-run reports are
deterministic — `accepted`, `importable`, `worstOperationStatus` — and
twelve claim-first readiness protocols check a workspace against published
criteria to produce proposed claims, never runtime mutations.

**Collaboration as governed disclosure.** Repositories have enforced roles:
private-domain repos hold one person's source material, shared-project
repos hold what a team may read, and the boundary guard fails closed when
private or sensitive material lands in shared space, when protected local
files are staged, or when private-domain material appears in shared work
without a record. Crossing the boundary requires a recorded `git.promote`
disclosure event. Disclosure is a commit, not an accident. Change to the
machinery itself is governed the same way: the lockfile records exactly
what a workspace runs, and upgrades are branch-based, review-first, and
refuse dirty repositories.

**A local runtime for humans and for agents.** The same workspace projects
a generated review surface over a loopback-only sidecar for humans, and
session-bound context and capability envelopes for agent harnesses. Agents
get a governed view and a place to record proposals; there are no apply
endpoints and no write authority to grant. Context without authority.
Neutral Claude and Codex skill wrappers ship in the package.

**A platform for your own tool.** A distribution wraps the CLI under its
own name, contributes a validated extension pack, and themes the
projection, while the root contracts, guards, and conformance stay
canonical underneath. Commercial use is an Apache-2.0 right, not a favor;
the trademark policy governs the name, and attribution is checked by a
command.

Methodology authoring is the first application, not the ceiling. MNSTRY
built the Atelier to carry its own most demanding case — private
transformational work, where a leaked document is a betrayal — and a
system trustworthy enough for that is trustworthy enough for whatever you
govern with it.

## Quickstart

```bash
npm install --save-dev @mnstry/atelier@0.2.0-alpha.2

npx atelier init --fixture=sample-workspace --target ./sample
npx atelier graph --project ./sample/atelier.project.json
npx atelier project --project ./sample/atelier.project.json
npx atelier readiness --project ./sample/atelier.project.json
MNSTRY_ATELIER_ACTOR=owner npx atelier boundary check --project ./sample/atelier.project.json
npx atelier dev --project ./sample/atelier.project.json
```

`npx` here runs the binary already installed in `./node_modules/.bin`. Always
install first, and keep the `@mnstry/` scope — the unscoped name `atelier`
belongs to an unrelated third-party package.

`init` scaffolds a fictional sample workspace, `graph` builds the knowledge
graph from front matter and sidecars, `project` generates the local review
surface, `dev` serves it on loopback only. From there:

```js
import { validateAtelierExportDryRun } from '@mnstry/atelier'

const report = validateAtelierExportDryRun(exportDocument)
console.log(report.accepted, report.importable, report.errors)
```

Real projects start from the `private-domain`, `shared-project`, or
`distribution` templates instead of the sample fixture.

## Status

- Version: `0.2.0-alpha.2`
- Stability: alpha — contracts are under a compatibility gate from the
  `v0.2.0-alpha.0` epoch tag onward; everything else may still move
- Runtime: Node.js `>=22.18.0 <23`
- Dependencies: ajv, ajv-formats (JSON Schema validation); nothing else at
  runtime
- Distribution: `@mnstry/atelier@0.2.0-alpha.2` on npm, published from the
  `v0.2.0-alpha.2` tag. The `v0.2.0-alpha.0` tag is the contract epoch
  marker, not an install target — it predates the current tree. The version
  `0.2.0` was published in error and unpublished the same day; that number
  is permanently retired on npm and will never be reused.
- Telemetry: none. Network egress: none, with one documented exception —
  see "Nothing leaves your machine" below.

## Claims you can check

This package makes three promises. None of them asks for your trust — each
one names the command that proves it.

**Nothing leaves your machine, with one exception you can see.** There is no
telemetry, no update check, no crash reporting, and no send path anywhere in
the package. The exception: when no actor is configured, `boundary check` and
`doctor` fall back to the `gh` CLI to resolve your GitHub login, which is an
authenticated request to GitHub made with your own credentials. Set
`MNSTRY_ATELIER_ACTOR` and that path is never taken. The only network client
refuses non-loopback URLs, the served pages carry a policy that authorizes no
external origin, and a fail-closed gate scans the executable and markup files
under `src/`, `bin/`, `scripts/`, and `examples/` for egress primitives. Two
limits worth stating plainly: the gate does not read the `.json` and `.md`
files under `templates/` and `skills/`, and it does not model
`child_process`, which is why the `gh` fallback above does not trip it:

```bash
npm run egress:check
```

**Compatibility is checked by machinery, not memory.** Documents valid
against the `v0.2.0-alpha.0` contracts stay valid: every change is checked
against the baseline tag's validators, and schema widening outside `ext`
containers is refused by a schema-vs-schema differ. Breaking changes require
a new contract version and a recorded migration. Known limit: the differ
compares schemas structurally and does not resolve `$ref` pointers, so a
`$ref` retargeted at a looser definition is not caught by this gate — the
fixture tests catch that for contracts with negative fixtures, and closing
the gap in the differ is tracked work:

```bash
npm run contract:compat
```

**Conformance works offline, forever.** Validating a document against the
published contracts needs this package and nothing else — no account, no
service, no network:

```bash
atelier dry-run ./atelier-export.json
```

`docs/continuity.md` records the distribution commitments behind these
claims, including the perpetual Apache-2.0 grant on every tagged release you
receive.

## What it will not do

- It does not write to a MNSTRY runtime database.
- It does not import, provision, publish, or send anything.
- It does not contact external services.
- It does not execute model-assisted analysis or any model provider.
- It does not include client project content.

These limits are the design. An authoring tool for private material earns
trust by what it refuses to be able to do.

## Your documents and the boundary

What you author is yours. Documents live in your repositories, in formats you
chose, readable without this tool. The one vocabulary the contracts enforce:
`audience` describes local source readership (`public`, `team`, `operator`,
`staff`, `private`, `sensitive`); runtime and export `visibility` describes
runtime exposure and accepts only `private`, `shared`, `platform`, or
`public`. A public export referencing a source whose audience is not public
is refused — that check is fixture-pinned and mutation-tested.

## Conformance is public, admission is separate

The Atelier export format is MNSTRY's format, offered openly.

**Anyone can check a document against the published contracts, forever,
offline.** The contracts, fixtures, and dry-run validator all ship in the
package, so conformance needs no account, no network, and no MNSTRY
involvement.

Admission is a narrower, opt-in decision: whether a MNSTRY governed runtime
accepts a document for delivery to clients. Admission is a signed MNSTRY
attestation against criteria this package publishes (`docs/attestation.md`).
The criteria are public, the checker is private, and the rejection message
is part of the contract. You can build on the Atelier without ever talking
to MNSTRY, and a document MNSTRY declines can still be fully conformant.

## Build your own tool on it

The Atelier is designed to be built on, under your name — including
commercially. A distribution wraps the CLI under its own command,
contributes a validated extension pack (branded protocols, terms,
templates), and themes the projection, while the root contracts, guards,
and conformance stay canonical underneath. Apache-2.0 makes commercial use
a right, not a favor; the trademark policy keeps the name ours and the
code yours. Start by copying the worked example:

- `examples/loomworks-studio` — a complete fictional distribution: branded
  bin, extension pack, themed workspace template. It lives in this
  repository and deliberately never ships in the npm tarball.
- `docs/distributions.md` — the contract a distribution must honor.
- `TRADEMARKS.md` — naming rules; Apache-2.0 grants code rights, not brand
  rights. Every distribution carries "powered by MNSTRY Atelier" attribution,
  checked by `atelier distribution check`.

## Feedback and announcements

Both channels respect consent by construction. `atelier feedback` writes a
scanned, redaction-checked report to a local file — there is no send path;
you choose whether and where to share it. `announcements list` verifies
project-shipped announcements against a committed public key — pull-only,
nothing phones home to ask.

## Running the test suite from a fresh clone

`npm test` includes one fail-closed check that expects a private denylist
file (`release-denylist.local.json`, gitignored) used by MNSTRY's release
lane. On a fresh clone that file is absent, so the check **fails** — it never
passes silently on missing protection. Expect this, after `npm install`:

```bash
npm install
npm test     # 510 tests: 509 pass, 1 fail — the denylist check, by design
```

To acknowledge the missing file and run the rest, which turns that failure
into a recorded skip:

```bash
ATELIER_ALLOW_MISSING_DENYLIST=1 npm test     # 509 pass, 0 fail, 1 skipped
```

## Command reference

```bash
atelier dry-run ./atelier-export.json
atelier contract check
atelier graph --project ./atelier.project.json
atelier project --project ./atelier.project.json
atelier readiness --project ./atelier.project.json
atelier readiness protocols
atelier readiness journey --project ./atelier.project.json
atelier readiness run mnstry.readiness:identity-map --project ./atelier.project.json
atelier readiness packet --project ./atelier.project.json
atelier readiness export --dry-run --project ./atelier.project.json
atelier boundary check --project ./atelier.project.json
atelier boundary check --staged --project ./atelier.project.json
atelier boundary install-hooks --project ./atelier.project.json
atelier promote --source-repo tenant-private-domain --target-repo project-alpha --kg-id tenant-private-domain:seed
atelier lock write --project ./atelier.project.json
atelier lock check --project ./atelier.project.json
atelier upgrade --dry-run --project ./atelier.project.json
atelier upgrade --apply --project ./atelier.project.json --branch codex/atelier-upgrade-YYYYMMDD
atelier extension-pack validate --project ./atelier.project.json
atelier attestation verify ./attestation.json
atelier feedback create --message "what happened"
atelier announcements list
atelier distribution check --target ./my-distribution
atelier dev --project ./atelier.project.json
```

`upgrade --apply` creates or switches to the requested branch, refuses dirty
authored repos, preserves unrelated user hooks through composed hook files,
runs only registered migrations, refreshes generated projections, and leaves
a Git commit for review. It will not weaken boundary policy, introduce
telemetry, enable non-loopback egress, run model-assisted analysis, or
write, import, or apply runtime state.

## Sample fixtures

Fixtures in this package are fictional and generic. Project-specific adapter
fixtures belong in their project repositories, not in the published Atelier
package.

## License and contributing

Apache-2.0. See `LICENSE`, `NOTICE` (attribution obligations that survive
forks), `TRADEMARKS.md` (naming), and `docs/continuity.md` (distribution
continuity commitments). Contributions are accepted under inbound-equals-
outbound Apache-2.0 with a DCO sign-off — `CONTRIBUTING.md` is the working
agreement, including how to contribute without exposing client material or
your own private methodology.
