This package makes three promises. None of them asks for your trust — each
one names the command that proves it.

**There is no silent egress; every network path is named.** There is no
telemetry, update check, crash reporting, managed-runtime upload, or model
provider path in the package. The exceptions are explicit: `boundary check`
may invoke `gh api user` after no declared actor matches an explicit `--actor`,
`MNSTRY_ATELIER_ACTOR`, `GITHUB_ACTOR`, or a configured Git email; repository
identity checks may invoke `gh api repos/...` to resolve a canonical GitHub
identity. Those authenticated requests use your own `gh` credentials. A
recognized explicit actor prevents the boundary actor fallback; recorded
repository identities let identity checks keep working when the provider is
unavailable. Explicitly enrolled Atelier Sync may also run bounded Git fetches
for observation/reconciliation and one non-force push only when the exact
reviewed commit plan requested and confirmed it. The package's HTTP client
refuses non-loopback URLs, the served pages authorize no external origin, and
release audit scans every executable or markup file in the exact `npm pack`
inventory for egress primitives. The standalone gate also scans executable and
markup files under `src/`, `bin/`, `scripts/`, `templates/`, `examples/`, and
`skills/`. Two limits worth stating plainly: the egress control does not
interpret data-only `.json` or `.md` files, and it does not model
`child_process`; the reviewed `gh` and enrolled Git paths above are documented
subprocess exceptions rather than scanner detections:

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
