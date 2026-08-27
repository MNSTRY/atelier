# Tenant authoring extensions

An Atelier project can power a tenant-specific authoring interface without
putting that tenant's authoring system into the public kit. The split is:

```text
public Atelier
  extension-pack validation and digest pinning
  tenant-binding, display-projection, and action-intent contracts
  local-service safety and source-boundary rules

private consumer adapter
  tenant ontology, principles, queries, and priority logic
  source selection and composition
  authoring-state validation and persistence
  renderer binding and user-facing language
```

The public contracts describe the seam, not the engine behind it. A competitor
can implement the same generic seam under Apache-2.0. The contract does not
disclose the tenant's methodology, rule bodies, scoring, prompts, source graph,
or authoring-state machine.

## The three documents

`atelier-tenant-extension-binding@v1` binds one declared extension pack to one
tenant and one authoring projection. It names capabilities and fixes the
authority posture. The binding is a tracked document in the consumer
repository. It is not a runtime enrollment or a publication grant.

`atelier-authoring-projection@v1` is the display-safe view a consumer-owned
service may expose to its interface. It carries stable source references,
capabilities, and authority posture. It deliberately has no fields for source
queries, implementation paths, private rules, prompt material, or persistence
details.

`atelier-authoring-action-intent@v1` is a proposal-only envelope sent from an
interface to the consumer adapter. Tenant-specific payloads travel under a
namespaced `ext` member and are validated privately. The public envelope never
claims that the action was accepted or applied.

## Authority

The contract family is intentionally narrow:

- local authoring state is consumer-owned;
- publication mutation is always false;
- editorial-gate mutation is always false;
- MNSTRY runtime mutation is always false;
- the consumer adapter decides whether a proposed authoring intent is valid.

An adapter may write its own local review ledger after its private checks. That
does not turn the public Atelier browser or contract into publication
authority. A later product that needs publication or MNSTRY runtime writes
requires a separate accepted-server contract and a new authority review.

## Declaring the private pack

Declare the tenant pack in the tracked project config:

```json
{
  "ext": {
    "mnstry.atelier": {
      "extensionPacks": [
        {
          "id": "sample.authoring",
          "version": "v1",
          "path": "packs/sample.authoring/atelier.pack.json",
          "enabled": true
        }
      ]
    }
  }
}
```

Keep the pack inside the consumer repository. Put tenant lenses, readiness
conditions, and private contract references inside that pack's namespaced
`ext` member. Atelier validates the outer pack and pins its digest; the
consumer adapter validates and executes the private meaning.

Run `atelier extension-pack validate`, review the pack, and then run
`atelier lock write`. The lock pins the private pack without copying it into
the public package.

## Rendering

The consumer interface renders the authoring projection through its canonical
design system. The projection owns meaning and capability; the renderer owns
visual treatment. Tenant content, labels, and principles remain source records
or private projection fields. Route or page code does not become a second
authoring database.

For a durable loopback interface, use the managed local-service contract in
[`local-services.md`](./local-services.md). Service names, ports, commands,
state schemas, and recovery content remain in the consumer repository.
