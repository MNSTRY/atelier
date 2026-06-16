#!/usr/bin/env node
import { runServerCommand } from '../server/server.mjs'
runServerCommand().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
