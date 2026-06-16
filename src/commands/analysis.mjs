#!/usr/bin/env node
import { runAnalysisCommand } from '../analysis/analysis.mjs'
try {
  runAnalysisCommand()
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
