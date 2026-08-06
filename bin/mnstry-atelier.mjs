#!/usr/bin/env node
import { runCli } from '../src/cli/run.mjs'
process.exit(await runCli({ argv: process.argv.slice(2) }))
