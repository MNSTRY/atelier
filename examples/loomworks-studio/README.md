# Loomworks Studio

A fictional reference distribution — powered by MNSTRY Atelier.

Loomworks Studio is not a product. It is the smallest complete example of a
white-label distribution: a wrapper package that gives the Atelier CLI its own
command name, its own branded projection, and its own extension pack, while
every command, contract, and gate underneath stays the unmodified root
package. Read it top to bottom and you have seen the entire distribution
surface.

This example is tracked in the Atelier repository but never published: it is
absent from the package `files` allowlist, and the release audit fails loudly
if it ever appears in a tarball.

## What is here

| Path | What it demonstrates |
| --- | --- |
| `package.json` | Depending on `@mnstry/atelier` and exposing one branded bin. |
| `bin/loomworks.mjs` | The whole wrapper: `runCli` plus a brand object. |
| `atelier.project.json` | Projection branding and the extension-pack declaration. |
| `packs/loomworks-readiness/` | A branded, namespaced extension pack. |
| `skills/` | A branded skill in the dual claude/codex tree. |
| `workspace/` | The managed repo the sample workspace declares. |

## The wrapper

`bin/loomworks.mjs` is the only executable code in this package:

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

`loomworks --version` prints the wrapper name and version followed by the
attribution line; `loomworks --help` opens with the display name, then the
attribution line, then the same command list the root package ships. Both are
rendered by `runCli` from the brand object. The brand carries no attribution
field, so a wrapper cannot reword or omit that line — which is why this README
does not have to ask you to remember it.

## Attribution

The exact byte string `powered by MNSTRY Atelier` appears at the top of this
file. That is the blocking requirement, and `loomworks distribution check`
verifies it. The pack manifest additionally carries the advisory marker
`ext["mnstry.atelier/attribution"]`, which the same command reports without
blocking.

The normative policy lives in `TRADEMARKS.md` under "Required attribution" in
the Atelier package — deliberately not restated here, so the two cannot drift.

## The extension pack

`packs/loomworks-readiness/atelier.pack.json` declares two protocols under the
`loomworks.readiness:` namespace. They load alongside the twelve bundled
MNSTRY protocols; they do not replace, shadow, or edit them. The loader
enforces that: a pack may not claim the reserved `mnstry` namespace, reuse a
bundled protocol id or slug, or resolve any path outside its own directory.

The project config declares the pack:

```json
"ext": {
  "mnstry.atelier": {
    "extensionPacks": [
      {
        "id": "loomworks.readiness",
        "version": "v1",
        "path": "packs/loomworks-readiness/atelier.pack.json",
        "enabled": true
      }
    ]
  }
}
```

Pack paths resolve from the directory holding `atelier.project.json` and may
not contain `..` segments, so the sample workspace config sits at this package
root rather than one level down — the config directory has to contain the pack
directory. A distribution whose workspace lives elsewhere ships the pack under
that workspace instead.

## Projection branding

The same `ext["mnstry.atelier"]` container carries the branding block read by
`loomworks project`:

```json
"distribution": {
  "name": "Loomworks Studio",
  "eyebrow": "studio projection",
  "theme": { "accent": "#7a9e7e" }
}
```

Theme values must be hex colors; anything else fails the build rather than
reaching the rendered style block. The "MNSTRY Tenant Readiness" heading in
the projection stays as it is — it names the bundled pack, not this
distribution.

## Skills

`skills/claude/loomworks-open/SKILL.md` and its byte-identical
`skills/codex/` twin follow the root package's dual-tree convention. The skill
speaks in the wrapper's command name and points at the branded protocols, but
it describes root behavior — a distribution skill teaches the same system under
a different name.

## Try it

From this directory, with the root package installed:

```bash
loomworks --version
loomworks --help
loomworks extension-pack validate --project ./atelier.project.json
loomworks distribution check
```

The repository's `npm run distribution:smoke` runs exactly this sequence
against a packed tarball in a temporary directory, so the example cannot rot
without a gate noticing.

## Learn more

- `docs/distributions.md` in the Atelier package — the full distribution guide.
- `TRADEMARKS.md` — attribution, naming, and compatibility-claim policy.
- `docs/attestation.md` — how admission decisions are recorded and verified.
