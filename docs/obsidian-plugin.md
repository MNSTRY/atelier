# Atelier's Obsidian plugin

Atelier ships its own Obsidian plugin inside every vault it manages. Nobody
finds or installs it: the maintenance service puts it into the vault with the
notes, and Obsidian asks once per vault whether to trust the vault's plugins.
Until the person says yes, and whenever the plugin is absent, turned off or
running in an app that is too old, everything works as it did before through
the command-line path described in [obsidian.md](obsidian.md).

This is phase 1: the plugin is present, reports status and holds a channel to
the service. It decides nothing and writes nothing. Phase 2, planned at the
end of this document, moves the in-app part of publication into it.

The source is `plugins/obsidian/` in the package: `manifest.json`, `main.js`
and `styles.css`, plain JavaScript with no build step. The channel it speaks
is `src/projection/obsidian/plugin-bridge/channel.mjs`; the service's half is
`src/runtime/obsidian/plugin-channel.mjs`.

## What it does

- A status bar item says how current the view is: `Atelier: current`,
  `Atelier: updating`, `Atelier: held (N)` with the number of notes held for
  an edit you made, `Atelier: stale` or `Atelier: service unreachable`. Before
  the first answer it says `Atelier: connecting`; without channel data, or in
  a copy of the vault rather than the vault Atelier maintains, it says
  `Atelier: not set up`; in an app older than 1.13.7 it says
  `Atelier: needs a newer Obsidian`.
- The command "Atelier: show status", or a click on the status bar item, opens
  a window with the view, its state and the reason in words, the committed and
  the prepared generation, when freshness was last checked, the held, retained
  and pending edits, the service address and state, and the plugin and app
  versions.
- A notice appears when the view moves into a state that needs a person (held,
  stale, service unreachable, app too old) and when it is current again.
  `updating` is not announced: it is what every change looks like.
- While the vault is open the plugin tells the service so: it says hello once,
  then renews a lease every two seconds, and releases it when the plugin
  unloads (the vault closes, the app quits, the plugin is turned off). A lease
  that is not renewed lapses after six seconds. The hello carries the plugin
  version, the app version (`apiVersion`, the version of the app the plugin
  runs in) and the real path of the vault the app has open.

## What it never does

- It writes no file. No note, no setting, and not its own `data.json`: it
  never calls `saveData` and never uses the vault's write operations.
- It runs no code it receives. The service answers with JSON documents of
  fixed shape and the plugin reads fields out of them.
- It reaches nothing but the maintenance service named in its `data.json`, on
  the literal address `127.0.0.1` or `::1`, through Node's `http` module, with
  no name to resolve. It sends no telemetry.
- It holds no state that matters: no manifest, no edit, no policy, no recovery
  bytes. Removing it loses nothing.

The test suite holds the plugin to this: it loads `main.js` the way the app
does into a stand-in app whose every write throws, records every module the
plugin requires (`obsidian`, `http`, `fs`) and every request it makes, and
fails a copy of the plugin that points a request at a host from its data
file (see "Evidence" below).

## How it gets into a vault

The publisher's settings unit owns these paths of a vault, and nothing else
under `.obsidian/`:

| Path | Owned | How it is written |
| --- | --- | --- |
| `.obsidian/core-plugins.json` | the `publish` and `sync` keys, kept `false` | merged with the file on disk; every other key stays |
| `.obsidian/community-plugins.json` | the `atelier-projection` entry | appended to the list on disk when missing; every other entry stays, in its order |
| `.obsidian/plugins/atelier-projection/manifest.json`, `main.js`, `styles.css` | the whole file | the shipped bytes |
| `.obsidian/plugins/atelier-projection/data.json` | the whole file | this vault's channel: the service address, the view and the view's bearer |

The plugin files' digests are pinned in the generation manifest, under
`ext["mnstry.atelier.obsidian"].settings.pluginOwned`, beside the record of
the owned settings keys and entries. A prepared view that carries a plugin
file its manifest does not pin, or pins one it does not carry, is refused
before anything is written.

