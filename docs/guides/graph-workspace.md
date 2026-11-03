# Graph workspace

A graph workspace lets a person explore a whole knowledge graph, then shape its concepts one step at a time. It is built in three layers, and the last one belongs to the owner:

1. **Atelier** ships primitives and defaults: the read model, scale and layout helpers, label placement, recipes, themes, authoring and the browser rooms.
2. **A coach** builds tooling for a cohort from those pieces: their own recipes, a theme, perhaps a different shell around the same rooms.
3. **The owner** shapes their own system from everything they receive: hiding what they do not use, renaming, adding their own recipes and appearance.

Nothing in a layer is hard-coded into the one below it. Recipes and themes are data that compose by name, and every resolved recipe field records which layer set it.

## One graph, three rooms

- **Constellation.** Every readable record, alive on a night-sky canvas (the default), with soft glows for the owner's folders and folder names at a distance. Names fade in by importance as you zoom in and never overlap each other or the controls. Hovering lights a neighbourhood; clicking selects without moving the map. "Let it move" turns on live physics.
- **Workbench.** A sparse set of rich cards (incoming on the left, outgoing on the right) beside a focused authoring sheet. One subject at a time, one step at a time, with deferral and structural guidance. Drafts belong to one workspace identity (and reader scope, where the host has one), so two workspaces never see each other's drafts. Without an identity they live in this tab only. With `profile.id` or `draftIdentity` they persist in this browser, and with a host storage port they persist there. The interface says which.
- **Review.** Before and proposed, the state of the evidence, and that a person decides. Nothing is sent.

A work **recipe** picks the room, the lens and the single primary action. Lenses (`question`, `concept`, `zone`) belong to the constellation, subjects (`record`, `concept`, `relation`) to the workbench, and the review room takes neither. The primary action is one of `search`, `open-evidence`, `next-step`, `walk`, `review` or `pick`, and only one the recipe's room can carry out (`primaryActionsFor`). Combinations the shell cannot honour are refused when recipes are composed, and recipes the workspace cannot run (a relation recipe with no relations, say) are not offered. Defaults: *Explore*, *Answer a question*, *Refine a concept*, *Inspect a record*. A command bar (⌘K or `/`) replaces persistent navigation. Text view lists every record, and without WebGL every task remains available through Text view and the workbench.

## Honesty rules the primitives keep

- Zones come only from the owner's folder structure. No computed clusters are drawn.
- A record belongs to a concept only when the record carries the concept's tag itself. Text matches are offered as suggestions labelled "not members".
- Edge direction is preserved. Edges fall into three classes: written links, folder containment and declared relations. Only declared relations are drawn with arrows and emphasis.
- Links to records outside the readable set are counted, never drawn.
- "Ready for human review" means complete and grounded in readable records. It is not a verdict on truth.

## Scale

`planConstellation()` decides whether to draw every record or to show zones. The default budget is 12,000 records or 60,000 links. Above it, `aggregateZones()` gives counts by zone and directed bundles between zones, and `zoneSlice()` opens one zone at a time. Every link touching the zone is accounted for exactly once (drawn, omitted inside the zone, to another zone, or omitted to another zone), and plan concepts list only the kept records that declare them, with the rest counted. Aggregating 30,000 records is part of the test suite. On a laptop GPU the constellation holds 60 fps at 5,000 records, with labels and zone glows.

## Build a workspace

```js
import Graph from 'graphology'
import Sigma from 'sigma'
import { EdgeArrowProgram } from 'sigma/rendering'
import forceAtlas2 from 'graphology-layout-forceatlas2'
import FA2Layout from 'graphology-layout-forceatlas2/worker'
import { buildWorkspaceModel, layoutWorkspace, composeRecipes, composeTheme, DEFAULT_THEME } from '@mnstry/atelier/graph-workspace'
import { mountGraphWorkspace } from '@mnstry/atelier/graph-workspace/browser'

// graph: an Atelier knowledge graph the host has already limited to this reader.
const model = buildWorkspaceModel({ graph, plan, zoneRule: { prefix: 'notes/', depth: 1 } })
layoutWorkspace(model, { Graph, forceAtlas2 })            // or store positions at build time

const recipes = composeRecipes({ coach: coachRecipes, owner: ownerRecipes }).recipes
const theme = composeTheme(DEFAULT_THEME, coachTheme, ownerTheme) // every layer is checked; one bad layer refuses the theme

mountGraphWorkspace(element, { model, recipes, theme, deps: { Sigma, Graph, EdgeArrowProgram, FA2Layout },
  profile: { id: 'workspace-id', name: 'My notebook', vocabulary: { record: 'note', records: 'notes', zone: 'folder' } },
  // Optional: persist drafts to the host instead of this browser.
  // storage: hostDraftPort, draftIdentity: { workspace: 'workspace-id', reader: readerScope },
})
```

Atelier does not depend on `sigma` or `graphology`; the host injects them. Pin sigma 3 and graphology 0.25 or later in the consuming application.

## Keeping a shareable layer clean

A coach or owner who builds on private workspaces can check that nothing from them reaches a shareable layer. `fingerprintsFrom()` derives distinctive strings from a private graph and plan (record ids, paths, long titles, summary openings, plan wording and names). `scanForFingerprints()` reports where any of them appears in shareable text, naming the file and a masked sample only.

## What this does not do

It does not authenticate a reader, grant access, read source bodies, save to a source or apply a plan change. Drafts that outlive the browser, and proposals, need a host storage port bound to the coauthor ledger, and the host's ontology guide remains the authority on guidance. See the [reference](../reference/graph-workspace.md) for every export.
