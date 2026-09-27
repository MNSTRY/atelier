import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { executableIdentity } from './service-record.mjs'

// Whether a live PID provably runs the executable a service record names,
// without that process answering anything. Used for one decision only: telling
// a service of ours that is too busy to answer health (`busy`) from a listener
// nobody proved (`occupied`). Whatever cannot be established is "not proven".
//
//   Linux    /proc/<pid>/cmdline, the exact argument list
//   macOS    /bin/ps -ww -o args= -p <pid>, one line of text
//   Windows  not established: a busy service reads as `occupied` there
//
// Nothing is looked up by name, port or pattern: the one PID asked about is
// the PID the owner-only record names.

const RUNTIME_ARGUMENT = '--runtime-id='

// string[] (exact arguments), string (one joined line) or null.
export function readProcessCommandLine(pid, { platform = process.platform, readFile = fs.readFileSync, run = execFileSync } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  try {
    if (platform === 'linux') {
      const words = readFile(`/proc/${pid}/cmdline`, 'utf8').split('\u0000').filter((word) => word !== '')
      return words.length > 0 ? words : null
    }
    if (platform === 'darwin' || platform === 'freebsd' || platform === 'openbsd') {
      const line = run('/bin/ps', ['-ww', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 1024 * 1024 }).trim()
      return line === '' ? null : line
    }
  } catch { /* not established */ }
  return null
}

// Pure. The command line must name the recorded entry module, by one of
// `entries` (its recorded path, and the path it was started by when that is
// another name for it), and a runtime identifier it carries must be the
// recorded one.
export function commandLineNamesRecord(commandLine, record, entries = [record?.executable?.path]) {
  const names = entries.filter((entry) => typeof entry === 'string' && entry !== '')
  if (names.length === 0 || typeof record?.runtimeId !== 'string') return false
  if (Array.isArray(commandLine)) {
    if (!commandLine.slice(1).some((word) => names.includes(word))) return false
    const named = commandLine.filter((word) => word.startsWith(RUNTIME_ARGUMENT)).map((word) => word.slice(RUNTIME_ARGUMENT.length))
    return named.every((runtimeId) => runtimeId === record.runtimeId)
  }
  if (typeof commandLine !== 'string') return false
  if (!names.some((entry) => ` ${commandLine} `.includes(` ${entry} `))) return false
  const named = [...commandLine.matchAll(/(?:^|\s)--runtime-id=(\S+)/g)].map((match) => match[1])
  return named.every((runtimeId) => runtimeId === record.runtimeId)
}

// The recorded executable is still the bytes that were recorded, and the live
// process was started on it: by its recorded path, or by the path the record
// says it was started by (a login item names the installed entry by its path),
// when that still leads to the recorded one.
export function processRunsRecordedExecutable(record, { commandLineOf = readProcessCommandLine, identityOf = executableIdentity, realpathOf = fs.realpathSync } = {}) {
  try {
    if (identityOf(record.executable.path).digest !== record.executable.digest) return false
  } catch { return false }
  const entries = [record.executable.path]
  const invokedAs = record.executable.ext?.invokedAs
  if (typeof invokedAs === 'string' && path.isAbsolute(invokedAs)) {
    try { if (realpathOf(invokedAs) === record.executable.path) entries.push(invokedAs) } catch { /* not another name for it */ }
  }
  return commandLineNamesRecord(commandLineOf(record.pid), record, entries)
}
