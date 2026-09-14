# Full-brief acceptance protocol

Status: proposed executable evidence contract; the following scenario is required by source section 35. Implementation is not yet authorised.

## Controlled real-feature run

Use an explicitly approved disposable fixture repository for failure injection, followed by an approved real feature repository. Do not use Helm CLI's active worktrees. All model calls and GitHub mutations require the run's delegated authority; a test fixture is not authority to spend.

| Step | Required observation | Durable evidence |
|---|---|---|
| Human outcome | Short Brief with expected product behaviour and fixed boundaries | Brief version and human ruling |
| Plan | Fable creates/changes the Map within those boundaries | Before/after node versions, reasoning and issue references |
| Parallel execution | At least three overlapping native Pi worker sessions; distinct writer worktrees | Session/attempt IDs, timestamps, ownership records |
| Routing | Fable sees real resource observations and selects legal models | Observation freshness, unknown fields, model/family/pool snapshots |
| Failure | Kill one controlled worker; supervisor retries within lease or wakes Fable when ambiguous | Injected fault, desired/observed state and recovery event |
| Review | Separate session independently reviews the exact implementation head | Reviewer provenance, independence, head SHA and findings |
| Repair | A real failing oracle or confirmed finding requires an implementation change | Failing evidence, repair commit, subsequent passing evidence |
| Integration | Merge uses fresh exact-head oracle/review/CI checks and confirms actual outcome | Command, preconditions, merge receipt and readback |
| Fable restart | Restart Fable mid-run without losing attempts or duplicating effects | Wake identity, recovery trace, durable pending commands |
| Lease | Test expiry and authorised renewal; no new spend after expiry; record in-flight cancellation/accounting limits | Clock/control evidence, refusal and cancellation events |
| Reconciliation | Restart control plane and reconcile dead/alive sessions, worktrees and interrupted integration | Fresh observations, deterministic repairs and ambiguity queue |
| Closure | Fable closes the Map branch only with outcomes evidenced against the original intent | Original acceptance, latest repo facts, closure command |
| Cockpit | Overview, Map, Needs You, Workers, Models and Log agree with machine-readable API | API fixtures/live responses, UI checks, screenshots |

## Fault boundaries

Test crash before dispatch, after external effect but before acknowledgement, and during readback. Re-delivery must not repeat a known effect. Unknown outcomes must trigger observation rather than blind replay. Test lease revocation/expiry across queued and active work, stale evidence after head changes, duplicate/reordered events, and conflicting writer claims. Shell writes outside workspace must be refused by the actual isolation mechanism, not only a mock edit hook.

## Closure dossier

Record exact commits, pinned SDK/runtime versions, gate commands/results, source maps from claims to evidence, run duration, cost and unknown usage, human interventions, Fable wakeups, review/repair rounds and unresolved defects. Mark every check as live-provider, local SDK, deterministic mock, documentation-only or untested. Never substitute one evidence class for another.

## Full design coverage

Section 35 is the first serious end-to-end test, not the entire specification. Before declaring the complete brief delivered, each of source sections 1–39 must map to a implemented capability, retained invariant, demonstrated evidence, or an explicitly approved change. Runtime pause/resume/fork/model change/compaction, context shaping, tracked external cognition, calibration views, two escalation queues, CLI/UI parity and legacy retirement need their own evidence beyond this scenario.
