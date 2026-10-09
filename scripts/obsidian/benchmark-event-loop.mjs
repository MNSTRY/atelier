#!/usr/bin/env node
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { createEventLoopCorpus, createTransitionDriver, initializeTransitionRepositories, TRANSITION_SCENARIOS } from '../../test/helpers/obsidian-event-loop-corpus.mjs'
import { resolveProjectConfig } from '../../src/project/config.mjs'
import { createEditorAdapter, publishView } from '../../src/projection/obsidian/publication/index.mjs'
import { prepareViewCooperatively } from '../../src/projection/obsidian/materialize/prepare-view.mjs'
import { PLUGIN_DIRECTORY } from '../../src/projection/obsidian/plugin-bridge/channel.mjs'
import { createRecoveryStore } from '../../src/projection/obsidian/recovery/store.mjs'
import { createMaintenanceEngine } from '../../src/runtime/obsidian/engine.mjs'
import { protectedRoots } from '../../src/runtime/obsidian/machine-settings.mjs'
import { buildGraph, captureSnapshot } from '../../src/runtime/obsidian/pipeline.mjs'
import { probeHealth } from '../../src/runtime/obsidian/service-client.mjs'
import { readServiceRecord, writeServiceSettings } from '../../src/runtime/obsidian/service-record.mjs'
import { runMaintenanceService } from '../../src/runtime/obsidian/service.mjs'
import { createNullWatcherFactory } from '../../src/runtime/obsidian/watchers.mjs'

// A finite controller and one owned child running the production service body.
// The controller probes from a separate process: a service blocked before its
// first cooperative yield cannot hide that interval by delaying its own probe.
// Defaults are a small smoke run. A large run takes minutes and wants a host
// with little else on it. Every run builds, reads and removes its own invented
// corpus; nothing here can be pointed at a real one.
const entry = fileURLToPath(import.meta.url)
const repository = fileURLToPath(new URL('../../', import.meta.url))
const epochMs = () => performance.timeOrigin + performance.now()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const arg = name => process.argv.slice(2).find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
function integer(name, fallback, minimum, maximum) {
  const value = Number(arg(name) ?? fallback)
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new TypeError(`--${name} must be between ${minimum} and ${maximum}`)
  return value
}
const send = message => { if (process.connected) process.send(message) }
const sendTerminal = message => new Promise((resolve, reject) => {
  if (!process.connected) return reject(new Error('owning IPC controller disconnected'))
  process.send(message, error => error ? reject(error) : resolve())
})
function summaryBursts() {
  const phases = new Map()
  return {
    record({ phase, elapsedMs, units, maxUnitMs }) {
      const previous = phases.get(phase) ?? { bursts: 0, maxElapsedMs: 0, maxUnitMs: 0, units: 0 }
      phases.set(phase, { bursts: previous.bursts + 1, maxElapsedMs: Math.max(previous.maxElapsedMs, elapsedMs), maxUnitMs: Math.max(previous.maxUnitMs, maxUnitMs), units: previous.units + units })
    },
    result: () => Object.fromEntries(phases),
  }
}

