import { atelierControlStyles } from './control-system.mjs'

export function htmlEscape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function htmlAttr(name, value) {
  if (value == null || value === false) return ''
  if (value === true) return ` ${name}`
  return ` ${name}="${htmlEscape(value)}"`
}

export function htmlAttrs(attrs = {}) {
  return Object.entries(attrs).map(([name, value]) => htmlAttr(name, value)).join('')
}

export function renderPageShell({ title = 'MNSTRY Atelier', body = '' } = {}) {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${htmlEscape(title)}</title>`,
    '<style>',
    ':root{color-scheme:light dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif}',
    'body{margin:0;padding:32px;background:#f7f7f4;color:#181816}',
    'main{max-width:980px;margin:0 auto}',
    'a{color:#245f73}',
    '.list{display:grid;gap:12px;margin-top:24px}',
    '.item{border:1px solid #d8d8d0;border-radius:8px;padding:16px;background:#fff}',
    '.meta{color:#666;font-size:13px}',
    'pre{white-space:pre-wrap;background:#1f2424;color:#f5f5ee;border-radius:8px;padding:16px;overflow:auto}',
    '.notice{border-left:4px solid #245f73;padding:12px 16px;background:#edf6f7}',
    atelierControlStyles,
    '</style>',
    '</head>',
    '<body>',
    '<main>',
    body,
    '</main>',
    '</body>',
    '</html>',
  ].join('')
}

export function renderProposalListPageHtml(records = []) {
  const items = records.length
    ? records.map((record) => {
      const proposal = record.proposal || {}
      return [
        '<article class="item">',
        `<h2><a href="/proposals/${htmlEscape(proposal.id)}">${htmlEscape(proposal.id)}</a></h2>`,
        `<p class="meta">${htmlEscape(proposal.status || 'unknown')} · ${htmlEscape(proposal.path || '')}</p>`,
        `<p>${htmlEscape(proposal.action || '')}</p>`,
        '</article>',
      ].join('')
    }).join('')
    : '<p class="meta">No local proposals.</p>'

  return renderPageShell({
    title: 'Atelier Proposals',
    body: [
      '<h1>Atelier Proposals</h1>',
      '<p class="notice">Review records are local handoffs. No source writes or browser apply endpoint are exposed.</p>',
      `<section class="list">${items}</section>`,
    ].join(''),
  })
}

export function renderProposalDetailPageHtml(record) {
  if (!record) {
    return renderPageShell({
      title: 'Proposal Not Found',
      body: '<h1>Proposal Not Found</h1>',
    })
  }
  const proposal = record.proposal || {}
  const copyable = record.copyable || null
  const copyBlock = copyable
    ? [
      '<h2>Copy Handoff</h2>',
      '<p class="notice">Accepted Atelier proposal output is copy-only. There is no browser apply endpoint.</p>',
      `<pre>${htmlEscape(copyable.agentInstructions || '')}</pre>`,
      copyable.diff ? `<pre>${htmlEscape(copyable.diff)}</pre>` : '',
    ].join('')
    : ''

  return renderPageShell({
    title: `Review ${proposal.id || 'Proposal'}`,
    body: [
      `<h1>Review ${htmlEscape(proposal.id || 'Proposal')}</h1>`,
      `<p class="meta">${htmlEscape(proposal.status || 'unknown')} · ${htmlEscape(proposal.path || '')}</p>`,
      '<p class="notice">No source writes or apply endpoint are available from this review page.</p>',
      '<h2>Proposal</h2>',
      `<pre>${htmlEscape(JSON.stringify(proposal, null, 2))}</pre>`,
      record.diff ? '<h2>Diff</h2>' : '',
      record.diff ? `<pre>${htmlEscape(record.diff)}</pre>` : '',
      copyBlock,
    ].join(''),
  })
}
