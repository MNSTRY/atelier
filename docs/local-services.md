# Managed local services

Atelier-backed repositories sometimes need a local authoring, review, or
preview service that writes repository-owned state. The service may be
specialized; its lifecycle and data-boundary behavior should not be improvised.

This contract applies to consumer services other than `atelier dev`. It does
not change the Atelier sidecar's own lifecycle.

## Atelier sidecar reference boundary

The built-in `atelier dev` sidecar is the reference for its request and
publication boundary, not for the managed lifecycle below. It binds only to a
literal loopback host and refuses startup without a valid generated
`atelier.manifest.json`. Static reads are limited to manifest-enrolled,
supported file types after realpath containment; hidden, state, secret-shaped,
symlinked, unknown, and unenrolled paths are denied. API reads require a trusted
loopback host and `Sec-Fetch-Site: same-origin` or `none`; `same-site` and
cross-site requests are refused. Mutations additionally require an
allowed method, exact expected origin, and the session nonce. Its collaboration
records are copy-only proposals, not an apply channel.

## Kit and adapter boundary

The portable Atelier layer owns these invariants:

- bind to loopback only;
- expose explicit `start`, `status`, and `stop` operations;
- detach only when the user asked for a service that survives an agent command;
- identify the running process with both a random runtime identifier and its
  process ID;
- refuse to adopt, overwrite, or stop a process whose identity cannot be
  proven;
- keep runtime records, logs, drafts, and recovery copies in ignored local
  storage with owner-only permissions;
- make writes atomic and keep a failed queued write from poisoning later saves;
- keep unsaved browser work available when the service disappears;
- provide an explicit snapshot export and a retry path;
- use no telemetry, remote dependency, or external send path.

The consuming repository owns its service name, port, executable, state schema,
content, command names, and user-facing recovery copy. None of those adapter
details belong in the public Atelier kit.

## Lifecycle contract

### Start

1. Resolve an explicit loopback port and ignored runtime directory.
2. Probe the service health endpoint.
3. If a managed instance answers with the recorded runtime identifier and PID,
   report it as already running.
4. If anything else owns the port, refuse to take it over.
5. Generate a fresh runtime identifier, start the child without a shell, write
   a mode-0600 runtime record, and wait for health to echo both identifiers.
6. If health never proves ownership, stop only the child just created and
   report the ignored operational log.

### Status

Status is healthy only when the runtime record, health response, runtime
identifier, PID, service identity, and loopback address agree. A responding
port without that proof is occupied, not adopted.

### Stop

Stop only the PID whose health response matches the recorded runtime identifier
and PID. Refuse on disagreement. After a clean stop, remove only the generated
runtime record. Never kill by port, process name, or broad pattern.

Managed start survives a terminal or agent command. It does not imply operating
system startup. Installing an OS-level service is a separate system change and
requires explicit user authorization.

## Authoring-state contract

- The canonical template may be tracked; the live draft must be ignored unless
  a reviewed workflow explicitly promotes a sanitized artifact.
- Live state and runtime metadata use owner-only permissions.
- Browser autosave is a recovery layer, not a substitute for the canonical
  local file.
- A lost server must produce a persistent, actionable message naming the exact
  restart command, the retained browser state, the snapshot option, and Retry.
- Conflict responses remain fail-closed. Do not silently overwrite a newer
  file or reconcile divergent tabs automatically.

## Required evidence

A consumer implementation is not complete until tests prove:

1. start is idempotent and survives the launching command;
2. status refuses an unowned listener;
3. stop is bound to runtime identifier and PID;
4. a stopped server leaves the exact in-browser draft intact;
5. restart plus Retry persists that draft;
6. a refused filesystem write does not break later valid saves;
7. private state and runtime files are ignored and owner-readable only; and
8. a fresh checkout can discover the commands through its agent instructions.

Use synthetic fixtures for public Atelier tests. Tenant-specific proof remains
in the tenant repository.

## The Obsidian maintenance service

The continuous maintenance of Obsidian views (`src/runtime/obsidian/`) is a
consumer of this contract that ships with Atelier. It keeps one service per
enabled workspace: a process that ticks the maintenance engine on an interval
and answers on one loopback port. Its lifecycle is `startService`,
`serviceStatus` and `stopService` in `src/runtime/obsidian/lifecycle.mjs`.

