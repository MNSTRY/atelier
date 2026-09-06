# Review state and portable inspection

| State | Ownership and portability |
| --- | --- |
| Contracts, adapter configuration and declared packs | Track in the adapter; domain facts stay in their source repository. |
| Real answers, evidence snapshots, responses and decisions | Ignored owner-local state; backup is an explicit owner action. |
| Projections and caches | Regenerable, subject to the same content disclosure boundary. |
| Session state, nonces and presence | Ephemeral; never exported with review records. |
| Secrets, credentials, grants and signing keys | Nontransferable through the inspection format. |

Moving a Git checkout does not transfer active review authority. This feature
exports selected historical evidence for inspection; it does not synchronize
state, upload files, install packs, execute migrations or import current approval.
There is no encrypted-export option. Encryption, recipient selection and key
custody require a separate design and qualification. Hashes are not encryption
and do not authenticate a sender.

Preview a selected run and optionally selected response/position request IDs:

```sh
atelier review export --runs RUN_ID --responses RESPONSE_ID,POSITION_ID --denylist PRIVATE_POLICY.json
```

The disclosure policy must contain the `patterns` array used by the existing
scanner; maintain it privately. The command fails closed if that policy is
unavailable or rejects selected content. Preview reports selected identities,
byte counts and digests. Inspect the selected local history and evidence before
writing the reviewed selection. Then repeat with `--write --out inspection.json`.
An existing output file is never overwritten. The current selection is validated
and disclosure-checked again at write time. Exports contain private excerpts and
asserted names, so an empty policy is appropriate only for an invented fixture.

`atelier review inspect inspection.json` validates the version, closed contracts,
member count/byte bounds, JCS SHA-256 digests, duplicate identities and historical
links before displaying inert JSON. It does not resolve a project or write active
state. Foreign decisions remain visibly unverified historical assertions. The
format carries no trusted signature: there is no applicable signer authorization
or attestation to verify. Valid hashes prove internal consistency only.

The `atelier-review.v1.schema.json` contract defines these separate artifacts.
Evidence and contributions use the existing JCS implementation; the bundle hash
covers every top-level member except `digest`. A member hash covers its complete
`value`; `bytes` is the UTF-8 byte count of `JSON.stringify(value)`. Record input
hashes cover complete submitted input. Maximum bundle size is 4 MiB, with at most
20 runs and 2,000 selected document contributions. Current capture supports up to
256 text source nodes and 1 MiB per source; unsupported inputs refuse capture.
No archive extraction or arbitrary path writing occurs. Symlink input/output
leaves, absolute machine-path values, credential-bearing URLs and nontransferable
field names are refused. Generic text still needs the owner's private disclosure
policy; structural checks do not determine disclosure permission.

To roll back, pin the earlier package and pack/configuration/lock together,
disable the optional review surface, and retain both ledgers. Legacy proposal
readers continue using their separate files. Never delete historical records or
reinterpret them under a replacement pack to make an upgrade appear complete.
