import assert from 'node:assert/strict';
import test from 'node:test';
import { describeIngestionProcessor, extractIngestionEvidence } from '../src/ingestion/processors.mjs';

const limits = { maxOutputBytes: 1024 * 1024, maxEvidenceItems: 2000 };
const extract = (ref, text, overrides = {}) => extractIngestionEvidence({
  ref, bytes: Buffer.from(text, 'utf8'), limits: { ...limits, ...overrides },
});
const cells = result => result.evidence.map(item => [item.locator.value, item.text]);

test('extension discovery is explicit, stable and independent of returned descriptor mutation', () => {
  for (const [ref, id, format, modality] of [
    ['note.TXT', 'utf8-lines', 'text', 'text'],
    ['notes/page.md', 'utf8-lines', 'markdown', 'text'],
    ['table.csv', 'csv-cells', 'csv', 'tabular'],
    ['data.json', 'json-leaves', 'json', 'structured'],
  ]) {
    const value = describeIngestionProcessor(ref);
    assert.deepEqual([value.id, value.format, value.modality], [id, format, modality]);
    assert.match(value.id, /^[a-z][a-z0-9-]{0,63}$/);
    assert.equal(value.version, '1.0.0');
    assert.equal(value.supported, true);
    assert.ok(value.limitations.some(item => item.includes('extension only')));
    value.limitations.length = 0;
    assert.ok(describeIngestionProcessor(ref).limitations.length);
  }
  assert.equal(describeIngestionProcessor('data.csv?format=json').supported, false);
  assert.equal(describeIngestionProcessor('table.tsv').supported, false);
});

test('multibyte text retains blank physical lines and stable CRLF, LF and CR locations', () => {
  const result = extract('note.txt', 'étoile\r\n\n猫🪁\rfin\n');
  assert.deepEqual(cells(result), [['1', 'étoile'], ['2', ''], ['3', '猫🪁'], ['4', 'fin']]);
  assert.deepEqual(result.evidence.map(item => item.locator.kind), Array(4).fill('line'));
  assert.deepEqual([result.coverage.unit, result.coverage.total, result.coverage.processed,
    result.coverage.omitted, result.coverage.complete], ['line', 4, 4, 0, true]);
  assert.equal(extract('note.txt', '\n').evidence.length, 1);
  assert.equal(extract('note.txt', '\n\n').evidence.length, 2);
});

test('Markdown remains literal source text with no embedded reference or instruction execution', () => {
  const source = '# Draft\n![shape](assets/shape.png)\nRead https://example.invalid/reference\n```sh\nprint a command\n```';
  const result = extract('note.md', source);
  assert.equal(result.evidence.map(item => item.text).join('\n'), source);
  assert.ok(result.coverage.limitations.some(item => item.includes('not processed or followed')));
  assert.equal(result.format, 'markdown');
});

test('one leading UTF-8 BOM is explicitly removed without normalizing remaining text', () => {
  assert.equal(extract('note.txt', '\uFEFF\uFEFFhello').evidence[0].text, '\uFEFFhello');
  assert.deepEqual(cells(extract('table.csv', '\uFEFF"a",b')), [['row:1,column:1', 'a'], ['row:1,column:2', 'b']]);
  assert.deepEqual(cells(extract('data.json', '\uFEFF{"a":1}')), [['/a', '1']]);
});

test('CSV preserves quoted commas, escaped quotes, multiline cells, headers and empty cells', () => {
  const result = extract('table.csv', 'label,description,empty\r\n"é,猫","first\r\nsecond ""quoted""",\r\n');
  assert.deepEqual(cells(result), [
    ['row:1,column:1', 'label'], ['row:1,column:2', 'description'], ['row:1,column:3', 'empty'],
    ['row:2,column:1', 'é,猫'], ['row:2,column:2', 'first\r\nsecond "quoted"'], ['row:2,column:3', ''],
  ]);
  assert.equal(result.coverage.unit, 'csv-cell');
  assert.equal(result.coverage.total, 6);
  assert.equal(result.coverage.processed, 6);
  assert.ok(result.evidence.every(item => item.locator.kind === 'csv-cell'));
});

