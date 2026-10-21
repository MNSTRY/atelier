# Decision practices

This internal composition keeps a reusable decision practice inside an ordinary
Knowledge contribution. It adds no adoption store, policy authority, scheduler,
model route, command or package export. The format `atelier.decision-practice/v0`
is experimental and is not a registered public contract. The existing
instruction-adoption command, `atelier practice`, is a separate concept.

A definition declares purpose, applicability, rights, required evidence roles,
prerequisites, an existing decision request as a rubric specimen, count limits and
the permitted reconsideration proposal. Purpose and rights statements are
declarations; a consumer still needs its own source, actor and disclosure proof.
The specimen establishes the task and rubric; it is not permission to reuse old
request state or a result against different evidence.

`validateDecisionPractice` inspects bounded JSON without invoking accessors.
`prepareDecisionPracticeContribution` prepares captured contribution data for the
existing Knowledge review path. It neither appends a record nor adopts a rule.
`readAdoptedDecisionPractice` checks an exact contribution digest, current accepted
review and a current activation in the supplied Knowledge history. That history
is caller-supplied evidence, not independent proof of actor identity, current host
permission or authenticity. Withdrawal, supersession and reconsideration remain
the existing harness's responsibility.

This portable profile deliberately bounds each complete input, including the
supplied history, to 262,144 UTF-8 JSON bytes, 8,192 JSON members and depth 24.
Each string also has a 262,144 UTF-16-unit limit and must not contain NUL.
Knowledge itself accepts larger histories. A valid history outside this smaller
profile returns `practice-input-exceeds-bounds`; it is not reported as malformed
history. The host must supply an in-profile complete history or retain that typed
refusal; silently truncating history cannot establish current adoption. Within
the bounded inspected prefix, accessors, cycles, custom prototypes and sparse
arrays remain malformed input. Reaching the traversal bound before a malformed
value keeps the bounds refusal. Preparation reports a plain JSON history that
fails Knowledge replay as `invalid-definition-history`; failure of the initial
whole-input JSON copy remains `invalid-definition`. An adopted
body must equal `JSON.stringify(definition, null, 2)`, as produced by the preparation
function, and retain category `decision-rationale`, captured origin and locator
`decision-practice:<definition id>`. Invalid, duplicate-key or noncanonical bodies
return `invalid-definition`. A parsed adopted body outside the portable profile
instead returns `practice-input-exceeds-bounds`.

`evaluateDecisionPractice` returns `proceed`, `stop`, `escalate` or `refuse` with a
typed reason. It checks declared prerequisites and count budgets, current exact
evidence snapshots, text digests, and the existing decision request/result
binding. Its initial internal profile maps one choice question to the three
non-refusal outcomes. Other question forms may inform the supplied assessment,
but no general expression language, workflow execution or confidence threshold
is introduced. Model confidence does not establish correctness or authority.

Request state must be exactly the request's evidence, in request order, using
`<evidence id>: <exact text>` lines. Every request field except `id`, `state` and
`evidence` must match the adopted specimen, including optional contract version
and extensions. Each new evidence pin contains exactly `id` and `sourceRef`, with
no extensions. The supplied result must validate against the exact
new request digest. No provider is called or qualified by this module. An
abstention escalates. Missing/stale evidence, unknown prerequisites, changed or
unadopted definition, exhausted budgets, unsupported proposals and invalid rubric
results refuse. A proposal cannot target its own definition, review or current
activation. This protects the current definition and its reviews/activation;
a superseded predecessor contribution is still an eligible reconsideration target.

Count budgets are caller-reported consumption plus this assessment's declared
requirements; they do not measure provider use, elapsed time or durable lifetime
usage. The host must maintain those facts. Snapshots and records are supplied by
the caller; their actual authority, authenticity and freshness remain host proof.
The pure evaluator checks the complete supplied assessment envelope before a
false prerequisite returns `stop`. It never obtains that assessment itself.
A host that can stop before calling a provider should precheck prerequisites
there; this module does not prove that provider work or cost was avoided.
Malformed snapshots or timestamps also return `stale-evidence`: they cannot
establish currency. `sourceRef` is a caller-supplied label; the host must bind it
to the source resolved by exact retrieval.

A proceeding outcome prepares an ordinary captured Knowledge contribution draft.
Its body pins the definition, activation, reconsideration target, exact evidence,
request digest and supplied assessment. Both preparation functions validate the
completed draft against the existing Knowledge contribution shape before returning
it. Pretty-print expansion beyond the writer's body limit returns
`practice-output-exceeds-bounds` with no draft. This shape check uses a fixed
validation-only envelope; it establishes no native record or actor authority.
Definition preparation also checks the operating core: the complete supplied
history, new draft data including its escaped body, and the repeated full rubric
must fit the portable profile with 8,192 UTF-8 bytes reserved for additional
adoption/instance metadata. Otherwise it returns `practice-output-exceeds-bounds`.
This rejects definitions whose necessary repetition can never fit; it does not
guarantee arbitrary future history, evidence, assessment or metadata will fit.
The host must still validate the complete actual operating input before adoption
and execution. A Knowledge-valid body alone proves no operating capacity.
The assessment includes supplied provider/model/usage/extensions verbatim at the
domain audience. Its inherited `rightsBasis` remains a declaration. The host must
verify rights/consent and the full draft's permitted disclosure before review or
append; this module does not sanitize an assessment or establish those permissions.
It does not supersede the target, accept
or activate knowledge, change native decision status, or write a file. A stale
decision may be the subject of reconsideration; it is not smuggled into the
draft's accepted `basedOn` dependencies. The receiving reviewer must revalidate
the embedded references before adopting any resulting contribution.

The invented journey changes a captured source, observes the existing Knowledge
harness's dependent decision reconsideration, rejects the old local-reader
handle, retrieves fresh exact evidence from a new explicit ingestion plan and
prepares a separate draft. On the existing qualified POSIX reference profile, the simulated host explicitly
appends that draft; it remains unaccepted and the original decision remains
marked for reconsideration. Windows completes the same source-change, exact-read
and pure-evaluation journey, then verifies the existing capability store refuses
its write and leaves no harness history. The platform refusal does not skip the
portable evidence or proposal checks.
Fixtures contain simulated reviews and an invented supplied assessment. They
establish no model quality, native actor or consent proof, Runtime database
binding, real supported-consumer acceptance, integration review or deployment.
