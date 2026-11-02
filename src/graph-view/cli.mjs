#!/usr/bin/env node
import { runGraphViewCommand } from './command.mjs'
process.exitCode = await runGraphViewCommand(process.argv.slice(2))
