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

`evaluateDecisionPractice` returns `proceed`, `stop`, `escalate` or `refuse` with a
typed reason. It checks declared prerequisites and count budgets, current exact
evidence snapshots, text digests, and the existing decision request/result
binding. Its initial internal profile maps one choice question to the three
non-refusal outcomes. Other question forms may inform the supplied assessment,
but no general expression language, workflow execution or confidence threshold
is introduced. Model confidence does not establish correctness or authority.

Request state must be exactly the request's evidence, in request order, using
`<evidence id>: <exact text>` lines. Task, rubric version, questions and scope must
match the adopted specimen. The supplied result must validate against the exact
new request digest. No provider is called or qualified by this module. An
abstention escalates. Missing/stale evidence, unknown prerequisites, changed or
unadopted definition, exhausted budgets, unsupported proposals and invalid rubric
results refuse. A proposal cannot target its own definition, review or current
activation.

Count budgets are caller-reported consumption plus this assessment's declared
requirements; they do not measure provider use, elapsed time or durable lifetime
usage. The host must maintain those facts. Snapshots and records are supplied by
the caller; their actual authority, authenticity and freshness remain host proof.

A proceeding outcome prepares an ordinary captured Knowledge contribution draft.
Its body pins the definition, activation, reconsideration target, exact evidence,
request digest and supplied assessment. It does not supersede the target, accept
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
