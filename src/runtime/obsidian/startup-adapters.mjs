import path from 'node:path'
import { refuse } from './errors.mjs'

// Builds the text of an operating-system startup unit for the maintenance
// service. Pure: it returns text and touches nothing. It writes no file,
// installs nothing and runs no service manager. Installing a unit is a
// separate system change that needs a person's explicit authorization and a
// recorded consent that covers startup; the service refuses `--startup`
// without one.
//
// Every machine-specific value is an input. Nothing is looked up here: no
// home directory, no environment, no current directory, no installed path.
//
//   macOS    a launchd user agent (property list)
//   Linux    a systemd user unit
//   Windows  refused, typed: startup there has not been qualified
//
// The unit runs the service entry in the foreground with `--startup`; the
// service writes its own record once it listens, exactly as under `start`.

export const STARTUP_PLATFORMS = Object.freeze(['darwin', 'linux'])
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

const xml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
// systemd: quoted, with its specifier and variable characters doubled.
const unitWord = (value) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$$$')}"`

function launchdText({ label, words, logPath, workingDirectory }) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>', `  <string>${xml(label)}</string>`,
    '  <key>ProgramArguments</key>', '  <array>', ...words.map((word) => `    <string>${xml(word)}</string>`), '  </array>',
    '  <key>RunAtLoad</key>', '  <true/>',
    // Restarted after a crash, not after a clean stop; a refusal is not retried in a tight loop.
    '  <key>KeepAlive</key>', '  <dict>', '    <key>SuccessfulExit</key>', '    <false/>', '  </dict>',
    '  <key>ThrottleInterval</key>', '  <integer>60</integer>',
    '  <key>ProcessType</key>', '  <string>Background</string>',
    ...(workingDirectory === undefined ? [] : ['  <key>WorkingDirectory</key>', `  <string>${xml(workingDirectory)}</string>`]),
    '  <key>StandardOutPath</key>', `  <string>${xml(logPath)}</string>`,
    '  <key>StandardErrorPath</key>', `  <string>${xml(logPath)}</string>`,
    '</dict>',
    '</plist>',
  ]
  return `${lines.join('\n')}\n`
}

function systemdText({ label, words, logPath, workingDirectory }) {
  const lines = [
    '[Unit]',
    `Description=Atelier Obsidian maintenance (${label.replaceAll(/[^A-Za-z0-9._-]/g, '')})`,
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${words.map(unitWord).join(' ')}`,
    ...(workingDirectory === undefined ? [] : [`WorkingDirectory=${workingDirectory.replaceAll('%', '%%')}`]),
    // Restarted after a crash; not after a clean stop, and not after a refusal (exit status 2).
    'Restart=on-failure',
    'RestartSec=60',
    'RestartPreventExitStatus=2',
    `StandardOutput=append:${logPath.replaceAll('%', '%%')}`,
    `StandardError=append:${logPath.replaceAll('%', '%%')}`,
    '',
    '[Install]',
    'WantedBy=default.target',
  ]
  return `${lines.join('\n')}\n`
}

// { platform, kind, fileName, text }. `args` are the arguments of the entry after `--startup`.
export function buildStartupAdapter({ platform, label, nodePath, entryPath, args = [], logPath, workingDirectory } = {}) {
  if (platform === 'win32') refuse('startup-platform-unqualified', 'operating-system startup on Windows has not been qualified; no unit is generated for it', { platform })
  if (!STARTUP_PLATFORMS.includes(platform)) refuse('startup-platform-unsupported', 'no startup unit is known for this platform', { platform: String(platform) })
  if (typeof label !== 'string' || !LABEL.test(label)) refuse('startup-adapter-input-invalid', 'the unit label must be a plain identifier')
  const flavor = path.posix
  for (const [name, value] of [['nodePath', nodePath], ['entryPath', entryPath], ['logPath', logPath], ...(workingDirectory === undefined ? [] : [['workingDirectory', workingDirectory]])]) {
    if (typeof value !== 'string' || !flavor.isAbsolute(value) || /[\u0000-\u001f]/.test(value)) refuse('startup-adapter-input-invalid', `${name} must be an absolute path given by the caller`, { name })
  }
  if (!Array.isArray(args) || args.some((word) => typeof word !== 'string' || word === '' || /[\u0000-\u001f]/.test(word))) refuse('startup-adapter-input-invalid', 'args must be a list of plain words')
  if (args.includes('--startup')) refuse('startup-adapter-input-invalid', '--startup is added by the builder')
  const words = [nodePath, entryPath, '--startup', ...args]
  return platform === 'darwin'
    ? { platform, kind: 'launchd-user-agent', fileName: `${label}.plist`, text: launchdText({ label, words, logPath, workingDirectory }) }
    : { platform, kind: 'systemd-user-unit', fileName: `${label}.service`, text: systemdText({ label, words, logPath, workingDirectory }) }
}
