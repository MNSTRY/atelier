import { createRequire } from 'node:module'
import { PLUGIN_OWNED_PATHS, POLICY_SETTINGS_PATHS } from '../materialize/settings.mjs'
import { EXCHANGE_CONSTANTS } from './exchange.mjs'

// The fixed script that performs one conditional publication. It runs in two
// places with the same body: inside the Obsidian renderer, sent through the
// official CLI's `eval`, and in this process when no Obsidian is running.
//
// The body is a constant. The only variable input is a closed, validated JSON
// payload that travels base64-encoded, so note text and paths never become
// code. Candidate and recovery bytes travel as files bound by SHA-256.

export const PROTOCOL_ID = 'obsidian-cli-critical-section/v1'
export const POLICY_SETTINGS_PATH = '.obsidian/core-plugins.json'

const OPS = new Set(['inspect', 'publish', 'collect'])
const MODES = new Set(['replace', 'remove'])
const SHA = /^[0-9a-f]{64}$/
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const KEYS = {
  inspect: ['op', 'vaultRoot', 'path'],
  collect: ['op', 'vaultRoot', 'path'],
  replace: ['op', 'mode', 'vaultRoot', 'path', 'operationId', 'baseSha256', 'candidateSha256', 'stagedPath', 'recoveryPath'],
  remove: ['op', 'mode', 'vaultRoot', 'path', 'operationId', 'baseSha256', 'recoveryPath'],
}

const isAbsolute = (value) => typeof value === 'string' && value.startsWith('/') && !value.includes('\u0000')

// A vault-relative path the publisher may address: visible files only, plus
// the settings Atelier owns (the two policy settings files and its own
// plugin's files). Every other settings path is the person's and cannot be
// named in a payload at all.
const ATELIER_OWNED_SETTINGS = new Set([...POLICY_SETTINGS_PATHS, ...PLUGIN_OWNED_PATHS])

export function isAddressableVaultPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || value.startsWith('/') || value.includes('\\') || value.includes('\u0000')) return false
  if (ATELIER_OWNED_SETTINGS.has(value)) return true
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && !part.startsWith('.'))
}

export function validatePayload(payload) {
  const fail = (message) => { throw new TypeError(`Invalid bridge payload: ${message}`) }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('object required')
  if (!OPS.has(payload.op)) fail('unknown op')
  if (payload.op === 'publish' && !MODES.has(payload.mode)) fail('unknown mode')
  const allowed = KEYS[payload.op === 'publish' ? payload.mode : payload.op]
  for (const key of Object.keys(payload)) if (!allowed.includes(key)) fail(`unknown key ${key}`)
  for (const key of allowed) if (payload[key] === undefined) fail(`missing key ${key}`)
  if (!isAbsolute(payload.vaultRoot)) fail('vaultRoot must be absolute')
  if (!isAddressableVaultPath(payload.path)) fail('path must be a relative visible path or a settings file Atelier owns')
  if (payload.op === 'publish') {
    if (!OPERATION_ID.test(payload.operationId)) fail('operationId required')
    if (!SHA.test(payload.baseSha256)) fail('baseSha256 required')
    if (!isAbsolute(payload.recoveryPath)) fail('recoveryPath must be absolute')
    if (payload.mode === 'replace') {
      if (!SHA.test(payload.candidateSha256)) fail('candidateSha256 required')
      if (!isAbsolute(payload.stagedPath)) fail('stagedPath must be absolute')
      if (payload.baseSha256 === payload.candidateSha256) fail('candidate equals base; nothing to publish')
    }
  }
  return payload
}

