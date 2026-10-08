# Source-bound Knowledge Health exercise

Use a local Git workspace and a pinned Atelier release that includes
`@mnstry/atelier/knowledge-health`. Atelier declares Node
`>=22.18.0 <23 || >=24.13.1 <25`; this supplier rehearsal used Node22.18 on
macOS. Git must be on PATH. The invented public exercise needs no model account.

Replace `VERSION_FROM_FACILITATOR` with the exact workshop release version:

```sh
npm install --save-exact @mnstry/atelier@VERSION_FROM_FACILITATOR
node --input-type=module -e "import('@mnstry/atelier/knowledge-health').then(m => console.log(typeof m.assessKnowledgeHealth))"
```

The import should print `function`. Public alpha.12 does not include this export,
knowledge-plan/context modules or the normal `knowledge-workspace` initializer.
See [troubleshooting](troubleshooting.md) if your installed version lacks them.

Create a new disposable directory; the helper refuses an existing directory:

```sh
node --input-type=module -e "import {initializeKnowledgeHealthExample as init} from '@mnstry/atelier/knowledge-health'; init('./kh-example')"
node --input-type=module -e "import {assessKnowledgeHealthExample as assess} from '@mnstry/atelier/knowledge-health'; console.log(JSON.stringify(assess('./kh-example'), null, 2))" > before.json
```

Open `kh-example/records/checklist.md` in your editor. Its typed declaration is
`supports: []`. The report says `checklist-pilot` has no declared edge in the
required direction. Inspect the exact source digest/content revision, declaration
quote and UTF-8 byte range in the finding, the native report in
`assessment.original.report`, and selected source text in
`assessment.original.context.sources`.

The source says the pilot has not been approved and no allocation decision is
recorded. Record your own words and interpretation separately. You may disagree,
leave a perspective without revising, or pause. The structural report does not
decide what the source means or require a write.

If you choose the supplied correction, compare your file with the installed
`fixtures/knowledge-health/corrected/checklist.md`. It changes only the declaration
to `supports: ["demo:pilot"]`. Apply that change through your existing editor,
save and reopen the local file. Preserve the body and its qualifications. The
assessment API itself writes no source.

```sh
node --input-type=module -e "import {assessKnowledgeHealthExample as assess} from '@mnstry/atelier/knowledge-health'; console.log(JSON.stringify(assess('./kh-example'), null, 2))" > after.json
```

The current structural report should be `structurally-valid` with zero selected
findings and one matching declared edge. Its source/read-set/comparison pins
change; the earlier report remains your baseline. Compare the
[expected summary](../../../fixtures/knowledge-health/expected-summary.json).

`retrievalEvaluation` still reports the changed checklist as stale against frozen
baseline expectations. Review and explicitly update an evaluation baseline when
appropriate; never silently replace expected pins to make it pass. Approval,
funding, semantic support, adoption and participant usefulness remain unknown.

Use [the API guide](api.md) for an existing source. Example `content-sha256:`
revisions and invented actor/store labels are fixture evidence, not authenticated
identity, durable store heads or write authority. The explicit fixture helper
does not prove normal package `init` or the actual guided editor/save journey.
