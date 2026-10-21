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

This package ships the reference implementation of this procedure —
`src/attestation/jcs.mjs` (RFC 8785 canonicalization), `src/attestation/sign.mjs`
(hashing, signing, verification), and the `atelier attestation hash|sign|verify`
command line. The contract fixes the procedure and the encoding; the
implementation is replaceable by anything that produces the same bytes.

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

Verifier implementation is in scope (see the verification procedure below).
Key distribution and trust establishment remain policy-level: relying parties
decide which keys they recognize, and MNSTRY publishes its admission public
keys out of band.

## Signing procedure

The signing input is the UTF-8 encoding of the RFC 8785 (JCS) canonicalization
of the attestation document with its `signature` member set to `null`. That
sentence is normative; everything else here is mechanics.

- To sign: take a schema-valid attestation whose `signature` is `null`,
  canonicalize it, sign the canonical bytes, and embed the result as
  `{ "algorithm": ..., "keyId": ..., "value": ... }` where `value` is the
  unpadded base64url encoding of the raw signature bytes.
- To verify: take the signed document, replace `signature` with `null`,
  canonicalize, and verify `signature.value` over those bytes.
- `ed25519` signatures are raw 64-byte RFC 8032 signatures.
- `es256` signatures are the 64-byte IEEE P1363 concatenation of r and s,
  not DER. A DER-encoded signature also fits the schema's base64url pattern,
  so a verifier must not accept one by accident and a signer must never emit
  one — both signature shapes are 64 bytes (86 base64url characters).

A signer must refuse to sign a document that is not schema-valid, already
carries a signature, or names an `issuer.keyId` different from the signing
key's `keyId`.

## Verification procedure

`verifyAttestation` returns `{ valid, reasons }` and collects every applicable
reason instead of stopping at the first, in this order:

1. `schema.invalid` — the document fails the attestation schema.
2. `signature.missing` — `signature` is `null`. An unsigned attestation is
   non-authoritative, so verification fails by definition.
3. `signature.algorithm-mismatch` — `signature.algorithm` does not match the
   public key document's `algorithm` (or its JWK is for another curve).
4. `signature.key-id-mismatch` — `signature.keyId` does not match the public
   key document's `keyId`.
5. `issuer.key-id-mismatch` — `issuer.keyId` is present and differs from
   `signature.keyId`.
6. `signature.invalid` — cryptographic verification fails over the signing
   input defined above.

Payload binding is checked separately by `verifyPayloadBinding`, with reasons
`payload.digest-mismatch` (recomputed canonical digest differs from
`subject.payloadHash.digest`) and `payload.schema-field-mismatch` (the
payload's `schema` field differs from `subject.schema`). Signature validity
and payload binding are independent answers: a signature can be genuine while
the attestation is being presented against the wrong payload, and vice versa.

## Key format and the local key file

Key material is handled as JWK only — never PEM. The private key file lives in
the signing project's working directory, is gitignored by default, and must
never be committed:

```json
{
  "keyId": "example-issuer-2026",
  "algorithm": "ed25519",
  "privateKeyJwk": { "kty": "OKP", "crv": "Ed25519", "x": "wafd…", "d": "9dfu…" }
}
```

The signing key loads with fail-closed precedence: the
`ATELIER_ATTESTATION_KEY_JSON` environment variable (key file JSON), then
`--key <file>`, then `./atelier-attestation-key.local.json` in the current
directory. If none is present, signing exits with code 2 — there is no
"sign without a key" mode.

The public key document is freely shareable and is what verifiers consume:

```json
{
  "keyId": "example-issuer-2026",
  "algorithm": "ed25519",
  "publicKeyJwk": { "kty": "OKP", "crv": "Ed25519", "x": "wafd…" }
}
```

Errors and logs may name `keyId` and `algorithm`, and never any JWK member
value.

## Command line

```
atelier attestation hash <payload.json>
atelier attestation sign <attestation.json> [--key FILE] [--out FILE]
atelier attestation verify <attestation.json> --public-key FILE [--payload FILE] [--json]
atelier attestation keygen --key-id ID [--algorithm ed25519|es256] [--out FILE]
```

- `hash` prints the canonical `payloadHash` object for a payload document.
- `sign` signs an unsigned attestation with the local signing key and writes
  the signed document to stdout or `--out`.
- `verify` checks the signature against a public key file, plus payload
  binding when `--payload` is given; `--json` prints `{ valid, reasons }`.
  When no `--payload` is given, the output says so explicitly.
- `keygen` generates a key pair, writes the private key file (mode 0600,
  refusing to overwrite an existing file), and prints only the public key
  document.

Exit codes: 0 success (for `verify`: valid), 1 `verify` judged the attestation
invalid, 2 usage or input error.

## Fixtures and tests

Reference documents live in `fixtures/atelier-attestation/` (`valid/` and
`invalid/`), and `test/attestation-contract.test.mjs` validates all of them
against the schema, asserting that each invalid fixture fails for its intended
reason.

`valid/` fixtures are schema-valid shapes; only `signed-roundtrip.v1.json` is
also cryptographically real. Its signature was produced once at authoring time
with a throwaway key whose private half was never persisted; the public half
is committed as `keys/roundtrip-issuer.public.v1.json`, and its digest is the
real canonical hash of `fixtures/atelier-export/sample-studio-offer.v1.json`.
`test/attestation-signing.test.mjs` verifies the committed signature and the
payload binding on every run (and never re-signs), alongside a tamper matrix
asserting the exact failure reason for each mutation.
`test/attestation-jcs.test.mjs` pins the canonicalizer to the RFC 8785 vectors,
and `test/attestation-cli.test.mjs` exercises the command line end to end.