async function serviceChild() {
  // This mode is only the controller's IPC child, never an installable entry.
  if (!process.connected) throw new Error('benchmark service requires its owning IPC controller')
  const configPath = arg('project'), dataRoot = arg('data-root')
  if (!configPath || !dataRoot || !path.isAbsolute(configPath) || !path.isAbsolute(dataRoot)) throw new TypeError('absolute fixture paths required')
  const loadProject = () => resolveProjectConfig({ argv: [`--project=${configPath}`], cwd: path.dirname(configPath), env: process.env, writeLocalState: false })
  const scenario = arg('scenario') ?? 'publication'
  const driver = scenario === 'publication' ? null : createTransitionDriver({ loadProject, dataRoot, fixtureRoot: arg('fixture-root'), scenario, onPhase: phase => send({ type: 'phase', ...phase }) })
  const histogram = monitorEventLoopDelay({ resolution: 10 })
  histogram.enable()
  const timing = (phase, operation) => input => {
    const startedMs = epochMs()
    try { return operation(input) } finally { send({ type: 'phase', phase, startedMs, endedMs: epochMs() }) }
  }
  const cooperativeTiming = (phase, operation) => async input => {
    const startedMs = epochMs(), bursts = summaryBursts()
    try { return await operation({ ...input, scheduling: { ...input.scheduling, onBurst: value => bursts.record(value) } }) }
    finally { send({ type: 'phase', phase, scopeId: input.scope?.scopeId ?? input.recoveryStore?.scopeId, startedMs, endedMs: epochMs(), bursts: bursts.result() }) }
  }
  let tick = 0, service = null, engineRef = null, transitioning = false, stopRequested = false
  const stop = async () => { stopRequested = true; if (service) await service.shutdown('benchmark-owner-stop') }
  process.on('message', async message => {
    if (message?.type === 'stop') void stop()
    if (message?.type === 'transition' && driver && engineRef && !transitioning) {
      transitioning = true
      try { await sendTerminal({ type: 'transition', ...(await driver.run(engineRef)) }) }
      catch (error) { send({ type: 'transition-error', code: error.code ?? error.name, message: String(error.message) }); process.exitCode = 1; await stop() }
    }
  })
  process.on('disconnect', () => { void stop() })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void stop() })
  try {
    service = await runMaintenanceService({
      loadProject, dataRoot, entryPath: entry, intervalMs: 60 * 60 * 1000,
      ...(driver ? { clock: driver.clock } : {}),
      adapterFactory: () => createEditorAdapter({ call: async () => { throw new Error('no app in a synthetic benchmark') }, processProbe: () => 'absent', kind: 'absent' }),
      log(event) { if (event.event === 'started') send({ type: 'listening', atMs: epochMs(), runtimeId: event.runtimeId, pid: event.pid }) },
      engineOptions: {
        ...(driver ? { extensions: driver.extensions } : {}),
        quietPeriodMs: 0, watcherFactory: createNullWatcherFactory(),
        seams: { onPhase: phase => send({ type: 'phase', ...phase }), buildGraph: timing('build-graph', buildGraph), captureSnapshot: timing('capture-snapshot', captureSnapshot), prepareViewCooperatively: cooperativeTiming('prepare', prepareViewCooperatively), publishView: cooperativeTiming('publish', publishView) },
      },
      createEngine(options) {
        const engine = createMaintenanceEngine(options)
        engineRef = engine
        return { ...engine, async tick() {
          const startedMs = epochMs(), number = ++tick
          try {
            const report = await engine.tick()
            send({ type: 'tick', number, startedMs, endedMs: epochMs(), report: { state: report.state, reason: report.reason ?? null, scopes: (report.scopes ?? []).map(({ scopeId, state, reason, verified }) => ({ scopeId, state, reason, verified })) }, maxEventLoopDelayMs: histogram.max / 1e6 })
            return report
          } catch (error) { send({ type: 'tick-error', number, code: error.code ?? 'untyped-error' }); throw error }
        } }
      },
    })
    if (stopRequested) await stop()
    await service.done
  } finally { histogram.disable() }
}

