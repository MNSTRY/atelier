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
| Package provenance | Separate versioned diagnostic; retain v1 lock fields ([versioned diagnostic](../src/upgrade/provenance.mjs#L206-L318), [v1 lock fields](../src/upgrade/provenance.mjs#L320-L338)) | Declared origin and observed bytes do not authenticate an upstream publisher. Exact checks require verified binding ([declared origin](../src/upgrade/provenance.mjs#L160-L204), [exact checks](../src/upgrade/upgrade.mjs#L654-L682)). |
| Evidence snapshot | Separate content-addressed record using existing JCS ([hashEvidence](../src/readiness-protocols/evidence.mjs#L20-L24), [captureReviewEvidence](../src/readiness-protocols/evidence.mjs#L170-L180), [evidence ledger](../src/readiness-protocols/evidence.mjs#L182-L190), [recordReviewEvidence and validBoundRun](../src/readiness-protocols/evidence.mjs#L192-L249)) | Existing v1 runs stay readable; missing snapshot means no current decision eligibility ([listProtocolRuns](../src/readiness-protocols/runtime.mjs#L188-L202), [loadBoundRun and currentRunEligibility](../src/readiness-protocols/evidence.mjs#L251-L282), [bound run required](../src/collaboration/review-store.mjs#L172-L174), [current snapshot required](../src/collaboration/review-store.mjs#L188-L195)). |
| Claim decision | Separate immutable decision aggregate and contract ([separate contribution ledger](../src/collaboration/review-store.mjs#L37-L44), [validContribution](../src/collaboration/review-store.mjs#L27-L35), [history replay](../src/collaboration/review-store.mjs#L45-L67), [decision fields](../src/collaboration/review-store.mjs#L106-L114)) | Never insert new event types into legacy proposal aggregates. Stable request identity and expected version are mandatory ([mandatory request identity and expected version](../src/collaboration/review-store.mjs#L93-L103), [request reuse, single-event aggregate, stale version](../src/collaboration/review-store.mjs#L139-L171)). |
| Document response | Separate passage-bound record ([passage identity](../src/collaboration/review-store.mjs#L115-L122), [response type and wording](../src/collaboration/review-store.mjs#L123-L128), [passage binding](../src/collaboration/review-store.mjs#L196-L213), [document()](../src/collaboration/review-store.mjs#L232-L266)) | A question/correction is not a semantic claim or agreement. |
| Owner handoff | Derived proposed change | No canonical apply or publication authority; cross-repository Git disclosure is a distinct event. |
| Inspection bundle | Separate inert artifact; reuse disclosure/JCS ([prepareInspectionBundle](../src/collaboration/inspection-bundle.mjs#L37-L105)) | No active-state overwrite, execution, secret transfer or approval import ([prohibitedKeys](../src/collaboration/inspection-bundle.mjs#L16-L36), [inspectBundle](../src/collaboration/inspection-bundle.mjs#L106-L197), [read and write paths](../src/collaboration/inspection-bundle.mjs#L198-L223)). |
| Pack compatibility | New versioned lifecycle declaration ([inspectPackLifecycle](../src/extension-packs/lifecycle.mjs#L14-L121)) | Legacy packs remain inspectable; closed v1 contracts are not silently widened. |

Reuse existing private-file, ledger, origin/nonce, JSON validation and
attestation primitives where applicable. Decisions retain complete history;
latest-state compaction alone is not an audit archive. Local typed identity is
explicitly asserted, not authenticated. Encryption and transfer of active
authority require a separate custody design before availability.
