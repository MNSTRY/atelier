import fs from 'node:fs'
import path from 'node:path'
import { resolveGitExecutable } from '../src/runtime/git-adapter.mjs'

// Synthetic upgrade proofs require an explicitly supported Git configuration.
// Keep runner/user filters outside the fixture without changing the real host
// configuration or relaxing the installed executor's refusal checks.
export function upgradeTestGit(directory) {
  const executable = resolveGitExecutable()
  const home = path.join(directory, 'home')
  const bin = path.join(directory, 'bin')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(bin, { recursive: true })
  const globalConfig = path.join(home, '.gitconfig')
  const systemConfig = path.join(directory, 'system.gitconfig')
  fs.writeFileSync(globalConfig, '')
  fs.writeFileSync(systemConfig, '')
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
  const wrapper = path.join(bin, 'git')
  fs.writeFileSync(wrapper, `#!/bin/sh\nGIT_CONFIG_SYSTEM=${quote(systemConfig)} GIT_CONFIG_GLOBAL=${quote(globalConfig)} exec ${quote(executable)} "$@"\n`, { mode: 0o755 })
  return {
    globalConfig,
    env: { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), PATH: `${bin}${path.delimiter}${process.env.PATH}`, ATELIER_GIT_PATH: wrapper },
  }
}
