# Obsidian publication feasibility prototype (G00)

Disposable prototype. Nothing here ships, nothing here is wired into the
package, and a passing run is evidence for one host and one app version only.

## Question

Can Atelier replace a generated note in an Obsidian vault while the vault is
open and being edited, without ever losing a byte the user or another program
wrote?

## What the app actually does

Observed on Obsidian 1.13.7 (installer 1.12.7), macOS, and confirmed in the
app bundle:

- When a note changes on disk while its editor holds an unsaved buffer, the app
  re-applies the user's diff onto the new content with fuzzy patching and
  ignores patches that fail. An overlapping edit is dropped with only a
  "file changed" notice. A publisher that just replaces files loses edits.
- `Vault.process` reads, transforms and then writes the file in place with no
  check in between, so an outside writer landing in that gap is overwritten.
- Asking the app to save an open note after replacing it has the same defect.
  This was observed as a real loss (20-round run, outside-writer race, round
  12) and is kept as negative control I06b.

## Candidate protocol: `obsidian-cli-critical-section/v1-prototype`

A fixed script, run through the official CLI's `eval`, performs one synchronous
critical section inside the app. Note text never becomes code: the only
variable input is a validated JSON payload, and bytes travel as files bound by
SHA-256.

1. Refuse if any editor of the note, in any window, is unsaved or differs from
   the expected base.
2. Refuse if the bytes on disk differ from the expected base.
3. Atomically exchange the staged candidate with the note. Whatever occupied
   the note path at that instant becomes the recovery file, so a concurrent
   replacement is captured instead of lost. A failed exchange changes nothing.
4. Update every open editor in one transaction of minimal line hunks and record
   the view as saved with that content, so the app neither takes its lossy
   merge path nor writes the file itself.
5. Reply at once. Guard-window evidence and the recorded outcome are read back
   with a separate call; a publish is never resent.

The publisher must re-check the recovery file after a quiet period: an outside
program that held the note open before the exchange writes into that file.

## Cases

`run-g00.mjs` drives an isolated instance (private `HOME`, private profile,
synthetic vault, mock keychain) with real text input through CDP.

| Case | Interleaving | Accepted outcome |
| --- | --- | --- |
| I00 | clean open note | published; editor shows the candidate |
| I01, I02 | edit saved before, or between, capture and update | refusal, nothing written |
| I03 | unsaved buffer, delayed save | refusal; the later save keeps the edit |
| I04 | real typing racing the critical section | typed text on disk and in the buffer |
| I05 | second window, clean and unsaved | both updated; unsaved refuses |
| I06 | outside atomic-rename writer racing publication | outside bytes on disk or in recovery |
| I06a, I06b | no app write after publication; negative control | regression for the observed loss |
| I07 | note removed | refusal, nothing created |
| I08, I09 | app killed after exchange, and after update | coherent note; base and candidate both retained |
| I10 | shutdown while publishing | coherent note, retryable |
| I11 | full disk (APFS image) | staging refused by digest; exchange all-or-nothing; typed text survives |
| I12 | outside writer holding the note open writes late | bytes in recovery, detected |
| I13 | outside in-place rewrite after publication | kept and shown |

## Limits a production publisher inherits

- **Atomic exchange is per platform.** Proven here only on macOS
  (`renamex_np` with `RENAME_SWAP`), reached through `/usr/bin/python3`, which
  costs about 50 ms inside the critical section and is not a shippable
  dependency. Linux `renameat2(RENAME_EXCHANGE)` and any Windows equivalent
  are unproven. Link-then-rename is not a substitute: it leaves a window in
  which a concurrent replacement is destroyed.
- **One undocumented app field.** Step 4 sets the view's `lastSavedData`. The
  documented alternative is the route that lost bytes. The bridge refuses open
  notes when the field is absent; a release needs a pinned app version floor
  and this runtime check.
- **CLI replies can be lost** while the app stays responsive. Outcomes are
  recorded in the app and re-read; callers must be serialised and idempotent.
- **Hidden windows throttle the app's timers**, delaying its own autosave. The
  test app disables that throttling because a window being typed into is
  focused; a production service must not read a delayed autosave as a fault.
- **One anomaly is unexplained.** An early run once ended with typed text on
  disk but absent from the editor buffer. It has not recurred since the
  harness stopped holding CLI calls open and began verifying its own setup,
  and it is recorded as unreproduced, not as resolved.
- Pop-out windows cannot receive CDP input, so their unsaved edit is injected
  through the editor API.

## Running

```sh
ATELIER_OBSIDIAN_ASAR=/path/to/obsidian-<version>.asar \
  node experiments/obsidian-publication/run-g00.mjs --races 25 --out /tmp/G00.json
ATELIER_OBSIDIAN_G00=1 node --test test/obsidian-publication-feasibility.test.mjs
```

The runner opens a desktop application window. It refuses to proceed unless
the CLI sees exactly one vault, the synthetic one it created.
