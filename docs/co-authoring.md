# Co-authoring with agents

A body of work is authored together, in the structure of the work itself
rather than in a document tool or an email thread. People read and question
the pages. Agents draft from the graph and the questions. Every change, by a
person or an agent, passes the same checks and carries its receipt, and that
is what makes the agentic process (an agent acting inside a governed workflow)
reliable.

This page describes the loop, the record it leaves, and what has to be in
place for it to hold. The package supplies the files, the graph, the checks
and the collaboration records. The harness supplies the agent. Nothing here
changes the boundary stated in the README's will-not-do block.

## The loop

1. **A person asks on the page.** A reader selects the sentence they mean on
   the projected page and leaves a question, a correction or a discussion. The
   note is receipted and pinned to that passage and that revision of the
   source.
2. **An agent drafts from the graph.** In the harness it reads the open
   questions on the file, follows the graph to every file declared to depend
   on it, and revises those files. The graph check and the contracts run
   against its work as they would against anyone's.
3. **A person decides, and the change lands.** The decision carries a reason
   and is refused if a newer question has arrived on the same passage.
   Accepted, the change is committed with its receipt, the graph is rebuilt,
   and the pages built from it follow.

The next question starts from the updated source.

## Provenance is built in

Every contribution and decision is a revision-pinned record: who, on which
document at which revision, anchored to which passage, with the reason given.
The original contribution stays beside every later decision about it. When
the source changes, earlier notes stay pinned to the wording they addressed,
so "what has been questioned about this passage" is a lookup, not a memory.

A change by an agent is governed the same way as a change by a person: the
graph check, the contracts, the audience boundary and a recorded decision.
That is what makes it reliable to let many people and agents work on the same
record.

## Giving an agent a job

You define the outcome and constraints. An agent uses the relevant files,
works through the task with connected tools and returns work to review.
Approved changes become part of the shared record for the next task. The
agent's instructions (its skill and the harness's permissions, not a package
gate) specify which records it may use, what it may change and when approval
is required.

What changes for a team is less repeated briefing and coordination. The team
defines a goal and reviews a proposed plan before the agent starts, then
reviews the outputs and approves consequential actions. Accepted changes
update the shared knowledge, so the next task starts from the latest agreed
material. Measure the value through time to an approved result and the amount
of rework.

What has to be connected: the agent, access to the relevant files, and
whatever website, email, booking or practice tools the chosen workflow uses,
plus agreed review responsibilities and action permissions. The package
organises source material and review contributions; agent execution and
external delivery are integrations you configure in the harness.

## What the loop rests on

- **A harness with the skills loaded.** Claude Code or Codex opened on the
  repository, with the package's skills installed by `atelier skills sync`
  from a digest-confirmed plan. See `docs/skill-steward.md`.
- **Gates in the commit path.** The boundary guard hooks
  (`atelier boundary install-hooks`) and the graph check in CI. The sentence
  "every change passes the same checks" is true where the checks run on every
  commit.
- **A contribution surface.** The package's loopback projection carries the
  page and its passages; the note-taking and decision surface is a consumer
  adapter built on the collaboration ledger. `docs/local-review.md` describes
  the optional review workspace, and `docs/coauthor-session.md` the
  experimental portable session reducer. Neither applies a source change; the
  agent in the harness does, and the checks run against it.
- **Examples with expected results.** Each round of authoring adds reviewed
  examples, and those become the evals an agent runs against its own drafts.
  The agents improve as the record does, and the record shows it.

## What the package does not do here

It does not draft. It does not apply a proposal to a source. It does not
grant an agent write access. It does not decide. It records the question,
checks the change, and records the decision, and it refuses a decision made
against a revision that has moved on. The rest is the harness's work and the
people's.
