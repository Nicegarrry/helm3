# Wave 4 observed progress — 15 September 2026

The user approved continuing Wave 4 and onward overnight under the [recorded authority](overnight-authority.md). This is an evidence checkpoint, not full Brief acceptance. GitHub Map #1 and issue state remain authoritative.

## Accepted foundations

PR #61 records the overnight authority. PR #62 adds immutable economy facts and role/data-policy-aware Core admission. PR #63 adds fixed-route, bounded native Pi requests and validated token settlement. PR #64 adds durable supervisor signals, coalesced judgement wakes and pure recovery classification. PR #65 adds guarded fresh GitHub Map mutations. Each was independently reviewed with executable tests and green exact-head CI before coordinator integration.

Their combined main head `c5b4e24810ea9129bd40f968e20e423daa2900d6` passed `npm run typecheck` and all **123 tests** with Node 22.22.2 and a private frozen dependency installation. Individual review heads were:

| PR | Reviewed head | Independent validation |
| --- | --- | --- |
| #62 | `ac8b5f4c91e51524aba841a0f37db7080c6945d8` | 103 tests, typecheck and economy policy regression probes |
| #63 | `ce4ecb973694cce92095dd9296b600be440896ff` | Standards: 101 tests; Spec: 14 targeted tests; typecheck and adversarial configuration/usage probes |
| #64 | `3201358997d9764598330a623b58f41d2ee58375` | 100 tests, typecheck and takeover-at-acknowledgement probe |
| #65 | `3f59684a13b21d970d7b618c1b779690c1b801d5` | 104 tests, typecheck and final target revision regression |

PR #62's final head `4abc7a3c9fef2ad5e0ad0b57a2a1adac3474b4a2` only combined the already-reviewed supervisor/main changes with the economy code; the combined suite passed 108 tests and CI was green before merge.

## Real native Pi dogfood

The coordinator used the accepted `BoundedPiAccess`, `createBoundedPiWorkerBinding`, `PiNativeRuntime`, `HostControlPlane` and `WorkspaceManager` against the pinned `opencode-go/kimi-k2.7-code` route. Credentials stayed outside Git and worker context. This was an actual Pi SDK session with Helm worktree ownership, command admission, durable reservation, raw semantic events and a structured terminal envelope.

The synthetic attempt `pi-synthetic-3a6ca189-085a-44de-8d5d-7ad6e417d47e` succeeded. Its US$1.34742016 upper bound settled to US$0.0008727 using validated provider token fields and frozen nominal prices. This does not establish actual incremental subscription billing or known quota headroom.

A subsequent read-only engineering-review attempt exposed a failure-path defect: the model command became `unknown`, while the parent host process failed to finish promptly. The coordinator stopped that local process, verified its absence, revoked the attempt lease and used host restart recovery. The model effect and attempt remain `unknown`; the full US$1.34742016 reservation remains charged to the guard. It has not been replayed. The resulting combined committed guard is **US$1.34829286 of US$10**.

[Sanitised attempt and reservation evidence](evidence/wave4-live-pi-20260915.json) records this checkpoint. Detailed raw artifacts and the persistent ledger remain in local operational storage. The coordinator was the existing Codex conversation; this is not evidence of a Helm Astra-driver invocation or Fable/Astra interchange.

## Guarded Map dogfood

The coordinator updated Map #1 through the accepted mutator inside an admitted, claimed and executed Kernel command. The adapter re-read membership and the exact issue revision before PATCH, rechecked host ownership/lease/hash authority, then confirmed the requested body by readback. It preserved the existing body and appended a dated progress section. The [receipt](evidence/wave4-map-mutation-20260915.json) records success at revision `2026-09-15T12:23:32Z`. GitHub issue PATCH remains read-before-write rather than an atomic revision CAS. No issue was closed.

## Remaining work

The Pi failure-termination regression and fix, executable supervisor/host dispatch, and exact-head integration are active work. The existing supervisor library does not yet prove continuous reconciliation or actual retry dispatch. Integration PR #66 is under final review. A full accepted engineering review/repair/merge loop, live frontier orchestration, consultation, context lifecycle, failover, calibration and the complete original/addendum acceptance scenarios remain open.

Unknown outcomes remain visible. A successful access probe is not closure of ACCESS #5, which also requires the active-orchestrator route and wider bounded-access evidence.
