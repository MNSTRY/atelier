#!/usr/bin/env node
import { checkForbiddenEgress } from '../egress/forbidden-egress.mjs'

const findings = checkForbiddenEgress()
if (findings.length) {
  for (const finding of findings) {
    console.error(`[atelier-egress] ${finding.file}:${finding.line} ${finding.type}: ${finding.detail}`)
  }
  process.exit(1)
}
console.log('[atelier-egress] no forbidden network egress found')
