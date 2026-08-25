import { checkForbiddenEgress } from './forbidden-egress.mjs'

export { checkForbiddenEgress } from './forbidden-egress.mjs'

export function runEgressCommand() {
  const findings = checkForbiddenEgress()
  if (findings.length) {
    for (const finding of findings) {
      console.error(`[atelier-egress] ${finding.file}:${finding.line} ${finding.type}: ${finding.detail}`)
    }
    process.exit(1)
  }
  console.log('[egress:check] no forbidden non-localhost egress found in package runtime paths')
}
