# Use the public workshop profile

Use the exact package version and integrity supplied by the release owner. This
profile is a source contribution until it is admitted, released and rehearsed.

In an empty consumer directory, install that version and create a new workshop:

```sh
npm install --save-exact "@mnstry/atelier@$ATELIER_DEVDAY_VERSION"
```

```js
import { initializeKnowledgeHealthWorkshop } from '@mnstry/atelier/knowledge-health'
initializeKnowledgeHealthWorkshop('./workshop')
```

Build its graph and projection, then start the existing loopback host:

```sh
npx --no-install atelier graph --project ./workshop/atelier.project.json
npx --no-install atelier build --project ./workshop/atelier.project.json
npx --no-install atelier server --knowledge --project ./workshop/atelier.project.json --port=0
```

Open the printed URL at `/knowledge`. The Workshop profile appears when the
current invented checklist has the actionable missing supporting relationship.
Read the finding and both sources before responding.

## Retain your response

1. Record your original words and save the private draft.
2. Record a separate interpretation. **Propose revised wording** shows the
   confirmation step; confirm or keep the original wording, then save.
3. Enter one exact choice yourself: `note`, `perspective-only`, `disagreement`
   or `pause`. Save it. These responses retain different meanings, and a
   proposed choice is refused.

**Review** is a separate, optional action. It becomes available after all three
fields are saved and read back. It opens a second session with one field:
enter `["devday:workshop"]` there and save it to select the draft declaration.
See [participant response](participant-response.md).

The **Pause** control pauses the session and retains its existing state. A
saved `pause` choice records your response without selecting a source edit.

The same native text field stays available while a request is pending. Later
wording and composition remain unsaved until you record them. Export the
snapshot before closing the tab when wording or a request remains unresolved.
Closed-tab browser recovery, native undo and keyboard behavior still require
qualification in the receiving browser.

If a reply is lost, **Retry exact request** first looks up its original ID in
durable history. A known retained event is read back without another append.
An unknown outcome retains the request for inspection. A source change leaves
earlier history readable and refuses new writes to the old session.

## Review a source-owner handoff

After the selected draft is saved in the Review session, **Prepare
source-owner handoff** reads both sessions back from durable storage and
retains one copy-only proposal in the existing local proposal store. The
proposal holds the original words, interpretation, choice, selected
declaration, six finding reference fields, source, anchor, read set and the
saved draft receipts, unshortened. The response names the proposal ID. Read the
proposal back at `/api/proposals/<id>` or on the `/proposals` page.

Repeating the request looks up the original saved receipt before anything is
appended. The same handoff returns the same proposal. A different value under
the same receipt is refused. If the source has changed since, a proposal that
was already retained is still read back, and nothing new is retained. A
missing or altered saved draft, or a handoff too large to keep whole, is
refused. An unreadable proposal ledger is reported as unknown: inspect it, then
repeat the same request. A retained proposal has status `proposed`. It is not a
review decision and it applies no source change.

The normal Knowledge host has no source-apply endpoint. A source owner may
review and edit the exact declaration using normal repository editing, then
read it back and reassess:

```js
import { createPublicWorkshopComposition } from '@mnstry/atelier/knowledge-health'
const workshop = createPublicWorkshopComposition({ workspaceRoot: './workshop' })
console.log(workshop.inspect())
console.log(workshop.read(savedSessionId))
```

Keep the frozen expected evidence. A cleared relationship finding can still
leave `devday:checklist` stale in question evaluation. Refreshing expected
evidence is a separate explicit source-owner action. Neither result establishes
semantic support, readiness or human acceptance.

## API and authority

`createPublicWorkshopComposition` delegates `start`, `event`, `lookup`, `read`,
`recover` and `list` to the existing Knowledge sessions and durable coauthor
store. `profile()` provides current evidence and the start snapshot;
`prepareHandoff(sessionId)` prepares the copy-only handoff after durable readback.
Use the existing session request shapes. The author is locally asserted.

This profile saves ordinary public coauthor drafts. Its context retains the
six finding fields; it does not issue a native typed finding-disposition receipt.
It adds no source writer, ledger, canonical model, editor or server.

The public Obsidian source-apply primitive is available under
`@mnstry/atelier/obsidian/edits`. It requires its admitted workspace, vault,
generation, policy and authored-body lens. Its compatibility with this workshop
frontmatter remains an owner binding gap; these controls must remain enforced.
