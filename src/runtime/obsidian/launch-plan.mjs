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
// So a vault is named by its id where that id reaches it first (a vaultRoute
// of `how: 'id'`), and otherwise by its own path, which the app then matches
// exactly (a listed folder is the longest prefix of its own path); an app that is not running is
// started plainly and handed the URL only once it answers: a URL reaching a
// running app opens a window and changes no flag. On Linux a plain start is not
// qualified, and the URL starts the app, with the flag loss as a known limit.
//
// Steps:
//   { step: 'plain-start' }           start the app with no URL
//   { step: 'wait-for-app' }          wait, bounded, until the app itself answers its command-line tool
//   { step: 'url', uri }              hand the URL to the running app
//   { step: 'url-start', uri }        start the app with the URL (Linux only)
//
// { ok: true, steps } or { ok: false, reason }.

const VAULT_ID = /^[A-Za-z0-9_-]{1,64}$/

export function launchPlan({ platform = process.platform, appRunning, vaultId = null, vaultPath = null } = {}) {
  let uri
  if (typeof vaultId === 'string' && VAULT_ID.test(vaultId)) uri = `obsidian://open?vault=${encodeURIComponent(vaultId)}`
  else if (typeof vaultPath === 'string' && vaultPath.startsWith('/') && !vaultPath.includes('\u0000')) uri = `obsidian://open?path=${encodeURIComponent(vaultPath)}`
  else return { ok: false, reason: 'vault-id-unknown' }
  if (platform !== 'darwin' && platform !== 'linux') return { ok: false, reason: 'launcher-platform-unqualified' }
  if (appRunning === true) return { ok: true, steps: [{ step: 'url', uri }] }
  if (platform === 'darwin') return { ok: true, steps: [{ step: 'plain-start' }, { step: 'wait-for-app' }, { step: 'url', uri }] }
  return { ok: true, steps: [{ step: 'url-start', uri }] }
}

// Pure. Whether the command-line tool's reply to a URL says the app took it ("Processed URI …").
export const urlProcessed = (stdout) => typeof stdout === 'string' && /^processed uri\b/im.test(stdout)

// Carries out a launchPlan with injected actions, so the order and the
// fallbacks are the same for the production launcher and the test harness:
//
//   start()        -> Promise<boolean>  start the app with no URL
//   answered()     -> Promise<boolean>  one poll: the app itself answered (appAnswered); a tool that cannot find the
//                                       app yet is not an answer
//   handLink(uri)  -> Promise<boolean>  the app's tool took the URL (urlProcessed)
//   osOpen(uri)    -> Promise<boolean>  the operating system accepted the URL
//
// A URL is never handed to the operating system for an app this launch
// started: that would start or reach it while it starts, which is what drops
// the other vaults' reopen flags. The vault was added flagged open, so a plainly
// started app opens it anyway, and `open` waits for it.
export async function runLaunchPlan(plan, { start, answered, handLink, osOpen, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), waitMs = 30_000, pollMs = 500, now = () => Date.now() }) {
  if (!plan?.ok) return { launched: false, reason: plan?.reason ?? 'launcher-refused' }
  let started = false
  let reason = 'url-accepted'
  for (const { step, uri } of plan.steps) {
    if (step === 'plain-start') {
      if (!(await start())) return { launched: false, reason: 'os-open-failed' }
      started = true
    } else if (step === 'wait-for-app') {
      const deadline = now() + waitMs
      let up = false
      while (!up) {
        up = await answered()
        if (up) break
        if (now() >= deadline) return { launched: true, reason: 'app-started-not-answering' }
        await sleep(pollMs)
      }
    } else if (step === 'url') {
      if (await handLink(uri)) continue
      if (started) return { launched: true, reason: 'app-started-link-not-taken' }
      if (!(await osOpen(uri))) return { launched: false, reason: 'os-open-failed' }
      reason = 'os-open-accepted'
    } else if (step === 'url-start') {
      if (!(await osOpen(uri))) return { launched: false, reason: 'os-open-failed' }
      reason = 'os-open-accepted'
    }
  }
  return { launched: true, reason: started && reason === 'url-accepted' ? 'plain-start-then-url' : reason }
}
