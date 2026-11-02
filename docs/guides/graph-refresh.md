# Graph projection refresh

This is an experimental host integration module in `src/graph-refresh/`. It is
not enabled by `atelier dev --knowledge`, and has no published package export.
It adds no listener, daemon, graph database, identity or grant authority. A host
attaches its start and stop to the existing sidecar lifecycle. The first proof
uses invented graph-view fixtures; authenticated host receiving is separate.

The Git source, canonical graph builder and knowledge plan still own source
identity and semantics. Refresh consumes complete authorized projections. It
does not extract a second graph, accept a relation, change a plan or apply a
proposal. The existing graph file cache supplies incremental source reuse.

## Lifecycle ports

`createGraphRefresh` takes these host functions:

| Port | Contract |
| --- | --- |
| `build({generation,binding,signal})` | Return one complete authorized graph-view projection. Compute in isolation, honor cancellation, and bound execution. Do not write a current output from inside the builder. |
| `validate(projection)` | Return exactly `true` only for a supported, complete projection with a verified digest. Use the projection owner's validator. It may be asynchronous. |
| `revalidate(binding,projection)` | Return exactly `true` only while this host-issued binding and every requested historical or current projection are still readable. `projection` is null before the build. Errors and other values refuse. It may be asynchronous. |
| `stage({projection,generation,signal})` | Optional preparation of a complete host output, isolated from readers. Return `{commit,discard}`. It may be asynchronous. The default uses only the controller's in-memory pointer. |
| `commit()` | Synchronously and atomically replace the host's current output. Never queue an asynchronous current write. A promise result is unsupported and refuses controller publication. |
| `discard()` | Idempotently remove only this uncommitted staging output. It may be asynchronous. Failure retains cleanup custody even after supersession, access loss or stop. |
| `clear()` | Synchronously clear host reader caches, inspectors, selections, search results and renderer resources. A failure or promise result blocks accepting a replacement binding. |
| `onCleanup(outcome)` | Optional trusted host notification `{cleanupId,state,code}` for resolved or failed staging cleanup. It carries no source, path, binding or raw exception and is never a reader event. |

`setAccess({key,expiresAtMs,...privateHostState})` accepts a trusted host binding.
The key binds principal, exact authorized repositories, grant revision and
expiry, policy and request filter. This is a cache and lifecycle key, not proof
of a grant. Keep any instance-issued capability object in private host state;
do not clone that capability or reconstruct it from browser JSON. Each access
replacement first purges prior history, projection and selection. A host access
adapter must revalidate the actual capability, not just compare the key.

`start()` starts a pending build only when a binding is present. `invalidate()`
immediately marks an existing view stale, aborts a superseded build and requests
a replacement. Bursts share a fixed coalescing window, default 40 ms. Only one
build and staging operation runs at a time. An abort-ignoring builder must
settle before its successor can compute; its late result cannot publish.

Every awaited build, validation, access check and staging step is followed by a
generation fence. A final current access check and fence precede synchronous
commit and pointer replacement without an intervening await. Partial builds,
failed saves and obsolete generations never become the controller's current
view. A conforming staging adapter is required for equivalent disk behavior.

Cleanup custody is separate from publication and reader eligibility.
`cleanupStatus()` returns sanitized host-only records with a `cleanupId` and
`cleaning` or `failed` state. A failed discard retains its transaction handle;
new builds and staging stop until the host resolves it with
`await retryCleanup(cleanupId)`. Concurrent retries share the complete operation
and its result, including a rejection. A failed attempt requires a separate host
call to retry; a waiting caller never starts another attempt automatically.
Success releases the handle and requests a fresh build if the host is running
with current access. Rejection remains retained and notifies the host again.
This bounds unresolved custody to one transaction without a retry daemon.

The host must consume these operational outcomes and keep the controller until
cleanup is resolved. Never serialize cleanup records into a reader response.
Grant loss still purges private reader state immediately; resource custody does
not authorize any old view delivery. `stop()` retains unresolved cleanup, and
`await flush()` settles an already in-flight operation even after stop. Process
restart recovery belongs to the staging adapter's existing resource journal;
this controller does not add a persistent store or trust a saved projection.

