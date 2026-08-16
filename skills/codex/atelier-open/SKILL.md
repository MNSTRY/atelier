# Open the Atelier

Use this skill when someone says "open the atelier", "pull up the atelier",
"show me the portal", or asks what page they are currently viewing.

"Open" means **the client's native preview surface**, not the system browser.
An Atelier is a local sidecar serving a workspace projection; the point is to
render it where the person is already working.

## Route by client

| Client | How to open |
|---|---|
| Claude Code / Cowork | `preview_start` with the `atelier` launch config, then screenshot |
| Codex | the harness preview pane if present, otherwise report the URL |
| Editor with no preview pane | print the URL; do not shell out to `open` |

Never use the system `open` command and never fetch the page and describe it —
that answers a different question than the one being asked.

## Starting it

The workspace ships `.claude/launch.json` with `autoPort: true`. Start it by
name (`atelier`) and use the port the harness returns. The equivalent manual
command is:

```
./node_modules/.bin/atelier dev
```

Use the local binary path. Do **not** run unscoped `npx atelier`: the unscoped
name belongs to an unrelated third-party package that `npx` would download and
execute. From outside an installed workspace, install `@mnstry/atelier` first
and use the branded `npx mnstry-atelier` command.

`atelier dev` resolves its port as **argv > `PORT` env > 8137**, so a
supervisor can hand it a free port without a config edit.

## Do not fight for the canonical port

A workspace often keeps a long-lived instance on 8137 for humans and
cross-service links, frequently under a supervisor that respawns it. A preview
instance must coexist on its own port rather than evict it:

- Keep `autoPort: true`. Never pin a preview instance to the canonical port.
- "Port 8137 in use by a non-preview server" is the supervisor working, not an
  error to clear. Start on the assigned port instead.
- Never kill the canonical instance to pick up new code without asking — on
  most setups it is respawned by a supervisor whose rules you may not own.

## Boot time is not hang time

An Atelier may build or refresh its projection at startup. While it does, the
port is not yet open and browser calls fail with connection or policy errors
that read like permission problems. Poll the port or `/api/health` rather than
retrying the browser, and give a cold workspace room before declaring it broken.

## Which view to open

- Working inside one repo → that repo's portal, `/<repo>/index.html`
- Workspace-level work, or "everything" → `/`
- A repo's file audit → `/<repo>/atelier-ledger.html`

## What is the user looking at?

Prefer the session-aware context flow over any global "current view" file. A
recorded current view is a hint, not authority: trust it only when a
session-bound API response ties the view to the same workspace and a fresh
observation. Otherwise ask for an explicit target rather than guessing.
