# Structured graph explorer

The structured explorer is a browser DOM consumer of `atelier.graph-view@v1`.
It provides record search, keyboard navigation, a directed relationship table,
questions, diagnostics and a shared evidence inspector without WebGL. It emits
presentation intents; it does not read repositories, accept assertions, perform
access checks, or create source records.

## Host integration

The source entry is `src/graph-view/structured/browser.mjs`:

```js
const explorer = mountStructuredGraphView(element, {
  view: authorizedView,
  selection: { projectionDigest: authorizedView.projectionDigest, ref },
  onIntent: handleIntent,
})
explorer.update({ view: nextAuthorizedView, selection: nextSelection })
explorer.clear()
explorer.destroy()
```

This source seam is awaiting a package export and a consuming browser host.
A source import or local test does not establish published package availability.
The host validates the complete versioned envelope and digest before delivery.
The component checks its required presentation shape, copies received values,
and presents source text as inert DOM text. It is not a browser authorization
control. Never deliver a combined graph and ask this component to hide denied
records. The access and projection owners must remove denied topology before
any bytes, counts, diagnostics, source references or cursors reach the browser.

`onIntent` receives the producer's digest-bound intents: `select` with exactly
one qualified `ref` or `edgeId`; `openEvidence` with an `evidenceId`;
`setQuestion` with a `questionId`; and `expand` with a qualified `ref` and
`direction` of `in`, `out` or `both`. Qualified refs use `{repoId, localId}`.
The component uses the producer's browser-safe intent validator. The host revalidates current grants and source before handling an intent.
Selection is controlled by `update`; a request never optimistically accepts an
assertion or changes source. Focus and selection are separate. Keyboard arrows,
Home and End move list focus; Enter or Space requests selection.

Host selection is `{projectionDigest, ref|edgeId|evidenceId|questionId}` with
exactly one target available in the delivered slice. Stale or unavailable
selection is cleared without rendering its identity or a placeholder.
Host updates preserve focus where the corresponding control remains available.
If it disappears, focus moves to the inspector. Search applies only to the
records already delivered, and it is labelled accordingly.

On grant loss or withdrawal, call `clear()` immediately and discard host caches.
The component clears source pins, controls, search text and selection. A late
intent callback cannot update the component's status after withdrawal. The host
must also cancel or reject stale query results and must not call `update` with
previously withdrawn bytes. `destroy()` removes the entire mounted DOM and
releases the mount reservation; no global listener or transport was installed.

## Provenance and honest states

Each relationship retains its producer `edgeId`, direction, predicate, family,
assurance and acceptance state. Equal endpoint/predicate triples remain separate
rows. Origin and support IDs resolve into authorized evidence records, including
repository, path, exact source revision, content digest and structured locator.
Review receipt digests, policy/record digests, qualifications and check time
are displayed as supplied. An active source-declared edge is not labelled a
reviewed assertion. No source passage is invented when a view supplies only pins.

The initial producer fixture provides no edge currency field. The inspector
therefore says that staleness is not supplied and must not be assumed current.
It displays each support record's independent verification state. A host can also pass `refreshStatus` from the existing refresh controller's read result. A stale source view and rebuild failure receive explicit labels, including in the edge inspector; arbitrary failure details are never echoed. Selection updates for the same projection preserve that status, and a new projection or withdrawal clears it. A verification
check time is not a currentness guarantee. Explicit edge currency remains a
producer dependency.

Questions retain coverage, gaps, omissions and supporting/contradicting evidence.
An abstention states that the sources do not establish an answer. Authorized
diagnostics remain visible with record and evidence controls. A bounded view
states its truncation and omitted counts; search and counts never imply whole-corpus completeness. A host may supply onPage({projectionDigest, cursor}) to receive the visible Load next page control. Without a cursor, the view explains that a broader host query is needed.

## Acceptance and limits

Run the opt-in network-blocked proof using the repository's locked Playwright
runtime and an installed Chromium. It does not download browsers or start a
service:

```sh
ATELIER_STRUCTURED_BROWSER_PROOF=1 node --test test/graph-view-structured-browser.test.mjs
```

The default shared fixture is `fixtures/graph-view/synthetic-view.v1.json`, owned
by the projection lane. `ATELIER_GRAPH_VIEW_FIXTURE` may select its exact received
file before the producer dependency lands. The test independently verifies the
fixture digest and records the file hash. `ATELIER_STRUCTURED_PROOF_OUTPUT`
selects the output directory; the default is `output/playwright/graph-structured`.

The proof exercises question/source/relationship/contradiction tasks, abstention,
qualified identity, repeated-edge provenance, keyboard selection and independent
focus, native accessibility-tree semantics, touch without dragging, 44px targets,
forced colors, reduced motion, 320px reflow, 200% CSS layout zoom, WebGL disabled,
withdrawal, failed/late delivery and disposal. CSS layout zoom supplements the
manual browser zoom test; it is not a claim of operating-system magnification.
Automated accessibility-tree inspection is not a human screen-reader result.

Before human acceptance, use the same reserved unseen task in the Babylon host
and structured explorer: locate a question, inspect a source, traverse a directed
relationship, recognize a contradiction or missing support, and explain the next
decision or abstention. Retain exact source/projection/browser identities. Run
keyboard only, a named screen reader, actual browser zoom at 200%, high contrast,
reduced motion, touch without dragging and WebGL disabled. Record correctness,
source trace, wrong turns and time separately. Keep A-only and A+B host views
separate; the A-only participant must receive no clue that B exists. A local
synthetic consumer test does not qualify that access boundary or pass an unseen
human task. The cohort validation owner retains that acceptance work.

## Reused authority

Source records and predicates remain governed by `src/graph/knowledge-graph.mjs`.
Questions and expected evidence remain knowledge-plan projections. Graph-view
owns the qualified identity, envelope and intent contract; the host owns access
and delivery. Existing presentation semantics distinguish focused and selected
state. This component adds a presentation seam, not an ontology canonical or a
second authoring desk. Babylon scene and lifecycle remain with its owning lane.
