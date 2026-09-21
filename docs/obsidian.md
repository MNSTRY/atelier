# Obsidian projection: selection, apply policy and acceptance receipts

This document describes the selection binding, the apply policy setup, the
conflict-state view and the acceptance receipt validator under
`src/projection/obsidian/selection-ui/`. It states what each one does on this
machine and what it does not. The contract itself is in
[obsidian-contract.md](obsidian-contract.md).

Nothing in this module starts the app, runs `obsidian-cli`, publishes a vault
or writes a source file. The test suite installs a spawn guard that throws if
anything tries.

## What is real and what is not

Real, on this machine, today:

- A declared view (`full`, `scoped` or `focus`, with an optional bounded
  expansion) resolves to an exact scope document, the exact selected set, and
  the note paths a vault of this workspace gives those notes.
- A focus resolves to a Graph "Search files" query naming every selected note
  by its exact path, plus the payload of a core Bookmark that retains the
  query.
- The resolved selection persists in Atelier's private workspace state and
  reads back exactly.
- A manual or automatic apply policy is built, digested, validated and
  installed through the runtime's installer; revocation is durable and is
  re-read before every queued dispatch.
- A read-only view of the arbitration state answers which objects are
  conflicted, pending, settled or unreadable and what a person does next.
- A receipt document for one of the gates G07 and G13 to G18 is checked for
  shape and required fields.

Not real, and not claimed:

- Whether the installed app applies the focus query as built, indexes the
  vault, or shows the graph the way the receipt says. That is acceptance
  evidence from a running app (AP-01, AP-02), and nothing here produces it.
- Whether any gate is closed. `validateAcceptanceReceipt` answers
  `gateClosed: false` on every input; its result is labelled
  `schema-validation-only`.
- Any change to the files the app's UI owns under `.obsidian/`. Atelier never
  writes `workspace.json`, `graph.json` or `bookmarks.json`.

## Selection

`resolveSelection({ canonicalSnapshot, profile, scope, allowEmpty, pathRegistry })`
calls the contract's `selectScope` unchanged and adds no selector, default or
fallback. The answer carries:

- `scope`: the exact scope document (`atelier-obsidian-scope/v1`). The only
  members filled in are the two expansion defaults the contract allows,
  `direction: outgoing` and `order: canonical-id`. A budget is never
  defaulted; an expansion without `depth` and `maxNodes` refuses with
  `missing-expansion-budget`, and a budget out of range refuses with
  `invalid-expansion`.
- `nodes`, `edges`, `outsideSelectionEdges`, `vaultNodes`, `vaultEdges`,
  `truncated`, `unresolvedIds`, `diagnostics`: `selectScope`'s answer as is.
- `notePaths`: one vault-relative path per selected node, allocated by the
  workspace path registry when the caller passes the persisted one, or by a
  fresh allocation otherwise. Both are deterministic for the same inputs.
- `empty` and `emptyReason` (`explicit-empty` or `no-visible-members`). An
  empty selection is refused with `selection-empty` unless the caller passes
  `allowEmpty: true`; it is then reported empty, never widened.
- `focus`: `null` unless the mode is `focus`.

A withheld identity and an absent one are one answer, `unresolvedIds`, and
neither falls back to the whole corpus.

### Focus

A focus keeps the full vault on disk and filters the native Graph view. The
query is

```
path:"<note path>" OR path:"<note path>" ...
```

in the order of the selected set (canonical-id order). Inside the quoted term
a backslash and a double quote are escaped with a backslash; nothing else is
changed, so a path that itself contains search operators (`tag:`, `-`, `OR`,
parentheses) stays text. Paths are NFC-normalized before they are quoted. A
path that carries a control character, a C1 control, or the U+2028 or U+2029
line separator cannot be a search term and refuses with
`focus-path-unrepresentable`; so does an absolute path, a backslash path or a
`..` segment. A focus with no selected note refuses with
`focus-selection-empty` even when the caller allows empty results: a filter
naming nothing would show the whole vault or nothing, and neither was asked
for.

The bookmark payload is `{ type: "graph", title: "Atelier focus <scope-id>",
options: { search: <query> } }`, the shape of a core-Bookmark graph entry.
The app assigns the creation time when the bookmark is made there. Only the
`graph` type is produced: core Bookmarks retain graph views, not local-graph
views.

Both values are applied by a person, an agent or the acceptance procedure in
the app. Atelier hands them over and writes nothing under `.obsidian/`.

### Where the selector persists

`writeSelectionState` keeps the resolved selection at

```
<data>/obsidian/<workspace-id>/state/selection/<scope-id>.json
```

beside the maintenance and settings documents the runtime keeps there,
through the same private-state primitives (owner-only mode, atomic replace,
no symlink following) and the same guard that refuses private state inside an
enrolled repository. `assertWritableSelectionPath` refuses any target outside
`state/selection`, any target under `vaults/`, and any path with a `.obsidian`
segment. A rewrite that would change only the timestamp is not a change and
is not written. A stored document of another workspace, or one with a member
the shape does not know, refuses on read with `invalid-selection-state`.

