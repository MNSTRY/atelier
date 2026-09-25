// How `open` shows a vault in Obsidian, as steps a launcher carries out. Pure.
//
// Two facts of the app (1.13.7, read from its main process and checked on an
// isolated instance) decide the steps:
//
//   - An app started with an `obsidian://` URL opens only that URL's vault and
//     deletes the `open` flag of every other vault without a window, so the
//     person's other vaults do not come back the next time Obsidian starts.
//     Started plainly, it reopens every vault its list marks open (the view's
//     vault included, when it was added to the list marked open) and keeps
//     the flags.
//   - `open?path=` picks the listed vault whose folder is the longest string
//     prefix of the path, with no separator check; `open?vault=<id>` names one
//     vault exactly.
//
// So a vault is always named by its id, and an app that is not running is
// started plainly and handed the URL only once it answers: a URL reaching a
// running app opens a window and changes no flag. On Linux a plain start is not
// qualified, and the URL starts the app, with the flag loss as a known limit.
//
// Steps:
//   { step: 'plain-start' }           start the app with no URL
//   { step: 'wait-for-app' }          wait, bounded, until its command-line tool answers anything
//   { step: 'url', uri }              hand the URL to the running app
//   { step: 'url-start', uri }        start the app with the URL (Linux only)
//
// { ok: true, steps } or { ok: false, reason }.

const VAULT_ID = /^[A-Za-z0-9_-]{1,64}$/

export function launchPlan({ platform = process.platform, appRunning, vaultId } = {}) {
  if (typeof vaultId !== 'string' || !VAULT_ID.test(vaultId)) return { ok: false, reason: 'vault-id-unknown' }
  const uri = `obsidian://open?vault=${encodeURIComponent(vaultId)}`
  if (platform !== 'darwin' && platform !== 'linux') return { ok: false, reason: 'launcher-platform-unqualified' }
  if (appRunning === true) return { ok: true, steps: [{ step: 'url', uri }] }
  if (platform === 'darwin') return { ok: true, steps: [{ step: 'plain-start' }, { step: 'wait-for-app' }, { step: 'url', uri }] }
  return { ok: true, steps: [{ step: 'url-start', uri }] }
}

// Pure. Whether the command-line tool's reply to a URL says the app took it ("Processed URI …").
export const urlProcessed = (stdout) => typeof stdout === 'string' && /^processed uri\b/im.test(stdout)
