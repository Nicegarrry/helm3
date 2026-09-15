# Helm CLI M1 receipt and reuse inventory

## Receipt and authority

On 2026-09-15 the human confirmed Opus finished the predecessor milestone and explicitly authorised bringing across needed elements and dogfooding existing/new work. This replaces the earlier predecessor-access/import hold. The historical brief remains unchanged.

- Repository: `https://github.com/Nicegarrry/helm-cli.git`.
- Immutable source: `ae5c3ff18ef8c0e12d57973ecb21c928b020b5c7`.
- Receipt: [Opus M1 completion](https://github.com/Nicegarrry/helm-cli/issues/1#issuecomment-5674271806).
- Root observation: `git rev-parse HEAD` in the predecessor and `gh api repos/Nicegarrry/helm-cli/commits/main --jq .sha` both returned that SHA.
- The predecessor checkout contains unrelated modified/untracked memory documents and an untracked `helm.toml`. They are excluded from the source baseline and were preserved.

Opus reports 313 tests passing, typecheck clean, and a full sandbox lifecycle through dispatch/build/PR/review/check/merge/cleanup/close. These are milestone receipts, not claims that Helm 3 has reproduced the whole live flow. The latest source fixes asynchronous PR/provenance recovery in checks. The live Marlo exit wave moved to M2. The predecessor supervisor/cockpit remain later work, not reusable completed implementations.

## Reuse decisions

| Component | Source anchors at the pinned SHA | Helm 3 treatment |
|---|---|---|
| GitHub task facts and relationships | `src/tracker/github.ts`, `src/tracker/verbs.ts` | Reuse/adapt behind #15; preserve fresh reads and external truth. Replace the hard-coded legacy label selector for this Map. |
| Exact-head checks, tamper and review provenance | `src/check/index.ts`, `src/check/tamper.ts`, `src/ledger/schema.ts` | Carry guarded behaviours and regression oracles into #19/#20, adapted to Helm 3 attempt/epoch identity. Reuse async head-branch/exit-window recovery only where evidence semantics match. |
| Model/resource facts and refusal semantics | `src/budget.ts`, `src/config.ts`, model/routing modules | Assess for #8/#9 before rebuilding. Preserve source units and unknown headroom; old example prices/models are configuration, not current observations. |
| Structured output, shared registry | `src/output.ts`, `src/registry.ts`, `src/mcp.ts` | Reuse envelope/parity behaviour for #21; keep existing Helm 3 SDK-native tool transports rather than installing a second authority surface. |
| Mechanical handoff facts | `src/handoff.ts` | Reuse formatting/fact collection where clean for #13/#17; raw evidence and Helm 3 Log remain durable authority. |
| Worktree and reclamation mechanics | workspace/reclaim modules and tests | Assess narrow safe pieces for #10. Do not adopt unsafe failed-worktree reclamation while #89 is unresolved. |
| Provider adapters, terminal inference, old per-ticket sequencing | `src/adapters/`, dispatch and supervisor design | Do not import as Helm 3 runtime architecture. Pi remains native worker execution; frontier orchestrator chooses workflow. |

Behavioural tests must be classified and ported with each selected component. This receipt does not close IMPORT #22, retire legacy execution, or claim wholesale source import. The existing Helm 3 command/journal/lease code is retained; importing a second competing authoritative ledger would require resolving ownership first.

## Known exclusions and follow-ups

The completion receipt explicitly retains open predecessor #81, #82, #84, #89 and #90:

- #81: optional Codex harness fallback; not a requirement for Pi-native core.
- #82: `brief` posts supplied text verbatim, while `dispatch` expects an adapter-qualified first line. A successful post does not prove the dispatch composition works.
- #84: generated init/gate/template/workspace assumptions need repairs; do not copy its default config as a usable Helm 3 deployment.
- #89: failed/no-PR worktree reclamation needs a live-writer lease check before it is safe to adopt.
- #90: the suite already uses PATH fakes, but has no global enforcement that provider calls remain zero; audit/fence baseline execution. The issue is not evidence that current tests made paid calls.

Binding source references include `docs/spec.md`, `docs/design/ledger.md`, `docs/design/routing.md`, `docs/design/prompts.md`, `docs/design/output.md` and `docs/landmines.md`. Preserve prompt-as-data/argv safety, family provenance, freshness before effects, exact-head approvals, truthful unknown resource state and dirty-worktree safety. Helm 3 original30–34 and addendum14–24 govern adaptations where predecessor implementation differs.

## First actual dogfood receipt

With Node22.22.2, the pinned predecessor binary was run against the checked-in migration coordinator profile targeting the real Helm 3 repository:

```sh
/path/to/pinned/helm-cli/bin/helm frontier --repo /path/to/helm3/docs/dogfood --json
```

Observed exit0 and exact stdout:

```json
{"schema_version":1,"verb":"frontier","outcome":"success","data":{"tickets":[],"diagnostics":[]}}
```

Inspection of pinned `src/tracker/github.ts:132` confirms its fixed `wayfinder:task` selector. Helm 3 issues currently carry other metadata, so this is an incompatible-selector result, not evidence of no unblocked work. The tracker import must fix it before using the result to route this build. No provider call, worker dispatch, login, configuration overwrite or shared ledger mutation was needed for this call.

See [the revised next wave](wave3-plan.md) for graduated dogfooding and acceptance. Further receipts belong on the Map with exact source/target heads and observable results.
