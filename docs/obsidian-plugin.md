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
  `Atelier: needs a newer Obsidian`. Between `not set up` and
  `service unreachable` it moves only when two rounds in a row agree, so a
  listener that answers one way and then the other does not make it flip;
  every other change shows at once.
- The command "Atelier: show status", or a click on the status bar item, opens
  a window with the view, its state and the reason in words, the committed and
  the prepared generation, when freshness was last checked, the held, retained
  and pending edits, the service address and state, and the plugin and app
  versions.
- A notice appears when the view moves into a state that needs a person (held,
  stale, service unreachable, app too old) and when it is current again.
  `updating` is not announced: it is what every change looks like.
- While the vault is open the plugin tells the service so: it shakes hands
  once (see "The channel"), then renews a lease every two seconds, and
  releases it when the plugin unloads (the vault closes, the app quits, the
  plugin is turned off). A lease that is not renewed lapses after six seconds.
  The hello carries the plugin version, the app version (`apiVersion`, the
  version of the app the plugin runs in), an id of this launch of the plugin,
  and a proof of the real path of the vault the app has open.

## What it never does

- It writes no file. No note, no setting, and not its own `data.json`: it
  never calls `saveData` and never uses the vault's write operations.
- It runs no code it receives. The service answers with JSON documents of
  fixed shape and the plugin reads fields out of them.
- It reaches nothing but the maintenance service named in its `data.json`, on
  the literal address `127.0.0.1` or `::1`, through Node's `http` module, with
  no name to resolve. It sends no telemetry.
- It never sends its vault's key, and it sends nothing that names the vault or
  the view until whatever listens at that address has proven that it holds
  the key.
- It holds no state that matters: no manifest, no edit, no policy, no recovery
  bytes. Removing it loses nothing.

The test suite holds the plugin to this: it loads `main.js` the way the app
does into a stand-in app whose every write throws, records every module the
plugin requires (`obsidian`, `http`, `fs`, `crypto`) and every request it
makes with its exact body, and fails a copy of the plugin that points a
request at a host from its data file (see "Evidence" below).

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
to repair never holds a view back: a symlinked folder, a directory where a
file should be, or a file or folder nobody may read (`path-unsafe`), a vault
root that is not private enough for the bearer (`vault-not-private`), or a
file that cannot be made or replaced there, in a plugin folder the person can
read but not write, say (`create-failed`, `exchange-failed`), is reported and
left alone while every note converges. Once it is repaired,
or when a person changed or removed a plugin file, the file is written again
at the maintenance service's next tick, with nothing changed at the view's
sources: the service compares the plugin files each committed generation pins
with the disk, has a view whose files differ prepared again, and a generation
that is already committed is published again, as it is, with its notes kept.
A drift left for the person is asked about once, and again once it changes;
where the plugin is turned off in the vault, a pinned file that is gone is no
drift. Publishing a committed generation again needs the app when one runs;
if that app does not qualify, nothing is written, the view stays `current`
(a committed generation needs no app, so an app that cannot be qualified
never makes a current view stale), and the file is written at a later
attempt, on the retry schedule of an unsettled view, once the app
qualifies. (The settings files are held to the same rule for a file nobody
may read.) A plugin file that another program changes while a publication runs
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

