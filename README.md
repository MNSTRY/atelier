# MNSTRY Atelier

**The Atelier makes a repository mean something.** It is a local governance
toolkit for file-based bodies of work — a Node CLI and library with no
service, no account, and no telemetry. Git is the database. The ontology is
the schema. The validators are the constraints. The runtime is local.

An ordinary file gains a small structured header: what this is, who it is
for, what it relates to. That is the entire enrollment. From those
declarations the Atelier builds a knowledge graph over your work, generates
a review page you read in a browser on loopback, checks the work against
published readiness protocols, and rejects what must never happen — a
public export that quietly references a private source.

MNSTRY publishes it under Apache-2.0 and authors its own workspaces with
it. Everything here runs without ever talking to a MNSTRY runtime, so it
can govern a methodology, a research corpus, an editorial pipeline, or any
body of work that must outlive the tools that touch it. Every promise on
this page ends in a command you can run.

```bash
npm install --save-dev @mnstry/atelier@0.2.0-alpha.2
npx mnstry-atelier init --fixture=sample-workspace --target ./sample
npx mnstry-atelier graph --project ./sample/atelier.project.json
```

`npx` here runs the binary already installed in `./node_modules/.bin` —
always install first. Keep the `@mnstry/` scope: the unscoped npm name
`atelier` belongs to an unrelated third-party package, so a bare
`npx atelier` outside an installed workspace runs someone else's code.
The branded `npx mnstry-atelier` form never collides with it; inside an
installed workspace the shorter `atelier` command is also available, and
that is the form npm scripts and the command reference below use.

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
YAML, CSV, media, anything — without ever parsing the foreign format. Your
documents stay in your repositories, in formats you chose, readable
without this tool. From there the working loop is four commands:

```bash
npx mnstry-atelier graph --project ./sample/atelier.project.json      # build the knowledge graph
npx mnstry-atelier project --project ./sample/atelier.project.json    # generate the local review page
npx mnstry-atelier readiness --project ./sample/atelier.project.json  # check against published protocols
npx mnstry-atelier dry-run ./atelier-export.json                      # validate against the public contracts
```

After those four commands you have a generated graph, a browsable review
page under your project's output directory, a readiness summary, and a
dry-run report — all of them files in your repository, all of them
diffable. `npx mnstry-atelier dev` serves the review page on loopback.

<!-- atelier:block:audience-visibility:start -->
The `audience` field in the header is the load-bearing word. It declares who
a source is written for — `public`, `team`, `operator`, `staff`, `private`,
or `sensitive` — and the machinery downstream refuses to let material travel
further than its audience allows. Runtime and export `visibility` is a
separate vocabulary (`private`, `shared`, `platform`, `public`) describing
runtime exposure, and the validators reject every crossing between the two.
Above all: a public export that references a source whose audience is not
public is refused. That check is fixture-pinned and mutation-tested —
deleting its enforcement fails tests, not documentation.
<!-- atelier:block:audience-visibility:end -->

The same machinery is a library:

```js
import { validateAtelierExportDryRun } from '@mnstry/atelier'

const report = validateAtelierExportDryRun(exportDocument)
console.log(report.accepted, report.importable, report.errors)
```

Real projects start from the `private-domain`, `shared-project`, or
`distribution` templates instead of the sample fixture —
[`docs/install.md`](docs/install.md) is the full install guide.

## Claims you can check

<!-- atelier:block:claims:start -->
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
<!-- atelier:block:claims:end -->

## What it will not do

<!-- atelier:block:will-not-do:start -->
- It does not write to a MNSTRY runtime database.
- It does not import, provision, publish, or send anything.
- Except for the documented `gh` actor-resolution fallback, it initiates no
  external network requests.
- It does not execute model-assisted analysis or any model provider.
- It does not include client project content.

These limits are the design. An authoring tool for private material earns
trust by what it refuses to be able to do.
<!-- atelier:block:will-not-do:end -->

## Conformance is public, admission is separate

<!-- atelier:block:conformance-admission:start -->
The Atelier export format is MNSTRY's format, offered openly.

**Anyone can check a document against the published contracts, forever,
offline.** The contracts, fixtures, and dry-run validator all ship in the
package, so conformance needs no account, no network, and no MNSTRY
involvement.

Admission is a narrower, opt-in decision: whether a MNSTRY governed runtime
accepts a document for delivery to the people it serves. That is what
admission buys — delivery through a runtime that enforces consent and
visibility at serve time — and it takes the form of a signed MNSTRY
attestation against criteria this package publishes (`docs/attestation.md`).
The criteria are public, the checker is private, and the rejection message
is part of the contract. You can build on the Atelier without ever talking
to MNSTRY, and a document MNSTRY declines can still be fully conformant.
<!-- atelier:block:conformance-admission:end -->