### Identity record

Each workspace has one record, `state/service/runtime.json`, under the
workspace's private state root in the machine-private data directory. It is
never inside a repository or a vault, its directory is owner-only, the file is
mode 0600, and it is replaced atomically. It satisfies
`contracts/atelier-obsidian-service-state.v1.schema.json`:

- the service name, derived from the workspace identity;
- the literal loopback host, `127.0.0.1` or `::1`, never a hostname and never
  a wildcard address, and the selected port;
- the executable identity: the path of the service entry module and the
  SHA-256 digest of its bytes;
- a random runtime identifier and the PID;
- the state location, a health description, and the startup consent (who
  granted it, when, and whether it covers the service only or the service and
  operating-system startup);
- in its private part, the random bearer of that one runtime. The bearer exists
  nowhere else, and nothing that `start`, `status` or `stop` returns carries it.

The record is validated on every read. A record that does not validate, or
that names another workspace, service or state location, makes `start`,
`status` and `stop` refuse with `invalid-service-record`. It is never repaired,
adopted or removed automatically; a person inspects it and removes it.

The port is a machine-specific value. `start` takes an explicit port, or
selects a free loopback port once and records it beside the consent in
`state/service/settings.json`, so later starts, `status` and any installed
unit name the same one. The first start of a workspace refuses without an
explicit consent that names its actor.

### Health fields and fixed operations

| Operation | Method and path | Credential | Answer |
| --- | --- | --- | --- |
| Health | `GET /health` | none | service name, workspace identity, runtime identifier, PID, loopback host and port, executable digest, start time, status |
| Status | `GET /status` | bearer | the health fields, loop state, last tick, last error code, and per-view freshness with held notes counted, not named |
| Tick now | `POST /tick` | bearer | the state of the tick that ran. The body may also name one view (`scopeId`, a contract identifier), which that tick prepares and publishes once more, asking the app again |
| Stop | `POST /stop` | bearer | an acknowledgement naming the runtime and PID, then the service ends |
| Plugin challenge, hello, lease, release, status | `POST /plugin/challenge`, `/plugin/hello`, `/plugin/lease`, `/plugin/release`, `/plugin/status` | a handshake over one vault's key, which never crosses the wire | Atelier's Obsidian plugin inside that vault: presence and read-only status of that one view ([obsidian-plugin.md](obsidian-plugin.md)) |

Health carries no path, no note title, no source name and no withheld
identity. There is no other operation: no file serving, no command, no
evaluation, and no route that takes a path or code from a request. The service
opens no outbound connection, has no telemetry and depends on nothing remote.

The listener refuses a request before looking its operation up when:

- `Host` is not exactly the literal loopback authority it is bound to, which
  also refuses a name that resolves to loopback;
- `Sec-Fetch-Site` is present and is neither `none` nor `same-origin`, or
  `Origin` is present and is not the listener itself;
- the path is not one of the nine, exactly and without a query, or the method
  is not that path's method.

Status, tick and stop additionally refuse without the bearer of the running
runtime. A `POST` payload is a JSON object of at most 1 KiB that names the
runtime identifier it is meant for, so a request aimed at an earlier runtime on
the same port does nothing (409, `request-names-another-runtime`). A tick may
also name one view by its `scopeId`, which must be a contract identifier as
the scope contract defines it (400, `request-invalid`); any other member, and a
`scopeId` on a stop, is refused (400, `request-member-unknown`). A refused
request runs nothing.

The plugin commands carry no credential in a header, and refuse one. The key
of a vault the workspace maintains is random per view and kept owner-only in
private state and in that vault's plugin data file; it never crosses the
wire. The service answers a challenge only for a key it holds, with a proof
over its own exact address, before the plugin sends anything that names the
vault; the plugin then proves the same key, and every later command and answer
is sealed with a key for that session, with a counter that only goes up. What
a session grants is the plugin commands for that one view and nothing else:
the runtime bearer is not accepted there, and a vault's key is not accepted by
status, tick or stop. A plugin payload is a JSON object of at most 1 KiB with
exactly the fields of its command.

### Status values and refusal cases

