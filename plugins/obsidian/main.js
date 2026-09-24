'use strict'

// Atelier's own plugin. Atelier ships it into every vault it manages, under
// .obsidian/plugins/atelier-projection/, beside a data file that names the
// maintenance service of the workspace and this vault's bearer. The person
// never installs it; Obsidian asks once per vault whether to trust the vault's
// plugins, and until then (or in restricted mode, or on an app older than
// 1.13.7) everything works without it.
//
// Phase 1: presence and status, read-only. While the vault is open the plugin
// tells the service so (a lease renewed every two seconds, released when the
// plugin unloads), reports the app version it runs in, and shows the view's
// freshness in the status bar and in "Atelier: show status".
//
// What it never does: write a file (a note, a setting, its own data file),
// run code it is sent, or reach anything but that one service, on a literal
// loopback address, with no name to resolve.

const obsidian = require('obsidian')

// Held equal to src/projection/obsidian/plugin-bridge/channel.mjs by the test suite.
const CHANNEL = Object.freeze({
  pluginId: 'atelier-projection',
  protocol: 'atelier-obsidian-plugin-channel/v1',
  dataSchema: 'atelier-obsidian-plugin-data/v1',
  statusSchema: 'atelier-obsidian-plugin-status/v1',
  routes: Object.freeze({ hello: '/plugin/hello', lease: '/plugin/lease', release: '/plugin/release', status: '/plugin/status' }),
  renewEveryMs: 2000,
  requestTimeoutMs: 1500,
  maxResponseBytes: 64 * 1024,
  minimumAppVersion: '1.13.7',
})

const BEARER = /^[A-Za-z0-9_-]{43}$/
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SESSION_ID = /^ps-[0-9a-f]{32}$/
const VERSION = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.]+))?/

// -1, 0 or 1; null when either side is not a version. A prerelease ranks below its release.
function compareVersions(left, right) {
  const [a, b] = [VERSION.exec(String(left || '')), VERSION.exec(String(right || ''))]
  if (!a || !b) return null
  for (let index = 1; index <= 3; index += 1) if (Number(a[index]) !== Number(b[index])) return Number(a[index]) < Number(b[index]) ? -1 : 1
  if (Boolean(a[4]) === Boolean(b[4])) return a[4] === b[4] || !a[4] ? 0 : a[4] < b[4] ? -1 : 1
  return a[4] ? -1 : 1
}

function meetsFloor(version) {
  const order = compareVersions(version, CHANNEL.minimumAppVersion)
  return order !== null && order >= 0
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// The channel this vault's data file names, or null when it names none that can be used.
function channelOf(data) {
  if (!isPlainObject(data) || data.schema !== CHANNEL.dataSchema || !isPlainObject(data.channel)) return null
  const { host, port } = data.channel
  if (host !== '127.0.0.1' && host !== '::1') return null
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return null
  if (typeof data.scopeId !== 'string' || !IDENTIFIER.test(data.scopeId) || typeof data.bearer !== 'string' || !BEARER.test(data.bearer)) return null
  return Object.freeze({ host, port, scopeId: data.scopeId, bearer: data.bearer })
}

// What the status bar says. `held` carries the number of held edits.
const LABELS = Object.freeze({
  connecting: 'Atelier: connecting',
  current: 'Atelier: current',
  updating: 'Atelier: updating',
  stale: 'Atelier: stale',
  unreachable: 'Atelier: service unreachable',
  'not-set-up': 'Atelier: not set up',
  unsupported: 'Atelier: needs a newer Obsidian',
})

function labelOf(view) {
  return view.state === 'held' ? `Atelier: held (${view.held})` : LABELS[view.state]
}

const plural = (count, one, many) => (count === 1 ? one : many)

// Notices on a transition into a state that needs a person, and back out of one.
const ATTENTION = Object.freeze({
  held: (view) => `Atelier kept ${plural(view.held, 'an edit', `${view.held} edits`)} you made. This view is not updated over ${plural(view.held, 'it', 'them')} until ${plural(view.held, 'it is', 'they are')} applied or withdrawn.`,
  stale: () => 'Atelier: this view is not current. "Atelier: show status" says why.',
  unreachable: () => 'Atelier: the maintenance service does not answer. The vault stays as it is.',
  unsupported: () => `Atelier's plugin needs Obsidian ${CHANNEL.minimumAppVersion} or later. The vault keeps working without it.`,
})

// The view as the service reports it. Anything but current, updating or held is stale.
function viewOfStatus(body) {
  const view = isPlainObject(body) && body.schema === CHANNEL.statusSchema && isPlainObject(body.view) ? body.view : null
  const common = { reason: view && typeof view.reason === 'string' ? view.reason : 'no-freshness-recorded', report: isPlainObject(body) ? body : null }
  if (view === null) return { state: 'stale', ...common }
  if (view.state === 'current') return { state: 'current', ...common }
  if (view.state === 'updating') return { state: 'updating', ...common }
  if (view.state === 'held-for-your-edit') return { state: 'held', held: Number.isInteger(view.heldNoteCount) ? view.heldNoteCount : 0, ...common }
  return { state: 'stale', ...common }
}

const readable = (code) => (typeof code === 'string' && code !== '' ? code.replace(/[-_]+/g, ' ') : 'none')
const byteLength = (text) => new TextEncoder().encode(text).length

// One request to the service. Resolves, never rejects:
//   { kind: 'response', statusCode, body }   body is a JSON object or null
//   { kind: 'unreachable', code }            nothing usable came back
function post(http, channel, route, body) {
  return new Promise((resolve) => {
    let settled = false
    const settle = (value) => { if (!settled) { settled = true; resolve(value) } }
    const text = JSON.stringify(body)
    const authority = channel.host === '::1' ? `[::1]:${channel.port}` : `127.0.0.1:${channel.port}`
    let request
    try {
      // A literal loopback address, whatever the data file said: nothing is resolved by name.
      request = http.request({ host: channel.host === '::1' ? '::1' : '127.0.0.1', family: channel.host === '::1' ? 6 : 4, port: channel.port, method: 'POST', path: route, agent: false, timeout: CHANNEL.requestTimeoutMs,
        headers: { Host: authority, Authorization: `Bearer ${channel.bearer}`, 'Content-Type': 'application/json', 'Content-Length': byteLength(text), Connection: 'close' } }, (response) => {
        let size = 0
        let received = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          size += chunk.length
          if (size > CHANNEL.maxResponseBytes) { settle({ kind: 'unreachable', code: 'answer-too-large' }); request.destroy() } else received += chunk
        })
        response.on('end', () => {
          let parsed = null
          try { parsed = JSON.parse(received) } catch { parsed = null }
          settle({ kind: 'response', statusCode: response.statusCode, body: isPlainObject(parsed) ? parsed : null })
        })
        response.on('error', () => settle({ kind: 'unreachable', code: 'answer-failed' }))
      })
    } catch {
      settle({ kind: 'unreachable', code: 'request-failed' })
      return
    }
    request.on('timeout', () => { settle({ kind: 'unreachable', code: 'timeout' }); request.destroy() })
    request.on('error', (error) => settle({ kind: 'unreachable', code: error && error.code === 'ECONNREFUSED' ? 'refused' : 'request-failed' }))
    request.end(text)
  })
}

