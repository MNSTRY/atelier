# Distributions

A distribution is a branded wrapper package around `@mnstry/atelier`. It gives
a partner or program its own command name, display name, and look while the
MNSTRY Atelier package underneath keeps doing all of the work. This document
describes the model, the one invariant every distribution must hold, the
attribution requirement, and how to build one.

## The three-tier model

1. **Root package** — `@mnstry/atelier`. Owns every command, contract,
   validator, and the bundled MNSTRY readiness pack. Published and versioned by
   MNSTRY.
2. **Distribution wrapper** — a small npm package (for example Loomworks
   Studio) that depends on the root package, ships a branded bin, and may add
   extension packs, skills, and projection branding. It never modifies the
   root package.
3. **End workspace** — what a user of the distribution initializes and works
   in. Workspaces created through a distribution are ordinary Atelier
   workspaces; nothing about them is fork-specific.

Because the wrapper is a dependency edge and not a fork, upgrading a
distribution is `npm install` of a newer root package, and every root gate
(contracts, boundary rules, egress checks) applies unchanged.

## The invariant

Add and rebrand, never alter root semantics.

A distribution may add commands of its own, add extension packs, add skills,
and restyle the projection. It must not remap or shadow root commands, replace
or edit bundled readiness protocols, or alter the bundled MNSTRY pack in any
way. Extension packs are the additive path: namespaced protocols load
alongside the bundled twelve, they never substitute for them. A wrapper that
changes what a root command means is a fork, not a distribution.

## Attribution requirement

Distributions must carry MNSTRY attribution. The normative wording of this
requirement lives in `TRADEMARKS.md` under "Required attribution" — this
document deliberately does not restate it, so the two cannot drift. See also
`docs/attestation.md` for how admission decisions are recorded.

Mechanically, attribution has three surfaces:

- **CLI output — automatic.** `runCli` renders the attribution line in
  `--version` and `--help` output for any non-default brand. A wrapper that
  dispatches through `runCli` does not need to print anything itself.
- **Distribution README — blocking.** The distribution's root `README.md`
  must contain the exact byte string `powered by MNSTRY Atelier`. Surrounding
  text is free.
- **Pack manifest — advisory.** An extension-pack manifest should declare
  `"ext": { "mnstry.atelier/attribution": "powered by MNSTRY Atelier" }`.
  The `mnstry.atelier/attribution` key is distinct from the `mnstry.atelier`
  container used for projection branding.

`atelier distribution check` verifies the last two: the README byte string is
blocking (exit 1 when absent), the manifest key is reported but never blocks.
Run it from the distribution root, or point it elsewhere with `--target DIR`;
`--pack DIR` overrides the default `packs/*/atelier.pack.json` manifest
lookup. Exit codes: 0 checks passed, 1 blocking attribution failure, 2 usage
error.

## Building a distribution: the Loomworks walkthrough

The reference distribution, Loomworks Studio, lives at
`examples/loomworks-studio/` in this repository; the steps below are the
complete recipe it follows, and `npm run distribution:smoke` runs that recipe
against a packed tarball on every publish. Paths are relative to the wrapper
package root, for example `~/workspace/loomworks-studio`.

### 1. Create the wrapper package

```json
{
  "name": "loomworks-studio",
  "private": true,
  "type": "module",
  "version": "0.1.0",
  "bin": { "loomworks": "bin/loomworks.mjs" },
  "dependencies": { "@mnstry/atelier": "file:../.." }
}
```

A published distribution depends on a released `@mnstry/atelier` version
instead of a `file:` path.

### 2. Write the branded bin

The whole wrapper story is one small file:

```js
#!/usr/bin/env node
import { runCli } from '@mnstry/atelier/cli'
import { createRequire } from 'node:module'
const { version } = createRequire(import.meta.url)('../package.json')
process.exit(await runCli({
  argv: process.argv.slice(2),
  brand: { command: 'loomworks', displayName: 'Loomworks Studio', version },
}))
```

With that in place, `loomworks --version` prints
`Loomworks Studio 0.1.0 — powered by MNSTRY Atelier <root version>` and
`loomworks --help` opens with the display name and the attribution line — both
rendered by `runCli`, neither maintained by the wrapper.

### 3. Put the attribution line in the README

Add the exact byte string `powered by MNSTRY Atelier` near the top of the
wrapper's `README.md`. This is what `distribution check` blocks on.

### 4. Brand the projection

Workspace projections read
`ext["mnstry.atelier"].distribution` from `atelier.project.json`:

```json
{
  "ext": {
    "mnstry.atelier": {
      "distribution": {
        "name": "Loomworks Studio",
        "eyebrow": "studio projection",
        "theme": { "accent": "#7a9e7e" }
      }
    }
  }
}
```

The "MNSTRY Tenant Readiness" section heading in the rendered projection stays
as is: it names the bundled MNSTRY pack.

### 5. Add an extension pack

Branded protocols live under `packs/<pack-name>/` with a manifest
(`atelier.pack.json`, schema `mnstry-atelier-extension-pack@v1`) whose
protocol ids are namespaced, for example `loomworks.readiness:open-intake`.
The manifest carries the advisory attribution key:

```json
{
  "ext": { "mnstry.atelier/attribution": "powered by MNSTRY Atelier" }
}
```

Extension protocols load alongside the bundled twelve; they never replace
them.

Declared pack paths resolve from the directory holding `atelier.project.json`
and may not contain `..` segments, so the pack directory has to sit inside the
config directory. Put the workspace config wherever the packs are, not one
level above them — `examples/loomworks-studio/` keeps both at the wrapper
root for exactly this reason.

### 6. Ship skills

Distribution skills follow the root package's dual-tree convention:
`skills/claude/<skill-name>/SKILL.md` and a byte-identical
`skills/codex/<skill-name>/SKILL.md`.

### 7. Verify

```
loomworks distribution check
```

Exit 0 means the README attribution is present; the output also reports
whether each pack manifest declares the advisory attribution key. The repo's
distribution smoke gate runs the same check against the installed example.

## `ext["mnstry.atelier"].distribution` reference

All fields are optional; absence renders the default MNSTRY Atelier styling.

| Field | Type | Meaning |
| --- | --- | --- |
| `name` | string | Display name used in the projection title and eyebrow. |
| `eyebrow` | string | Second half of the eyebrow line (default `local projection`). |
| `theme` | object | Color overrides, keyed by theme token name. |

Theme token names: `background`, `surface`, `text`, `accent`, `eyebrow`. Each
maps to a CSS custom property (`--atelier-bg`, `--atelier-surface`,
`--atelier-text`, `--atelier-accent`, `--atelier-eyebrow`).

Hex-only rule: every theme value must match `^#[0-9a-fA-F]{3,8}$`. Values are
interpolated into a style block, so non-hex input fails the build fast — this
is an injection guard, not a stylistic preference.

## Admission

A distribution changes branding, not authority. Admission of any payload into
a MNSTRY destination is decided and recorded exactly as for the root package —
see `docs/attestation.md` for the admission model and how attestations record
those decisions.