| Status | Meaning | `start` | `stop` |
| --- | --- | --- | --- |
| `healthy` | record and health agree on service name, workspace, runtime identifier, PID, executable digest and loopback address, and the PID is alive | reports already running | asks that runtime to stop |
| `busy` | the recorded port accepts a connection and does not answer health in time, the recorded PID is alive, the recorded entry module still has the recorded digest, and that PID's command line names that entry module (and the recorded runtime identifier when it names one) | reports it as running and busy; starts nothing | refuses with a retry hint; nothing is signalled |
| `stopped` | no record and nothing listens | starts | nothing to do |
| `occupied` | something answers on the port without that proof: another program, a silent listener that is not provably ours, or a health answer with any field different | refuses; never takes over | refuses |
| `stale-record` | the recorded address is closed and the recorded PID is gone | starts; the new service replaces the record once it listens | refuses; nothing is proven to stop |
| `pid-not-ours` | the recorded address is closed and a process has the recorded PID (the number was reused, or a process outlived its listener) | starts; that PID is never signalled | refuses; that PID is never signalled |

`start` is serialized per workspace, spawns the service without a shell, in
the root directory rather than the one the command runs in, and detaches it
only when asked for a service that survives the launching command.
It waits for health to echo the runtime identifier it generated and the PID of
the child it created. If that proof never arrives it stops only that child, by
its process handle, and reports the private operational log,
`state/service/service.log`.

A tick is largely synchronous, so a healthy service in a long tick may not
answer health within the deadline. That is `busy`, not `occupied`: it is
never adopted, never stopped and never started over, and a `start` whose own
child went straight into a long first tick reports it as started and busy
instead of ending it. The command line of another process is read from
`/proc/<pid>/cmdline` on Linux and from `/bin/ps` on macOS. It is not
established on Windows, where a silent service still reads as `occupied`.

`stop` sends the stop operation to the proven runtime only, waits for that PID
to end and removes only the generated record. It never looks a process up by
port, name or pattern. Ending a proven runtime that ignores the request is
opt-in and is proven again immediately before the signal.

