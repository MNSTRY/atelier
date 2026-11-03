# Graph workspace reference

Two package subpaths. The first is pure and runs anywhere; the second needs a browser and injected renderer packages.

## `@mnstry/atelier/graph-workspace`

| Export | Purpose |
| --- | --- |
| `buildWorkspaceModel({ graph, plan?, zoneRule?, summaryLength? })` | Read model `atelier.graph-workspace-model@v1` from an `mnstry.atelier-knowledge-graph@v1` graph and optional knowledge plan. Refuses duplicate ids and other schemas. |
| `zoneOf(path, rule)`, `validateZoneRule(rule)`, `ROOT_ZONE` | Zones from folders: `{ prefix, depth (1–4), labels, rootLabel }`. Records outside the rule share the zone `ROOT_ZONE` (`'/'`), which no folder can be. |
| `edgeClass(type)`, `EDGE_CLASSES` | `related` → `link`, `belongs_to` → `containment`, others → `relation`. |
| `neighbours(model, id)` | Neighbour ids in either direction. |
| `seedPositions`, `layoutWorkspace(model, { Graph, forceAtlas2, seed?, iterations?, settings? })`, `normalizePositions`, `LAYOUT_WEIGHTS` | Deterministic zone-seeded ForceAtlas2 layout (injected), normalised to a 1,000-unit frame. |
| `zoneGeometry(model, { cell? })` | Density blobs and a label anchor per zone. |
| `planMap(model, budget?)`, `DEFAULT_BUDGET` | `records` or `zones` mode for the whole view. `planConstellation` is its deprecated alpha.15 name. |
| `aggregateZones(model)` | `atelier.graph-workspace-zones@v1`: counts by zone and type, directed bundles by edge class, coverage. |
| `zoneSlice(model, zoneId, { limit })` | Bounded sub-model. `slice` reports `linksTouchingZone` = drawn + `omittedLinksInsideZone` + `linksToOtherZonesCount` + `omittedLinksToOtherZones`, with `linksToOtherZones` per zone. `coverage.byClass` counts the drawn links. Plan concepts keep only kept declaring records, with `omittedDeclarations`. |
| `rankRecords(model)` | Records by connection count, then title. |
| `placeLabels({ candidates, measure, width, height, reserved?, budget?, threshold? })` | Collision-free label placement with four slots per label. Pure. |
| `labelThreshold(ratio, boost?)`, `labelBudget(width, height, ratio, boost?)`, `overlaps` | Defaults for zoom-dependent label density. |
| `DEFAULT_RECIPES`, `composeRecipes({ atelier?, distribution?, owner? })`, `validateRecipe`, `availableRecipes(recipes, model)` | Layered recipes with per-field provenance (`setBy`). Rooms (`ROOMS`): `map`, `workbench`, `review`; layers (`LAYERS`): `atelier`, `distribution`, `owner`. The alpha.15 names `coach` (layer) and `constellation` (room, see `DEPRECATED_ROOMS`) are accepted for one release and read as `distribution` and `map`; passing both `coach` and `distribution` throws. Lenses (map only): `question`, `concept`, `zone`; subjects (workbench only, required there): `record`, `concept`, `relation`; primary actions (`PRIMARY_ACTIONS`): `search`, `open-evidence`, `next-step`, `walk`, `review`, `pick`, of which `primaryActionsFor(recipe)` names those the shell honours in a recipe's room (review: `review`; workbench: `next-step`, or `walk` for a record; zone lens: `pick`, `search`; question or concept lens: `open-evidence`, `pick`, `search`; no lens: `search`). `composeRecipes` throws on any other combination; `availableRecipes` drops recipes the model cannot run (concept, relation or question work without them in the plan, a review without concepts, a zone lens without zones, a record subject without records). |
| `DEFAULT_THEME`, `composeTheme(base, ...layers)`, `validateTheme`, `contrastRatio` | `atelier.graph-workspace-theme@v1`, night (dark) by default with a paper (light) scheme. Every layer is checked before and after composing. Each CSS custom property has a declared type (colour, font list, length, shadow, duration, easing), so URLs, `image-set()` and other resource loads are refused, as are unknown fields, schemes and tokens. `--canvas` must equal `graph.canvas`; interface text must reach 4.5:1 on the canvas and surfaces, and on `--surface-glass` composited over the canvas and `--surface-2`; labels need 7:1 and zone colours 3:1. |
| `conceptSteps`, `relationSteps`, `guideConcept`, `guideRelation`, `stepState`, `readiness(plan, store, readableIds)` | Focused authoring steps and structural guidance. `readiness` needs the `Set` of record ids this reader can open; for concepts and relations alike, missing or unreadable evidence and a missing disconfirming case are errors, so `ready-for-human-review` means every step is complete and every citation is readable here. |
| `createDraftStore({ storage, key, identity, persistence?, delayMs? })`, `memoryStorage()` | Drafts behind a storage port `{ getItem, setItem, removeItem }`, saved in an `atelier.graph-workspace-draft@v1` envelope bound to `identity` (`{ workspace, ...scope }`); a draft saved under another identity is never restored. `persistence` is `tab`, `browser` or `host`. Status: `empty`, `restored`, `saving`, `saved`, `unavailable`. |
| `fingerprintsFrom({ graph?, plan?, names?, extra? })`, `scanForFingerprints(files, fingerprints)` | Shareable-content gate with masked findings. |

## `@mnstry/atelier/graph-workspace/browser`

| Export | Purpose |
| --- | --- |
| `mountGraphWorkspace(element, { model, deps, recipes?, theme?, scheme?, profile?, storage?, draftIdentity?, persistence?, draftKey?, initialRecipe?, intro?, webgl? })` | Default shell with the three rooms, command bar, display menu, question, concept and zone lenses, the recipe's primary action, selection card and Text view. Drafts stay in the tab unless `draftIdentity` or `profile.id` names the workspace; a host `storage` port requires one. Returns `{ state, recipes, store, map, workbench, select, openWorkbench, openReview, setRecipe, runPrimary, backToMap, toggleText, setScheme, readiness, destroy }`, plus the deprecated aliases `constellation` and `backToConstellation`. One per document. |
| `createMap({ container, model, palette, deps, font?, reserveSelector?, onSelect?, onHover?, onOpen? })` | The map room alone (`createConstellation` is its deprecated alpha.15 name). `deps = { Sigma, Graph, EdgeArrowProgram, FA2Layout? }`. Elements matching `reserveSelector` (default `[data-graph-reserve]`) are kept free of labels. |
| `createWorkbench(...)`, `renderReview(...)` | The other two rooms, for custom shells. |
| `applyTheme(theme, scheme, element)` | Validate and apply a theme scheme as custom properties; returns the graph palette. |
| `GRAPH_WORKSPACE_CSS`, `injectGraphWorkspaceStyles(document)` | Styles scoped under `.atelier-gw`, responsive by container size. |

The opt-in browser acceptance test is `ATELIER_GRAPH_WORKSPACE_BROWSER_PROOF=1 node --test test/graph-workspace-browser.test.mjs`. It uses an invented fixture and makes no claim about human usefulness, screen-reader parity or a hosted deployment.
