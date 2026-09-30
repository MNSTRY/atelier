import { replay, unique } from '../harnesses/history.mjs'
import { assertAudience, assertHandoff } from '../harnesses/contracts.mjs'
const terminal = new Set(['completed', 'failed', 'cancelled'])
export function inspectBuild(records) {
  const attempts = new Map(), gates = new Map(), decisions = []
  let candidate
  const state = replay(records, 'build', 'objective', (record, ctx) => {
    const d = record.data, refs = []
    const resolve = (pin, kinds) => { const r = ctx.resolve(pin, kinds); refs.push(r.id); return r }
    const objective = ctx.first.data
    switch (record.kind) {
      case 'objective':
        unique(d.gates.map(g => g.id), 'build gate'); unique(d.dependencies.map(d => d.id), 'build dependency'); unique(d.allowedEffects, 'allowed effect')
        if (!d.gates.some(g => g.required)) throw new Error('build needs a required gate')
        for (const dependency of d.dependencies) {
          const h = assertHandoff(dependency.handoff)
          if (h.source.profile === 'build' || h.target.profile !== 'build' || h.target.repository !== d.repository) throw new Error('build dependency requires knowledge or inquiry handoff to this repository')
          assertAudience(d.audience, h.audience)
        }
        break
      case 'candidate':
        resolve(d.objective, ['objective'])
        if (d.repository !== objective.repository) throw new Error('candidate repository mismatch')
        if (candidate) {
          if (!d.supersedes || ctx.resolve(d.supersedes, ['candidate']).id !== candidate.id) throw new Error('candidate must supersede current candidate')
          if ([...attempts.values()].some(a => a.candidate === candidate.id && !terminal.has(a.state))) throw new Error('unsettled attempt prevents candidate replacement')
          ctx.invalidate(candidate.id, `candidate-replaced:${record.id}`)
        } else if (d.supersedes) throw new Error('initial candidate cannot supersede missing work')
        candidate = record
        break
      case 'attempt':
        resolve(d.candidate, ['candidate']); unique(d.effects, 'attempt effect')
        if (d.effects.some(effect => !objective.allowedEffects.includes(effect))) throw new Error('attempt effect is outside declared scope')
        if (attempts.size >= objective.maxAttempts) throw new Error('build attempt budget exhausted')
        if ([...attempts.values()].some(a => a.candidate === d.candidate.id && a.operation === d.operation && !['failed', 'cancelled'].includes(a.state))) throw new Error('operation already completed or unsettled; reconcile before retry')
        attempts.set(record.id, { candidate: d.candidate.id, operation: d.operation, state: 'intent', last: record.id })
        break
      case 'progress': {
        const original = resolve(d.attempt, ['attempt']), previous = attempts.get(original.id)
        const allowed = { intent: ['running', 'uncertain', 'completed', 'failed', 'cancelled'], running: ['uncertain', 'completed', 'failed', 'cancelled'], uncertain: ['completed', 'failed', 'cancelled'] }
        if (!allowed[previous.state]?.includes(d.state)) throw new Error('invalid or terminal attempt transition')
        refs.push(previous.last)
        attempts.set(original.id, { ...previous, state: d.state, last: record.id })
        break
      }
      case 'gate': {
        resolve(d.candidate, ['candidate'])
        if (!objective.gates.some(g => g.id === d.gate)) throw new Error('undeclared build gate')
        if (d.attempt) {
          const a = resolve(d.attempt, ['attempt']), status = attempts.get(a.id)
          if (a.data.candidate.id !== d.candidate.id || (d.status === 'passed' && status.state !== 'completed')) throw new Error('gate requires completed attempt on exact candidate')
          refs.push(status.last)
        }
        const key = `${d.candidate.id}/${d.gate}`, old = gates.get(key)
        if (old) ctx.invalidate(old.id, `gate-replaced:${record.id}`)
        gates.set(key, record)
        break
      }
      case 'decision': {
        resolve(d.candidate, ['candidate']); unique(d.gates.map(g => g.id), 'decision gate')
        const named = d.gates.map(pin => resolve(pin, ['gate']))
        if (named.some(g => g.data.candidate.id !== d.candidate.id)) throw new Error('gate names another candidate')
        if (d.disposition === 'accepted') {
          for (const required of objective.gates.filter(g => g.required)) {
            const gate = gates.get(`${d.candidate.id}/${required.id}`)
            if (!gate || gate.data.status !== 'passed' || !named.some(r => r.id === gate.id)) throw new Error('accepted build requires all current required gates')
          }
          if ([...attempts.values()].some(a => a.candidate === d.candidate.id && !terminal.has(a.state))) throw new Error('unsettled attempt prevents acceptance')
        }
        if (decisions.length) ctx.invalidate(decisions.at(-1).id, `decision-replaced:${record.id}`)
        decisions.push(record)
        break
      }
      case 'delivery': {
        const decision = resolve(d.decision, ['decision'])
        if (decision.data.disposition !== 'accepted' || decisions.at(-1)?.id !== decision.id) throw new Error('delivery requires latest accepted decision')
        break
      }
    }
    return refs
  })
  const stale = new Set(state.reconsider.map(r => r.id))
  const decision = decisions.filter(r => !stale.has(r.id)).at(-1)
  return { ...state, candidate: candidate ?? null, attempts: Object.fromEntries(attempts),
    gates: [...gates.values()].filter(r => !stale.has(r.id)), decision: decision ?? null,
    reportedAccepted: decision?.data.disposition === 'accepted',
    dependencyFreshness: 'unverified-until-snapshots-supplied', executionAuthorized: false, authenticatedAcceptance: false }
}
