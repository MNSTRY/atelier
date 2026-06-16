#!/usr/bin/env node
import { parseArgs } from '../project/config.mjs'
import { runBoundaryCheckCommand, runBoundaryInstallHooksCommand } from '../boundary/policy.mjs'

const args = parseArgs(process.argv.slice(2))
const subcommand = args._[0] || 'check'

if (subcommand === 'check' || subcommand === 'doctor') {
  runBoundaryCheckCommand(process.argv.slice(2).filter((arg) => arg !== 'check' && arg !== 'doctor'))
} else if (subcommand === 'install-hooks') {
  runBoundaryInstallHooksCommand(process.argv.slice(2).filter((arg) => arg !== 'install-hooks'))
} else {
  console.error(`Unknown boundary command: ${subcommand}`)
  process.exit(1)
}
