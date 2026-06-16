# Repo Boundary Guard V1

Repo Boundary Guard V1 is the Atelier workspace convention for separating
private domain source from shared Mystery source before anything reaches the
MNSTRY runtime.

## Boundary Model

- Private domain material lives in one private Git repository per user.
- Shared Mystery material lives in shared project repositories.
- Git repository access is the source read boundary.
- `kg.audience` is local projection metadata, not a permission system.
- Runtime/export `visibility` remains reserved for MNSTRY runtime objects.

If a file is private, place it in the user's private domain repo. Do not rely on
front matter, generated projections, readiness output, browser views, or local
HTML hiding to protect source material inside a shared repo.

## Guard Rules

- Private or sensitive source belongs in a repo with `readBoundary: "private"`.
- Shared Mystery source may use `team`, `operator`, `staff`, or `public`
  audiences when the repository readership matches that exposure.
- Local source metadata must use `kg.audience`.
- Local source metadata must not use `kg.visibility`.
- Dry-run exports may contain runtime `visibility` only on export/runtime
  objects.
- Generated outputs are projections and should be reproducible from source.

## Non-Goals

Repo Boundary Guard V1 does not:

- create, invite, or permission GitHub users;
- move files between repositories automatically;
- write to the MNSTRY runtime;
- send telemetry;
- contact cloud services;
- mutate browser state or write directly from a browser view.

## Review Checklist

Use this as a defensive review before copying preview content into real repos:

- Every private user has exactly one private domain repo entry.
- Private domain repos use `readBoundary: "private"`.
- Shared Mystery repos do not contain private or sensitive source nodes.
- `rg -n "kg.visibility|visibility:"` over source files finds no local source
  front matter misuse.
- `repo-access.v1.json` covers every repo listed in `atelier.project.json`.
- Generated `atelier-output/` files are not treated as source authority.

When in doubt, fail closed: move the source into the private domain repo first,
then project a reviewed summary into shared Mystery material later.
