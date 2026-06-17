# Changelog

## 0.1.0-alpha.2

- Adds bundled `mnstry-readiness-pack@v1` with twelve claim-first readiness
  protocols for MNSTRY tenant preparation.
- Adds readiness protocol and readiness run contracts with AJV fixtures.
- Adds `atelier readiness protocols`, `journey`, `run`, `packet`, and
  `export --dry-run` commands.
- Adds tenant-readiness journey data to generated local projections.
- Adds neutral Codex and Claude readiness skill wrappers.
- Keeps readiness output local, proposal-first, non-importing, non-mutating,
  no-send, and free of project-specific package content.

## 0.1.0-alpha.0

- Introduces the alpha `@mnstry/atelier` package.
- Adds the `mnstry atelier ...` and `mnstry-atelier ...` local CLI entrypoints.
- Adds `atelier-export@v1` schema validation.
- Adds dry-run validation for export artifacts.
- Adds fictional sample fixtures and fail-closed negative fixtures.
- Keeps runtime import, runtime mutation, telemetry, and external egress out of
  scope.