- The first publication of a vault offers the entry. Once the app has it, a
  list without it is the person's decision: turning the plugin off in
  Settings, Community plugins, removes the entry, and uninstalling it there
  removes the entry and deletes the plugin's folder. The app has the entry
  when it was in place before an app next opened the vault (published while
  no app held the vault), or once the plugin has run there. An entry
  published while an app holds the vault is only `offered`: that app keeps
  the list it read when it opened the vault and may write it back without the
  entry, which is no decision of the person's, so the next publication offers
  the entry again.
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
  `atelier obsidian plugin on --scope ID` records a request instead and asks
  the running maintenance service for a tick that names the view: that tick
  prepares and publishes the view again, which adds the entry back and makes
  the plugin's files again (the way back after an uninstall), and the command
  says so when it returns (`takesEffect: "published"`). With
  `--adapter=obsidian-cli`, a service of an earlier release still running
  after an upgrade is replaced by the installed one first, under the consent
  already recorded, as `open` does; without it, such a service is only
  reported (`service-outdated`) with that next step. With no service
  running, the view's next publication does it: the one the next change at
  its sources causes, or the one when the service next starts.
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
`state/plugin/choices/<view>.json`, as `requested`, `offered`, `on` or `off`,
with the reason (`entry-confirmed` or `entry-seen-by-the-app` for `on`,
`entry-removed-by-person` for `off`), so an entry the app never had is never
taken for the person's decision. A record that cannot be read counts as
`off`: nothing is added back on a guess.

### The data file and the privacy of the vault

`data.json` names the address the service listens on and the key of this one
vault, its bearer:

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
workspace's private state. It is the key of the handshake below and never
crosses the wire. The data file is written with mode `0600`, and only into a
vault root that is private to this user (owned by this user, no group or other
permission bits). Atelier creates the vaults it places under its own data root
with mode `0700` and makes an existing one private before the first bearer
goes in. Any other vault root is only checked: when it is not private the data
file is not published (`vault-not-private`), the rest of the vault is, and the
plugin says `Atelier: not set up`. A vault path under the data root that is a
link to a folder somewhere else never receives the data file, private or not
(`vault-not-private`, reason `vault-root-is-a-link`), and its mode is never
changed; the view is published into it as ever.

Deleting `state/plugin/<view>.json` rotates the bearer. A session made with
the old one ends at its next request, and a handshake with it is refused; the
next publication of the view (its next change, or the next start of the
service) mints a new one and replaces the data file, which the plugin reads
again without a restart.

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
answers five plugin commands besides its own four operations. Every one is a
`POST` of a JSON object of at most 1 KiB with exactly the fields of its
command, and none carries a credential in a header: the plugin proves it holds
the vault's key without sending it, and the service proves it first
(protocol `atelier-obsidian-plugin-channel/v2`).

1. The plugin sends a fresh 32-byte nonce, the time it made it, and a hint at
   its key: an HMAC of both under the key. The hint names no vault, and two
   hints of one vault do not look alike. The service computes the hint for
   each vault's key it holds, in constant time for every one of them, and
   answers only for a key it holds, only within thirty seconds of the time the
   challenge names, and each nonce only once: its own nonce, a handshake id,
   and a proof, an HMAC under the key over the view, its own exact address,
   both nonces and the handshake id. At most four handshakes wait for their
   hello per view, so a view's challenges never hold up another view's. A
   challenge recorded by a program that took the port while the service was
   down is therefore worth one answer, and only for thirty seconds, and the
   answer leads nowhere without the key.
2. The plugin checks that proof, in constant time, against the address in
   its data file. A listener that cannot make it (a program that took the
   port while the service was down, or one relaying a service that listens
   elsewhere) is told nothing more: the plugin shows the service as
   unreachable (`listener-not-proven`) and tries again at its next round.
3. Only then does the plugin say hello: its own proof under the key, over the
   same values and everything the hello carries (plugin version, app version,
   the id of this launch, and a proof of the vault path under the session key,
   so the path itself is never sent). A handshake is used once, whatever the
   hello proves, and lapses after five seconds.
4. Both derive a key for this session from the same values. Every later
   command carries the session, a counter that only goes up, and a MAC under
   the session key over the command, the session and the counter; every
   answer the service gives is the exact text of its document with a MAC over
   it, the command and the request's counter. The plugin believes no answer
   that does not verify. Any answer to a command that is not sealed (an
   error, which nobody vouches for, a timeout, or an answer that does not
   verify) ends the session in the plugin, which shakes hands again: at once
   when a renewal is refused as an unknown session or as not authenticated,
   at its next round otherwise. A listener that cannot seal therefore
   receives one command of a session at most, besides its release. A session
   ends when its lease lapses, when it is released, after fifteen minutes (the
   plugin shakes hands again), or at its next request after its vault's key
   was rotated.

