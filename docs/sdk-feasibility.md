# SDK feasibility spike — 2026-09-15

## Boundary

This is preparation evidence only. It does not authorise a Helm runtime, a provider request, a login, a cost-bearing model probe, or migration from Helm CLI. All executable probes are under `spikes/sdk-feasibility`, use a temporary directory, and delete it on exit. They do not read account credential files or environment credential values.

## Reproduce

```sh
cd spikes/sdk-feasibility
/Users/sa/.nvm/versions/node/v22.22.2/bin/npm ci --ignore-scripts
/Users/sa/.nvm/versions/node/v22.22.2/bin/node node_modules/typescript/bin/tsc -p tsconfig.json
/Users/sa/.nvm/versions/node/v22.22.2/bin/node probe.mjs
/Users/sa/.nvm/versions/node/v22.22.2/bin/node sandbox-smoke.mjs
```

Pinned direct packages in `package-lock.json`:

| Package | Version | Purpose |
| --- | ---: | --- |
| `@earendil-works/pi-coding-agent` | 0.85.1 | Current Pi session/runtime surface |
| `@earendil-works/pi-ai` | 0.85.1 | Pi-native faux provider and in-memory credential store |
| `@anthropic-ai/claude-agent-sdk` | 0.3.270 | Claude typed tool and session surface |
| `@anthropic-ai/sandbox-runtime` | 0.0.76 | Local process isolation candidate |
| `zod` | 4.6.5 | Direct schema dependency; its `zod/v3` compatibility export matches the Claude tool declaration |

`npm ci --ignore-scripts`, the TypeScript schema check, and both local probes completed on the repository-pinned Node 22.22.2 binary. npm reported no audit findings; the spike does not run `npm audit fix`.

## Observed local evidence

The Pi probe uses Pi's packaged faux provider with an in-memory fake key. It calls `session.prompt()`, but that prompt consumes two deterministic local faux responses; it does not call a remote provider or spend model tokens. The observed result was:

```json
{
  "pi": {
    "created": true,
    "noTools": "all",
    "fauxProviderCalls": 2,
    "forbiddenToolSideEffect": false,
    "reopenedSdkSessionIdMatches": true,
    "reopenedPersistedHeaderIdMatches": true,
    "reopenedName": "offline-persisted-session"
  },
  "claude": {
    "typedToolName": "record_evidence",
    "typedToolHandlerNotInvoked": true,
    "mcpServerCreated": true
  }
}
```

Pi also emitted structured `agent_start`, `turn_start`, `message_start`, `message_end`, `tool_execution_start`, `tool_execution_end`, `turn_end`, and `agent_end` events to a `session.subscribe` listener. The faux model requested `bash` while `noTools: "all"` was active. The tool lifecycle events arrived, but `must-not-run` was absent from the temporary working directory. Assertions make the probe fail if these conditions, durable reopen, or the expected faux-response count change. This proves the local tool suppression path for this installed version; it does not prove a production policy layer.

Pi did not write the session file until an assistant message was present. After the faux completion, a reopened `SessionManager` and a reopened SDK session had the same persisted session id and the assigned name. This is a real persistence/reopen result, and it means a coordinator must not assume a just-created, pre-turn session is durable.

The Claude probe imports `tool`, creates a Zod-typed tool from the SDK's required raw Zod shape, creates an SDK MCP server, and constructs `InMemorySessionStore`. `typecheck.ts` validates that same call against the installed TypeScript declarations. Neither probe invokes `query()` or the handler. This validates module loading and typed-tool construction only.

Read-only CLI readiness was filtered to non-sensitive fields only. The CLI output has `loggedIn` (not `isAuthenticated`), plus `authMethod`, `subscriptionType`, and `apiProvider`; it reported `loggedIn: true`, `authMethod: "claude.ai"`, `subscriptionType: "max"`, and `apiProvider: "firstParty"`. This is still **inconclusive** for Agent SDK and Pi use: it is not a provider compatibility test. Pi used an isolated `ModelRuntime` with an in-memory fake credential store and no account credential or environment value was read.

The sandbox smoke initialises `@anthropic-ai/sandbox-runtime` with no allowed network domains and permits writes only to one temporary directory. It asserts an allowed write succeeds while an explicitly denied write, an unlisted outside write, and a symlink escape from the allowed directory all fail. It uses macOS `sandbox-exec` already on this machine, starts only local runtime components, changes no settings file or machine configuration, then resets the manager and removes its temporary directory. This is a disposable-process boundary result; full Pi-worker confinement remains untested.

