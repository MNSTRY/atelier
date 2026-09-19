import path from 'node:path'
import { firstString, parseArgs, resolveProjectConfig } from '../../../project/config.mjs'
import { refuse } from '../../../runtime/obsidian/errors.mjs'
import { SOURCE_APPLY_OPERATION_ID, SourceApplyRefusal, createSourceApply } from './apply.mjs'

// Binds source apply to the two places that call it: the maintenance engine,
// which dispatches queued edits in automatic mode, and `atelier obsidian
// apply`, which is how a person or an agent acting for them asks for one edit
// by name. Both reach the same function; the engine says `automatic`, the
// command says `manual`.
//
// The engine hands an apply operation the edit and the policy and nothing
// about where it runs, so the operation finds its project the way the process
// that hosts the engine did: from `--project` and `--data-root` of that
// process, else from the working directory. A workspace other than the edit's
// own refuses.

const EXIT = Object.freeze({ ok: 0, notSuccess: 3 })
const EDIT_ID = /^edit-[0-9a-f]{32}$/
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const ENGINE_STATUSES = new Set(['applied', 'refused', 'conflict', 'failed'])

export function processApplyContext({ argv = process.argv.slice(2), env = process.env, cwd = process.cwd(), platform = process.platform } = {}) {
  const args = parseArgs(argv)
  const configPath = firstString(args.project)
  const dataRoot = firstString(args['data-root']) ?? undefined
  return {
    loadProject: () => resolveProjectConfig({ argv: configPath ? [`--project=${path.resolve(cwd, configPath)}`] : [], cwd: configPath ? path.dirname(path.resolve(cwd, configPath)) : cwd, env, writeLocalState: false }),
    ...(dataRoot === undefined ? {} : { dataRoot: path.resolve(cwd, dataRoot) }), env, platform,
  }
}

// The engine looks at displaced files again on the tick of a dispatch and on later ones, and an applied source leaves
// a closed journal that names its backup, so the operation does not wait out a quiet period inside a tick.
export function createEngineApplyOperation({ context = processApplyContext, create = createSourceApply } = {}) {
  return {
    id: SOURCE_APPLY_OPERATION_ID,
    async apply({ edit, policyDigest }) {
      const sourceApply = create({ ...(typeof context === 'function' ? context() : context), quietPeriodMs: 0 })
      const result = await sourceApply.apply({ editId: edit?.editId, mode: 'automatic', policyDigest })
      return { status: ENGINE_STATUSES.has(result.status) ? result.status : 'failed', code: result.code }
    },
  }
}

const SUMMARY = 'list | show EDIT | run EDIT [ACTOR] | recover  Pending edits and the explicit apply of one of them to its source file.'

export function createApplyCommandOperation({ create = createSourceApply } = {}) {
  return {
    name: 'apply',
    summary: SUMMARY,
    async run({ args, flags, loadProject, dataRoot, env, platform, clock }) {
      const [sub = 'list', editId, actorArgument] = args
      const sourceApply = create({ loadProject, ...(dataRoot === undefined ? {} : { dataRoot }), env, platform, clock })
      const typed = async (operation) => {
        try { return await operation() } catch (error) {
          if (error instanceof SourceApplyRefusal) refuse(error.code, 'the apply operation refused', error.detail)
          throw error
        }
      }
      const needsEdit = () => { if (typeof editId !== 'string' || !EDIT_ID.test(editId)) refuse('usage', 'name the edit: an identifier that `obsidian apply list` printed') }
      if (sub === 'list') {
        const edits = await typed(() => sourceApply.list())
        return { exit: EXIT.ok, document: { edits }, human: edits.length === 0 ? ['no pending edit'] : edits.map((edit) => `${edit.editId}\t${edit.repoId}\t${edit.nodeId}\t${edit.state}\t${edit.object?.state ?? 'not-observed'}${edit.lastCode ? `\t${edit.lastCode}` : ''}`) }
      }
      if (sub === 'show') {
        needsEdit()
        const edit = await typed(() => sourceApply.show(editId))
        return { exit: EXIT.ok, document: { edit }, human: [JSON.stringify(edit, null, 2)] }
      }
      if (sub === 'run') {
        needsEdit()
        const actor = actorArgument ?? flags['consent-actor']
        if (actor !== undefined && !ACTOR.test(actor)) refuse('usage', 'the actor must be an identifier')
        const result = await sourceApply.apply({ editId, mode: 'manual', ...(actor === undefined ? {} : { actor }) })
        const applied = result.status === 'applied'
        return { exit: applied ? EXIT.ok : EXIT.notSuccess, document: { result }, human: [`${result.status}: ${result.code}`, ...(applied ? ['The source file changed; nothing was staged or committed.'] : ['Nothing was written to the source file.'])] }
      }
      if (sub === 'recover') {
        const report = await sourceApply.recover()
        if (report.refusal) refuse(report.refusal.code, 'interrupted applies could not be looked at')
        return { exit: EXIT.ok, document: report, human: report.recovered.length === 0 ? ['no interrupted apply'] : report.recovered.map((item) => `${item.applyId}\t${item.status}\t${item.code}`) }
      }
      return refuse('usage', 'apply takes list, show EDIT, run EDIT [ACTOR] or recover')
    },
  }
}

export function createSourceApplyContribution(options = {}) {
  return {
    id: 'atelier.source-apply',
    register({ extensions, operations }) {
      extensions.register('apply-operation', createEngineApplyOperation(options))
      operations.register(createApplyCommandOperation(options))
    },
  }
}
