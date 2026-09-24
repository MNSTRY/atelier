'use strict'

// Atelier's own plugin. Atelier ships it into every vault it manages, under
// .obsidian/plugins/atelier-projection/, beside a data file that names the
// maintenance service of the workspace and this vault's key (its bearer). The
// person never installs it; Obsidian asks once per vault whether to trust the
// vault's plugins, and until then (or in restricted mode, or on an app older
// than 1.13.7) everything works without it.
//
// Phase 1: presence and status, read-only. While the vault is open the plugin
// tells the service so (a lease renewed every two seconds, released when the
// plugin unloads), reports the app version it runs in, and shows the view's
// freshness in the status bar and in "Atelier: show status".
//
// The key never leaves this machine's files. The plugin first asks whatever
// listens at the service's address to prove that it holds the key, and sends
// nothing that names this vault until it did; then it proves the same, and
// every later request and answer is sealed with a key for that session only.
//
// What it never does: write a file (a note, a setting, its own data file),
// run code it is sent, or reach anything but that one service, on a literal
// loopback address, with no name to resolve.

const obsidian = require('obsidian')

// Held equal to src/projection/obsidian/plugin-bridge/channel.mjs by the test suite.
const CHANNEL = Object.freeze({
  pluginId: 'atelier-projection',
  protocol: 'atelier-obsidian-plugin-channel/v2',
  dataSchema: 'atelier-obsidian-plugin-data/v1',
  statusSchema: 'atelier-obsidian-plugin-status/v1',
  routes: Object.freeze({ challenge: '/plugin/challenge', hello: '/plugin/hello', lease: '/plugin/lease', release: '/plugin/release', status: '/plugin/status' }),
  renewEveryMs: 2000,
  requestTimeoutMs: 1500,
  maxResponseBytes: 64 * 1024,
  minimumAppVersion: '1.13.7',
})

const BEARER = /^[A-Za-z0-9_-]{43}$/
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const NONCE = /^[0-9a-f]{64}$/
const MAC = /^[0-9a-f]{64}$/
const HANDSHAKE_ID = /^ph-[0-9a-f]{32}$/
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

// The handshake and session computations of plugin-bridge/channel.mjs; the
// test suite holds the two to each other. Every input but the vault path is a
// shape without a line break, and the vault path is the only input of its
// computation, so joining them by lines is unambiguous.
function transcript(label, fields) {
  return [CHANNEL.protocol, label].concat(fields.map(String)).join('\n')
}
function hmac(crypto, key, label, fields) {
  return crypto.createHmac('sha256', key).update(transcript(label, fields), 'utf8').digest()
}
function hmacHex(crypto, key, label, fields) {
  return hmac(crypto, key, label, fields).toString('hex')
}
// Two MACs in hex, compared in time that does not depend on where they differ.
function sameMac(presented, expected) {
  if (typeof presented !== 'string' || !MAC.test(presented) || presented.length !== expected.length) return false
  let difference = 0
  for (let index = 0; index < expected.length; index += 1) difference |= presented.charCodeAt(index) ^ expected.charCodeAt(index)
  return difference === 0
}
// The exact address the service is reached at, as both proofs bind it.
const authorityOf = (channel) => (channel.host === '::1' ? `[::1]:${channel.port}` : `127.0.0.1:${channel.port}`)

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

