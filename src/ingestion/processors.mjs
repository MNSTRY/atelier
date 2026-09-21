// Pure structural projections. No source reference or embedded instruction is executed.
const VERSION = '1.0.0';
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ITEMS = 100000;
const DISCOVERY = 'Processor selection uses the filename extension only; content type is not verified.';
const REFERENCES = 'Embedded media, external references and instructions are not processed or followed.';
const UTF8 = 'Input must be valid UTF-8; one leading UTF-8 BOM prefix is removed.';

function refuse(code, message, limitKind) {
  throw Object.assign(new Error(message), { code, ...(limitKind ? { limitKind } : {}) });
}
function limit(message, kind) { refuse('INGESTION_LIMIT', message, kind); }

export function describeIngestionProcessor(ref) {
  if (typeof ref !== 'string' || !ref || ref.length > 4096 || ref.includes('\0')) {
    refuse('INGESTION_ARGUMENT', 'A bounded source reference is required');
  }
  const filename = ref.split(/[\\/]/).at(-1);
  const extension = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1).toLowerCase() : '';
  const definitions = {
    txt: ['utf8-lines', 'text', 'text', 'Line evidence preserves text and blank lines, excludes line terminators and does not create a final empty line after a terminator.'],
    text: ['utf8-lines', 'text', 'text', 'Line evidence preserves text and blank lines, excludes line terminators and does not create a final empty line after a terminator.'],
    md: ['utf8-lines', 'markdown', 'text', 'Markdown is projected as source lines, not rendered or interpreted; line terminators are excluded and a final terminator creates no extra empty line.'],
    markdown: ['utf8-lines', 'markdown', 'text', 'Markdown is projected as source lines, not rendered or interpreted; line terminators are excluded and a final terminator creates no extra empty line.'],
    csv: ['csv-cells', 'csv', 'tabular', 'CSV evidence contains decoded cell strings including headers and empty cells; ragged rows are retained, and types, headers and formulas are not interpreted.'],
    json: ['json-leaves', 'json', 'structured', 'JSON evidence contains primitive leaves only; empty containers have no evidence. Strings are decoded; number tokens, booleans and null retain their source spelling. Duplicate decoded object keys are refused.'],
  };
  if (Object.hasOwn(definitions, extension)) {
    const [id, format, modality, projection] = definitions[extension];
    return { id, version: VERSION, format, modality, supported: true,
      limitations: [DISCOVERY, UTF8, REFERENCES, projection, 'Complete coverage applies only to the named structural projection, not semantic acceptance.'] };
  }
  const unsupported = {
    pdf: 'document', doc: 'document', docx: 'document', rtf: 'document', odt: 'document',
    html: 'document', htm: 'document', xml: 'document', xlsx: 'tabular', xls: 'tabular',
    png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', tiff: 'image',
    mp3: 'audio', wav: 'audio', m4a: 'audio', opus: 'audio', ogg: 'audio', flac: 'audio',
    mp4: 'video', mov: 'video', webm: 'video', zip: 'archive', gz: 'archive', tar: 'archive',
  };
  const known = Object.hasOwn(unsupported, extension);
  return { id: 'unsupported-source', version: VERSION, format: known ? extension : 'unknown',
    modality: known ? unsupported[extension] : 'unknown', supported: false,
    limitations: [DISCOVERY, REFERENCES, 'No built-in structural processor supports this source type; no content was extracted.'] };
}

function argumentsFor(bytes, limits) {
  if (!(bytes instanceof Uint8Array)) refuse('INGESTION_ARGUMENT', 'Input bytes must be a Uint8Array or Buffer');
  if (bytes.byteLength > MAX_BYTES) limit('Input exceeds the 16 MiB processor ceiling', 'input-bytes');
  if (!limits || typeof limits !== 'object' || Array.isArray(limits) ||
      Object.keys(limits).some(key => !['maxOutputBytes', 'maxEvidenceItems'].includes(key))) {
    refuse('INGESTION_ARGUMENT', 'Explicit output and evidence limits are required');
  }
  for (const [key, ceiling] of [['maxOutputBytes', MAX_BYTES], ['maxEvidenceItems', MAX_ITEMS]]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 0 || limits[key] > ceiling) {
      refuse('INGESTION_ARGUMENT', 'Processor limits must be nonnegative integers within the built-in ceilings');
    }
  }
}

function lines(text, emit) {
  const endings = /\r\n|\n|\r/g;
  let start = 0, line = 1, match;
  while ((match = endings.exec(text))) {
    emit('line', String(line++), text.slice(start, match.index));
    start = match.index + match[0].length;
  }
  if (start < text.length) emit('line', String(line), text.slice(start));
}

