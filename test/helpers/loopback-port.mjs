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
// shares, so no other test, in this suite or another one on this host, reserves the same port while this test holds
// it. The claim lasts until the test ends, which covers services that are stopped and started again on the same port.
// Nothing is retried: a service that still finds its reserved port occupied has a real occupant, and the test fails.
//
// A test that occupies a port on purpose (a foreign or silent listener) listens on port 0 itself and keeps the socket.
// It never probes and closes first.

export const RESERVATIONS = path.join(os.tmpdir(), 'mnstry-atelier-test-ports')
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

// One file per claim, `<port>.<pid>`, so no claim ever removes another. A port is this process's only while no other
// live process has a claim on it. Two claims made at the same moment both give way, and the port is simply not used.
const held = new Set()
function claim(port) {
  if (held.has(port)) return false
  fs.mkdirSync(RESERVATIONS, { recursive: true })
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

// Whether the service could listen on the port now: the same listen it makes, on 127.0.0.1.
function listenable(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolve(true)))
  })
}

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