class AtelierStatusModal extends obsidian.Modal {
  constructor(app, rows) {
    super(app)
    this.rows = rows
  }

  onOpen() {
    this.setTitle('Atelier status')
    const list = this.contentEl.createEl('dl', { cls: 'atelier-projection-status' })
    for (const [label, value] of this.rows) {
      list.createEl('dt', { text: label })
      list.createEl('dd', { text: value })
    }
  }

  onClose() {
    this.contentEl.empty()
  }
}

class AtelierProjectionPlugin extends obsidian.Plugin {
  async onload() {
    this.channel = null
    this.sessionId = null
    this.cycling = null
    this.view = { state: 'connecting', reason: 'not-yet-asked', report: null }
    this.shownState = null
    this.appVersion = typeof obsidian.apiVersion === 'string' ? obsidian.apiVersion : null
    this.statusBarEl = this.addStatusBarItem()
    this.statusBarEl.addClass('atelier-projection-status-bar')
    this.registerDomEvent(this.statusBarEl, 'click', () => this.showStatus())
    this.addCommand({ id: 'show-status', name: 'Show status', callback: () => this.showStatus() })
    this.setView(this.view)

    if (!meetsFloor(this.appVersion)) {
      // Older than the floor, or a version that cannot be read: visible, and the channel stays closed.
      this.setView({ state: 'unsupported', reason: 'app-below-minimum-version', report: null })
      return
    }
    try {
      this.http = require('http')
      this.fs = require('fs')
    } catch {
      this.setView({ state: 'unsupported', reason: 'node-modules-unavailable', report: null })
      return
    }
    await this.readChannel()
    this.registerInterval(globalThis.setInterval(() => { void this.cycle() }, CHANNEL.renewEveryMs))
    // Not awaited: the app finishes loading while the first round trip is under way.
    void this.cycle()
  }

  onunload() {
    // The lease lapses by itself; releasing it says at once that the vault closed.
    if (this.channel && this.sessionId && this.http) {
      void post(this.http, this.channel, CHANNEL.routes.release, { scopeId: this.channel.scopeId, sessionId: this.sessionId })
    }
    this.sessionId = null
  }

  // Obsidian calls this when data.json changed on disk: Atelier republished the channel.
  async onExternalSettingsChange() {
    await this.readChannel()
    // A round under way still speaks for the old channel; the next one uses the new.
    if (this.cycling) await this.cycling
    await this.cycle()
  }

  async readChannel() {
    let data = null
    try { data = await this.loadData() } catch { data = null }
    const next = channelOf(data)
    const same = next && this.channel && next.host === this.channel.host && next.port === this.channel.port && next.scopeId === this.channel.scopeId && next.bearer === this.channel.bearer
    if (!same) this.sessionId = null
    this.channel = next
    if (next === null) this.setView({ state: 'not-set-up', reason: data === null ? 'no-channel-data' : 'channel-data-unusable', report: null })
  }