## Where the Atelier stops

The Atelier is a complete, standalone tool; nothing on the right side of
this table is required to use it. MNSTRY's managed platform begins where
local preparation ends:

| The Atelier, today                    | The MNSTRY managed platform        |
| ------------------------------------- | ---------------------------------- |
| Local files and Git authority         | Runtime authority                  |
| Knowledge graph and review projection | Governed delivery                  |
| Readiness checks and proposed claims  | Runtime consent and identity       |
| Offline conformance                   | Signed admission                   |
| Proposal-only harness access          | Tenant applications and operations |

## The system

The full design lives in [`docs/design.md`](docs/design.md) — five
movements, each grounded in shipped machinery, each ending with the command
that proves it. In brief:

**A repository with an ontology.** Front matter — or a `.kg.json` sidecar
beside any format the kit never parses — declares a file's identity, type,
audience, and relations. A node's `kg.id` names its canonical: the stable
source-of-truth version of a thing that people, tools, and agents can refer
to without losing meaning. The graph builder compiles the repository into a
deterministic knowledge graph. No import step, no database: the repository
is the store, and Git is the history, the review process, and the read
boundary.

**Rules that refuse.** JSON Schema contracts under a compatibility epoch
define the vocabulary, and fail-closed validators enforce it — including
the audience/visibility refusal above. Schema widening outside `ext`
containers is refused by a schema-vs-schema differ, breaking changes
require a new contract version with a recorded migration, and twelve
claim-first readiness protocols check a workspace against published
criteria to produce proposed claims, never runtime mutations.

**Collaboration as governed disclosure.** Repositories have enforced roles:
private-domain repos hold one person's source material, shared-project
repos hold what a team may read, and the boundary guard fails closed when
material crosses without a record. Crossing the boundary requires a
recorded `git.promote` disclosure event — disclosure is a commit, not an
accident. Change to the machinery itself is governed the same way: the
lockfile records exactly what a workspace runs, and upgrades are
branch-based, review-first, and refuse dirty repositories.

**A local runtime for humans and for agents.** `atelier project` renders a
projection — a contextual view of the same governed workspace. Humans get a
generated review page over a loopback-only sidecar; agent harnesses get
session-bound context and capability envelopes, with a place to record
proposals and no apply endpoints. That is a narrow, testable control — a
bounded view, and no write authority to grant — not a general claim that an
agent is safe around private material. Neutral Claude and Codex skill
wrappers ship in the package.

**A platform for your own tool.** A distribution wraps the CLI under its
own name, contributes a validated extension pack, and themes the
projection, while the root contracts, guards, and conformance stay
canonical underneath.

It exists because some bodies of work are too important to live inside
someone else's platform. MNSTRY built the Atelier to carry its own most
demanding case — private transformational work, where a leaked document is
a betrayal — and that case shaped the defaults: fail-closed boundaries, no
telemetry, no send path, agents without authority, disclosure as a recorded
event. Other domains reuse the mechanics and define their own ontology,
protocols, and boundary policies. Methodology authoring is the first
application, not the ceiling.

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
- [`docs/distributions.md`](docs/distributions.md) — the contract a
  distribution must honor.
- `TRADEMARKS.md` — naming rules; Apache-2.0 grants code rights, not brand
  rights. Every distribution carries "powered by MNSTRY Atelier"
  attribution, checked by `atelier distribution check`.

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
  see "Claims you can check" above.

## Command reference

Commands below use the `atelier` form, which is what an installed
workspace sees; from outside a workspace, invoke the same commands as
`npx mnstry-atelier`.

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

`feedback create` writes a scanned, redaction-checked report to a local
file — there is no send path; you choose whether and where to share it.
`announcements list` verifies project-shipped announcements against a
committed public key — pull-only, nothing phones home to ask
([`docs/announcements.md`](docs/announcements.md)).

## License and contributing

Apache-2.0. See `LICENSE`, `NOTICE` (attribution obligations that survive
forks), `TRADEMARKS.md` (naming), and `docs/continuity.md` (distribution
continuity commitments).

Issues and questions are welcome. Outside pull requests are not open yet —
a required CI check currently asserts maintainer commit identity — and
`CONTRIBUTING.md` states that posture plainly, along with the
inbound-equals-outbound Apache-2.0 terms and DCO sign-off that will govern
contributions when they open. One expectation worth knowing before you run
the suite: `npm test` from a fresh clone fails exactly one check by
design — a release-lane protection whose private file is absent — and
`CONTRIBUTING.md` explains the acknowledged-skip form.
