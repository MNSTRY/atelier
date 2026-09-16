# Connected composition: synthetic foundation

Status: experimental, opt-in source prototype. Not an accepted public API,
production auth integration, published release, or certification of a private
host. Existing package exports and contracts remain unchanged.

## Bounded implementation

Owned additions: `src/composition/`, `src/access/`, `src/preview/`,
`examples/connected-composition/`, `test/connected-composition*.test.mjs`, and
`scripts/prove-connected-composition.mjs`. This document records the reservation.
No existing sidecar, vault, coauthor, presentation, keyboard or business module
is changed. The prototype starts from the frozen presentation supplier and is a
separate candidate; its local proof cannot satisfy that supplier's CI gate.

The public root supplies placement validation, an opt-in trusted-host enforcement
helper and a two-origin preview channel. A private host supplies identity,
membership, delegation, policy, registry/source resolution, services, result
filtering and audit storage. Auth adapters can differ without changing placements.
White-label and self-provisioned hosts remain possible; no hosting infrastructure
or tenant provisioning is implemented here.

The example uses two invented auth adapters and an in-memory collection service.
It is intentionally not an auth provider. Only preview-plane synthetic reads and
an explicitly enabled reversible sandbox action are supported. No production
plane, live network transport, credential, payment or irreversible action exists.

## Implementation sequence and acceptance

1. Closed, byte/depth/count-bounded JSON parsing, placement and action schemas;
   exact source-byte and immutable definition/renderer digests.
2. Trusted channel authentication, complete decision binding, agent attenuation,
   fail-closed revalidation before service and before output; bounded projection.
3. Independent fake service authorization, expected-version/idempotency behavior,
   with accurate uncertainty rather than invented rollback after an effect.
4. Exact-origin/source/nonce MessageChannel handshake and generation/source/sequence
   guards; old mounts and pending responses cleared on change or logout.
5. An Astro page retaining useful static content without JavaScript or an account;
   isolated dynamic preview, ordinary native controls, narrow responsive layout.
6. Focused control tests, three desktop browser engines, source-edit/build/refresh,
   fake adapter switch/logout, scoped agent refusal and no secret projection.

The browser receives proposals and filtered results, never a trusted session,
decision or service port. This separation protects against an untrusted preview,
not a malicious host constructor. A real service must independently authorize
and atomically own effect/version/idempotency receipts. Types and callback names
are not security boundaries. A compromised private service or dishonest projector
is outside this root helper's assurance.

No general source writer is added. The browser does not get filesystem tools.
The proof harness edits only its disposable authored fixture and rebuilds it.
Existing coauthor draft persistence and canonical source promotion stay owned by
their existing workflows. There is no duplicate placement database.

## Proposal alignment

The wire retains the `proposal-v1` discriminators from the reviewed placement
proposal, with an executable closed action validator added. The implementation
is `connected-composition/experimental-v1`, not a proposal acceptance event.
An action's full request digest is additionally bound to authorization, so an
identifier cannot silently stand for a changed payload. The projector returns
only filtered data; the root constructs all public state metadata itself.
Audit intake uses `pending` and output settlement uses `prepared`, not
`delivered`: returning a prepared result is not a browser delivery acknowledgement.
Preview lifecycle generations are mount-local and never serialize host session
generation or identity. Real hosts must map invalidation into channel disposal.
The first resolver intentionally admits exactly one data binding and a web
projection. Multi-resource composition, other host projections and a published
package export require their own accepted contracts; parsing their proposed
shape alone is not runtime admission.

Missing completion gates: owner validation of real host adapters and source
promotion integration, service-specific transaction/reconciliation proof,
assistive-technology and actual native/device tests, private adopter acceptance,
maintainer integration and recognized CI. None is implied by this prototype.
