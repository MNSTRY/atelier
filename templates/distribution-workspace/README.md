# Distribution workspace

Starter for a MNSTRY Atelier distribution: a rebranded package that wraps the
Atelier CLI and ships its own name, projection branding, and optional extension
packs on top of the unmodified Atelier core.

The distribution invariant: add and rebrand, never alter root semantics. A
distribution may add protocols, skills, and branding, but the bundled commands,
contracts, and boundary rules keep their upstream meaning.

## Required attribution

Every distribution package must carry the exact line below in its README:

powered by MNSTRY Atelier

`atelier distribution check` blocks on this line. See `TRADEMARKS.md`
("Required attribution") and `docs/attestation.md` in the Atelier package for
the policy and signing details.

## Projection branding

`atelier.project.json` in this workspace carries the extension block that
brands the local projection:

```json
"ext": {
  "mnstry.atelier": {
    "distribution": {
      "name": "Example Distribution",
      "eyebrow": "distribution projection"
    }
  }
}
```

An optional `theme` object may override the projection color tokens
`bg`, `surface`, `text`, `accent`, and `eyebrow` with hex values, for example
`"theme": { "accent": "#7a9e7e" }`. Values that are not hex colors are
rejected at build time.

## Boundary

Shared distribution repos are readable by the project group. Do not place
private or sensitive personal domain source here. Use a private domain repo per
user for that material. `USER_GITHUB_LOGIN_PLACEHOLDER` in
`boundary-policy.v1.json` is a placeholder, not a real account; `atelier init`
personalizes it in the copied workspace.

## Tracked config and local overlay

Track `atelier.project.json`, `repo-access.v1.json`, `boundary-policy.v1.json`,
`atelier.lock.json`, governance files, and source documents. Ignore local
operator state such as `atelier.local.json`, `atelier.workspace.local.json`,
`atelier-attestation-key.local.json` (the local attestation signing key —
never commit it), `.atelier-local/`, proposals/current/presence/nonce/grants/
audit/session/support state, support bundles, transcripts, prompts, generated
projections, `node_modules/`, and `.DS_Store`.

## Local commands

```bash
atelier graph --project ./atelier.project.json
atelier project --project ./atelier.project.json
atelier readiness --project ./atelier.project.json
atelier lock check --project ./atelier.project.json
atelier distribution check
```

Atelier performs no telemetry, cloud sync, runtime mutation, or direct browser
writes for this preview.

## Atelier lockfile

`atelier init --template distribution` writes `atelier.lock.json`.
If this template was copied manually, create the lock before the first commit:

```bash
atelier lock write --project ./atelier.project.json
```

## Learn more

- `docs/distributions.md` in the Atelier package — the full distribution guide.
- `examples/loomworks-studio/` in the Atelier repository — a complete
  reference distribution with a branded wrapper binary and extension pack.
