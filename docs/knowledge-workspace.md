# Knowledge workspaces and guided coauthoring

The experimental knowledge workspace connects five reusable dashboards to the
same source-bound private drafts used by people and agents. Human planning sets
the task, assisted drafting works from evidence, and human review determines
what may enter the canonical plan or become an action.

Start with one consequential question, a permitted source, and a reviewer.
Expand when a demonstrated task needs more knowledge. Graph size is not the
success measure.

## Open a workspace

```sh
atelier init --template knowledge-workspace --target my-workspace
cd my-workspace
git init
atelier knowledge check
atelier graph
atelier build
atelier dev --knowledge
```

Open `/knowledge` at the printed loopback address. This uses the existing
foreground sidecar and its manifest, host, origin, and nonce controls. Stop it
with Ctrl-C; restart the same command to resume saved sessions. `--port=0`
chooses a free port. It installs no background or operating-system service.
The template is an invented equipment library. Replace its purpose, roles,
sources, concepts, relations, and questions before operational use.

An existing enrolled project needs a valid `knowledge-plan.json` beside its
project configuration. Use the schema and guide in
[knowledge setup](knowledge-setup.md). Rebuild the projection when its source
changes. The knowledge panels read the current enrolled graph on request; the
ordinary projection remains the last explicitly built projection.

The sidecar enables these routes only with `--knowledge`. Its new reads are
`/api/knowledge/dashboard`, `context`, `sessions`, and `read`; mutations are
`start`, `event`, and `recover`. The empty same-origin `session` POST obtains
its nonce. There is no remote collaboration, account, canonical apply, model
provider, or outbound network path. All people who use this local process have
the local operator's source access. It is not a multi-user access-control layer.

## Five connected views

| Workspace | What is visible | Coauthored result | Next proof |
| --- | --- | --- | --- |
| Onboard | Purpose, steward, reviewer, source-use policies, and context budget | Useful work, roles, source boundaries, and success criteria | One permitted source can support a consequential question |
| Model | Definitions, identity rules, directed relationships, and question coverage | A minimal concept or relationship proposal with examples and counterexamples | Source-backed questions distinguish the intended meanings |
| Deepen | Unused concepts, unknown tags, missing edges, missing evidence, and changed pins | A source-cited correction, contradiction, or unmodeled finding | A reviewer checks exact passages, qualifications, and proposed changes |
| Apply | Complete bounded sources, provenance, qualifications, and declared relationships | An answer or abstention, uncertainties, proposed action, and validation needs | The owner reviews the answer and decides the next real action |
| Learn | Equal-budget retrieval comparison and explicitly unmeasured outcomes | Observed outcome, quality, assistance, correction effort, time, and usage notes | Useful work on unseen questions compared with direct source search |

The dashboard recommends a next step from current structural diagnostics. It
never automatically completes an onboarding stage, promotes an assertion, or
calls an ontology useful because its checks pass. Both task-specific judgment
and actual adopter acceptance remain visible work.

The direct-search comparison uses metadata lexical matching. Graph context adds
one hop of declared relationships. It is not a semantic answer evaluator or a
full-text-search benchmark. The graph may spend *more* context on necessary
qualifications; improvement means better work at appropriate total cost.

## Coauthoring and recovery

Select a question and a flow, enter your locally asserted name or role, and
start. Each session retains its prompts, selected evidence, plan digest, and
workspace snapshot. The prompts cover generic knowledge-work practices; the
consumer owns its domain vocabulary and source decisions.

1. Write an answer. **Record my answer** retains its exact wording in session
   history. It is still a draft.
2. **Save private draft** persists the field and reads back the matching receipt.
   **Continue** then advances. A machine `propose` event opens a confirmation
   step: confirm the revised wording or keep the original before saving.
3. Pause or close after a confirmed save. The session list resumes history from
   the local ledger. A `saving` state offers reconciliation; a failed write
   exposes the existing store's one explicit retry. Exhausted retries need
   operator inspection; the UI does not remove another writer's lock.
4. A failed request retains the exact request ID for retry and keeps the text
   in the tab. Editing pauses so the retry cannot silently change its wording.
   Restore `atelier dev --knowledge`, retry, or reload the session to inspect
   what was actually recorded. Retry controls survive reload and export.
   **End retry and inspect history** stops the tab's retry attempt and preserves
   its request in exported snapshots; it does not cancel or delete server
   history. If recorded wording differs from the text in your tab, the current
   recorded wording and retained answers appear beside it before another intent.
   A failed history inspection remains visible. Reload does not silently erase
   unsaved text. Discarding tab text is explicit.
5. Export a private snapshot for owner review. It includes saved wording,
   receipts, bound source evidence, unsaved text, and a pending request when
   present. Review its audience before sharing. Browser download behavior is
   browser-owned; export does not transmit it to a collaborator.

Unsaved tab text is not durable across tab closure or browser failure. The UI
warns on navigation while dirty; recording an answer or exporting a snapshot is
the recovery path. No browser local storage accumulates source material.