function csvCells(text, emit) {
  let cursor = 0, row = 1, column = 1;
  const invalid = () => refuse('INGESTION_INVALID_CSV', 'CSV has invalid quoting');
  while (cursor < text.length) {
    let value;
    if (text[cursor] === '"') {
      cursor++;
      let start = cursor, closed = false;
      const parts = [];
      while (cursor < text.length) {
        if (text[cursor] !== '"') { cursor++; continue; }
        parts.push(text.slice(start, cursor));
        if (text[cursor + 1] === '"') {
          parts.push('"'); cursor += 2; start = cursor; continue;
        }
        cursor++; closed = true; break;
      }
      if (!closed) invalid();
      if (cursor < text.length && ![',', '\r', '\n'].includes(text[cursor])) invalid();
      value = parts.join('');
    } else {
      const start = cursor;
      while (cursor < text.length && ![',', '\r', '\n'].includes(text[cursor])) {
        if (text[cursor] === '"') invalid();
        cursor++;
      }
      value = text.slice(start, cursor);
    }
    emit('csv-cell', `row:${row},column:${column}`, value);
    if (cursor === text.length) break;
    if (text[cursor] === ',') {
      cursor++; column++;
      if (cursor === text.length) emit('csv-cell', `row:${row},column:${column}`, '');
    } else {
      const crlf = text[cursor] === '\r' && text[cursor + 1] === '\n';
      cursor += crlf ? 2 : 1; row++; column = 1;
    }
  }
}

function jsonLeaves(text, emit) {
  let cursor = 0;
  const invalid = () => refuse('INGESTION_INVALID_JSON', 'JSON is malformed or contains duplicate object keys');
  const whitespace = () => { while (cursor < text.length && /[ \t\r\n]/.test(text[cursor])) cursor++; };
  const pointerKey = key => key.replaceAll('~', '~0').replaceAll('/', '~1');
  function string() {
    if (text[cursor] !== '"') invalid();
    const start = cursor++;
    while (cursor < text.length) {
      const current = text[cursor++];
      if (current === '"') {
        try { return JSON.parse(text.slice(start, cursor)); } catch { invalid(); }
      }
      if (current.charCodeAt(0) < 0x20) invalid();
      if (current !== '\\') continue;
      if (cursor === text.length) invalid();
      const escape = text[cursor++];
      if (escape === 'u') {
        if (!/^[0-9a-fA-F]{4}$/.test(text.slice(cursor, cursor + 4))) invalid();
        cursor += 4;
      } else if (!'"\\/bfnrt'.includes(escape)) invalid();
    }
    invalid();
  }
  function value(pointer, depth) {
    if (depth > 128) limit('JSON exceeds the nesting ceiling of 128', 'json-depth');
    whitespace();
    const next = text[cursor];
    if (next === '"') { emit('json-pointer', pointer, string()); return; }
    if (next === '{') {
      cursor++; whitespace();
      if (text[cursor] === '}') { cursor++; return; }
      const keys = new Set();
      while (cursor < text.length) {
        whitespace();
        const key = string();
        if (keys.has(key)) invalid();
        keys.add(key); whitespace();
        if (text[cursor++] !== ':') invalid();
        value(`${pointer}/${pointerKey(key)}`, depth + 1); whitespace();
        const separator = text[cursor++];
        if (separator === '}') return;
        if (separator !== ',') invalid();
      }
      invalid();
    }
    if (next === '[') {
      cursor++; whitespace();
      if (text[cursor] === ']') { cursor++; return; }
      let index = 0;
      while (cursor < text.length) {
        value(`${pointer}/${index++}`, depth + 1); whitespace();
        const separator = text[cursor++];
        if (separator === ']') return;
        if (separator !== ',') invalid();
      }
      invalid();
    }
    for (const literal of ['true', 'false', 'null']) {
      if (text.startsWith(literal, cursor)) {
        cursor += literal.length; emit('json-pointer', pointer, literal); return;
      }
    }
    const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    number.lastIndex = cursor;
    const match = number.exec(text);
    if (!match) invalid();
    cursor = number.lastIndex;
    emit('json-pointer', pointer, match[0]);
  }
  value('', 0); whitespace();
  if (cursor !== text.length) invalid();
}

export function extractIngestionEvidence({ ref, bytes, limits } = {}) {
  const descriptor = describeIngestionProcessor(ref);
  argumentsFor(bytes, limits);
  const evidence = [];
  let evidenceBytes = 2;
  const emit = (kind, value, text) => {
    if (evidence.length >= limits.maxEvidenceItems) limit('Extraction exceeds the evidence item limit', 'evidence-items');
    const item = { locator: { kind, value }, text };
    evidenceBytes += Buffer.byteLength(JSON.stringify(item), 'utf8') + (evidence.length ? 1 : 0);
    if (evidenceBytes > limits.maxOutputBytes) limit('Extraction exceeds the output byte limit', 'output-bytes');
    evidence.push(item);
  };
  let unit = 'source';
  if (descriptor.supported) {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { refuse('INGESTION_INVALID_UTF8', 'Source is not valid UTF-8'); }
    if (descriptor.id === 'utf8-lines') { unit = 'line'; lines(text, emit); }
    else if (descriptor.id === 'csv-cells') { unit = 'csv-cell'; csvCells(text, emit); }
    else { unit = 'json-leaf'; jsonLeaves(text, emit); }
  }
  const result = {
    schema: 'mnstry.atelier-ingestion-extraction@v1',
    processor: { id: descriptor.id, version: descriptor.version },
    format: descriptor.format, modality: descriptor.modality,
    coverage: { unit, total: descriptor.supported ? evidence.length : 1,
      processed: evidence.length, omitted: descriptor.supported ? 0 : 1,
      complete: descriptor.supported, limitations: [...descriptor.limitations] },
    evidence,
  };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > limits.maxOutputBytes) {
    limit('Extraction including its coverage envelope exceeds the output byte limit', 'output-bytes');
  }
  return result;
}