function groupExists(pid) {
  try { process.kill(process.platform === 'win32' ? pid : -pid, 0); return true }
  catch (error) { if (error.code === 'ESRCH') return false; throw error }
}
async function endOwnedChild(child, terminal) {
  if (terminal.value === null && child.connected) child.send({ type: 'stop' })
  let until = Date.now() + 5000
  while (terminal.value === null && Date.now() < until) await sleep(25)
  const signals = []
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    if (!groupExists(child.pid)) break
    signals.push(signal)
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error }
    until = Date.now() + 5000
    while (groupExists(child.pid) && Date.now() < until) await sleep(25)
  }
  return { pid: child.pid, groupId: process.platform === 'win32' ? null : child.pid, terminal: terminal.value, signals, groupAbsent: !groupExists(child.pid) }
}
function sourcePin() {
  const git = args => childProcess.execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
  const paths = ['src/projection/obsidian/materialize/prepare-view.mjs', 'src/projection/obsidian/publication/publisher.mjs', 'src/runtime/obsidian/engine.mjs', 'src/runtime/obsidian/pipeline.mjs', 'src/runtime/obsidian/service.mjs', 'test/helpers/obsidian-event-loop-corpus.mjs', 'scripts/obsidian/benchmark-event-loop.mjs', 'package-lock.json']
  return { head: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']), dirty: git(['status', '--porcelain']).length > 0, files: paths.map(relative => ({ path: relative, sha256: createHash('sha256').update(fs.readFileSync(path.join(repository, relative))).digest('hex') })) }
}

async function controller() {
  const notes = integer('notes', 32, 1, 10000), scopes = integer('scopes', 1, 1, 6)
  const timeoutMs = integer('timeout-ms', 30000, 1000, 30 * 60 * 1000)
  const output = arg('output')
  const scenario = arg('scenario') ?? 'publication'
  if (scenario !== 'publication' && !TRANSITION_SCENARIOS.includes(scenario)) throw new TypeError('unknown transition scenario')
  if (scenario === 'observe-16' && notes < 17) throw new TypeError('observe-16 needs at least17 invented notes')
  if (output && fs.existsSync(output)) throw new Error('measurement output already exists; preserve it and choose a fresh result path')
  const result = { kind: 'production-service-event-loop-measurement', scenario, node: process.version, notes, scopes, source: sourcePin(), status: 'failed', events: [], probes: [], cleanup: null }
  let corpus = null, child = null, probeLoop = null, probing = true, interrupted = false
  const terminal = { value: null }, startedMs = epochMs()
  const interrupt = () => { interrupted = true }
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, interrupt)
  try {
    corpus = createEventLoopCorpus({ notes, scopes })
    if (scenario !== 'publication') initializeTransitionRepositories(corpus)
    result.corpusDigest = corpus.digest
    result.scopeDefinitions = corpus.manifest.scopes
    // Reserved as the service test suites reserve theirs, and held until this controller exits: a port found by
    // listening on port 0 and closing again could be handed to anything else before the child listens on it.
    const { reservePort } = await import('../../test/helpers/loopback-port.mjs')
    const port = await reservePort(null), at = new Date().toISOString()
    writeServiceSettings({ workspaceRoot: corpus.workspaceRoot, workspaceId: corpus.workspaceId, settings: { schema: 'atelier-obsidian-service-settings/v1', workspaceId: corpus.workspaceId, host: '127.0.0.1', port, consent: { actor: 'synthetic-benchmark', coverage: 'service', grantedAt: at }, updatedAt: at } })
    probeLoop = (async () => {
      while (probing) {
        const fromMs = epochMs()
        const answer = await probeHealth({ host: '127.0.0.1', port, timeoutMs: 5000 })
        result.probes.push({ startedMs: fromMs, endedMs: epochMs(), kind: answer.kind, ...(answer.kind === 'health' ? { runtimeId: answer.body.runtimeId, pid: answer.body.pid, workspaceId: answer.body.workspaceId, serviceName: answer.body.serviceName, executableDigest: answer.body.executableDigest } : {}) })
        if (probing) await sleep(25)
      }
    })()
    child = childProcess.spawn(process.execPath, [entry, '--service', `--project=${corpus.configPath}`, `--data-root=${corpus.dataRoot}`, `--scenario=${scenario}`, `--fixture-root=${corpus.directory}`], { env: corpus.env, detached: process.platform !== 'win32', shell: false, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    let stderr = ''
    child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-4096) })
    child.on('message', message => { result.events.push(message) })
    child.once('exit', (code, signal) => { terminal.value = { code, signal } })
    child.once('error', error => { terminal.value = { code: null, signal: null, error: error.code ?? 'spawn-error' } })
    while (!result.events.some(event => event.type === 'tick' || event.type === 'tick-error') && terminal.value === null && epochMs() - startedMs < timeoutMs && !interrupted) await sleep(25)
    if (interrupted) throw Object.assign(new Error('controller interrupted; owned child cleanup follows'), { code: 'ABORT_ERR' })
    if (terminal.value !== null) throw new Error(`service ended before qualification: ${JSON.stringify(terminal.value)}; ${stderr}`)
    const tick = result.events.find(event => event.type === 'tick')
    assert.ok(tick, 'first tick must complete before the finite timeout')
    assert.equal(tick.report.state, 'ticked')
    assert.equal(tick.report.scopes.length, scopes)
    for (const scope of tick.report.scopes) assert.deepEqual([scope.state, scope.verified], ['current', true], JSON.stringify(scope))
    // Keep probing through the completed tick and validate every answer against
    // the actual service record identity, never merely a successful HTTP code.
    const listening = result.events.find(event => event.type === 'listening')
    assert.ok(listening)
    await sleep(50)
    // A request may start while the listener writes its record, then remain
    // in flight across the first tick. That matching health response covers
    // the leading edge too; do not discard it merely for starting earlier.
    const during = result.probes.filter(probe => probe.startedMs <= tick.endedMs
      && (probe.startedMs >= listening.atMs || (probe.kind === 'health' && probe.endedMs >= tick.startedMs)))
    assert.ok(during.length > 0, 'separate controller must observe health during the first publication')
    const identity = { runtimeId: listening.runtimeId, pid: child.pid, workspaceId: corpus.workspaceId }
    const record = readServiceRecord({ workspaceRoot: corpus.workspaceRoot, workspaceId: corpus.workspaceId })
    assert.ok(record)
    for (const probe of during) {
      assert.equal(probe.kind, 'health', `health answered ${probe.kind}`)
      assert.equal(probe.runtimeId, identity.runtimeId)
      assert.equal(probe.pid, identity.pid)
      assert.equal(probe.workspaceId, identity.workspaceId)
      assert.equal(probe.serviceName, record.serviceName)
      assert.equal(probe.executableDigest, record.executable.digest)
      assert.ok(probe.endedMs - probe.startedMs < 5000, 'health must answer in under five seconds')
    }
    const firstProbeLagMs = Math.max(0, during[0].startedMs - tick.startedMs)
    const lastProbeLagMs = Math.max(0, tick.endedMs - during.at(-1).endedMs)
    assert.ok(firstProbeLagMs < 250 && lastProbeLagMs < 250, 'health sampling must cover both edges of the first tick within 250ms')
    result.health = { identity, probesDuringFirstTick: during.length, maxResponseMs: Math.max(...during.map(probe => probe.endedMs - probe.startedMs)), firstTickMs: tick.endedMs - tick.startedMs, firstProbeLagMs, lastProbeLagMs }
    // Check committed counts and plugin installation from actual durable state.
    result.publications = corpus.manifest.scopes.map(({ scopeId }) => {
      const directory = path.join(corpus.workspaceRoot, 'state', 'manifests', scopeId)
      const pointer = JSON.parse(fs.readFileSync(path.join(directory, 'current.json')))
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, pointer.manifestFile)))
      assert.equal(manifest.notes.length, notes)
      assert.equal(manifest.completeness.status, 'complete')
      const store = createRecoveryStore({ workspaceRoot: corpus.workspaceRoot, workspaceId: corpus.workspaceId, scopeId, repositoryRoots: protectedRoots(corpus.loadProject()) })
      const plugin = path.join(store.vaultRoot, PLUGIN_DIRECTORY, 'main.js')
      assert.ok(fs.existsSync(plugin), 'actual service publication carries its plugin')
      const pluginBytes = fs.readFileSync(plugin)
      assert.deepEqual(pluginBytes, fs.readFileSync(path.join(repository, 'plugins', 'obsidian', 'main.js')))
      return { scopeId, generationId: pointer.generationId, notes: manifest.notes.length, manifestSha256: createHash('sha256').update(fs.readFileSync(path.join(directory, pointer.manifestFile))).digest('hex'), pluginPresent: true, pluginSha256: createHash('sha256').update(pluginBytes).digest('hex') }
    })
    if (scenario !== 'publication') {
      child.send({ type: 'transition' })
      while (!result.events.some(event => event.type === 'transition' || event.type === 'transition-error') && terminal.value === null && epochMs() - startedMs < timeoutMs && !interrupted) await sleep(25)
      const transition = result.events.find(event => event.type === 'transition')
      assert.ok(transition, JSON.stringify(result.events.find(event => event.type === 'transition-error') ?? { finiteTimeout: true, interrupted, terminal: terminal.value }))
      assert.ok(transition.typedAndByteOraclesPassed && transition.fsOpenRestored)
      await sleep(50)
      // Transition coverage includes any result, even an invalid or timed-out
      // answer; none may be filtered away by its response kind.
      const window = result.probes.filter(probe => probe.startedMs <= transition.endedMs && probe.endedMs >= transition.startedMs)
      assert.ok(window.length > 0)
      for (const probe of window) {
        assert.equal(probe.kind, 'health')
        for (const key of ['runtimeId', 'pid', 'workspaceId']) assert.equal(probe[key], identity[key])
        assert.equal(probe.serviceName, record.serviceName)
        assert.equal(probe.executableDigest, record.executable.digest)
        assert.ok(probe.endedMs - probe.startedMs < 5000)
      }
      const firstLagMs = Math.max(0, window[0].startedMs - transition.startedMs), lastLagMs = Math.max(0, transition.endedMs - window.at(-1).endedMs)
      assert.ok(firstLagMs < 250 && lastLagMs < 250)
      result.transitionHealth = { identity, probes: window.length, maxResponseMs: Math.max(...window.map(probe => probe.endedMs - probe.startedMs)), firstLagMs, lastLagMs }
      result.transition = transition
    }
    result.status = 'passed'
  } catch (error) { result.failure = { code: error.code ?? error.name, message: String(error.message) } }
  finally {
    if (child?.pid) result.cleanup = await endOwnedChild(child, terminal)
    probing = false
    if (probeLoop) await probeLoop
    if (child && (!result.cleanup?.groupAbsent || result.cleanup?.terminal?.code !== 0)) result.status = 'failed'
    if (!child || result.cleanup?.groupAbsent) {
      corpus?.cleanup()
      result.fixtureRemoved = corpus === null || !fs.existsSync(corpus.directory)
    }
    for (const signal of ['SIGINT', 'SIGTERM']) process.off(signal, interrupt)
    result.elapsedMs = epochMs() - startedMs
  }
  const text = `${JSON.stringify(result, null, 2)}\n`
  if (output) fs.writeFileSync(output, text, { flag: 'wx', mode: 0o600 })
  else process.stdout.write(text)
  process.exitCode = result.status === 'passed' ? 0 : 1
}

