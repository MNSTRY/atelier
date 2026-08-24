# MNSTRY Atelier

**Turn a repository into a living, governed system.**

Important bodies of work often begin as files: methods, research, programs,
policies, editorial systems, product knowledge, or something no existing app
quite understands. A folder can hold that work, but it cannot explain what each
file is, how the pieces relate, who may see them, or whether the whole is ready
to use.

The Atelier adds that missing layer without taking the work away from you. It
turns a repository into an ontology-governed knowledge graph, gives rules the
power to refuse invalid states, and produces bounded views for people, teams,
agents, and tools. Git remains the source of record. Your files remain readable.
The runtime remains local.

That makes the same repository useful at several levels:

- A **steward** can shape a coherent system without surrendering it to a
  proprietary database.
- A **team** can collaborate through explicit roles, handoffs, and disclosure
  boundaries.
- A **person or agent** can receive the right context and capabilities for the
  task, without receiving the entire repository.
- A **toolmaker** can build a specialized or commercial product on the graph,
  contracts, validators, and projections instead of inventing a new source of
  truth.

MNSTRY built the Atelier for a demanding case: a living body of methodology
that must stay legible, internally connected, privacy-aware, and usable across
many interfaces. Methodology authoring is one application of the system, not
its definition or ceiling.

## From files to a working system

```text
files you own
    ↓ declare identity, type, audience, and relationships
ontology-governed graph
    ↓ apply contracts, policies, and readiness rules
governed projections
    ├── local review
    ├── bounded agent context
    ├── collaboration and disclosure
    └── specialized tools and commercial distributions
```

You can see the complete loop in a disposable sample workspace:

```bash
npm install --save-dev @mnstry/atelier@0.2.0-alpha.4
npx mnstry-atelier init --fixture=sample-workspace --target ./sample
npx mnstry-atelier graph --project ./sample/atelier.project.json
npx mnstry-atelier project --project ./sample/atelier.project.json
npx mnstry-atelier dev --project ./sample/atelier.project.json
```

Open the loopback URL printed by `dev`. The browser page is generated from
the same graph and rules that the CLI and library expose.

`npx` here runs the binary installed in `./node_modules/.bin`, so install the
scoped package first. Keep the `@mnstry/` scope: the unscoped npm package
`atelier` is unrelated. The branded `npx mnstry-atelier` command avoids that
collision; inside an installed workspace, the shorter `atelier` command is
also available.

## What authoring looks like

Enrollment is deliberately small. A source file declares its identity, type,
audience, and relationships in front matter:

```markdown
---
title: Breath practice
summary: A simple preparation practice.
tags: []
kg:
  id: example:breath-practice
  type: document
  status: active
  audience: public
  relations:
    belongs_to: example:flagship-program
---

# Breath practice

Let the exhale become slightly longer than the inhale.
```

The file is still Markdown. Git still records its history. The declarations
let the Atelier resolve one canonical identity, validate its declared shape,
connect it to neighboring work, and decide where it may
travel.

When a source format cannot carry front matter, a sidecar can provide the same
declarations. The graph does not require every source to become Markdown.

From there, one source can inform a human-readable review page, a session-bound
context envelope for an agent, or structured input to another tool. These are
interfaces to the same governed repository, not copies that quietly drift apart.

## Rules travel with the work

The ontology is not only a vocabulary. It is an enforcement surface. Contracts
define valid shapes, policies govern movement and disclosure, readiness rules
make completion testable, and validators fail closed when a boundary cannot be
proven.

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

That distinction matters whenever several interfaces share one body of work.
A public site, an internal review tool, and an agent session can all use the
same graph while receiving different, mechanically checked projections.

## The system beneath it

### 1. The repository becomes an ontology

The project manifest tells the Atelier where sources live and which boundaries
govern the workspace. Source declarations establish typed nodes and relationships. The
graph command resolves those declarations into a deterministic index that can
be queried, validated, rendered, and extended.

This is what makes a collection of files behave like a system while remaining
portable. The repository contains both the knowledge and the terms needed to
interpret it.

### 2. Rules can refuse

A useful rule must do more than advise. The Atelier checks schema validity,
relationship integrity, audience boundaries, readiness protocols, and export
contracts. Invalid or ambiguous states produce a failing command instead of a
best-effort publication.

Because the checks are local and versioned with the work, the repository can
prove its state in CI, on a laptop, or inside a larger toolchain.

Repositories that may contribute to a public or shared surface can add a
private, ignored disclosure denylist and scan either the tracked tree or the
exact staged index:

```bash
npx mnstry-atelier disclosure check --staged
```

The built-in structural pass catches machine-local paths, key material, and
secret-shaped assignments. A client-aware verdict additionally requires the
private denylist; the command fails closed when it is absent unless
`--structural-only` is chosen explicitly. Denylist patterns and matched text
never belong in the shared repository.

