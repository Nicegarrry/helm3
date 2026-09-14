# Build approval packet

Prepared 2026-09-15. Historical preparation packet. First-wave approval is now recorded in [APPROVAL #2](https://github.com/Nicegarrry/helm3/issues/2#issuecomment-5671903235); see [current first-wave progress](wave1-progress.md) for live status and bounds.

The proposal and execution-boundary sections below describe the preparation state before approval; they are retained for provenance and are not the current operator instruction.

## Completed independent preparation

- New private `Nicegarrry/helm3` repository; predecessor checkout/worktrees untouched.
- Original 39-section design and the 29-section addendum are preserved verbatim, appended in the combined Brief and separately hash-checked. Coverage now maps all 68 source sections.
- Initial preparation established 26 issues and passed its recorded checks. The addendum revises that live Map to 34 issues, preserving existing IDs and the completed PREP history; current native relationships are verified for this revision before handoff. All product issues remain proposed.
- Full source-section coverage, separate human approval and predecessor handoff/import gates, and dependency checks.
- Current Pi packages pinned to 0.85.1, Claude Agent SDK 0.3.270, Sandbox Runtime 0.0.76 and Node 22.22.2. Lockfile and reproducible throwaway probes are included.
- Coordinator independently reran clean dependency installation, SDK tool-schema typecheck, local faux-model session/event/persistence assertions and macOS sandbox write-boundary assertions. All passed.

See the prior [SDK evidence](sdk-feasibility.md) and the new documentation-only [orchestrator SDK readiness note](orchestrator-sdk-notes.md) for the evidence classes and limitations. No live provider request was made. Actual Pi/Fable/Astra model compatibility and full worker-integrated containment remain unverified.

## Revised approach: addendum incorporated

1. **First build wave is foundation only:** freeze contracts, durable Log/raw-artifact journal boundaries, ownership-lease epoch fields/refusals, and SDK feasibility. No product workflow is built in this wave. Existing Claude SDK facts are narrow prior evidence; no Codex SDK executable probe has occurred and subscription entitlement is unverified.
2. **Use one active replaceable orchestrator:** Fable/Claude Agent SDK or Astra/Codex SDK drive the same small Helm tool/lifecycle contract; Pi remains the single native worker runtime. The second driver is early work, followed by the same comparable feature under both. This supports measurement, not causal performance claims.
3. **Authority and recovery:** ownership epochs fence stale orchestrator commands at queue and effect. They are distinct from Autonomy Leases. Later takeover reconstructs from a recovery bundle without a transcript; confirmed quota/death can trigger deterministic handling, unknown provider state fails closed. Takeover never renews expired autonomy or cancels independently valid supervisor work.
4. **Evidence and containment:** typed worker claims are checked by evidence-detailed gates; repairable failures return to the same session. Prevent protected-path changes and detect post-diff escape. Raw artifacts provide forensic evidence; SQLite artifact indexes are projections while durable Helm Log records retain orchestration authority. Track context occupancy separately from cost and preserve per-pool reserve/provenance.
5. **Freeze the short protocol, then three lanes:** Terra owns native Pi/session/isolation; Terra owns command/lease/recovery and first-driver integration; Luna/Terra owns early Map/API/cockpit and picks up predecessor reuse when the handoff is available. Every brief references the approved design and exact acceptance evidence.
6. **Import only after Opus's Milestone 1 handoff.** Receive the SHA, checks, invariants and exclusions. Choose a history-preserving transition and port useful deterministic behaviour behind the new contracts. Do not rebuild stable predecessor components speculatively or claim full migration completion without the handoff.
7. **Integrate and prove the complete brief.** Section 35's scenario plus addendum invariants 16–23 require explicit evidence for interchange, independent consultation, takeover fencing, context pressure, evidence claims/gates, containment and journal provenance.

## Proposed timing after approval

- First 6 hours: feasibility, contract/journal/epoch foundation and an explicit re-estimate.
- Then: first driver and Pi slice; early second driver plus comparable-feature proof; consultation, supervisor/economy/quality/cockpit; acceptance and failure repair.
- Target 48–72 elapsed hours of continuous multi-agent execution, with 96 hours contingency. Timely predecessor handoff and working live providers are assumptions, not verified facts.

These are milestones in a fluid Map, not four fixed workflow stages encoded into Helm.

## Proposed execution boundary for the first-wave approval

Build in this private repository with isolated worktrees and at most three workers plus coordinator. Use existing connected subscription routes where supported; do not purchase capacity or automatically top up. Incremental API spending remains disabled unless the human specifies a cap. If a required native route needs API funding, surface the concrete route/cap decision before using it. Normal engineering failures are handled within the approved scope.

The next approval should name the [first-wave scope](build-plan.md#proposed-first-implementation-wave), code/tests/PR authority and resource bounds in Helm 3. Merge only verified Helm 3 work and an explicitly named disposable acceptance fixture within recorded merge authority. Do not merge into, modify or dispatch work in the predecessor repository. Record actual pool bounds/reserve, run expiry and attempt limits before autonomous execution; this preparation cannot manufacture resource telemetry.

The immediate requested step and approval gate described above are complete. This packet does not claim full system readiness; consult [current first-wave progress](wave1-progress.md) for the merged foundation, open ACCESS work and active kernel frontier.