| Command | Fields | Answer |
| --- | --- | --- |
| `POST /plugin/challenge` | `protocol`, `keyHint`, `clientNonce`, `issuedAt` | `protocol`, `handshakeId`, `serverNonce`, `serverProof` |
| `POST /plugin/hello` | `handshakeId`, `pluginVersion`, `appVersion`, `instanceId`, `vaultProof`, `clientProof` | sealed: a session identity, the lease time and the renewal interval |
| `POST /plugin/lease` | `sessionId`, `counter`, `mac` | sealed: the renewed lease |
| `POST /plugin/release` | `sessionId`, `counter`, `mac` | sealed: whether the session was released |
| `POST /plugin/status` | `sessionId`, `counter`, `mac` | sealed: the view's state, reason, verification, committed and prepared generation, held notes (counted, not named), retained edits, open pending edits, and the service's own state |

Refusals, before anything else is looked at: `Host` other than the listener's
literal loopback authority, a cross-site `Origin` or `Sec-Fetch-Site`, a path
other than one of the nine exactly (a query included), or another method (the
listener's rules for every request). Then:

| Case | Status | Code |
| --- | --- | --- |
| a credential in the `Authorization` header, the service's runtime bearer included | 400 | `plugin-command-takes-no-bearer` |
| a body over 1 KiB | 413 | `payload-too-large` |
| a body that is not a JSON object | 400 | `payload-not-json-object` |
| a field too many or missing, or of the wrong shape (a challenge that names the view, say) | 400 | `request-malformed` |
| a challenge in another protocol | 409 | `protocol-unsupported` |
| a challenge whose hint matches no key the service holds | 401 | `plugin-key-unknown` |
| a challenge whose time is more than thirty seconds from the service's clock | 401 | `challenge-stale` |
| a challenge whose nonce the service has already answered for that view | 401 | `challenge-replayed` |
| four handshakes of that view already waiting for their hello | 429 | `too-many-handshakes` |
| a hello for a handshake that is unknown, used, lapsed, or was made at another address | 401 | `handshake-unknown` |
| a hello whose proof does not verify under the key | 401 | `plugin-not-authenticated` |
| a hello that proves a vault path other than this view's | 409 | `wrong-vault` |
| a ninth live session for one view | 429 | `too-many-sessions` |
| a command for a session the service does not know, or whose key was rotated | 409 | `session-unknown` |
| a command whose MAC does not verify | 401 | `request-not-authenticated` |
| a command with a counter already seen | 401 | `request-replayed` |

The service keeps handshakes and sessions in memory. A service that started
again knows neither; the plugin's next lease is refused with
`session-unknown`, and it shakes hands again.

What the person sees of a refused challenge: a 401 is a key the service does
not know (`Atelier: not set up`, reason "key not known to the service"; the
data file is older than a rotated key, say), unless the answer says the
challenge was `challenge-stale` or `challenge-replayed`. The key is not in
question then: the plugin shows the service as unreachable with that reason,
and its next round tries again with a fresh challenge. None of these answers
is authenticated, so they only ever decide what is shown.

## Security argument

- Reach. The listener binds a literal loopback address and refuses any `Host`
  but its own authority, so nothing off the machine and no name that resolves
  to loopback reaches it. A web page, including a note rendered in the app,
  sends an `Origin` or `Sec-Fetch-Site` that is refused, and it cannot compute
  a proof. The plugin's own requests come from Node's `http` module and carry
  neither header.
- Authenticity, both ways. The service answers a challenge only for a key it
  holds and proves it over its own exact address; the plugin proves the same
  key over the same values; every later request and answer is sealed with the
  session's key. Comparisons are constant time. A proof or a MAC cannot stand
  in for another (each has its own label), a challenge is answered once and
  only while fresh, a handshake is used once, and a counter is accepted once,
  so nothing recorded can be replayed for any use.
- Secrecy. The key lives in two owner-only places, the private state of the
  workspace and the vault's `data.json` (`0600`, in a vault root that is
  `0700`), and never crosses the wire. Another user of the machine cannot read
  it, and a program of any user that takes the service's port while it is
  down learns a nonce, a hint it cannot link to a vault, and of a session
  that ended with the service one sealed renewal or status request at most
  (and its release, when the plugin unloads meanwhile): no key, no view, no
  path, no session and no app version it can use (the squatter tests in
  "Evidence"). Any process that runs as this user can read the data file,
  including other community plugins in the same app: the key separates vaults
  and processes of one person, it does not authenticate a person. That is the
  same boundary the service's runtime bearer has. A vault copied or
  synchronized to another machine carries its key there, where it reaches
  nothing: the service answers on this machine's loopback address only.
