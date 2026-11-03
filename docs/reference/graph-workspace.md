# Graph workspace reference

Two package subpaths. The first is pure and runs anywhere; the second needs a browser and injected renderer packages.

## `@mnstry/atelier/graph-workspace`

| Export | Purpose |
| --- | --- |
| `buildWorkspaceModel({ graph, plan?, zoneRule?, summaryLength? })` | Read model `atelier.graph-workspace-model@v1` from an `mnstry.atelier-knowledge-graph@v1` graph and optional knowledge plan. Refuses duplicate ids and other schemas. |
| `zoneOf(path, rule)`, `validateZoneRule(rule)` | Zones from folders: `{ prefix, depth (1–4), labels, rootLabel }`. |
| `edgeClass(type)`, `EDGE_CLASSES` | `related` → `link`, `belongs_to` → `containment`, others → `relation`. |
| `neighbours(model, id)` | Neighbour ids in either direction. |
| `seedPositions`, `layoutWorkspace(model, { Graph, forceAtlas2, seed?, iterations?, settings? })`, `normalizePositions`, `LAYOUT_WEIGHTS` | Deterministic zone-seeded ForceAtlas2 layout (injected), normalised to a 1,000-unit frame. |
| `zoneGeometry(model, { cell? })` | Density blobs and a label anchor per zone. |
| `planConstellation(model, budget?)`, `DEFAULT_BUDGET` | `records` or `zones` mode for the whole view. |
| `aggregateZones(model)` | `atelier.graph-workspace-zones@v1`: counts by zone and type, directed bundles by edge class, coverage. |
| `zoneSlice(model, zoneId, { limit })` | Bounded sub-model with omitted counts and links to other zones. |
| `rankRecords(model)` | Records by connection count, then title. |
| `placeLabels({ candidates, measure, width, height, reserved?, budget?, threshold? })` | Collision-free label placement with four slots per label. Pure. |
| `labelThreshold(ratio, boost?)`, `labelBudget(width, height, ratio, boost?)`, `overlaps` | Defaults for zoom-dependent label density. |
| `DEFAULT_RECIPES`, `composeRecipes({ atelier?, coach?, owner? })`, `validateRecipe`, `availableRecipes(recipes, model)` | Layered recipes with per-field provenance (`setBy`). Rooms: `constellation`, `workbench`, `review`; lenses: `question`, `concept`, `zone`; subjects: `record`, `concept`, `relation`. |
| `DEFAULT_THEME`, `composeTheme(base, ...layers)`, `validateTheme`, `contrastRatio` | `atelier.graph-workspace-theme@v1`, night (dark) by default with a paper (light) scheme. CSS custom property values only; refuses unsafe values, label contrast under 7:1 and zone colours under 3:1. |
| `conceptSteps`, `relationSteps`, `guideConcept`, `guideRelation`, `stepState`, `readiness` | Focused authoring steps and structural guidance. |
| `createDraftStore({ storage, key, delayMs? })`, `memoryStorage()` | Drafts behind a storage port `{ getItem, setItem, removeItem }`. Status: `empty`, `restored`, `saving`, `saved`, `unavailable`. |
| `fingerprintsFrom({ graph?, plan?, names?, extra? })`, `scanForFingerprints(files, fingerprints)` | Shareable-content gate with masked findings. |

## `@mnstry/atelier/graph-workspace/browser`

| Export | Purpose |
| --- | --- |
| `mountGraphWorkspace(element, { model, deps, recipes?, theme?, scheme?, profile?, storage?, draftKey?, initialRecipe?, intro?, webgl? })` | Default shell with the three rooms, command bar, display menu, question lens, selection card and Text view. Returns `{ state, recipes, store, constellation, workbench, select, openWorkbench, setRecipe, backToConstellation, toggleText, setScheme, readiness, destroy }`. One per document. |
| `createConstellation({ container, model, palette, deps, font?, reserveSelector?, onSelect?, onHover?, onOpen? })` | The constellation room alone. `deps = { Sigma, Graph, EdgeArrowProgram, FA2Layout? }`. Elements matching `reserveSelector` (default `[data-graph-reserve]`) are kept free of labels. |
| `createWorkbench(...)`, `renderReview(...)` | The other two rooms, for custom shells. |
| `applyTheme(theme, scheme, element)` | Validate and apply a theme scheme as custom properties; returns the graph palette. |
| `GRAPH_WORKSPACE_CSS`, `injectGraphWorkspaceStyles(document)` | Styles scoped under `.atelier-gw`, responsive by container size. |

The opt-in browser acceptance test is `ATELIER_GRAPH_WORKSPACE_BROWSER_PROOF=1 node --test test/graph-workspace-browser.test.mjs`. It uses an invented fixture and makes no claim about human usefulness, screen-reader parity or a hosted deployment.
