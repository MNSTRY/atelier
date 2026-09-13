# Project option and command inventory

`--project PATH` and `--project-config PATH` select the first explicit config.
Repeated `--repo-path NAME=PATH` uses the last value for each name; paths resolve
from the invocation's current directory. Both separated and equals forms work.
Resolution precedence is CLI override, ignored local overlay, tracked relative
location, then declared sibling discovery. Overrides do not declare repositories
or widen read boundaries. Missing required sources still fail.

`atelier config check --explain` reports logical names, resolution sources,
resolved state and read boundary without machine paths. Normal config diagnostics
remain local. `MNSTRY_ATELIER_PROJECT_CONFIG` and local overlays retain their established
resolver behavior. Shared options are parsed by the resolver, including direct
module calls and branded `runCli` wrappers; wrapper authors must forward argv.

| Family (aliases share implementation) | Location and side effects |
| --- | --- |
| graph; project/build; readiness/generated; context/resolve/capabilities/proposal | Shared project resolver. Graph/projection/readiness and proposal operations can create local outputs/history. |
| dev/server | Shared project resolver; foreground loopback service. `--review` opts into local review ledgers. |
| config/manifest; extension-pack/list/validate | Shared resolver; project resolution may ensure ignored local state. Pack loading is declarative, with no extension execution. |
| support/bundle; analysis/analyze | Project-aware implementation; local previews/explicit output or disabled-by-default analysis contracts retain their existing controls. |
| boundary/check/doctor/push-check/audit/install-hooks; promote | Project-aware implementation; checks and explicit hook/promotion operations retain their own mutation guards. |
| lock/check/write; upgrade | Shared project resolver, except standalone `lock provenance`. Lock write and upgrade apply retain their explicit operation semantics. |
| review run/history/handoff/packs/export | Shared resolver; bound runs and contributions use ignored state. Export previews unless explicitly written. |
| review inspect | Standalone inert file inspection; does not resolve a project or create active review state. |
| coauthor | Current Git workspace only; JSON stdin. Explicit start/event/recover writes ignored private drafts and ledger events. Never relocates or edits canonical sources. |
| init; setup/adopt/doctor | Scaffold/adoption-specific target handling; no new universal target semantics. |
| sync | Repository-operation interface owns `--repo`; enrollment accepts its existing project-config option. It is not an adapter source relocation command. |
| distribution; disclosure; attestation; feedback; announcements; egress; contract; export/dry-run | Artifact/package/repository-specific entry points retain their own targets and option validation. |

Command-specific parsers retain ownership of their options. The shared project
parser never globally allows arbitrary flags. The strict extension-pack and new
review interfaces reject unknown options before operation. Legacy permissive
entry points retain compatibility rather than gaining an unrelated syntax change.
Regression coverage exercises moved sources through the published CLI, legacy
alias, branded wrapper and direct pack module, plus project command families.
The installed consumer gate repeats the external adapter journey across two
source locations and checks that missing or stale inputs cannot gain authority.