  // One round: identify (once per session), renew the lease, read the status.
  cycle() {
    if (this.cycling) return this.cycling
    this.cycling = this.runCycle().finally(() => { this.cycling = null })
    return this.cycling
  }

  async runCycle() {
    const channel = this.channel
    if (channel === null) return
    if (this.sessionId === null) {
      if (!(await this.hello(channel))) return
    } else {
      const lease = await post(this.http, channel, CHANNEL.routes.lease, { scopeId: channel.scopeId, sessionId: this.sessionId })
      if (lease.kind === 'response' && lease.statusCode === 409 && lease.body && lease.body.error === 'session-unknown') {
        // The service started again since: identify once more.
        this.sessionId = null
        if (!(await this.hello(channel))) return
      } else if (!(lease.kind === 'response' && lease.statusCode === 200)) {
        this.setView(this.unreachable(lease))
        return
      }
    }
    const status = await post(this.http, channel, CHANNEL.routes.status, { scopeId: channel.scopeId })
    if (channel !== this.channel) return
    this.setView(status.kind === 'response' && status.statusCode === 200 ? viewOfStatus(status.body) : this.unreachable(status))
  }

  async hello(channel) {
    let vaultPath = null
    try { vaultPath = this.fs.realpathSync(this.app.vault.adapter.getBasePath()) } catch { vaultPath = null }
    if (typeof vaultPath !== 'string') {
      this.setView({ state: 'unsupported', reason: 'vault-path-unknown', report: null })
      return false
    }
    const answer = await post(this.http, channel, CHANNEL.routes.hello, { protocol: CHANNEL.protocol, scopeId: channel.scopeId, pluginVersion: String(this.manifest.version), appVersion: this.appVersion, vaultPath })
    if (channel !== this.channel) return false
    if (answer.kind === 'response' && answer.statusCode === 200 && answer.body && typeof answer.body.sessionId === 'string' && SESSION_ID.test(answer.body.sessionId)) {
      this.sessionId = answer.body.sessionId
      return true
    }
    // A copy of a vault carries its data file, but the service maintains the original only.
    if (answer.kind === 'response' && answer.statusCode === 409 && answer.body && answer.body.error === 'wrong-vault') this.setView({ state: 'not-set-up', reason: 'not-the-vault-atelier-maintains', report: null })
    else this.setView(this.unreachable(answer))
    return false
  }

  unreachable(answer) {
    const reason = answer.kind === 'unreachable' ? answer.code : answer.body && typeof answer.body.error === 'string' ? answer.body.error : `answered-${answer.statusCode}`
    return { state: 'unreachable', reason, report: null }
  }

  setView(view) {
    const previous = this.shownState
    this.view = view
    this.statusBarEl.setText(labelOf(view))
    this.statusBarEl.setAttr('aria-label', `${labelOf(view)} (${readable(view.reason)})`)
    this.shownState = view.state
    if (previous === view.state || previous === null) return
    if (Object.prototype.hasOwnProperty.call(ATTENTION, view.state)) new obsidian.Notice(ATTENTION[view.state](view))
    else if (view.state === 'current' && Object.prototype.hasOwnProperty.call(ATTENTION, previous)) new obsidian.Notice('Atelier: this view is current again.')
  }

  statusRows() {
    const report = this.view.report || {}
    const view = isPlainObject(report.view) ? report.view : {}
    const count = (value) => (Number.isInteger(value) ? String(value) : 'unknown')
    const channel = this.channel
    return [
      ['View', channel ? channel.scopeId : 'not set up'],
      ['State', labelOf(this.view).replace(/^Atelier: /, '')],
      ['Reason', readable(this.view.reason)],
      ['Generation', typeof view.generationId === 'string' ? view.generationId : 'none yet'],
      ['Prepared generation', typeof view.preparedGenerationId === 'string' ? view.preparedGenerationId : 'none yet'],
      ['Checked at', typeof view.checkedAt === 'string' ? view.checkedAt : 'not yet'],
      ['Held edits', count(view.heldNoteCount)],
      ['Retained edits', count(view.retainedEdits)],
      ['Pending edits', count(isPlainObject(report.pendingEdits) ? report.pendingEdits.open : null)],
      ['Service', channel ? `${channel.host === '::1' ? '[::1]' : '127.0.0.1'}:${channel.port}, ${isPlainObject(report.service) && typeof report.service.status === 'string' ? report.service.status : 'no answer'}` : 'not set up'],
      ['Plugin', String(this.manifest.version)],
      ['Obsidian', this.appVersion || 'unknown'],
    ]
  }

  showStatus() {
    new AtelierStatusModal(this.app, this.statusRows()).open()
  }
}

AtelierProjectionPlugin.channel = CHANNEL
module.exports = AtelierProjectionPlugin
