// Synthetic provider evidence only. Never use this verifier in a deployed host.
export function protectionEvidence({ vault, publication, phase, owner }) {
  return { vault, publication, phase, owner, checkedAt: Date.now(), validUntil: Date.now() + 60000, policyRevision: 'synthetic-policy', configuration: { ownerOnly: true, privateStorage: true, completeInventory: true }, targets: ['artifact', 'asset', 'alias', 'origin', 'storage'].map(kind => ({ kind, url: `https://${kind}.example/test`, owner: kind === 'storage' ? 'denied' : 'content', anonymous: 'denied', otherUser: 'denied' })) }
}
