import test from 'node:test'

export const capabilityWriteTest = (name, fn) => test(name, {
  skip: process.platform === 'win32' ? 'Capability and harness writes require a qualified POSIX filesystem; Windows refusal is tested separately.' : false,
}, fn)
