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
path:/^<note path>$/ OR path:/^<note path>$/ ...
```

in the order of the selected set (canonical-id order). Each term is a regular
expression anchored at both ends, so it matches exactly one note: a plain
`path:` term matches any path that contains it, and with titles as names one
note's path can lie inside another's. In the term every regular-expression
character and the `/` delimiter is escaped with a backslash, and a space and
a double quote are written as `\x20` and `\x22`, so a path that itself
contains search operators (`tag:`, `-`, `OR`, parentheses) stays text. Paths
are NFC-normalized first. A persisted focus of the earlier query version
(`obsidian-graph-search-paths/v1`, quoted substring terms) is still read. A
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
The production loader reads regular `.mjs` modules from
`src/runtime/obsidian/contributions/`, and that directory ships three one-line
modules: `source-apply.mjs` (`apply`), `proposal-adapter.mjs` (`proposals`)
and `selection-ui.mjs` (`selection`, `conflicts`, `apply-policy`). The shipped
`atelier obsidian` command loads them and dispatches every registered
operation with the discipline of the built-ins: noninteractive, one JSON
document under `--json`, exit 2 with a typed code for a refusal or a usage
error, exit 3 when the operation ran and its answer is not success.
`atelier obsidian status` lists the registered operations under
`operations`; `atelier obsidian --help` names them.

A manual apply on a real workspace, from the shipped command:

```sh
atelier obsidian apply list --project atelier.project.json --json
atelier obsidian apply show EDIT --project atelier.project.json --json
atelier obsidian apply run EDIT --actor ID --project atelier.project.json --json
```

`--actor` is an option of `apply run` only; every other operation refuses it
as a usage error. `apply run` exits 0 when the edit was applied and 3 when it
ran and the answer is anything else; nothing is staged or committed either
way. A contribution registers which shared options it takes by naming them
under `options`; one that names none refuses `--actor` before it runs.

## Package entry points

The published package declares these subpaths. Each is the module named, and
nothing under `scripts/obsidian/` ships.

| Subpath | Module |
| --- | --- |
| `@mnstry/atelier/obsidian` | `src/runtime/obsidian/index.mjs`: enablement, machine settings, engine, service lifecycle, production seams, app qualification |
| `@mnstry/atelier/obsidian/contracts` | `src/projection/obsidian/contracts.mjs`: contract validation, `selectScope`, note paths |
| `@mnstry/atelier/obsidian/materialize` | `prepareView`, settings (including the plugin's files and entry), path registry |
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

## First vault: what to expect

This is the path an adopter walks on one machine. Every operation and flag
below is the shipped `atelier obsidian` usage text; `atelier obsidian --help`
prints it. There are three steps, and none of them is done by hand in
Obsidian.

1. Enable the projection in the project configuration. The member
   `ext["mnstry.atelier.obsidian"]` is an `atelier-obsidian-ext-settings/v1`
   document: `enabled: true`, `scopes` (each with a `scopeId`, a `mode` of
   `full`, `scoped` or `focus`, a `selector`, and for an expansion an explicit
   `depth` and `maxNodes`), and optionally `defaultScopeId`. A project without
   this member is `disabled (not-configured)` and nothing is published.
   `atelier obsidian scope list` shows what was declared.
2. Set the private machine settings. They live outside every repository and
   are never committed:
   - `atelier obsidian audience set me` lets "only you" into a view: every
     audience of a note but `sensitive`, which a vault takes only by name
     (`audience set me,sensitive`); `audience set A,B` names the audiences
     instead. No audience is admitted by default, so a view is empty until one
     is set; `audience clear` empties it again. Notes that carry no
     classification (no `kg` block) are withheld from every vault in this
     release, "only you" included; the decision already records whether they
     are shown, and a later change lets an "only you" vault show them. A list
     of audiences never shows them.
   - `atelier obsidian mode set manual` keeps every queued edit waiting for a
     person. `mode set automatic` is refused until an active automatic policy
     is installed.
   - `atelier obsidian policy digest FILE` prints the digest the policy file
     has to carry; `policy install FILE` installs it and leaves the mode
     unchanged; `policy revoke` returns the mode to `manual` and stops every
     later apply.
3. Open a view:
   `atelier obsidian open --scope ID --adapter=obsidian-cli`.
   That's it. Reaching the installed app is never a default, so
   `--adapter=obsidian-cli` is needed the first time; the workspace remembers
   it, and later runs need no flag. The first open of a workspace records who
   allowed the maintenance service to run: for a person at a terminal, the
   account's name; for a program, `--consent-actor ID`, which it must pass.
   Later opens reconnect and need neither. `atelier obsidian settings` shows
   what was remembered and how to change it. `open` starts or
   reconnects maintenance and asks it for a tick, makes Obsidian (version
   1.13.7 or later) know the view's vault as one of its vaults, opens it,
   publishes the view, verifies the vault by reading it back, and waits until
   the app answers for exactly that vault. It does this in whatever state
   Obsidian is in; see
   [What `open` does in each state of Obsidian](#what-open-does-in-each-state-of-obsidian).

The maintenance service can also be managed on its own:
`atelier obsidian service start [--consent-actor ID] [--adapter=obsidian-cli]`,
`service status` and `service stop`; `service unit --print` prints the login
item that `service unit --install` would write, and installs nothing (see
[Start at login](#start-at-login)). The flags are needed only until the
workspace remembers them, as for `open`.

### What this machine remembers

A workspace's machine settings (`atelier-obsidian-machine-settings/v2`, owner
only, under the private data root, never in a repository) hold what a person
decided once, so no later run asks again or has to be told again. Each
decision is null until it is made, and otherwise records what was decided,
when, by whom when that is known (an actor identifier), and how: answered at
a terminal (`question`), given on the command line (`command`), taken as the
defaults (`defaults`), or carried over from an earlier release (`v1`).

| Decision | Holds | Made today by |
| --- | --- | --- |
| `audience` | `only-you` or `custom`, and whether notes that carry no classification are `shown` or `withheld`. Only `only-you` may show them; a list of audiences always withholds them. The admitted list stays in `audienceAllow`, the engine's audience input | `audience set me` (only you) or `audience set A,B` / `audience clear`; each withholds unclassified notes for now |
| `location` | the absolute folder that holds this workspace's vaults | not yet: the first-run flow |
| `loginItem` | `on` or `off` | `service unit --install` (on); `service unit --remove` and `uninstall` (off) |
| `adapter` | `obsidian-cli` | `--adapter=obsidian-cli` given to `open`, `service start` or `service unit --install` |

Who allowed the maintenance service is not a second copy here: it stays the
consent the service reads from its own settings. `atelier obsidian settings`
shows all of it, and how each answer is changed.

Releases up to 0.2.0-alpha.12 wrote `atelier-obsidian-machine-settings/v1`.
Such a file is read as the v2 document it stands for, an audience list set
with it becoming that person's decision, and stays v1 on disk until the next
write, which writes v2. A release that knows only v1 refuses a v2 file as
`invalid-machine-settings`: after an upgrade, a maintenance service that
still runs the earlier release fails its ticks until it is replaced, which
`atelier obsidian open` and `atelier obsidian service start` do.

### Start at login

Without a login item the vault is complete after a restart, but nothing keeps
it fresh until the next `open`. A login item starts the maintenance service
when you log in:

```sh
atelier obsidian service unit --install [--consent-actor ID] [--adapter=obsidian-cli]
atelier obsidian service unit --print    # what --install writes; writes nothing
atelier obsidian service unit --remove
atelier obsidian uninstall
```

- On macOS it is a launchd agent,
  `~/Library/LaunchAgents/ai.mnstry.atelier.<project>.<workspace-id>.plist`.
  macOS says "Background Items Added" and lists it as "node" under System
  Settings → General → Login Items & Extensions, because there is no app to
  name it after. Switched off there, it stays off: `status` reports
  `installed, switched off in System Settings`, and `open` starts the service
  for that session only.
- On Linux it is a systemd user unit,
  `~/.config/systemd/user/atelier-obsidian-<workspace-id>.service`
  (`$XDG_CONFIG_HOME` when set), enabled with `systemctl --user`. Where no
  user instance of systemd answers (WSL, a container), the answer is
  `login-item-unavailable` and nothing is left behind.
- Windows is not offered (`startup-platform-unqualified`), as publication
  itself is refused there.

It runs the package installed in the project
(`<project>/node_modules/@mnstry/atelier/…`, named by that path, so the next
start runs whatever release the project has installed then), with the Node
that installed it and the search path you had, in the root folder. Run from
`npx` in a project that has no package installed, it refuses with
`login-item-needs-installed-package`: install `@mnstry/atelier` in the project
first. Installing records that you allowed the service to run at login (the
consent then covers startup): `--consent-actor ID` names who allows it; for a
person at a terminal, the actor already recorded for this workspace, or else
the account's name. A program that passes no `--consent-actor` for a
workspace whose consent covers the service alone is refused
(`startup-consent-required`). The answer is remembered as the `loginItem`
decision. `--remove` takes the consent back to the service alone, removes the
item, and starts the service again for this session only, as a process of its
own (with the adapter given or remembered; otherwise the next `open` starts
it). Each workspace has its own login item, port, log and consent, and
projects may pin different releases; `launchctl list | grep ai.mnstry.atelier`
lists every one on a Mac.

Once a login item is installed, the service is started through it: `service
start`, `open` and the replacement of an outdated service ask launchd or
systemd to start it, never start a second one beside it, and accept only the
service that proves itself with the installed entry. When the unit differs from
what would be written now (the Node it names was removed, say), the next start
writes it again and says `login item refreshed`. A refusal of the service at
login (another service already runs, or the consent does not cover startup)
ends the process cleanly, so it is not retried every minute, and `status` says
`the login item did not start the service: <code>` with the next step. A crash
is restarted after a minute.

`uninstall` removes the login item and stops the service. It keeps the vaults,
the private state, the project file and Obsidian's vault list as they are, and
prints where each is. It does not start the service again.

After an upgrade of Atelier, a maintenance service started earlier still runs
the earlier release. One the login item started notices it: after each tick
it compares the package on disk (read through the path the item names, so a
re-pointed link or a `file:` install counts) with the release it started
with, and when they differ it exits after that tick with code 75, and its
service manager starts the new release within a minute. Otherwise `open` and
`service start` replace it: when the service of this workspace proves itself
Atelier's own but runs an earlier release than the installed one (its record
names the release it runs: the package version and a digest of its modules;
an earlier version, the same version with other modules, or no release
named), or refuses a tick that names a view as releases up to 0.2.0-alpha.11
do, they stop it as `service stop` would and start the installed release under
the consent already recorded (through the login item when there is one), and
say `service: restarted (outdated)`. The installed release is read from the
package of the entry that would be started, so with a login item it is the
project's own package. A service of a later release is never replaced by an
earlier one, so two installations used on one workspace (a global and a
project-local one, say) do not replace each other's service on every open:
`open` answers `service-unavailable` / `service-other-release`, and `service
start` answers that it runs, with `release: later`; run `atelier obsidian
service stop`, then open again, or open with the later release. A service in a
long tick is not stopped (`open` answers `busy`), and a listener that does not
prove itself this workspace's service is never touched.

The first time Obsidian opens a view's vault it asks "Do you trust the author
of this vault?", because every vault Atelier publishes carries Atelier's own
plugin. "Trust author and enable plugins" turns it on: a status bar item then
says whether the view is current, updating, held for an edit you made, stale,
or whether the maintenance service does not answer, and "Atelier: show status"
says why. "Browse vault in Restricted Mode" keeps every community plugin off
in that vault, and nothing else changes: maintenance, `open` and `status` work
without the plugin, as they always did. Obsidian keeps the answer per vault in
its own storage and asks again the next time until the vault is trusted or
restricted mode is switched on for good in its settings. Turning the plugin
off in a vault, or uninstalling it there, is respected from then on;
`atelier obsidian plugin on --scope ID` brings it back. What the plugin does
and never does is in [obsidian-plugin.md](obsidian-plugin.md).

`open` and `status` answer with a freshness state, not a promise. `current`
means the vault is the present generation, verified by read-back, and the app
has it open. `updating` means maintenance is publishing or has not finished.
`stale-readable` means a last good vault exists but is not proven current;
`open --allow-stale` opens it as it is. `not-prepared` means no generation has
been published yet. `held-for-your-edit` means a note you edited is preserved
and the view is not republished over it. The remaining outcomes (`indexing`,
`publisher-conflict`, `app-missing`, `app-version-unsupported`,
`app-cli-unavailable`, `launch-failed`, `service-unavailable`, `busy`,
`disabled`) each name what to do next, and exit code 3 says the answer is not
success. Both also report Atelier's plugin for each view, under `plugin`:
present while it holds the vault open in the app, with the app and plugin
versions, or not present with the reason.

Edits made in the vault are preserved before anything is republished. A body
replacement is held as a pending edit; under manual mode it reaches its source
file only through `atelier obsidian apply run EDIT [--actor ID]`, after
`apply list` and `apply show EDIT` named it. An applied edit changes the source
file and nothing is staged or committed. Under automatic mode the engine
applies body replacements itself under the installed policy, and revocation is
read again before every one. An edit that is not a body replacement, such as a
new or changed link to another note or an edited front matter, becomes a
copy-only proposal in the owning repository's proposal store; `atelier obsidian
proposals list` and `proposals show OPERATION` read them, and nothing applies
one. A body edit to a note whose source uses CRLF line endings is also a
proposal, never an apply, because the app normalizes line endings on save.

The vault itself lives under the private data root, outside every repository:
`~/Library/Application Support/Atelier` on macOS, `$XDG_DATA_HOME/atelier`
(else `~/.local/share/atelier`) on Linux and `%LOCALAPPDATA%\Atelier` on
Windows, under `obsidian/<workspace-id>/`. `--data-root DIR` names another
absolute directory. Private state inside an enrolled repository is refused.
Publication is proven on macOS arm64 only and is refused on Windows; see
[Known limits](#known-limits).

### What `open` does in each state of Obsidian

Obsidian opens a vault from a link only when the folder is in its own vault
list, the `vaults` of `obsidian.json` in its user-data directory. `open` puts
the view's vault there first, and never asks a person to open a folder by
hand. It then names the vault by its id (`obsidian://open?vault=<id>`), never
by path where the id reaches it first: a path is matched against the list by
string prefix, so a link for a note under `/A/strategy-lab` can open the
listed vault `/A/strategy`. When another vault's folder is named like the id,
or the id is unusual, the vault's own path is used, which the app matches
exactly because the folder is listed.