A runtime of an earlier release is replaced by a command that asks for a tick
with the start options of the installed entry (`requestServiceTick({ service
})`; `open` does). Every runtime records at its start the release it runs
(`executable.ext.release` in its record): the package version and a digest of
every runtime module it ships (`src/` and `contracts/`, by path and content),
and of the plugin it publishes into every vault (`plugins/`; none where a
package has no such folder).
A runtime of an earlier release proves itself `healthy` but records an earlier
version than this package's, this version with an entry module or modules of
other content, or no release at all (releases up to the one that began
recording it); or it refuses a tick that names a view, as releases up to
0.2.0-alpha.11 do (their `POST` payload has exactly one member). Versions are
ordered as semantic versions, a prerelease below its release
(`0.2.0-alpha.11` < `0.2.0-alpha.12` < `0.2.0`; `releaseStanding` in
`lifecycle.mjs`). It is stopped as `stop` stops it and the installed entry is
started, detached, under the consent already recorded; the answer carries
`restarted: "outdated"`, and `open` shows `service: restarted (outdated)`. A
runtime that records a later version, or another version that cannot be
ordered against the installed one, is never
replaced by this release, nor asked for the tick: the answer is
`service-other-release` (`open`: `service-unavailable`, with the next step
`atelier obsidian service stop`, then open again). So two installations used
on one workspace, a global and a project-local one for example, do not replace
each other's runtime on every open; within one version, other content is
replaced. The same version string is compared by content even when it cannot
be ordered (a fork's `dev`, say), so the runtime `open` just started is always
this release and "service stop, then open" cannot loop. A listener of now refuses a tick only when it names another runtime,
which happens when a concurrent command replaced the runtime between the check
and the request: the record is read again, the runtime that took its place is
asked, and nothing is restarted. A `busy` runtime is not stopped, and anything
that is not a proven runtime of this workspace is never stopped. Without the
start options the runtime is only reported (`service-outdated`).

The service itself refuses to start beside a runtime of the same workspace
that proves itself, and ends cleanly when its record no longer names it. Two
engines can never tick one workspace together: each tick holds a private
per-workspace lock, and an engine that finds it held writes nothing and
reports busy.

### What stop and a hard end leave intact

On `stop` the tick in flight finishes, within a grace period. Drafts in a
vault, pending edits, recovery copies, staging and the last good view are left
exactly as they are. The service never sweeps or deletes anything under
`staging/` or `recovery/`: not at start, on a tick, at shutdown, after a hard
kill or when it finds a stale record. A publication cut short by a hard kill
is settled by the publisher's own journaled restart recovery on a later tick.

A tick that fails for a reason nobody typed (a full disk, a crash inside a
step) does not end the service. Its error code is kept in
`state/service/last-error.json`, its message only in the private log; the
delay before the next attempt doubles up to a ceiling, and the next tick
proceeds.

### Cases that need a person

- a record that does not validate, or that belongs to another workspace;
- an `occupied` port: decide what owns it, or select another port;
- an engine lock whose holder is a live process that recorded no health
  address, a lock written on another machine, an unreadable ticket, or an
  unknown file in the lock directory. A lock is taken from a holder only with
  proof that its process is gone, or that it was a service whose recorded
  address is closed or answers as another runtime or PID. An address that
  accepts a connection and does not answer in time proves nothing.
  `inspectPrivateGenerationLock` reports the holder without changing anything.

### Operating-system startup: the login item

`buildStartupAdapter` returns the text of a launchd user agent (macOS) or a
systemd user unit (Linux) from the values it is given. It writes no file,
installs nothing, runs no service manager and looks nothing up on the machine.
Windows startup has not been qualified and refuses with
`startup-platform-unqualified`. The unit runs the service entry with
`--startup` in the root directory, with the search path it is given, and is
restarted after a crash or a non-zero exit but never after a clean one:

| Key | launchd | systemd |
| --- | --- | --- |
| Program | `ProgramArguments`: Node, the entry, `--startup`, `--project`, `--data-root`, `--workspace-id`, `--adapter` | `ExecStart`, the same words |
| Search path | `EnvironmentVariables` `PATH` | `Environment="PATH=…"` |
| Directory | `WorkingDirectory` `/` | `WorkingDirectory=/` |
| Start | `RunAtLoad` | `WantedBy=default.target` |
| Restart | `KeepAlive` `SuccessfulExit` false, `ThrottleInterval` 60 | `Restart=on-failure`, `RestartSec=60`, `RestartPreventExitStatus=2` |
| Stop | `ExitTimeOut` 60 (a tick in flight gets 30 s) | `TimeoutStopSec=60` |
| Process type | `Standard`: the service's budgets were measured without background I/O throttling | – |
| Output | `StandardOutPath`, `StandardErrorPath`: `state/service/login-item.log` | `StandardOutput`, `StandardError`: `append:` the same file |

Installing one is an explicit request (`service unit --install`), never a
side effect (`src/runtime/obsidian/login-item.mjs`):

1. The entry is the one of the package installed for the project, found as
   Node finds a package from the project's folder and named by that path,
   not its real path, so an upgrade or a re-pointed link is what the next
   start runs. Without one, the command's own package is used unless it lies
   in a package runner's cache (npx, pnpm dlx, bunx) or a temporary folder:
   `login-item-needs-installed-package`. Node is named by its real path, so a
   version manager's per-shell link is never named. The search path keeps
   absolute entries once, and none in a temporary folder. The unit always
   names the data root the workspace was resolved under (the flag, the
   pointer, the overlay's preference or the platform default, such as
   `$XDG_DATA_HOME/atelier`) and the workspace identity, because the
   manager's environment carries only the search path: the service at login
   finds the same workspace, and, when the project no longer leads to it (it
   moved, or its pointer is gone), records its refusal in the workspace the
   unit names, if that exists.
2. The consent is recorded before the unit is loaded, because the manager
   starts the service as soon as it loads it: `--consent-actor ID`; for a
   person at a terminal, the actor already recorded for the workspace or else
   the account's name (asking for the login item there is that person's
   consent); or a recorded consent that already covers startup. Otherwise
   `startup-consent-required`. Its coverage becomes `service-and-startup`.
   A proven service of an earlier release than the entry the unit will run
   is stopped then, as `service stop` stops it, so the unit's own start at
   load runs that entry instead of refusing beside the earlier one; if the
   manager then refuses the unit, the entry is started as a child for this
   session.
