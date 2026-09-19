// Calls one `tick` again and again, never two at a time.
//
// The next tick is scheduled only when the previous one has settled, so ticks
// cannot overlap however long one takes. A tick that throws does not end the
// loop and does not change the next tick: the error is handed to `onOutcome`,
// and the delay before the next attempt doubles per consecutive failure up to
// a ceiling, so a disk that stays full is retried slowly instead of in a tight
// loop. One success returns the loop to its interval.
//
// `tickNow()` asks for a tick that starts after the request: while a tick is
// in flight the request is answered by one follow-up tick, shared by everyone
// who asked meanwhile.

export const DEFAULT_TICK_INTERVAL_MS = 30 * 1000
export const DEFAULT_MAX_BACKOFF_MS = 15 * 60 * 1000

export const TICK_LOOP_PRIMITIVES = Object.freeze({
  // Whether the loop goes on after a tick threw.
  continuesAfterError: () => true,
  delayAfter: ({ intervalMs, maxBackoffMs, consecutiveFailures }) => (consecutiveFailures === 0 ? intervalMs : Math.min(maxBackoffMs, intervalMs * 2 ** Math.min(consecutiveFailures, 20))),
})

export function createTickLoopForOracleTests({ tick, intervalMs = DEFAULT_TICK_INTERVAL_MS, maxBackoffMs = DEFAULT_MAX_BACKOFF_MS, setTimer = setTimeout, clearTimer = clearTimeout, onOutcome = () => {} }, primitives = TICK_LOOP_PRIMITIVES) {
  if (typeof tick !== 'function') throw new TypeError('the tick loop needs a tick')
  if (!Number.isInteger(intervalMs) || intervalMs < 1 || !Number.isInteger(maxBackoffMs) || maxBackoffMs < intervalMs) throw new TypeError('the tick loop needs a positive interval and a backoff ceiling no smaller than it')
  const rules = { ...TICK_LOOP_PRIMITIVES, ...primitives }
  let timer = null
  let inFlight = null
  let followUp = null // { promise, resolve } while somebody waits for a tick that starts after now
  let started = false
  let stopped = false
  let consecutiveFailures = 0
  let ticks = 0

  function schedule() {
    if (stopped || !started || timer !== null) return
    timer = setTimer(() => { timer = null; void run() }, rules.delayAfter({ intervalMs, maxBackoffMs, consecutiveFailures }))
  }

  async function once() {
    let outcome
    try { outcome = { ok: true, report: await tick() } } catch (error) { outcome = { ok: false, error } }
    ticks += 1
    consecutiveFailures = outcome.ok ? 0 : consecutiveFailures + 1
    try { await onOutcome({ ...outcome, consecutiveFailures }) } catch { /* recording an outcome never ends the loop */ }
    if (!outcome.ok && !rules.continuesAfterError()) stopped = true
    return outcome
  }

  function run() {
    if (stopped) return Promise.resolve({ ok: false, stopped: true })
    if (inFlight) return inFlight
    if (timer !== null) { clearTimer(timer); timer = null }
    inFlight = once().finally(() => {
      inFlight = null
      const waiting = followUp
      followUp = null
      if (waiting) run().then(waiting.resolve)
      else schedule()
    })
    return inFlight
  }

  return {
    start() { if (!started && !stopped) { started = true; void run() } },
    tickNow() {
      if (stopped) return Promise.resolve({ ok: false, stopped: true })
      if (!inFlight) return run()
      if (!followUp) { let resolve; const promise = new Promise((settle) => { resolve = settle }); followUp = { promise, resolve } }
      return followUp.promise
    },
    // Lets the tick in flight finish; starts no other.
    async stop() {
      stopped = true
      if (timer !== null) { clearTimer(timer); timer = null }
      if (inFlight) await inFlight.catch(() => {})
    },
    state: () => ({ started, stopped, ticking: inFlight !== null, ticks, consecutiveFailures, nextDelayMs: rules.delayAfter({ intervalMs, maxBackoffMs, consecutiveFailures }) }),
  }
}

export function createTickLoop(options) {
  return createTickLoopForOracleTests(options, TICK_LOOP_PRIMITIVES)
}
