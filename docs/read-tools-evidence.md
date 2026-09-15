# Host read tools

The host creates `createHostReadToolRegistry` from a configured Brief reader,
GitHub Map observer, Economy snapshot and `HostControlPlane`. It exposes only
`brief.get`, `map.get`, `log.query`, `models.get`, and `budget.get`.

The tool input never selects a run, repository, file, credential, SQL query or
provider. The configured context fixes the run and mode. For driver-generated
session IDs, the host supplies `authorize(context)` and must fence it through
the durable owner (for example `HostControlPlane.artifactsFor(context)`) before
each read. The loopback operator endpoint receives the same registry and only
permits the five fixed read paths; `log.query` accepts a bounded `limit` of
1–100.

`log.query` returns event metadata only. It never returns event payloads,
artifact references, provider transcripts, or credentials. `map.get` carries
the GitHub observation timestamp and source. `models.get` and `budget.get`
return the Economy observations unchanged. Run-local reservations and provider
quota observations do not prove pool-wide headroom, so `budget.get.headroom`
is always `unknown` in this slice.

Validation: `npm run typecheck`; `npx tsx --test test/host/read-tools.test.ts`;
`npm test`.
