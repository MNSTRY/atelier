import { createHash } from 'node:crypto'
import { ObsidianContractRefusal } from '../contracts.mjs'

// Raw byte lens: where the front matter and the body of one Markdown source
// sit, as byte offsets into the Buffer exactly as read. Nothing is decoded into
// a working string, no newline is normalized and no byte is dropped. A source
// the lens cannot delimit with certainty refuses; it is never guessed at.

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])
const LF = 0x0a
const CR = 0x0d
const DASH = 0x2d
const SPACE = 0x20
const TAB = 0x09

export function refuse(code, message, detail = {}) {
  throw new ObsidianContractRefusal(code, message, detail)
}

export function sha256Digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

export function assertStrictUtf8(buffer, detail = {}) {
  if (!Buffer.isBuffer(buffer)) refuse('invalid-source', 'a source must be read as a Buffer', detail)
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer)
  } catch {
    refuse('malformed-utf8', 'source is not valid UTF-8; it is not emitted', detail)
  }
}

// One line starting at `offset`: [contentEnd, nextOffset, eol]. `eol` is
// 'lf', 'crlf' or 'none' (end of buffer).
function lineAt(buffer, offset) {
  const newline = buffer.indexOf(LF, offset)
  if (newline === -1) return { contentEnd: buffer.length, next: buffer.length, eol: 'none' }
  const crlf = newline > offset && buffer[newline - 1] === CR
  return { contentEnd: crlf ? newline - 1 : newline, next: newline + 1, eol: crlf ? 'crlf' : 'lf' }
}

function isDelimiterLine(buffer, start, contentEnd) {
  if (contentEnd - start < 3) return null
  for (let index = start; index < start + 3; index += 1) if (buffer[index] !== DASH) return null
  let trailing = 0
  for (let index = start + 3; index < contentEnd; index += 1) {
    if (buffer[index] !== SPACE && buffer[index] !== TAB) return null
    trailing += 1
  }
  return { trailing }
}

function finalNewlineState(buffer) {
  if (buffer.length === 0 || buffer[buffer.length - 1] !== LF) return 'none'
  return buffer.length > 1 && buffer[buffer.length - 2] === CR ? 'crlf' : 'lf'
}

// Returns { bom, frontmatter, body, finalNewline } with half-open byte ranges.
// `bom` and `frontmatter` are null when absent.
export function readMarkdownLens(buffer, detail = {}) {
  assertStrictUtf8(buffer, detail)
  const hasBom = buffer.length >= 3 && buffer.subarray(0, 3).equals(UTF8_BOM)
  const start = hasBom ? 3 : 0
  const bom = hasBom ? { start: 0, end: 3 } : null
  const whole = { bom, frontmatter: null, body: { start, end: buffer.length }, finalNewline: finalNewlineState(buffer) }

  // A bare carriage return after the opening dashes is a line ending to some
  // readers and ordinary text to others.
  if (buffer.subarray(start, start + 3).equals(Buffer.from('---')) && buffer[start + 3] === CR && buffer[start + 4] !== LF) {
    refuse('ambiguous-frontmatter', 'the opening front matter delimiter ends in a bare carriage return', detail)
  }
  const first = lineAt(buffer, start)
  const opening = isDelimiterLine(buffer, start, first.contentEnd)
  if (!opening) return whole
  // The canonical graph reads a delimiter only as the exact first bytes of the
  // text. Any opening it would read differently from an editor is ambiguous.
  if (hasBom) refuse('ambiguous-frontmatter', 'a byte order prefix precedes a front matter delimiter', detail)
  if (opening.trailing > 0) refuse('ambiguous-frontmatter', 'the opening front matter delimiter carries trailing whitespace', detail)
  if (first.eol === 'none') refuse('ambiguous-frontmatter', 'the source is a lone front matter delimiter', detail)

  let offset = first.next
  let lines = 0
  while (offset < buffer.length) {
    const line = lineAt(buffer, offset)
    if (isDelimiterLine(buffer, offset, line.contentEnd)) {
      if (lines === 0) refuse('ambiguous-frontmatter', 'front matter closes immediately after it opens', detail)
      if (line.eol === 'none') refuse('ambiguous-frontmatter', 'the closing front matter delimiter has no line ending', detail)
      const region = buffer.subarray(start, line.next)
      for (let index = 0; index < region.length; index += 1) {
        if (region[index] === CR && region[index + 1] !== LF) refuse('ambiguous-frontmatter', 'front matter uses a bare carriage return as a line ending', detail)
      }
      return { ...whole, frontmatter: { start, end: line.next }, body: { start: line.next, end: buffer.length } }
    }
    lines += 1
    offset = line.next
  }
  return refuse('ambiguous-frontmatter', 'front matter opens and never closes', detail)
}