Plugin files go through the same conditional publication as notes, with two
differences. Each is compared with what the disk holds when the run begins
rather than with an earlier generation, so whatever occupies a plugin path (a
hand edit, an earlier release, something else entirely) is exchanged out into
recovery with a receipt and is never lost. And a plugin path that a person has
to repair never holds a view back: a symlinked folder or a directory where a
file should be (`path-unsafe`), or a vault root that is not private enough for
the bearer (`vault-not-private`), is reported and left alone while every note
converges, and the file is written by a later publication once it is
repaired. A plugin file that another program changes while a publication runs
is a race and is handled like one on a note: that publication does not
commit, the view is tried again, and the file is planned from the disk anew
(`plugin-file-changed`); nothing reads a plugin file as an edit of a note.
Upgrades replace the plugin files the same way. The plugin's version in
`manifest.json` changes whenever its code does, and the test suite holds the
two together: the app keeps running the `main.js` it loaded until it reloads
the plugin, so one version must name one code.

`community-plugins.json` is a list the person owns, with Atelier's entry in it
only while the person wants the plugin in that vault (next section). A file
that is not a list is the person's to repair; it is reported as
`settings-invalid` and left alone. Atelier never removes plugin files from a
vault.

### Turning it off, and on again

The person decides whether Atelier's plugin runs in a vault, and Atelier
follows. The decision is the one Obsidian itself records: the
`atelier-projection` entry of `community-plugins.json`.

- The first publication of a vault offers the entry. Once it is confirmed in
  place, a list without it is the person's decision: turning the plugin off
  in Settings, Community plugins, removes the entry, and uninstalling it there
  removes the entry and deletes the plugin's folder.
- From then on the vault's plugin is `off`. Atelier leaves
  `community-plugins.json` exactly as the person left it and never adds the
  entry back. It creates no plugin file that is not there, so a folder the
  person deleted stays deleted, and it keeps the files that are still there
  current, so turning the plugin back on gets the current code. The vault
  works through the command-line path, and `status`, `open` and
  `atelier obsidian plugin show` report the plugin as not present with reason
  `turned-off-in-this-vault` and the way back. They read the vault's list, so
  they say so as soon as the person has turned the plugin off; the decision
  is recorded when the view is next prepared (`plugin show` marks a choice
  not recorded yet as `pending`).
- There are two ways back. Turning "Atelier" on again in Obsidian's settings
  (possible while its folder is there) lists the entry again; the view's next
  publication records the plugin as on and owns the entry again.
  `atelier obsidian plugin on --scope ID` records a request instead; the view's
  next publication adds the entry back and makes the plugin's files again,
  which is the way back after an uninstall. The command publishes nothing by
  itself: the next publication is the one the next change at the view's
  sources causes, or the one when the maintenance service next starts.
  Obsidian reads `community-plugins.json` when it opens a vault, so a plugin
  brought back this way runs from the next time the vault is opened; one
  turned on in Obsidian's settings runs at once.
- The list is read before the view is prepared, and the entry is written only
  over exactly the bytes it was read as. A change the person makes in
  between, turning the plugin off while a publication runs for example, is
  never written over: that settings unit stops (`settings-changed`), the
  publication does not commit, and the view is tried again, when its
  preparation reads the list as the person left it.
- A list that is missing, or that is not a list, decides nothing. A missing
  list is written again with the entry, unless the vault's plugin is `off`.
  Restricted mode leaves the list alone, and needs nothing from Atelier: no
  community plugin runs.

The decision is kept owner-only in the workspace's private state, under
`state/plugin/choices/<view>.json`, as `requested`, `on` or `off`. A record
that cannot be read counts as `off`: nothing is added back on a guess.

### The data file and the privacy of the vault

`data.json` names the address the service listens on and the bearer of this
one vault:

