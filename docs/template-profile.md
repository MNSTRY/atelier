# Portable template profiles

Status: Additive source candidate. Not a released package export or installed
host integration. Import `src/templates/profile.mjs` from a source checkout for
evaluation; package exports and CLI registration await the receiving integrator.

A template profile names semantic roles, surface roles, supported carriers,
compatibility and limits. An adopter binds those roles to its own source. The
profile carries no project content, renderer, runtime handler or permission.

## Four independent grammars

- Semantic roles describe resource, relation, facet, asset, collection, sequence,
  occurrence, offer and action-descriptor structure. Profiles choose a subset.
- Surface roles describe composition: Shell, region, collection, card, detail,
  graph, filter, offer, status, refusal and receipt views. They reference semantic
  role identifiers, not executable components.
- Runtime meaning is an optional opaque `RuntimeProfileRef`. A host must supply
  the exact profile for runtime participation; ordinary local authoring needs
  no runtime connection. The profile never creates an operation or receipt.
- Governance and release identities are typed digest-bound references. A
  `TemplateRef` is not interchangeable with a source, policy, authority decision,
  project binding, projection or release reference.

## Validation stages

| Entry point | Checks | Does not prove |
| --- | --- | --- |
| `validateTemplateDefinition(profile)` | Closed grammar, bounded data, unique roles, surface references and supported extension behavior | Adoption, content or host availability |
| `validateTemplateBinding(profile, binding, records)` | Exact template, role cardinality, required roles, resolved source digests | Source ownership or content truth |
| `validateTemplateRelease(profile, binding, release, records)` | Exact binding, projection/source/policy/decision/payload references, required carriers | Publication acceptance, rights or distribution |
| `validateTemplateHost(profile, host)` | Exact version/pack/runtime requirements, primitives and optional decision observations | Host authentication, actual renderer behavior or operation permission |

Every result includes `authority: structural-only`, `executionAuthority: false`
and `publicationAuthority: false`. No result authorizes a write, network request,
installation or publication. The implementation does not mutate inputs.

Reference inventories contain `{ ref, document }` entries. All entries are
bounded plain JSON; duplicate `(kind, id, version)` identities refuse even if
their digests differ. References must resolve to exact supplied bytes. No URL
fetching, path loading, provider call or dynamic extension code occurs.

`templateReference(kind, id, version, document)` hashes the existing Atelier
canonical JSON serialization of:

```json
{ "schema": "atelier-template-digest@v1", "kind": "SourceRef", "id": "sample", "version": "v1", "document": {} }
```

The digest is `sha256:` plus lowercase hexadecimal. Kind, identifier and version
belong to the digest domain. Template, binding and release versions use SemVer;
other source-owned versions remain opaque strings. Pack versions retain their
existing `vN` contract. None of these digests is a signature or an authenticated
authority decision. This new domain does not reinterpret older artifact digests.

## Extensions and evolution

This is a separate versioned artifact; the closed extension-pack v1 schema is
unchanged. Profiles may link optional namespaced schema/payload references.
Their bytes must resolve at binding/release validation, but their meanings stay
opaque and inert. This version registers no required extension handlers and
refuses every required extension. Do not place required behavior in optional
annotations to evade admission.

Exact compatible Atelier versions and pack digests are explicit. There is no
automatic version coercion, range admission, migration or upgrade apply in this
module. A new contract version and the existing owner-controlled upgrade path
must govern changes. Keep prior source and profile artifacts for recovery.

## Optional advisory decisions

`optionalDecisions` declares named tasks using `atelier-decision-request@v1`.
Each is explicitly optional; the schema refuses a required provider and provides
no vendor selector. `validateTemplateDecision` consumes the existing request and
result validators, checks the task binding, and retains proposal-only semantics.
It does not decide whether the answer is true or should influence the graph.

A host may report `absent`, `disabled`, `unqualified` or `available`. Available
requires an exact `CapabilityRef`; it remains an untrusted structural observation
until the host's existing capability and authority checks qualify it. Absence
leaves local reading and authoring usable. Every diagnostic retains a
deterministic/manual fallback and `invocationAuthorized: false`.

No decision SDK, credential, network access, provider selection or automatic
substitution is required. Actual consent, disclosure, execution, budgets,
revocation and qualification remain with the existing host/capability owners.
This module adds neither a capability registry nor a second decision ontology.

## Synthetic proof and remaining integration

```sh
node --test test/template-profile.test.mjs
```

The invented reading-shelf fixture exercises structural positive cases and
refusals. It is not a real publication, owner approval, visual baseline or
conformance certificate. A complete adopter journey still needs existing graph
and presentation bindings, durable source editing/reload, upgrade participation,
actual host conformance, and receiving-owner acceptance. Software/definition
licensing never supplies content rights or paid-service entitlement.
