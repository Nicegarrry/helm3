# GitHub Map mutation evidence

## Scope

This Wave 4 slice adds a narrow adapter for `map.update` and `map.close`.
It preserves GitHub as the Map authority: a fresh native sub-issue snapshot
proves that the target belongs to the configured Map, and a separate GitHub
issue read establishes the exact repository, issue number and `updated_at`
revision immediately before the effect.

The adapter accepts only immutable-command-shaped input. Before a PATCH it
calls an injected authority boundary, which must return a permit bound to the
same `commandId` and `idempotencyKey`. The permit is a kernel integration seam:
the kernel must durably claim the immutable command before issuing it. This
module deliberately has no process-local replay guard, and its returned receipt
does not make an unknown effect durable or replayable.

## Mutation and recovery contract

`map.update` may change a nonempty issue title and/or body. It requires a
GitHub precondition naming the exact issue revision and a scope that names the
configured repository and target Map node. Foreign, stale, incomplete, or
authority-refused targets return `refused` before a PATCH.

`map.close` PATCHes only `state=closed`. It additionally requires nonempty
evidence references bound to the immutable command, a nonempty closure
rationale, and an explicit set of resolved dependencies that exactly matches a
fresh GitHub dependency observation. Every dependency page is bounded, and the
adapter re-reads each dependency's own issue state rather than trusting a
relationship summary. Every observed dependency must already be closed. The
authority permit must return the exact evidence references it verified; supplied
references are claims until that happens. This is evidence/dependency/rationale
closure, not an arbitrary checklist workflow.

The result is a frozen receipt containing the Kernel-compatible hash of the
exact `JSON.stringify` command bytes, observed target state and one of
`succeeded`, `refused`, or `unknown`. Any failed or
unreadable write response is `unknown`; callers must persist it through the
kernel and reconcile GitHub before another command is considered. The adapter
does not retry mutations.

GitHub issue REST PATCH offers no conditional revision/CAS operation used by
this slice. A final GET followed by PATCH is therefore explicitly recorded as
`read_before_write_not_atomic`: it reduces stale writes but cannot promise that
another writer did not change the issue in the interval. The readback confirms
only the observed outcome. Stronger concurrency guarantees require a GitHub
conditional facility or a higher-level serialized writer, neither of which is
claimed here.

## Root-only bounded dogfood path

After this change is merged and the kernel wraps the effect with its durable
command claim, the root operator may dogfood one bounded `map.update` against
the live Helm Map: fresh-read the selected root issue identity/revision and
body, append a dated Wave 4 evidence paragraph while preserving all existing
body text, invoke the kernel-issued permit, then read the issue back and retain
the command and receipt. This document grants no authority to run that effect,
and it does not close an issue. A closure requires real acceptance evidence,
resolved dependencies and rationale at the time of the separate close command.

## Provider-free verification

The fixture suite covers successful fresh update/readback, stale and foreign
refusal, pre-effect authority order, mismatched kernel permit refusal, ambiguous
write classification without replay, and closure refusal/success based on fresh
dependency state. It does not prove live GitHub credentials, live mutation
availability, kernel persistence, or atomic multi-writer concurrency.
