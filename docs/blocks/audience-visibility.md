The `audience` field in the header is the load-bearing word. It declares who
a source is written for — `public`, `team`, `operator`, `staff`, `private`,
or `sensitive` — and the machinery downstream refuses to let material travel
further than its audience allows. Runtime and export `visibility` is a
separate vocabulary (`private`, `shared`, `platform`, `public`) describing
runtime exposure, and the validators reject every crossing between the two.
Above all: a public export that references a source whose audience is not
public is refused. That check is fixture-pinned and mutation-tested —
deleting its enforcement fails tests, not documentation.