test('CSV retains ragged rows and formula strings without inference and handles final delimiters', () => {
  assert.deepEqual(cells(extract('table.csv', 'a,b\nx\r1,2,3\n=SUM(A1:A2),')), [
    ['row:1,column:1', 'a'], ['row:1,column:2', 'b'], ['row:2,column:1', 'x'],
    ['row:3,column:1', '1'], ['row:3,column:2', '2'], ['row:3,column:3', '3'],
    ['row:4,column:1', '=SUM(A1:A2)'], ['row:4,column:2', ''],
  ]);
  assert.deepEqual(cells(extract('table.csv', ',')), [['row:1,column:1', ''], ['row:1,column:2', '']]);
  assert.deepEqual(cells(extract('table.csv', '""')), [['row:1,column:1', '']]);
  assert.deepEqual(cells(extract('table.csv', '\r\n')), [['row:1,column:1', '']]);
});

test('malformed CSV quoting refuses complete extraction instead of returning a partial prefix', () => {
  for (const source of ['"unterminated', 'a,b\n"bad', 'a"b,c', '"a" trailing,b', '"a""']) {
    assert.throws(() => extract('table.csv', source), { code: 'INGESTION_INVALID_CSV' });
  }
});

test('JSON primitive leaves use RFC6901 pointers, decoded strings and exact numeric spelling', () => {
  const result = extract('data.json', '{"a/b":{"~key":["猫\\n🪁",false,null]},"":-0,"n":9007199254740993,"e":1.00e+400}');
  assert.deepEqual(cells(result), [
    ['/a~1b/~0key/0', '猫\n🪁'], ['/a~1b/~0key/1', 'false'], ['/a~1b/~0key/2', 'null'],
    ['/', '-0'], ['/n', '9007199254740993'], ['/e', '1.00e+400'],
  ]);
  assert.equal(result.coverage.unit, 'json-leaf');
  assert.ok(result.evidence.every(item => item.locator.kind === 'json-pointer'));
  assert.deepEqual(cells(extract('data.json', '"root"')), [['', 'root']]);
  assert.deepEqual(cells(extract('data.json', 'true')), [['', 'true']]);
});

test('JSON property names that resemble object internals remain ordinary locatable data', () => {
  assert.deepEqual(cells(extract('data.json', '{"__proto__":{"constructor":"value"},"toString":0}')), [
    ['/__proto__/constructor', 'value'], ['/toString', '0'],
  ]);
});

test('invalid JSON and duplicate decoded keys refuse without hidden primitive loss', () => {
  for (const source of ['', '  ', '{', '[1,]', '{"a":1,}', '{"a":1,"a":2}', '{"a":1,"\\u0061":2}',
    '{"a" 1}', '01', '1.', '1e', 'true false', '"unclosed', '"bad\\x"', '"bad\\u00"', '"bad\nline"']) {
    assert.throws(() => extract('data.json', source), { code: 'INGESTION_INVALID_JSON' });
  }
});

test('empty supported projections and unsupported media have distinct coverage', () => {
  for (const [ref, source] of [['note.txt', ''], ['note.md', ''], ['table.csv', ''], ['data.json', '{}'], ['data.json', '[]'], ['data.json', '{"nested":[{},[]]}']]) {
    const result = extract(ref, source);
    assert.deepEqual(result.evidence, []);
    assert.equal(result.coverage.total, 0);
    assert.equal(result.coverage.complete, true);
  }
  for (const [ref, modality] of [['scan.pdf', 'document'], ['photo.png', 'image'], ['note.opus', 'audio'], ['clip.mp4', 'video'], ['archive.zip', 'archive'], ['unknown', 'unknown']]) {
    const result = extractIngestionEvidence({ ref, bytes: Uint8Array.from([255, 0, 254]), limits });
    assert.deepEqual(result.evidence, []);
    assert.equal(result.modality, modality);
    assert.deepEqual([result.coverage.unit, result.coverage.total, result.coverage.processed,
      result.coverage.omitted, result.coverage.complete], ['source', 1, 0, 1, false]);
  }
});

