import fs from 'node:fs'
import path from 'node:path'
import { commandProject, readJson, writeJson } from '../project/config.mjs'
import { summarizeReadinessJourney } from '../readiness-protocols/runtime.mjs'

const esc = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

export function buildProjectProjection(project) {
  const graph = readJson(project.graphPath)
  const readinessJourney = summarizeReadinessJourney(project)
  const output = path.join(project.outputRoot, 'index.html')
  const dimensionCards = readinessJourney.dimensions.map((item) => `<article class="readiness-card" data-protocol="${esc(item.protocolId)}">
    <p class="eyebrow">${esc(item.label)}</p>
    <h3>${esc(item.title)}</h3>
    <p><strong>${esc(item.status)}</strong> · ${esc(item.score)} / 100</p>
    <p>${esc(item.blockers[0] || 'review-ready')}</p>
    <button type="button" data-copy="${esc(item.agentPrompt)}">Copy protocol prompt</button>
  </article>`).join('\n')
  const cards = graph.nodes.map((node) => `<article class="card" data-node="${esc(node.id)}">
    <p class="eyebrow">${esc(node.repo)} · ${esc(node.type)} · ${esc(node.audience)}</p>
    <h2>${esc(node.title || node.id)}</h2>
    <p>${esc(node.summary || node.path)}</p>
  </article>`).join('\n')
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="mnstry:atelier" content="project-projection">
<title>${esc(project.config.name || 'MNSTRY Atelier')}</title>
<style>
body{margin:0;font:16px/1.5 ui-sans-serif,system-ui;background:#151312;color:#f4eee5}
main{max-width:1120px;margin:0 auto;padding:32px 20px}
h1{font-size:clamp(2rem,4vw,4rem);margin:.2em 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}
.card{border:1px solid #3a302b;border-radius:8px;padding:16px;background:#201a18}
.readiness{margin:24px 0 32px;padding:20px;border:1px solid #463b34;border-radius:8px;background:#1c1715}
.readiness-head{display:flex;gap:16px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap}
.readiness-score{font-size:2rem;font-weight:700;color:#e3b56e}
.readiness-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-top:16px}
.readiness-card{border:1px solid #342b26;border-radius:8px;padding:14px;background:#171312}
.readiness-card h3{font-size:1.05rem;margin:.2rem 0}
.readiness-card button{min-height:44px;border:1px solid #755f43;border-radius:6px;background:#241d18;color:#f4eee5;padding:8px 10px;cursor:pointer}
.eyebrow{color:#c39a5b;text-transform:uppercase;letter-spacing:.08em;font-size:.8rem}
a{color:#e3b56e}
</style>
</head>
<body><main>
<p class="eyebrow">MNSTRY Atelier · local projection</p>
<h1>${esc(project.config.name || 'Project Workspace')}</h1>
<p>${graph.counts.nodes} graph nodes · ${graph.counts.edges} graph edges · ${graph.counts.diagnostics} diagnostics</p>
<section class="readiness" aria-labelledby="tenant-readiness-title">
  <div class="readiness-head">
    <div>
      <p class="eyebrow">MNSTRY Tenant Readiness</p>
      <h2 id="tenant-readiness-title">Readiness Journey</h2>
      <p>${esc(readinessJourney.dimensions.length)} dimensions · next protocol: ${esc(readinessJourney.nextProtocol || 'none')}</p>
    </div>
    <div class="readiness-score">${esc(readinessJourney.score)}%</div>
  </div>
  <div class="readiness-grid">${dimensionCards}</div>
</section>
<section class="grid">${cards}</section>
<script>
document.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-copy]')
  if (!button) return
  try {
    await navigator.clipboard.writeText(button.getAttribute('data-copy') || '')
    button.textContent = 'Copied'
  } catch {
    button.textContent = 'Copy failed'
  }
})
</script>
</main></body></html>
`
  return { output, html, graph, readinessJourney }
}

export function runProjectCommand(argv = process.argv.slice(2)) {
  const check = argv.includes('--check')
  const project = commandProject({ argv })
  const projection = buildProjectProjection(project)
  if (check) {
    const current = fs.existsSync(projection.output) ? fs.readFileSync(projection.output, 'utf8') : null
    if (current !== projection.html) {
      console.error(`project projection is stale: ${projection.output}`)
      process.exit(1)
    }
  } else {
    fs.mkdirSync(path.dirname(projection.output), { recursive: true })
    fs.writeFileSync(projection.output, projection.html)
    writeJson(path.join(project.outputRoot, 'atelier.manifest.json'), {
      schema: 'mnstry.atelier-manifest@v1',
      generatedAt: 'deterministic',
      graphPath: project.graphPath,
      entry: 'index.html',
      tenantReadiness: {
        score: projection.readinessJourney.score,
        ready: projection.readinessJourney.ready,
        dimensions: projection.readinessJourney.dimensions.map((item) => ({
          key: item.key,
          protocolId: item.protocolId,
          status: item.status,
          score: item.score,
        })),
      },
      nodes: projection.graph.nodes.map((node) => ({ id: node.id, title: node.title, audience: node.audience, path: node.path })),
    })
  }
  console.log(`project projection: ${projection.graph.counts.nodes} nodes -> ${projection.output}`)
}
