import { resolveProjectConfig } from '../project/config.mjs'
import { createAtelierSidecarServer } from './local-sidecar.mjs'

function parseServerArgs(argv = []) {
  const args = { projectArgs: [] }
  for (const arg of argv) {
    if (arg === '--smoke') args.smoke = true
    else if (arg.startsWith('--port=')) args.port = arg.slice('--port='.length)
    else args.projectArgs.push(arg)
  }
  return args
}

export async function runServerCommand(argv = process.argv.slice(2)) {
  const args = parseServerArgs(argv)
  const project = resolveProjectConfig({ argv: args.projectArgs })
  const sidecar = createAtelierSidecarServer({
    workspaceRoot: project.outputRoot,
    stateDir: project.outputRoot,
    // argv > PORT env > default. Supervisors that assign a free port (preview
    // panes, dev harnesses) pass it via PORT, and an Atelier that ignores that
    // fights whatever already holds the canonical port instead of coexisting.
    port: args.smoke ? 0 : Number(args.port || process.env.PORT || 8137),
  })

  if (args.smoke) {
    const address = await sidecar.listen()
    const base = `http://127.0.0.1:${address.port}`
    // @atelier-egress-local-computed
    const health = await fetch(`${base}/api/health`).then((res) => res.json())
    if (!health.ok) throw new Error('health check failed')
    // @atelier-egress-local-computed
    const page = await fetch(`${base}/index.html`).then((res) => res.text())
    if (!page.includes('MNSTRY Atelier')) throw new Error('projection smoke failed')
    await sidecar.close()
    console.log('[atelier:browser:smoke] local projection and health endpoint passed')
    return
  }

  const address = await sidecar.listen()
  console.log(`MNSTRY Atelier listening on http://127.0.0.1:${address.port}/`)
}
