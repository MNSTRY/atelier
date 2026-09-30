# AGENTS.md — MNSTRY Atelier

> Primary instructions for agents working in the public Atelier repository.

## Scope

This repository is the public, Apache-2.0 Atelier kit. It contains portable
contracts, validators, templates, documentation, synthetic fixtures, and agent
skills. Client and tenant repositories are separate trust domains.

## Responsibility and runtime architecture

Use `docs/architecture.md` and the validated responsibility catalog to distinguish
responsibilities, harnesses, roles, capabilities, resources, methods, records and
hosts. Reuse the existing owner of each fact and transition. Skill Steward belongs
within Capability Stewardship; Companion and Witness share the host's existing
conversation authority. Reflection remains optional.

Behavioral authoring must identify its consumer and supported profile. Share
domain rules between preview and execution, pin adopted definitions, and verify
actual writes and readback. Preserve source evidence, situated judgment, native
ADR authority and independent repository adoption. Context delivery, model
behavior, native host acceptance and release are different proof obligations.
Use the relevant bundled operating skill and document unsupported host bindings.

## Public-source boundary

- Never copy client names, source material, product structures, private
  methodology, correspondence, media, transcripts, operational paths, or
  identifying details into this repository, including tests, fixtures,
  comments, branch names, and commit messages.
- When a client implementation reveals a reusable lesson, re-derive only the
  mechanism or invariant. Keep ports, paths, field names, content, brands, and
  examples in the client adapter. Exercise the public mechanism with invented
  fixtures.
- Treat neutral wording as insufficient evidence of safety. Before staging,
  confirm that the structure itself does not reproduce a client's proprietary
  method or information architecture.
- Private disclosure patterns belong only in the maintainer-held CI secret or
  an ignored local denylist. Never commit the patterns or matched content.

Read `CONTRIBUTING.md` and `docs/release-engineering.md` before changing a
public surface. Changes to disclosure, egress, boundary, or release guards need
an evidence-backed defensive review and regression tests.

## Portable local services

For a repository-backed authoring or review surface that must outlive an agent
command, use the contract in `docs/local-services.md` and the
`atelier-local-service` skill. The shared kit owns lifecycle and safety
invariants; a consuming repository owns its service identity, port, commands,
state schema, content, and user-facing copy.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run repo:check -- --staged` | Scan staged content with the maintainer-held denylist. |
| `node --test test/disclosure.test.mjs` | Prove the shipped consumer disclosure command in isolated synthetic repos. |
| `npm run syntax:check` | Parse-check executable modules. |
| `npm test` | Run the complete regression suite. |
| `npm run release:audit` | Inspect the exact public tarball allowlist and content. |

If the private denylist is unavailable, a structural-only run may inform local
work but is not a complete disclosure verdict. Do not claim the public boundary
is green until the private lane passes.

## Closeout

Before committing, inspect the staged blob rather than trusting the working
tree, run the repo disclosure gate and the consumer-command regression test,
and verify the exact diff and tarball. A clean test suite does not authorize
publication or replace maintainer review.