### 3. Collaboration becomes governed disclosure

Collaboration is not equivalent to giving every participant every file. The
Atelier models audience, runtime visibility, roles, and capability envelopes
as separate concerns. A projection can therefore disclose the material needed
for a task while withholding material outside that boundary.

This creates a shared language for human handoffs, agent sessions, reviews,
and eventual managed delivery. The open package validates the declared
boundary; it does not silently make access decisions on your behalf.

### 4. The local runtime serves people and agents

`atelier dev` exposes a loopback-only review surface backed by the compiled
graph. The library exposes the same project, graph, validation, and projection
primitives to code.

Consumer-owned authoring or review services that need a separate durable
lifecycle follow [the managed local-service contract](./docs/local-services.md).
That contract standardizes process ownership, private local state, and browser
recovery without putting a tenant's service details into Atelier.

The shipped agent model is intentionally bounded: the Atelier can assemble
session context, capability envelopes, and proposed changes, but it does not
apply those proposals or grant direct write access. It is a local context and
control layer that another interface can build on, not an autonomous editor.

### 5. The repository can power another product

The CLI is one interface. The package is also a library, and its contracts are
published artifacts. A tool can use the repository as its durable source of
truth, compile the graph, select an audience-safe projection, and present a
purpose-built experience without reimplementing the governance model.

That tool may be private, open source, or commercial. Apache-2.0 permits all
three. Conformance to the public Atelier contracts does not require a MNSTRY
account or service.

Read [the design document](./docs/design.md) for the five-part architecture and
[the ontology](./docs/ontology.md) and
[contract-stability policy](./docs/contract-stability.md) for the stable
boundaries.

## Build your own tool on it

Use the CLI when a shell command or CI gate is enough. Use the library when the
Atelier is the substrate beneath a custom interface:

```js
import {
  buildGraph,
  resolveProjectConfig,
} from '@mnstry/atelier'

const project = resolveProjectConfig({
  cwd: process.cwd(),
  argv: ['--project=./atelier.project.json'],
})
const graph = buildGraph(project)

if (graph.errors.length > 0) throw new Error(graph.errors.join('\n'))
console.log(graph.nodes)
```

The package exports change over the alpha series, so pin the exact prerelease
version and treat the package export map and shipped source modules as the
executable API reference. [Distribution contracts](./docs/distributions.md) explain
how a governed subset can be packaged for another surface without widening its
audience.

## Where the Atelier stops

The open package owns repository-side structure and proof. A managed runtime
may consume a conformant export, but that is a separate system with a separate
trust boundary.

| The local Atelier does | A managed runtime may do |
| --- | --- |
| Parse sources and sidecars | Authenticate participants |
| Compile and query the graph | Resolve live authorization |
| Validate contracts and relationships | Persist runtime state |
| Enforce export audience boundaries | Deliver governed experiences |
| Generate local review and agent context | Record consent and operational events |
| Check offline conformance | Decide optional admission |

### Claims you can verify

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

### What it will not do

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

### Conformance and admission

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

## Install and go deeper

Node.js `>=22.18.0 <23` is required. Pin the prerelease while the package
remains in alpha:

```bash
npm install --save-dev @mnstry/atelier@0.2.0-alpha.4
```

Then choose the path that matches what you are building:

- [Installation and first run](./docs/install.md)
- [Design and architecture](./docs/design.md)
- [Knowledge graph and source model](./docs/knowledge-graph.md)
- [Local runtime and agent boundary](./docs/atelier-runtime.md)
- [Distribution contracts](./docs/distributions.md)
- [Conformance and attestation](./docs/attestation.md)
- [Continuity commitments](./docs/continuity.md)
- [Upgrade notes](./docs/upgrade.md)

## Status and command reference

Current package: `@mnstry/atelier@0.2.0-alpha.4`.

The alpha package is usable and contract-tested, but its library API may still
change before a stable release. Pin the exact version in production toolchains.

```text
atelier init
atelier adopt
atelier setup
atelier graph
atelier project
atelier build
atelier dev
atelier generated check
atelier config check
atelier extension-pack
atelier distribution check
atelier egress check
atelier boundary
atelier readiness
atelier export
atelier context flow
atelier support bundle
atelier feedback
atelier announcements
atelier attestation
atelier promote
atelier upgrade
atelier lock
```

Run `atelier --help` or `atelier <command> --help` for the current flags. The
full command behavior is also covered by the package's executable tests.

## Contributing and license

Contributions are welcome through [the contribution guide](./CONTRIBUTING.md).
MNSTRY Atelier is released under [Apache-2.0](./LICENSE).
