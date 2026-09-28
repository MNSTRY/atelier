import readline from 'node:readline'

// Questions for a person at a terminal, one line each, over the streams the
// caller gives, so a test types the answers. A question never waits forever:
// no line within the timeout (10 minutes), or the end of the input, is no
// answer, so an agent that was handed a terminal still never hangs. Whether a
// person is there at all is decided before anything is asked
// (src/commands/obsidian.mjs `isInteractive`).

export const ANSWER_TIMEOUT_MS = 10 * 60 * 1000
const MAX_ANSWER_LENGTH = 4096
const clean = (line) => line.slice(0, MAX_ANSWER_LENGTH).trim()

// `ask(question)` writes the question and answers the next line typed, trimmed, or null when none came. A line typed
// before its question is kept for it. `close()` stops reading.
export function createQuestioner({ input, output, timeoutMs = ANSWER_TIMEOUT_MS }) {
  const typed = []
  const waiting = []
  let ended = false
  const lines = readline.createInterface({ input, terminal: false, crlfDelay: Infinity })
  lines.on('line', (line) => { const next = waiting.shift(); if (next === undefined) typed.push(line); else next(line) })
  lines.on('close', () => { ended = true; for (const next of waiting.splice(0)) next(null) })
  return {
    ask(question) {
      output.write(question)
      if (typed.length > 0) return Promise.resolve(clean(typed.shift()))
      if (ended) return Promise.resolve(null)
      return new Promise((resolve) => {
        const answer = (line) => { clearTimeout(timer); resolve(line === null ? null : clean(line)) }
        const timer = setTimeout(() => { waiting.splice(waiting.indexOf(answer), 1); output.write('\n'); resolve(null) }, timeoutMs)
        waiting.push(answer)
      })
    },
    close() { lines.close() },
  }
}

// A go-ahead: Enter, y or yes is yes; n or no is no; anything else is asked again, three times in all. null: no answer.
export async function askGoAhead(questioner, question) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = await questioner.ask(question)
    if (answer === null) return null
    const word = answer.toLowerCase()
    if (word === '' || word === 'y' || word === 'yes') return true
    if (word === 'n' || word === 'no') return false
  }
  return null
}
