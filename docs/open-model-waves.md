# Current continuation — 17 September 2026

The user renewed autonomous building and asked to minimise ChatGPT usage. This section supersedes historical run deadlines, spending allocations and the old 35% coordination pause below. Use native Pi open/Gemini workers first; any ChatGPT worker must be Luna, with frontier use confined to coordination and consequential decisions.

Current bounded run: 06:05:35–10:05:35 UTC on 17 September. The combined US$20 ceiling and all prior reservations remain intact. At renewal, conservative ledger liability was US$15.476677786 plus US$0.04 external-probe reserve. New pool allocations are US$3.50 for existing open/Gemini work, US$0.90 for OpenRouter paid work and US$0 for free inference. These are maximum commitments, not invoices. Earlier unresolved reservations are not reset or released. Shorter per-attempt leases apply, and expiry stops new spending/effects.

## Next acceptance wave

1. Qualify the explicit public-only free Nemotron route (#132), keep its cost class separate from capability, and update the [model roster](model-roster.md) from real evidence. OpenRouter/DeepSeek integration is merged in PR131; full live task completion remains open in #130 after shared-pool429 failures.
2. Finish operational work that reduces coordinator intervention: host-owned review publication (#112), trusted local-gate merge evidence (#111), pause/stop/resume (#115), and machine-resource admission (#116). Retain normal native-command acceptance (#126) and dispatch explanation (#114).
3. Continue the remaining quality/integration, orchestrator interchange/takeover, cockpit/calibration and full-feature soak waves below. Report accepted outcomes and remaining gaps between waves; do not equate helper completion with end-to-end acceptance.

Free inference still needs bounded concurrency, request counts, authority expiry and measured quality. Do not change account-wide privacy settings or fall back to a paid model/provider. Public/synthetic-only consent does not permit exporting local transcripts or private source.

---

# Open-model build waves — 16 September 2026

The human approved the proposed remaining-work plan and requested reports between waves. The original design and addendum remain authoritative. “Wave 0” below is the new qualification wave; historical numbered waves/PRs remain unchanged.

## Execution authority

Use predominantly open-model native Pi workers. Qwen, GLM and Kimi are candidate families; Meta Muse Spark 1.3 is also requested, and Gemini 3.8 Flash is explicitly permitted as a lower-cost proprietary option. Model choice remains an orchestrator decision. No automatic paid fallback or deterministic model router is introduced. Catalogue presence, valid credentials and successful inference are separate evidence levels.

Conserve Codex for coordination, consequential decisions and narrow escalation. Observe its remaining quota between waves and pause at 35% remaining; this is an operational threshold, not a claim that per-task consumption is predictable. Start with one qualifying request at a time; grow to two builders plus an independent different-family reviewer only after successful bounded tasks. Actual tasks must use Helm/Pi, not relabelled conversation subagents.

Retain the original combined US$10 ceiling across the supplied OpenCode and Gemini accounts. The expired grant has US$5.42051699 committed, including US$5.38968064 in unresolved reservations. Renewal allocates only the US$4.57948301 remainder, in the same durable database and pool, under a new immutable time authority. The original grant and reservations are untouched. The new grant's cap plus inherited commitments cannot exceed US$10; unknown usage remains held. Initial execution expires at 2026-09-16T02:15:00Z, with shorter per-attempt leases. The previous heartbeat remains paused.

Do not enable Zen balance fallback, auto-reload, paid upgrades or contributor-data training. Muse's Go contributor route is not cleared for private repository context. Interactive OAuth remains a separate prerequisite when needed. GitHub Actions failure remains a merge blocker, not a reason to skip required checks.

## Remaining waves

| Wave | Outcome | Exit proof |
| --- | --- | --- |
| 0 | Qualify bounded live model routes and fix discovered compatibility failures | Real useful tasks, typed envelopes, native tool effects, independent verification and cumulative accounting |
| 1 | Normal Helm API/CLI performs issue to worker to gates to review to repair to PR | An actual Helm improvement built and reviewed through Helm; coordinator merges labelled separately |
| 2 | Continuous supervisor, process/session reconciliation, lease-safe retries and wake delivery | Worker/host restart without duplicate effects; expiry stops spending |
| 3 | Production evidence-bound integration and Map closure | Real merge with both source/target authority preserved and confirmed readback |
| 4 | Live Astra/Fable composition, consultation and takeover | Both drivers execute comparable work; old epochs refused; valid fleet preserved |
| 5 | Live cockpit, calibration, context reporting and remaining import parity | CLI/UI agree with live authority/evidence; unknowns remain visible |
| 6 | Complete real-feature acceptance and soak | Three workers, independent review, repair, restart/takeover, merge and Map/UI agreement; legacy retired only after proof |

Waves may overlap once dependencies are stable. Report verified outcomes, remaining gaps, spend/reservations and the next wave before advancing. The estimate is roughly two days as a target and 48–72 hours as a planning allowance after blockers clear; re-estimate from accepted-task throughput, not agent counts or test counts.

## Route facts and observed compatibility

- Pi 0.85.1 and the account model list contain `opencode-go/glm-5.1`, `qwen3.7-plus`, Kimi variants and `google/gemini-3.8-flash`.
- Gemini 3.8 Flash supports low/medium/high thinking. `minimal` is rejected; Pi 0.85.1 also maps `off` to MINIMAL. A live low-thinking request returned a valid WorkerResult and measured usage. Do not generalise to other Gemini versions/providers.
- GLM 5.1 produced an HTTP 200 response with known usage after omitting the generic reasoning-effort hint, but its initial investigation envelope had an invalid prefix. Transport success is not task acceptance. Bounded same-session correction should preserve useful context.
- Qwen 3.7 Plus has higher prices above 256K input tokens; full-context reservations must use the higher tier. The SDK's low-tier catalogue values alone are insufficient for the current conservative full-window bound.
- Muse Spark 1.3 contributor routes permit training on prompts/completions. No private-code request has been made on that route. A standard route requires separately verified endpoint, data policy, access and budget authority.

Sources: [OpenCode Go](https://opencode.ai/docs/go/), [OpenCode Zen data policy](https://opencode.ai/docs/zen/), [Gemini 3.8 model](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash), [Gemini prices](https://ai.google.dev/gemini-api/docs/pricing). Retrieved 2026-09-16. These public facts are not account headroom observations.

## Wave 0 build evidence (in progress)

A Qwen 3.8 Flash worker, through accepted Helm/Pi code, wrote the compatibility helper and a staged test artifact in an isolated worktree. Four real requests, including bounded same-session envelope correction, completed with a valid WorkerResult. The coordinator installed the test artifact, wired the helper before native session initialization and added a native-start regression. The worker did not write protected runtime/test paths, execute tests or merge its own work. Source worker commit: `5d85766`.

The resulting behavior refuses unsupported direct Google Gemini 3.8 Flash thinking before SDK access/model effects, preserves explicitly requested supported levels and leaves other provider/model identities alone. This is a compatibility refusal, not automatic reasoning/model selection. A deliberate removal of the runtime guard fails the integration regression.

Earlier GLM 5.1 and Gemini attempts failed for malformed/length-limited output or protected-path refusals; they are retained as failures. The failed protected-write attempt was reconciled only after observing its process absent, clean worktree and explicit pre-write refusal records. Its task outcome is failed; no budget reservation was released by reconciliation.

Current Go documentation also lists GLM 5.3 Flash ($0.15 input/$0.50 output per million, including its 2x usage accounting) and Qwen 3.8 Flash ($0.15/$0.47). Their conservative request bounds use the published prices and full pinned context/output limits, not the SDK's lower GLM rate. Qwen Flash has live build evidence; GLM Flash review is pending.