```json
{
  "schema": "atelier-obsidian-plugin-data/v1",
  "channel": { "host": "127.0.0.1", "port": 43123 },
  "scopeId": "scope-example",
  "bearer": "<43 characters>"
}
```

The bearer is 32 random bytes, minted by the service the first time the view
is prepared and kept owner-only in `state/plugin/<view>.json` under the
workspace's private state. The data file is written with mode `0600`, and only
into a vault root that is private to this user (owned by this user, no group
or other permission bits). Atelier creates the vaults it places under its own
data root with mode `0700` and makes an existing one private before the first
bearer goes in. Any other vault root is only checked: when it is not private
the data file is not published (`vault-not-private`), the rest of the vault
is, and the plugin says `Atelier: not set up`.

Deleting `state/plugin/<view>.json` rotates the bearer. The old one is
refused at once; the next publication of the view (its next change, or the
next start of the service) mints a new one and replaces the data file, which
the plugin reads again without a restart.

## The trust prompt

A vault that carries community plugins asks, the first time an app profile
opens it:

> Do you trust the author of this vault?
>
> You're opening this vault for the first time, and it comes with some plugins.

with two buttons, "Browse vault in Restricted Mode" and "Trust author and
enable plugins". Obsidian keeps the answer for each vault in the app's own
storage for that app profile (not in the vault), so it is asked once per vault
and per profile.

- Trust: Obsidian enables the plugins the vault lists, Atelier's among them.
  The status bar item appears and the service sees the vault open.
- Restricted mode: no community plugin runs. Obsidian asks again the next time
  the vault is opened, until restricted mode is switched on for good in
  Settings, Community plugins. Nothing of Atelier depends on the answer:
  maintenance, `open` and `status` work through the command-line path, and
  `status` reports the plugin as not present.

Only the person answers this prompt. Atelier does not answer it, write the
app's storage, or change the app profile. The isolated real-app test answers
it in a disposable app profile only; see "Evidence".

## The channel

The service's loopback listener (see [local-services.md](local-services.md))
answers four plugin commands besides its own four operations. Every one is a
`POST` of a JSON object of at most 1 KiB with exactly the fields of its
command, and carries `Authorization: Bearer <the vault's bearer>`.

| Command | Fields | Answer |
| --- | --- | --- |
| `POST /plugin/hello` | `protocol`, `scopeId`, `pluginVersion`, `appVersion`, `vaultPath` | a session identity, the lease time and the renewal interval |
| `POST /plugin/lease` | `scopeId`, `sessionId` | the renewed lease |
| `POST /plugin/release` | `scopeId`, `sessionId` | whether a session was released |
| `POST /plugin/status` | `scopeId` | the view's state, reason, verification, committed and prepared generation, held notes (counted, not named), retained edits, open pending edits, and the service's own state |

Refusals, before anything else is looked at: `Host` other than the listener's
literal loopback authority, a cross-site `Origin` or `Sec-Fetch-Site`, a path
other than one of the eight exactly (a query included), or another method (the
listener's rules for every request). Then:

| Case | Status | Code |
| --- | --- | --- |
| no bearer, an unknown one, the service's runtime bearer | 401 | `plugin-bearer-required` |
| a body over 1 KiB | 413 | `payload-too-large` |
| a body that is not a JSON object | 400 | `payload-not-json-object` |
| a field too many or missing, or of the wrong shape | 400 | `request-malformed` |
| a hello in another protocol | 409 | `protocol-unsupported` |
| a bearer of one vault naming another view | 403 | `scope-not-this-vault` |
| a hello from a vault that is not this view's | 409 | `wrong-vault` |
| a lease or release for a session the service does not know | 409 | `session-unknown` (release answers `released: false`) |
| a ninth live session for one view | 429 | `too-many-sessions` |

The service keeps sessions in memory. A service that started again knows no
session; the plugin's next lease is refused with `session-unknown`, and it says
hello again.

## Security argument

- Reach. The listener binds a literal loopback address and refuses any `Host`
  but its own authority, so nothing off the machine and no name that resolves
  to loopback reaches it. A web page, including a note rendered in the app,
  sends an `Origin` or `Sec-Fetch-Site` that is refused. The plugin's own
  requests come from Node's `http` module and carry neither.
- Authority. A vault's bearer is compared in constant time with the bearer of
  every view the workspace has, before the request body is read, and grants
  exactly the four plugin commands for that one view: presence and read-only
  status. It does not reach status, tick or stop of the service, and the
  service's runtime bearer does not reach the plugin commands. No command
  takes a path to act on, a name or code; `vaultPath` is compared with the
  view's vault and never opened.
- Secrecy. The bearer lives in two owner-only places: the private state of the
  workspace and the vault's `data.json` (`0600`, in a vault root that is
  `0700`). Another user of the machine cannot read either. Any process that
  runs as this user can, including other community plugins in the same app:
  the bearer separates vaults and processes of one person, it does not
  authenticate a person. That is the same boundary the service's runtime
  bearer has. A vault copied or synchronized to another machine carries its
  bearer there, where it reaches nothing: the service answers on this
  machine's loopback address only.
