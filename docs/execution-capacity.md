# Execution capacity and unresolved costs

Worker limits are per human authority and per autonomy lease, not a fixed three-worker limit. A lease can narrow its parent's limit. These are operator configuration values; unrelated or expired grants must not be added together and presented as one active limit.

The host API `readExecutionCapacity(authorityId)` returns the parent limit and its source, occupied execution slots, stopped attempts with unresolved outcomes, and child lease limits/revocation/expiry. Concurrency refusals identify the limiting authority or lease and report occupied/maximum. A caller still needs an unexpired, nonrevoked lease and sufficient budget even when a slot is free.

A worker outcome, local execution liveness and provider billing are different facts. The existing native `pi.worker.stop` receipt proves a whole local session stopped. Helm validates its raw bytes, journal identity, succeeded launch, attempt, session, provider and model provenance. When remaining uncertain commands are only model requests, this proof can release execution capacity without changing their unknown outcomes or monetary reservations. Snapshots expose `executionReleased` and the stop evidence reference separately from the attempt's state.

Released attempts stay fenced: queued commands cannot execute, new commands cannot join them, old effect identities are not replayed, and attempt-count and monetary limits remain in force. Queued commands have not started and remain fenced after release. In-flight commands and unknown non-model effects still require reconciliation. A missing process handle, elapsed time, an agent's own claim, or an absent PID is not a substitute for the native stop receipt.

Restart reconciliation reuses durable stop receipts. Old attempts without sufficient evidence stay unresolved and must be reported honestly; operators should not delete them or settle unknown costs to zero to obtain a slot. The SQLite migration preserves existing rows and defaults them to unreleased.
