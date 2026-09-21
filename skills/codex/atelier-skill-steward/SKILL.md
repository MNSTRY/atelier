---
name: atelier-skill-steward
description: Audit, create, improve, reconcile, retire, or update an Atelier-backed agent skill catalog using evidence thresholds, behavioral checks, and reversible managed projections.
---

# Atelier skill steward

Use this skill when a repository should maintain its agent skills as a coherent,
self-improving catalog. Do not use it to turn a one-off preference into a skill,
capture prompts or transcripts, or grant a skill new authority implicitly.

## Publish and govern capabilities

For portable capability packages and multiple publishers, use `atelier capability`
from a release that exposes it. Check `atelier capability help` first. Keep an
older installed steward on its supported catalog commands until the package is
upgraded; do not invent missing commands.

- Inventory explicitly selected personal, organization, repository, nested and
  plugin skill surfaces. Preserve unknown host resolution and unavailable tools.
- Choose reference, managed, customized or retired adoption per repository.
  Existing skills keep their owner; choose aliases and inspect overlap instead
  of automatically merging, replacing or uninstalling them.
- Author a standard, self-contained skill bundle and a capability package
  descriptor with stable identity, inputs, outputs, requirements, exact
  dependencies, evaluation evidence and limitations. Seal the local release and
  verify its complete payload before distribution through an authorized channel.
- Review publisher provenance separately from digest integrity. A declared
  identity, copied bundle or passing schema does not authenticate a publisher or
  demonstrate behavioral quality.
- Keep desired pins in the repository's adoption file. Review the exact adoption
  plan and requirement delta before apply. Supplied tool observations and allowed
  effects never grant runtime permissions. Preserve local customization, refuse
  unmanaged collisions and inspect recovery before retrying interrupted writes.
- Validate discovery in the intended host session, then exercise representative
  positive, negative and incomplete requests. Record only version-bound metadata
  and an evidence digest with `capability observe`. Distinguish installation,
  reported discovery, exercise and human acceptance.
- Use `capability candidates` for cause-specific review and `capability fleet`
  for explicitly selected repositories. Tool or host failures are not evidence
  that skill instructions need rewriting. Low usage alone is not retirement.
- Emit draft graph records with `capability graph`, review their audience and
  destination, and use the repository's normal authoring and graph validation.
  Graph ingestion never grants authority or accepts an interpretation by itself.

Use the existing catalog workflow below for unversioned local observations and
one-source projections. Its candidates remain review proposals, not acceptance.

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