- Blast radius. Whoever holds a bearer can make one view look open, or closed,
  take its eight sessions for as long as it keeps renewing them, and claim an
  app version for it. A claimed version only admits the
  command-line path for that view: publication still needs the app to answer
  for the vault through its own channel, and the in-app step still refuses on
  an app that lacks the saved-content field it relies on
  (`unsupported-app`). Nothing a bearer holder sends writes a file, starts a
  publication or changes an edit.
- Egress. `plugins/` is in the egress scan, which fails a request whose target
  is not a literal loopback address, and the release audit requires the three
  plugin files in the package and scans them in the tarball.

## When the plugin is not there

If the plugin is not loaded (the person chose restricted mode or has not
answered the prompt yet, the app is older than 1.13.7, or the person turned it
off in the vault), nothing changes: the service coordinates through the
command-line path exactly as before, `open` asks the command-line tool for the
app version, and `status` reports the plugin as not present with the reason
(`no-live-lease`, `turned-off-in-this-vault` or `service-not-running`).

## The app version a plugin reports

The plugin runs inside the app whose version it reports, so while it holds a
live lease on a view that version counts as checked:

- The service's adapter factory qualifies the app from the lease (reason
  `plugin-reported`) and does not run the command-line tool's `version`
  command. The adapter still coordinates through the command-line tool, which
  must answer for exactly this vault before anything is published.
- `open` takes the version from the lease as well, so an app whose
  command-line tool answers "Vault not found." or does not answer in time
  still qualifies. Whether the app is installed and has its command-line
  capability is still the probe's answer, because `open` and publication use
  that capability in this phase.
- An app below the floor refuses as before (`app-version-unsupported`,
  `below-minimum-version`), whoever reported the version.

`atelier obsidian status` and `open` report the plugin for each view:
`{ present, reason, appVersion, pluginVersion, sessions }`, and a line such as
`plugin present (Obsidian 1.13.7)`.

## Evidence

- `test/obsidian-plugin.test.mjs` runs the shipped `main.js` in a stand-in app
  against a real listener on an ephemeral loopback port: parity of the
  plugin's constants with the channel contract; the status bar, the status
  window and the notices through every state; lease renewal, release and
  lapse; a service restart; a republished data file; missing or unusable
  channel data; the app floor; the refusal table above with mutation controls
  that must fail it; bearer minting and rotation; publication of the plugin
  files, entries and data file, with a person's settings kept, displaced bytes
  kept in recovery, the privacy rule of the vault root and an upgrade; the
  service publishing the plugin and the plugin it published holding the view;
  qualification from a plugin report; and `status` and `open` reporting it.
