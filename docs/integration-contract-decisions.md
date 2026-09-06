# Integration contract decisions

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
| Inspection bundle | Separate inert artifact; reuse disclosure/JCS | No active-state overwrite, execution, secret transfer or approval import. |
| Pack compatibility | New versioned lifecycle declaration | Legacy packs remain inspectable; closed v1 contracts are not silently widened. |

Reuse existing private-file, ledger, origin/nonce, JSON validation and
attestation primitives where applicable. Decisions retain complete history;
latest-state compaction alone is not an audit archive. Local typed identity is
explicitly asserted, not authenticated. Encryption and transfer of active
authority require a separate custody design before availability.
