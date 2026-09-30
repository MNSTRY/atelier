import { replay, unique } from '../harnesses/history.mjs'
import { assertAudience, assertHandoff, contentDigest } from '../harnesses/contracts.mjs'

export function inspectKnowledge(records) {
  const reviews = new Map(), evaluations = new Map()
  let domain
  const state = replay(records, 'knowledge', 'domain', (record, ctx) => {
    const d = record.data, refs = []
    const resolve = (pin, kinds, current = true) => { const r = ctx.resolve(pin, kinds, current); refs.push(r.id); return r }
    const accepted = id => { const review = reviews.get(id); return review?.data.disposition === 'accepted' && !ctx.stale.has(id) && !ctx.stale.has(review.id) }
    switch (record.kind) {
      case 'domain': case 'domain-revision':
        unique(d.questions.map(q => q.id), 'domain question'); unique(d.vocabulary.types.map(t => t.id), 'vocabulary type'); unique(d.vocabulary.relations.map(r => r.id), 'vocabulary relation')
        if (record.kind === 'domain-revision') {
          const old = ctx.resolve(d.supersedes, ['domain', 'domain-revision'])
          if (old.id !== domain.id || d.repository !== domain.data.repository) throw new Error('domain revision must preserve repository and supersede current domain')
          ctx.invalidate(old.id, `domain-revised:${record.id}`)
        }
        domain = record
        break
      case 'contribution': {
        const owner = resolve(d.domain, ['domain', 'domain-revision'])
        if (owner.id !== domain.id || !owner.data.vocabulary.types.some(t => t.id === d.term)) throw new Error('contribution requires current domain vocabulary')
        if (d.scope !== owner.data.scope) throw new Error('contribution scope differs from domain')
        assertAudience(owner.data.audience, d.audience)
        if (Boolean(d.supersedes) !== Boolean(d.revisionReason)) throw new Error('revision needs both supersedes and reason')
        if (d.supersedes) {
          const old = ctx.resolve(d.supersedes, ['contribution'], false)
          if ([...ctx.entries.values()].some(r => r.kind === 'contribution' && r.data.supersedes?.id === old.id)) throw new Error('contribution already superseded; revise its successor')
          ctx.invalidate(old.id, `revised:${record.id}`)
        }
        if (d.origin.method === 'captured' && contentDigest(d.body) !== d.origin.contentDigest) throw new Error('captured source digest mismatch')
        if (d.origin.method === 'extracted' && contentDigest(d.body) !== d.origin.outputDigest) throw new Error('extraction output digest mismatch')
        if (d.origin.method === 'exchange') {
          const handoff = assertHandoff(d.origin.handoff)
          if (handoff.target.profile !== 'knowledge' || handoff.target.repository !== owner.data.repository || handoff.payload !== d.body) throw new Error('exchange target or content mismatch')
          assertAudience(d.audience, handoff.audience)
        }
        unique(d.basedOn.map(e => e.contribution.id), 'knowledge evidence')
        for (const evidence of d.basedOn) {
          const source = resolve(evidence.contribution, ['contribution'])
          if (!source.data.body.includes(evidence.quote)) throw new Error('knowledge quote missing from source')
          assertAudience(d.audience, source.data.audience)
        }
        break
      }
      case 'evaluation': {
        const target = resolve(d.contribution, ['contribution'])
        if (d.scope !== target.data.scope) throw new Error('evaluation scope mismatch')
        const previousReview = reviews.get(target.id)
        if (previousReview) ctx.invalidate(previousReview.id, `evaluation-added:${record.id}`)
        evaluations.set(record.id, record)
        break
      }
      case 'relation': {
        const owner = resolve(d.domain, ['domain', 'domain-revision'])
        const subject = resolve(d.subject, ['contribution']), object = resolve(d.object, ['contribution'])
        if (subject.data.domain.id !== owner.id || object.data.domain.id !== owner.id || !owner.data.vocabulary.relations.some(r => r.id === d.predicate)) throw new Error('relation requires matching domain and predicate')
        break
      }
      case 'review': {
        const target = resolve(d.target, ['contribution', 'relation'])
        const priorReview = reviews.get(target.id)
        if (priorReview && !ctx.stale.has(priorReview.id)) throw new Error('target already reviewed; revise, evaluate or withdraw it')
        unique(d.evaluations.map(r => r.id), 'evaluation')
        for (const pin of d.evaluations) {
          const evaluation = resolve(pin, ['evaluation'])
          if (target.kind !== 'contribution' || evaluation.data.contribution.id !== target.id) throw new Error('evaluation belongs to another contribution')
        }
        if (d.disposition === 'accepted') {
          if (target.kind === 'contribution') {
            if (!d.evaluations.length) throw new Error('accepted contribution needs an evaluation')
            if ([...evaluations.values()].some(e => e.data.contribution.id === target.id && !ctx.stale.has(e.id) && !d.evaluations.some(pin => pin.id === e.id))) throw new Error('review must account for every current evaluation')
            for (const item of target.data.basedOn) {
              if (!accepted(item.contribution.id)) throw new Error('contribution evidence needs current acceptance')
              refs.push(reviews.get(item.contribution.id).id)
            }
          } else {
            for (const pin of [target.data.subject, target.data.object]) {
              if (!accepted(pin.id)) throw new Error('relation endpoints need current acceptance')
              refs.push(reviews.get(pin.id).id)
            }
          }
        }
        reviews.set(target.id, record)
        break
      }
      case 'withdrawal': {
        const target = ctx.resolve(d.target, ['contribution', 'relation'], false)
        if ([...ctx.entries.values()].some(r => r.kind === 'withdrawal' && r.data.target.id === target.id)) throw new Error('target already withdrawn')
        ctx.invalidate(target.id, `withdrawn:${record.id}`)
        break
      }
      case 'activation':
        unique(d.reviews.map(r => r.id), 'activation review'); unique(d.questions, 'activation question')
        refs.push(domain.id)
        if (d.questions.some(id => !domain.data.questions.some(q => q.id === id))) throw new Error('unknown domain question')
        for (const pin of d.reviews) {
          const review = resolve(pin, ['review'])
          if (!accepted(review.data.target.id)) throw new Error('activation requires accepted current knowledge')
        }
        break
    }
    return refs
  })
  const stale = new Set(state.reconsider.map(r => r.id))
  return { ...state, domain: domain ?? null, accepted: [...reviews.values()].filter(r => r.data.disposition === 'accepted' && !stale.has(r.id) && !stale.has(r.data.target.id)).map(r => r.data.target.id),
    evaluations: Object.fromEntries([...evaluations].map(([id, r]) => [id, { judgment: r.data.judgment, limitations: r.data.limitations, scope: r.data.scope }])),
    semanticTruthVerified: false }
}
