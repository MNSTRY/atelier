export function renderKnowledgePage() {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Knowledge workspace · Atelier</title>
    <style>
      :root {
        color-scheme: light;
        --ink: #202d37;
        --muted: #52616c;
        --line: #cad2d5;
        --paper: #f6f5f0;
        --accent: #215c52;
        --wash: #e8efeb;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        background: var(--paper);
        color: var(--ink);
        font: 16px/1.55 system-ui, sans-serif;
      }
      header {
        padding: 24px 4vw;
        border-bottom: 1px solid var(--line);
        display: flex;
        gap: 20px;
        align-items: center;
        justify-content: space-between;
      }
      .eyebrow {
        text-transform: uppercase;
        font-size: 0.75rem;
        letter-spacing: 0.13em;
        font-weight: 750;
        color: var(--muted);
      }
      h1 {
        font-size: 1.5rem;
        margin: 4px 0;
      }
      h2 {
        font-size: 1.7rem;
        line-height: 1.2;
        margin: 0 0 16px;
      }
      h3 {
        font-size: 1.1rem;
        margin: 0 0 10px;
      }
      p {
        margin: 8px 0 16px;
      }
      .muted,
      small {
        color: var(--muted);
      }
      small {
        font-size: 0.85rem;
      }
      .shell {
        max-width: 1500px;
        margin: auto;
        padding: 28px 4vw;
      }
      .steps {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-bottom: 24px;
      }
      .steps button {
        flex: 1;
        min-width: 112px;
        text-align: left;
        background: transparent;
      }
      .steps button[aria-pressed='true'] {
        background: var(--ink);
        color: white;
        border-color: var(--ink);
      }
      .steps span {
        display: block;
        font-size: 0.75rem;
        opacity: 0.8;
      }
      .layout {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(300px, 390px);
        gap: 32px;
        align-items: start;
      }
      .card {
        padding: 22px;
        background: white;
        border: 1px solid var(--line);
        border-radius: 10px;
        margin-bottom: 16px;
        overflow-wrap: anywhere;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr));
        gap: 14px;
      }
      .grid .card {
        margin: 0;
      }
      .callout {
        border-left: 4px solid var(--accent);
        background: var(--wash);
      }
      .tag {
        display: inline-block;
        padding: 3px 8px;
        border-radius: 4px;
        background: var(--wash);
        font-size: 0.8rem;
        color: var(--accent);
      }
      button,
      input,
      select,
      textarea {
        font: inherit;
        color: inherit;
        min-height: 44px;
        max-width: 100%;
        border: 1px solid #819298;
        border-radius: 5px;
        padding: 9px 12px;
        background: white;
      }
      button {
        cursor: pointer;
        font-weight: 650;
      }
      button.primary {
        background: var(--accent);
        color: white;
        border-color: var(--accent);
      }
      button:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      button:hover:not(:disabled) {
        filter: brightness(0.94);
      }
      button:focus-visible,
      input:focus-visible,
      select:focus-visible,
      textarea:focus-visible,
      summary:focus-visible,
      a:focus-visible {
        outline: 3px solid #477dbe;
        outline-offset: 3px;
      }
      label {
        display: block;
        font-size: 0.9rem;
        font-weight: 650;
        margin: 16px 0 6px;
      }
      input,
      select,
      textarea {
        width: 100%;
      }
      textarea {
        min-height: 155px;
        resize: vertical;
        font-weight: 400;
      }
      fieldset {
        border: 0;
        margin: 0;
        padding: 0;
        min-width: 0;
      }
      fieldset:disabled {
        opacity: 0.75;
      }
      .actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin: 14px 0;
      }
      .notice {
        padding: 12px 16px;
        background: var(--wash);
        border-radius: 6px;
        overflow-wrap: anywhere;
      }
      .error {
        background: #ffeadb;
        color: #6f3114;
      }
      #status {
        margin: 0 0 20px;
      }
      #status:empty {
        display: none;
      }
      #session-status {
        margin: 8px 0;
      }
      pre {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        font: 0.85rem/1.6 ui-monospace, monospace;
        background: #f1f3f3;
        padding: 14px;
        border-radius: 5px;
      }
      details {
        margin: 10px 0;
      }
      summary {
        cursor: pointer;
        min-height: 44px;
        padding: 10px 0;
        font-weight: 650;
      }
      .scroll {
        overflow: auto;
      }
      table {
        border-collapse: collapse;
        width: 100%;
        font-size: 0.9rem;
      }
      th,
      td {
        padding: 12px 10px;
        border-bottom: 1px solid var(--line);
        text-align: left;
        vertical-align: top;
      }
      ul {
        padding-left: 24px;
      }
      .session-list button {
        width: 100%;
        text-align: left;
        margin-top: 8px;
      }
      .session-list small {
        display: block;
        font-weight: 400;
      }
      .skip {
        position: absolute;
        left: 16px;
        top: -100px;
        background: white;
        padding: 12px;
        z-index: 3;
      }
      .skip:focus {
        top: 12px;
      }
      .split {
        display: flex;
        justify-content: space-between;
        gap: 14px;
        align-items: center;
      }
      .saved {
        border-left: 3px solid var(--accent);
        padding-left: 14px;
      }
      .scope {
        font-size: 0.85rem;
        color: var(--muted);
        margin-top: 20px;
      }
      [hidden] {
        display: none !important;
      }
      @media (max-width: 900px) {
        .layout {
          grid-template-columns: 1fr;
        }
        .shell {
          padding: 20px;
        }
        .steps button {
          min-width: 100px;
        }
        header {
          padding: 20px;
        }
      }
      @media (prefers-reduced-motion: no-preference) {
        button {
          transition: background 0.12s;
        }
      }
      @media print {
        button,
        .steps,
        #start-form,
        #editor {
          display: none;
        }
        .layout {
          display: block;
        }
        .card {
          break-inside: avoid;
        }
      }
    </style>
  </head>
  <body>
    <a class="skip" href="#workspace">Skip to workspace</a>
    <header>
      <div>
        <div class="eyebrow">Atelier / knowledge practice</div>
        <h1>Knowledge workspace</h1>
      </div>
      <button id="refresh">Refresh evidence</button>
    </header>
    <main class="shell" id="workspace">
      <p class="notice" id="status" role="status" aria-live="polite">
        Loading the current plan and graph…
      </p>
      <nav class="steps" aria-label="Knowledge workflow" id="steps"></nav>
      <div class="layout">
        <section aria-label="Current workspace">
          <div class="card callout" id="purpose"></div>
          <div class="card">
            <label for="question">Work on a question</label
            ><select id="question"></select>
            <p class="muted" id="work"></p>
          </div>
          <div id="dashboard"></div>
        </section>
        <aside aria-label="Coauthoring">
          <div class="card">
            <div class="eyebrow">
              Human planning → assisted drafting → review
            </div>
            <h2 style="margin-top: 12px">Coauthor the next step</h2>
            <p class="muted">
              One useful question at a time. Saved wording stays in private
              local history.
            </p>
            <form id="start-form">
              <label for="author">Your name or role</label
              ><input
                id="author"
                maxlength="160"
                required
                autocomplete="name"
              /><label for="flow">Guided flow</label
              ><select id="flow"></select
              ><button class="primary" style="margin-top: 16px" id="start">
                Start a session
              </button>
            </form>
            <p
              id="session-status"
              class="notice"
              role="status"
              aria-live="polite"
            >
              Start here, or resume a session below.
            </p>
            <div id="pending-controls" class="notice" hidden>
              <p>
                The request is unconfirmed. Editing is paused so retry sends the
                exact same wording. Reload and export remain available.
              </p>
              <div class="actions">
                <button id="retry-request">Retry exact request</button>
                <button id="end-retry">End retry and inspect history</button>
                <button id="export-request">Export pending request</button>
              </div>
            </div>
            <div id="session" hidden>
              <p id="session-meta" class="muted"></p>
              <p id="source-state" class="notice"></p>
              <div id="recorded-wording"></div>
              <fieldset id="editor">
                <label for="answer" id="prompt"></label>
                <p id="hint" class="muted"></p>
                <textarea
                  id="answer"
                  maxlength="24000"
                  aria-describedby="hint"
                ></textarea>
                <p id="confirmation" hidden>
                  Compare this proposed revision with your original answer.
                  Confirm it before saving.
                </p>
                <div class="actions" id="controls"></div>
              </fieldset>
              <div class="actions">
                <button id="reload-session">Reload session</button
                ><button id="discard" hidden>Discard unsaved text</button
                ><button id="snapshot">Export draft snapshot</button>
              </div>
              <p class="muted">
                Unsaved text remains in this tab. Export a snapshot before
                closing it. Reloading a session preserves your unsaved text.
              </p>
              <div id="bound-context"></div>
              <div id="history"></div>
            </div>
            <p class="scope">
              A saved draft is ready for owner review. It does not edit the
              plan, accept evidence, or authorize an action. Names are locally
              asserted.
            </p>
          </div>
          <div class="card session-list">
            <h3>Continue earlier work</h3>
            <form id="open-session-form">
              <label for="session-id">Open an exact session ID</label>
              <input
                id="session-id"
                required
                placeholder="kg-…"
                autocomplete="off"
              />
              <button id="open-session">Open session</button>
            </form>
            <div id="sessions"></div>
          </div>
        </aside>
      </div>
    </main>
    <script type="module">
      const el = (id) => document.getElementById(id)
      let dashboard = null,
        stage = 'onboard',
        active = null,
        busy = false,
        pending = null,
        endedRequests = [],
        dirty = false,
        contextRequest = 0
      const note = (id, text, error = false) => {
        el(id).textContent = text
        el(id).classList.toggle('error', error)
      }
      function node(tag, text, parent, cls) {
        const item = document.createElement(tag)
        if (text !== undefined) item.textContent = text
        if (cls) item.className = cls
        parent?.append(item)
        return item
      }
      function card(parent, title) {
        const box = node('article', undefined, parent, 'card')
        node('h3', title, box)
        return box
      }
      async function request(route, body) {
        if (!/^[-a-z]+$/.test(route.split('?')[0]))
          throw new Error('Invalid local route')
        const options =
          body === undefined
            ? {}
            : {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
              }
        if (body !== undefined && route !== 'session') {
          const grant = await request('session', {})
          options.headers['X-Atelier-Nonce'] = grant.mutationNonce
        }
        const response = await fetch('/api/knowledge/' + route, options)
        const value = await response.json()
        if (!response.ok || !value.ok)
          throw new Error(value.error || 'Request failed')
        return value
      }
      const selected = () =>
        dashboard?.questions.find((q) => q.id === el('question').value)
      const details = (parent, title, value) => {
        const d = node('details', undefined, parent)
        node('summary', title, d)
        node(
          'pre',
          typeof value === 'string' ? value : JSON.stringify(value, null, 2),
          d
        )
        return d
      }
      function choose(next) {
        stage = next
        for (const b of el('steps').children)
          b.setAttribute('aria-pressed', String(b.dataset.stage === stage))
        el('flow').value = stage
        render()
      }
      async function refresh() {
        try {
          const data = (await request('dashboard')).dashboard
          const old = el('question').value
          dashboard = data
          el('purpose').replaceChildren()
          node(
            'div',
            'THE WORK THIS GRAPH SHOULD IMPROVE',
            el('purpose'),
            'eyebrow'
          )
          node('h2', data.purpose, el('purpose'))
          node('p', data.next.reason, el('purpose'))
          node('small', data.assurance, el('purpose'))
          el('question').replaceChildren()
          for (const q of data.questions) {
            const o = node('option', q.question, el('question'))
            o.value = q.id
          }
          if (data.questions.some((q) => q.id === old))
            el('question').value = old
          if (!el('steps').children.length)
            for (const [i, f] of data.flows.entries()) {
              const b = node('button', undefined, el('steps'))
              b.type = 'button'
              b.dataset.stage = f.id
              node('span', '0' + (i + 1), b)
              node('strong', f.title, b)
              b.onclick = () => choose(f.id)
              const o = node('option', f.title, el('flow'))
              o.value = f.id
            }
          choose(stage)
          note(
            'status',
            'Current plan and graph loaded. Coverage checks do not establish acceptance.'
          )
          await sessions()
        } catch (error) {
          note(
            'status',
            'Workspace unavailable: ' +
              error.message +
              '. Check the plan and restart with atelier dev --knowledge if needed. Earlier session history remains available.',
            true
          )
          await sessions().catch(() => {})
        }
      }
      function render() {
        if (!dashboard) return
        contextRequest++
        const out = el('dashboard')
        out.replaceChildren()
        const flow = dashboard.flows.find((f) => f.id === stage)
        node('h2', flow.title, out)
        node('p', flow.description, out, 'muted')
        el('work').textContent = selected()?.work || ''
        if (stage === 'onboard') {
          const box = card(out, 'People and purpose')
          node('p', 'Steward: ' + dashboard.steward, box)
          node('p', 'Reviewer: ' + dashboard.reviewer, box)
          node(
            'p',
            'These roles and policies are declarations to review with the people involved.',
            box,
            'muted'
          )
          const grid = node('div', undefined, out, 'grid')
          for (const [key, value] of Object.entries(dashboard.governance)) {
            const c = card(grid, key[0].toUpperCase() + key.slice(1))
            node('p', value, c)
          }
          const c = card(out, 'Start small')
          node(
            'p',
            'Choose one permitted source, one consequential question, and one reviewer. Replace the starter plan with your own definitions and test an end-to-end answer before expanding.',
            c
          )
          node(
            'p',
            'Context budget: ' +
              dashboard.budget.maxContextBytes.toLocaleString() +
              ' bytes across at most ' +
              dashboard.budget.maxDocuments +
              ' complete documents.',
            c
          )
        }
        if (stage === 'model') {
          const grid = node('div', undefined, out, 'grid')
          for (const c of dashboard.concepts) {
            const box = card(grid, c.id)
            node('p', c.definition, box)
            node('div', 'Identity rule', box, 'eyebrow')
            node('p', c.identityRule, box)
            node(
              'small',
              (c.coverage?.records ?? 0) +
                ' records · questions: ' +
                (c.coverage?.questions.join(', ') || 'none'),
              box
            )
          }
          const c = card(out, 'Relationships with a reason')
          for (const r of dashboard.relations) {
            node('h3', r.from + ' → ' + r.to, c)
            node('span', r.predicate, c, 'tag')
            node('p', r.meaning, c)
            node(
              'small',
              (r.coverage?.matchingEdges ?? 0) + ' declared matching edges',
              c
            )
          }
          node(
            'p',
            'Coverage describes recorded structure. Review identity, direction, and meaning against the source.',
            c,
            'muted'
          )
        }
        if (stage === 'deepen') {
          const c = card(out, 'Evidence and modeling gaps')
          const issues = [
            ...dashboard.inspection.errors,
            ...dashboard.inspection.warnings,
          ]
          if (!issues.length)
            node(
              'p',
              'No structural gap flagged. Check meaning, contradictions, and an unseen question before calling the model useful.',
              c
            )
          else {
            const list = node('ul', undefined, c)
            for (const issue of issues) node('li', issue, list)
          }
          for (const q of dashboard.evaluation?.cases || []) {
            const g = q.runs.graph
            if (!g.expectedEvidencePresent || g.stale.length) {
              const b = card(out, q.question)
              node(
                'p',
                'Missing evidence: ' +
                  (g.missing.join(', ') || 'none') +
                  '. Changed pins: ' +
                  (g.stale.join(', ') || 'none') +
                  '. Missing relationships: ' +
                  (g.missingRelations.join(', ') || 'none') +
                  '.',
                b
              )
            }
          }
          node(
            'p',
            'Keep unmodeled observations and disagreement visible. A forecast, a proposal, and an observed outcome have different meanings.',
            c
          )
        }
        if (stage === 'apply') {
          const c = card(out, selected()?.question || 'Choose a question')
          node(
            'p',
            'Inspect complete sources before drafting an answer. The context builder selects evidence and makes no model call.',
            c
          )
          const actions = node('div', undefined, c, 'actions')
          for (const mode of ['graph', 'lexical']) {
            const b = node(
              'button',
              mode === 'graph'
                ? 'Inspect graph context'
                : 'Inspect direct-search baseline',
              actions
            )
            b.onclick = () => loadContext(mode)
          }
          node('div', undefined, out).id = 'evidence'
        }
        if (stage === 'learn') {
          const c = card(out, 'Is the graph helping?')
          node(
            'p',
            'The same questions and byte budget are checked with direct metadata search and one hop of declared relationships. These are author-specified retrieval checks.',
            c
          )
          if (dashboard.evaluation) {
            const wrap = node('div', undefined, c, 'scroll'),
              table = node('table', undefined, wrap)
            const tr = node('tr', undefined, node('thead', undefined, table))
            for (const h of ['Question', 'Direct search', 'Graph context'])
              node('th', h, tr)
            const body = node('tbody', undefined, table)
            for (const q of dashboard.evaluation.cases) {
              const row = node('tr', undefined, body)
              node('th', q.question, row)
              for (const mode of ['lexical', 'graph']) {
                const run = q.runs[mode]
                node(
                  'td',
                  (run.expectedEvidencePresent && !run.stale.length
                    ? q.expect === 'abstain'
                      ? 'No evidence retrieved; abstention expected'
                      : 'Expected evidence retained'
                    : 'Needs attention') +
                    ' · ' +
                    run.payloadBytes.toLocaleString() +
                    ' bytes',
                  row
                )
              }
            }
          }
          node(
            'p',
            'Actual tokens, cost, answer correctness, time saved, and user acceptance: not measured by this dashboard.',
            c,
            'notice'
          )
          node(
            'p',
            'Use the Learn flow to retain observed outcomes and measurement notes. Compare unseen questions, including cases where the right answer is “not enough evidence.”',
            c
          )
        }
      }
      async function loadContext(mode) {
        const generation = ++contextRequest
        const q = selected()
        try {
          const result = await request(
            'context?' + new URLSearchParams({ id: q.id, mode })
          )
          if (generation !== contextRequest || stage !== 'apply') return
          const out = el('evidence')
          out.replaceChildren()
          const context = result.context
          const c = card(
            out,
            context.sources.length
              ? 'Evidence selected'
              : 'More evidence needed'
          )
          node(
            'p',
            context.budget.payloadBytes.toLocaleString() +
              ' bytes · approximately ' +
              context.budget.estimatedTokens.toLocaleString() +
              ' tokens · 0 provider calls',
            c
          )
          node(
            'small',
            'Token estimate uses bytes / 4. Actual token usage is unknown. ' +
              context.coverage.omitted +
              ' sources omitted; ' +
              context.coverage.unreadable +
              ' unreadable.',
            c
          )
          node('p', context.use, c)
          for (const source of context.sources) {
            const b = card(out, source.id)
            node(
              'p',
              source.repo +
                '/' +
                source.path +
                ' · lines ' +
                source.lines.start +
                '–' +
                source.lines.end,
              b,
              'muted'
            )
            details(b, 'Read complete source', source.text)
            details(b, 'Source identity', source.sha256)
          }
          details(out, 'Declared relationships', context.relations)
          details(out, 'Context for your agent', context)
        } catch (error) {
          if (generation === contextRequest)
            note('status', 'Context unavailable: ' + error.message, true)
        }
      }
      async function sessions() {
        try {
          const report = await request('sessions')
          const list = report.sessions
          el('sessions').replaceChildren()
          if (report.truncated)
            node(
              'p',
              'Showing the newest ' +
                report.limit +
                ' of ' +
                report.total +
                ' local session files. Open any older session by its exact ID.',
              el('sessions'),
              'muted'
            )
          if (!list.length)
            node('p', 'No sessions yet.', el('sessions'), 'muted')
          for (const s of list) {
            if (!s.available) {
              const box = node('div', undefined, el('sessions'), 'saved')
              node('p', s.id, box)
              node('p', s.reason, box)
              if (s.recoverable) {
                const resume = node('button', 'Resume incomplete start', box)
                resume.onclick = () => send('recover', { sessionId: s.id })
              }
              continue
            }
            const b = node('button', s.title + ' · ' + s.phase, el('sessions'))
            node(
              'small',
              s.question +
                ' · ' +
                s.saved +
                '/' +
                s.fields +
                ' saved' +
                (s.current
                  ? ''
                  : s.currency === 'unavailable'
                  ? ' · source check unavailable'
                  : ' · earlier source revision'),
              b
            )
            node('small', s.id + (s.createdAt ? ' · ' + s.createdAt : ''), b)
            b.disabled = dirty || busy || Boolean(pending)
            b.onclick = () => readSession(s.id)
          }
          setBusy(busy)
        } catch (error) {
          el('sessions').textContent = 'History unavailable: ' + error.message
        }
      }
      function setBusy(value) {
        busy = value
        el('discard').hidden = !dirty
        el('discard').disabled = value || Boolean(pending)
        el('start').disabled = value || dirty || Boolean(pending)
        el('open-session').disabled = value || dirty || Boolean(pending)
        el('reload-session').disabled = value
        el('editor').disabled = value || !active?.current || Boolean(pending)
        el('pending-controls').hidden = !pending
        el('retry-request').disabled = value
        el('end-retry').disabled = value
        el('export-request').disabled = value
        for (const b of el('sessions').querySelectorAll('button'))
          b.disabled = value || dirty || Boolean(pending)
      }
      function renderSession({ preserve = false } = {}) {
        if (!active) return
        el('session').hidden = false
        const { record, state, current } = active
        el('session-meta').textContent =
          record.title +
          ' · ' +
          record.question.question +
          ' · ' +
          record.author +
          ' (locally asserted) · ' +
          state.saved.length +
          '/' +
          state.fields.length +
          ' saved'
        note(
          'source-state',
          current
            ? 'Bound sources still match this session.'
            : active.currency === 'unavailable'
            ? 'Bound sources could not be checked. History is retained; repair the workspace before continuing.'
            : 'Earlier source revision. History is retained; refresh evidence and start a new session to continue.',
          !current
        )
        const prompt = record.prompts[state.index]
        el('start-form').hidden = false
        el('prompt').textContent = prompt?.[1] || 'All draft fields saved'
        el('hint').textContent =
          prompt?.[2] ||
          'Review the retained wording and export it for the source owner.'
        if (!preserve && !dirty) el('answer').value = state.proposal?.text || ''
        const recorded = el('recorded-wording')
        recorded.replaceChildren()
        const field = state.fields[state.index]?.id
        const answers = state.answers.filter((a) => a.fieldId === field)
        if (
          dirty &&
          state.proposal &&
          el('answer').value !== state.proposal.text
        ) {
          node(
            'p',
            'Recorded wording differs from your tab text. Compare it before recording another answer.',
            recorded,
            'notice'
          )
          node('h3', 'Current recorded wording', recorded)
          node('p', state.proposal.text, recorded, 'saved')
          node(
            'small',
            'Session revision ' +
              state.revision +
              '. Recording a new answer keeps both versions in history and makes your wording the current proposal.',
            recorded
          )
        }
        if (answers.length) {
          const history = details(
            recorded,
            'Retained answers for this step',
            answers.map((a) => ({
              text: a.text,
              eventId: a.eventId,
              revision:
                (state.events.find((e) => e.id === a.eventId)?.event
                  .expectedRevision ?? -1) + 1,
            }))
          )
          history.open = Boolean(
            dirty &&
              state.proposal &&
              el('answer').value !== state.proposal.text
          )
        }
        el('answer').hidden = !prompt && !dirty
        el('answer').readOnly =
          !['input', 'draft'].includes(state.phase) && !dirty
        el('confirmation').hidden = state.phase !== 'confirmation'
        el('controls').replaceChildren()
        const action = (title, type) => {
          const b = node(
            'button',
            title,
            el('controls'),
            ['save', 'answer'].includes(type) ? 'primary' : undefined
          )
          b.type = 'button'
          b.onclick = () => intent(type)
        }
        if (['input', 'draft'].includes(state.phase)) {
          action('Record my answer', 'answer')
          if (state.phase === 'draft') action('Save private draft', 'save')
        }
        if (state.phase === 'confirmation') {
          details(el('controls'), 'Proposed wording', state.proposal.text)
          details(
            el('controls'),
            'Original wording',
            state.answers.find(
              (a) => a.eventId === state.proposal.originalEventId
            )?.text || ''
          )
          action('Confirm revised wording', 'confirm')
          action('Keep original wording', 'reject')
        }
        if (state.phase === 'saved') action('Continue', 'advance')
        if (state.phase === 'paused') action('Resume', 'resume')
        else if (
          ['input', 'draft', 'confirmation', 'saved', 'recovery'].includes(
            state.phase
          )
        )
          action('Pause', 'pause')
        if (state.phase === 'recovery' && state.pending.retries < 1)
          action('Retry private save', 'retry')
        if (state.phase === 'saving')
          action('Reconcile pending save', 'recover')
        if (state.phase === 'recovery' && state.pending.retries >= 1)
          node(
            'p',
            'Retry exhausted. Preserve history for operator reconciliation.',
            el('controls')
          )
        el('bound-context').replaceChildren()
        details(
          el('bound-context'),
          'Evidence captured for this session',
          record.context || 'No context available at session start.'
        )
        el('history').replaceChildren()
        for (const saved of state.saved) {
          const box = node('div', undefined, el('history'), 'saved')
          node(
            'h3',
            record.prompts.find((p) => p[0] === saved.fieldId)?.[1] ||
              saved.fieldId,
            box
          )
          node('p', saved.text, box)
          details(box, 'Durable draft receipt', saved.receipt)
        }
        setBusy(busy)
      }
      async function readSession(id) {
        try {
          active = await request('read?' + new URLSearchParams({ id }))
          renderSession({ preserve: dirty })
          note(
            'session-status',
            'Session loaded. ' +
              (dirty
                ? 'Your unsaved text is still in the editor.'
                : 'Saved drafts and retained intents were read from local history.')
          )
          await sessions()
          return true
        } catch (error) {
          note('session-status', 'Session unavailable: ' + error.message, true)
          return false
        }
      }
      async function send(route, input) {
        pending = { route, input }
        setBusy(true)
        try {
          active = await request(route, input)
          pending = null
          dirty = false
          renderSession()
          note(
            'session-status',
            active.current
              ? operationMessage(route, input, active.state)
              : 'Sources changed during the operation. Retained history is available; start a newly bound session.'
          )
          await sessions()
        } catch (error) {
          note(
            'session-status',
            'Not confirmed saved: ' +
              error.message +
              '. Your wording remains here. If the service is unavailable, restore atelier dev --knowledge and retry. For a revision, source, or event refusal, end retry and inspect history before another intent.',
            true
          )
        } finally {
          setBusy(false)
        }
      }
      function operationMessage(route, input, state) {
        const step = ' Current step: ' + state.phase + '.'
        if (['saving', 'recovery'].includes(state.phase))
          return (
            'Save not confirmed. Preserve your wording and inspect the recovery controls.' +
            step
          )
        if (route === 'start')
          return 'Session started. Its retained state was read back.' + step
        const type = input.event?.type
        if (type === 'answer')
          return (
            'Answer retained in session history; this request did not save a draft.' +
            step
          )
        if (
          type === 'save' &&
          state.saved.some((s) => s.receipt.requestId === input.event.id)
        )
          return 'Saved draft receipt read back.' + step
        if (
          (type === 'retry' || route === 'recover') &&
          state.phase === 'saved'
        )
          return 'Saved draft receipt read back.' + step
        if (type === 'reject' || type === 'confirm')
          return (
            'Wording choice recorded; save the private draft when ready.' + step
          )
        return 'Session state read back.' + step
      }
      async function intent(type) {
        if (pending)
          return note(
            'session-status',
            'Resolve the pending request with Retry or End retry before recording another intent.',
            true
          )
        if (!active || busy) return
        if (dirty && type !== 'answer')
          return note(
            'session-status',
            'Record or export your changed answer before moving on.',
            true
          )
        if (type === 'recover')
          return send('recover', { sessionId: active.record.id })
        const event = {
          id: crypto.randomUUID(),
          type,
          expectedRevision: active.state.revision,
        }
        if (type === 'answer') {
          event.text = el('answer').value
          if (!event.text.trim())
            return note('session-status', 'Write an answer first.', true)
        }
        await send('event', { sessionId: active.record.id, event })
      }
      el('start-form').onsubmit = (event) => {
        event.preventDefault()
        if (pending)
          return note(
            'session-status',
            'Resolve the pending request before starting another session.',
            true
          )
        if (!dashboard || busy || dirty) return
        send('start', {
          requestId: crypto.randomUUID(),
          flow: el('flow').value,
          questionId: selected().id,
          snapshot: dashboard.snapshot,
          author: el('author').value,
        })
      }
      el('discard').onclick = () => {
        dirty = false
        renderSession()
        note(
          'session-status',
          'Unsaved tab text discarded. Retained session history is unchanged.'
        )
      }
      el('answer').oninput = () => {
        dirty = true
        setBusy(busy)
        note(
          'session-status',
          'Unsaved wording in this tab. Record it to retain the answer in session history.'
        )
      }
      el('question').onchange = render
      el('refresh').onclick = refresh
      el('reload-session').onclick = () =>
        active && readSession(active.record.id)
      el('retry-request').onclick = () =>
        pending && !busy && send(pending.route, pending.input)
      el('end-retry').onclick = async () => {
        if (!pending || busy) return
        const ended = pending
        endedRequests.push(ended)
        pending = null
        setBusy(false)
        if (active) {
          if (!(await readSession(active.record.id))) return
        } else await sessions()
        note(
          'session-status',
          'Retry ended; no server history was deleted or cancelled. Inspect the session before another intent. Your text and the ended request remain in this tab and its exported snapshot. Session: ' +
            (ended.input.sessionId || 'kg-' + ended.input.requestId)
        )
      }
      el('open-session-form').onsubmit = (event) => {
        event.preventDefault()
        if (busy || dirty || pending)
          return note(
            'session-status',
            'Resolve your current wording and pending request before opening another session.',
            true
          )
        readSession(el('session-id').value.trim())
      }
      function exportSnapshot() {
        if (!active && !pending && !endedRequests.length) return
        const value = {
          status: 'private-draft-for-owner-review',
          sourceEditsApplied: false,
          session: active,
          unsavedText: dirty ? el('answer').value : null,
          pendingRequest: pending,
          endedRequests,
        }
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(value, null, 2)], {
            type: 'application/json',
          })
        )
        const a = document.createElement('a')
        a.href = url
        a.download =
          'knowledge-draft-' +
          (active?.record.id || pending?.input.requestId || 'request') +
          '.json'
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
        note(
          'session-status',
          'Private draft snapshot exported. Review its audience before sharing.'
        )
      }
      el('snapshot').onclick = exportSnapshot
      el('export-request').onclick = exportSnapshot
      window.addEventListener('beforeunload', (event) => {
        if (dirty || pending) {
          event.preventDefault()
          event.returnValue = ''
        }
      })
      refresh()
    </script>
  </body>
</html>
`
}
