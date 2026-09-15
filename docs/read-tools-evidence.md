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

The host reads a requested `log.query` page directly from SQLite in descending
row order with a parameterized 1–100 limit, then restores chronological order.
It selects only metadata expressions; it neither loads event payload bytes nor
uses the supervisor's full-history query (whose 10,000-event overflow remains
a supervisor safety refusal). A persisted 10,001-event run returns only its
latest requested tail.

The CLI streams read-tool JSON with the same 1 MiB cap used for operator
snapshots, cancels an over-cap body, and validates the complete tool-result
envelope before returning it. Real `HostControlPlane` coverage verifies that
the read registry refuses a stale, superseded, or expired durable owner, and
that a run-scoped log cannot expose another run's payload.

Validation: `npm run typecheck`; `npx tsx --test test/host/read-tools.test.ts`;
`npm test`.
