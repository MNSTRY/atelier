import { performance } from 'node:perf_hooks'

// AP-04 measurement helpers: percentiles, warm-change summaries, resource
// sampling and timing. Pure functions of their inputs except the samplers,
// which read this process's own counters through an injectable reader.

// The targets ACCEPTANCE.md proposes for AP-04. The app usability budget is
// deliberately absent: it is set from G00 and reference-host measurements
// before G16 closes, and nothing here substitutes a number for it.
export const PROPOSED_TARGETS = Object.freeze({
  fileUpdate: Object.freeze({ p95Ms: 5000, source: 'ACCEPTANCE.md AP-04 proposed file-update target' }),
  droppedEventRecovery: Object.freeze({ maxMs: 60000, source: 'ACCEPTANCE.md AP-04 proposed dropped-event recovery target' }),
  appUsableOpen: Object.freeze({ budgetMs: null, reason: 'set from G00 and reference-host measurements before closing G16; no app latency target is substituted here' }),
  sourceToApp: Object.freeze({ p95Ms: null, reason: 'measured and recorded independently of the file target; no target is substituted' }),
})

// Nearest-rank percentile: sort ascending, rank = ceil(p / 100 * n), take the
// value at that rank. Empty input answers null.
export function percentile(values, p) {
  const numbers = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((left, right) => left - right)
  if (numbers.length === 0) return null
  if (p <= 0) return numbers[0]
  const rank = Math.min(numbers.length, Math.ceil((p / 100) * numbers.length))
  return numbers[rank - 1]
}

function series(values, targetP95Ms) {
  const numbers = values.filter((value) => typeof value === 'number' && Number.isFinite(value))
  const p95Ms = percentile(numbers, 95)
  return {
    samples: numbers.length,
    p50Ms: percentile(numbers, 50),
    p95Ms,
    maxMs: numbers.length === 0 ? null : Math.max(...numbers),
    targetP95Ms,
    withinTarget: p95Ms === null || targetP95Ms === null ? null : p95Ms <= targetP95Ms,
    status: numbers.length === 0 ? 'not-measured' : 'measured',
  }
}

// Thirty warm single-note changes: each sample carries the time from the
// source edit to the vault file holding the candidate bytes, and separately
// the time from the same edit to the app reading those bytes. The two are
// summarized independently; an absent app measurement stays absent.
export function warmChangeSummary(samples, { targets = PROPOSED_TARGETS, expectedSamples = 30 } = {}) {
  const list = Array.isArray(samples) ? samples : []
  return {
    expectedSamples,
    count: list.length,
    complete: list.length >= expectedSamples,
    sourceToFile: series(list.map((sample) => sample?.sourceToFileMs), targets.fileUpdate.p95Ms),
    sourceToApp: series(list.map((sample) => sample?.sourceToAppMs), targets.sourceToApp.p95Ms),
    targets,
  }
}

export function defaultResourceReader() {
  const memory = process.memoryUsage()
  const cpu = process.cpuUsage()
  return { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, cpuUserMicros: cpu.user, cpuSystemMicros: cpu.system }
}

// Samples this process's RSS and CPU counters on an interval. `read` and
// `now` are injectable so the sampler is testable without waiting.
export function createResourceSampler({ intervalMs = 500, read = defaultResourceReader, now = () => performance.now(), setInterval: schedule = globalThis.setInterval, clearInterval: cancel = globalThis.clearInterval } = {}) {
  const samples = []
  const startedAt = now()
  let handle = null
  const take = (label = null) => { samples.push({ atMs: Math.round(now() - startedAt), label, ...read() }); return samples[samples.length - 1] }
  return {
    start() { if (handle === null) { take('start'); handle = schedule(() => take(), intervalMs); if (typeof handle?.unref === 'function') handle.unref() } return this },
    sample: take,
    stop() { if (handle !== null) { cancel(handle); handle = null; take('stop') } return samples },
    get samples() { return samples },
    summary() {
      const rss = samples.map((sample) => sample.rssBytes)
      const last = samples[samples.length - 1]
      const first = samples[0]
      return {
        samples: samples.length,
        intervalMs,
        rssPeakBytes: rss.length ? Math.max(...rss) : null,
        rssEndBytes: last?.rssBytes ?? null,
        cpuUserMicros: last && first ? last.cpuUserMicros - first.cpuUserMicros : null,
        cpuSystemMicros: last && first ? last.cpuSystemMicros - first.cpuSystemMicros : null,
        wallMs: last?.atMs ?? null,
      }
    },
  }
}

// Times a synchronous or asynchronous step and appends it to `timings`.
export async function timed(timings, name, step) {
  const started = performance.now()
  const value = await step()
  timings[name] = Math.round((performance.now() - started) * 1000) / 1000
  return value
}

// Polls `probe` until it answers true or the budget runs out. Answers the
// elapsed time and whether the condition was met; a timeout is recorded, not
// thrown, so a receipt can carry the failure.
export async function waitUntil(probe, { timeoutMs, intervalMs = 250, now = () => performance.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const started = now()
  let attempts = 0
  for (;;) {
    attempts += 1
    let answer = false
    let error = null
    try { answer = await probe() } catch (caught) { error = String(caught?.message ?? caught) }
    const elapsedMs = Math.round(now() - started)
    if (answer === true) return { met: true, elapsedMs, attempts, error: null }
    if (elapsedMs >= timeoutMs) return { met: false, elapsedMs, attempts, error }
    await sleep(intervalMs)
  }
}
