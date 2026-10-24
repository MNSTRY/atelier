# Provider-owned checklist example

Select the checklist explicitly for a fresh PostgreSQL project:

```sh
atelier extension init --directory ./task-extension --model checklist --profile postgres-sql --json
atelier extension validate --directory ./task-extension --json
```

The default model remains the existing counter. The checklist defaults to the
extension ID `sample.tasks`; pass `--id` for your own permitted pack identity.
Other checklist provider profiles are refused. The generated files create no
database, process, account, installation, consent, permission or deployment.

Install the pinned dependencies, retain the resulting dependency lock and run
the generated `npm run typecheck`. For an unpublished SDK version, explicitly
install a reviewed owner-supplied tarball, record its digest, review the dependency
edit and reseal. Do not treat a scaffold or seal as an installed artifact proof.

Each task is one provider-local relational row, keyed by the verified
installation, tenant, subject and a numbered slot from 1 to 32. The slot check
and primary key bound every scope to 32 rows without a count-then-insert race.
The task's other application fields are `label` (1–80 Unicode code points,
without control characters) and `checked` (boolean). These fields and their
JSON schemas belong to this example, not an SDK or host domain canonical.

| Action | Input | Result |
| --- | --- | --- |
| `checklist.add` | `{slot,label}` | `{created:boolean}`; an occupied slot is preserved |
| `checklist.update` | `{slot,checked}` | `{matched:boolean}`; a missing slot remains absent |
| `checklist.read` | `{}` | `{tasks:[{slot,label,checked}]}`, ordered by slot |
| `checklist.export` | `{}` | `{format:'sample.task-rows/v1',rows:[{slot,label,checked}]}` |
| `checklist.delete` | `{}` | `{deleted,retention:'provider-live-rows-deleted',backups:'operator-policy'}` |
| `checklist.lookup` | `{operationId}` | Existing SDK provider-operation proof or `null` |

Use a fresh customer-owned PostgreSQL 17 database and review the generated
migration. Create the `extension_app` login and its secret separately, then
apply the migration with a distinct migration role. The application role must
not own tables, bypass row-level security or inherit unsafe roles. Both the task
and operation tables force row-level security; SQL predicates also bind all
three scope references. No host runtime database or credentials are supplied.

The backend uses the SDK's existing native `postgres` 3.4.7 transaction APIs,
verified effect scopes, delegation verification and admission consumer. The host
supplies the exact admitted installation, public verification keys, database and
process lifecycle. An admission refusal reaches no task transaction. A host
connection still requires its supported membership, consent and enablement
workflow. The generator neither executes the backend nor creates that binding.

Add, update and delete run through `oncePostgresOperation`. The task effect and
operation result share one transaction. Duplicate delivery returns the original
stored result, including `created:true` after the slot has since changed. A
reused operation with a changed action, payload, generation or release conflicts.
When a response is lost, use explicit SDK lookup/recovery before deciding on
another operation. The existing proof retains the original operation, action,
installation, generation, release, payload digest, result digest and result.
Never automatically refresh a generation or replay an uncertain write.

The logical export includes only task fields; it is not a database backup or
an accepted host import format. Delete removes this scope's live task rows and
prior provider receipts, retaining its own receipt for recovery. It does not
erase host records or promise deletion from operator-managed backups. A replay
of an older operation after explicit receipt deletion has no retained deduplication
history; the host must reconcile and govern such a decision.

The manifest has `surfaces: []`, empty root permissions and no result-recording
integration. The sample supplies neither a renderer nor an accepted host result
payload. A receiving host must separately author and verify its private adapter,
schema mapping and admission. `qualified:false` and `hostBinding:'unbound'` are
deliberate scaffold results. Sealing binds bytes; real PostgreSQL behavior,
installed artifact consumption and host acceptance require separate evidence.

The generated pack projection uses the existing non-executing extension-pack
workflow. Explicitly adopt it in the consuming project's configuration and lock;
loading it grants no authority. See the [extension SDK guide](extensions.md)
for the existing release, connection and recovery workflow.
