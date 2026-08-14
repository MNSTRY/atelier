This package makes three promises. None of them asks for your trust — each
one names the command that proves it.

**Nothing leaves your machine, with one exception you can see.** There is no
telemetry, no update check, no crash reporting, and no send path anywhere in
the package. The exception: when no actor is configured, `boundary check` and
`doctor` fall back to the `gh` CLI to resolve your GitHub login, which is an
authenticated request to GitHub made with your own credentials. Set
`MNSTRY_ATELIER_ACTOR` and that path is never taken. The only network client
refuses non-loopback URLs, the served pages carry a policy that authorizes no
external origin, and a fail-closed gate scans the executable and markup files
under `src/`, `bin/`, `scripts/`, and `examples/` for egress primitives. Two
limits worth stating plainly: the gate does not read the `.json` and `.md`
files under `templates/` and `skills/`, and it does not model
`child_process`, which is why the `gh` fallback above does not trip it:

```bash
npm run egress:check
```

**Compatibility is checked by machinery, not memory.** Documents valid
against the `v0.2.0-alpha.0` contracts stay valid: every change is checked
against the baseline tag's validators, and schema widening outside `ext`
containers is refused by a schema-vs-schema differ. Breaking changes require
a new contract version and a recorded migration. Known limit: the differ
compares schemas structurally and does not resolve `$ref` pointers, so a
`$ref` retargeted at a looser definition is not caught by this gate — the
fixture tests catch that for contracts with negative fixtures, and closing
the gap in the differ is tracked work:

```bash
npm run contract:compat
```

**Conformance works offline, forever.** Validating a document against the
published contracts needs this package and nothing else — no account, no
service, no network:

```bash
atelier dry-run ./atelier-export.json
```

`docs/continuity.md` records the distribution commitments behind these
claims, including the perpetual Apache-2.0 grant on every tagged release you
receive.
