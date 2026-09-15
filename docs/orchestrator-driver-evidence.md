# Provider-free Fable and Astra driver evidence

Status: local adapter evidence on 2026-09-15. This is not a live-provider,
authentication, entitlement, quota, pricing, or interchange result.

## Implemented mapping

`src/runtime/orchestrator/index.ts` provides the small shared lifecycle
contract: start, resume, event delivery, invocation, interrupt, checkpoint,
handoff and stop. It keeps SDK details inside the two provider drivers.

| Driver | Pinned SDK and production mapping | Local evidence |
| --- | --- | --- |
| Fable | `@anthropic-ai/claude-agent-sdk` `0.3.270`; dynamic import of `query`, `tool` and `createSdkMcpServer`; explicit host `env`, `cwd` and `model` options; `permissionMode: 'dontAsk'`, no built-in tools, and `strictMcpConfig`. | `test/runtime/orchestrator-driver.test.ts` passes a typed `zod/v3` Helm domain shape to the actual SDK `tool` and `createSdkMcpServer` constructors, then calls the registered handler during an injected local query stream. |
| Astra | `@openai/codex-sdk` `0.154.0`; dynamic `Codex` construction from explicit host `env`, optional config and executable path; `startThread`, `resumeThread` and `runStreamed` map to the driver lifecycle. | The same test runs the actual pinned SDK against a generated local executable and observes start, event streaming, resume and abort. `test/runtime/review-races.test.ts` exercises lifecycle races. |

The Fable registry and Helm domain shapes use `zod/v3`, matching the frozen
contract schemas. This prevents a Zod v4 registry object from rejecting a
valid domain v3 shape before the handler runs.

Helm assigns a UUID-based session identity. A provider thread/session ID is
recorded only after a matching SDK event is observed. A recovery bundle carries
the run, Helm session, mode, context/event refs, observed provider ID and a
required host recovery-state reference. Resume restores that host reference
into the next prompt context; an SDK continuation is only a hint.

The supplied `OrchestratorSessionGuard`, `OrchestratorArtifacts`, and
`OrchestratorRecoveryState` are required host integrations. The guard is
checked before lifecycle mutations and immediately before a Fable tool effect.
The artifact/recovery implementations are responsible for trusted ownership,
durability and the actual Brief/Map/Log recovery manifest.

## Boundaries still open

- No SDK call contacted a provider. The fixtures do not prove account access,
  OAuth, model availability, subscription/API route, spend bounds, remote
  cancellation, quota, or provider-side session behavior.
- This is a driver library, not a runnable Helm control-plane service. It does
  not establish live model/pool authorization, internal SDK request bounding,
  takeover cleanup, service/API integration, or production guard/artifact
  implementations.
- Astra reports its in-process Helm tool bridge as unsupported because the
  pinned `ThreadOptions` surface has no in-process callback or MCP server
  configuration. A loopback MCP transport is a separate future slice.
- These adapters do not establish full Helm-tool parity, a live small-feature
  orchestration trace, cross-provider takeover, or comparable Fable/Astra
  interchange. Those acceptance items remain open in [DRIVER #27](https://github.com/Nicegarrry/helm3/issues/27), [ASTRA #29](https://github.com/Nicegarrry/helm3/issues/29), and their dependent live-provider work.

## Regression coverage

`test/runtime/orchestrator-driver.test.ts` covers a typed Fable MCP callback
during an active invocation, late/revoked tool ownership, consultant refusal,
failed durable checkpoint storage, Astra start/resume/abort and restoration
context. `test/runtime/review-races.test.ts` covers cancellation during Fable
setup, the final resume-guard race with a concurrent active invocation, and
persistence of already-observed Fable events when the stream fails. All run
against injected SDK seams or the local executable; neither test is live proof.
