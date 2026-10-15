#!/usr/bin/env node
import { scaffoldPostgres, sealProject, validateProject } from '../extensions/project.mjs'

const usage = 'Usage: atelier extension init|validate|seal --directory PATH [--id sample.counter] [--profile postgres-sql] [--json]'
const [command, ...args] = process.argv.slice(2)
try {
  if (command === '--help' || command === '-h' || !command) { console.log(usage) }
  else {
    if (!['init', 'validate', 'seal'].includes(command)) throw new Error('unknown extension command')
    const options = {}
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (arg === '--json') { if (options.json) throw new Error('duplicate option'); options.json = true; continue }
      if (!['--directory', '--id', '--profile'].includes(arg) || !args[i + 1] || args[i + 1].startsWith('--') || Object.hasOwn(options, arg)) throw new Error('invalid option')
      options[arg] = args[++i]
    }
    if (!options['--directory'] || (command !== 'init' && (options['--id'] || options['--profile']))) throw new Error('invalid options')
    if (options['--profile'] && options['--profile'] !== 'postgres-sql') throw new Error('profile not implemented')
    const result = command === 'init' ? await scaffoldPostgres({ directory: options['--directory'], extensionId: options['--id'] }) :
      command === 'validate' ? await validateProject(options['--directory']) : await sealProject(options['--directory']).then(manifest => ({ releaseDigest: manifest.releaseDigest, qualified: false }))
    console.log(options.json ? JSON.stringify(result) : `${command}: ${result.releaseDigest} (qualification pending)`)
  }
} catch {
  // Do not echo a caller path, secret, source file or arbitrary exception text.
  console.error(`Extension command failed. ${usage}`); process.exitCode = 1
}