3. The injected service manager (`service-managers.mjs`) writes the unit
   atomically with mode 0644 and loads it. launchd: bootout of a loaded job
   (it keeps the definition it was loaded with), a bounded wait until launchd
   lets it go, then `bootstrap gui/<uid>`. systemd: `daemon-reload`, `enable`.
   A manager that refuses the unit leaves the consent as it was.
4. `state/service/login-item.json` (`atelier-obsidian-login-item/v1`) records
   the label, allocated once and kept, the unit file, the digest of its text,
   the program and the search path. The answer is remembered as the
   `loginItem` decision of the machine settings (`on`), by the actor named or
   the person at the terminal; `--adapter=obsidian-cli`, when given, is
   remembered as for `service start`.

The production manager (`service-manager-production.mjs`) is the only code
that runs `launchctl` or `systemctl` or writes into `~/Library/LaunchAgents`
or the user's systemd folder. It is imported only by the command entry, and
refuses under the Node test runner (`real-login-item-under-test`) and when
HOME is not the account's own home directory (`login-item-home-mismatch`):
a unit is registered in the account's real session whatever HOME says, so a
private HOME never installs one.

Once installed, `startService` starts the service through the manager
(`launchctl kickstart -p`, `systemctl --user start`) instead of spawning a
child, so two starts never compete, and accepts the runtime that proves itself
with a record naming the digest of the entry the unit runs; the runtime
identifier is the service's own there. As for a child, it waits for that
runtime to be healthy and answers `busy` only when the wait is over and the
runtime is still in its first tick. A listener that has not written its
record yet is waited for as that service, never adopted. On the way, a unit
whose text differs from what would be written now, keeping the recorded
search path, is written and loaded again (`loginItem: { refreshed: true }`).
The manager is asked first whether the person switched the item off (System
Settings on macOS, `systemctl --user disable` on Linux); one that is off is
neither written again, reloaded, enabled nor started through the manager
(`login-item-switched-off`). A unit that is switched off, whose file is gone,
or that the manager does not have loaded (no user systemd), is not forced: a
child is started for that command only, and the answer says why (`loginItem:
{ via: 'child', reason }`). `requestServiceTick` replaces an outdated service the same way,
and so does `startService` with `replaceOutdated` (`service start`): a proven
runtime of an earlier release is stopped through its own listener, under the
start lock, and the installed entry started in its place
(`replaced: 'outdated'`); one of a later release is left running and
answered as `release: 'later'`.

Which release is installed is read from the entry that would be started
(`runtimeRelease`): the digest of that entry, and `readReleaseIdentity({
root })` of the package that entry's path names (its root is the folder above
`src/runtime/obsidian/service-main.mjs`, read without resolving links), read
now and never cached. With a login item that is the project's own package,
whatever package the command runs from, and a re-pointed link or a `file:`
install is read where it leads now. An entry that is not a package's service
entry (a test entry) is measured against this package's own release,
`releaseIdentity()`, the cached form a service records when it starts. Both
cover the package version and every file under `src/`, `contracts/` and
`plugins/`; a package without `plugins/` reads as one with an empty one.

Under `--startup` the service:

- writes its log into its own bounded `service.log`, as under `start`; the
  unit's output file receives only what happens before that log is open;
- exits 0 on a refusal as well (another runtime of this workspace answers, no
  consent that covers startup, an occupied port, arguments it cannot use), so
  its manager does not start it again every minute, and records how the start
  ended in `state/service/last-startup.json`
  (`atelier-obsidian-last-startup/v1`: `at`, `outcome` `started` or
  `refused`, `code`); `status` reports a refusal while the service is not
  running;
- records the path it was started by beside its real path
  (`executable.ext.invokedAs`), so the busy proof reads a process table that
  names the entry through a link;
- after every tick, compares the release on disk, read through the path it
  was started by, with the one it started with (`readReleaseIdentity`: the
  package version and a digest of every file under `src/`, `contracts/` and
  `plugins/`). The files' status is
  compared first and the digest computed only when that differs; a package
  that cannot be read is not a change yet. When they differ, the service
  finishes the tick, removes its record and exits 75, which its manager
  restarts on the new release.

