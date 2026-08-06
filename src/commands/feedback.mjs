#!/usr/bin/env node
import { runFeedbackCommand } from '../support/feedback-report.mjs'
process.exitCode = runFeedbackCommand()
