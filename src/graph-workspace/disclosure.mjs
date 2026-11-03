// Shippable-content gate for layered systems. When a coach or owner builds on top of
// private workspaces, the shareable layer must not carry anything from them.
// fingerprintsFrom() derives distinctive strings from a private knowledge graph and
// plan (ids, paths, long titles, summary openings, plan wording, names);
// scanForFingerprints() reports where any of them occurs in shareable text.
// Findings name the file and a masked sample, never the full matched content.

export function fingerprintsFrom({ graph = null, plan = null, names = [], extra = [] } = {}) {
  const out = new Set()
  const add = v => { if (typeof v === 'string' && v.trim().length >= 8) out.add(v.trim()) }
  const distinctive = t => typeof t === 'string' && (t.length >= 24 || t.trim().split(/\s+/).length >= 4)
  for (const n of graph?.nodes ?? []) {
    add(n.id); add(n.path)
    if (distinctive(n.title)) add(n.title)
    const first = (n.summary ?? '').split('\n')[0]
    if (first.length >= 40) add(first.slice(0, 60))
  }
  for (const c of plan?.concepts ?? []) for (const v of [c.definition, c.identityRule]) if ((v ?? '').length >= 30) add(v.slice(0, 60))
  for (const q of plan?.questions ?? []) add(q.question ?? q.title)
  for (const v of names) add(v)
  for (const v of extra) if (typeof v === 'string' && v.length >= 4) out.add(v)
  return [...out]
}

const mask = f => f.length > 10 ? `${f.slice(0, 4)}…${f.slice(-3)} (${f.length} chars)` : '(short value)'

/** files: [{ path, text }]. Returns { ok, scanned, findings: [{ path, sample }] }. */
export function scanForFingerprints(files, fingerprints) {
  const byPrefix = new Map()
  for (const f of fingerprints) { const k = f.slice(0, 6); if (!byPrefix.has(k)) byPrefix.set(k, []); byPrefix.get(k).push(f) }
  const findings = []
  for (const file of files) {
    for (const [prefix, list] of byPrefix) {
      if (!file.text.includes(prefix)) continue
      for (const f of list) if (file.text.includes(f)) findings.push({ path: file.path, sample: mask(f) })
    }
  }
  return { ok: findings.length === 0, scanned: files.length, findings }
}
