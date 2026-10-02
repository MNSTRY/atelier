# Personal workspace composition

This module composes enrolled local repositories and private interpretation in
one Atelier graph. The person supplies a private home outside every enrolled
repository. Shared source files are never changed. Private authored inputs change
only through an explicit, confirmed restore (see below).
This is a local composition module. Host integration and release require
separate acceptance.

A manifest records enrollment, repository identity, and folder bindings. An
overlay contains annotations, connections, collections, saved repository
selections, and preferences. These closed documents grant no consent,
permission, policy exception, disclosure, or effect authority. Valid graph
metadata does not constrain a tool that can directly read the filesystem.

## Files and API

The caller passes `personalHome` explicitly; the module does not discover it
from the environment or the current directory. The caller owns these files:

- `atelier.personal.json`: `atelier-personal-workspace-manifest@v1`.
- `atelier.overlay.json`: `atelier-personal-workspace-overlay@v1`.

Both contracts live in `contracts/`. Paths in the private manifest are absolute
canonical paths. Bindings must not overlap; enrolled roots must not nest.
Each repo has a `repoId`, `root`, recorded `remote` (or `null`), and `enrolled`.
Overlay references are closed `{ repoId, nodeId }` pairs. Repository IDs are
stable local enrollment keys; matching a recorded remote is an offline change
check, not proof of upstream membership or provider identity.

The module entrypoint is `src/personal-workspace/index.mjs`; its public package
subpath is `@mnstry/atelier/personal-workspace`. The API consists of fifteen exports:

- `MANIFEST_SCHEMA` and `OVERLAY_SCHEMA`.
- `PersonalWorkspaceRefusal`.
- `loadPersonalManifest` and `loadPersonalOverlay`.
- `resolvePersonalWorkspace`.
- `planPersonalGeneration`, `materializePersonalGeneration`, and
  `composePersonalWorkspace`.
- `selectPersonalGeneration`, `selectionConfirmDigest`, and
  `readPersonalSelection`.
- `inventoryPersonalHome`.
- `planPersonalRestore` and `restorePersonalInputs`.

Package registration and installed-consumer qualification are separate from
module source qualification. A registered package can be used as follows:

```js
import {
  resolvePersonalWorkspace,
  planPersonalGeneration,
  materializePersonalGeneration,
  composePersonalWorkspace,
} from '@mnstry/atelier/personal-workspace'

const resolved = resolvePersonalWorkspace({ folder, personalHome })
if (resolved.status === 'resolved') {
  const plan = planPersonalGeneration(resolved)
  const written = materializePersonalGeneration(plan, { personalHome })
  const result = composePersonalWorkspace({
    personalHome,
    generationId: written.generationId,
  })
}
```

`loadPersonalManifest` and `loadPersonalOverlay` read and validate private
files. `resolvePersonalWorkspace` returns `resolved` or `none`; conflicting
bindings refuse. `planPersonalGeneration` is pure and accepts only a resolved
input from this module. These operations write nothing. Failures throw
`PersonalWorkspaceRefusal`, with a stable `code` and a sanitized message.
No paths, source excerpts, or graph diagnostic text are included in refusals.

Of the composition operations, only `materializePersonalGeneration` writes. (The
selection and restore operations below write their own records and, on an explicit
confirmed restore, the authored inputs.) It creates
`generations/<generationId>/` under the explicit private home. The id is a
digest of canonical schema-tagged manifest and overlay inputs, declared
stable references, and the canonical private-home location. Moving that home
produces a new generation; historical generations remain untouched. Compose
of a generation recording the old home refuses `generation-relocated`. Planning does not pretend to discover source nodes.
Materialization writes exclusive files to a private staging directory, fsyncs
them, verifies references through the canonical graph, and atomically renames
the generation. A failed reference check discards only that attempt's staging.
An interruption can leave a reported `stale-staging` directory; the module
never prunes it or historical generations automatically.

