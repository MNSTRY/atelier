// Impeccable 0.1.19 CLI contract: advisories remain in JSON but do not set exit 2.
export function impeccableFindingExitCode(findings) {
  return findings.some(finding => finding?.advisory !== true && finding?.severity !== 'advisory') ? 2 : 0
}