// The two ways a round can fail to reach the view. Between them the status bar moves only once two rounds agree.
const ROUND_FAILURES = new Set(['not-set-up', 'unreachable'])

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
    const authority = authorityOf(channel)
    let request
    try {
      // A literal loopback address, whatever the data file said: nothing is resolved by name.
      request = http.request({ host: channel.host === '::1' ? '::1' : '127.0.0.1', family: channel.host === '::1' ? 6 : 4, port: channel.port, method: 'POST', path: route, agent: false, timeout: CHANNEL.requestTimeoutMs,
        headers: { Host: authority, 'Content-Type': 'application/json', 'Content-Length': byteLength(text), Connection: 'close' } }, (response) => {
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
    this.session = null
    this.cycling = null
    this.unloaded = false
    this.view = { state: 'connecting', reason: 'not-yet-asked', report: null }
    this.shownState = null
    // A round's failure that differs from the failure shown, not yet seen twice in a row.
    this.pendingFailure = null
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
      this.crypto = require('crypto')
    } catch {
      this.http = null
    }
    if (!this.http || typeof this.http.request !== 'function' || !this.fs || typeof this.fs.realpathSync !== 'function' || !this.crypto || typeof this.crypto.createHmac !== 'function' || typeof this.crypto.randomBytes !== 'function') {
      this.setView({ state: 'not-set-up', reason: 'node-modules-unavailable', report: null })
      return
    }
    // This launch of the plugin: the service tells two apps holding the same vault apart by it.
    this.instanceId = `pi-${this.crypto.randomBytes(16).toString('hex')}`
    await this.readChannel()
    this.registerInterval(globalThis.setInterval(() => { void this.cycle() }, CHANNEL.renewEveryMs))
    // Not awaited: the app finishes loading while the first round trip is under way.
    void this.cycle()
  }

  onunload() {
    // The lease lapses by itself; releasing it says at once that the vault closed. A round still under way stops at its
    // next step, and a session it opens after this is released at once.
    this.unloaded = true
    const session = this.session
    this.session = null
    if (this.channel && session) void this.release(this.channel, session)
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
    if (!same) this.session = null
    this.channel = next
    if (next === null) this.setView({ state: 'not-set-up', reason: data === null ? 'no-channel-data' : 'channel-data-unusable', report: null })
  }

  // One round: shake hands (once per session), renew the lease, read the status.
  cycle() {
    if (this.cycling) return this.cycling
    this.cycling = this.runCycle().finally(() => { this.cycling = null })
    return this.cycling
  }

  // Whether a round that started for `channel` may still act.
  current(channel) {
    return !this.unloaded && channel === this.channel
  }

  async runCycle() {
    const channel = this.channel
    if (channel === null || this.unloaded) return
    if (this.session === null) {
      if (!(await this.handshake(channel))) return
    } else {
      const lease = await this.request(channel, 'lease')
      if (!this.current(channel)) return
      if (lease.kind !== 'sealed') {
        // Whatever answered did not seal its answer with the session's key: the session ends here, and the next request
        // starts a handshake, which only the service can answer. An unproven listener gets no second request of it.
        this.session = null
        if (!(lease.kind === 'refused' && (lease.error === 'session-unknown' || lease.statusCode === 401))) {
          this.showRound(this.unreachable(lease))
          return
        }
        // The service started again since, the vault's key changed, or the session is not accepted: shake hands at once.
        if (!(await this.handshake(channel))) return
      }
    }
    const status = await this.request(channel, 'status')
    if (!this.current(channel)) return
    if (status.kind !== 'sealed') this.session = null
    this.showRound(status.kind === 'sealed' ? viewOfStatus(status.document) : this.unreachable(status))
  }

  // The handshake. Nothing that names this vault is sent before the listener proved it holds the vault's key.
  async handshake(channel) {
    let vaultPath = null
    try { vaultPath = this.fs.realpathSync(this.app.vault.adapter.getBasePath()) } catch { vaultPath = null }
    if (typeof vaultPath !== 'string') {
      this.showRound({ state: 'not-set-up', reason: 'vault-path-unknown', report: null })
      return false
    }
    const crypto = this.crypto
    const clientNonce = crypto.randomBytes(32).toString('hex')
    const issuedAt = Date.now()
    const challenge = await post(this.http, channel, CHANNEL.routes.challenge, { protocol: CHANNEL.protocol, keyHint: hmacHex(crypto, channel.bearer, 'key-hint', [clientNonce, issuedAt]), clientNonce, issuedAt })
    if (!this.current(channel)) return false
    const offer = challenge.kind === 'response' && challenge.statusCode === 200 ? challenge.body : null
    if (offer === null) {
      this.showRound(challenge.kind === 'response' && challenge.statusCode === 401 ? { state: 'not-set-up', reason: 'key-not-known-to-the-service', report: null } : this.unreachable(challenge))
      return false
    }
    const bound = [channel.scopeId, authorityOf(channel), clientNonce, offer.serverNonce, offer.handshakeId]
    if (offer.protocol !== CHANNEL.protocol || typeof offer.handshakeId !== 'string' || !HANDSHAKE_ID.test(offer.handshakeId) || typeof offer.serverNonce !== 'string' || !NONCE.test(offer.serverNonce)
      || !sameMac(offer.serverProof, hmacHex(crypto, channel.bearer, 'server-proof', bound))) {
      // Whatever answers there does not hold this vault's key: it is told nothing more.
      this.showRound({ state: 'unreachable', reason: 'listener-not-proven', report: null })
      return false
    }
    const key = hmac(crypto, channel.bearer, 'session-key', bound)
    const vaultProof = hmacHex(crypto, key, 'vault', [vaultPath])
    const pluginVersion = String(this.manifest.version)
    const clientProof = hmacHex(crypto, channel.bearer, 'client-proof', bound.concat([pluginVersion, this.appVersion, this.instanceId, vaultProof]))
    const answer = await post(this.http, channel, CHANNEL.routes.hello, { handshakeId: offer.handshakeId, pluginVersion, appVersion: this.appVersion, instanceId: this.instanceId, vaultProof, clientProof })
    const sealed = this.opened(answer, 'hello', { key, id: null }, 0)
    if (sealed.kind === 'sealed') {
      const session = { id: sealed.sessionId, key, counter: 0 }
      if (!this.current(channel)) {
        // Unloaded, or a new channel, while the hello was under way: the session it opened is let go at once.
        void this.release(channel, session)
        return false
      }
      this.session = session
      return true
    }
    if (!this.current(channel)) return false
    // A copy of a vault carries its data file, but the service maintains the original only.
    if (sealed.kind === 'refused' && sealed.statusCode === 409 && sealed.error === 'wrong-vault') this.showRound({ state: 'not-set-up', reason: 'not-the-vault-atelier-maintains', report: null })
    else this.showRound(this.unreachable(sealed))
    return false
  }

  // One command of the session: a counter that only goes up, and a MAC over it under the session's key.
  request(channel, command) {
    const session = this.session
    session.counter += 1
    const counter = session.counter
    return post(this.http, channel, CHANNEL.routes[command], { sessionId: session.id, counter, mac: hmacHex(this.crypto, session.key, 'request', [command, session.id, counter]) })
      .then((answer) => this.opened(answer, command, session, counter))
  }

  release(channel, session) {
    session.counter += 1
    return post(this.http, channel, CHANNEL.routes.release, { sessionId: session.id, counter: session.counter, mac: hmacHex(this.crypto, session.key, 'request', ['release', session.id, session.counter]) })
  }

  // An answer counts only when it is sealed with the session's key over this very request:
  //   { kind: 'sealed', document, sessionId }   the service's own answer
  //   { kind: 'refused', statusCode, error }    an error; nobody vouches for it, so it only ever makes the plugin ask again
  //   { kind: 'unreachable', code }             nothing usable came back
  opened(answer, command, session, counter) {
    if (answer.kind !== 'response') return answer
    const body = answer.body
    if (answer.statusCode !== 200) return { kind: 'refused', statusCode: answer.statusCode, error: body && typeof body.error === 'string' ? body.error : null }
    let document = null
    try { document = body && typeof body.payload === 'string' ? JSON.parse(body.payload) : null } catch { document = null }
    // A hello's answer names the session it opened; the MAC over it is what vouches for that name.
    const sessionId = command === 'hello' ? (isPlainObject(document) && typeof document.sessionId === 'string' && SESSION_ID.test(document.sessionId) ? document.sessionId : null) : session.id
    if (!isPlainObject(document) || sessionId === null || !sameMac(body.mac, hmacHex(this.crypto, session.key, 'response', [command, sessionId, counter, body.payload]))) return { kind: 'unreachable', code: 'answer-not-authenticated' }
    return { kind: 'sealed', document, sessionId }
  }

  unreachable(answer) {
    const reason = answer.kind === 'unreachable' ? answer.code : typeof answer.error === 'string' ? answer.error : answer.body && typeof answer.body.error === 'string' ? answer.body.error : `answered-${answer.statusCode}`
    return { state: 'unreachable', reason, report: null }
  }

  // What a round found. A failure other than the one shown ('not set up' where 'service unreachable' is shown, or the other
  // way round) is shown only when the next round finds it too, so answers that alternate between them do not make the
  // status bar flip. Anything else is shown at once.
  showRound(view) {
    if (ROUND_FAILURES.has(view.state) && ROUND_FAILURES.has(this.shownState) && view.state !== this.shownState && this.pendingFailure !== view.state) {
      this.pendingFailure = view.state
      return
    }
    this.setView(view)
  }

  setView(view) {
    // Nothing is shown once the plugin unloaded.
    if (this.unloaded) return
    this.pendingFailure = null
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
