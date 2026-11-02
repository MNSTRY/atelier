# Source-bound ontology guidance

The experimental internal ontology guide prepares a private proposal for the
existing knowledge workspace. It starts with a decision and preserves concept
identity, exact source passages, directed relationship meaning and uncertainty.
It does not edit a plan or source, confirm a participant answer, accept a mapping,
or execute a decision.

This module is not a supported package export or a new browser route. Existing
knowledge-plan v1 files, the five knowledge views, sessions and package interfaces
are unchanged. Maintainers can inspect its behavior with:

```sh
node --test test/ontology-guide.test.mjs
```

## One guided loop

Choose a question in the current plan, then answer seven prompts:

1. What decision will this help?
2. What is the thing you are naming?
3. How would you recognize the same thing next week?
4. What close example should stay separate?
5. Which source supports it?
6. What does the relationship mean in each direction?
7. What would change your mind?

For an existing corpus, select bounded permitted evidence through the current
knowledge context. For a blank workspace, retain its enrolled source directory
and begin with a permitted observation/interview note or an explicit unknown.
A synthetic practice observation remains labelled synthetic. An absent or broken
enrollment is a source configuration error; it cannot establish an abstention.
Both routes lead to source-owner review and a proposed next decision or test.
Observed outcomes belong in Learn after they exist.

The seven prompts map to the four existing Model fields: `concept`, `identity`,
`relation` and `test`. A host should use the existing session answer/propose,
confirmation and private-save operations. The guide returns wording; it does not
send those operations. A saved draft remains a proposal. Agent-written wording
still requires the existing explicit participant confirmation before saving.

## Identity, evidence and limits

Choose concepts by their existing IDs. Definitions, stable identity rules and
`concept:` tags remain in the v1 plan. Examples, near misses, distinction
rationale and disconfirming observations stay in private proposal metadata;
they do not widen the closed plan schema. Identical definitions or identity
rules require an explanation of how the concepts differ. Similar labels or
aliases never establish identity. This small check cannot detect every semantic
ambiguity; a reviewer still judges the proposed definitions and examples.

The guide reads context through the existing local knowledge workspace. Evidence
must match a unique selected source ID, its current full-file digest, a valid
line range and its exact text. The handoff retains repo/path, digest, locator
and passage, including qualifications. A source or plan change requires a new
binding; earlier evidence and drafts remain historical. This is local-operator
source binding, not a recipient permission check or hosted access decision.

Explain each required relation using its existing forward predicate and both
endpoint concepts. A reverse reading helps a person understand the original
relation; it creates no inverse assertion. Evidence retrieval cannot establish a
business claim, certainty or semantic truth.

A proposed answer can say `supported` or `abstain`. These are the participant's
proposed labels. `ready-for-human-review` checks draft completeness and source
binding only. It does not certify that the answer is supported. Require stated
scope and uncertainty, alternative explanations, and what could change the
answer. Missing evidence suggests narrowing the claim or abstaining. Omitted
sources remain explicit in the handoff; an abstention with omissions is marked
`unverified-omissions`, so it cannot imply corpus-wide absence of evidence.

## Review handoff

The internal `createOntologyGuide()` adapter reads an already-loaded local
workspace and a current question ID:

- `prompts(workspace, questionId, entry)` returns ordered guidance for `corpus`
  or `blank` entry and the existing view/Model field for each step.
- `inspect(workspace, questionId, draft)` returns field-specific next actions,
  verified source passages and retained retrieval limitations.
- `prepareReview(workspace, questionId, draft, {basePlanText, planRef})` returns
  an input body for the existing copy-only proposal store, or diagnostics.

`draft` retains the workspace snapshot, raw base-plan SHA-256, entry route,
decision, exact concept IDs with examples/counterexamples and identity basis,
required relation readings, selected evidence pins, proposed answer/limits and
disconfirming observation. An optional `proposedPlan` must still validate as v1.
The source owner reviews changes before any canonical admission.

The handoff binds exact raw plan bytes, retains complete before/proposed text
and structural changes, and uses `proposal.copy-only` with `directWrite: false`
and no apply endpoint. Oversize handoffs refuse with a request to narrow the
change, before the existing store can truncate them. The guide never calls the
store or persists a second draft ledger. A host explicitly supplies the body to
the existing proposal workflow after reviewing the private audience.

Review and source edit remain separate. The source owner inspects the exact diff,
checks identity and passage meaning, applies an admitted change using the normal
Git path, reruns knowledge check/evaluate, then starts a newly bound session.
No source pin is replaced automatically to clear a failed check.

Cross-repository concept mappings remain proposals preserving both source
identities. Conversion to an edge-governance record requires the allocated
stable repository/source descriptor, exact current source revisions and raw
byte locators, plus the receiving review policy. This internal guide does not
invent those values, emit accepted equivalence or activate a semantic edge.

The synthetic tests exercise software behavior on the invented equipment library.
They do not demonstrate a cold participant's comprehension, answer correctness,
host ACL behavior or a completed human corpus/blank-start drill.
