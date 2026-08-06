import fs from 'node:fs'

export function analysisAdapterDryRun(manifestPath = null) {
  const manifest = manifestPath && fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {}
  if (manifest.enabled === true) throw new Error('model-assisted analysis execution is disabled in this release')
  if (manifest.endpoint || manifest.token || manifest.apiBase || manifest.proxyUrl) throw new Error('model-assisted analysis manifest must not declare network/provider egress')
  return {
    schema: 'mnstry.atelier-analysis-adapter-dry-run@v1',
    provider: 'analysis',
    enabled: false,
    canonicalMutation: false,
    output: 'atelier-claim@v1 proposed claims only',
  }
}

export function runAnalysisAdapterCommand(argv = process.argv.slice(2)) {
  const manifestArg = argv.find((arg) => arg.startsWith('--manifest='))
  const report = analysisAdapterDryRun(manifestArg ? manifestArg.slice('--manifest='.length) : null)
  console.log(JSON.stringify(report, null, 2))
}
