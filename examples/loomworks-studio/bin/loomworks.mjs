#!/usr/bin/env node
// The whole wrapper. Every command, contract, and gate comes from the root
// package; this file supplies a name and nothing else.
import { runCli } from '@mnstry/atelier/cli'
import { createRequire } from 'node:module'

const { version } = createRequire(import.meta.url)('../package.json')

process.exit(await runCli({
  argv: process.argv.slice(2),
  brand: { command: 'loomworks', displayName: 'Loomworks Studio', version },
}))