## Apply policy setup

`runPolicySetup({ action, input, workspace, repositoryRoots, now })` takes a
structured request and answers a structured document
(`atelier-obsidian-policy-setup/v1`, `ok: true|false`; a refusal is carried
as `refusal: { code, message, detail }`).

- `create`: builds `atelier-obsidian-apply-policy/v1` from
  `{ policyId, mode, actor, selector, allowedEditClasses?, maxBatchSize?,
  retryBudget?, version? }`, computes the canonical digest, validates the
  document against the frozen contract and installs it through the runtime's
  installer. `mode` is `manual` or `automatic`. Only an edit class with an
  apply implementation can be allowed (`body-replacement` today); any other
  refuses with `unimplemented-edit-class`. The conflict disposition is `hold`,
  the only one that exists. Without an explicit `version`, the next revision
  of an installed identity is one above it; an equal or lower version refuses
  with `policy-version-not-newer` and installs nothing.
- `show`: the installed policy, the reference to it in the machine settings,
  the maintenance mode, and whether an automatic apply would be authorized
  right now.
- `revoke`: the stored policy is rewritten `revoked` first, then the
  maintenance mode goes back to `manual`. Every later authorization read
  denies with `apply-policy-revoked`, even when the mode is switched back to
  automatic by hand.

Installing a policy never switches the maintenance mode. That is the person's
separate `mode set automatic`, which itself checks that an active automatic
policy is installed.

### Revocation wins

The dispatch loop reads authorization from disk immediately before each
queued edit. A revocation that lands while one edit is being applied stops
the next one in the same batch: it is never dispatched, it stays `queued`,
and after a restart nothing is dispatched at all because the revocation is on
disk. `dispatchGate(workspace)` exposes that read in the form a caller sees.

## Conflict view

