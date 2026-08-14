# MNSTRY Atelier

**Author your methodology once, in files you own, in a form machines can
validate and runtimes can honor.**

A methodology that creates real transformation cannot scale through static
content, generic AI, or manual labor. Scaling it means giving it a form
machines can carry — and most tools do that by taking the work into their
platform, their format, their database, where it stops being fully yours.
The Atelier answers the same problem the other way around.

The Atelier is a local-first toolkit for authoring a body of work as
structured documents machines can validate — plain files, in your own Git
repositories, on your machine, under your control. You author primitives,
sources, and offers; the Atelier builds a knowledge graph over them,
projects a local review surface, checks readiness against published
protocols, and validates exports against public contracts. There is no
telemetry and no send path, and the commands that prove the package's
promises are further down this page.

It is built for methodology holders and the studios that serve them. The
MNSTRY runtime — the governed platform for identity, consent, visibility,
provisioning, bookings, commerce, sessions, audit, and client-grade
sharing — is a separate, optional destination. The Atelier is the front
porch, not the house: everything here works without ever talking to MNSTRY.

## What authoring looks like

A source document is a plain file with a small structured header. This is a
complete, working example — fictional, like every fixture in this package:

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

Git is the database. The ontology is the schema. The validators are the
constraints. The runtime is local. The design is five movements, each
grounded in shipped machinery — [docs/design.md](docs/design.md) states
them in full, ending each one with the command that proves it:

**A repository with an ontology.** Front matter — or a `.kg.json` sidecar
beside any format the kit never parses — declares a file's identity, type,
audience, and relations. The graph builder compiles the repository into a
deterministic knowledge graph. No import step, no database: the repository
is the store, and Git is the history, the review process, and the read
boundary.

**Rules that refuse.** Eighteen contracts under a compatibility epoch
define the vocabulary; fail-closed validators enforce it. A public export
that references a non-public source is rejected — fixture-pinned and
mutation-tested — and dry-run reports are deterministic: `accepted`,
`importable`, `worstOperationStatus`. Twelve bundled claim-first readiness
protocols check the work against published criteria and produce proposed
claims, never runtime mutations.

**Collaboration as governed disclosure.** Private-domain and shared-project
repos have enforced roles: the boundary guard fails closed when private or
sensitive material lands in shared space, when protected local files are
staged, or when private-domain material appears in shared work without a
recorded `git.promote` disclosure event. Disclosure is a commit, not an
accident. Change to the machinery itself is governed the same way — the
lockfile records exactly what a workspace runs, and upgrades are
branch-based, review-first, and refuse dirty repos.

**A local runtime for humans and for agents.** The workspace projects two
ways: a generated review surface over a loopback-only sidecar for humans,
and session-bound context and capability envelopes for agent harnesses — a
governed view with proposals recorded as metadata and no apply endpoints.
Context without authority. Neutral Claude and Codex skill wrappers ship in
the package.

**A platform for your own tool.** A distribution wraps the CLI under your
own name, contributes a validated extension pack, and themes the
projection, while the root contracts, guards, and conformance stay
canonical underneath — commercially if you want. See "Build your own tool
on it" below.

Methodology authoring is the first application, not the ceiling. MNSTRY
built the Atelier to carry its own most demanding case — private
transformational work, where a leaked document is a betrayal — and a
system trustworthy enough for that is trustworthy enough for whatever you
govern with it.

## Quickstart

```bash
npm install --save-dev @mnstry/atelier@0.2.0-alpha.1

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

- Version: `0.2.0-alpha.1`
- Stability: alpha — contracts are under a compatibility gate from the
  `v0.2.0-alpha.0` epoch tag onward; everything else may still move
- Runtime: Node.js `>=22.18.0 <23`
- Dependencies: ajv, ajv-formats (JSON Schema validation); nothing else at
  runtime
- Distribution: `@mnstry/atelier@0.2.0-alpha.1` on npm, published from the
  `v0.2.0-alpha.1` tag. The older `v0.2.0-alpha.0` tag is the contract
  epoch marker, not an install target — it predates the current tree.
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

## What this package will not do

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
`staff`, `private`, `sensitive`); runtime/export `visibility` describes
runtime exposure and accepts only `private`, `shared`, `platform`, or
`public`. A public export referencing a source whose audience is not public
is refused — that check is fixture-pinned and mutation-tested.

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

## The MNSTRY relationship

The Atelier export format is MNSTRY's format, offered openly. Conformance —
is this document valid against the published contracts? — is public,
offline, and free, forever. Admission — will MNSTRY's governed runtime
accept it for delivery to clients? — is a separate, opt-in step: a signed
attestation issued by MNSTRY against criteria this package publishes
(`docs/attestation.md`). The criteria are public; the checker is private;
the rejection message is part of the contract. You can build on the Atelier
without ever talking to MNSTRY, and a document MNSTRY declines can still be
fully conformant.

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
npm test     # 509 tests: 508 pass, 1 fail — the denylist check, by design
```

To acknowledge the missing file and run the rest, which turns that failure
into a recorded skip:

```bash
ATELIER_ALLOW_MISSING_DENYLIST=1 npm test     # 508 pass, 0 fail, 1 skipped
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
telemetry, enable non-localhost egress, run model-assisted analysis, or write/import/apply
runtime state.

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