The source plan and records are never edited by this surface. A source owner
uses the exported proposal in its own ordinary edit/review workflow, reviews
an exact diff, applies the admitted change, reruns `knowledge check` and
`knowledge evaluate`, and starts a session bound to the resulting sources.
Never update evidence pins merely to make a failing case pass. A changed
source or project makes old sessions historical; the original prompts,
evidence, and wording remain readable, including when the current plan fails
validation. Correction creates a new session; saved-answer undo is not offered.

Descriptors are immutable, digest-checked files under ignored
`.atelier-local/knowledge/sessions/`. Accepted intents and draft receipts use the
existing coauthor ledger under `.atelier-local/coauthor/`. These are private
proposal artifacts, not a second canonical ontology database. Sessions require
a Git workspace with ignored, untracked local state. Descriptor and draft files
use owner-only modes on POSIX hosts. On Windows, access follows the host's
filesystem permissions; this surface does not install an access-control list.
Same-account filesystem control is not an authentication boundary.
An interrupted start is resumable only when its bound sources still match and
the retained start protocol, ledger, completion marker, and value files support
that interpretation. A completed start publishes an immutable marker before any
guided answer. Missing history with a completion marker or retained values is
never recreated as an empty session. A missing ledger or an incomplete legacy
descriptor requires inspection. A damaged descriptor does not hide other
sessions. Preserve damaged files for inspection; the surface never deletes them
to make history pass.

Each operation checks the current workspace and reports whether its bound
sources still match. External source editors do not share an atomic transaction
with the draft ledger: a change during an operation may leave a retained draft
whose response reports changed sources. These drafts never authorize canonical
writes or effects. Review and rebind before using them after source changes.

## People and agents share the same flow

`atelier knowledge dashboard` prints the five views as JSON. Obtain its current
`snapshot` and an actual question ID. Session commands read one JSON object
from stdin, at most 1 MiB; `list` needs no input:

```sh
atelier knowledge session list
atelier knowledge session start < start-request.json
atelier knowledge session read < session-request.json
atelier knowledge session event < event-request.json
atelier knowledge session recover < session-request.json
```

Start takes `requestId` (a fresh UUID, retained for exact retry), `flow`
(`onboard`, `model`, `deepen`, `apply`, or `learn`), `questionId`, `snapshot`,
and `author`. Read/recover take only `sessionId`. Event takes `sessionId` and
an `event` with a unique `id`, current `expectedRevision`, and reducer `type`.
An `answer` or `propose` also carries `text`. All other event behavior follows
[coauthor sessions](coauthor-session.md). Clients cannot submit receipts or
failure events. Stale versions never silently overwrite an intervening answer.

Ask one useful question at a time. Record the person's exact answer. For
agent-written revisions, send `propose`, show original and proposed wording,
and wait for explicit confirmation before `confirm`. The API records intents;
it cannot authenticate that a human supplied one. Do not infer confirmation,
source-owner acceptance, or action authority from a saved draft.
UUID letters, including exact session IDs, are normalized to lowercase. Reusing
a start request ID with a different author, flow, question, or snapshot is refused. UTF-8 BOM plans are
supported: the workspace binds raw plan bytes, while the coauthor receipt binds
decoded text using the same definition as its source reader.

Keep requests in ignored local files rather than interpolating authored text
into shell commands. The CLI supports `--project` and `--plan` for an explicit
consumer location; browser sessions use that project's `knowledge-plan.json`.
A coauthor plan must be a visible, unredirected file inside its workspace.
The workspace directory itself may be reached through an alias or symbolic link;
plan segments inside it must not be symbolic links.
Resumed sessions check their own recorded plan, including sessions started with
`--plan`. Unavailable source checks are reported separately from changed sources.

## Evaluation and scale

Context contains complete source text, not silently shortened qualifications.
The exact byte budget covers the context JSON, while estimated tokens are only
`ceil(bytes / 4)`. Source selection and dashboard retrieval make zero provider
calls. Workspace scans and evaluation across every planned question still have
local computation cost; context limits are not a whole-corpus scan deadline.

Descriptors are bounded to 1 MiB, session listings to the 200 newest local
descriptor files, and coauthor history to its existing ledger ceilings. Listings
include a total and truncation flag; invalid or unfinished entries are individual
unavailable rows. Use **Open an exact session ID** or the CLI to inspect an older
session beyond the listing limit; use CLI `recover` for an older incomplete start.
Each listing verifies one shared ledger snapshot and replays the selected session
chains. It does not cache state across requests. No history is silently deleted
or compacted. This first reference is for bounded local workspaces, with
text-based observations. It provides no numeric outcome aggregation, automatic source ingestion, semantic
inference, collaborative presence, or canonical editing UI.

Qualification should include an unfamiliar person and agent completing an
unseen useful question: time to first supported answer, correct abstention,
source support, confusion or assistance, corrections, actual token usage,
provider cost, and the observed outcome. Automated browser proof demonstrates
software behavior, not those human results.
