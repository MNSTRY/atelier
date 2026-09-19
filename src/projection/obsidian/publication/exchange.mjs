import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// Atomic exchange of two paths on one volume. After a successful call each
// path names the file the other path named before it; a failed call changes
// nothing. This is the only primitive the publisher uses to put generated
// bytes at an editable path, because whatever occupied that path at the
// instant of the call is kept, under the other name, instead of destroyed.
//
// The call is reached through the system perl as a raw syscall: no perl
// module, no compiler and no package dependency.
//   macOS: renameatx_np(AT_FDCWD, from, AT_FDCWD, to, RENAME_SWAP)
//   Linux: renameat2(AT_FDCWD, from, AT_FDCWD, to, RENAME_EXCHANGE)
// Link-then-rename is not a substitute and is not offered. Where the exchange
// is unavailable the caller refuses and publishes nothing.

export const EXCHANGE_CONSTANTS = Object.freeze({
  perlCandidates: Object.freeze(['/usr/bin/perl', '/bin/perl', '/usr/local/bin/perl']),
  // argv: syscall number, AT_FDCWD, from, to. The exit status is errno.
  script: 'my ($n,$d,$from,$to)=@ARGV; my $r = syscall($n+0, $d+0, $from, $d+0, $to, 2); exit($r == 0 ? 0 : ($!+0 || 1));',
  calls: Object.freeze({
    'darwin/arm64': Object.freeze({ number: 488, cwd: -2 }),
    'darwin/x64': Object.freeze({ number: 488, cwd: -2 }),
    'linux/x64': Object.freeze({ number: 316, cwd: -100 }),
    'linux/arm64': Object.freeze({ number: 276, cwd: -100 }),
  }),
})

export class ExchangeRefusal extends Error {
  constructor(code, message, detail = {}) {
    super(`${code}: ${message}`)
    this.name = 'ExchangeRefusal'
    this.code = code
    this.detail = detail
  }
}

export function resolveExchange({ platform = process.platform, arch = process.arch, perlPath, existsSync = fs.existsSync } = {}) {
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new ExchangeRefusal('exchange-unsupported-platform', 'no atomic exchange is known for this platform; nothing is published', { platform })
  }
  const call = EXCHANGE_CONSTANTS.calls[`${platform}/${arch}`]
  if (!call) throw new ExchangeRefusal('exchange-unsupported-architecture', 'the exchange syscall number is not known for this architecture', { platform, arch })
  const perl = perlPath ?? EXCHANGE_CONSTANTS.perlCandidates.find((candidate) => existsSync(candidate))
  if (!perl || !existsSync(perl)) throw new ExchangeRefusal('exchange-interpreter-missing', 'the system perl used to reach the exchange syscall is absent', { platform })
  return { perl, number: call.number, cwd: call.cwd }
}

export function exchangeFiles(from, to, options = {}) {
  if (!path.isAbsolute(from) || !path.isAbsolute(to)) throw new TypeError('exchangeFiles needs absolute paths')
  const { perl, number, cwd } = resolveExchange(options)
  try {
    execFileSync(perl, ['-e', EXCHANGE_CONSTANTS.script, '--', String(number), String(cwd), from, to], { stdio: 'ignore' })
  } catch (error) {
    throw new ExchangeRefusal('exchange-failed', 'the atomic exchange did not happen; nothing changed', { exitStatus: error.status ?? null })
  }
}

const probed = new Map()

export function resetExchangeProbeCache() {
  probed.clear()
}

// Self-test on two scratch files inside `directory`, which must be on the
// volume that holds the vault. The verdict is cached per volume. A refusal is
// returned, not thrown: { supported: false, code, message }.
export function probeExchange({ directory, ...options } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new TypeError('probeExchange needs an absolute directory')
  let key
  try {
    key = `${options.platform ?? process.platform}/${options.arch ?? process.arch}/${options.perlPath ?? ''}/${fs.statSync(directory).dev}`
  } catch (error) {
    return { supported: false, code: 'exchange-probe-failed', message: `the staging area cannot be read: ${error.code ?? error.message}` }
  }
  if (probed.has(key)) return probed.get(key)
  const id = randomUUID()
  const first = path.join(directory, `.atelier-exchange-probe-${id}.a`)
  const second = path.join(directory, `.atelier-exchange-probe-${id}.b`)
  let verdict
  try {
    const resolved = resolveExchange(options)
    fs.writeFileSync(first, 'a', { flag: 'wx', mode: 0o600 })
    fs.writeFileSync(second, 'b', { flag: 'wx', mode: 0o600 })
    exchangeFiles(first, second, options)
    if (fs.readFileSync(first, 'utf8') !== 'b' || fs.readFileSync(second, 'utf8') !== 'a') {
      throw new ExchangeRefusal('exchange-unsupported-filesystem', 'the exchange call returned success without exchanging the files')
    }
    verdict = { supported: true, perl: resolved.perl }
  } catch (error) {
    if (!(error instanceof ExchangeRefusal)) {
      // A scratch file could not even be written (for example a full disk). That says nothing durable about the volume.
      return { supported: false, code: 'exchange-probe-failed', message: `the exchange self-test could not run: ${error.code ?? error.message}` }
    }
    const code = error.code === 'exchange-failed' ? 'exchange-unsupported-filesystem' : error.code
    verdict = { supported: false, code, message: error.message, detail: error.detail }
  } finally {
    for (const file of [first, second]) fs.rmSync(file, { force: true })
  }
  probed.set(key, verdict)
  return verdict
}
