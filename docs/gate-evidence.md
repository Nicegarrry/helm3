# Deterministic gate evidence

`src/verification/index.ts` carries the CI classification behaviour from `Nicegarrry/helm-cli@ae5c3ff18ef8c0e12d57973ecb21c928b020b5c7:src/check/index.ts`. Empty checks remain none; neutral/skipped/missing checks do not become green; any failure dominates. This is a selected behaviour import for #19/#20/#22, not the predecessor's whole check/merge service.

The new `runGate` executor runs trusted, host-configured argv checks against a clean exact Git head. It rechecks authority and repository state before each command and verifies state after execution. The raw journal records intent, each executed check (exit/signal/output/timeout) and the final result with immutable refs. Commands that fail stop the gate; head/worktree changes, missing observations, timeout or output overflow produce unknown rather than pass. Command configuration and raw output are protected sensitive artifacts; the host must explicitly permit their persistence before execution starts.

The embedding host still owns validated command admission, leases, workspace writer exclusion and reconciliation. The runner is not an arbitrary-shell model tool, an OS sandbox, independent review, or merge authority. Clean Git observations detect relevant changes but cannot prove no concurrent transient mutation; hold the assigned worktree's writer lease throughout. Timeout kills the direct child and bounds local observation; it cannot prove descendant cancellation. Unknown outcomes require host quarantine/observation before workspace reuse. No automatic retry or cleanup occurs.

## Behavioural tests

`test/verification/gates.test.ts` imports the predecessor CI decision cases and adds native temporary-repository/journal tests. It proves protected exact-head evidence, fail-fast checks, dirty/stale refusal, mutation detection, authority expiry between checks, and honest timeout/output uncertainty. Legacy adapter, template, test-count shell splitting, and review-identity assumptions are not ported. The current runner does not establish full tamper detection or trusted independent approval; those remain in #19/#20.

Run with Node22.22.2: `npm run typecheck` and `npx tsx --test test/verification/gates.test.ts`. Actual wave-PR gate receipts belong on the Map/PR at the exact tested head.
