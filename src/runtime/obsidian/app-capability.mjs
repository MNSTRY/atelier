import { refuse } from './errors.mjs'

// Whether the installed Obsidian may be published through and opened.
//
// Nothing here looks at this machine. What is installed is learned through an
// injected `appProbe`:
//
//   appProbe.inspect()                 -> { installed, cli, running, version, noVaultOpen? }
//   appProbe.vaultState({ vaultRoot }) -> { answered, indexReady }
//
// `installed` and `cli` are booleans, `running` is true, false or null (not
// known) and `version` is the app's own version text or null. `noVaultOpen`
// is true when the command-line tool answered that no vault is open. The
// production probe is a separate module that only the real command-line
// entries load; every test passes its own.
//
// A version can also come from Atelier's plugin: a plugin that holds a live
// lease runs inside the app and reports `apiVersion`, the version of exactly
// that app. It stands in only where the command-line tool gives no version:
// the tool reaches the app a publication coordinates with, which may be
// another app holding the same vault, so its own answer decides wherever it
// gives one. Such an observation carries `versionSource: 'plugin'` and
// qualifies with reason `plugin-reported`; whether the app is installed where
// Atelier looks, with its command-line tool, is still the probe's answer, and
// so is whether it runs: a lease outlives a crashed app by up to its lease
// time, so while the process table shows no app, a report stands for none.

// The publication protocol sets the view's undocumented `lastSavedData` field.
// 1.13.7 is the only app version that protocol was proven on, so it is the
// floor. Raising the ceiling needs the protocol cases re-run on that release.
export const MINIMUM_APP_VERSION = '1.13.7'

export const APP_OUTCOMES = Object.freeze(['qualified', 'app-missing', 'app-cli-unavailable', 'app-version-unsupported'])

const VERSION = /^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*))?(?:\+[0-9A-Za-z.-]+)?(?=$|[\s(])/

// { major, minor, patch, prerelease: string[] } or null. Only a version at the
// very start of the text counts; anything else is not a version.
export function parseAppVersion(text) {
  if (typeof text !== 'string' || text.length > 200) return null
  const match = VERSION.exec(text.trim())
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] === undefined ? [] : match[4].split('.') }
}

function comparePrerelease(left, right) {
  // No prerelease ranks above any prerelease of the same version.
  if (left.length === 0 || right.length === 0) return left.length === right.length ? 0 : left.length === 0 ? 1 : -1
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] === undefined) return -1
    if (right[index] === undefined) return 1
    const [a, b] = [left[index], right[index]]
    const [aNumeric, bNumeric] = [/^\d+$/.test(a), /^\d+$/.test(b)]
    if (aNumeric && bNumeric) { if (Number(a) !== Number(b)) return Number(a) < Number(b) ? -1 : 1 } else if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    else if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

// Pure. -1, 0 or 1; null when either side is not a version.
export function compareAppVersions(left, right) {
  const [a, b] = [parseAppVersion(left), parseAppVersion(right)]
  if (a === null || b === null) return null
  for (const part of ['major', 'minor', 'patch']) if (a[part] !== b[part]) return a[part] < b[part] ? -1 : 1
  return comparePrerelease(a.prerelease, b.prerelease)
}

// Pure. A version that cannot be read does not meet the floor.
export function meetsMinimumAppVersion(version, floor = MINIMUM_APP_VERSION) {
  const order = compareAppVersions(version, floor)
  return order !== null && order >= 0
}

// While the app runs with no vault open, its command-line tool answers every
// command, `version` too, with this line (observed on 1.13.7, on either output
// stream and with either exit status). It is not a version.
const NO_VAULT_OPEN = /^vault not found\.?$/i
// While a vault window is still loading, right after the app started or opened
// a vault, the tool answers a command with this line instead (observed on
// 1.13.7). The app is not up yet: this is not a version either.
const COMMAND_NOT_READY = /^error: command "[^"]*" not found\b/i
// With its command line turned off (the default of a new installation: Settings > General > Advanced), the app
// answers every command but a URL with this line (1.13.7). It runs and is reachable only by URL: not a version.
const CLI_TURNED_OFF = /^command line interface is not enabled\b/i

// Pure. What one `version` call of the command-line tool answered:
// { version, noVaultOpen }. `exited` is false for a call that failed or exited
// non-zero; its output is then read for the no-vault answer, never for a version.
export function readVersionAnswer({ stdout = '', stderr = '', exited = true } = {}) {
  const lines = [stdout, stderr].flatMap((text) => (typeof text === 'string' ? text.split('\n') : [])).map((line) => line.trim())
  if (lines.some((line) => NO_VAULT_OPEN.test(line))) return { version: null, noVaultOpen: true }
  if (lines.some((line) => CLI_TURNED_OFF.test(line))) return { version: null, noVaultOpen: false, cliOff: true }
  if (lines.some((line) => COMMAND_NOT_READY.test(line))) return { version: null, noVaultOpen: false }
  const text = typeof stdout === 'string' ? stdout.trim() : ''
  return { version: exited && text !== '' ? text : null, noVaultOpen: false }
}

