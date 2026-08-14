# The design

The Atelier makes a repository mean something. Files declare what they are,
who they are for, and how they relate — and machinery enforces it.

**Git is the database. The ontology is the schema. The validators are the
constraints. The runtime is local.**

This page states the design in five movements. Each one is a general
primitive, grounded in a shipped mechanism, ending with the command that
proves it — because a design document that cannot be checked is marketing.

## 1. A repository with an ontology

A small structured header turns a file into a node: front matter on
Markdown, or a `.kg.json` sidecar beside any other format — JSON, YAML,
CSV, media, anything — which the kit enrolls without ever parsing the
foreign format. The header declares identity (`kg.id`), type, status,
audience, and relations to other nodes.

The graph builder compiles the repository into a knowledge graph,
deterministically: same tree in, same graph out, and `--check` mode fails
when a generated graph has drifted from its sources. There is no import
step, no database, and no export lock-in. The repository is the store. Git
is the history, the review process, and the read boundary you already
trust — an audience label guides projection, but repository access is what
actually hides a file.

```bash
atelier graph --project ./atelier.project.json
atelier graph --check --project ./atelier.project.json
```

## 2. Rules that refuse

The ontology is not documentation. It is the enforcement mechanism.

Eighteen JSON Schema contracts define the vocabulary — exports, project
configuration, boundary policy, sidecars, locks, migrations, readiness,
attestation — and fail-closed validators enforce it. The load-bearing
separation is `audience` versus `visibility`: audience is local readership
(`public`, `team`, `operator`, `staff`, `private`, `sensitive`), visibility
is runtime authority (`private`, `shared`, `platform`, `public`), and the
validators reject every crossing — a local audience word in a visibility
field, a `visibility` key on a source node, and above all a public export
that resolves any source reference to a non-public source. That last check
is fixture-pinned and mutation-tested: deleting its enforcement makes tests
fail, not documentation drift.

The contracts sit under a stability epoch. Every change is checked against
the baseline tag's validators, schema widening outside namespaced `ext`
containers is refused by a schema-vs-schema differ, and a breaking change
requires a new contract version with a recorded migration. Twelve bundled
claim-first readiness protocols check a workspace against published
criteria and produce proposed claims — never runtime mutations.

```bash
atelier dry-run ./atelier-export.json
atelier contract check
npm run contract:compat
```

## 3. Collaboration as governed disclosure

Repositories have roles. A private-domain repo holds one person's source
material; a shared-project repo holds what a team may read. The boundary
guard enforces the difference and fails closed: private or sensitive
source placed in a shared repo blocks, protected local files staged for
commit block, and private-domain material appearing in shared work without
a recorded disclosure blocks.

Crossing the boundary is an event with a record: `atelier promote` writes a
`git.promote` disclosure event, reviewable like any other commit.
Disclosure is a commit, not an accident.

Change to the machinery itself is governed the same way. The workspace
lockfile records exactly which package version, contracts, extension
packs, and migrations a workspace runs; upgrades are branch-based,
review-first, refuse dirty repos, and never silently overwrite authored
content.

```bash
atelier boundary check --project ./atelier.project.json
atelier boundary check --staged --project ./atelier.project.json
atelier promote --source-repo <private-repo> --target-repo <shared-repo> --kg-id <node>
atelier lock check --project ./atelier.project.json
```

## 4. A local runtime for humans and for agents

The same governed workspace projects two ways.

For humans: a generated review surface, served by a sidecar that binds to
loopback only. The served pages carry a policy that authorizes no external
origin, and the only network client in the package refuses non-loopback
URLs.

For agents: session-bound context and capability envelopes that hand an
agent harness a governed view of the workspace — what exists, what it may
look at, what it may propose. Proposals are recorded as metadata; there
are no browser apply endpoints and no write authority to grant. Context
without authority. Neutral Claude and Codex skill wrappers ship in the
package, so a harness can do readiness review work against the workspace
without a single line of custom glue.

This is the honest answer to the question every team has right now: how do
you put an agent inside private material safely? Not by trusting the
agent — by projecting a bounded view and making writing impossible.

```bash
atelier dev --project ./atelier.project.json
atelier context flow --project ./atelier.project.json
```

## 5. A platform for your own tool

The Atelier is designed to be built on, under your name, including
commercially.

A distribution wraps the CLI under its own command, contributes a
validated extension pack — branded protocols, terms, templates — and
themes the projection, while the root contracts, guards, and conformance
stay canonical underneath. The repository carries a complete fictional
reference distribution (`examples/loomworks-studio`) small enough to read
in one sitting: a wrapper bin, a pack, a themed workspace.

Apache-2.0 makes commercial use a right, not a favor. The trademark policy
keeps the name ours and the code yours: every distribution carries
"powered by MNSTRY Atelier" attribution, and the check is a command, not a
request. Contributions run inbound-equals-outbound with a DCO sign-off and
no CLA — nobody, including MNSTRY, holds rights over your contribution
that you do not also hold.

```bash
atelier distribution check --target ./my-distribution
atelier extension-pack validate --project ./atelier.project.json
```

## The first application

Methodology authoring is the Atelier's first application, not its ceiling.
MNSTRY built this to carry its own most demanding case: private
transformational work, where a leaked document is not a bug but a
betrayal. That case set the bar — fail-closed boundaries, no telemetry, no
send path, agents without authority, disclosure as a recorded event.

A system trustworthy enough for that is trustworthy enough for whatever
you govern with it: a research corpus, a client practice, an editorial
pipeline, a body of work that must outlive the tools that touch it.

The claims behind this page are stated precisely, with their known limits,
in the README's "Claims you can check" — each with the command that proves
it. `docs/continuity.md` records the distribution commitments, including
the perpetual Apache-2.0 grant on every tagged release you receive.
