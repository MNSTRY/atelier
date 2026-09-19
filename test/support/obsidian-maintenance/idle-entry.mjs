#!/usr/bin/env node
// An entry that never becomes the maintenance service: it listens nowhere,
// writes no record and simply stays alive. `start` has to notice that health
// never proves ownership, stop this one child and report the private log.
process.stdout.write('idle entry: alive, and not a service\n')
setInterval(() => {}, 1000)