- Blast radius. Whoever holds a vault's key can make that view look open, or
  closed, take its eight sessions for as long as it keeps renewing them, and
  claim an app version for it. A claimed version only admits the command-line
  path for that view: publication still needs the app to answer for the vault
  through its own channel, and the in-app step still refuses on an app that
  lacks the saved-content field it relies on (`unsupported-app`). Nothing a
  key holder sends writes a file, starts a publication or changes an edit, and
  the key reaches nothing of the service itself: not its status, tick or stop.
- Cost. A request without a key costs the service one look at the bearer
  directory (the bearers are kept in memory and read again only when that
  directory changed) and one HMAC per vault; at most four handshakes wait per
  view, and recorded challenges can keep them filled for at most about
  thirty seconds after a restart, since a challenge is answered only within
  thirty seconds of the time it names.
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

The plugin runs inside the app whose version it reports, so its version is
the app's. The command-line tool, though, reaches the app a publication
coordinates with, which may be another app holding the same vault, so its own
answer decides wherever it gives one:

- The service's adapter factory asks the probe as it would without a plugin,
  through the same remembered answer. Where the tool answers with a version,
  that version qualifies or refuses the app, whatever the plugin reports.
  Where it gives none (no vault open yet, as it says while a vault is still
  loading, or no answer in time), the version the plugin reports stands in,
  reason `plugin-reported`, while one launch of the plugin alone holds the
  view. Whether the app is installed where Atelier looks and has its
  command-line tool is the probe's answer either way. The adapter still
  coordinates through the command-line tool, which must answer for exactly
  this vault before anything is published.
- `open` does the same: the plugin's version stands in only where the tool
  gives none. It asks the service about the plugin at most once a second
  while it waits for the app. A version only the plugin reported is not the
  command line answering, so `open` then asks the command line nothing to
  find the vault: it reads the app's settings file, as with no vault open,
  and opens by path the vault the app lists. Where the settings file does
  not show it (a sandboxed build, say), `open` answers
  `app-cli-unavailable` / `vault-open-cli-silent`: the plugin shows the vault
  open, so the command line is what did not answer.
- Whether an app runs is the process table's answer, which says no only when
  it finds no Obsidian process at all. A lease outlives its app by up to the
  lease time (six seconds after a crash), and any process that holds the
  vault's key can hold one, so while the process table shows no app, a
  plugin's report counts for nothing, in the adapter factory and in `open`.
  The probe's own answer stands (`app-not-running-version-not-needed`): the
  publication goes to the files, and an adapter qualified on that answer
  never coordinates with an app found running later (`app-version-unchecked`),
  so an app started since, perhaps updated as it restarted, is asked for its
  own version at the next qualification.
- With two launches holding one view (two app profiles with the same vault
  open, both running the plugin), neither plugin's version decides.
- An app below the floor refuses as before (`app-version-unsupported`,
  `below-minimum-version`), whoever reported the version.

What remains: where the tool gives no version but still coordinates (its
`version` call timed out, say), and a second app holds the same vault without
the plugin, the plugin's version may belong to the other app. The in-app step
still refuses an app without the saved-content field it relies on, for a
note open in the editor.

