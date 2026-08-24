import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export function resolveNpmCli({
  execPath = process.execPath,
  npmExecPath = process.env.npm_execpath,
  pathValue = process.env.PATH,
} = {}) {
  const executableDirectory = path.dirname(execPath)
  const pathDirectories = String(pathValue ?? '')
    .split(path.delimiter)
    .filter(Boolean)
  const candidates = [
    npmExecPath,
    path.join(executableDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(executableDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ...pathDirectories.flatMap((directory) => [
      path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      path.resolve(directory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ]),
  ].filter(Boolean)

  for (const candidate of new Set(candidates)) {
    const absolute = path.resolve(candidate)
    try {
      if (fs.statSync(absolute).isFile()) return absolute
    } catch {
      // Try the next standard Node/npm installation layout.
    }
  }

  throw new Error([
    'unable to resolve npm-cli.js without a shell shim',
    `checked: ${candidates.map((candidate) => path.resolve(candidate)).join(', ')}`,
  ].join('; '))
}

export function execNpmSync(args, options = {}) {
  return execFileSync(process.execPath, [resolveNpmCli(), ...args], {
    windowsHide: true,
    ...options,
  })
}
