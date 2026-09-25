# Changelog

## Unreleased

### Added

- `atelier enroll documents [--audience private] [--dry-run] [--json]` writes
  a minimal `<file>.kg.json` sidecar next to every `.html`, `.pdf` and
  `.docx` document the knowledge graph reads that has none, so an adopted
  vault with attachments, a static website or a folder of documents can pass
  `atelier graph` without hand-written sidecars. Each sidecar carries the
  document's title, the domain, lifecycle and status the graph infers, the id
  `<repo>:asset:<path>` (with a short digest when two paths fold to one id)
  and the audience `private`. `--audience` picks another, which the
  repository's boundary policy must allow; a refusal is typed
  (`enroll-audience-not-allowed`) and names the allowed audiences before
  anything is written. An existing sidecar, including one Git ignores or a
  link with the sidecar's name, is never changed, and sources are never
  changed. See `docs/install.md`.
- `atelier adopt --enroll-documents [--audience AUDIENCE]` adopts and enrolls
  in one step, checking the audience against the policy before adoption
  writes anything.

### Changed

- `setup.include` and `setup.exclude` in `atelier.project.json` now scope
  what the knowledge graph reads. `adopt --include` and `--exclude` recorded
  them, and the `monorepo` profile required `--include`, but nothing read
  them, so a tracked build folder could not be left out and every tracked
  page needed a sidecar. Each is a path pattern relative to the project
  config's folder, in the boundary policy's `forbiddenPaths` dialect; a path
  outside the scope is treated exactly like a Git-ignored one, and a sidecar
  follows its source. A project that already sets either field gets a graph
  over that scope from this release: run `atelier graph` and commit the
  result. Both values must now be relative (the contract's `pathString`), and
  `adopt` no longer writes them as `null`. The decision is recorded in
  `docs/install.md`.
- `atelier graph` ends its error list with a `Next:` line naming
  `atelier enroll documents` when a document has no sidecar.

### Fixed

- The project readiness artifact (`atelier-output/atelier-readiness.json` by
  default) records `graph.path`, `projection.outputRoot` and
  `projection.entry` relative to the project configuration directory, in POSIX
  form, instead of as absolute paths. `atelier readiness --check` and
  `atelier generated check` now accept an artifact written in another checkout
  of the same project, and the artifact no longer names the machine's
  directories (which could include the account name). An exact upgrade
  candidate's readiness bytes now match what `atelier readiness` regenerates
  there; before, when the path to the candidate passed through a symlink (as
  macOS temporary directories do), the check reported the new candidate
  stale. `atelier upgrade explain` no longer warns that readiness bytes can
  contain absolute host paths. An artifact written by an earlier version is
  reported stale once; run `atelier readiness` to rewrite it and review the
  difference.

## 0.2.0-alpha.12

### Added

- Atelier's own Obsidian plugin (phase 1: presence and status). Every vault
  the maintenance service publishes now carries it under
  `.obsidian/plugins/atelier-projection/` with its entry in
  `.obsidian/community-plugins.json`; the person never installs anything, and
  Obsidian asks once per vault whether to trust the vault's plugins. Once
  trusted, a status bar item says whether the view is current, updating, held
  for an edit, stale or out of reach of the service, and "Atelier: show
  status" says why. The plugin writes nothing, runs nothing it is sent and
  reaches only the workspace's maintenance service on its literal loopback
  address. Without it (restricted mode, an app older than 1.13.7, before the
  prompt is answered, or turned off in the vault) everything works as before.
  See `docs/obsidian-plugin.md`.
- A person who turns Atelier's plugin off in a vault, or uninstalls it there,
  is followed. Once the app has the plugin's entry in
  `community-plugins.json` (it was in place before an app opened the vault,
  or the plugin ran there), a list without it is recorded as the person's
  decision (private state, `state/plugin/choices/`): the entry is not added
  back, a deleted plugin folder is not made again, and the plugin files still
  there are kept current. An entry published while an app held the vault is
  only offered until then, since that app may write back the list it read
  before, and a list without it is no decision of the person's. `status`, `open` and the new
  `atelier obsidian plugin show` report `turned-off-in-this-vault`. Turning the
  plugin on again in Obsidian's settings is followed the same way;
  `atelier obsidian plugin on --scope ID` brings the entry and the files back
  (the way back after an uninstall): at once, on a tick that names the view,
  while the maintenance service runs (with `--adapter=obsidian-cli`, one of
  an earlier release is replaced by the installed one first, as `open` does),
  and otherwise at the view's next publication.
- The maintenance service answers five plugin commands (`/plugin/challenge`,
  `/plugin/hello`, `/plugin/lease`, `/plugin/release`, `/plugin/status`,
  protocol `atelier-obsidian-plugin-channel/v2`) and grants presence and
  read-only status of one view to a plugin that proves it holds that vault's
  key. The key is random per vault, kept owner-only in private state and in
  that vault's plugin data file, and never crosses the wire: the service
  proves it holds the key over its own exact address before the plugin sends
  anything that names the vault, and every later request and answer is sealed
  with a key for that session and a counter that only goes up. A program that
  takes the service's port while the service is down learns nothing it can
  use: an answer the session's key does not seal ends the session in the
  plugin, so such a program receives one command of a session at most; a
  challenge is answered once and only within thirty seconds of the time it
  names, and at most four handshakes wait per view. `status` reports which
  views a plugin holds open, and so do `atelier obsidian status` and `open`.
- While one launch of the plugin holds a view open and the command-line
  tool gives no version (no vault open yet, or no answer in time), the app
  version the plugin reports counts as checked (reason `plugin-reported`), in
  the service's adapter factory and in `open`, unless the process table shows
  no app running (a lease outlives a crashed app by a few seconds, and then
  vouches for no version). A version the tool does give
  decides, since the tool may reach another app holding the same vault, and
  whether the app and its tool are installed is still the probe's answer.

### Changed

- Node.js 24 is supported alongside Node.js 22. The engines range is now
  `>=22.18.0 <23 || >=24.13.1 <25`, so an install on Node 24 no longer warns.
  Graph and projection files come out byte-identical on either major: CI runs
  the complete suite on 24.13.1 and on the newest 24, and a new
  `cross-node-bytes` job builds one workspace on 22 and on 24 and compares
  every file written. The byte-determinism test names the supported majors
  and checks them against `package.json`. The floor is 24.13.1, not the
  first 24 LTS, because earlier 24 releases have an `fs.rmSync` defect
  (nodejs/node#61020): removing a symbolic link to a directory throws
  `EISDIR`, and a broken symbolic link is silently left in place. The
  complete suite fails on 24.11.0 for that reason.
- **Breaking:** Obsidian generation manifests of the new vault layout are
  `atelier-obsidian-generation-manifest/v2`, a new contract major that records
  `layoutVersion: 2` and each note's identity region, and a vault an earlier
  release published is laid out again once (below). The v1 contract is
  unchanged and still validates every generation an earlier release wrote; a
  reader of generation manifests must accept both majors.
- Obsidian views are laid out in vault layout 2, so a file name reads as the
  note's title and the vault reads as the repositories. Folders mirror each
  repository under a folder named after it, so a view's folders show the
  repository identity and source directory chain of its notes, as its notes'
  `atelier-repo` and `atelier-source` properties do; this is acceptable for
  every vault, scoped ones included. A note's file name is its title (the
  front-matter `title`, else its first H1, else the file stem as written),
  with a trailing source extension dropped and made safe for macOS, Linux,
  Windows and Obsidian links. Two notes of a view that would share a name in
  one folder, compared case- and normalization-insensitively, are told apart
  by the source file stem and then by a short stable id; a name that collides
  with nothing carries no hash. A wrapped file keeps its own name beside its
  note (`<file name>.md`), and an embedded file is copied to its mirrored
  path. Links name their target by its full vault path. A repository folder
  that would be `notes` or `attachments` spelled another way is told apart by
  a short id, since an upgraded vault keeps those two folders of the earlier
  layout.
- Each view allocates its paths among its own notes, seeded from what its
  prior generation published: a path does not change on retitle or when
  other files come and go, a note that leaves the view releases its path
  there (a renamed source takes its name back), a note of another view never
  causes a qualifier, and a lost path registry costs no view its paths. One
  identity may have different paths in different views. The registry keeps
  each view's allocation in a section of its own, and drops the sections of
  views the engine no longer maintains. `@mnstry/atelier/obsidian/materialize`
  adds `allocateViewPaths`; `allocateWorkspacePaths` is deprecated: it still
  allocates the earlier layout's paths for a whole workspace, exactly as
  before, and Atelier no longer calls it.
- A source that does not fit is laid out anyway and reported, never a reason
  to refuse the workspace: a folder chain too long for the path budget keeps a
  readable prefix and a short stable id, or, when not even that fits, the note
  sits directly in its repository's folder; a source folder that meets a file
  of the same name is qualified with an id. Only a name that does not fit even
  in its repository's folder refuses the view. What is worth a look (these, an
  author's own identity keys shadowing the generated ones, generated text that
  names a note outside the view without refusing it) is recorded in the
  manifest and the view's freshness entry, and shown by
  `atelier obsidian status`, naming the note.
