#!/usr/bin/env node
import { runAnalysisAdapterCommand } from '../analysis/adapter.mjs'
try {
  runAnalysisAdapterCommand()
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
