# Orchestrator SDK readiness — addendum planning

Status: documentation check on 2026-09-15, not an executed Codex SDK probe. The existing [SDK spike](sdk-feasibility.md) remains evidence only for its Pi/Claude/local sandbox checks. No provider calls, authentication changes or new runtime dependencies were introduced for this addendum revision.

## Astra / Codex

The official TypeScript SDK documentation describes `@openai/codex-sdk`, `Codex.startThread()`, continuing with `thread.run()`, and `resumeThread(threadId)`. It describes local server-side use. The same page points custom clients needing authentication, approvals and streamed-event management toward Codex app-server. These are documented surfaces, not proof that all eight proposed Helm driver operations have direct SDK equivalents. [Official Codex SDK documentation](https://learn.chatgpt.com/docs/codex-sdk)

Codex documents ChatGPT subscription sign-in and API-key access as distinct routes for local clients; API-key usage is billed separately. This does not establish this repository's exact SDK/model entitlements, quota availability or pool accounting. ACCESS must verify the chosen route with an authorised finite request. Do not silently fall back from subscription to paid API usage. [Official authentication documentation](https://learn.chatgpt.com/docs/auth)

## Fable / Claude

Earlier local evidence covers Claude Agent SDK typed-tool construction, not a live Fable run or subscription interoperability. Preserve the addendum's intended Claude subscription route as a target; do not label it verified from a CLI login. The driver must use an actually supported, authorised route and report any mismatch before spending.

## Consequences for the plan

- Keep the driver contract small: lifecycle, event delivery, invocation, interruption, checkpoint, handoff and stop. Reasoning policy stays in the active orchestrator; workers remain Pi-native.
- Map each method to a tested SDK operation, a Helm-owned durable mechanism, or an explicitly unsupported capability. A driver must not report checkpoint/cancellation merely because a method name exists.
- Checkpoint and handoff correctness rest on Helm's Brief/Map/Log recovery bundle. Native thread/session continuation is an optimisation; cross-provider failover cannot require another provider to interpret the predecessor's transcript.
- SDK-native tool injection, approval hooks, event delivery and interrupt semantics must be proved against a pinned version during the first wave. If a Codex SDK surface requires its app-server protocol internally, keep that detail inside the Astra driver and record the decision; do not swap in a generic worker harness.
- Benchmark parity means identical domain contracts and comparable starting evidence/workloads with one controller per run. It does not promise identical model reasoning or a scientifically conclusive ranking from a single run.
- Cross-provider failover needs a healthy and authorised backup route plus available reserve. Two configured driver names alone provide no operational redundancy.