// Pure. Whether a reply of the command-line tool came from the app itself: a
// version, or one of the lines the app answers with (no vault open, a command
// not ready yet, the command line turned off). The tool's own message while it
// cannot reach the app ("The CLI is unable to find Obsidian …") is not one, and
// nor is silence: the app is not up.
export function appAnswered({ stdout = '', stderr = '', exited = true } = {}) {
  const lines = [stdout, stderr].flatMap((text) => (typeof text === 'string' ? text.split('\n') : [])).map((line) => line.trim())
  if (lines.some((line) => NO_VAULT_OPEN.test(line) || CLI_TURNED_OFF.test(line) || COMMAND_NOT_READY.test(line))) return true
  const text = typeof stdout === 'string' ? stdout.trim() : ''
  return exited && parseAppVersion(text) !== null
}

// Pure. What one `eval` call of the command-line tool answered:
// { answered: true, value } with the value the script returned, parsed as
// JSON, or { answered: false, reason }. The tool prints a returned string as
// it is after `=> `; a string that is itself JSON text is parsed once more.
// `reason` is `no-vault-open` for the answer the app gives with no vault open,
// `cli-failed` for a call that failed, and `no-value` otherwise.
export function readEvalAnswer({ stdout = '', stderr = '', failed = false } = {}) {
  const lines = [stdout, stderr].flatMap((text) => (typeof text === 'string' ? text.split('\n') : [])).map((line) => line.trim())
  if (lines.some((line) => NO_VAULT_OPEN.test(line))) return { answered: false, reason: 'no-vault-open' }
  if (lines.some((line) => CLI_TURNED_OFF.test(line))) return { answered: false, reason: 'cli-turned-off' }
  if (failed) return { answered: false, reason: 'cli-failed' }
  const text = typeof stdout === 'string' ? stdout : ''
  const start = text.indexOf('=> ')
  if (start < 0) return { answered: false, reason: 'no-value' }
  try {
    let value = JSON.parse(text.slice(start + 3))
    if (typeof value === 'string') { try { value = JSON.parse(value) } catch { /* a plain string */ } }
    return { answered: true, value }
  } catch {
    return { answered: false, reason: 'no-value' }
  }
}

// Pure. `requireVersion: false` lets an installed app that is positively not
// running pass without a version: nothing is published through an app that
// does not run, and the version is asked for again once it does. An app whose
// command-line tool says no vault is open runs, whatever the process table
// said, and answers nothing else: `no-vault-open`, which does not qualify.
export function qualifyApp(observation, { requireVersion = true, floor = MINIMUM_APP_VERSION } = {}) {
  const seen = observation !== null && typeof observation === 'object' ? observation : {}
  const base = { floor, version: typeof seen.version === 'string' ? seen.version.slice(0, 80) : null, running: seen.running === true ? true : seen.running === false ? false : null }
  if (seen.versionSource === 'plugin') {
    // The plugin runs inside the app it reports: that app runs and has a vault open.
    const reported = { ...base, running: true, versionSource: 'plugin' }
    if (seen.installed !== true) return { ...reported, outcome: 'app-missing', reason: 'no-app-found' }
    if (seen.cli !== true) return { ...reported, outcome: 'app-cli-unavailable', reason: 'cli-capability-absent' }
    if (reported.version === null) return { ...reported, outcome: 'app-version-unsupported', reason: 'version-unknown' }
    if (parseAppVersion(reported.version) === null) return { ...reported, outcome: 'app-version-unsupported', reason: 'version-unreadable' }
    if (!meetsMinimumAppVersion(reported.version, floor)) return { ...reported, outcome: 'app-version-unsupported', reason: 'below-minimum-version' }
    return { ...reported, outcome: 'qualified', reason: 'plugin-reported', versionChecked: true }
  }
  if (seen.installed !== true) return { ...base, outcome: 'app-missing', reason: 'no-app-found' }
  if (seen.cliOff === true) return { ...base, running: true, outcome: 'app-cli-unavailable', reason: 'cli-turned-off' }
  if (seen.cli !== true) return { ...base, outcome: 'app-cli-unavailable', reason: 'cli-capability-absent' }
  if (seen.noVaultOpen === true) return { ...base, outcome: 'app-version-unsupported', reason: 'no-vault-open' }
  if (base.version === null) {
    if (!requireVersion && base.running === false) return { ...base, outcome: 'qualified', reason: 'app-not-running-version-not-needed', versionChecked: false }
    return { ...base, outcome: 'app-version-unsupported', reason: 'version-unknown' }
  }
  if (parseAppVersion(base.version) === null) return { ...base, outcome: 'app-version-unsupported', reason: 'version-unreadable' }
  if (!meetsMinimumAppVersion(base.version, floor)) return { ...base, outcome: 'app-version-unsupported', reason: 'below-minimum-version' }
  return { ...base, outcome: 'qualified', reason: 'meets-minimum-version', versionChecked: true }
}