`conflictView({ objects, edits, scopeId })` is a pure function of the object
entries (the object store's `list()`) and the pending edit records.
`readConflictView` reads both from the workspace's private state. The answer
(`atelier-obsidian-conflict-view/v1`) lists, per object, its identity, state
(`conflicted`, `pending`, `settled`, `empty`, `inconsistent`, `unreadable`),
source digest, whether a lease is held, whether an apply was started whose
outcome is not recorded, its operations with their states and reasons, the
conflicted operation keys, the open edits of the views that feed it, whether
a person is needed, and what happens next. No note text, title or path leaves
the view. The view decides nothing, chooses no winner and appends no event: a
conflict is resolved by a new operation that names the ones it resolves.

## Acceptance receipt validation

`validateAcceptanceReceipt(receipt, { gate })` checks a document against the
`acceptance-receipt` schema and then against the rules of the named gate. The
answer carries `label: "schema-validation-only"`, `schemaValid`,
`requirementsMet`, `valid`, `outcome`, `evidenceType`, the list of
`missing` entries (`{ code, pointer, message }`), and always
`gateClosed: false` with `closes: "nothing"`. A failed or blocked receipt is
a valid receipt of its outcome; validity is not a pass.

A gate is closed by its owner inspecting the actual app, host or adopter
evidence and recording that in the parent matrix. A document that passes here
is an input to that inspection, never its result.

### Required fields per gate

Every gate requires: `candidate.commit` (not the zero placeholder),
`candidate.treeDigest`, exact `environment.os.{name,version}`,
`environment.app.{name,version}` and `environment.cli.version` (a placeholder
such as `latest`, `unknown`, `n/a` or a blank refuses), every `evidence[]`
entry hashed with a positive `byteLength`, and `host.id` and `operator.id`
under `ext["mnstry.atelier.obsidian"]`. The extension is a closed shape:
`host`, `operator`, `evidenceRoles`, `acceptance`, `wallClock`, `dataset`.

| Gate | Procedure | Evidence type | Evidence roles (each names a hashed entry) | Also required |
| --- | --- | --- | --- | --- |
| G07 | AP-01 | `real-app` | `cli-link-inspection`, `app-observation` | human acceptance |
| G13 | AP-02 | `real-app` | `on-disk-membership`, `app-index-membership`, `graph-filter-observation` | human acceptance |
| G14 | AP-03 | `host` | `source-refresh-trace`, `dropped-event-recovery`, `sleep-wake-clock` | wall clock; no acceptance |
| G15 | AP-03 | `host` | `ownership-health`, `terminal-closure` | wall clock; no acceptance |
| G16 | AP-04 | `real-app` | `dataset-manifest`, `resource-samples`, `app-indexing-timings`, `warm-update-latencies` | wall clock; dataset (nodes, edges, fixture digest); no acceptance |
| G17 | AP-05 | `real-app` | `multi-vault-edit-trace`, `manual-apply-trace`, `automatic-apply-trace`, `uninstall-retention` | human acceptance |
| G18 | AP-06 | `human` | `tarball-audit`, `adopter-acceptance` | `candidate.tarballDigest`; adopter acceptance |

`procedureId` is the gate's procedure or a variant of it (`AP-02:run-3`); a
bare name of another procedure refuses. An acceptance is
`{ kind: human|adopter, actor, recordedAt, evidenceName }` and names its own
hashed evidence entry; an adopter acceptance recorded by the operator refuses
with `acceptance-not-separate`. A gate that records automation and host
evidence (G14, G15, G16) refuses an acceptance with
`acceptance-not-expected`. `receiptRequirementsFor(gate)` answers this table
as data.

Synthetic, schema-valid receipts for each gate are under
`fixtures/obsidian/acceptance/receipts/`. They name no real host, person or
machine path, and validating them closes nothing.

## The command operations

`createSelectionContribution()` is a contribution `{ id, register({ operations }) }`
for the `obsidian` command's operation registry, the extension point the
runtime lays out. It registers:

- `selection resolve ID | persist ID [allow-empty] | show ID | list`
- `conflicts [ID]`
- `apply-policy create FILE | show | revoke`

The built-in `scope`, `policy` and `mode` names are reserved and untouched.
The contribution is loaded in the tests by passing it to the command runner.
The production loader reads regular `.mjs` modules from
`src/runtime/obsidian/contributions/`; the one-line module that would load
this contribution there is not part of this change, so the operations are not
yet on the shipped command.

## Package entry points

The published package declares these subpaths. Each is the module named, and
nothing under `scripts/obsidian/` ships.

| Subpath | Module |
| --- | --- |
| `@mnstry/atelier/obsidian` | `src/runtime/obsidian/index.mjs`: enablement, machine settings, engine, service lifecycle, production seams, app qualification |
| `@mnstry/atelier/obsidian/contracts` | `src/projection/obsidian/contracts.mjs`: contract validation, `selectScope`, note paths |
| `@mnstry/atelier/obsidian/materialize` | `prepareView`, settings, path registry |
| `@mnstry/atelier/obsidian/publication` | `publishView`, editor adapters, the exchange |
| `@mnstry/atelier/obsidian/recovery` | recovery store, journals, late-writer recheck |
| `@mnstry/atelier/obsidian/edits` | edit observation, arbitration, apply policy, source apply |
| `@mnstry/atelier/obsidian/proposals` | proposal queue, router and adapter |
| `@mnstry/atelier/obsidian/selection` | this document's module, `src/projection/obsidian/selection-ui/index.mjs` |

Every `contracts/atelier-obsidian-*.v1.schema.json` is exported under its own
path. The package root (`@mnstry/atelier`) exports nothing of the projection.
Names ending `ForOracleTests` are mutation controls for the test suite, not a
supported API. The whole surface is alpha and may change between prereleases.
What the tarball must and must not carry, and the package proof, are in
[release-engineering.md](release-engineering.md#obsidian-package-contents).

## Known limits

These are the limits known at this release. None is hidden behind a skipped
test reported as a pass.

- Windows: no atomic file exchange is known, so the publisher refuses with
  `exchange-unsupported-platform` and publishes nothing, and source apply
  refuses for the same reason. Selection, policy setup, `prepareView` and
  receipt validation work. The tests that publish are skipped there and say
  why.
- Linux: the exchange primitive was proven in a container on aarch64. The
  real-app suite (the publication interleavings and procedures AP-01 to AP-05)
  has not been run on Linux. x86_64 has not been run on any system.
- macOS: the exchange is a raw system call reached through the system perl. The
  perl binary is used only when uid 0 owns it and neither group nor others can
  write it; otherwise publication refuses with
  `exchange-interpreter-untrusted`. A machine without the stock perl cannot
  publish.
- App version: `MINIMUM_APP_VERSION` in
  `src/runtime/obsidian/app-capability.mjs` is 1.13.7, the only version the
  publication protocol was proven on. An older, unreadable or unknown version
  is `app-version-unsupported`. There is a floor and no ceiling: a newer app
  is admitted although the protocol depends on the view's undocumented
  `lastSavedData` field, and the protocol cases have not been re-run on any
  later release. The "App capability floor" row of
  [obsidian-contract.md](obsidian-contract.md) predates the floor and still
  says none is pinned.
- CRLF sources: the editor normalizes line endings when it saves, so a body
  edit made in the vault to a note whose source uses CRLF is more than a body
  replacement to the edit lens. It is preserved and becomes a proposal; it is
  never applied to the source, in manual or automatic mode. Edit such a note
  in its repository.
- An edit the byte lens cannot turn into source bytes (a new or changed link
  to another note of the vault, an edited front matter) becomes a copy-only
  proposal. No operation applies one.
- The selection, conflict and apply-policy operations of this module are not
  on the shipped `atelier obsidian` command; see "The command operations".
- Acceptance: a schema-valid receipt closes no gate, the package proof closes
  no gate, and no adopter acceptance is recorded in this repository.

## Mutation controls

The test suite proves each oracle can fail:

- `createFocusQueryBuilderForOracleTests` accepts a builder with escaping,
  quoting or joining switched off; the escaping oracle fails on exactly the
  cases that depend on the switched-off step.
- `createReceiptValidatorForOracleTests` accepts a rule table with one rule
  switched off; every negative case that depends on that rule then passes,
  and even that closes nothing.
