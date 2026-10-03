# Integration contract decisions

## Responsibility architecture

The [responsibility architecture](architecture.md) is the canonical naming and
composition model. Keep existing source/API identifiers as compatibility
surfaces. Responsibilities, roles, methods, resources, records and hosts have
distinct kinds and typed relationships. This decision adopts the architecture
direction; it does not declare every consumer implemented or qualified.

Use additive contracts for architecture bindings, practical cases, native ADR
snapshots and instruction adoption. Existing learning, intake, knowledge and
capability stores retain their domain ownership. Native ADR identity and
approvals remain with the repository that issued them. An imported decision
never becomes a new local approval automatically.

Preview and runtime must map authored fields to the same relevant domain rules.
Unsupported required behavior is a visible resolution failure. Installation,
actual loading, operation execution, durable readback and behavior assessment
remain separate evidence. Reconsider this architecture if a proposed workflow
requires a competing domain writer or an unrelated mandatory stage.

<!-- mnstry-review-workflow: atelier-integration-implementation-r1 gate: implementation-readiness stage: closing -->

These decisions implement the first local integration cut. They do not satisfy
independent review, publication or human acceptance.

| Artifact | Decision | Compatibility and authority |
| --- | --- | --- |
| Package provenance | Separate versioned diagnostic; retain v1 lock fields | Declared origin and observed bytes do not authenticate an upstream publisher. Exact checks require verified binding. |
| Evidence snapshot | Separate content-addressed record using existing JCS | Existing v1 runs stay readable; missing snapshot means no current decision eligibility. |
| Claim decision | Separate immutable decision aggregate and contract | Never insert new event types into legacy proposal aggregates. Stable request identity and expected version are mandatory. |
| Document response | Separate passage-bound record | A question/correction is not a semantic claim or agreement. |
| Owner handoff | Derived proposed change | No canonical apply or publication authority; cross-repository Git disclosure is a distinct event. |
| Inspection bundle | Separate inert artifact; reuse disclosure/JCS ([inspection-bundle.mjs](../src/collaboration/inspection-bundle.mjs); [prepareInspectionBundle](../src/collaboration/inspection-bundle.mjs#L37-L105)) | No active-state overwrite, execution, secret transfer or approval import ([prohibitedKeys](../src/collaboration/inspection-bundle.mjs#L16-L36), [inspectBundle](../src/collaboration/inspection-bundle.mjs#L106-L197), [read and write paths](../src/collaboration/inspection-bundle.mjs#L198-L223)). |
| Pack compatibility | New versioned lifecycle declaration ([lifecycle.mjs](../src/extension-packs/lifecycle.mjs); [inspectPackLifecycle](../src/extension-packs/lifecycle.mjs#L14-L121)) | Legacy packs remain inspectable; closed v1 contracts are not silently widened ([legacy packs inspectable; closed declaration and entries](../src/extension-packs/lifecycle.mjs#L14-L121), [rootVersion](../src/extension-packs/lifecycle.mjs#L7-L12)). |

<!-- Whole-file citations here rely on decision-practice definition revision three, which drafts on added as well as modified or removed lines. Uncited: Package provenance, Evidence snapshot, Claim decision and Document response await symbol-level citation support in the decision-practice consumer. -->

Reuse existing private-file, ledger, origin/nonce, JSON validation and
attestation primitives where applicable. Decisions retain complete history;
latest-state compaction alone is not an audit archive. Local typed identity is
explicitly asserted, not authenticated. Encryption and transfer of active
authority require a separate custody design before availability.