## Capability matrix

| Need | Pi 0.85.1 | Claude Agent SDK 0.3.270 | Evidence / conclusion |
| --- | --- | --- | --- |
| Create and subscribe | Yes | `query()` produces a controllable `Query` object | Pi observed; Claude package surface inspected only |
| Steer / follow-up | `session.steer()` and `session.followUp()` | `Query` supports input/control methods | Installed declarations/source inspected; unexercised |
| Resume / persistence | `SessionManager.open()` and session files | `resume`, session functions, and `SessionStore` declarations | Pi observed with faux model; Claude unexercised |
| Fork | Session-manager and RPC fork paths | `forkSession()` declaration | Package surface only |
| Compact | `session.compact()` | compact hooks/events and session controls | Package surface only; a compaction call needs model behaviour |
| Change model | `session.setModel()` | model options and model-switch hooks | Package surface only; real auth/provider compatibility unknown |
| Tool interception | `noTools: "all"`; extension tool hooks | typed tools plus `PreToolUse` hooks | Pi observed suppression with deterministic faux tool call; Claude package surface only |
| Process isolation | Pi example extension wraps bash through ASRT | can be placed outside SDK process boundary | ASRT local smoke observed; integration with either SDK untested |

## Recommended shape for the later build proposal

Use Pi's native session runtime as the worker owner: it owns the session file, event stream, replacement/reopen flow, and Pi-native tools. Run Fable as a first-class Claude Agent SDK process with its own documented session/control surface. Do not flatten those two systems into a generic portable harness. The durable external record should track only the narrow cognition that crosses process boundaries: immutable command id, lease generation, worktree path, evidence references, process ownership, and final reconciliation state.

Run worker commands through a per-worktree sandbox configuration that allows the worktree and an explicit scratch directory, blocks credential paths and writes outside those paths, and has a deny-by-default network allowlist. The successful local ASRT test is a candidate mechanism, not approval to rely on it for production isolation. The build phase needs a fresh integration test through the actual worker adapter.

Lease expiry cannot be treated as an SDK cancellation guarantee. On expiry or restart, the supervisor should mark the attempt `cancelling`, send the adapter interrupt, wait for process exit for a bounded interval, terminate the owned child process if necessary, and reconcile the recorded command/evidence/commit state before a new lease starts. Any late event carries the old lease generation and is stored as stale evidence, never applied as a current success.

## Open risks and required build-time evidence

- **Live provider compatibility: UNKNOWN.** No account credential files or environment values were read, and no Pi or Claude provider call was attempted. Auth source compatibility, available models, billing, quota, and actual model change behaviour all require an explicitly authorised bounded live probe.
- **Auth readiness is not enough.** The read-only Claude CLI status has `loggedIn: true` plus `claude.ai`/`max` metadata. Do not infer that this can authenticate the Agent SDK, a custom provider, or Pi. The future bounded probe must explicitly record provider, model id, auth source class (never secret), request result, and charge bound.
- **Pi upgrade risk.** The spike now pins the supported `@earendil-works/*` 0.85.1 namespace. Pi's SDK shape changed from the deprecated namespace (notably `ModelRuntime` replaces the former auth/registry surface), so upgrades require this exact no-network probe again.
- **Claude session API remains unexercised.** Typed tools and an in-memory store load locally, but fork/resume semantics, hook ordering, interrupt receipts, and persistence need a no-cost or authorised bounded integration test.
- **Sandbox is not a lease mechanism.** Its filesystem boundary does not establish process ownership, cancellation, or durable reconciliation. It is one enforcement layer beneath the supervisor.
- **The empty-session durability edge is material.** Persist the Helm command/lease before creating a worker session; do not use the existence of a Pi in-memory session as recovery evidence.

## Upstream sources consulted

- Pi coding agent package and programmatic SDK documentation: <https://www.npmjs.com/package/@earendil-works/pi-coding-agent>, <https://github.com/earendil-works/pi>
- Claude Agent SDK TypeScript reference: <https://docs.anthropic.com/en/docs/claude-code/sdk/sdk-typescript>
- Anthropic Sandbox Runtime package and README: <https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime>, <https://github.com/anthropics/sandbox-runtime>

The source pages and installed package declarations describe capabilities. The observed section above is the only runtime evidence from this spike.
