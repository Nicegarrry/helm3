# Helm 3 agent contract

## Current authority

Wave 2 is now explicitly approved: “Ok to proceed with wave 2”. See [wave-two scope and acceptance](docs/wave2-authority.md). This supersedes first-wave-only wording for the supervised next slice; all predecessor, spending, login and isolation boundaries below remain applicable.

The human explicitly approved the first implementation wave after context clean on 2026-09-15: “pick up the handoff and review map and the first wave. Let’s get working using mostly Luna/terra workers and reviewers please”. The scoped decision is recorded in [APPROVAL #2](https://github.com/Nicegarrry/helm3/issues/2#issuecomment-5671903235) and [wave-one authority](docs/wave1-authority.md). Implement and review that foundation in isolated worktrees and integrate reviewed PRs. No purchases, top-ups, incremental paid API fallback, unattended Helm run lease or predecessor import is authorised. Public SDK/package reads and local provider-free tests remain permitted.

Do not read, modify, fetch, build, test, index, dispatch into, or otherwise interfere with `/Users/sa/code/other/helm-cli` or its worktrees until an explicit immutable handoff. Opus is finishing Milestone 1 there. Do not infer completion from historic state. Await an explicit handoff and immutable commit SHA.

## Durable contract

- The human owns the Brief. Proposals must not silently change fixed requirements. The full original design and its addendum are authoritative together.
- The Map is fluid; GitHub is authoritative for issue/PR state. Documents are dated projections.
- Agents are disposable; command/evidence/handoff records are durable.
- Re-read authority and relevant external facts immediately before effects.
- Unknown quota/cost remains unknown. No live provider probe without an authorised bounded cost.
- One writer per isolated worktree; PR-only product work. Workers do not merge their own work.
- Verify each worker brief against the accepted design and ticket before dispatch.
- Root bootstrap commits are permitted for the authorised empty-repository preparation only.
- Keep secrets, local account files, transcripts, and dependency trees out of Git.
- Models choose workflows; machinery enforces authority, evidence and recovery.
- One active, replaceable frontier orchestrator owns mutation at a time: Fable via Claude Agent SDK or Astra via Codex SDK. Helm's small driver normalises lifecycle/tool calls, never reasoning behaviour; Pi remains the one native worker runtime.
- An orchestrator ownership lease and its monotonic epoch fence queued and at-effect mutating commands. It is distinct from the bounded Autonomy Lease that controls spend and effects.

## Working method

Use Terra for bounded implementation/investigation and Luna for mechanical tasks and documentation. Frontier coordination resolves interface decisions and acceptance. Prefer at most three workers plus coordinator, and increase only against demonstrated machine/provider capacity. Workers must report commands and observed results, distinguish mocks from live-provider evidence, and preserve WIP on interruption.

Prefer codebase-memory-mcp for code discovery: search_graph, trace_path, get_code_snippet, query_graph, search_code. Run index_repository first when unindexed. Use file search for non-code/config/string literals or insufficient graph results. Do not index the predecessor repository.

Context clean and first-wave approval are now recorded. Subsequent autonomous waves require their actual delegated scope and bounds; elapsed time is not authority.
