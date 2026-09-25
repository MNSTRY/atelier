import { AtelierDiagnosticError, resolveProjectConfig } from '../project/config.mjs'
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

// argv > PORT env > default. Supervisors that assign a free port (preview
// panes, dev harnesses) pass it via PORT, and an Atelier that ignores that
// fights whatever already holds the canonical port instead of coexisting.
// A value listen would refuse is refused here, naming where it came from;
// Node's own range error names neither the flag nor the variable.
function resolvePort(args, env = process.env) {
  const [source, raw] = args.port ? ['--port', args.port] : env.PORT ? ['PORT', env.PORT] : [null, '8137']
  const port = Number(raw)
  if (Number.isInteger(port) && port >= 0 && port <= 65535) return port
  throw new AtelierDiagnosticError('port-invalid', `${source} must be a whole number from 0 to 65535, got ${JSON.stringify(raw)}`, {
    hint: source === 'PORT'
      ? 'Set PORT to a free port or unset it, or pass --port=<free port> to override it.'
      : 'Pass a free port, for example --port=8138.',
  })
}

export async function runServerCommand(argv = process.argv.slice(2)) {
  const args = parseServerArgs(argv)
  const project = resolveProjectConfig({ argv: args.projectArgs })
  const sidecar = createAtelierSidecarServer({
    workspaceRoot: project.outputRoot,
    stateDir: project.outputRoot,
    reviewProject: argv.includes('--review') ? project : null,
    port: args.smoke ? 0 : resolvePort(args),
  })

  if (args.smoke) {
    const address = await sidecar.listen()
    const base = `http://127.0.0.1:${address.port}`
    const headers = { Origin: base, 'Sec-Fetch-Site': 'same-origin' }
    // @atelier-egress-local-computed
    const health = await fetch(`${base}/api/health`, { headers }).then((res) => res.json())
    if (!health.ok) throw new Error('health check failed')
    // @atelier-egress-local-computed
    const page = await fetch(`${base}/`, { headers }).then((res) => res.text())
    if (!page.includes('<meta name="mnstry:atelier"')) throw new Error('projection smoke failed')
    await sidecar.close()
    console.log('[atelier:browser:smoke] local projection and health endpoint passed')
    return
  }

  const address = await sidecar.listen()
  console.log(`MNSTRY Atelier listening on http://127.0.0.1:${address.port}/`)
}
