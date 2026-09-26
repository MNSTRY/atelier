// Quote data as Markdown text, including control characters in path names.
const quote = (value) => JSON.stringify(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/[\\`*_{}\[\]()#+.!|]/g, '\\$&')

export function renderUpgradeExplanation(report) {
  return [
    '# Atelier upgrade for review',
    '',
    `Plan: ${quote(report.planDigest)}`,
    `Source commit: ${quote(report.baseHead)}`,
    `Candidate branch: ${quote(report.branch)}`,
    `Expires: ${quote(report.expiresAt)}`,
    '',
    report.bindingsCurrent ? 'The saved plan matches the observed workspace. This report does not record approval.' : 'The saved plan cannot currently be applied:',
    ...report.blockers.map((reason) => `- ${quote(reason)}`),
    '',
    '## Proposed changes',
    ...report.writes.map((write) => `- ${quote(write.action)} ${quote(write.path)} (${quote(write.owner)}): ${quote(write.before?.digest ?? 'absent')} → ${quote(write.after.digest)}; mode ${quote(write.after.mode)}.`),
    '',
    '## Consent and outcome',
    report.participant === 'local-template-profile@1' ? 'Selection covers the exact installed template/profile/projection bytes and a local Git commit through existing hooks. It does not authenticate human approval.' : 'Approval covers these prepared lock/projection bytes and a local Git commit through existing hooks. The source branch remains unchanged.',
    'Package installation, merge, publication and service activation require their own named authority. This report does not authorize any action.',
    'The digest identifies content; the agent must obtain and retain the owner decision. The CLI does not authenticate human approval.',
    '',
    `Recovery: ${report.recovery}.`,
    ...report.caveats.map((note) => `- ${note}`),
    '',
    `Installed executor evidence: ${quote(report.provenance.executorDigest)}`,
    `Source inventory: ${report.provenance.sourceFiles} files. Upstream release authentication: not supplied by this transaction.`,
    '',
  ].join('\n')
}