- Every note names its identity in three generated front-matter properties,
  `atelier-id`, `atelier-repo` and `atelier-source`, or, when its own front
  matter could not take them unchanged in meaning, in a generated block at
  its end. An edit to them is never applied to a source.
- A vault published by an earlier release is laid out again once. Every
  earlier path is retired through the publisher's remove units: moved to the
  recovery area, or kept where it is when somebody edited it. The app's
  bookmarks, open tabs and graph positions of the earlier paths are lost once.
  A view that holds a note for an open edit keeps its earlier layout until the
  edit is applied or withdrawn, and such an edit still applies; an edit that
  closes on a tick (automatic mode applies on the tick it observes) keeps it
  for that tick, so the file the person edited becomes the published note and
  is retired like any other. See "Vault layout" in `docs/obsidian-contract.md`.
- The redaction guard is re-based on the readable layout. Atelier never
  generates a reference to a note outside a view: every path the emitter
  writes must be one allocated to the view, and every identity block names
  its own note. Generated prose repeats author text (the titles, summaries
  and tags of in-view notes), which is carried as authored; the deny-list over
  it, read as a reader sees it with the emitter's escapes removed and in NFC,
  follows the audience, as defence in depth. For a note the audience may not
  see it refuses an unambiguous identifier (an identity qualified by any
  repository, a repository-qualified path, a repository-relative path with a
  folder, a vault path) and reports a bare-word identity or a file name at a
  repository's root (`README.md`); for a note the audience may see but the
  view does not select it only reports. A view may newly refuse with
  `redaction-failure`; the refusal names the rule and the in-view note, never
  the value. Both rules run over every note, cached ones included. The deny
  matcher is one automaton: building it takes time and memory linear in the
  values it holds, on every preparation, and it reads each text once, however
  many there are.
- A focus query names each note by an anchored regular-expression path term
  (`path:/^…$/`, query version `obsidian-graph-search-paths/v2`), so it matches
  exactly the selected notes; a focus persisted with the earlier version is
  still read.
- `atelier obsidian open` makes the first open of a view automatic: Obsidian
  no longer has to be quit, and no vault folder has to be opened by hand. It
  makes the app know the view's vault as one of its vaults before it opens
  it. With Obsidian running and
  answering its command line, the vault is added through the app itself
  (`vault-open` through `obsidian-cli eval`, a constant script with the folder
  as a base64 JSON payload), verified in the app's own vault list by real
  path, and opened; `open` waits until the app answers for exactly that vault
  and then asks for the view again, so the first publication runs through the
  app with every editor check. Quitting Obsidian is no longer needed. With
  Obsidian not running, the view is published on the path with no app, and
  the vault is added to the app's `obsidian.json` before the app is started
  on it: only while the process table shows, positively, that no Obsidian
  runs (read again immediately before the rename), only a file Obsidian
  created, owned by this user and not a link, atomically (a temporary file in
  the same directory, fsynced, renamed), keeping every other key and entry,
  and with a timestamped backup beside it; a write that fails at any step
  leaves the file as it was and nothing beside it; an Obsidian that never ran
  on the account (no such file) is asked to be started once. With Obsidian running
  and no vault open, a vault the app already lists is opened by path; one it
  does not list is answered as `app-version-unsupported` / `no-vault-open`
  (open any vault, or quit Obsidian, then open again) and nothing is
  written. Every failure is typed and names its next step. See "What `open`
  does in each state of Obsidian" in docs/obsidian.md and "Obsidian's vault
  list" in docs/obsidian-contract.md.
- A tick requested over the service's listener may name one view
  (`POST /tick` with `scopeId`; `requestServiceTick({ scopeId })`), which the
  engine then prepares and publishes once more, whatever its state
  (`engine.requestPreparation(scopeId)`, a one-shot request consumed at the
  next tick), with the app's qualification asked again. `open` names its view
  on both ticks it requests. A view whose last publication did not settle is
  also tried again without a request: as soon as the app looks different (it
  quit or started, or opened or closed a vault in its list), and otherwise
  after a delay that starts at 30 seconds (`DEFAULT_PUBLICATION_RETRY_MS`) and
  doubles, up to the full reconciliation interval. Before, it waited for a
  change or the five-minute reconciliation. What the app looks like is read
  from the process table and its vault list alone (`appStateSignature({
  processes, settings })`), so nothing runs in Obsidian to find out; the app
  is asked for its version only when a view is about to be published, and
  the service's adapter factory asks it without blocking
  (`createQualifiedAdapterFactory` answers a promise for an app probe with
  `inspect()`). `engine.requestPreparation` takes a request only for a view
  the project declared at the last tick (at most 64 before the first), and
  answers whether it did. The service listener answers a POST member it does
  not know, or a view on a stop, with 400 `request-member-unknown` instead of
  409, and checks a view against the scope contract's own identifier.
- Command-line calls to the app reach only the vault they are about. A call
  about a vault names it first (`vault=<id>`), so it reaches that vault's
  window whichever window has focus; only when that id would name another
  vault first does it run in the vault's folder, and not at all when a vault
  the app lists before it at a folder above it (a home folder, say) would take
  a call run there. The vault root, the settings entry, the vault check and
  the publication bridge's check that the app holds this vault use the path as
  the file system stores it, so on macOS a data root given in another letter
  case neither hides a vault listed above it nor routes a call there, and a
  store written before, or an app that holds the vault under another spelling
  or through a link, keeps working: publication through the app, and `open`'s
  check that the app answers for the vault. Publication calls do so only while the app's list
  shows the view's vault open; every other call runs in a directory that is
  no vault. Maintenance never reopens a vault window that was closed and never
  reaches another vault, and the directory a command or service was started
  in no longer picks, or opens, a vault. `open` never adds a view's vault
  inside a folder Obsidian already lists as a vault, which would show the
  view's notes too: it answers `launch-failed` / `vault-inside-another-vault`.
  A listed folder is compared as written first; its real path is read only
  when its last component is the vault root's, so a vault on a mount that
  does not answer is never waited on. The maintenance service is started in
  the root directory.
- A view's vault that Obsidian has open in more than one window, one per
  entry of its vault list that names the folder (under another letter case,
  or through a link), is not published: a publication would coordinate with
  one window only. The view reports `publisher-conflict` /
  `vault-open-in-several-windows` (removing the extra entries from Obsidian's
  vault list clears it; closing a window may not, since Obsidian keeps the last
  window it closed marked open), and `open` answers the same, names the entries (`open in Obsidian
  as: …`, `duplicates` in JSON) and launches nothing. While one entry of the
  folder has a window, calls and `open` reach only that entry, so a closed
  entry of the same folder is never opened beside it.
- Obsidian's settings file is not written larger than 4 MiB
  (`obsidian-settings-too-large`), nor through a second name (a hard link,
  `obsidian-settings-unsafe`). Of Atelier's backups beside it, the first (the
  list as it was before Atelier wrote it) and the latest are kept. A write
  that cannot be read back is `registration-not-read-back`, no longer
  `app-started-during-registration`. A Flatpak or snap build of Obsidian on
  Linux, which never reads that file, is recognised (the build whose vault
  list was written last; its installation only when no build wrote one), and
  the file is neither read nor written for it (`obsidian-sandboxed`); the
  vault is added through the running app. An addition the running app did not answer is looked up in
  its list, and is `addition-not-answered` when it is not there, no longer
  `app-did-not-list-its-vaults`. Adding a vault through the app also puts its
  folder in the operating system's recent documents (Recent Items on macOS),
  as Obsidian's own "open folder as vault" does.