A committed generation contains `inputs.json`, `atelier.project.json`,
`shared/atelier.project.json` for independent shared-source comparison, private
Markdown under `overlay/`, and `generation.json` written last. The latter lists
every other file and its digest. The whole inventory is checked; additional,
missing, edited, or symlinked files refuse. Identical existing generations are
reused; conflicting ones refuse `generation-overwrite-refused`. There is no
mutable current pointer and no in-place schema migration.

Compose revalidates current authored inputs, roots, identity, the generation,
and every `(repoId, nodeId)` before returning a graph. Removing enrollment
while retaining references refuses `retained-removed-reference` before
planning. Missing or misowned IDs refuse `stale-reference`; path-derived IDs refuse
`unstable-reference`. Targets must declare an explicit `kg.id`. A source file
rename preserves references when its stable node ID stays the same. Changed
inputs refuse use of an old generation; old bytes remain untouched. Authored
note retention and recipient export are outside this module.

## Selection, inventory and restore

A generation is eligible only while it composes against the current authored
inputs, roots and enrollment, so at most one generation is eligible at a time.
These operations record a person's choices about that, and write only under the
private home. They never delete authored inputs, generations or records; they
remove only their own temporary files. Every failure is a
`PersonalWorkspaceRefusal` with a stable code and no path.

- `selectPersonalGeneration({ personalHome, generationId, confirm })` records an
  explicit choice of the eligible generation. `confirm` is
  `selectionConfirmDigest({ generationId, previous })`, computed over the head
  that `readPersonalSelection` returns, so a choice shown against an older history
  does not apply. Selections are append-only, numbered, hash-chained records under
  `selections/`, each written completely before it is published, so a crash leaves
  only a temporary file. Concurrent selections refuse `selection-concurrent`. An
  ineligible generation refuses with its composition code, such as
  `stale-generation`.
- `readPersonalSelection({ personalHome })` returns the current selection and
  whether it is still eligible. A selection never keeps a generation eligible after
  its inputs, roots or enrollment change. A change to any record other than the
  last, or a reordered or renumbered history, refuses `selection-history-corrupt`.
  Deleting or rewriting the last record cannot be detected from the history
  alone: it changes the returned `head`, so a host that needs that keeps the head
  it last observed and compares it.
- `inventoryPersonalHome({ personalHome })` lists, for review before any deletion
  the person chooses: the authored files, each generation with its eligibility,
  interrupted staging directories, every selection and restore record, and any
  leftover temporary file, with sizes and digests. It is read-only.
- `planPersonalRestore({ personalHome, generationId })` plans restoring the
  authored manifest and overlay that an earlier generation recorded. The
  generation's `inputs.json` must reproduce its id from this private home, or the
  plan refuses `generation-corrupt`; an oversized record refuses
  `generation-inputs-too-large`. **A restore never widens enrollment or
  bindings:** a repository the target enrolls must be enrolled now with the same
  root and remote, and every binding it declares must be declared now. Otherwise
  it refuses `rollback-readmits-repository` or `rollback-identity-changed` (with
  the repository ids) or `rollback-readds-binding`, before any write.
  Re-admission is the person's fresh edit; afterwards the same restore is
  evaluated normally. The plan carries a summary of the enrollment and bindings it
  removes and whether each file changes. A restore that only narrows proceeds.
- `restorePersonalInputs(plan, { personalHome, confirm: plan.confirm })` accepts
  only a plan returned by `planPersonalRestore`. It reads the current authored
  files once, validates those exact bytes, requires them to match the plan, and
  re-runs the widening check on them; inputs changed after planning refuse
  `authored-input-changed`. It keeps those exact bytes in an append-only record
  under `restores/`, then stages, validates and renames each restored file,
  re-checking just before each rename that the file is still the one it read. A
  rerun after an interruption completes the files not yet restored. A restore does
  not change the selection; selecting the restored generation is the person's next
  explicit act.

Retention follows the person's decision: withdrawn material stops being eligible
immediately, while authored history, generations and these records stay until the
person reviews the inventory and explicitly confirms deletion. No deletion
operation is provided yet.

