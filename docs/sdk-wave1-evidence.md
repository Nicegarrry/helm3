# Wave 1 Codex SDK evidence

Date: 2026-09-15. Scope: provider-free Astra-driver feasibility for [ACCESS #5](https://github.com/Nicegarrry/helm3/issues/5). This is not a live-access receipt and does not close ACCESS.

## Pin and source

`spikes/sdk-feasibility/package.json` pins `@openai/codex-sdk` to `0.154.0`. The lockfile pins its bundled `@openai/codex` runtime to the same version. `npm view @openai/codex-sdk version engines dist.tarball --json`, observed on 2026-09-15, reported version `0.154.0` and Node `>=18`; the spike used Node `v22.22.2`.

The current [official Codex SDK documentation](https://learn.chatgpt.com/docs/codex-sdk) says the TypeScript SDK is server-side, needs Node 18+, and supports starting, continuing, and resuming local threads. It directs clients that need authentication, approvals, history, and streamed agent events to the Codex app server. The documentation establishes a supported SDK surface; it does not establish this machine's subscription entitlement, available model, quota, or a hard spend bound.

## Actual pinned TypeScript surface

The installed `0.154.0` declarations expose:

| Helm driver operation | Pinned SDK surface | Wave 1 conclusion |
| --- | --- | --- |
| `start` | `new Codex().startThread(options)` | Supported SDK mapping |
| `resume` | `codex.resumeThread(threadId, options)` | Supported SDK mapping |
| `invoke` | `thread.run(input, { signal? })` | Supported SDK mapping |
| event delivery | `thread.runStreamed(input, { signal? })` returns `AsyncGenerator<ThreadEvent>` | Supported SDK mapping |
| cancellation request | per-turn `AbortSignal` | Supported caller-side request; the resulting process outcome must still be observed |
| `interrupt` / `stop` | no SDK method in the installed declarations | Helm must own intent, observation, and `pending`/`unknown` result semantics |
| `checkpoint` / `handoff` | no SDK method in the installed declarations | Helm recovery bundle is authoritative; persisted native thread ID is only a continuation hint |

The thread options include `approvalPolicy`, `sandboxMode`, `networkAccessEnabled`, and web-search controls. These options are process configuration, not proof of Helm policy enforcement or OS containment. `ThreadEvent` includes thread/turn start, completion/failure, item lifecycle, and an error event. `Turn` supplies usage when the underlying runtime reports it, but this cannot establish subscription-pool accounting or an enforceable hard cost ceiling.

## Provider-free conformance evidence

`spikes/sdk-feasibility/codex-sdk-conformance.mjs` runs the installed SDK against a generated local fake Codex executable. It does not invoke an OpenAI endpoint, reads no login state, and passes no API key. The fake executable receives an explicitly limited environment (`PATH` plus two fake-test paths; the SDK adds its internal originator marker), records the SDK CLI arguments, emits local JSONL events, and blocks until its process receives cancellation.

Observed command and result:

```text
PATH=/Users/sa/.nvm/versions/node/v22.22.2/bin:$PATH npm run codex-conformance
{"network":"none; the pinned SDK launched only a generated local fake executable","sdk":"@openai/codex-sdk@0.154.0","lifecycle":{"startThread":true,"run":true,"resumeThread":true,"streamedEvents":true,"abortSignalCancellation":"local child exit observed"},"cancellationObservation":{"timeoutMs":1000,"pid":"observed local PID","localOnly":true},"nativeDriverGaps":["interrupt","stop","checkpoint","handoff"]}
```

The conformance test verifies that the real SDK starts a thread, receives a thread ID from `thread.started`, buffers a completed run, resumes by the returned ID, forwards restrictive thread options to its executable, consumes streamed events, and propagates an aborted turn through `AbortSignal`. For the cancellation case, the fake writes its PID before the stream event; after abort, the test requires both an `exit` marker for that PID and an `ESRCH` process check within 1,000 ms. If either observation misses the finite timeout, the test fails; its `finally` block sends `SIGKILL` to a still-live fake child before removing temporary files. `typecheck.ts` separately compiles the imported SDK classes and event/cancellation types.

This proves local child-process termination through the pinned SDK's `AbortSignal` path. It does not prove provider-side cancellation, zero charge after cancellation, or a native driver `interrupt`/`stop` result. Consistent with the protocol, `cancel_requested` remains only an event until Helm observes the relevant real external outcome; a missing or ambiguous provider observation must be recorded as `pending` or `unknown`.

## ACCESS status and next bounded action

No live subscription request was made. The approved route remains unproven because this evidence cannot demonstrate both the intended subscription authentication route and a finite enforceable bound. There was no login change, purchase, top-up, API-key fallback, or provider request.

Keep #5 open. A later live check needs a human-approved finite per-pool bound, an already-authenticated intended subscription route, and a receipt that records the exact provider/model/auth-source class, request bound, observed usage, cancellation outcome, and unknown quota fields. It must refuse rather than substitute a paid API route if that route is unavailable or cannot meet the declared bound.