`read(digest?)` revalidates before returning a detached copy. A previous view is
returned with `stale:true` after a source edit or failure, and `historical:true`
when it is no longer the published snapshot. History is in memory, bounded to
three previous digests by default, and available only under the same still-valid
binding. A missing digest returns no projection. It does not fall back to a
different snapshot. Restart requires fresh host access and a successful rebuild;
there is no automatic trust of saved projections.

`select(ref,digest)` accepts a current qualified `{repoId,localId}` only against
the exact published digest. `compare(beforeDigest,afterDigest)` revalidates both
retained snapshots and fences access changes before returning their comparison.

## Revocation and UI receiving

On a grant or policy notification the host first retires its access capability,
then calls `invalidateAccess()`. This synchronously aborts work and drops the
current projection, all history, selection and host caches. Expiry and a refused
read or build check do the same. They cannot wait for a replacement build. Each
read still checks access, covering a missed notification before another delivery.
The controller cannot detect remote revocation without its host's notification
or revalidation; this module does not establish an authenticated access host.

Subscribe with `subscribe(listener)` and dispose with its returned unsubscribe
function. Events contain only `{type,phase,generation,stale,failure}`. On `clear`,
the UI must immediately dispose its graph, inspector, selection, query caches
and pending render work, including all WebGL resources that retain private
labels or topology. A previous browser copy cannot be recalled by clearing the
controller alone. Conforming hosts must connect this event and `clear` to their
own state and verify the visible result. Do not keep the old graph on screen
while fetching a narrower replacement. Old refs and diagnostics are absent
from clear events. A listener failure does not prevent other listeners running.

| Phase | Meaning |
| --- | --- |
| `stopped` | No delivery; snapshots and selections cleared. |
| `denied` | No current host binding or access refused/expired; no delivery. |
| `pending` | Authorized first build requested. |
| `building` | Build or staging in progress; an existing view is explicitly stale. |
| `stale` | Source change invalidated the published generation. |
| `current` | Latest complete generation passed validation and access checks. |
| `failed` | Build, save or staging cleanup failed. An authorized old view may remain stale. |
| `unsupported` | Host validator refused the projection. An authorized old view may remain stale. |

Failures expose generic codes, never arbitrary build exceptions or source paths.
The host can keep source-level details in an independently authorized diagnostic
channel. `flush()` awaits pending work for a drill or on-demand build; it is not
a background completion promise. `stop()` purges immediately and fences late
results. The host must also await its own resource cleanup where required.

## Local watcher binding

`createLocalGraphRefresh({roots,...ports})` reuses Atelier's existing filesystem
watcher factory. Roots are trusted host inputs for the exact current permitted
repository set. It does not discover, clone or authorize repositories. Start it
with the existing sidecar, and call `stop()` from that sidecar's close path.
On a replacement access decision, pass the new permitted roots explicitly as
`setAccess(binding,roots)`. Old watchers close on clear; delayed events from a
retired watcher cannot invalidate the replacement reader's projection.

Watch events are hints. A periodic rebuild, default every 30 seconds, reconciles
dropped events using the canonical builder and file cache. It does not interrupt
an in-flight build. `status().watchState` is `watching`, `unavailable` or `stopped`;
failure to watch remains visible while periodic reconciliation can continue.
Neither watcher nor reconciliation timer keeps a second process alive.

## Snapshot comparison

`compareGraphSnapshots(before,after)` is a pure derived comparison. Trusted callers
must revalidate both snapshots first; controller `compare` performs that check.
The pure function refuses incompatible schemas, different access contexts or
filters, duplicate qualified refs and dangling references. It does not turn
matching access metadata into authentication.

Nodes compare by qualified ref, sources by repository and path with all exact
pins retained, edges by edge id, and questions by question id. A rename does not
merge identities. Assertions sharing a semantic triple retain separate edge ids.
Changed bytes, revision, locator, edge support or question state are included.
Possible question impact conservatively follows permitted edges in either
direction within the supplied slice. It is explicitly possible impact, not
proof of a semantic dependency or completeness outside that slice. No model,
provider, source write or accepted history mutation occurs.

Run `node --test test/graph-refresh-*.test.mjs` for the synthetic lifecycle,
comparison and real local file-edit/restart drills. These checks do not qualify
the held sidecar integration, a real recipient access host, or a browser renderer.
