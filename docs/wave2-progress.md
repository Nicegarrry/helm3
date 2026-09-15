# Helm 3 wave-two progress and continuation

2026-09-15. GitHub remains authoritative for issue and PR state. This document records implementation evidence, not completion of the full Brief.

## Implemented slices

- [PR #44](https://github.com/Nicegarrry/helm3/pull/44), merged: explicit supervised wave-two scope and boundaries.
- [PR #45](https://github.com/Nicegarrry/helm3/pull/45), merged: an approval-gated Pi subscription access harness. Ten provider-free cases exercise OAuth-only admission, exact provider/model/response validation, error handling and a bounded local deadline. No live request was made. See [access evidence](sdk-wave2-access.md).
- [PR #46](https://github.com/Nicegarrry/helm3/pull/46), merged: durable parent authority, lease limits, typed attempt identity, per-node attempt and concurrency limits, current model facts, resource reservations, retained actual consumption, protected reserves and cancellation quarantine. Independently reviewed at `250343ef69026019f853ae3305488ef9cfaa4f76`; 42 tests and CI passed. See [authority evidence](wave2-authority-evidence.md).
- [PR #47](https://github.com/Nicegarrry/helm3/pull/47): native Pi 0.85.1 library integration, external durable worktree ownership, controlled writes, exact envelopes, semantic journal events, repair, session reopen and bounded cancellation observation. Check the PR for current integration status and final exact-head review. See [native evidence](wave2-pi-evidence.md).

The combined local suite has 47 tests. Its native Pi test uses the SDK's packaged faux provider with in-memory fake credentials, not a remote model. Three provider requests cross real kernel authority and settle three request units under one attempt; a fourth is refused even after reopen. Local failure tests demonstrate unknown cancellation when a stream ignores abort, later observed stop, expiry between model turns, isolated workspace ownership and malformed-envelope preservation.

## Remaining acceptance

[ACCESS #5](https://github.com/Nicegarrry/helm3/issues/5) and [PI-SLICE #11](https://github.com/Nicegarrry/helm3/issues/11) remain open. Pi does not use the existing Codex CLI login automatically. Its own OpenAI Codex OAuth credentials were absent at the non-refreshing status observation. The human is unavailable for interactive OAuth until tomorrow (expected 2026-09-16). Login is deferred until they return; no consent is inferred from elapsed time. Current scope excludes account/login changes, purchases and paid API fallback.

The approved bounded access harness supports one request, no retries, no tools and a 30-second local deadline using the intended existing subscription. Provider output ceiling, subscription headroom and remote cancellation remain unknown where the SDK/provider does not expose them. A local deadline is not a guaranteed remote spending cutoff.

After the login decision, validate the intended provider/model route and record the receipt. Then prove a real native worker with linked worktree/session/command/evidence under explicit runtime authority. While OAuth is deferred, construct both orchestrator drivers against the shared Helm domain contract and exercise local lifecycle, tool and recovery conformance. After authentication, prove the real native slice and driver interchange, then continue consultation, supervisor, quality integration and cockpit evidence. Live-proof dependencies do not block independent construction. The library currently requires trusted host wiring; there is no complete runnable control-plane service or end-to-end Fable/Astra driver.

AUTHORITY #7, WORKSPACE #10 and EXTENSION #12 have substantial partial implementation but remain open for their full acceptance. The authority slice does not yet supply a complete supervisor escalation/refusal classification service. The worker exposes one controlled write tool; broader tools, full runtime topology, context management and OS-level shell isolation are not established. A controlled tool surface is not an OS sandbox.

The predecessor handoff [#3](https://github.com/Nicegarrry/helm3/issues/3) is still independent. Its repository, worktrees, tests and working state were not accessed. Do not infer an immutable handoff from historical status.

## Continue safely

Read [AGENTS.md](../AGENTS.md), [wave-two authority](wave2-authority.md), the immutable original and addendum, and fresh GitHub Map/PR state. Preserve existing worktrees. Use Node 22.22.2 and reproduce the relevant commands:

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
python3 scripts/check-preparation.py
```

The separate access harness tests run in `spikes/sdk-feasibility` with `npm run pi-access-probe-test`; never enable the live probe without its specific approval and established route. Review and CI remain tied to exact PR heads. No unattended Helm run lease has been issued.
