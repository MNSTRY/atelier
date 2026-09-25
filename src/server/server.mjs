import fs from 'node:fs'
import path from 'node:path'
import { AtelierDiagnosticError, resolveProjectConfig } from '../project/config.mjs'
import { createAtelierSidecarServer } from './local-sidecar.mjs'

// dev serves what build wrote and builds nothing itself. Before build, the
// output folder (or, after graph alone, its manifest) is absent, and the
// sidecar failed with a raw ENOENT carrying an absolute path or a redacted
// internal error. Name the missing steps instead, and name the folder only
// relative to the project config. A non-directory is left to the sidecar.
function assertProjectionBuilt(project) {
  const stat = fs.statSync(project.outputRoot, { throwIfNoEntry: false })
  if (stat && !stat.isDirectory()) return
  const manifestMissing = stat && !fs.existsSync(path.join(project.outputRoot, 'atelier.manifest.json'))
  if (stat && !manifestMissing) return
  const rel = path.relative(project.configDir, project.outputRoot)
  const contained = rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
  const folder = contained ? `projection output folder ${rel}` : 'the projection output folder'
  const state = manifestMissing ? 'has no atelier.manifest.json' : 'does not exist'
  throw new AtelierDiagnosticError('projection-output-missing', `${folder} ${state}; this project has not been built yet`, {
    hint: 'Run atelier graph, then atelier build, with the same --project path, then retry.',
  })
}

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
  assertProjectionBuilt(project)
  const sidecar = createAtelierSidecarServer({
    workspaceRoot: project.outputRoot,
    stateDir: project.outputRoot,
    reviewProject: argv.includes('--review') ? project : null,
    // argv > PORT env > default. Supervisors that assign a free port (preview
    // panes, dev harnesses) pass it via PORT, and an Atelier that ignores that
    // fights whatever already holds the canonical port instead of coexisting.
    port: args.smoke ? 0 : Number(args.port || process.env.PORT || 8137),
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
