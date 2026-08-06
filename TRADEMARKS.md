# MNSTRY trademarks

The names MNSTRY and MNSTRY Atelier, and the associated logos, are trademarks
of MNSTRY. The Apache-2.0 license for this package (see LICENSE, section 6)
grants no trademark rights: you may use, modify, and redistribute the code
without any right to use these marks except as described in this document.

## Required attribution

Distributions built on this package must display the exact attribution string

    powered by MNSTRY Atelier

in two places:

- the distribution's root `README.md` (byte-for-byte match on the phrase;
  the surrounding text is free), and
- the distribution's user-facing credits or about surface.

The README requirement is normative and mechanically checked by
`atelier distribution check`. As an advisory (reported, non-blocking) signal,
a distribution's extension-pack manifest may also carry
`ext["mnstry.atelier/attribution"]` set to the same attribution string, using
the reserved `ext` container — no schema change is involved. Attribution in
`--version` output is a distribution-side test convention, not a runtime
check.

## Naming your distribution

MNSTRY marks may not appear in product names, package names, or domain names.
Nominative use is permitted in the form "<YourName> for MNSTRY Atelier", which
names the compatibility target without implying that MNSTRY publishes or
endorses your distribution.

## Compatibility claims

The sanctioned phrasing for a compatibility claim is:

    implements atelier contracts v1

Conformance is public and offline: anyone can run the published validators in
this package and reach the same answer (see `docs/attestation.md`). No
permission is needed to make a truthful compatibility claim in this form, and
no attestation can substitute for it.

## Certification and admission

The phrases "MNSTRY certified" and "MNSTRY admitted" (and equivalents) are
reserved to holders of a signed MNSTRY attestation that verifies per the
procedure in `docs/attestation.md`. Self-issued or unsigned attestations
confer no such claim: an attestation with `"signature": null` is
non-authoritative by definition, and a signature is only meaningful under a
key the relying party recognizes as MNSTRY's.

## Questions

For trademark questions or permission requests beyond what this document
covers, contact MNSTRY through the channels listed in the package README.
