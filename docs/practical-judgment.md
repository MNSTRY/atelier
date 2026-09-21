# Practical Judgment and practice adoption

Practical Judgment supports deciding what matters and what is fitting in a
particular situation. It also supports cultivation: contrasting cases, warranted
exceptions, questions, distinct voices and reflection on consequences. A useful
deliberation can remain open or produce an action without producing a rule.

`@mnstry/atelier/judgment` validates portable cases and native architecture
decision snapshots. `inspectPracticalCase` preserves purpose, values, evidence,
alternatives, dissent, cultivation exercises and reconsideration conditions.
It does not score wisdom. The invented workshop fixtures demonstrate an open
deliberation and a decision whose implementation is still planned.

## Architecture decisions

`importArchitectureDecision({decision, sourceText})` verifies a declared native
source digest. Repository identity, ADR identity and source location stay intact.
The adapter does not allocate ADR numbers, authenticate an approver or infer
implementation from acceptance. Decision status, implementation evidence and
evidence currency remain separate. `renderArchitectureDecision` produces a
readable snapshot; its text does not replace the source repository's native form.

`prepareJudgmentContribution` preserves the typed case or decision inside an
ordinary Knowledge contribution. Review and activation still use the existing
Knowledge writer. `createJudgmentDependency` revalidates that typed payload and
the accepted contribution before issuing the existing Build handoff. Decision
imports additionally require matching native source bytes. The resulting
handoff retains the native states; it grants no implementation or approval
authority. Revisions use new Knowledge contributions and normal supersession,
review and dependency reconsideration. Do not change an old record in place.

## From feedback to intrinsic practice

The [learning lifecycle](learning.md) captures an observation, proposes a scoped
lesson, records an exact decision, then activates the accepted version for a
named harness. `capabilityEventToLearningInput` bridges version-bound capability
metadata into that lifecycle. It retains the reported cause, binding, release,
session and evidence digest. It neither invents a user quotation nor certifies
causality. A harness feedback wrapper can preserve causes that the older
capability event vocabulary cannot express.

For accepted instruction artifacts, use `atelier practice plan`, inspect the
returned text and exact plan digest, then `practice apply`. Requests are JSON
on stdin in the intended Git repository. Private state must be ignored under
`.atelier-local/`. The request names `workspaceId`, `scope`, `harnessId`,
`lessonId`, `target`, `slot` and `mode` (`adopt` or `retire`). Apply additionally
names `confirm`, the current plan digest.

The reference profile manages one marked block in a scoped `AGENTS.md` or
`CLAUDE.md`. It preserves surrounding text, states applicability and exceptions,
and leaves instruction precedence and tool permissions with the host. Skills
continue through capability releases and Skill Steward; checks remain inert
until an owning implementation explicitly realizes them. This adapter does not
execute a lesson as code or update arbitrary configuration files.

Planning binds the complete current destination bytes and learning selection.
Applying refuses local drift, unowned slots, changed scope, ambiguous markers
and ineligible learning. The POSIX reference adapter uses non-overwriting
creation or the existing atomic file-exchange primitive. Displaced bytes remain
in private recovery storage. Unavailable exchange or volume mismatch refuses.
An interrupted operation is inspected with `practice status` and resumed with
`practice recover` using the pending plan digest. Concurrent changes remain
visible for reconciliation. If the source differs from both planned states,
`practice abandon` can retain the journal and recovery bytes without editing the
source. It requires the plan digest and the current destination digest reported
by status. Then prepare a new plan. Applied changes must be reconciled before
retirement; never delete recovery state to force an apply.

`practice context` takes target, slot, session, scope and harnessId. It returns
only current selected guidance and writes a context-delivery receipt. The
receipt means that the calling consumer received those exact bytes. A host must
actually integrate this seam; it does not establish that an agent obeyed them.
Assess changed behavior with applicable and inapplicable tasks afterward.

Withdrawal immediately excludes future calls through this context API. A
previously written instruction file still needs an explicit retirement plan.
`practice status` reports that discrepancy. A host that reads the file directly
does not inherit live withdrawal checks automatically. Separate repositories
make separate adoptions; another repository's customization is preserved.

## Open core and host responsibilities

All local inspection, adoption, history and recovery are usable without a hosted
account. Identity assertions and digests establish local consistency, not remote
authentication. Production hosts supply their own identity, access, scheduling,
actual conversation delivery and durable runtime acceptance. Personal or private
learning is not implicitly exported to a public graph or capability package.
