# Pack compatibility for evidence-bound review

The closed v1 pack format remains unchanged. An adapter can declare a separate
`atelier-pack-lifecycle@v1` file through
`ext["mnstry.atelier"].extensionPackLifecycle`. Each entry binds the pack ID,
version and content digest to `compatibleRootVersions`, an explicit finite set
of approved root versions. This conservative compatibility range does not infer
SemVer compatibility or silently approve a future root version.

`atelier review packs` reports admission. `--migration-plan` returns a dry-run
report referencing the existing extension-pack upgrade registry and its checks.
A declaration can name an available registry `migrationId`; unknown migrations
fail qualification. Pack loading never executes extension code or installs
packages. An owner reviews replacement term/protocol meaning, retains prior
content, updates declarations and locks, and uses the existing upgrade workflow.
The plan itself writes nothing. A fresh run is required after a change.

| Root/pack state | Historical inspection | New evidence-bound run |
| --- | --- | --- |
| Current root explicitly approved; exact active pack | Pinned snapshot | Admitted |
| Exact deprecated pack, root approved | Pinned snapshot; replacement shown | Admitted with deprecated status |
| Retired, wrong digest/version or unapproved root | Pinned snapshot | Refused |
| Legacy pack without lifecycle declaration | Existing readers remain usable | Unqualified; refused |
| No custom packs | Bundled snapshot | Admitted |
| Old root predating this feature | Its legacy readers only | No new review protocol supplied by that root |

A snapshot contains the actual protocol and source identity used originally.
Historical inspection does not load today's replacement as yesterday's method.
Migration IDs describe reviewed owner operations, not autonomous reinterpretation
or approval. For rollback restore the previous package, pack declarations and
lock; retain the evidence and contribution ledgers. Existing legacy readiness
execution remains compatible and does not acquire exact-review qualification
merely because it can still read the pack.