- A maintenance service still running an earlier release after an upgrade
  is replaced by `open`. Every service records the release it runs, the
  package version and a digest of every runtime module it ships (`src/`,
  `contracts/`), in its record's `executable.ext.release`
  (`releaseIdentity()`). A service of the workspace that proves itself ours
  but runs an earlier version than the installed one, the same version with
  another entry module or other modules, records no release, or refuses a
  tick that names a view (as 0.2.0-alpha.11 and earlier do), is stopped
  through its own listener and the installed release is started under the
  consent already recorded; `open` shows `service: restarted (outdated)`
  (`service.restarted` in JSON). A service of a later version (versions
  ordered as semantic versions, 0.2.0-alpha.11 < 0.2.0-alpha.12 < 0.2.0), or
  of one that cannot be ordered, is never replaced by an earlier release, so
  two installations used on one workspace do not replace each other's service
  on every open: `open` answers `service-unavailable` /
  `service-other-release`, whose next step is `atelier obsidian service stop`,
  then open again. The same version string on both sides is compared by
  content even when it cannot be ordered (a fork's `dev`), so that next step
  cannot loop. A tick refused because a concurrent command replaced the
  runtime just before is asked of the runtime that took its place, and
  nothing is restarted. A busy service is not stopped, and nothing that does
  not prove itself ours is touched. `requestServiceTick` takes the start
  options of the installed entry as `service` for this (`runtimeRelease`,
  `releaseStanding`).
- The `status` next step for `publisher-conflict` / `editor-uncoordinated`
  names `atelier obsidian open` (which adds the vault to Obsidian and
  publishes through it) or quitting Obsidian; after `open` itself tried, it
  names quitting Obsidian. `launch-failed` no longer asks for a vault folder
  to be opened by hand.
- The settings unit owns two more things in a vault: the `atelier-projection`
  entry of `community-plugins.json` (appended while the person wants the
  plugin there; every other entry kept in order; written only over the exact
  bytes the decision was made on, so a change the person makes meanwhile
  stops that unit as `settings-changed` and the view is tried again) and the
  plugin's four files, whose digests are pinned in the generation manifest
  under `ext["mnstry.atelier.obsidian"].settings`.
  Whatever occupies a plugin path is displaced to recovery, never lost; a
  plugin path a person has to repair (a link, a folder where a file goes, a
  file nobody may read, a folder nobody may write) never holds a view back; a
  generation whose plugin files the person repaired, changed or removed is
  published again as it is at the maintenance service's next tick; and
  another writer racing a plugin file makes the view try again.
  `isUserOwnedSettingsPath` answers `false` for these paths.
- Vault roots that Atelier places under its data root are created private
  (`0700`), and an existing one is made private before the plugin's key is
  written into it. A vault root Atelier did not place never receives the key
  unless it is already private, and a vault path under the data root that is
  a link to another folder never receives it, and its mode is never changed.
- A settings file nobody may read (`core-plugins.json`, say) is reported as
  `path-unsafe` and left for the person instead of failing the publication.
- `plugins/` is part of the egress scan, and the release audit requires the
  plugin's three files in the package.

### Fixed

- A publication no longer stops with an untyped `state leaf changed while
  opening` when another program replaces a note by rename at the instant the
  publisher opens it (an editor or sync tool saving the note). The note is
  read again, since every rename leaves a complete file; a note that keeps
  being replaced is reported as `disk-changed` for that note only, and the
  other notes are published. No bytes were ever lost: the publication threw
  before writing.
- `open` no longer makes Obsidian forget which of your vaults to reopen. A
  quit Obsidian started with an `obsidian://` link opens only that vault and
  drops the reopen flag of every other one; `open` now starts it plainly on
  macOS (it reopens every vault it had open, and the view's vault, which `open`
  added flagged to reopen) and hands it the vault's link through its command
  line once the app itself answers there, never through the operating system.
  On Linux a quit Obsidian is still started with the link (a known limit).
- `open` names the vault by its id (`obsidian://open?vault=<id>`) where the id
  reaches it first, instead of its path, which Obsidian matches against its
  vault list by string prefix.
- Obsidian with its command line turned off (the default of a new
  installation) answers every command with "Command line interface is not
  enabled"; that answer was read as an unreadable version. It is now
  `app-cli-unavailable` / `cli-turned-off`, whose next step names the setting
  (Settings > General > Advanced > Command line interface).
- A view whose prepared generation was already the committed one (on the
  first tick of a service, or prepared again on request) was marked `stale`
  when the app could not be qualified, for example while it ran with no vault
  open: the editor adapter was built before the publisher found nothing to
  publish. That adapter is now built only when the publisher needs one.
- After a refused publication, the tick `open` asked for did not try the view
  again (the engine attempted only views with changes), so `open` reported the
  old conflict until the five-minute reconciliation.
- `open` launched `obsidian://open?path=` for a vault the app did not know,
  and Obsidian showed "Vault not found. Unable to find a vault for the URL";
  `open` then answered `launch-failed` / `app-did-not-answer-for-this-vault`.
- The production check that the app answers for a vault parsed the app's
  answer twice and so never saw an answer; it now reads it once (twice only
  for a quoted string), compares real paths, and asks from inside the vault
  folder.
- An app whose vault window is still loading answers a command with `Error:
  Command "version" not found`; that was read as an unreadable version and
  ended `open` as `app-version-unsupported`. It is now read as not up yet.
- `atelier dev` on a port that was already taken (8137 by default) printed
  only `[internal-error] command failed without a safe diagnostic`, and the
  message that says what to do appeared only with `ATELIER_DEBUG=1`. It is now
  `port-in-use`, naming the port, with `--port=<free port>` as the next step.
  A port the operating system refuses (EACCES, usually one below 1024) is
  `port-permission-denied` with the same remedy, and a `--port` or `PORT`
  value that is not a port from 0 to 65535 is `port-invalid`, naming which
  one, instead of Node's `ERR_SOCKET_BAD_PORT`. Other failures without a
  typed code are still redacted.

## 0.2.0-alpha.11

### Fixed

- `status` now gives the same reason-specific next step as `open` for a
  publication that stopped because an Obsidian that may hold the vault could
  not be coordinated with (`publisher-conflict`, reason
  `editor-uncoordinated`). The text no longer names one cause, since the
  reason has several: another vault open, a command line that did not answer,
  an unknown process table (on Linux, any app on a system Electron), or an app
  started during an app-closed publication. The advice depends on whether the
  view was ever published. Before a first publication: quit Obsidian (on
  Linux, also any app that runs on a system Electron) so the view is
  published, then `atelier obsidian open` starts Obsidian on it. After one:
  the same, or open the view in the app as it is with `atelier obsidian open
  --allow-stale`. A concurrent publisher keeps its advice.
- The service's app qualification checks no version for an app that is not
  running, and that answer is remembered for up to ten seconds. An editor
  adapter built on it could coordinate with an Obsidian started inside that
  window, whose version nobody had checked, and publish through it in-app.
  The adapter now receives the qualification and does not coordinate, or ask
  the app anything, unless a version was checked. An answer that checked no
  version (the app was not running, or none was found) is no longer reused,
  so the next publication after the app starts reads its version and
  coordinates. A publication that stops this way is tried again on the next
  change or at the next full reconciliation, every five minutes.
- On macOS the app is found only at `/Applications/Obsidian.app`. An
  Obsidian installed elsewhere is `app-missing`: nothing is published through
  it, and publication waits while it runs. This is now documented.
- On Linux an app started through a differently named link or launcher was
  read as absent, because the process name is the name it was started
  through. A process whose name is not recognised is now identified by the
  executable `/proc/<pid>/exe` resolves to. A read failure other than a
  process that exited or whose executable this user may not read, or a table
  in which nothing resolves, is `unknown`.
- The `ps` call of the process probe had no timeout, so a hung `ps` blocked
  the service. It is killed after five seconds and the reading is `unknown`.
- Documented that from 0.2.0-alpha.10 the app-free publication path runs in
  production, with its re-probe window of up to two seconds plus one note
  while Obsidian is not running (see "Known limits" in `docs/obsidian.md`).

## 0.2.0-alpha.10

### Fixed

- A first publication refused because Obsidian runs without that vault open
  (`publisher-conflict`, reason `editor-uncoordinated`) now advises quitting
  Obsidian so the view publishes directly, instead of waiting for "the other
  publisher", which does not exist.
- The Obsidian process probe matched Atelier's own maintenance service: it
  searched every argument of every process for an `obsidian` path segment, so
  the service (`…/src/runtime/obsidian/service-main.mjs`) and anything naming
  the private data root read as a running app. With the app quit, the service
  reported `app-version-unsupported` and never published, and the app-free
  publication path was blocked. The probe now reads `ps -A -o comm=` and
  recognises the app by its executable: `Obsidian` and `Obsidian Helper…` on
  macOS, `obsidian` on Linux. On Linux a system Electron process makes the
  reading `unknown`, which is treated as a running app.
- An app running with no vault open answers every command-line call with
  `Vault not found.`, which was read as a version and reported as
  `version-unknown` or `version-unreadable`. It is now the reason
  `no-vault-open` under the existing outcome `app-version-unsupported`, still
  not qualified, and `status` and `open` say to open any vault in Obsidian or
  quit it. `open` waits for an app it launched that is still opening the vault.

## 0.2.0-alpha.9

### Fixed

- The maintenance service process could not start from the shipped package:
  its entry awaits the command contributions at top level, and the selection
  contribution shipped in 0.2.0-alpha.8 reaches the entry again through
  `opening.mjs` → `lifecycle.mjs`, so the process deadlocked on its own await
  and exited 13 before it listened. `SERVICE_ENTRY_PATH` now lives in its own
  module that nothing else depends on, and a test spawns the real entry.

## 0.2.0-alpha.8

### Added

- Add portable, typed advisory decision requests and results under
  `@mnstry/atelier/decisions`, with versioned schemas, invented fixtures and
  offline validation of evidence bindings, distributions and abstention.
  Provider execution, credentials, budgets and authorization stay with the
  host. See `docs/decisions.md`.
- Add an experimental, opt-in Obsidian projection. A project that enables
  `ext["mnstry.atelier.obsidian"]` and declares views (`full`, `scoped` or
  `focus`, with an optional bounded expansion) gets readable, linked notes of
  the enrolled workspace in a vault outside every repository, under private
  per-workspace storage. Nothing is published for a project that does not
  enable it. See `docs/obsidian.md`, `docs/obsidian-contract.md` and
  `docs/local-services.md`.
- Add eleven closed `atelier-obsidian-*.v1` schemas with valid and invalid
  fixtures, each exported under its own `./contracts/` path.
- Add deterministic materialization: note paths made of a readable title and a
  stable identity suffix, exact byte regions that invert to their source,
  embedded assets, and audience and eligibility rules that fail closed. No
  audience is admitted by default, which publishes an empty view.
- Add publication that coordinates with a running editor through conditional
  operations, with journals, restart recovery and late-writer rechecks, so
  that a concurrent write by a person or the app is retained rather than
  overwritten. It depends on an atomic file exchange and is proven on macOS
  arm64 with one app version; see the contract for what is open.
- Add a per-workspace loopback maintenance service and the noninteractive
  `atelier obsidian` command (`status`, `scope`, `audience`, `mode`, `policy`,
  `service`, `open`, `apply`, `proposals`, `conflicts`, `apply-policy`,
  `selection`). Reaching the installed app or the operating system is never a
  default: it needs `--adapter=obsidian-cli`. The app must be version 1.13.7
  or later.
- Ship the selection contribution on the command: the one-line loader module
  `src/runtime/obsidian/contributions/selection-ui.mjs` puts `selection`,
  `conflicts` and `apply-policy` on `atelier obsidian`, beside `apply` and
  `proposals`. The usage text names every contributed operation, and a
  contributed operation declares under `options` which shared options it
  takes, so `--actor` is refused everywhere but `apply run`.
- Preserve every edit made in the vault before anything is republished. A
  body replacement is applied to its source manually, or automatically under
  a scoped policy the user installs and can revoke; revocation is read again
  before every write. An edit that is not a body replacement becomes a
  copy-only proposal in the owning repository's proposal store and is never
  applied. Atelier makes no Git commit for any of it.
- Add selection binding, apply-policy setup, a read-only conflict view and an
  acceptance-receipt validator that is labelled schema validation only and
  closes no gate.
- Add the package subpaths `./obsidian`, `./obsidian/contracts`,
  `./obsidian/materialize`, `./obsidian/publication`, `./obsidian/recovery`,
  `./obsidian/edits`, `./obsidian/proposals` and `./obsidian/selection`. The
  package root exports nothing of the projection. Names ending
  `ForOracleTests` are test mutation controls, not a supported API.
- `release:audit` now requires the Obsidian runtime, schemas and documents in
  the tarball, requires every declared export to name a packed file, and
  refuses scripts, tests, experiments, receipt directories, application
  archives, receipts that name a real host or operator, and fixtures above 262,144
  bytes. The path allowlist is unchanged. A package proof packs the tarball,
  imports the subpaths from a bare consumer and publishes a synthetic
  workspace into a temporary vault with no app.
- Known limits: Windows refuses publication and source apply because no atomic
  exchange is known; the real-app suite has not been run on Linux, and x86_64
  has not been run anywhere; macOS publication needs the stock system perl;
  the app version has a floor and no ceiling; a vault body edit to a note
  whose source uses CRLF becomes a proposal rather than an apply. No adopter
  acceptance is recorded.

### Changed

- The resolver that produces `links_to` edges is now shared by the graph and
  the projection, and its behaviour changed in five classes. Graph artifacts a
  consumer has committed may differ after upgrading in exactly these classes
  and no others; each is pinned in `test/graph-knowledge-graph.test.mjs` and
  listed in `docs/obsidian-contract.md`. Regenerate committed graph artifacts
  after upgrading and review the difference.
  1. Links inside fenced code (backtick or tilde, any info string, up to three
     spaces of indent, CRLF, CommonMark fence-length rules), inside inline
     code and inside front matter no longer produce edges. Two stray backticks
     that happen to pair across a link count as inline code, and links after
     an unbalanced fence that runs to the end of the file are inside code.
  2. A link to a directory resolves to that directory's `README.md`, then
     `index.md`, testing eligibility per candidate. A link to a parent
     directory now resolves where the earlier reader missed it.
  3. A link that climbs above its own repository root and re-enters through
     the checkout's directory name is reported as leaving the enrolled roots,
     as before. It is never turned into a repository-local edge.
  4. Malformed percent-encoding in a link is a `link-href-malformed` finding.
     It no longer throws out of the graph build.
  5. The workspace graph, not repository artifacts, additionally carries
     wikilink edges and cross-repository Markdown-link edges, de-duplicated.

## 0.2.0-alpha.7

- Add a guided owner-agent upgrade skill and read-only `upgrade explain`
  reports derived from saved plans. Retain consent and provenance limits,
  distinguish staged installation from adoption, and route unsupported
  workspaces through their existing operator procedure.

- Add explicit saved-plan local upgrade transactions with private receipts,
  existing commit hooks and recovery inspection. Refuse unsupported Git
  attributes before generated writes and explain abandoned preparation state.
- `lock write` now preserves valid migration and template history and refuses
  a malformed previous lock. Inspect and repair or separately archive the
  invalid lock before retrying; history is no longer silently overwritten.

- Add a source-only Astro reference consumer for build-time presentation tokens,
  no-script reading/navigation, local-only form validation and cross-browser proof.
  Keep public-page mechanics consumer-owned; add no Astro runtime dependency.
- Patch the existing fast-uri dependency and override to 3.1.7. Clarify ordinary
  web-link navigation versus native host navigation requests.

- Validate proposed and retained adoption configurations together with their
  policy before writing; refuse an existing default policy during blank init.
  Compare manifests using their serialized JSON representation so omitted
  optional fields do not make freshly generated output stale.
- Migration: unset or correct globally exported `MNSTRY_ATELIER_ACTOR` values
  that are not declared in the current policy. Invalid explicit selectors now
  refuse even shared-only and legacy-warning checks.

- Correct shared-only attribution so ambient platform identities cannot invent
  an ownership requirement or trigger a network lookup. Preserve legacy-warning
  semantics for derived identities; Sync remains strict. Match platform logins
  only to declared logins, refuse prototype-name omissions and duplicate repos.
- Share manifest generation between project and upgrade, store a relative graph
  path, and compare parsed content independently of object-key order.
- Resolve preview commands through the scoped package from root or parent installs;
  qualify both layouts with installed health/page smoke tests. Existing preview
  configs require an explicit user update.
- Validate retained adoption policy/lock state before writing, refuse implicit
  drift acceptance, detect null-digest policy drift, and refuse init collisions
  so retries cannot overwrite authored files or reset the lock.

- Repair starter document classifications, shared adoption policy validity and
  initial adoption locks. Existing locks are retained so adoption cannot accept
  managed-file drift implicitly.
- Resolve template previews through the locally installed scoped package.
- Refuse unknown or ambiguous actor declarations, prioritize platform login over
  Git metadata, and never infer the current operator from commit history. Shared
  policy declarations do not require ownership of private repos outside the
  configured workspace. These checks remain attribution, not authentication.
- Check the generated projection manifest as well as its HTML for staleness.

- Add evidence-thresholded skill stewardship and exact-plan local projections;
  refuse unmanaged collisions, managed drift and cross-workspace confirmations.
- Add bounded immutable source copies and extraction attempt receipts, retaining
  originals and separating byte integrity from semantic acceptance.
- Add inert guide offers, revocable engagement and exact-payload consent contracts.
  No remote execution, commercial authority or proprietary implementation ships.
  See issues #33 and #34 and the skill stewardship and intake/guide documentation.

- Add experimental source-bound coauthor sessions, a private draft store, JSON
  stdin CLI and portable guided-coauthor skill. Preserve original answers,
  confirmation, durable receipts, bounded recovery and source-change refusal;
  no canonical source edits or publication authority are introduced.
- Add an external-project adapter starter with declared source boundaries,
  namespaced synthetic protocols, local-state exclusions and compatibility policy.
- Add evidence-bound local review runs, per-claim decisions, source-owner
  handoffs, passage responses and reading-position recovery. Current decisions
  refuse changed evidence and stale versions; local typed names remain asserted
  identities and no source edits are applied automatically.
- Report installed provenance as declared origin, observed bytes or verified
  checkout binding. Compare working bytes with commit objects, including Git
  index hints, sanitize remote metadata, and fail exact-source checks when the
  binding is unresolved. Piped provenance output is no longer truncated.
- Remove unsupported numeric claim confidence and explain legacy readiness
  scores as input completeness. Supply the required run import-safety field.
- Add pack lifecycle qualification and dry-run migration guidance plus explicit,
  disclosure-checked historical inspection bundles that never transfer approval.
- Extend the existing installed consumer gate across moved source layouts,
  durable contributions, stale refusal and inspection-only portability.

## 0.2.0-alpha.6

- Share project-location parsing with extension-pack commands, including
  repeated `--repo-path NAME=PATH` overrides and both argument forms. Malformed
  shared options now fail before local-state creation. Add path-free resolution
  diagnostics with `config check --explain`; read boundaries remain declared
  by the project.
- Add Deliverable Zero for Atelier Sync: explicit single-repository
  enrollment, a pinned direct-process Git adapter, executable repository
  completeness observations, fast-forward-only reconciliation, per-repository
  locking, hash-chained local operation traces, pause/resume control, and a
  two-phase user-confirmed commit-and-publish path. No desktop shell, watcher
  dependency, semantic conflict resolution, force operation, browser apply
  endpoint, telemetry, or hidden upload is introduced.
- Raise the Sync Git floor to 2.40 so default global and system attributes can
  be observed, bind publication to the single resolved push URL, refuse URL
  rewrite ambiguity, strip every inherited `GIT_*` process control, keep
  read-only commands mutation-free, and return non-zero exits for paused status
  and failed publication.

## 0.2.0-alpha.5

- Harden boundary enforcement so path globs use segment-aware matching, an
  explicitly empty or malformed content-rule policy is invalid, staged and
  pushed binary evidence is scanned within bounded budgets, incomplete Git
  reads fail closed, linked worktrees install hooks in the correct Git common
  directory, and `boundary audit` defaults to the current working tree with an
  explicit `--head` snapshot mode.
- Consolidate graph classification in one canonical engine. Markdown without a
  `kg` block is now represented as `unclassified` with a private audience and
  diagnostics; empty, partial, or malformed declarations remain blocking.
  Generated projection directories remain derived from the file-class manifest
  so graph validation and generated-only upgrade recovery cannot drift apart.
- Bind release egress verification to the exact `npm pack` inventory, including
  test-shaped paths that are actually published, and make the legacy egress
  checker a thin delegate to the canonical scanner. Packed fixture-suppression
  markers are refused and reviewed local-computed suppressions are counted.
- Harden `atelier dev` so it binds only to loopback, requires a generated
  `atelier.manifest.json`, serves only enrolled safe static files after
  realpath validation, and applies host, fetch-site, origin, method, and nonce
  checks to the relevant read and mutation routes.
- Make collaboration records fail closed with typed corrupt-record results,
  bounded ledger reads, POSIX no-follow and cross-platform state-leaf identity
  validation, content-bound event identifiers, write locking, explicit
  compaction, and one-pass proposal-list materialization. Compatibility
  snapshots are best-effort projections of committed events rather than a
  second authority. Proposal authority now follows declared capabilities and
  apply endpoints rather than action-like words, and the never-released
  provider-analysis experiment was removed before it became part of a
  published API.
- Render expected project and JSON failures as typed, actionable CLI messages
  without stacks by default; set `ATELIER_DEBUG=1` to include diagnostic stacks.
- Strengthen release proof with negative-control mutations and a bare consumer
  that installs without publisher overrides, validates its dependency tree,
  and imports every declared package export. A candidate is packed once, bound
  by SHA-256, and passed unchanged through tarball audit, consumer, and branded
  distribution gates. The trusted-publishing workflow publishes that same
  retained, audited tarball rather than repacking the source directory.
- Pin every JavaScript subpath and named export from `v0.2.0-alpha.4` in a
  registry-verified compatibility baseline with immutable tag-commit and
  public-artifact provenance. Release tooling refuses removals, provenance
  drift, and binding modified source to an already-tagged package version.
- Add a portable `atelier disclosure check` command that scans tracked or
  staged consumer content, requires private denylist coverage by default, and
  refuses tracked repository-local denylist files. Portable and repository
  sweeps now detect the full bounded family of private-key headers and refuse
  binary or invalid-UTF-8 evidence instead of omitting it. Fork sweeps require
  the trusted denylist secret and cannot fall back to the untrusted checkout.
  Repository release sweeps also inspect every bounded blob introduced by the
  commit range, so content added and deleted before the final tree cannot
  become public history unseen.
- Add public agent instructions and mirrored skills for extracting reusable
  mechanisms from private implementations without carrying tenant material
  into Atelier, plus a managed local-service contract for durable loopback
  authoring and review tools.
- Document the client-zero adapter rule that exact package identity, installed
  dependency resolution, CLI version, and `atelier.lock.json` must agree. This
  prevents a stale sibling checkout from satisfying a current adapter proof.
- Declare the audited `fast-uri` pin as a direct runtime dependency so packed
  offline consumer installs resolve the same dependency closure as the source
  checkout.

## 0.2.0-alpha.4

Presentation release. No contract changes and no runtime behaviour changes:
documents valid against `0.2.0-alpha.0` remain valid.

- **The README now explains the system before the package.** It begins with
  the repository as a durable substrate, then shows how ontology, enforcement,
  governed projections, and a local runtime make the same work usable by
  people, teams, agents, and tools.
- **The story progresses with the reader.** Stewards and collaborators get the
  purpose and working loop first; builders get the graph and library surfaces;
  technical readers retain the exact, test-gated claims, limitations, and
  conformance boundaries.
- **Methodology authoring is presented as the proving ground, not the
  category.** The package can support any file-based body of work whose
  structure, relationships, disclosure, and readiness must remain portable and
  enforceable.
- **Package and installation metadata match the new public presentation.** The
  prerelease remains explicitly pinned, and the coordinated MNSTRY developer
  documentation carries the same conceptual spine.
- **Bundled client instructions match the released CLI.** The Codex and Claude
  open-Atelier skills use `atelier dev` and point registry users to the scoped,
  collision-free install path.

## 0.2.0-alpha.3

Documentation and metadata release. No contract changes and no runtime
behaviour changes: documents valid against `0.2.0-alpha.0` remain valid.

- **The package's promises are now under a gate.** The checkable claims,
  the will-not-do list, the conformance/admission separation, and the
  audience/visibility rule live canonically in `docs/blocks/`, the README
  embeds them verbatim between markers, and a test fails when they drift.
  Promises converge by machinery; framing diverges by audience.
- **The README is restructured as a depth ramp** — category and trust
  posture first, the working loop with its visible result second, the
  checkable claims third, boundaries fourth, architecture fifth, reference
  last — and a new "Where the Atelier stops" section states the boundary
  with MNSTRY's managed platform as a literal table.
- **Overbroad claims are corrected.** "Trustworthy enough for whatever you
  govern with it" is gone from the README and `docs/design.md` — controls
  shaped for one demanding case do not establish adequacy everywhere; the
  agent-runtime passage now states the narrow, testable control rather
  than a general safety claim; "does not contact external services" now
  carries its documented `gh` exception inline; contract and test counts
  are stated by command, not by number; the contributions text now matches
  `CONTRIBUTING.md`'s outside-PRs-not-open-yet posture; and
  `docs/continuity.md` speaks of npm publication in the present tense.
- **`npx` examples use the collision-free `mnstry-atelier` form.** The
  unscoped npm name `atelier` belongs to an unrelated third-party package,
  so a bare `npx atelier` outside an installed workspace runs someone
  else's code. Every `npx` example on every surface now uses the branded
  binary, `atelier` remains the documented command inside installed
  workspaces, and `docs/install.md` no longer calls `mnstry-atelier` a
  legacy alias — it is the safe form.
- **npm metadata describes the package from the outside.** A concrete
  description, registry keywords, and a homepage that resolves to the
  published documentation page.

## 0.2.0-alpha.2

Documentation and release-lane release. No contract changes and no runtime
behaviour changes: documents valid against `0.2.0-alpha.0` remain valid.

- **The README is rebuilt around the system rather than its first
  application.** New `docs/design.md` states the design in five movements —
  a repository with an ontology, rules that refuse, collaboration as governed
  disclosure, a local runtime for humans and for agents, and a platform for
  your own tool — each ending with the command that proves it. Methodology
  authoring is stated as the first application, not the ceiling.
- **Publishing is automated on tag push** via npm trusted publishing (OIDC),
  so releases carry a provenance attestation and no registry token is stored
  anywhere. Two fail-closed guards: the tagged commit must be an ancestor of
  `main`, and the tag must equal `package.json`'s version.
- **The disclosure scanner no longer flags the OIDC permission key.**
  `id-token` is a GitHub Actions permission, not a credential; the exemption
  is the literal `id-` prefix only, and every other compound still matches.
- **`0.2.0` was published in error and unpublished the same day.** A
  `npm version patch` against an alpha resolves the prerelease to `0.2.0`
  rather than advancing it, and `git push --follow-tags` delivered the tag
  even though branch protection rejected the commit, so a release published
  from a commit that never landed on `main`. That number is permanently
  retired on npm. The ancestry guard above exists so this cannot recur.

## 0.2.0-alpha.1

First release published to the npm registry, under `@mnstry/atelier` with
public access. Prior versions were installable only from the repository.

- **Removed `docs/format-ontologies.md`.** It documented mnstry.org's
  editorial composition system rather than the Atelier, and named a private
  repository, an unpublished package with a version pin, and dated internal
  review decisions. Nothing referenced it. No private repository content was
  exposed by it.
- **A request can no longer end the local sidecar.** An unusable proposal id
  or an unreadable proposal file used to throw out of the request handler and
  exit the process; both are now answered with a response, and a busy port is
  reported instead of crashing. Regression tests cover both shapes.
- **Claims narrowed to what the gates enforce.** `boundary check` and `doctor`
  may call the `gh` CLI to resolve a GitHub login when no actor is configured;
  the egress gate scans `src/`, `bin/`, `scripts/` and `examples/` and does not
  model `child_process`; the compatibility differ does not resolve `$ref`
  pointers. All three are stated in the README rather than implied away.
- **Install path corrected.** The registry is now the channel of record.
  `v0.2.0-alpha.0` remains the contract epoch marker that
  `contracts/compat-baseline.json` pins to, and is not an install target.
- **Agent skills no longer suggest `npx atelier`**, which resolves to an
  unrelated third-party package on npm.
- **Removed the undocumented bare `mnstry` bin alias.** The package installs
  `atelier` (primary) and `mnstry-atelier` (legacy alias). It no longer claims
  the bare `mnstry` command name, which no documentation mentioned and nothing
  used, and which belongs to whatever MNSTRY ships under that name in the
  future rather than to this authoring kit.

This release also carries the open-source readiness work that landed between
the epoch tag and the public flip, previously listed as unreleased:

- `SECURITY.md` states the vulnerability reporting
  channel, what counts as a vulnerability against this package's claims
  (egress, boundary guard, disclosure scanners, audience/visibility,
  attestation, upgrade, contract compatibility), and what is deliberately out
  of scope — the loopback sidecar's on-host trust boundary is the design, not
  a finding. It ships in the tarball alongside `NOTICE` and `TRADEMARKS.md`,
  so a consumer who only has the package still has a reporting path.
- `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1) governs conduct;
  `CONTRIBUTING.md` continues to govern contributions, and boundary
  violations stay an operational matter handled there rather than a conduct
  dispute.
- The DCO sign-off that `CONTRIBUTING.md` requires is now enforced by a `dco`
  workflow instead of being documentation only. Merge commits are exempt —
  a contributor cannot sign a merge a maintainer made.
- Issue forms and a pull-request template carry the disclosure rules to the
  point of submission: no client material, no private methodology, no key
  material, no absolute home paths. The issue chooser routes vulnerabilities
  to private reporting and routes contract, dependency, guard, and network
  changes to the conversation-first proposal form. Blank issues are off.
- Dependabot watches npm and the SHA-pinned actions weekly. Its pull requests
  receive Dependabot-scoped secrets rather than Actions secrets, so the
  denylist must also be stored as a Dependabot secret or every Dependabot
  pull request blocks on `secret-sweep` exactly as a fork does.

## 0.2.0-alpha.0

- **Breaking:** the internal analysis-engine codename is fully removed from
  the contract surface. The adapter contract is `analysis-adapter@v1`
  (schema const `analysis-adapter-manifest@v1`, provider const `analysis`,
  output root `.mnstry/atelier/analysis`); the lock and migration schemas
  say `analysisExecution`; the readiness contract's section and the claim
  proposer enum value are `analysis`; the package export is
  `./analysis/adapter`; the CLI command is `analysis` (alias `analyze`).
  The `v0.2.0-alpha.0` baseline tag is re-cut at this commit — it was hours
  old, unpublished, and had no external consumer.
- **Security:** an independent external audit deleted both enforcement sites
  of the public-projectability boundary with every gate green — the invalid
  fixtures named for the property fail earlier, at resolution, so the branch
  had no witness. Resolved-private and resolved-sensitive fixtures now assert
  the registered `is not public-projectable` reason, and the export path uses
  the tested projection-policy verdict instead of a near-copy that could
  drift.
- **Security:** the served CSP authorized two Google Fonts origins nothing in
  the kit uses. Workspace HTML is author-controlled, so the dead permission
  was an exfiltration channel; it is removed and the security test refuses
  any external origin in the policy.
- The egress gate detects the shapes the same audit showed it missed —
  `https.get`, `http2.connect`, dynamic import of a URL, beacons, XHR/Image,
  third-party HTTP client imports, CSP directives naming external origins,
  and markup resource attributes — and its scan-path list names directories
  that exist (eight of eleven were `src/` subdirectories listed as top level,
  silently scanning nothing). Every previously-missed probe is pinned in a
  permanent test.
- `LICENSE` ships the full Apache-2.0 text instead of the 18-line short-form
  notice, so the section 6 that `TRADEMARKS.md` cites exists. CI actions are
  pinned to commit SHAs, the `fast-uri` advisory is closed with an override,
  and `portableText` scrubs Linux and Windows home paths, not only macOS.
- The `typecheck` script is renamed `syntax:check` — it runs `node --check`
  and never was a type system. The quickstart's boundary check step works on
  the sample workspace it creates, the fresh-clone denylist skip is
  documented, and the unread `#atelier-data` script block is gone.
- Every attacker-reachable label is sanitized, including the key path: a key
  file whose *name* carried an escape sequence could erase the key-identity
  line and rewrite it, and an over-long basename wrapped the header so the
  true provenance landed on a later visual line.
- The key-material patterns match material rather than prose. A document may
  discuss `privateKeyJwk` or show a redacted example and still be attachable
  to a feedback report; the scalar floor is the length of a real key, so a
  short identifier under a member named `d` no longer fires. A JSON
  attachment is scanned as the structure it decodes to as well as the text it
  is, so escaped member names cannot smuggle a key past the scan.
- **Security:** the widened private-key pattern repeated a repeated group,
  which is quadratic — 256 KiB of header-shaped text took about ten seconds
  to reject, reachable through `--message`, a capped `--context`, and the
  release audit. The repetition is bounded at four algorithm words, which
  still matches every real header, and a timing guard pins it.
- **Security:** JWK private key material had no coverage anywhere, though it
  is the only key format the kit writes. The private scalar and the
  `privateKeyJwk` wrapper are now banned values, the repo sweep looks for the
  scalar, and the release audit rejects any packed JSON that carries one —
  not only announcements documents.
- Attacker-controlled labels are sanitized before they reach a terminal. A
  keyId carrying an escape sequence could erase the `!! UNVERIFIED` warning
  above it and print a forged listing in its place; keyIds, algorithms, and
  announcement filenames are now capped and stripped of control characters.
- `announcements verify` and `show` name the key that vouched for a document,
  as `list` already did — `show` prints it before any attacker-authored
  content, and `verify --json` carries the key path, keyId, and whether the
  anchor was explicit.
- `atelier feedback` refuses a `--context` that is not a regular file (a FIFO
  or character device never returned from the read, so the size cap could not
  fire) and bounds `--message` the way file inputs were already bounded.
- The release audit decodes packed files strictly: a NUL-free binary used to
  scan as harmless text through a lossy decode while still carrying
  recoverable content.
- **Security:** the private-key disclosure pattern matched only the bare
  PKCS#8 header, so an ssh-keygen OPENSSH private key — and the RSA, EC, DSA,
  ENCRYPTED, and PGP block headers — passed the support-bundle scan, the
  repo-wide sweep, and the tarball audit untouched. It now matches any PEM
  private-key header. The banned-value email pattern also backtracked for
  about a minute on large non-email input and is bounded to the RFC 5321
  local-part and domain limits.
- `atelier feedback create` refuses `--context` and `--message-file` input
  over 262144 bytes or that is not valid UTF-8 rather than embedding it, and
  warns when the report lands where `.atelier-local/` is not git-ignored. The
  success message states that the scan is a backstop, not clearance to share.
- `atelier announcements list` takes its trust anchor from the committed
  MNSTRY key, never from the directory being listed: `--dir` relocates only
  where documents are read. Every run names the key and keyId it verified
  against. A tree carrying its own key can no longer present forged
  announcements as verified.
- A git-ignored `.kg.json` sidecar can no longer enroll a file in the census
  or describe one. Membership is a function of tracked state alone, so a
  clean checkout and a working tree build the same graph.
- The announcements documents and public key now ship in the package, so
  `announcements verify` works for consumers; the release audit asserts the
  key is present, rejects any announcements document carrying a private key
  member, and refuses to pack a binary file it cannot content-scan.
- The knowledge-graph census is now sidecar-first: a `.kg.json` sidecar
  attaches any sibling file — JSON, YAML, CSV, binaries — as a first-class
  node with its own audience, without atelier ever parsing the foreign
  format. Document extensions keep their existing semantics, and non-Markdown
  documents still fail closed without a sidecar.
- Adds `atelier feedback` — a local, never-sent feedback report on the
  support-bundle chassis: assembled under ignored `.atelier-local/feedback/`,
  scanned against the banned key and value patterns before writing, refused
  on any match. The kit has no send path; sharing is always the user's act.
- Adds the signed announcements channel: pull-only JSON documents under
  `announcements/`, signed with the published MNSTRY announcements key and
  verified by `atelier announcements list|verify|show`. The kit never
  fetches them; receiving an announcement is the `git pull` you chose to
  run. Generic detached document signing joins `@mnstry/atelier/attestation`.
- `TRADEMARKS.md` gains the quiet-software clause (no commercially motivated
  interruptions for anything carrying the MNSTRY marks, MNSTRY bound to the same
  standard) and the applications attribution rule for apps without a CLI.
  A `NOTICE` file ships in the tarball; Apache-2.0 section 4(d) makes its
  reproduction a license obligation in every derivative redistribution.
- **Breaking:** the `atelier-export@v1` runtime owner vocabulary is now
  vendor-neutral. The closed `runtimeOwnerName` enum, the `RUNTIME_OWNERS`
  constant, the bundled readiness protocols, and the fixtures all move to the
  domain terms `identity`, `catalog`, `commitments`, `events`, `projection`,
  `consent`, `messaging`, `providers`, `audit` (see `docs/ontology.md`).
  Documents and validators from earlier tags do not interoperate across this
  change; regenerate exports rather than hand-editing owner values.
- **Breaking:** `protocol.outputs` on bundled readiness protocols is now the
  contract's object shape (`{ runSchema, artifacts }`) instead of an informal
  array of artifact slugs, and the undeclared `outputArtifacts` key is gone.
  All twelve bundled protocols now validate against
  `atelier-readiness-protocol@v1`.
- **Breaking:** every document contract enters the contract-stability epoch:
  each schema declares an optional root `contractVersion` and a reserved
  optional `ext` extension container on every closed object, and bundled
  readiness protocols emit `contractVersion: "1.0.0"`. Validators pinned to
  earlier tags reject documents that carry the new fields. See
  `docs/contract-stability.md`.
- **Breaking:** the `atelier-claim@v1` provider enum gains
  `atelier-readiness`, so claims emitted by readiness runs validate against
  the standalone claim contract. Claim validators pinned to earlier tags
  reject the new provider.
- **Breaking:** the analysis adapter manifest schema const is now
  `analysis-adapter-manifest@v1` (was
  `mnstry.atelier-analysis-adapter-manifest@v1`), matching the published
  contract and fixtures. Local manifests emitted before this change must
  update their `schema` field.
- **Breaking:** boundary promote events are now recorded with schema
  `git-promote-event@v1` (was `mnstry.git-promote-event@v1`), matching the
  published contract. Previously recorded ledger lines carrying the old
  const are not rewritten.
- **Breaking:** the agent-harness context envelope schema const is now
  `atelier-context@v1` (was `mnstry.atelier-context@v1`), matching the local
  sidecar contract.
- **Breaking:** the alignment projection ships no default root-graph name
  list; the default is empty and workspaces supply their own via
  `sduiMap.rootGraphs` in project configuration. Nodes previously classified
  by the built-in name list no longer match without configuration.
- **Breaking:** every command that resolves a project now
  validates loaded config files fail-closed. Unknown keys that earlier
  releases silently ignored are rejected, `ext` must be an object whose
  members are namespaced objects, and the closed sub-objects (`roots`,
  `graph`, `projection`, `alignment`, `runtime`, `boundaries`, `setup`)
  reject additional properties. A config with a misspelled or stray key now
  fails at CLI entry with the offending key named, instead of running with
  that key quietly dropped.
- Adds `atelier-attestation@v1`, a contract for recording admission
  decisions: issuer, attested payload with an RFC 8785 (JCS) + SHA-256
  payload hash, an admission-scoped verdict (a conformance-scoped verdict is
  structurally unexpressible), and a required-but-nullable signature where
  null means advisory and non-authoritative. See `docs/attestation.md`.
- Adds the contract compatibility gate: `scripts/check-contract-compat.mjs`
  (`npm run contract:compat`) validates the current fixture and
  generated-document corpus against validators from the baseline tag recorded
  in `contracts/compat-baseline.json`. The gate is inert until the first
  post-epoch tag is recorded as the baseline.
- Adds `docs/ontology.md` — the public export vocabulary: the nine runtime
  owners, the object classes and collections they govern, the six runtime
  targets, and the audience/visibility boundary — and
  `docs/contract-stability.md` — the stability epoch, `contractVersion`,
  `ext` and must-ignore rules, the widening ban, the deprecation policy, and
  the compatibility gate.
- Expunges client-zero-identifying names from tests, fixtures, docs, and the
  release audit. Name-based scrub patterns now load from the gitignored
  `release-denylist.local.json`; when that file is absent the audit warns and
  applies structural checks only, and the readiness-pack neutrality test skips
  the name assertions.

- Staged boundary guard now separates boundary-field *initialization* from
  *change*. A field added with no prior value, set to a non-disclosing default,
  commits without a review marker; widening, narrowing, and removal still
  require one. This removes the deadlock where the kit's own front-matter
  tooling produced changes the kit's own gate refused.
- `semantic-field-change-needs-review` findings now name the file and the exact
  field transition instead of failing a whole repo with one opaque message.
- Review markers are now scoped to the file they appear in. A marker in a
  sibling file no longer approves an unrelated boundary change.
- Graph and sidecar walks now skip git-ignored paths via one batched
  `git ls-files --others --ignored --exclude-standard --directory` per repo
  root, so committed graph artifacts describe the repository rather than one
  machine's working tree. Multi-machine workspaces no longer churn.
- Adds `test/graph-determinism.test.mjs`, a mutation-tested regression guard
  that builds twice with git-ignored junk planted in between and fails on any
  byte change to a committed artifact.
- Adds the reserved repo kind `external` for git folders a workspace
  acknowledges but does not manage. External repos imply no read boundary, are
  excluded from graph walking, sidecar requirements, projection, the staged
  guard, and hook installation, and must not appear in repo-access or boundary
  policy. Undeclared git folders remain an error, and the message now names
  `external` as the resolution.
- `atelier graph` prints the remote host of each external repo so a workspace
  surfaces where its unmanaged folders push.
- **Breaking:** `fileClasses` is now required in the kit manifest. Every file
  the kit ships or generates is classified `source`, `generated-projection`, or
  `distributed-runtime-copy`, and a runtime copy must declare the repo role in
  which it is canonical. Adds `classifyPath(path, { repoRole })` so sync loops,
  merge policies, upgrade tooling, and CI guards read one declaration instead of
  each keeping a list that drifts.
- The graph walker's generated-file skip list and the boundary policy's glob
  matcher are now derived from shared modules rather than restated inline, with
  a drift test asserting the kit keeps no second copy of either.
- Repo entries accept `identity` (provider + stable id) and `aliases` (former
  names), so a repository survives a rename. Adds
  `resolveRepoIdentity(cloneDir)`, which resolves from the provider's stable id,
  then a recorded identity, then declared aliases — and never from a root commit
  or a folder name.
- `atelier doctor` now audits repo identity: upstream renames, stale config
  names, deprecated aliases, clones that are secretly the same repository, and
  repos with no recorded id or no origin remote.
- Adds boundary-policy `contentRules` and `contentRuleExceptions`. Rules judge
  added lines and added file paths rather than the whole tree, so a pre-existing
  accepted usage no longer blocks every push of everything in a repo. Exceptions
  are reviewable policy config — per repo, per path, per rule, each requiring a
  reason — instead of hardcoded pathspecs inside a fleet-wide guard script.
  Blanket wildcards are rejected.
- Adds `atelier boundary push-check`, which reads pre-push ref updates from
  stdin and judges only the pushed range (new branches diff against the empty
  tree), and `atelier boundary audit`, the whole-tree view that reports without
  blocking. The installed `pre-push` hook now uses `push-check`.
- The push guard fails closed when it cannot identify the repo it is running in,
  and matches its repo through symlinked paths and subdirectories.
- Adds extension packs. A project declares namespaced protocol packs under
  `ext["mnstry.atelier"].extensionPacks`, and the loader admits each one
  through a fixed fail-closed pipeline: entry shape, enablement, schema
  validation, identity, reserved-namespace rules, fixture and protocol path
  guards confined to the pack directory, the nine-point protocol safety
  posture, collision rules against the bundled pack, and lock pin-and-verify.
  Enablement is disable-only: the machine-local overlay can switch a declared
  pack off but can never switch an undeclared one on. Protocol resolution runs
  through an explicit registry — bundled protocols keep resolving by id, slug,
  or namespaced id, while pack protocols resolve by full namespaced id only,
  so a pack can never shadow or squat a bundled slug.
- Adds `atelier extension-pack validate` and `atelier extension-pack list`,
  which report per pack with version, resolved path, digest, protocol count,
  and lock status. Exit 0 means every enabled pack loaded clean, 1 that one
  failed, 2 a usage or project resolution error.
- Readiness composes pack protocols alongside the bundled twelve.
  `readiness protocols --project`, `readiness journey`, and `readiness run`
  resolve pack protocols through the project registry, and the tenant packet
  carries a generic per-pack contribution under `ext` built from run fields
  alone, where only `required`-gate pack protocols can block export and
  `advisory` ones report without blocking.
- `atelier lock write` and `lock check` now cover extension packs. The lock
  records each pack's version and content digest, `lock check` reports drift
  in both directions (declared but unlocked, locked but changed), and the new
  `sync-extension-packs` upgrade migration re-verifies and re-pins declared
  packs. Locking loads packs in throwing mode, so a broken pack cannot be
  recorded.
- Adds attestation signing: `atelier attestation hash|sign|verify|keygen`,
  with RFC 8785 (JCS) canonicalization, sha-256 payload hashes, and ed25519 or
  es256 keys. `keygen` writes the signing key file at mode 0600, refuses to
  overwrite an existing one, and prints only the public key document; the
  default signing key file is gitignored. Adds `TRADEMARKS.md`, the normative
  home of the required attribution string, the naming rules for distributions,
  the sanctioned compatibility claim, and the reservation of "certified" and
  "admitted" to holders of a verifying signed attestation. `TRADEMARKS.md`
  ships in the published tarball and the release audit fails without it.
- The workspace projection reads `ext["mnstry.atelier"].distribution` for
  branding: `name` and `eyebrow` feed the title and eyebrow line, and `theme`
  overrides five CSS custom properties. Theme values must be hex colors —
  they are interpolated into a style block, so a non-hex value fails the build
  rather than reaching the page. Default output is unchanged, and the
  "MNSTRY Tenant Readiness" heading stays as it is because it names the
  bundled pack.
- Adds the `distribution` workspace template
  (`atelier init --template distribution`), which scaffolds a workspace
  carrying the branding block and the attribution line. Fixes a bug where an
  unrecognized `--template` silently produced a blank scaffold: init now exits
  1, names the valid templates, and writes nothing. The blank scaffold is
  reached by omitting `--template`.
- Adds `atelier distribution check`, which verifies a distribution package's
  attribution markers mechanically: the root `README.md` must contain the
  exact byte string `powered by MNSTRY Atelier` (blocking), and each
  extension-pack manifest is reported for the advisory
  `ext["mnstry.atelier/attribution"]` key. Its messages point at
  `TRADEMARKS.md` and `docs/attestation.md` rather than restating policy.
- Adds the exported CLI entry `@mnstry/atelier/cli`. `runCli({ argv, brand })`
  returns an exit code instead of calling `process.exit`, so a distribution
  wrapper is a brand object and one line of dispatch. Attribution is derived,
  not configurable: `runCli` renders `powered by MNSTRY Atelier <version>` in
  `--version` and help output whenever the brand is not the default, and the
  brand object has no field that could omit or reword it. Default-brand output
  is byte-identical apart from the new commands listed in help.
- Adds `docs/distributions.md` — the three-tier model, the invariant that a
  distribution adds and rebrands but never alters root semantics, the three
  attribution surfaces, a build walkthrough, and the
  `ext["mnstry.atelier"].distribution` field reference — plus
  `examples/loomworks-studio/`, a complete reference distribution exercised by
  the new `distribution:smoke` publish gate.

## 0.1.0-alpha.2

- Adds bundled `mnstry-readiness-pack@v1` with twelve claim-first readiness
  protocols for MNSTRY tenant preparation.
- Adds readiness protocol and readiness run contracts with AJV fixtures.
- Adds `atelier readiness protocols`, `journey`, `run`, `packet`, and
  `export --dry-run` commands.
- Adds tenant-readiness journey data to generated local projections.
- Adds neutral Codex and Claude readiness skill wrappers.
- Keeps readiness output local, proposal-first, non-importing, non-mutating,
  no-send, and free of project-specific package content.

## 0.1.0-alpha.0

- Introduces the alpha `@mnstry/atelier` package.
- Adds the `mnstry atelier ...` and `mnstry-atelier ...` local CLI entrypoints.
- Adds `atelier-export@v1` schema validation.
- Adds dry-run validation for export artifacts.
- Adds fictional sample fixtures and fail-closed negative fixtures.
- Keeps runtime import, runtime mutation, telemetry, and external egress out of
  scope.
