import { createCoauthorStore } from '../coauthor/store.mjs';

const usage = 'Usage: atelier coauthor start|read|event|recover\nRead one JSON request from stdin (maximum 1 MiB). Start: {"config":...}; read/recover: {"sessionId":...}; event: {"sessionId":...,"event":...}. Workspace is the current directory. Saves are private drafts, not source edits.';
const command = process.argv[2];
if (command === '--help' || command === 'help') { console.log(usage); process.exit(0); }
try {
  if (!['start', 'read', 'event', 'recover'].includes(command) || process.argv.length !== 3) throw new Error(usage);
  const chunks = [];
  let count = 0;
  for await (const chunk of process.stdin) {
    count += chunk.length;
    if (count > 1024 * 1024) throw new Error('request exceeds byte ceiling');
    chunks.push(chunk);
  }
  const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('object required');
  const allowed = command === 'start' ? ['config'] : command === 'event' ? ['sessionId', 'event'] : ['sessionId'];
  if (Object.keys(input).some(key => !allowed.includes(key)) || allowed.some(key => !Object.hasOwn(input, key))) throw new Error('invalid request fields');
  const store = createCoauthorStore();
  const state = command === 'start' ? store.start(input.config) : command === 'read' ? store.read(input.sessionId)
    : command === 'recover' ? store.recover(input.sessionId) : store.dispatch(input.sessionId, input.event);
  console.log(JSON.stringify({ ok: true, state, savedMeaning: 'private-draft-only' }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
}
