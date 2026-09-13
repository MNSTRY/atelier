---
name: atelier-skill-steward
description: Audit, create, improve, reconcile, retire, or update an Atelier-backed agent skill catalog using evidence thresholds, behavioral checks, and reversible managed projections.
---

# Atelier skill steward

Use this skill when a repository should maintain its agent skills as a coherent,
self-improving catalog. Do not use it to turn a one-off preference into a skill,
capture prompts or transcripts, or grant a skill new authority implicitly.

## Route the work

- Audit the current catalog with `atelier skills audit --json`.
- Record only a content-free signal with `atelier skills observe`; use a stable
  workflow key, enumerated signal, optional skill name, and outcome. Never put a
  summary, prompt, source excerpt, person, client, or private method in the key.
- Find evidence-thresholded work with `atelier skills candidates --json`.
- Create or improve an authored skill only when the candidate evidence and the
  current task establish a repeatable input, workflow, and success condition.
- Update a repo-scoped deployed catalog with `atelier skills sync`. Review the
  plan, then repeat its exact digest with `--apply --confirm`. Never manufacture
  confirmation before inspecting blockers and actions.

## Authoring boundary

Keep each skill focused. Give `SKILL.md` lowercase kebab-case `name` and a
discriminating `description`; put only decision-changing guidance in the body.
Add scripts or references only when deterministic reuse or progressive
disclosure justifies them. Test direct triggers, indirect triggers, incomplete
inputs, non-triggers, and risky edge cases.

In the public Atelier repository, read `AGENTS.md`, `CONTRIBUTING.md`, and
`docs/release-engineering.md` before editing. Re-derive private lessons as
generic invariants with invented fixtures. Keep Codex and Claude bundles
byte-identical and run the repository disclosure and release gates required by
those documents.

## Promotion policy

An instruction-only change that retains the same tools, data boundary, and
external authority may advance after its behavioral checks and catalog audit
pass. New scripts, tool dependencies, network access, filesystem scope,
external messages, spending, destructive operations, credential handling, or
audience changes require explicit human authorization immediately before that
authority is introduced.

Do not treat an audit pass as proof of behavioral quality. Compare the candidate
against representative positive and negative requests. Reject it when it only
memorizes one incident, broadens its trigger, weakens a refusal, or cannot name
observable improvement.

## Retirement and updates

Remove obsolete skills from active discovery only after checking dependents and
supersession. Preserve recovery through Git or the sync quarantine; never
permanently delete a managed deployed bundle during sync. A locally drifted or
unmanaged target is a blocker, not permission to overwrite it.

The steward has no model provider, telemetry, send path, browser apply endpoint,
or hidden source-mutation authority. Scheduling may invoke this workflow, but a
schedule does not widen its permissions or lower its evidence gates.
