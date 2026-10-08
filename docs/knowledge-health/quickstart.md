# Follow the workshop finding

This is the primary entry for the composed workshop. The release owner must
first bind and verify its exact package version, exports, template and guided
host. The functions below are implemented in the source proposal. They are
absent from the published `0.2.0-alpha.12` baseline.

## Install the verified version

The facilitator supplies the exact rehearsed version and package integrity.
Create an empty consumer directory, then use that version:

```sh
: "${ATELIER_DEVDAY_VERSION:?Set the exact version supplied by the release owner}"
npm install --save-exact "@mnstry/atelier@$ATELIER_DEVDAY_VERSION"
```

Initialize the package's shipped workshop fixture through its normal export:

```js
import { initializeKnowledgeHealthWorkshop, assessKnowledgeHealthWorkshop }
  from '@mnstry/atelier/knowledge-health';

const workspaceRoot = initializeKnowledgeHealthWorkshop('./workshop');
const before = assessKnowledgeHealthWorkshop({ workspaceRoot });
console.log(before.assessment, before.retrievalEvaluation);
```

An existing destination is refused. The example has two public invented
sources, `devday:checklist` and `devday:workshop`, and the planned relationship
`checklist-workshop`. The separate [pilot example](assessment/quickstart.md)
uses `demo:checklist` and `checklist-pilot`.

## Contribute and follow the owning correction

Use the release's verified existing guided host to follow the
[workshop exercise](exercise.md). Keep your words and the separate
interpretation, choose how to retain them, and verify both native readbacks.
The [API guide](api.md) explains the existing adapter/caller join. The host
keeps the original choice ID and full finding reference during recovery.

Preview the example declaration before applying it to a working draft. Save
and reopen that draft through its owning route. Its source remains unchanged
until the disposable source owner edits the exact declaration and reads it
back. Rerun `assessKnowledgeHealthWorkshop` against the current source and its
actual binding/revisions.

Read both outputs. The relationship check may clear while
`retrievalEvaluation` still lists `devday:checklist` as stale. Keep the frozen
expected evidence and earlier contribution context. The source owner explicitly
refreshes the relevant expected-evidence hash, then reruns the same assessment
and question evaluation. An empty stale list does not establish semantic or
human acceptance.

## Open the existing host

The inspected Foundation source supports this launch sequence after graph and
projection output have been built with the same project. Run it from the
consumer that contains the exact installed version:

```sh
npx --no-install atelier graph --project ./workshop/atelier.project.json
npx --no-install atelier build --project ./workshop/atelier.project.json
npx --no-install atelier server --knowledge --project ./workshop/atelier.project.json --port=0
```

Open the printed loopback URL ending in `/knowledge`. Port zero asks the host
for an available port. The server refuses a missing projection output or
`atelier.manifest.json`; its source diagnostic names graph and build as the
prerequisites. These commands are supported by the inspected source. Their
execution against the workshop and the actual released package remains to be
qualified by its owners.

The current `/knowledge` source hosts Knowledge sessions and an answer field.
Foundation must still bind the workshop assessment and existing native
adapter/caller/R5 contribution, disposition and selected-draft ports to that
host. Merely opening it does not supply those joins. The existing
`knowledge-workspace` template contains a different equipment-loan example;
it must not be mistaken for the shipped workshop fixture initialized above.
Keep the exact words, separate interpretation, original choice ID and pending
record through recovery. Retention and selected-draft application use the
existing owning write boundary and independent readback.

The owning release must qualify the launch sequence, declared exports, actual
native input and lifecycle before participants use this exercise. Runtime
controls require their existing licensed host allocation; private source
snapshots, bundles and local state are excluded from the npm payload.

For preparation and recovery, see [support](support.md),
[facilitator guidance](facilitator.md) and the
[Assessment API details](assessment/api.md). The
[Proof baseline guide](devday/quickstart.md) remains historical alpha12 guidance.
Independent Proof owns its candidate-specific successor and the actual
keyboard, focus, undo, input-method, recovery and participant observations.
