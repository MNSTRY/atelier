#!/usr/bin/env node
import { parseArgs } from '../project/config.mjs'
import {
  runBoundaryAuditCommand,
  runBoundaryCheckCommand,
  runBoundaryInstallHooksCommand,
  runBoundaryPushCheckCommand,
} from '../boundary/policy.mjs'

const args = parseArgs(process.argv.slice(2))
const subcommand = args._[0] || 'check'
const rest = (...names) => process.argv.slice(2).filter((arg) => !names.includes(arg))

if (subcommand === 'check' || subcommand === 'doctor') {
  runBoundaryCheckCommand(rest('check', 'doctor'))
} else if (subcommand === 'push-check') {
  runBoundaryPushCheckCommand(rest('push-check'))
} else if (subcommand === 'audit') {
  runBoundaryAuditCommand(rest('audit'))
} else if (subcommand === 'install-hooks') {
  runBoundaryInstallHooksCommand(rest('install-hooks'))
} else {
  console.error(`Unknown boundary command: ${subcommand}`)
  process.exit(1)
}
