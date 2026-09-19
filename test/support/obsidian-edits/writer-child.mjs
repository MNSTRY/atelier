import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

// A second process that writes a source file the way other programs do, on
// command, so a test can land its write exactly where it wants or let it race.
//
//   node writer-child.mjs <file> <style>
//
//   rename   writes a temporary file beside the source and renames it over it
//   inplace  opens the source once, keeps the descriptor, truncates and writes
//   append   opens the source once for appending, keeps the descriptor, appends
//
// Commands, one per line on stdin:  write <tag> | free <count> <maxDelayMs> <tag> | exit
// Replies, one per line on stdout:  ready | done <tag> <payloadHex> <sha256 of what its file holds now> | freedone
// Every payload is unique, so the test can look for exactly those bytes afterwards.

const [file, style] = process.argv.slice(2)
const say = (line) => process.stdout.write(`${line}\n`)
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
// What the file held when this program opened it: like an editor, it saves that text with its own change.
const opened = fs.readFileSync(file)
const descriptor = style === 'inplace' ? fs.openSync(file, 'r+') : style === 'append' ? fs.openSync(file, 'a+') : null

function readDescriptor(fd) {
  const size = fs.fstatSync(fd).size
  const bytes = Buffer.alloc(size)
  let read = 0
  while (read < size) { const count = fs.readSync(fd, bytes, read, size - read, read); if (count === 0) break; read += count }
  return bytes.subarray(0, read)
}

function write(tag) {
  const payload = Buffer.from(`\nwriter ${style} ${tag} ${randomBytes(12).toString('hex')}\n`)
  let holds
  if (style === 'rename') {
    const content = Buffer.concat([opened, payload])
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${tag}.tmp`)
    fs.writeFileSync(temporary, content)
    fs.renameSync(temporary, file)
    holds = content
  } else if (style === 'inplace') {
    const content = Buffer.concat([opened, payload])
    fs.ftruncateSync(descriptor, 0)
    fs.writeSync(descriptor, content, 0, content.length, 0)
    fs.fsyncSync(descriptor)
    holds = readDescriptor(descriptor)
  } else {
    fs.writeSync(descriptor, payload)
    fs.fsyncSync(descriptor)
    holds = readDescriptor(descriptor)
  }
  say(`done ${tag} ${payload.toString('hex')} ${digest(holds)}`)
}

const lines = readline.createInterface({ input: process.stdin })
lines.on('line', async (line) => {
  const [command, ...rest] = line.trim().split(' ')
  if (command === 'write') write(rest[0])
  else if (command === 'free') {
    const [count, maxDelayMs, tag] = [Number(rest[0]), Number(rest[1]), rest[2]]
    for (let index = 0; index < count; index += 1) {
      await new Promise((resolve) => { setTimeout(resolve, Math.floor(Math.random() * maxDelayMs)) })
      write(`${tag}-${index}`)
    }
    say('freedone')
  } else if (command === 'exit') {
    if (descriptor !== null) fs.closeSync(descriptor)
    lines.close()
    process.exit(0)
  }
})
say('ready')
