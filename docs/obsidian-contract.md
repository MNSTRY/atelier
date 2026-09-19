# Obsidian projection contract

This document freezes what later work receives from the contract and
feasibility track. It states what is proven, on what, and what is not. Nothing
here enables a feature; no publisher, service or command exists yet.

## Registered shapes

Eleven closed v1 schemas, `contracts/atelier-obsidian-<shape>.v1.schema.json`,
are registered in `src/contracts/corpus.mjs` with valid and invalid fixtures
under `fixtures/obsidian/contracts/<shape>/`. `src/projection/obsidian/contracts.mjs`
validates them and adds the refusals a schema cannot express.

| Shape | Portable | Purpose |
| --- | --- | --- |
| `corpus-profile` | yes | Workspace and repository identities, enrollment, audience |
| `scope` | yes | Mode and selector set-AST; an empty selection is valid and empty |
| `source-snapshot` | yes | Raw byte digests, graph pin, dirty state, single consistent read |
| `generation-manifest` | yes | Path map, byte regions, link inversion map, completeness |
| `publication-journal` | no | Conditional operations, partial transition, restart; protocol ID required |
| `service-state` | no | Literal loopback, port, runtime ID, PID, executable, consent |
| `edit-operation` | yes | Object identity, origin generation, base digest, idempotency key |
| `apply-policy` | no | `manual` or `automatic`; only `body-replacement` is an accepted edit class |
| `proposal-receipt` | yes | Repository-scoped store, adapter operation identity, dedupe outcome |
| `acceptance-receipt` | yes | Candidate identity, environment versions, evidence hashes, outcome |
| `ext-settings` | yes | The object under `ext["mnstry.atelier.obsidian"]` |

Portable shapes refuse absolute paths. `atelier-project-config.v1` is
unchanged: extension settings are validated by their own schema, and an
unknown extension key refuses in the adapter, not in the project validator.

## Selection

`selectScope({ canonicalSnapshot, profile, selector, expansion })` is the only
runtime entry point. Visibility fails closed: a node is selectable only when it
is explicitly eligible, its repository is enrolled and its audience is allowed.
Edges to a withheld endpoint are dropped. Absent and withheld identities are
reported together. Expansion requires an explicit depth and node budget,
proceeds in canonical-identity order and reports truncation. Relation types are
`related`, `supports`, `supersedes`, `implements`, `depends_on`, `evidences`,
`contradicts`, `belongs_to` and the derived `links_to`. Literal oracles and
refusals live in `fixtures/obsidian/contracts/oracles/scope-cases.json`.

## Note paths

`notes/<readable title>--<identity suffix>.md`. The suffix derives from the
stable repository identity plus node identity, starts at 12 hexadecimal
characters and lengthens on collision. Titles are Unicode-normalized, platform
reserved names are avoided, and case-folding collisions are detected. Duplicate
titles are allowed; duplicate canonical identities refuse; a title-only link
that matches more than one visible note refuses. Paths are allocated once per
workspace and reused by every view.

## Publication protocol `obsidian-cli-critical-section/v1`

The journal's `protocolId` names this protocol. A publisher may use it only
within the proven boundary below.

1. Stage the candidate beside the vault's volume and bind it by SHA-256.
2. Inside the app, in one synchronous step: refuse if any editor of the note in
   any window is unsaved or differs from the expected base; refuse if the bytes
   on disk differ from the expected base; refuse a staged file whose digest
   differs; atomically exchange the staged candidate with the note, so
   whatever occupied the path becomes the recovery file; update every open
   editor in one transaction and record the view as saved with that content.
   The app must not write the note as a result of publication.
3. Reply immediately. Record the outcome in the app. A caller whose reply is
   lost re-reads the outcome and never resends.
4. Re-check the recovery file after a quiet period: a program that held the
   note open before the exchange writes into it.
5. Commit the trusted manifest last. Until then the transition is reported as
   updating. A view converges to one verified generation; atomic visibility
   across notes is not claimed.

A refusal is always an acceptable outcome. A note being edited stays one
generation behind until its editor is clean.

### Proven boundary

macOS (Darwin 25, arm64) with Obsidian 1.13.7 (installer 1.12.7), CLI enabled,
no community plugin. Sixteen interleavings, 25 rounds for each racing case, in
four complete clean runs of the prototype in `experiments/obsidian-publication/`
at commits `34f5fab` and `c5142e7`. The receipts record those same trees under their
pre-sign-off identities `5930f85` and `93303ff`; the branch was rewritten only to add
sign-off trailers, with identical content. Receipt SHA-256 digests:

- `379992a6cc0e6c95581459412e8cab68d9b260a631fa891089613f120b40a67a`
- `63a5b69b203125b6099f2398d1ebddd0e4f3265a0401becbddff5e6d72fee16e`
- `95995051859e02042d648d1a0b513d86fa9f1d72d82359030e21858cdba5d959`
- `0984c35087ff91c0cc0d0f37f533eea1fc6c6380705491362eec98368f64fe01`

A fifth run aborted because the harness could not open a note after the
second-window case; no bytes were involved. The receipts are maintainer-held
and are not part of this repository.

### Receiving obligations for the production publisher

These are open. The publisher may not claim the protocol outside the proven
boundary until each is discharged with its own evidence.

| Obligation | State |
| --- | --- |
| Atomic exchange without an interpreter dependency | Open. The prototype reaches `renamex_np(RENAME_SWAP)` through the system Python, about 50 ms inside the critical section. |
| Linux (`renameat2` with `RENAME_EXCHANGE`) | Unproven |
| Windows | Unproven. No direct equivalent is known; not claimed. |
| App capability floor | The step that prevents an app write sets the view's undocumented `lastSavedData`. Refuse open notes when it is absent, pin a minimum app version, and re-run the cases on each app release before raising the ceiling. |
| Transport | CLI replies are occasionally lost while the app stays responsive. Serialize calls; make every call idempotent or outcome-recorded. |
| Timer throttling | A hidden app window delays the app's own autosave. Do not read that as a fault. |
| Unreproduced anomaly | One early run ended with typed text on disk but absent from the editor buffer. It did not recur in any later run. Keep the typing-race case in every qualification run and treat a recurrence as a failed gate. |
| Link-then-rename | Rejected. It leaves a window in which a concurrent replacement is destroyed. |
| App-driven save after replacement | Rejected. Observed losing an outside writer's bytes; kept as a negative control. |

Source application back into canonical files carries the same conditional-write
obligation against other source writers and is proven separately.
