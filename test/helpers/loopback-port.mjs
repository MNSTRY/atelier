import childProcess from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

// Loopback ports for tests that start a service on a port they choose, or need one that nobody listens on.
//
// A port found by listening on port 0 and closing again goes back to the system at once. Anything on this host that
// asks for port 0 next (another test file under `node --test`, another suite, an outgoing connection) can be handed it
// before the service listens there, and the service then refuses, correctly, with `service-port-occupied`.
//
// `reservePort` leaves no such gap. It chooses a port outside the range the system hands to port-0 binders, so nothing
// that asks for port 0 is ever given it. It also claims the port in a folder that every process using this helper
// shares, so no other test reserves the same port while this test holds it. Claims are shared per temp folder
// (TMPDIR) and per user: suites of one user that run with the same TMPDIR see each other's claims, and suites with
// another TMPDIR are kept apart only by the random choice among some 29,000 ports. The claim lasts until the test ends,
// which covers services that are stopped and started again on the same port. Nothing is retried: a service that still
// finds its reserved port occupied has a real occupant, and the test fails.
//
// A test that occupies a port on purpose (a foreign or silent listener) listens on port 0 itself and keeps the socket.
// It never probes and closes first.

// One folder per user, which only that user may write in; where the system has no user IDs (Windows), the temp folder
// is the user's own already.
export const RESERVATIONS = path.join(os.tmpdir(), typeof process.getuid === 'function' ? `mnstry-atelier-test-ports-${process.getuid()}` : 'mnstry-atelier-test-ports')
const LOWEST = 20000
const HIGHEST = 65535

let range = null
// The ports this system hands out for port 0 and for outgoing connections: { first, last, source }.
export function ephemeralRange() {
  if (range !== null) return range
  const read = (first, last, source) => (Number.isInteger(first) && Number.isInteger(last) && first > 0 && first <= last ? { first, last, source } : null)
  try {
    if (process.platform === 'linux') {
      const [first, last] = fs.readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/).map(Number)
      range = read(first, last, 'ip_local_port_range')
    } else if (process.platform === 'darwin') {
      const names = ['net.inet.ip.portrange.first', 'net.inet.ip.portrange.last', 'net.inet.ip.portrange.hifirst', 'net.inet.ip.portrange.hilast']
      const [first, last, hifirst, hilast] = childProcess.execFileSync('/usr/sbin/sysctl', ['-n', ...names], { encoding: 'utf8', windowsHide: true }).trim().split(/\s+/).map(Number)
      range = read(Math.min(first, hifirst), Math.max(last, hilast), 'sysctl portrange')
    }
  } catch { range = null }
  // Windows, and any system that could not be asked: the IANA dynamic range, the default on Windows and macOS.
  range ??= { first: 49152, last: 65535, source: 'default' }
  return range
}

// Asked once, when the helper is loaded: before a test patches node:child_process to count what it starts.
ephemeralRange()

export const isEphemeral = (port) => port >= ephemeralRange().first && port <= ephemeralRange().last

let pool = null
function candidates() {
  if (pool !== null) return pool
  const { first, last } = ephemeralRange()
  const ports = []
  for (let port = LOWEST; port <= HIGHEST; port += 1) if (port < first || port > last) ports.push(port)
  if (ports.length < 1000) throw new Error(`this system hands out almost every port for port 0 (${first}-${last}): a port no test takes cannot be reserved`)
  pool = ports
  return pool
}

const isAlive = (pid) => { try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' } }
const CLAIM = /^(\d+)\.(\d+)$/

// A test process killed by a signal never runs its exit hook, and its claims stay. They are swept when the helper
// loads, in one read of the folder; a claim whose PID is somebody else's by now is left, and costs one port.
function sweep() {
  let names
  try { names = fs.readdirSync(RESERVATIONS) } catch { return }
  for (const name of names) {
    const pid = Number(CLAIM.exec(name)?.[2])
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && !isAlive(pid)) fs.rmSync(path.join(RESERVATIONS, name), { force: true })
  }
}
sweep()

// One file per claim, `<port>.<pid>`, so no claim ever removes another. A port is this process's only while no other
// live process has a claim on it. Two claims made at the same moment both give way, and the port is simply not used.
const held = new Set()
function claim(port) {
  if (held.has(port)) return false
  fs.mkdirSync(RESERVATIONS, { recursive: true, mode: 0o700 })
  const mine = path.join(RESERVATIONS, `${port}.${process.pid}`)
  fs.writeFileSync(mine, '')
  const others = fs.readdirSync(RESERVATIONS).filter((name) => name.startsWith(`${port}.`) && name !== `${port}.${process.pid}`)
  for (const other of others) {
    const pid = Number(other.slice(String(port).length + 1))
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) { fs.rmSync(mine, { force: true }); return false }
    // A claim left by a process that is gone.
    fs.rmSync(path.join(RESERVATIONS, other), { force: true })
  }
  held.add(port)
  return true
}

// Gives a reservation up before its test ends.
export function releaseReservation(port) {
  if (!held.delete(port)) return
  fs.rmSync(path.join(RESERVATIONS, `${port}.${process.pid}`), { force: true })
}
process.once('exit', () => { for (const port of [...held]) releaseReservation(port) })

// Whether the service could listen on the port now (the same listen it makes, on 127.0.0.1) and nothing answers a
// connection to 127.0.0.1 there. The listen alone is not proof: where the system lets a listener on 0.0.0.0 or :: share
// the port (macOS), the listen succeeds and that listener still answers.
function bindable(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolve(true)))
  })
}
function refused(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const settle = (value) => { clearTimeout(timer); socket.destroy(); resolve(value) }
    const timer = setTimeout(() => settle(false), 2000)
    socket.once('connect', () => settle(false))
    socket.once('error', (error) => settle(error.code === 'ECONNREFUSED'))
  })
}
const listenable = async (port) => await bindable(port) && await refused(port)

// A loopback port that nothing listens on now and that nothing but this test takes until the test ends. `t` is the
// test (its `after` releases the port); without it, the port is held until this process exits. `choose` is a seam for
// the tests of this helper: it returns the ports to try, in order.
export async function reservePort(t, { choose = null } = {}) {
  const ports = choose === null ? candidates() : choose()
  for (let attempt = 0; attempt < Math.min(ports.length, 200); attempt += 1) {
    const port = choose === null ? ports[Math.floor(Math.random() * ports.length)] : ports[attempt]
    if (!claim(port)) continue
    if (!await listenable(port)) { releaseReservation(port); continue }
    t?.after(() => releaseReservation(port))
    return port
  }
  throw new Error('no loopback port could be reserved')
}

// A workspace's first start picks its port the way the tests used to: it listens on port 0, closes the socket and
// records the port, and the service listens there later (#102). A test's start therefore names its reserved port while
// the workspace records none. A recorded port is left alone: naming another would replace it. `recorded()` says
// whether the workspace records a port now; it is asked each time the start reads its options.
export const firstStartPort = (port, recorded) => (recorded() ? {} : { port })

// The command's seams with the reserved port added to `service`, the options the command passes to its start, while
// the workspace records no port. Read when the command reads them, which is just before it starts the service.
export function withFirstStartPort(seams, port, recorded) {
  if (seams === null || typeof seams !== 'object' || seams.service === undefined) return seams
  const { service, ...rest } = seams
  return Object.defineProperty(rest, 'service', { enumerable: true, get: () => ({ ...service, ...firstStartPort(port, recorded) }) })
}
