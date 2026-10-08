export const KNOWLEDGE_HEALTH_CAPABILITIES = Object.freeze({
  "schema": "knowledge-health-capability-map@v0",
  "projectionOnly": true,
  "source": {
    "commit": "fcfdbe5ded672d41c717f49e0cfdf68b6060834d",
    "tree": "400e181cd0cb55976f3ef7ab1a1405531dacd521",
    "referenceMode": "Static inventory of the native source at this commit and tree; each reference is pinned by blob. Not a release claim.",
    "supersededQualification": {
      "commit": "b1bdc9279a99f7c884ddfdfe0e2a24315d6f3666",
      "tree": "2797f44baf89007d3808675d897e55a943fc0d65"
    }
  },
  "publishedBaseline": {
    "version": "0.2.0-alpha.12",
    "registryIntegrityVerified": true,
    "sourceVersionLabelIsNotReleaseProof": true
  },
  "capabilities": [
    {
      "id": "canonical-graph",
      "spirals": [
        "S1",
        "S3"
      ],
      "sourceApi": "./graph#buildCanonicalGraph",
      "sourceCommands": [
        "atelier graph --project atelier.project.json",
        "atelier graph --check --project atelier.project.json"
      ],
      "sourceReference": {
        "path": "src/graph/graph.mjs",
        "line": 147,
        "blob": "6bce4e1213098457097e025f8ead53e6b4403336",
        "sha256": "1f01fbeab7e6fcaed127c8fe84c9a48b08f1fec13d21f486c48726715a5bbb92"
      },
      "publishedBaseline": {
        "version": "0.2.0-alpha.12",
        "entryDeclared": true,
        "filePresent": true
      },
      "verification": "Native function used in the relocated receiving rehearsal. CLI syntax/source only; not executed by this supplier.",
      "limits": "Canonical graph includes declared and ordinary-link origins/offsets. Legacy graph artifact/CLI includes declared edges only; --check verifies generated artifact freshness, not semantic truth.",
      "smallestSourceOwnerCorrection": "Keep existing graph implementation. Receive the assessment join; do not replace legacy artifact or claim ordinary links satisfy required direction."
    },
    {
      "id": "typed-plan-check",
      "spirals": [
        "S1"
      ],
      "sourceApi": "internal:inspectKnowledgePlan",
      "sourceCommands": [
        "atelier knowledge check --project atelier.project.json --plan knowledge-plan.json"
      ],
      "sourceReference": {
        "path": "src/knowledge/plan.mjs",
        "line": 34,
        "blob": "b029609a678354f188980acb8954030daa817582",
        "sha256": "7ee8d7d20fcc85264dd484b129eae9a1ab4424b47aae0cce764f9e769fe32336"
      },
      "publishedBaseline": {
        "version": "0.2.0-alpha.12",
        "entryDeclared": false,
        "filePresent": false
      },
      "verification": "Actual rule exercised through the additive installed-export rehearsal.",
      "limits": "Only typed plan/concept tag/native predicate direction. Native warnings can coexist with ok=true and exit 0; no arbitrary prose applicability.",
      "smallestSourceOwnerCorrection": "Receive src/knowledge-health and additive ./knowledge-health export; preserve current rule and warnings. Decide user CI warning policy explicitly."
    },
    {
      "id": "bounded-agent-context",
      "spirals": [
        "S1",
        "S2"
      ],
      "sourceApi": "internal:createKnowledgeContext",
      "sourceCommands": [
        "atelier knowledge context --project atelier.project.json --plan knowledge-plan.json --question \"What supports pilot readiness?\" --mode graph"
      ],
      "sourceReference": {
        "path": "src/knowledge/context.mjs",
        "line": 57,
        "blob": "7d2be260883267277050c6f7f1f0b0cd6888e5a4",
        "sha256": "29a73bc8e1afa498f1ed11e158379317cf738a898a68930d95b90b1f1f395d0d"
      },
      "publishedBaseline": {
        "version": "0.2.0-alpha.12",
        "entryDeclared": false,
        "filePresent": false
      },
      "verification": "Actual native context used in the receiving rehearsal.",
      "limits": "Bounded metadata lexical seeds and declared one-hop neighbors; omissions, unreadable and unlisted counts retained. Text is data. No provider execution, global semantic search or recipient sharing authority.",
      "smallestSourceOwnerCorrection": "Ship existing knowledge command with current source; expose source-bound joins via the additive adapter. No replacement retrieval or graph model."
    },
    {
      "id": "question-evaluation",
      "spirals": [
        "S2"
      ],
      "sourceApi": "internal:evaluateKnowledgeQuestions",
      "sourceCommands": [
        "atelier knowledge evaluate --project atelier.project.json --plan knowledge-plan.json"
      ],
      "sourceReference": {
        "path": "src/knowledge/context.mjs",
        "line": 175,
        "blob": "7d2be260883267277050c6f7f1f0b0cd6888e5a4",
        "sha256": "29a73bc8e1afa498f1ed11e158379317cf738a898a68930d95b90b1f1f395d0d"
      },
      "publishedBaseline": {
        "version": "0.2.0-alpha.12",
        "entryDeclared": false,
        "filePresent": false
      },
      "verification": "Native graph/lexical evaluation used before/after correction.",
      "limits": "Author-specified expected source/relation pins are excluded from retrieval. Stale expectations remain stale. No answer correctness, held-out qualification or human usefulness inference.",
      "smallestSourceOwnerCorrection": "Ship existing evaluator and explain graph versus lexical comparison, appropriate abstention and explicit expected-pin refresh; retain separate human trials."
    },
    {
      "id": "ingestion-evaluation",
      "spirals": [
        "S2"
      ],
      "sourceApi": "./ingestion/evaluation#evaluateIngestionTrial",
      "sourceCommands": [],
      "sourceReference": {
        "path": "src/ingestion/evaluation.mjs",
        "line": 38,
        "blob": "4871eea0e980e3eb518a4cb23dbe97687ffa71c7",
        "sha256": "adcf2f5d61fe0313e82a525ec28cea771d9d9ac1e470acba1da5be571387ba58"
      },
      "publishedBaseline": {
        "version": "0.2.0-alpha.12",
        "entryDeclared": false,
        "filePresent": false
      },
      "verification": "Actual exported function exercised on invented calibration evidence, including duplicate accounting.",
      "limits": "Exact evidence multiset/threshold evaluation; calibration-only never passes held-out gate. Unknown cost/elapsed/human acceptance remain null/unassessed; semanticQualification not-assessed.",
      "smallestSourceOwnerCorrection": "Include current source export/module in next release and the portable example. No new model or held-out answer bank; genuine semantic trial is separately owned."
    },
    {
      "id": "local-ingestion",
      "spirals": [
        "S2"
      ],
      "sourceApi": "./ingestion#createIngestionStore",
      "sourceCommands": [
        "atelier ingest plan",
        "atelier ingest run",
        "atelier ingest status",
        "atelier ingest query"
      ],
      "sourceReference": {
        "path": "src/commands/ingest.mjs",
        "line": 4,
        "blob": "2c5fc628d612968f686990ef39e69fdb6fd701bd",
        "sha256": "380152f2af7e1e0e8d429a8876bc2b413628c902450733a5163eb49781206da9"
      },
      "publishedBaseline": {
        "version": "0.2.0-alpha.12",
        "entryDeclared": false,
        "filePresent": false
      },
      "verification": "Static API/command source inspection only.",
      "limits": "Private local UTF-8 JSON envelope; explicit source/scope/budget, lexical evidence; local text/CSV/JSON processing. No semantic claim acceptance or raw file graph enrollment.",
      "smallestSourceOwnerCorrection": "Reuse current ingestion/store and ./knowledge localKnowledgeContext/contribution paths. Route actual semantic operation and human decisions to existing owners."
    },
    {
      "id": "semantic-operation",
      "spirals": [
        "S2"
      ],
      "sourceApi": "internal:createSemanticOperation",
      "sourceCommands": [],
      "sourceReference": {
        "path": "src/knowledge/semantic-operation.mjs",
        "line": 133,
        "blob": "eb131c7511a45fd0904b4a74a958b04d6436123f",
        "sha256": "fb6fafabb00dbd65890c5b409f6d4562dcf041c84606a1b0c4f8fb3930d09ef2"
      },
      "publishedBaseline": {
        "version": "0.2.0-alpha.12",
        "entryDeclared": false,
        "filePresent": false
      },
      "verification": "Static source inspection only; not executed or provider-qualified.",
      "limits": "Owner-bound recorded callback, source dependency witnesses and reconsideration; proposal-only, semantic acceptance pending. No public ./knowledge export at this source for this function.",
      "smallestSourceOwnerCorrection": "If the Dev Day interpretation path needs it, add the smallest owner-controlled export/wiring and exercise recorded invented lifecycle. Do not substitute a deterministic score for semantic/human evaluation."
    },
    {
      "id": "repository-observation",
      "spirals": [
        "S3"
      ],
      "sourceApi": "./runtime/observation#observeRepository",
      "sourceCommands": [
        "atelier sync status --repo .",
        "atelier sync trace --repo ."
      ],
      "sourceReference": {
        "path": "src/runtime/repository-observation.mjs",
        "line": 419,
        "blob": "89bc5a0fc5eae7830d95b8811faaf664b239d583",
        "sha256": "e6a53f6ce639a53a0888e038b244d26180ec5ef554bc49686dd91d9b3befb069"
      },
      "publishedBaseline": {
        "version": "0.2.0-alpha.12",
        "entryDeclared": true,
        "filePresent": true
      },
      "verification": "Public baseline file/export verified; current source inspected read-only.",
      "limits": "Local Git/head/status/filesystem evidence with blockers and bounded observation. A current Git observation does not prove application adoption, consumption, execution, remote freshness or causal lineage. Sync status/trace use already enrolled runtime state; reconcile/enroll/run are separate effects.",
      "smallestSourceOwnerCorrection": "Join actual observation/status/operation trace with existing harness history/dependency snapshots in a receiving adapter; require explicit owner evidence for declared/adopted/consumed/executed. This context reports unobserved by default."
    },
    {
      "id": "cross-repository-handoff",
      "spirals": [
        "S3"
      ],
      "sourceApi": "./harnesses#verifyHarnessHandoff",
      "sourceCommands": [
        "atelier harness inspect --profile knowledge --history HISTORY.json",
        "atelier harness verify --handoff HANDOFF.json --history HISTORY.json"
      ],
      "sourceReference": {
        "path": "src/commands/harness.mjs",
        "line": 25,
        "blob": "8fc40a7035e76a819c1752e1da2d413a89eb340f",
        "sha256": "885070823aabe350eeabea1e629c6b91eb0462a1f5039e6b0759cdea81593ee6"
      },
      "publishedBaseline": {
        "version": "0.2.0-alpha.12",
        "entryDeclared": false,
        "filePresent": false
      },
      "verification": "Static source inspection only.",
      "limits": "Complete ledgers and explicit repository/profile/records dependency snapshots. Proposal/reported acceptance is not execution authority; no actual adopter chain was observed.",
      "smallestSourceOwnerCorrection": "Reuse existing harness handoff/verify/reconcile and exact repository identities; publish a recorded public invented multi-repository exercise through receiving owner. Keep actual adopter/withdrawal acceptance open."
    },
    {
      "id": "readiness-and-generated-freshness",
      "spirals": [
        "S3",
        "S5"
      ],
      "sourceApi": "./readiness#buildReadiness",
      "sourceCommands": [
        "atelier readiness --project atelier.project.json",
        "atelier readiness --check --project atelier.project.json",
        "atelier generated check --project atelier.project.json"
      ],
      "sourceReference": {
        "path": "src/readiness/readiness.mjs",
        "line": 174,
        "blob": "05f39956a13a8f8435a4709d4512364aa56a5661",
        "sha256": "e5244afa52d01e8342cf1730990c3be6dd93bd6e82aaa8fb0014b6215bace652"
      },
      "publishedBaseline": {
        "version": "0.2.0-alpha.12",
        "entryDeclared": true,
        "filePresent": true
      },
      "verification": "Public baseline file/export verified; static current source inspection only.",
      "limits": "Existing artifact/schema/readiness checks, generated freshness and typed export boundaries. Native support limits and absent runtime evidence remain explicit; no human semantic health score.",
      "smallestSourceOwnerCorrection": "Reuse current readiness/generated tools; wire the source-bound assessment outcome as an explicit input only where owner contract permits, without inferring human acceptance."
    },
    {
      "id": "host-and-authoring",
      "spirals": [
        "S1",
        "S4"
      ],
      "sourceApi": "./coauthor#createSession",
      "sourceCommands": [
        "atelier knowledge dashboard --project atelier.project.json --plan knowledge-plan.json",
        "atelier knowledge session start",
        "atelier dev --project atelier.project.json"
      ],
      "sourceReference": {
        "path": "src/coauthor/session.mjs",
        "line": 22,
        "blob": "990ec8d01116ef289b514f9b590d53317b473b06",
        "sha256": "8321f6c3164f55dbcec1c9e6e09f170ec5411e1ceb0685d32075516a4252b0b6"
      },
      "publishedBaseline": {
        "version": "0.2.0-alpha.12",
        "entryDeclared": true,
        "filePresent": true
      },
      "verification": "Static current source inspection; this assessment supplier does not exercise UI/store/host save.",
      "limits": "Existing native coauthor/store, presentation, Obsidian/sidecar and runtime ownership remain. Keyboard/IME/undo/zoom, actual source apply and participant understanding require the existing host proof owners.",
      "smallestSourceOwnerCorrection": "Receive participatory supplier through existing Authoring writer. Source-bound assessment field binding is a handoff, not an apply operation; preserve one owning editor/save route."
    },
    {
      "id": "normal-knowledge-workspace-init",
      "spirals": [
        "S1",
        "S5"
      ],
      "sourceApi": null,
      "sourceCommands": [
        "atelier init ./workspace --template knowledge-workspace"
      ],
      "sourceReference": {
        "path": "src/commands/init.mjs",
        "line": 104,
        "blob": "986712fb799daf3b8f1c484bf18b521fa6946ad7",
        "sha256": "fb0c30241181ab6695a8690203bd83c561addd9e84392431395e907e5cb5a46d"
      },
      "publishedBaseline": {
        "version": "0.2.0-alpha.12",
        "dispatchAvailable": false,
        "templateAvailable": false
      },
      "verification": "Source dispatch inspected read-only. Published baseline missing path/dispatch confirmed independently by package inspection and the receiving proof owner; not executed on a new registry release.",
      "limits": "Explicit fixture helper does not qualify normal package init or installed hosted journey.",
      "smallestSourceOwnerCorrection": "Ship actual current templates/knowledge-workspace and normal init knowledge-workspace dispatch; bind both to the frozen source and audit/execute normal init from exact official tarball and new published version."
    }
  ],
  "retainedProgrammeToolingGaps": [
    {
      "spiral": "S2",
      "need": "Semantic fidelity, qualifiers/contradiction/identity; optional bounded agent cost/value; private perspective and scoped learning",
      "available": "Native question and ingestion evaluation, semantic operation lifecycle, contribution/learning primitives.",
      "remaining": "Concrete package/UI lifecycle joins and human source-supported semantic trial. No model/held-out execution in this supplier.",
      "owner": "Existing Foundation/Authoring semantic and evaluation owners via coordinator"
    },
    {
      "spiral": "S3",
      "need": "Declared/adopted/consumed/executed tracing; freshness, partial refresh, drift, withdrawal/recovery",
      "available": "Git repository observation, sync status/trace, native source hashes/census omissions, harness ledgers/dependency snapshots.",
      "remaining": "Actual receiving joins and recorded multi-repository use with exact owner evidence; withdrawal/recovery acceptance.",
      "owner": "Existing Reliability/Adoption & proof via coordinator"
    },
    {
      "spiral": "S4",
      "need": "Additional hosts/media/domains, keyboard/IME/text scaling, accessible graph alternative, purposeful scale",
      "available": "Existing source format/graph/presentation/runtime APIs and context byte/document/source budgets.",
      "remaining": "Installed cross-host/media and accessibility/scale measurement. This proof is Node22.18 on macOS only.",
      "owner": "Existing host/Authoring and Journey proof owners"
    },
    {
      "spiral": "S5",
      "need": "Ownership/documentation/rollback/maintenance and full programme closure",
      "available": "Portable typed exercise, API/command map, native recovery/readiness and existing owner routes.",
      "remaining": "Exact audited release, clean npm install, facilitator/participant feedback, ongoing owner receiving, all 22 promises disposition.",
      "owner": "Coordinator, Foundation release and existing proof owners"
    }
  ],
  "grantsAuthority": false
})