export async function inspectApp(appProbe) {
  if (typeof appProbe?.inspect !== 'function') throw new TypeError('an appProbe with inspect() is required')
  try { return await appProbe.inspect() } catch { return { installed: false, cli: false, running: null, version: null } }
}

// The adapter factory of a service that reaches a real app. The editor adapter
// is constructed only after the app qualified; otherwise the factory refuses,
// typed, and the engine records that reason and publishes nothing. The answer
// is remembered briefly so a tick over many views asks once, unless it let an
// adapter through without a checked version. `createAdapter` receives the
// qualification with its input: an app that was not running qualified without
// a version, and an adapter built on that answer must not coordinate with an
// app started since (see createEditorAdapter).
//
// The app is asked only when an adapter is wanted, that is when a view is
// about to be published. An appProbe with `inspect()` is asked without
// blocking, and the factory and `qualification()` then answer promises; one
// with only `inspectSync()` is asked synchronously.
//
// When the service passes `pluginReport` (one launch of the plugin holds a
// live lease on the view), the probe is asked as without one, through the same
// remembered answer, and that answer decides wherever the tool gave a version,
// found no app or no tool, or the process table showed no app running. Only
// where the tool gave no version while an app may run does the plugin's
// version stand in; such an answer is never reused for another view or a later
// call. The adapter still coordinates through its own channel, which must
// answer for the vault before anything is published.
export function createQualifiedAdapterFactory({ appProbe, createAdapter, floor = MINIMUM_APP_VERSION, maxAgeMs = 10_000, now = () => Date.now() } = {}) {
  const waits = typeof appProbe?.inspect === 'function'
  if (!waits && typeof appProbe?.inspectSync !== 'function') throw new TypeError('the qualified adapter factory needs an appProbe with inspect() or inspectSync()')
  if (typeof createAdapter !== 'function') throw new TypeError('the qualified adapter factory needs createAdapter')
  let last = null
  // An answer that lets an adapter through without a checked version (no app
  // was running, or none was found) is never reused: an app started since is
  // asked for its version by the next call, not refused on the old answer. An
  // answer that checked a version, or that refuses, is reused for `maxAgeMs`.
  const reusable = (result) => result.versionChecked === true || (result.outcome !== 'qualified' && result.outcome !== 'app-missing')
  const current = () => last !== null && reusable(last.result) && now() - last.at <= maxAgeMs
  const learn = (observation) => { last = { at: now(), result: qualifyApp(observation, { requireVersion: false, floor }) }; return last.result }
  const qualification = waits
    ? async () => { if (current()) return last.result; let observation; try { observation = await appProbe.inspect() } catch { observation = null } return learn(observation) }
    : () => { if (current()) return last.result; let observation; try { observation = appProbe.inspectSync() } catch { observation = null } return learn(observation) }
  const withPlugin = (probed, report) => {
    if (report === null) return probed
    // No app in the process table: a live lease is the echo of an app that is gone (it lapses within the lease time) or
    // of a process holding the key, and vouches for no version. The probe's own answer stands, so an adapter built on it
    // never coordinates with an app started since, whose version nobody checked.
    if (probed.version !== null || probed.running === false || probed.outcome === 'app-missing' || probed.outcome === 'app-cli-unavailable') return probed
    return qualifyApp({ installed: true, cli: true, version: typeof report?.appVersion === 'string' ? report.appVersion : null, versionSource: 'plugin' }, { requireVersion: true, floor })
  }
  let shown = null
  const build = (input, probed) => {
    const result = withPlugin(probed, input?.pluginReport ?? null)
    shown = result
    // No app at all is not an unqualified app: the publisher's own path needs none, and its adapter finds no process.
    if (result.outcome !== 'qualified' && result.outcome !== 'app-missing') refuse(result.outcome, 'the installed Obsidian does not qualify; nothing is published through it', { reason: result.reason, floor: result.floor, version: result.version })
    return createAdapter({ ...input, qualification: result })
  }
  const factory = waits ? async (input) => build(input, await qualification()) : (input) => build(input, qualification())
  factory.qualification = qualification
  // What was last learned, from the probe or from a plugin, without asking again: for a status answer.
  factory.lastQualification = () => shown ?? last?.result ?? null
  // Drops what was learned, so the next adapter asks the app again: a tick somebody asked for does not reuse an
  // answer from before the app changed.
  factory.forget = () => { last = null; shown = null }
  return factory
}
