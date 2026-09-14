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

## Read-only subscription-route and control observation

The following status observations were made on 2026-09-15 without a provider request, exposing credential values, login change, purchase, top-up, or API-key fallback:

- `codex login status` reported an existing ChatGPT login. The process environment did not expose `CODEX_API_KEY` or `OPENAI_API_KEY`. This establishes a locally available Codex subscription-auth route, but not entitlement to any particular model or quota.
- `claude auth status` reported an existing `claude.ai` first-party subscription session with the `max` subscription class. This establishes a locally available Claude subscription-auth route, but not a provider quota, a dollar estimate, or a Fable execution receipt.
- The package-local Pi CLI's non-refreshing `auth check --provider openai-codex --no-refresh --json` and equivalent Anthropic check both returned `credentials_not_configured`. Pi authentication is therefore unresolved on this host. This is an absent configured Pi route, not evidence that a subscription quota is empty or exhausted.

The installed Codex SDK exposes `AbortSignal` per turn and thread configuration for approval policy, sandbox, network access, and web search. It does not expose `maxTurns`, `maxTokens`, a wall-clock timeout, a no-tools switch, or a retry limit. A host can bound one SDK invocation and impose a local timeout, but that does not prove provider-side cancellation or a token ceiling.

The installed Claude Agent SDK exposes `abortController`, `tools: []`, tool allow/deny lists, `permissionMode`, `maxTurns`, `maxBudgetUsd`, and alpha `taskBudget`; the local Claude CLI documents its dollar-budget switch as API-key-only. The installed Pi package exposes `noTools: 'all'`, tool allow/deny configuration, offline mode, and an RPC auto-retry control, but no configured provider route was observed.

These observations distinguish two constraints that must both stay visible. `docs/protocol.md` requires fail-closed behaviour when an actual delegated hard pool cap cannot be enforced. Neither the human first-wave authority nor the Brief imposes a new finite dollar or token cap here. Separately, ACCESS #5 retains its finite per-pool planned-bound requirement for any later live probe. That is a ticket-level planning constraint, not a direct human-imposed dollar or token ceiling; before a live request, Helm must declare and enforce the applicable planned bound or refuse. Unknown quota and flat-subscription cost remain unknown and must be recorded as such; they are not invented as a hard cap or treated as unlimited authority.

## ACCESS status and next bounded action

No live SDK or subscription request was run. The earlier provider-free conformance result remains the only SDK execution evidence: it used a generated local fake executable and proves no authentication, entitlement, provider cancellation, quota, or cost fact.

Keep #5 open. If separately authorised, the smallest Codex subscription-only probe is one pinned-SDK `thread.run` invocation with no `apiKey`, no retry or fallback, a host-owned finite timeout, read-only sandbox, `approvalPolicy: 'never'`, and network/web search disabled. Its receipt must record the observed model/auth-source class, usage if returned, cancellation outcome, and unknown quota fields. It must not substitute a paid API route. This document records a proposal only; it does not claim that probe succeeded.
