import { commandProject, parseArgs } from '../project/config.mjs'

export function contextEnvelope(project, args) {
  const path = args.path || 'index.html'
  return {
    schema: 'atelier-context@v1',
    workspaceId: `atelier:${project.config.name ?? 'workspace'}`,
    workspaceVerified: Boolean(args.expectedWorkspaceId ? args.expectedWorkspaceId === `atelier:${project.config.name ?? 'workspace'}` : false),
    view: { path, source: 'cli' },
    authority: {
      runtimeMutation: false,
      browserWrites: false,
      actions: ['copy.repoPath', 'copy.agentPrompt'],
    },
  }
}

export function runContextCommand(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const project = commandProject({ argv })
  const command = args._[0] || 'flow'
  if (command === 'capabilities') {
    console.log(JSON.stringify({ schema: 'mnstry.atelier-capabilities@v1', runtimeMutation: false, browserWrites: false, proposalOnly: true }, null, 2))
    return
  }
  console.log(JSON.stringify(contextEnvelope(project, args), null, 2))
}