`atelier obsidian status` and `open` report the plugin for each view:
`{ present, reason, appVersion, pluginVersion, sessions }`, and a line such as
`plugin present (Obsidian 1.13.7)`.

## Evidence

- `test/obsidian-plugin.test.mjs` runs the shipped `main.js` in a stand-in app
  against a real listener on an ephemeral loopback port: parity of the
  plugin's constants and of every proof and MAC with the channel contract (a
  plugin that computes any one of them otherwise gets nowhere); the status
  bar, the status window and the notices through every state; lease renewal,
  release and lapse; a service restart; a republished data file; a rotated
  key; missing or unusable channel data; the app floor; a program squatting
  the service's address, which learns no key, no view and no path and, with
  everything it received replayed against the restarted service, opens no
  session and sets no app version; an answer relayed from a service at
  another address; answers that are not sealed, and a listener that answers
  every command with an error, which gets one renewal of a session and
  nothing more of it; answers that alternate between the two failures, which
  do not make the status bar flip; an unload while a hello is
  under way; the plugin's own timer (a renewal every two seconds, rounds that
  never overlap, nothing after an unload); the refusal table above with
  mutation controls that must fail
  it; bearer minting, rotation and the bearer cache; publication of the
  plugin files, entries and data file, with a person's settings kept, the
  person's choice followed (an entry the app had and the person removed is
  not added back; one published while an app held the vault is only offered
  until the plugin runs there; `plugin on` publishing the view at once while
  the service runs),
  displaced bytes kept in recovery, the privacy rule of the vault root, a
  linked vault root, unreadable files, a drifted plugin file written again
  (at the service's next tick, with nothing changed at the sources, and a
  drift left for the person asked about once),
  and an upgrade; the service publishing the plugin and the plugin it
  published holding the view; qualification from a plugin report, with one
  launch or two; and `status` and `open` reporting it. A spawn guard refuses
  any child of the suite that could reach an Obsidian with the developer's
  own `HOME`.
- The same file has three real-app tests, skipped unless
  `ATELIER_OBSIDIAN_PLUGIN=1` is set on a desktop host with Obsidian
  installed. Each publishes a synthetic vault through the maintenance service
  and opens it in a disposable Obsidian instance (private `HOME`, private
  profile, mock keychain, a copy of the pinned app archive when
  `ATELIER_OBSIDIAN_ASAR` names one). The first checks that the trust prompt
  is shown, answers it the way a person does, by pressing "Trust author and
  enable plugins" in that window through the command-line tool's `eval`, and
  asserts that the service sees the lease with the app's version, that the
  status bar item says `Atelier: current`, that a publication made while the
  plugin holds the view qualifies the app from the command-line tool's own
  version (reason `meets-minimum-version`), that
  a rotated key reaches the running plugin, and that quitting the app ends the
  presence. The second declines the prompt and publishes through the
  command-line path as before. The third uninstalls the plugin in the app and
  follows it until `atelier obsidian plugin on` brings it back at once (the
  running service publishes the view on a tick that names it), offered while
  that app holds the vault and confirmed when the plugin runs after a
  restart. They never touch another app profile, and they end each disposable
  instance by its profile path.

  The disposable window takes focus when it opens, so input meant for another
  window can answer its prompt before the test looks. The first test then
  fails and says so; the third, whose subject comes after trust, accepts a
  vault trusted that way. The desktop procedures
  (`scripts/obsidian/desktop-receipts.mjs`) decline the prompt as the second
  test does. When the command-line tool loses the reply to that press, a
  prompt that is gone proves nothing by itself: the app's own restricted mode
  says how it was answered, and a procedure refuses to run with community
  plugins on (`community-plugins-on`), ending the instance it started.

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
   answers with `POST /plugin/result`, both sealed under the session's key
   like every command of phase 1, so the plugin never listens on a port and
   takes work only from a service that proved it holds the vault's key.
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