- The same file has a real-app test, skipped unless
  `ATELIER_OBSIDIAN_PLUGIN=1` is set on a desktop host with Obsidian
  installed. It publishes a synthetic vault through the maintenance service,
  opens it in a disposable Obsidian instance (private `HOME`, private
  profile, mock keychain, a copy of the pinned app archive when
  `ATELIER_OBSIDIAN_ASAR` names one), checks that the trust prompt is shown,
  answers it the way a person does, by pressing "Trust author and enable
  plugins" in that window through the command-line tool's `eval`, and asserts
  that the service sees the lease with the app's version, that the status bar
  item says `Atelier: current`, that a publication made while the plugin holds
  the view qualifies the app with reason `plugin-reported`, and that quitting
  the app ends the presence. It never touches another app profile, and it
  ends the disposable instance by its profile path.

  Pressing the button in the prompt was chosen over the alternatives because
  it exercises the prompt a person sees and needs no knowledge of the app's
  storage. Writing the profile's local storage would mean editing a LevelDB
  database behind the app's back, and calling `app.plugins.setEnable(true)`
  would skip the prompt altogether.

## Phase 2 plan

Phase 2 moves the in-app critical section of publication into the plugin, and
closes gates G20 and G21 of the initiative. Nothing below is implemented.

1. Commands. The channel gains the publication protocol's three operations,
   `inspect`, `publish` (`replace` and `remove`) and `collect`, with the
   payloads the command-line path validates today (`validatePayload`), and a
   protocol variant, `obsidian-plugin-critical-section/v1`, recorded in every
   journal it writes. The service stays the only client that starts work; the
   plugin fetches work with a bounded long poll (`POST /plugin/work`) and
   answers with `POST /plugin/result`, so the plugin never listens on a port.
   At most one operation per vault is in flight, every operation has an
   identity, a lost answer is recovered with `collect`, and a publish is never
   sent twice.
2. The critical section. The plugin runs the same synchronous body the
   command-line path sends through `eval` (`criticalSection` in
   `bridge-script.mjs`), shipped in `main.js` rather than sent: refuse on a
   dirty or differing editor in any window, refuse on changed bytes on disk,
   exchange atomically, update open editors in one transaction of minimal
   hunks and record `lastSavedData`, record the outcome, reply at once. The
   late-writer re-check and the manifest commit stay in the publisher.
3. Path selection. With a live lease from a plugin whose protocol matches, the
   publisher uses the plugin channel; otherwise the command-line path, and
   with no app running, the app-free path, exactly as today. A refusal is
   never relaxed by switching paths.
4. Live edit preservation. The plugin forwards the vault's `modify` events and
   the editor's dirty state for Atelier's notes to the service as they happen,
   so an edit is preserved in recovery before any maintenance tick looks for
   it. The service still decides what an edit is.
5. G20. The complete G00 interleaving suite (sixteen interleavings, racing
   cases repeated) and the G04 production-publisher suite run in plugin mode
   on a real isolated app, unchanged, with zero lost bytes. A case that passes
   on the command-line path and fails in plugin mode fails the gate; the suite
   is not narrowed.
6. G21. Apply and Discard in the status window for held edits, forwarded to
   the service's existing apply operation, which decides; then the procedure
   AP-08: enable, disable, uninstall and an app below the floor on one vault
   with pending edits and recovery bytes, comparing manifests, path
   allocations, pending edits and recovery digests with the command-line path
   after each step.

Open questions for phase 2: when, if ever, plugin files are removed from a
vault; and how an upgraded service answers an older `main.js` that the app
keeps running until it reloads the plugin (the hello carries the plugin
version and the protocol for that).

### Deviations from the track plan

The obsidian-plugin track planned an optional enhanced mode. The owner's
decision of 2026-09-24 made the plugin the primary in-app half, shipped in
every managed vault, with the command-line path as the fallback. Phase 1 here
therefore builds the plugin, its delivery and a presence and status channel
before the publication commands the plan's first phase describes; the parity
held today is between the plugin's constants and the channel contract, and the
refusal parity with the command-line path belongs to phase 2, when the plugin
carries publication commands. Fixtures are generated in temporary directories
rather than kept under `fixtures/obsidian/plugin/`.
