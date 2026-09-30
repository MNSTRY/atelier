---
name: research-integrate
description: Prepare a reviewable integration of research into an existing Atelier knowledge graph after inspecting the destination schema; do not treat generated reports as accepted knowledge.
---

# Integrate research into Atelier

Inspect the destination's current repository instructions, ontology, intake
contracts, audience rules and existing graph build command. Keep the workflow
portable: use the destination's actual tools and types, never invent commands or
assume an optional integration is installed.

Preserve original reports through the existing intake path, record their content
digests and keep derived files separate. Reconcile identifiers against existing
sources before proposing new nodes. Follow [the integration checklist](references/integration.md).

Prepare draft source documents with stable IDs, provenance, audience and links
using the destination's allowed relations. Source observations, attributed
claims and human-accepted conclusions must retain distinct review states. Do not
turn a report into canonical truth merely because it was ingested.

Run the destination's graph validation/build and inspect the resulting nodes,
relations, diagnostics and retrieval of representative claims. Report exact
coverage and failures. A clean graph establishes structural validity; a human
still validates interpretation and publication.

Apply canonical source changes only within the current task's authoring
permission. Preserve a reviewable diff and report whether the result is prepared,
written, validated, reviewed or published.
