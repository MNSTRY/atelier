# Attestation

An attestation is a small governed document (`atelier-attestation@v1`,
`contracts/atelier-attestation.v1.schema.json`) in which an issuer records an
admission decision about one payload document — an export, a readiness run, or
a claim. It binds that decision to the exact payload bytes through a canonical
hash, names the issuer, and either carries a signature or explicitly declares
itself unsigned.

An attestation is a record of a decision, not the decision mechanism. It never
grants runtime authority, never mutates anything, and never substitutes for
running the published validators yourself.

## Admission versus conformance

The two words are deliberately kept apart, and the schema enforces the split
structurally:

- Conformance is public and offline. Anyone can run the published validators
  in this package against a document and reach the same answer. No attestation
  is needed to establish conformance, and no attestation can establish it.
- Admission is a decision by a specific issuer to accept a specific payload
  into a specific destination. An attestation only records an admission
  decision. MNSTRY's private validator only ever decides MNSTRY admission; it
  does not define, extend, or gate conformance.

`verdict.scope` is the constant `"admission"`. A document claiming a
conformance verdict cannot validate against the schema, so the vocabulary
cannot drift into "certified conformant" territory by accident.

The admission decision itself is one of `admitted`, `rejected`, or
`needs-review`, with optional machine-readable `reasons` entries
(`code` + `message`) explaining a rejection or review request.

## Canonical payload hash

`subject.payloadHash` binds the attestation to exact payload content. The
procedure is normative:

1. Canonicalize the attested payload document with RFC 8785 (JSON
   Canonicalization Scheme, JCS).
2. Hash the canonical bytes with SHA-256.
3. Encode the digest as lowercase hexadecimal (64 characters).

The fields are pinned accordingly: `algorithm` is the constant `"sha-256"`,
`canonicalization` is the constant `"RFC8785-JCS"`, and `digest` must match
`^[0-9a-f]{64}$`. A relying party that re-canonicalizes the payload and gets a
different digest must treat the attestation as not applying to that payload.

Validator implementation for this procedure is explicitly out of scope for
this package; the contract only fixes the procedure and the encoding.

`subject.schema` names the contract of the attested payload (for example
`atelier-export@v1`), `subject.ref` carries its stable identifier (exportId,
runId, or claimId), and optional `subject.references` entries cross-reference
related claims, runs, exports, or protocols.

## Signature semantics

`signature` is required in shape and nullable in value. Every attestation must
say one of two things — silently absent is not expressible:

- `"signature": null` — the attestation is unsigned and therefore
  non-authoritative. It is advisory only: useful as a local record or a
  tooling artifact, but it proves nothing about who issued it.
- A signature object — `algorithm` (`ed25519` or `es256`), `keyId`, and a
  base64url `value`. An admission decision is authoritative only when it
  carries a signature whose `keyId` the relying party recognizes as belonging
  to the claimed issuer.

The `issuer` block asserts identity (`id`, `role`, optional `keyId`); the
signature is what makes that assertion checkable. `issuer.role` distinguishes
an admission authority from a tool or a self-attestation, but the role field
alone confers no authority.

Key distribution, trust establishment, and verifier implementation are out of
scope for this package. Relying parties decide which keys they recognize.

## Fixtures and tests

Reference documents live in `fixtures/atelier-attestation/` (`valid/` and
`invalid/`), and `test/attestation-contract.test.mjs` validates all of them
against the schema, asserting that each invalid fixture fails for its intended
reason.
