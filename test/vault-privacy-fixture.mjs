// Synthetic provider evidence only. Never use this verifier in a deployed host.
export const deployment = { id: 'synthetic-deployment', origins: ['https://artifacts.example'] }
export function protectionEvidence(context) {
  const { vault, publication, phase, owner, manifest = [], objects = [], deployment: site = deployment } = context
  const targets = site.origins.flatMap(origin => [
    ...[`/${vault}`, `/${vault}/`].map(path => ({ kind: 'route', url: origin + path, sha256: '0'.repeat(64) })),
    ...manifest.map(file => ({ kind: 'route', url: `${origin}/${vault}/${file.path}`, sha256: file.sha256 })),
  ]).concat(objects.map(object => ({ ...object, kind: 'storage', url: `https://storage.example/${object.key}` }))).map(target => ({ ...target, anonymous: 'denied', otherUser: 'denied' }))
  return { vault, publication, phase, owner, deployment: site, checkedAt: Date.now(), validUntil: Date.now() + 60000, policyRevision: 'synthetic-policy', configuration: { ownerOnly: true, privateStorage: true, completeInventory: true }, targets }
}
