import fs from 'node:fs'
import path from 'node:path'
import { commandProject, readJson, writeJson } from '../project/config.mjs'

const esc = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

export function buildProjectProjection(project) {
  const graph = readJson(project.graphPath)
  const output = path.join(project.outputRoot, 'index.html')
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
.eyebrow{color:#c39a5b;text-transform:uppercase;letter-spacing:.08em;font-size:.8rem}
a{color:#e3b56e}
</style>
</head>
<body><main>
<p class="eyebrow">MNSTRY Atelier · local projection</p>
<h1>${esc(project.config.name || 'Project Workspace')}</h1>
<p>${graph.counts.nodes} graph nodes · ${graph.counts.edges} graph edges · ${graph.counts.diagnostics} diagnostics</p>
<section class="grid">${cards}</section>
</main></body></html>
`
  return { output, html, graph }
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
      nodes: projection.graph.nodes.map((node) => ({ id: node.id, title: node.title, audience: node.audience, path: node.path })),
    })
  }
  console.log(`project projection: ${projection.graph.counts.nodes} nodes -> ${projection.output}`)
}