- **Obsidian runs and answers its command line (any vault is open).** `open`
  reads the app's vault list through its command line. A vault the app does
  not list is added and opened in a new window through the app itself (it
  writes its own settings), and read back from its list. `open`
  then waits, bounded, until the app answers for exactly this vault, and asks
  maintenance for the view again: the publication runs through the app, which
  now holds the vault, with every editor check of the publication protocol.
  Obsidian does not have to be quit.
- **Obsidian is not running.** The view is published on the path with no app,
  as before. `open` then adds the vault to the app's settings file (see
  [Obsidian's vault list](obsidian-contract.md#obsidians-vault-list) for
  exactly when and how that one file is written, marked to reopen) and starts
  Obsidian plainly, with no link: an Obsidian started with a link opens only
  that vault and drops the reopen flag of every other one, so your other
  vaults would not come back the next time you start it. Started plainly, it
  reopens every vault it had open, this one included, and once its command
  line answers (the app itself, not the tool's "unable to find Obsidian")
  `open` hands it the vault's link through that tool, never through the
  operating system. On Linux a plain start is not
  qualified yet, and Obsidian is started with the link (the other vaults'
  reopen marks are lost there; a known limit).
  An Obsidian that never ran on this account has no settings file yet, and
  `open` does not create one: start Obsidian once, then open again.
- **Obsidian runs with no vault open.** Its command line then answers every
  command with "Vault not found.", so nothing can be asked of it, and its
  settings file belongs to the running app, so it is only read. A vault the
  app already lists is opened by path and published through the app as
  above. A vault it does not list yet is answered as outcome
  `app-version-unsupported` with reason `no-vault-open`: open any vault in
  Obsidian, or quit it, and open again. This is the one state of a running
  Obsidian that `open` cannot get through alone.
- **Obsidian's command line is turned off** (the default of a new
  installation). It then answers every command with "Command line interface
  is not enabled", and only a link reaches it. With Obsidian running, `open`
  adds and launches nothing. With Obsidian quit, `open` adds the vault to its
  settings and starts it, and Obsidian opens the vault. Either way `open` then
  answers `app-cli-unavailable` with reason `cli-turned-off` and says where to
  turn it on: Settings > General > Advanced > Command line interface.
  Publishing into a vault Obsidian holds needs it until Atelier's plugin takes
  over that part.