`service unit --remove` lowers the consent to the service alone first, so a
unit a failed removal left behind could only refuse, then unloads it (launchd
`bootout`, systemd `disable --now`, which stop a service it runs) and deletes
the file and the record, and remembers `off`. It then starts the service again
at once as a detached child for this session, under the consent now recorded,
when the adapter is given or remembered; otherwise the next `open` starts it.
`uninstall` removes the login item and stops the proven service, remembers
`off`, starts nothing, and keeps the vaults, the private state, the project
file and Obsidian's vault list. Removing Obsidian's vault entries is not part
of it.

The service entry refuses to run without an explicitly selected editor
adapter. Public Atelier tests start only a test entry whose adapter reports
that no app runs, in temporary directories, on ephemeral loopback ports.

### The `obsidian` command

`atelier obsidian <operation>` is the noninteractive surface over all of the
above. With `--json` it prints exactly one JSON document, for a refusal too.
Exit codes: 0 done, 1 an error nobody typed, 2 a typed refusal or a usage
error, 3 the operation ran and its answer is not success.

| Operation | What it does | Writes |
| --- | --- | --- |
| `status` | enablement, machine settings, what was decided, proven service state, per-view freshness with its diagnostics (a code, the rule and the in-view note concerned, never a value; see [the Obsidian contract](obsidian-contract.md#notes-that-were-laid-out-anyway)), whether an apply operation exists | nothing |
| `settings` | what this machine remembers for the workspace (who may see, where vaults live, start at login, the adapter), who allowed the service, and how each answer is changed | nothing |
| `scope list`, `scope show ID` | the declared views | nothing |
| `audience show`, `audience set me\|A,B`, `audience clear` | the audiences this machine lets into a view; none by default, which publishes an empty view. `me` is only you: every audience but `sensitive`, which is added by name. The answer is remembered as the person's decision. A change invalidates every view at the next tick | private machine settings |
| `mode show`, `mode set manual\|automatic` | `automatic` refuses without an installed, matching, active automatic policy | private machine settings |
| `policy show`, `policy install FILE`, `policy revoke` | `install` validates against the apply-policy contract and stores the policy owner-only beside the machine settings, never in a project, a repository or a note. `revoke` marks the stored policy revoked, which the engine reads before its very next dispatch, and returns the mode to manual | private machine settings |
| `service start`, `service status`, `service stop` | `startService`, `serviceStatus`, `stopService`. The first start records who allowed it: `--consent-actor ID`, or for a person at a terminal the account's name. `service start` replaces a proven service of an earlier release (`replaced: 'outdated'`) and never one of a later release (`release: 'later'`); with a login item it starts the service through it | what the lifecycle writes |
| `service unit --print` | the text `service unit --install` would write now | nothing |
| `service unit --install` | installs the login item and starts the service through it (see above). macOS and Linux | the service settings (consent), the unit file, `login-item.json`, the `loginItem` decision |
| `service unit --remove` | lowers the consent to the service alone, unloads and deletes the unit, and starts the service again as a detached child for this session | the service settings, the unit file, `login-item.json`, the `loginItem` decision |
| `uninstall` | removes the login item, stops the proven service, and prints where the vaults, the private state, the project file and Obsidian's vault list are; each is kept, and nothing is started again | the login item's files, the `loginItem` decision |
| `open [--scope ID]` | starts or reconnects the owned service, asks it for a tick, reads the view back, qualifies the installed app, makes the app know the vault (through the app while it runs; in its settings while none runs), has the vault opened, and asks again for a view the app kept from publication | what the service writes; the app's vault list (see [Obsidian's vault list](obsidian-contract.md#obsidians-vault-list)) |

Reaching the installed app or the operating system is never a default.
`open`, `service start` and `service unit` refuse with
`app-adapter-not-selected` unless `--adapter=obsidian-cli` is given, or was
given once before to `open` or `service start` of this workspace, which
remembers it (`selectAdapter`); `service unit --install` refuses the same way.
The service entry keeps its own explicit rule. The modules that talk to an app
are loaded only after that selection. A remembered adapter is used only by the
real command-line entry and never under the Node test runner
(`remembered-adapter-under-test`). A service manager is the caller's
(`serviceManager`, or `seams.serviceManager`), or, for the real command-line
entry only, the production one. Tests pass their own seams and a guard in the
test file throws if anything tries to start the app, its command-line tool, an
operating-system opener or a service manager, touches the account's real
LaunchAgents or systemd folder, or starts the `obsidian` command's `open` or
`service` outside the test runner's context with an environment that leads to
the developer's app.

A person at a terminal is never asked anything by these operations, but the
first start of the maintenance service records the account's name as the
actor that allowed it when no `--consent-actor` is given. A person is at a
terminal when standard input and output are both terminals and neither
`--json`, `--no-input`, a `CI` environment nor `ATELIER_NONINTERACTIVE=1`
says otherwise (`isInteractive`); under the test runner the process's own
terminal is never looked at. A recorded consent is never replaced by a derived
one.

`open` answers one typed outcome, each with a one-line explanation and a next
step. Only `current` is success:

| Outcome | Meaning |
| --- | --- |
| `current` | the proven service ticked after the request; the view's persisted freshness is `current`; read back independently, the trusted generation is the prepared one and every note has the bytes it was published with; the app meets the minimum version, knows this vault as one of its vaults, was asked to open it, answers for exactly this vault and has finished reading it |
| `updating` | a publication is under way, a tick outlasted the wait, or a note differs from the trusted generation and has not been looked at yet |
| `held-for-your-edit` | an edited note is preserved and held |
| `stale-readable` | a last good vault exists and reads back, but is not proven to be the present generation |
| `not-prepared` | no generation of this view has been published |
| `publisher-conflict` | another publisher or an uncoordinated editor holds the vault |
| `app-missing`, `app-cli-unavailable`, `app-version-unsupported` | no installation; no command-line capability, or the command line turned off in Obsidian (`cli-turned-off`); below the minimum version, or a version that cannot be read (reason `no-vault-open` when the app runs with no vault open and its command line answers nothing else) |
| `launch-failed` | the vault could not be added to the app's list (a typed reason names why), the operating system refused, or the app never answered for this vault |
| `indexing` | the app answers for this vault and has not finished reading it |
| `service-unavailable` | the service could not be started or is not provably ours (`occupied`, no consent yet, a start that never proved ownership), or it runs a later release than this command (`service-other-release`) |
| `busy` | the service is ours and in a long tick |
| `disabled` | the integration is off or not declared |

`apply-unavailable` is not an opening outcome. It is reported beside pending
edits, by `status`, `open`, `mode` and the placeholder `apply` operation, for
as long as no apply operation is registered. `status` does not repeat a
persisted `current` while no healthy service proves it: opening a vault
directly bypasses this command, so an old check is reported as
`stale-readable` with the reason.

The minimum app version is `MINIMUM_APP_VERSION` in
`src/runtime/obsidian/app-capability.mjs`: 1.13.7, the only version the
publication protocol was proven on. A prerelease ranks below its release and a
version that cannot be parsed never passes. The service entry constructs the
CLI editor adapter only through `createQualifiedAdapterFactory`: for a running
app below the floor, an unreadable version or a missing command-line
capability the factory refuses, the engine records that code as the view's
freshness reason and nothing is published. An app that is positively not
running needs no version, because nothing is published through it.

The production probe and launcher (`app-production-seams.mjs`) are written
against the documented command-line interface and have not been exercised
against a running app in this repository's tests, by design. They are to be
qualified on an isolated host before they are relied on.

`atelier sync` does not maintain a vault and does not try. When the enrolled
project enables the integration, `sync status` gains one member,
`obsidianMaintenance`, that repeats what maintenance last persisted and points
at `atelier obsidian status`; it starts no service, ticks no engine and writes
nothing. With the settings absent or switched off its output is unchanged.

### Registering later work

An apply operation, a proposal adapter and further `obsidian` sub-operations
are contributions: a module in `src/runtime/obsidian/contributions/` whose
default export is `{ id, register({ extensions, operations }) }`. The command
and the service entry both load that directory, so an apply operation
registered there is the one the service dispatches to and the one `status`
reports. No dispatch file is edited. A built-in operation name cannot be
taken, except the placeholder `apply`.