// A separate small functional oracle. It uses real engines/operations and
// owned IPC children, but starts no HTTP service or health sampler and makes
// no responsive-service claim. Large/probe qualification uses controller().
async function fixtureCheckChild() {
  if (!process.connected) throw new Error('fixture check requires its owning IPC parent')
  const scenario = arg('fixture-check-child'), configPath = arg('project'), dataRoot = arg('data-root')
  const loadProject = () => resolveProjectConfig({ argv: [`--project=${configPath}`], cwd: path.dirname(configPath), env: process.env, writeLocalState: false })
  const driver = createTransitionDriver({ loadProject, dataRoot, fixtureRoot: arg('fixture-root'), scenario })
  const engine = createMaintenanceEngine({ loadProject, dataRoot, clock: driver.clock, extensions: driver.extensions, quietPeriodMs: 0, watcherFactory: createNullWatcherFactory(),
    adapterFactory: () => createEditorAdapter({ call: async () => { throw new Error('no app in a fixture check') }, processProbe: () => 'absent', kind: 'absent' }) })
  try {
    const first = await engine.tick()
    assert.equal(first.state, 'ticked')
    assert.ok(first.scopes.every(scope => scope.state === 'current' && scope.verified))
    await sendTerminal({ type: 'fixture-check', ...(await driver.run(engine)), responsiveServiceQualified: false })
  } finally { engine.stop() }
}

