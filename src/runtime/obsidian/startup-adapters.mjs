import path from 'node:path'
import { refuse } from './errors.mjs'

// Builds the text of an operating-system startup unit for the maintenance
// service. Pure: it returns text and touches nothing. It writes no file,
// installs nothing and runs no service manager. Installing a unit is a
// separate step (login-item.mjs) that a person asks for, and the service
// refuses `--startup` without a recorded consent that covers startup.
//
// Every machine-specific value is an input. Nothing is looked up here: no
// home directory, no environment, no current directory, no installed path.
//
//   macOS    a launchd user agent (property list)
//   Linux    a systemd user unit
//   Windows  refused, typed: startup there has not been qualified
//
// The unit runs the service entry in the foreground with `--startup`, in the
// root directory (never one that could be a vault), with the search path it
// is given, so the service finds the same programs the person uses. It is
// restarted after a crash and after an exit with a code the service uses to
// ask for it (a new release on disk), never after a clean stop and never in a
// tight loop; a refusal under `--startup` exits cleanly. The service writes
// its own bounded log; the unit's output file receives only what happens
// before it can, such as a module that cannot be loaded.

export const STARTUP_PLATFORMS = Object.freeze(['darwin', 'linux'])
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const CONTROL = /[\u0000-\u001f\u007f]/
// Seconds: the least time between two starts, and how long a stop may take before the manager ends the process. The
// service gives a tick in flight 30 seconds to finish when it is asked to stop.
const THROTTLE_SECONDS = 60
const EXIT_TIMEOUT_SECONDS = 60

const xml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
// systemd: quoted, with its specifier and variable characters doubled.
const unitWord = (value) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$$$')}"`
// systemd: one quoted assignment of Environment=, where `$` has no meaning and only specifiers are expanded.
const unitAssignment = (name, value) => `"${`${name}=${value}`.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`

function launchdText({ label, words, logPath, workingDirectory, searchPath }) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>', `  <string>${xml(label)}</string>`,
    '  <key>ProgramArguments</key>', '  <array>', ...words.map((word) => `    <string>${xml(word)}</string>`), '  </array>',
    ...(searchPath === null ? [] : ['  <key>EnvironmentVariables</key>', '  <dict>', '    <key>PATH</key>', `    <string>${xml(searchPath)}</string>`, '  </dict>']),
    '  <key>WorkingDirectory</key>', `  <string>${xml(workingDirectory)}</string>`,
    '  <key>RunAtLoad</key>', '  <true/>',
    // Restarted after a crash or a non-zero exit, not after a clean stop; a refusal exits cleanly and is not retried.
    '  <key>KeepAlive</key>', '  <dict>', '    <key>SuccessfulExit</key>', '    <false/>', '  </dict>',
    '  <key>ThrottleInterval</key>', `  <integer>${THROTTLE_SECONDS}</integer>`,
    '  <key>ExitTimeOut</key>', `  <integer>${EXIT_TIMEOUT_SECONDS}</integer>`,
    // Standard, not Background: the service's budgets were measured without the I/O throttling of a background process.
    '  <key>ProcessType</key>', '  <string>Standard</string>',
    '  <key>StandardOutPath</key>', `  <string>${xml(logPath)}</string>`,
    '  <key>StandardErrorPath</key>', `  <string>${xml(logPath)}</string>`,
    '</dict>',
    '</plist>',
  ]
  return `${lines.join('\n')}\n`
}

function systemdText({ label, words, logPath, workingDirectory, searchPath }) {
  const lines = [
    '[Unit]',
    `Description=Atelier Obsidian maintenance (${label.replaceAll(/[^A-Za-z0-9._-]/g, '')})`,
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${words.map(unitWord).join(' ')}`,
    ...(searchPath === null ? [] : [`Environment=${unitAssignment('PATH', searchPath)}`]),
    `WorkingDirectory=${workingDirectory.replaceAll('%', '%%')}`,
    // Restarted after a crash or a non-zero exit; not after a clean stop, and not after a refusal (exit status 2).
    'Restart=on-failure',
    `RestartSec=${THROTTLE_SECONDS}`,
    'RestartPreventExitStatus=2',
    `TimeoutStopSec=${EXIT_TIMEOUT_SECONDS}`,
    `StandardOutput=append:${logPath.replaceAll('%', '%%')}`,
    `StandardError=append:${logPath.replaceAll('%', '%%')}`,
    '',
    '[Install]',
    'WantedBy=default.target',
  ]
  return `${lines.join('\n')}\n`
}

// The search path a unit carries: the entries of `value` (a PATH as the environment holds it) that are absolute
// directories, in their order, each once, and none inside a temporary directory (`temporary`, absolute prefixes): a
// relative entry would be resolved in the unit's working directory, and a temporary one (an agent's session, say) is
// gone after a restart. Pure. Null when nothing is left.
export function startupSearchPath(value, { temporary = [] } = {}) {
  if (typeof value !== 'string') return null
  const inside = (entry) => temporary.some((prefix) => typeof prefix === 'string' && path.posix.isAbsolute(prefix) && (entry === prefix || entry.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)))
  const kept = []
  for (const raw of value.split(':')) {
    const entry = raw.length > 1 ? raw.replace(/\/+$/, '') : raw
    if (!path.posix.isAbsolute(entry) || CONTROL.test(entry) || inside(entry) || kept.includes(entry)) continue
    kept.push(entry)
  }
  return kept.length === 0 ? null : kept.join(':')
}

// { platform, kind, fileName, text }. `args` are the arguments of the entry after `--startup`; `searchPath` is the PATH
// the unit sets (absolute entries joined by `:`; see startupSearchPath), none when omitted.
export function buildStartupAdapter({ platform, label, nodePath, entryPath, args = [], logPath, workingDirectory = '/', searchPath = null } = {}) {
  if (platform === 'win32') refuse('startup-platform-unqualified', 'operating-system startup on Windows has not been qualified; no unit is generated for it', { platform })
  if (!STARTUP_PLATFORMS.includes(platform)) refuse('startup-platform-unsupported', 'no startup unit is known for this platform', { platform: String(platform) })
  if (typeof label !== 'string' || !LABEL.test(label)) refuse('startup-adapter-input-invalid', 'the unit label must be a plain identifier')
  const flavor = path.posix
  for (const [name, value] of [['nodePath', nodePath], ['entryPath', entryPath], ['logPath', logPath], ['workingDirectory', workingDirectory]]) {
    if (typeof value !== 'string' || !flavor.isAbsolute(value) || CONTROL.test(value)) refuse('startup-adapter-input-invalid', `${name} must be an absolute path given by the caller`, { name })
  }
  if (searchPath !== null && (typeof searchPath !== 'string' || searchPath.split(':').some((entry) => !flavor.isAbsolute(entry) || CONTROL.test(entry)))) {
    refuse('startup-adapter-input-invalid', 'searchPath must be absolute directories joined by ":"', { name: 'searchPath' })
  }
  if (!Array.isArray(args) || args.some((word) => typeof word !== 'string' || word === '' || CONTROL.test(word))) refuse('startup-adapter-input-invalid', 'args must be a list of plain words')
  if (args.includes('--startup')) refuse('startup-adapter-input-invalid', '--startup is added by the builder')
  const words = [nodePath, entryPath, '--startup', ...args]
  const input = { label, words, logPath, workingDirectory, searchPath }
  return platform === 'darwin'
    ? { platform, kind: 'launchd-user-agent', fileName: `${label}.plist`, text: launchdText(input) }
    : { platform, kind: 'systemd-user-unit', fileName: `${label}.service`, text: systemdText(input) }
}
