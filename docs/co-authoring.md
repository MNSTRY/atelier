# Co-authoring with agents

A body of work is authored together, in the structure of the work itself
rather than in a document tool or an email thread. People read and question
the pages. Agents draft from the graph and the questions. Where the checks
run in the commit path, every change, by a person or an agent, passes the
same checks, and that is what makes the agentic
process (an agent acting inside a governed workflow) reliable.

This page describes the loop, the record it leaves, and what has to be in
place for it to hold. The files are yours. The package supplies the graph,
the checks and the collaboration records. The harness supplies the agent.
Nothing here changes what the package will and will not do to a source:
README section 4, "The local runtime serves people and agents", states that,
and the will-not-do block states the rest.

## The loop

Three actors take part: a person, an agent running in the harness, and the
package. In this loop the package records, checks and refuses; the edit and
the commit are the agent's or the person's.

1. **A person asks on the page.** A reader selects the sentence they mean on
   the projected page and leaves a question, a correction or a discussion. The
   review surface (the package's optional `atelier dev --review`, or a
   consumer adapter built on the collaboration ledger) records the note and
   pins it to that passage and to the digest of that revision of the source.
2. **An agent drafts from the graph.** In the harness it reads the open
   questions on the file, follows the graph to every file declared to depend
   on it, and edits those files in the working tree. Where they are wired in,
   the graph check and the boundary guard run against its work as they would
   against anyone's.
3. **A person decides, and the change lands.** The person reviews the draft
   and, where the workflow records decisions, records one with its rationale.
   The package does not require or check a decision before a commit. The
   person or the agent commits the change through the boundary guard, and the
   graph and the pages built from it follow on their next build.

The next question starts from the updated source.

## Provenance is built in

The review store pins notes and reading positions to a document's digest and
the passage they address, and binds decisions to the evidence they judged.
A contribution made against a stale version is refused. A later decision
supersedes an earlier one, and the history keeps both. Each record carries the
name its author gives, which the package records as locally asserted, not
authenticated. `docs/local-review.md` describes the store and its refusals. When the source changes, earlier notes stay pinned to
the wording they addressed, so "what has been questioned about this passage"
is a lookup, not a memory.

A change by an agent passes the same checks as a change by a person: the graph
check and the boundary guard, where they are wired in. A team that wants every
change to carry a recorded decision adds that rule to its own workflow; the
package does not enforce it.

## Giving an agent a job

This section describes the system (the package with a harness and connected
tools), not the package alone.

You define the outcome and constraints. An agent uses the relevant files,
works through the task with connected tools and returns work to review.
Approved changes become part of the shared record for the next task. The
agent's instructions (its skill and the harness's permissions, not a package
gate) specify which records it may use, what it may change and when approval
is required.

The team defines a goal and reviews a proposed plan before the agent starts,
then reviews the outputs and approves consequential actions. Accepted changes
update the shared knowledge, so the next task starts from the latest agreed
material rather than from a fresh briefing.

What has to be connected: the agent, access to the relevant files, and
whatever other tools the chosen workflow uses,
plus agreed review responsibilities and action permissions. The package
organizes source material and review contributions; agent execution and
external delivery are integrations you configure in the harness.

## What the loop rests on

- **A harness with the skills installed.** `atelier skills sync` installs the
  package's skill files into the workspace from a digest-confirmed plan (by
  default from the package's `skills/codex` into `.agents/skills`; `--source`
  and `--target` change that). Whether a harness discovers and follows them
  is the harness's matter. See `docs/skill-steward.md`.
- **Gates in the commit path.** The boundary guard hooks
  (`atelier boundary install-hooks`) and the graph check in CI. The sentence
  "every change passes the same checks" is true where the checks run on every
  commit.
- **A contribution surface.** The package's loopback projection carries the
  page and its passages. Notes and decisions are recorded by the package's
  optional review workspace (`atelier dev --review`, described in
  `docs/local-review.md`) or by a consumer adapter built on the collaboration
  ledger; `docs/coauthor-session.md` describes the
  experimental portable session reducer. Neither applies a source change; the
  agent in the harness does, and the checks run against it.
- **Examples with expected results.** By convention, each round of authoring
  adds reviewed examples with expected results beside the rules they test. The
  package keeps them and their links in the graph; it does not run them. An
  agent in the harness runs them against its drafts, and because they stay in
  the record, a later draft can be checked against the same cases.

## What the package does not do here

It does not draft. It does not apply a proposal to a source. It does not
grant an agent write access. It does not decide. It records the question,
checks the change, and records a decision when one is given, and it refuses
a contribution made against a stale version. The rest is the harness's work
and the people's.