Only `open` adds a vault to Obsidian: the maintenance service never does, so
it never opens a window nobody asked for. A declared view that was never
opened is published while Obsidian is quit, and `open --scope ID` adds it.

In no state does `open` add a view's vault inside a folder Obsidian already
lists as a vault (your home folder, say): that vault would show the view's
notes too, and a command-line call run in the view's folder would reach it.
`open` answers `launch-failed` with reason `vault-inside-another-vault`:
remove that vault from Obsidian's vault list, or keep Atelier's data root
outside that folder. A view's vault that Obsidian lists already, below such a
vault, is reached by its id instead (see "Which window answers" in
[Known limits](#known-limits)).

Obsidian can list one folder more than once, under another letter case or
through a link, and then open it in one window per entry. Each of those
windows holds the view's vault, and a publication coordinates with one window
only, so none is made: the view reports `publisher-conflict` with reason
`vault-open-in-several-windows`, and `open` answers the same, names the
entries (`open in Obsidian as: …`; `duplicates` in JSON) and launches nothing.
Remove the extra entries from Obsidian's vault list and open again. Closing
the extra windows is not enough: Obsidian keeps the last window it closed
marked open, so two entries can stay marked open with one window showing, and
the view stays refused until the list names the folder once.
While one entry of the folder has a window, `open` reaches only that one and
never opens another entry of the same folder beside it.

The publisher still writes into a vault only when it can coordinate with every
Obsidian that may hold it, or when the process table shows, positively, that
none runs. Otherwise it stops, and the view reports `publisher-conflict` with
reason `editor-uncoordinated`. That reason has several causes, and the report
does not say which: Obsidian runs without this vault open, or with it open but
its command line did not answer; the process table could not be read, or on
Linux shows an app that runs on a system Electron, which may be Obsidian; the
app's version was not checked when the publication began; or an app started
while the view was being published with the app closed. `status` gives
`atelier obsidian open` as the next step (it adds the vault to Obsidian and
publishes through it), or quitting Obsidian (on Linux, also any app that runs
on a system Electron). When `open` itself already did that and the
publication still stopped, it says to quit Obsidian and open again.

The tick `open` asks for prepares and publishes its view once more, whatever
state the view is in. A view whose last publication did not settle (refused,
stale or still updating) is also tried again without waiting for a change: as
soon as the app looks different (it quit or started, or opened or closed a
vault in its list), and otherwise after a delay that starts at 30 seconds and
doubles per attempt, up to the full reconciliation every five minutes. What
the app looks like is read from the process table and the app's vault list
alone: maintenance runs nothing in Obsidian to find out, and asks it for its
version only when a view is about to be published, without blocking.

While Atelier's plugin holds the view's vault open in the app and the command
line gives no version (as it answers while a vault is still loading), the
version the plugin reports stands in (reason `plugin-reported`); a version the
command line gives always decides, and while the process table shows no app
running, a plugin's report counts for nothing. `open` then asks the command
line nothing: a vault the app's settings file lists is opened by path, and one
it does not show is answered as `app-cli-unavailable` with reason
`vault-open-cli-silent` (the app has the vault open; make sure its
command-line interface is turned on). So is a listed vault the command line
does not answer for once it is opened, while only the plugin reports the
version: `open` says so at once instead of waiting for the app.

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
  later release. See the "App capability floor" row of
  [obsidian-contract.md](obsidian-contract.md). An app that was not running
  when an adapter was qualified had no version to check, and neither had an
  app that was not found. Such an answer is never reused, and the adapter
  built on it does not coordinate with any app it then finds running, and
  asks it nothing. That publication stops as `publisher-conflict` with reason
  `editor-uncoordinated`, and the next publication asks again and reads the
  version. A view that stopped is tried again on the next tick `open` asks
  for, as soon as the app looks different, and otherwise after a delay that
  starts at 30 seconds and doubles, up to the full reconciliation every five
  minutes. A tick `open` asks for never reuses a remembered app answer.
- Install location (macOS): the app is found only at
  `/Applications/Obsidian.app`, and its command-line tool only inside it. An
  Obsidian installed elsewhere, or a renamed bundle, is `app-missing`.
  Nothing is published through it, publication waits while it runs (the
  process probe still sees it), and `open` answers `app-missing` and cannot
  start it. With it quit, the view is published on the path with no app.
- No vault open: while Obsidian runs with no vault open, its command-line tool
  answers every command, `version` included, with `Vault not found.`. The
  version floor cannot be checked then, so the app does not qualify:
  `app-version-unsupported` with reason `no-vault-open`, and nothing is
  published through the app. `status` (under `service.app`) and `open` say what
  to do: open any vault in Obsidian, or quit Obsidian. With the app quit,
  maintenance publishes on its own path again; with a vault open, it reads
  the version again on a later tick. While the app runs with no vault open,
  `open` has it open a vault only when its list already knows that vault,
  by path; one it does not know cannot be added then (see below). After its
  own launch `open` waits, bounded, while the app is still opening the vault;
  an app whose vault window is still loading answers a command with `Error:
  Command "…" not found`, which is read as not up yet, never as a version.
- Obsidian's settings file: `open` adds a view's vault to the app's own list,
  `obsidian.json` in its user-data directory: `~/Library/Application
  Support/obsidian` on macOS and `$XDG_CONFIG_HOME/obsidian` (else
  `~/.config/obsidian`) on Linux. It is written only while the process table
  shows, positively, that no Obsidian runs, only when Obsidian created it
  before, and with a backup beside it; see
  [Obsidian's vault list](obsidian-contract.md#obsidians-vault-list). A
  Flatpak or snap build keeps its list inside its sandbox and never reads that
  file. Which build is in use is read from which vault list was written last
  (every build rewrites its own when a vault window opens or closes), and only
  when no build wrote one from its installation; for a Flatpak or snap build
  the file is then neither read nor written: `open` answers
  `obsidian-sandboxed` and says to start Obsidian with any vault open, then
  open again, and adds the vault through the app. On Windows no location is
  known, and `open` adds the vault through the app in the same way.
- Recent items: adding a vault through the running app is Obsidian's own
  "open folder as vault", which also puts the vault's folder in the operating
  system's recently used documents (Recent Items on macOS).
- Which window answers: Obsidian answers a command-line call that names a
  vault (`vault=<id>` first) in that vault's window; any other call in the
  window of the first vault in its list whose folder is the tool's working
  directory or contains it, and otherwise in the vault window that had focus
  last. A vault that takes a call is opened when it is closed. Calls about a
  vault therefore name its id; only when that id would name another vault
  first (one whose folder has the id as its name) do they run inside its
  folder instead, and not at all when a vault listed before it at a folder
  above it (your home folder, say) would take them there. The vault root is
  taken in the spelling the file system stores, so a data root given in
  another letter case on macOS changes nothing. Publication calls do this
  only while the app's list shows the view's vault open, and run in a
  directory that is no vault otherwise. So maintenance never reopens a vault
  window you closed while Obsidian keeps running, and never reaches another
  vault: publication then stops as `publisher-conflict` until `atelier
  obsidian open` opens the vault again or Obsidian quits.
- Detecting the app: the process table is read with `ps -A -o comm=`
  (`pid=,comm=` on Linux), and the app is recognised by the executable a
  process runs, never by its arguments, so a path argument that contains an
  `obsidian` directory (the maintenance service itself, anything under the
  private data root) is not the app. A `ps` that has not answered within five
  seconds is killed and the reading is `unknown`, which is treated as a
  running app.
  - macOS: the executable `Obsidian` and the bundle's `Obsidian Helper`
    processes count, in any directory. An app started through a differently
    named link shows that name for its main process; its `Obsidian Helper`
    processes still count.
  - Linux: a process named `obsidian` counts, which covers the .deb, snap,
    AppImage and Flatpak builds. Linux names a process after the path it was
    started through, so for a name that is not recognised the probe reads
    the executable `/proc/<pid>/exe` resolves to: an app started through a
    link or launcher named `obs`, or a child started through
    `/proc/self/exe` whose executable is readable, still counts. A process
    whose executable this user may not read (another user's, or one of this
    user's that hides it from tracing, such as ssh-agent) or that exited
    meanwhile is judged by its name alone. Any other read failure, or a
    table in which no executable resolves at all, is `unknown`. A
    distribution that runs the app under a system Electron shows only
    `electron`: the table is then `unknown`, so publication through the
    app-free path waits until no such process runs.
  - The command-line tool (`obsidian-cli`) is a client of the app and is not
    counted. An app packaged under another executable name, an app on
    another machine and an app that starts after a reading are not seen; see
    "The path with no app" in [obsidian-contract.md](obsidian-contract.md).
- The app-free path is live: before 0.2.0-alpha.10 the probe always found
  Atelier's own service, so publication never took the path with no app.
  From 0.2.0-alpha.10 it does, whenever the process table shows, positively,
  that no Obsidian runs. It applies only then. The table is read at path
  selection, again immediately before the first note, and again whenever two
  seconds have passed. An app that starts between two readings is not seen
  for at most two seconds plus one note's publication, and in that window a
  note is exchanged with no editor check. Bytes on disk stay protected by the
  on-disk comparison and the exchange. An unsaved buffer in the newly started
  app does not: the app applies its own external-modification merge, which
  can drop overlapping edits. Once a reading shows an app, every remaining
  note refuses. To avoid the window, do not start Obsidian while a view is
  being published with the app closed.
- CRLF sources: the editor normalizes line endings when it saves, so a body
  edit made in the vault to a note whose source uses CRLF is more than a body
  replacement to the edit lens. It is preserved and becomes a proposal; it is
  never applied to the source, in manual or automatic mode. Edit such a note
  in its repository.
- An edit the byte lens cannot turn into source bytes (a new or changed link
  to another note of the vault, an edited front matter) becomes a copy-only
  proposal. No operation applies one.
- Atelier's plugin (phase 1) reports presence and status and decides
  nothing: publication still coordinates with the app through its
  command-line tool, which must be enabled, and the plugin only supplies the
  app version where that tool gives none. A person who turns the plugin off
  in a vault, or uninstalls it there, is followed: its entry is not added
  back and a deleted folder is not made again until the person turns it on
  in Obsidian's settings or runs
  `atelier obsidian plugin on --scope ID`. Plugin files are never removed from
  a vault. See [obsidian-plugin.md](obsidian-plugin.md).
- Login items: the tests run the launchd and systemd managers' own code
  against stand-ins that answer as launchctl and systemctl do, and never
  against a real session. What `launchctl print-disabled` says for an item
  switched off in System Settings, and the exit statuses read from
  `launchctl` and `systemctl`, are the documented ones and are not yet
  confirmed on a host. A unit whose program cannot be loaded at all (the
  project's package was removed) is restarted by its manager once a minute,
  and each attempt adds a few lines to `state/service/login-item.log`, which
  nothing bounds: `service unit --remove` or `uninstall` ends it. An upgrade
  in the moment between a service's start and the first reading of its release
  is not noticed until the next change.
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
- `openScopeForOracleTests` with an `OPENING_PRIMITIVES.keptByApp` that
  never holds: an open with Obsidian running without the vault reports the
  publisher conflict it could have cleared, and the first-open oracle fails.
- `createMaintenanceEngineForOracleTests` with an
  `ENGINE_PRIMITIVES.isRetryDue` that never holds: a refused view waits for
  the full reconciliation, and the retry oracle fails.
