# Open the Loomworks studio

Use this skill when someone says "open Loomworks", "open the studio", or asks
to see the Loomworks projection.

Loomworks Studio is a distribution of MNSTRY Atelier: the `loomworks` command
is a branded entry point into the unmodified Atelier CLI. Every command below
is an Atelier command — a distribution adds and rebrands, it never changes what
a root command means.

## Route by client

| Client | How to open |
|---|---|
| Claude Code / Cowork | `preview_start` with the workspace launch config, then screenshot |
| Codex | the harness preview pane if present, otherwise report the URL |
| Editor with no preview pane | print the URL; do not shell out to `open` |

Never use the system `open` command, and never fetch the page and describe it
instead of rendering it.

## Starting it

```
loomworks server
```

The port resolves as argv > `PORT` env > 8137, so a supervisor can hand the
process a free port without a config edit. If a long-lived instance already
holds the canonical port, start beside it rather than evicting it.

## Studio protocols

The Loomworks extension pack contributes two protocols alongside the twelve
bundled MNSTRY readiness protocols. They resolve by full namespaced id only:

```
loomworks readiness protocols --project ./atelier.project.json
loomworks readiness run loomworks.readiness:open-intake --project ./atelier.project.json
```

`loomworks.readiness:open-intake` is a required gate; unfinished, it blocks the
readiness export. `loomworks.readiness:loom-alignment` is advisory and reports
without blocking.

## Checking the distribution

```
loomworks extension-pack validate --project ./atelier.project.json
loomworks distribution check
```

The first loads every declared pack fail-closed. The second verifies the
attribution markers this distribution is required to carry; the normative
policy lives in `TRADEMARKS.md` in the Atelier package under "Required
attribution".

## What this skill will not do

Readiness runs are claim-first and proposal-only: they write drafts under
ignored local state, never runtime data, and never send anything anywhere.
Report blockers rather than working around them.