## Canonical graph and offline checks

Composition uses the existing supported project loader, project validation,
and canonical graph builder. Generated project paths are explicit and
relative to the generation, with a conservative private read boundary; this
never upgrades source authority. The graph includes shared source nodes and
private interpretation nodes, with declared `related` edges. Private aliases
and preferences do not rewrite source titles, facts, or classifications.
Private nodes are excluded from ordinary Markdown link scanning and targeting;
only their explicitly declared stable references create edges. A second build
through the same canonical API uses a generated config containing only shared
roots, in the private generation. Shared nodes, edges, and link diagnostics must
match the composed result, or `shared-facts-changed` refuses publication/output. Complex tags
round-trip through block-list frontmatter. Blank, padded, and duplicate tags
refuse `malformed-input` instead of being silently normalized. Untagged private
nodes receive the
fixed `personal-interpretation` tag instead of inferred shared-domain tags.
Generated scalars escape Unicode line separators. Composition verifies every private
node’s planned identity, title, classification, explicit ID, type, status, audience,
tags, relations, and declared edges; a mismatch refuses `overlay-semantics-mismatch`.
Saved views are stored selections, not executable queries or policy rules.

Bounded local Git reads are required for identity and the canonical ignore
census. No network, provider lookup, `gh`, Git fetch, hook execution, service,
database, credential operation, or shell is requested. The module refuses
ambient `GIT_*` variables, fsmonitor helpers in local, global, XDG, or system
configuration, and failed independent
ignore listings. It checks that ignored sources never enter the graph even
when the shared builder's ignore call fails open, including ignored sidecars.
An enrolled root must equal its Git worktree top level; a nested directory
refuses `repo-root-mismatch` before planning or writes.
Every module-owned Git probe disables fsmonitor. Its configuration probe uses
Git boolean-or-string typing so a valueless enabled setting is refused too.
On macOS, ignored-path comparisons normalize both Git and census spellings to
NFC, including sidecar paths and parent directories. Observed remote URLs are
sanitized before comparison; the authored identity must already be sanitized,
without user information, query parameters, or fragments. Credential-bearing
authored remote values refuse `remote-credentials-refused` and are never copied
to generations or returned observations. Project inputs have pinned
arguments and environment, no ambient overlays, and no path discovery.

Private generation roots must be outside every worktree, verified by ancestor
`.git` checks and a local Git probe. The overlay census must equal exactly the
materialized overlay documents. Private roots must be owned by the current
POSIX user and not writable by others. All roots, ancestors, and authored files
must be free of symlinks. Windows private-root qualification is not implemented
and refuses `private-root-unverifiable`.

Current source evidence hashes regular files with 64 KiB reads rather than whole
asset allocations. Unavailable or changing file evidence refuses `source-read-failed`
without returning local paths. This observation is not a transactional source snapshot.

## Evidence and limits

The tests use invented temporary repositories and private homes. They verify
canonical nodes and edges, unchanged source trees and authored inputs,
determinism, removal, identity replacement, closed schemas, ignore failure,
unsafe roots, corrupted generations, and interrupted writes. This proves the
bounded module behavior, not installed host enforcement or human acceptance.

`sourceRevisions` reports digests observed from the current canonical census
after the build. Shared repositories remain live, mutable files: this is not a
transactional snapshot or an upstream Git revision. Concurrent writers can
change source bytes between graph reads. Consumers requiring an immutable
source snapshot must supply one through a separately governed host boundary.
Similarly, checks in this module are not an OS sandbox, defense against a
hostile filesystem owner, or protection from concurrent root replacement.

The returned coverage is `manifest-only`, with `enforcement: none` for direct
filesystem access, disclosure, effects, and host sandboxing. A harness with
repository access still needs the applicable host and runtime boundaries.
Integration, independent review, hosted CI, publication, installation,
consent/effect enforcement, and acceptance are separate gates.
