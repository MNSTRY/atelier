# Announcements

MNSTRY communicates with kit users through signed announcement documents
committed under `announcements/` in this repository. The channel is
pull-only: an announcement reaches you when you run `git pull`, and pulling
is the consent act. There is no push channel, no subscription list, no
beacon, and no delivery receipt — and none is ever created.

## The promise

This channel is one-way, outbound from MNSTRY. It carries no tracking of any
kind: reading, verifying, or ignoring an announcement produces no signal
back to MNSTRY. The kit never fetches this channel — no command, hook, or
background process contacts a network to look for announcements. The only
transport is the git history you already chose to pull.

## Document shape

An announcement is a JSON document with the runtime-defined shape
`mnstry.announcement@v1` (validated structurally in code by the verify path;
deliberately not a `contracts/` schema, so the governed contract corpus
stays stable):

- `schema` — the constant `mnstry.announcement@v1`.
- `announcementId` — a stable identifier with the `announcement:` prefix.
- `publishedAt` — an ISO date string.
- `title` — a non-empty string.
- `body` — the announcement text, as markdown.
- `signature` — a detached signature (`algorithm`, `keyId`, `value`), or
  null only while unsigned. An unsigned announcement never verifies.

Announcement files live directly in `announcements/`, named
`YYYY-MM-DD-<slug>.v1.json`. The MNSTRY announcements public key is
committed at `announcements/keys/mnstry-announcements.public.v1.json`; the
private half is never in this repository and CI only ever verifies — it
never re-signs.

## Signing rule

The signature covers the UTF-8 encoding of the RFC 8785 (JCS)
canonicalization of the document with its `signature` member set to null —
the same normative rule the attestation flow uses (see
`docs/attestation.md`). The shared implementation is
`signDocument`/`verifyDocument` in `src/attestation/sign.mjs`.

## Verifying announcements

List and verify everything at once:

    atelier announcements list

Each verified announcement prints its id, date, and title. A file that does
not verify is flagged loudly and fails the exit code; treat its content as
not from MNSTRY.

Verify a single file (the committed key is the default; pass
`--public-key FILE` to pin your own copy):

    atelier announcements verify announcements/<file>.json

Read one:

    atelier announcements show announcements/<file>.json

`show` prints the body only after the signature verifies. It refuses —
without printing any content — otherwise.

## Trust model

- Verification is offline and local. Anyone with the repository can reach
  the same verdict; no MNSTRY service participates.
- The committed public key travels with the repository. If you want
  protection against a compromised repository rewriting both the key and
  the announcements together, pin a known-good copy of the public key out
  of band and pass it with `--public-key`.
- A document under `announcements/` that fails verification is noise, not
  an announcement. The tooling never presents unverified content as if it
  were from MNSTRY.