// Everything between "critical section begins" and "critical section ends" is
// synchronous. Inside the app that means no editor input event, in any window
// of the vault, can interleave with it. The function is serialized with
// toString(), so it may not close over anything in this module: all it uses
// arrives through `host`.
//
// host: { app, window, document, require, process, performance, exchange }
// `host.crashSeam` is a test seam for crash injection. It is a function-valued
// host property: no payload can carry it and buildEvalCode never sets it.
export function criticalSection(P, host) {
  const fs = host.require('fs')
  const nodePath = host.require('path')
  const crypto = host.require('crypto')
  const app = host.app || null
  const sha = (value) => crypto.createHash('sha256').update(value).digest('hex')
  const t0 = host.performance.now()
  const trace = []
  const step = (event, detail) => trace.push({ ms: Number((host.performance.now() - t0).toFixed(3)), event, ...(detail || {}) })
  const crash = (point) => { if (host.crashSeam && host.crashSeam.at === point) host.crashSeam.halt(point) }
  const real = (target) => { try { return fs.realpathSync(target) } catch (error) { return null } }
  const vaultBasePath = app ? real(app.vault.adapter.getBasePath()) : real(P.vaultRoot)
  const full = nodePath.join(P.vaultRoot, P.path)
  const views = () => {
    const found = []
    if (!app) return found
    app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view
      if (view && view.file && view.file.path === P.path && view.editor && typeof view.getViewData === 'function') found.push(view)
    })
    return found
  }
  const describe = (view) => ({ dirty: Boolean(view.dirty), bufferSha256: sha(view.getViewData()), popout: view.containerEl.ownerDocument !== host.document,
    savedMarker: typeof view.lastSavedData === 'string' })
  const lstat = (target) => { try { return fs.lstatSync(target) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
  // No write-through links: every directory on the way is a real directory and the leaf, when present, is a regular file.
  const unsafe = () => {
    let current = P.vaultRoot
    const parts = P.path.split('/')
    for (let index = 0; index < parts.length; index += 1) {
      current = nodePath.join(current, parts[index])
      const stat = lstat(current)
      if (!stat) return false
      if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) return true
    }
    return false
  }
  const disk = () => (lstat(full) ? sha(fs.readFileSync(full)) : null)
  const snapshot = () => ({ vaultBasePath, diskSha256: disk(), views: views().map(describe) })
  const store = (host.window.__atelierObsidianPublication = host.window.__atelierObsidianPublication || {})
  // Every outcome is kept here so a caller whose reply was lost re-reads it and never resends.
  const done = (status, extra) => {
    if (P.op === 'publish') store[P.path] = { ...(extra || {}), operationId: P.operationId, outcome: status }
    return JSON.stringify({ status, operationId: P.operationId, ...(extra || {}), trace })
  }

  if (vaultBasePath === null || vaultBasePath !== P.vaultRoot) return done('vault-mismatch', { vaultBasePath, wrote: false })
  // The app answered for this vault; the path itself is the problem.
  if (unsafe()) return done('path-unsafe', { vaultBasePath, wrote: false })
  if (P.op === 'inspect') return done('inspected', snapshot())
  if (P.op === 'collect') return JSON.stringify({ status: 'collected', ...(store[P.path] || { missing: true }), ...snapshot() })

  // ---- critical section begins (synchronous) ----
  step('enter')
  if (!lstat(full)) return done('note-missing', { ...snapshot(), wrote: false })
  const open = views()
  // Capability floor: the no-write editor update relies on the view's saved-content field. Refuse open notes on an app build that lacks it.
  if (P.mode === 'replace' && open.some((view) => typeof view.lastSavedData !== 'string')) return done('unsupported-app', { wrote: false })
  if (open.some((view) => view.dirty || sha(view.getViewData()) !== P.baseSha256)) return done('editor-edit', { ...snapshot(), wrote: false })
  if (disk() !== P.baseSha256) return done('disk-changed', { ...snapshot(), wrote: false })
  if (lstat(P.recoveryPath)) return done('recovery-path-occupied', { wrote: false })

  if (P.mode === 'remove') {
    // A move, never a delete: whatever occupies the path at this instant is kept at the recovery path.
    try { fs.renameSync(full, P.recoveryPath) } catch (error) { return done('move-failed', { ...snapshot(), wrote: false, errorCode: error.code || null }) }
    step('moved')
    crash('after-removal-move')
    const movedSha256 = sha(fs.readFileSync(P.recoveryPath))
    if (movedSha256 !== P.baseSha256) {
      // Something replaced the note between the check and the move. Put it back without overwriting anything.
      try { fs.linkSync(P.recoveryPath, full) } catch (error) {
        // The path is taken again, or cannot be linked: the moved bytes stay in recovery.
        return done('removed-external-captured', { ...snapshot(), wrote: true, externalCaptured: true, recoveredSha256: movedSha256 })
      }
      // The note is live again from here on, whatever happens to the second name.
      let recoveryNameLeft = false
      try { fs.unlinkSync(P.recoveryPath) } catch (error) { recoveryNameLeft = true }
      return done('remove-reverted', { ...snapshot(), wrote: false, observedSha256: movedSha256, recoveryNameLeft })
    }
    return done('removed', { ...snapshot(), wrote: true, externalCaptured: false, recoveredSha256: movedSha256 })
  }

  let candidate
  try { candidate = fs.readFileSync(P.stagedPath) } catch (error) { return done('staged-missing', { wrote: false, errorCode: error.code || null }) }
  if (sha(candidate) !== P.candidateSha256) return done('staged-mismatch', { wrote: false })
  const call = host.exchange.calls[`${host.process.platform}/${host.process.arch}`]
  const perl = host.exchange.perlCandidates.find((candidatePath) => fs.existsSync(candidatePath))
  if (!call || !perl) return done('exchange-unavailable', { wrote: false })
  // The interpreter runs inside the app: only a root-owned binary that neither group nor others can write.
  let perlStat = null
  try { perlStat = fs.statSync(perl) } catch (error) { perlStat = null }
  if (!perlStat || perlStat.uid !== 0 || (perlStat.mode & 0o022) !== 0) return done('exchange-interpreter-untrusted', { wrote: false })
  // Atomic exchange: whatever occupied the note path at this instant lands at
  // the staged path, so no concurrent replacement of the note can be lost.
  let exitStatus = 0
  try {
    host.require('child_process').execFileSync(perl, ['-e', host.exchange.script, '--', String(call.number), String(call.cwd), P.stagedPath, full], { stdio: 'ignore' })
  } catch (error) {
    exitStatus = error.status == null ? null : error.status
  }
  // What happened is read from the files, not from the exit status: a helper
  // killed after the call returned reports failure although the exchange took
  // place. The staged path is private, so bytes there that are not the
  // candidate can only be what the exchange displaced from the note path.
  let stagedNow = null
  try { stagedNow = sha(fs.readFileSync(P.stagedPath)) } catch (error) { stagedNow = null }
  if (stagedNow === null || stagedNow === P.candidateSha256) {
    // All-or-nothing: a failure (for example a full disk) leaves the note as it was.
    const seen = snapshot()
    return done('exchange-failed', { ...seen, wrote: stagedNow === null && seen.diskSha256 === P.candidateSha256, exitStatus })
  }
  step('exchanged', exitStatus === 0 ? undefined : { exitStatus })
  crash('after-exchange')
  fs.renameSync(P.stagedPath, P.recoveryPath)
  const recoveredSha256 = sha(fs.readFileSync(P.recoveryPath))
  const externalCaptured = recoveredSha256 !== P.baseSha256
  step('recovered', { externalCaptured })
  crash('after-recovery-move')

  const candidateText = candidate.toString('utf8')
  let editorUpdateFailed = false
  open.forEach((view) => {
    // Route the change through the editor so the app never takes its lossy
    // external-modification merge path for this view, and never writes the
    // file itself afterwards: an in-place save here would overwrite an outside
    // writer that replaced the note after the exchange. Minimal line hunks in
    // one transaction keep carets and selections in untouched text.
    try {
      const a = view.getViewData().split(/(?<=\n)/)
      const b = candidateText.split(/(?<=\n)/)
      let head = 0
      while (head < a.length && head < b.length && a[head] === b[head]) head += 1
      let tail = 0
      while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1
      const starts = [0]
      for (const line of a) starts.push(starts[starts.length - 1] + line.length)
      const am = a.slice(head, a.length - tail)
      const bm = b.slice(head, b.length - tail)
      const changes = []
      if (am.length * bm.length > 4000000) {
        // Too large for a line table inside a synchronous section: one hunk over the differing middle.
        changes.push({ from: starts[head], to: starts[a.length - tail], old: am.join(''), text: bm.join('') })
      } else {
        const lcs = Array.from({ length: am.length + 1 }, () => new Uint32Array(bm.length + 1))
        for (let i = am.length - 1; i >= 0; i -= 1) {
          for (let j = bm.length - 1; j >= 0; j -= 1) lcs[i][j] = am[i] === bm[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
        }
        let current = null
        for (let i = 0, j = 0; i < am.length || j < bm.length;) {
          if (i < am.length && j < bm.length && am[i] === bm[j]) { current = null; i += 1; j += 1; continue }
          if (!current) { current = { from: starts[head + i], to: starts[head + i], old: '', text: '' }; changes.push(current) }
          if (j < bm.length && (i >= am.length || lcs[i][j + 1] >= lcs[i + 1][j])) { current.text += bm[j]; j += 1 } else { current.old += am[i]; i += 1; current.to = starts[head + i] }
        }
      }
      for (const change of changes) {
        let lead = 0
        while (lead < change.old.length && lead < change.text.length && change.old[lead] === change.text[lead]) lead += 1
        let trail = 0
        while (trail < change.old.length - lead && trail < change.text.length - lead
          && change.old[change.old.length - 1 - trail] === change.text[change.text.length - 1 - trail]) trail += 1
        change.from += lead; change.to -= trail; change.text = change.text.slice(lead, change.text.length - trail)
      }
      view.editor.transaction({ changes: changes.map((change) => ({ from: view.editor.offsetToPos(change.from), to: view.editor.offsetToPos(change.to), text: change.text })) })
      if (view.getViewData() !== candidateText) { step('hunk-fallback'); view.editor.setValue(candidateText) }
      view.lastSavedData = candidateText // the app's delayed save now sees nothing to write
    } catch (error) {
      // The note is already published and the buffer was clean: the app reloads a clean buffer from disk without loss.
      editorUpdateFailed = true
      step('editor-update-failed')
    }
  })
  step('editor-routed', { openViews: open.length })
  crash('after-editor-update')
  // ---- critical section ends ----
  return done(externalCaptured ? 'published-external-captured' : 'published', { ...snapshot(), wrote: true, openViews: open.length, externalCaptured, recoveredSha256, editorUpdateFailed })
}

const encodePayload = (payload) => Buffer.from(JSON.stringify(validatePayload(payload)), 'utf8').toString('base64')

// The code sent to the app. Only the base64 literal varies between calls.
export function buildEvalCode(payload) {
  return `(${criticalSection.toString()})(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('${encodePayload(payload)}'),c=>c.charCodeAt(0)))),`
    + `{app,window,document,require,process,performance,exchange:${JSON.stringify(EXCHANGE_CONSTANTS)}})`
}

const nodeRequire = createRequire(import.meta.url)

// A host for running the same script in this process. With no `app` the
// script sees no editors; that is only correct when no Obsidian has the vault
// open, which the publisher establishes before choosing this path.
export function createInProcessHost({ app = null, window = {}, document = {}, crashSeam } = {}) {
  return { app, window, document, require: nodeRequire, process, performance, exchange: EXCHANGE_CONSTANTS, ...(crashSeam ? { crashSeam } : {}) }
}

export function runInProcess(payload, host) {
  // The payload takes the same JSON round trip it takes on its way into the app.
  return JSON.parse(criticalSection(JSON.parse(JSON.stringify(validatePayload(payload))), host))
}