async function fixtureCheckController() {
  const selected = arg('fixture-check'), scenarios = selected === 'all' ? TRANSITION_SCENARIOS : [selected]
  assert.ok(scenarios.every(value => TRANSITION_SCENARIOS.includes(value)))
  const notes = integer('notes', 18, 17, 32), output = arg('output')
  if (output && fs.existsSync(output)) throw new Error('fixture result already exists')
  const result = { kind: 'small-transition-functional-oracle', node: process.version, notes, scopes: 1, source: sourcePin(), status: 'failed', cases: [], responsiveServiceQualified: false }
  let interrupted = false
  const interrupt = () => { interrupted = true }
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, interrupt)
  try {
    for (const scenario of scenarios) {
      let corpus = null, child = null
      const terminal = { value: null }, item = { scenario, status: 'failed', events: [] }, startedMs = epochMs()
      result.cases.push(item)
      try {
        corpus = createEventLoopCorpus({ notes, scopes: 1 })
        initializeTransitionRepositories(corpus)
        child = childProcess.spawn(process.execPath, [entry, `--fixture-check-child=${scenario}`, `--project=${corpus.configPath}`, `--data-root=${corpus.dataRoot}`, `--fixture-root=${corpus.directory}`], { env: corpus.env, detached: process.platform !== 'win32', shell: false, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
        let stderr = ''
        child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-8192) })
        child.on('message', event => item.events.push(event))
        child.once('exit', (code, signal) => { terminal.value = { code, signal } })
        child.once('error', error => { terminal.value = { code: null, signal: null, error: error.code ?? 'spawn-error' } })
        while (terminal.value === null && epochMs() - startedMs < 40000 && !interrupted) await sleep(25)
        assert.ok(!interrupted && terminal.value?.code === 0 && terminal.value?.signal === null, JSON.stringify({ terminal: terminal.value, stderr, interrupted }))
        assert.ok(item.events.find(event => event.type === 'fixture-check')?.typedAndByteOraclesPassed)
        item.status = 'passed'
      } catch (error) { item.failure = { code: error.code ?? error.name, message: String(error.message) } }
      finally {
        if (child?.pid) item.cleanup = await endOwnedChild(child, terminal)
        if (!child || item.cleanup?.groupAbsent) { corpus?.cleanup(); item.fixtureRemoved = corpus === null || !fs.existsSync(corpus.directory) }
        if (!item.cleanup?.groupAbsent || item.cleanup?.terminal?.code !== 0) item.status = 'failed'
        item.elapsedMs = epochMs() - startedMs
      }
      assert.equal(item.status, 'passed', JSON.stringify(item.failure))
    }
    result.status = 'passed'
  } catch (error) { result.failure = { code: error.code ?? error.name, message: String(error.message) } }
  finally { for (const signal of ['SIGINT', 'SIGTERM']) process.off(signal, interrupt) }
  const text = `${JSON.stringify(result, null, 2)}\n`
  if (output) fs.writeFileSync(output, text, { flag: 'wx', mode: 0o600 }); else process.stdout.write(text)
  process.exitCode = result.status === 'passed' ? 0 : 1
}

if (arg('fixture-check-child')) {
  try { await fixtureCheckChild() } catch (error) { send({ type: 'fixture-error', code: error.code ?? error.name, message: String(error.message) }); process.exitCode = 1 }
  finally { if (process.connected) process.disconnect() }
} else if (arg('fixture-check')) await fixtureCheckController()
else if (process.argv.includes('--service')) {
  try { await serviceChild() } catch (error) { send({ type: 'service-error', code: error.code ?? error.name }); process.exitCode = 1 }
  finally { if (process.connected) process.disconnect() }
} else await controller()
