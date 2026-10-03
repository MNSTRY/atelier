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
| Package provenance | Separate versioned diagnostic; retain v1 lock fields ([inspectPackageProvenance](../src/upgrade/provenance.mjs#L206-L318), [legacyPackageSource](../src/upgrade/provenance.mjs#L320-L338), [packageSource](../src/upgrade/upgrade.mjs#L84-L86), [lock package source](../src/upgrade/upgrade.mjs#L121-L125), [packageRoot and packageJson](../src/upgrade/upgrade.mjs#L45-L46)) | Declared origin and observed bytes do not authenticate an upstream publisher. Exact checks require verified binding ([digest and bounds](../src/upgrade/provenance.mjs#L9-L12), [safeRepository](../src/upgrade/provenance.mjs#L14-L26), [git](../src/upgrade/provenance.mjs#L28-L39), [declarations](../src/upgrade/provenance.mjs#L160-L204), [inventory](../src/upgrade/provenance.mjs#L43-L89), [matchesCommit](../src/upgrade/provenance.mjs#L93-L158), [limitations](../src/upgrade/provenance.mjs#L206-L318), [provenance --exact-source-required](../src/upgrade/upgrade.mjs#L657-L661), [lock check --exact-source-required](../src/upgrade/upgrade.mjs#L672-L675)). |
| Evidence snapshot | Separate content-addressed record using existing JCS ([hashEvidence](../src/readiness-protocols/evidence.mjs#L20-L24), [hashBytes and evaluatorInventory](../src/readiness-protocols/evidence.mjs#L25-L50), [answerForField](../src/readiness-protocols/runtime.mjs#L76-L82), [buildReadinessRun](../src/readiness-protocols/runtime.mjs#L129-L155), [currentInputs](../src/readiness-protocols/evidence.mjs#L52-L168), [captureReviewEvidence](../src/readiness-protocols/evidence.mjs#L170-L180), [evidenceLedger](../src/readiness-protocols/evidence.mjs#L182-L190), [recordReviewEvidence and validBoundRun](../src/readiness-protocols/evidence.mjs#L192-L249)) | Existing v1 runs stay readable; missing snapshot means no current decision eligibility ([runs directory](../src/readiness-protocols/runtime.mjs#L27-L33), [listProtocolRuns](../src/readiness-protocols/runtime.mjs#L188-L202), [invalid](../src/collaboration/review-store.mjs#L16-L16), [write precondition](../src/collaboration/review-store.mjs#L158-L164), [contribution ledger](../src/collaboration/review-store.mjs#L38-L44), [loadBoundRun and currentRunEligibility](../src/readiness-protocols/evidence.mjs#L251-L282), [bound run required](../src/collaboration/review-store.mjs#L172-L174), [current snapshot required](../src/collaboration/review-store.mjs#L188-L195)). |
| Claim decision | Separate immutable decision aggregate and contract ([contribution key and field rules](../src/collaboration/review-store.mjs#L13-L26), [contribution ledger](../src/collaboration/review-store.mjs#L38-L44), [validContribution](../src/collaboration/review-store.mjs#L27-L35), [history replay](../src/collaboration/review-store.mjs#L45-L67), [decision fields](../src/collaboration/review-store.mjs#L106-L114), [input contract](../src/collaboration/review-store.mjs#L134-L137)) | Never insert new event types into legacy proposal aggregates. Stable request identity and expected version are mandatory ([contribution ledger](../src/collaboration/review-store.mjs#L38-L44), [request identity and expected version](../src/collaboration/review-store.mjs#L93-L103), [request reuse, single event and stale version](../src/collaboration/review-store.mjs#L138-L171), [duplicate replay](../src/collaboration/review-store.mjs#L217-L229)). |
| Document response | Separate passage-bound record ([field rules and contribution key](../src/collaboration/review-store.mjs#L14-L26), [contribution ledger](../src/collaboration/review-store.mjs#L38-L44), [write precondition](../src/collaboration/review-store.mjs#L158-L164), [validContribution](../src/collaboration/review-store.mjs#L27-L35), [history replay](../src/collaboration/review-store.mjs#L45-L67), [kind separation](../src/collaboration/review-store.mjs#L104-L105), [passage identity](../src/collaboration/review-store.mjs#L115-L122), [response type and wording](../src/collaboration/review-store.mjs#L123-L128), [passage binding](../src/collaboration/review-store.mjs#L196-L213), [document](../src/collaboration/review-store.mjs#L232-L266)) | A question/correction is not a semantic claim or agreement ([kind separation](../src/collaboration/review-store.mjs#L104-L105), [input contract](../src/collaboration/review-store.mjs#L134-L137), [only accepted decisions hand off](../src/collaboration/review-store.mjs#L270-L276)). |
| Owner handoff | Derived proposed change | No canonical apply or publication authority; cross-repository Git disclosure is a distinct event. |
| Inspection bundle | Separate inert artifact; reuse disclosure/JCS ([prepareInspectionBundle](../src/collaboration/inspection-bundle.mjs#L37-L105)) | No active-state overwrite, execution, secret transfer or approval import ([prohibitedKeys](../src/collaboration/inspection-bundle.mjs#L16-L36), [inspectBundle](../src/collaboration/inspection-bundle.mjs#L106-L197), [read and write paths](../src/collaboration/inspection-bundle.mjs#L198-L223)). |
| Pack compatibility | New versioned lifecycle declaration ([inspectPackLifecycle](../src/extension-packs/lifecycle.mjs#L14-L121)) | Legacy packs remain inspectable; closed v1 contracts are not silently widened ([legacy packs inspectable; closed declaration and entries](../src/extension-packs/lifecycle.mjs#L14-L121), [rootVersion](../src/extension-packs/lifecycle.mjs#L7-L12)). |

Reuse existing private-file, ledger, origin/nonce, JSON validation and
attestation primitives where applicable. Decisions retain complete history;
latest-state compaction alone is not an audit archive. Local typed identity is
explicitly asserted, not authenticated. Encryption and transfer of active
authority require a separate custody design before availability.