test('invalid UTF-8 refuses text extraction and honours Uint8Array slice offsets', () => {
  for (const bytes of [[0xc3], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xff]]) {
    for (const ref of ['note.txt', 'table.csv', 'data.json']) {
      assert.throws(() => extractIngestionEvidence({ ref, bytes: Uint8Array.from(bytes), limits }), { code: 'INGESTION_INVALID_UTF8' });
    }
  }
  const underlying = Uint8Array.from([255, 65, 66, 255]);
  assert.equal(extractIngestionEvidence({ ref: 'note.txt', bytes: underlying.subarray(1, 3), limits }).evidence[0].text, 'AB');
});

test('evidence and exact serialized-byte bounds refuse rather than truncate', () => {
  for (const [ref, source] of [['note.txt', 'a\nb'], ['table.csv', 'a,b'], ['data.json', '[1,2]']]) {
    assert.throws(() => extract(ref, source, { maxEvidenceItems: 1 }), { code: 'INGESTION_LIMIT', limitKind: 'evidence-items' });
    assert.equal(extract(ref, source, { maxEvidenceItems: 2 }).evidence.length, 2);
  }
  const output = extract('note.txt', '猫🪁');
  const bytes = Buffer.byteLength(JSON.stringify(output), 'utf8');
  assert.deepEqual(extract('note.txt', '猫🪁', { maxOutputBytes: bytes }), output);
  assert.throws(() => extract('note.txt', '猫🪁', { maxOutputBytes: bytes - 1 }), { code: 'INGESTION_LIMIT', limitKind: 'output-bytes' });
  assert.throws(() => extract('note.txt', '', { maxOutputBytes: 0 }), { code: 'INGESTION_LIMIT', limitKind: 'output-bytes' });
  assert.deepEqual(extract('note.txt', '', { maxEvidenceItems: 0 }).evidence, []);
});

test('input and JSON depth ceilings are explicit and limits cannot silently become unbounded', () => {
  assert.throws(() => extractIngestionEvidence({ ref: 'note.txt', bytes: new Uint8Array(16 * 1024 * 1024 + 1), limits }),
    { code: 'INGESTION_LIMIT', limitKind: 'input-bytes' });
  assert.throws(() => extract('data.json', '['.repeat(129) + '0' + ']'.repeat(129)), { code: 'INGESTION_LIMIT', limitKind: 'json-depth' });
  assert.equal(extract('data.json', '['.repeat(128) + '0' + ']'.repeat(128)).evidence.length, 1);
  for (const invalid of [{}, { maxOutputBytes: -1, maxEvidenceItems: 10 }, { ...limits, maxEvidenceItems: Infinity },
    { ...limits, maxOutputBytes: 1.5 }, { ...limits, other: true }]) {
    assert.throws(() => extractIngestionEvidence({ ref: 'note.txt', bytes: Buffer.from('a'), limits: invalid }), { code: 'INGESTION_ARGUMENT' });
  }
  assert.throws(() => extractIngestionEvidence({ ref: 'note.txt', bytes: 'a', limits }), { code: 'INGESTION_ARGUMENT' });
});

test('extraction is deterministic and leaves caller bytes and limits unchanged', () => {
  const bytes = Buffer.from('a,b\n猫,🪁');
  const before = Buffer.from(bytes);
  const bound = Object.freeze({ ...limits });
  const one = extractIngestionEvidence({ ref: 'table.csv', bytes, limits: bound });
  assert.deepEqual(extractIngestionEvidence({ ref: 'table.csv', bytes, limits: bound }), one);
  assert.deepEqual(bytes, before);
  assert.deepEqual(Object.keys(one), ['schema', 'processor', 'format', 'modality', 'coverage', 'evidence']);
});
