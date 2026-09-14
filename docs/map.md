# Helm 3 Map — addendum revision

Snapshot: 2026-09-15. GitHub issues and native dependencies remain authoritative. This is a proposed, changeable approach to the original 39 sections plus the 29-section addendum.

Parent: [MAP #1](https://github.com/Nicegarrry/helm3/issues/1). CONTEXT CLEAN precedes first-wave approval at [APPROVAL #2](https://github.com/Nicegarrry/helm3/issues/2). Predecessor handoff: [HANDOFF #3](https://github.com/Nicegarrry/helm3/issues/3).

The previous PREP record is completed historical work. Addendum documentation does not authorise implementation. No issue or schedule is a spending/merge lease.

| Issue | Outcome | Blocked by |
| --- | --- | --- |
| [MAP #1](https://github.com/Nicegarrry/helm3/issues/1) | Outcome: Helm 3 durable autonomous development control plane | None; scope still applies |
| [APPROVAL #2](https://github.com/Nicegarrry/helm3/issues/2) | Record human approval of Brief and proposed Map | None; scope still applies |
| [HANDOFF #3](https://github.com/Nicegarrry/helm3/issues/3) | Receive immutable Helm CLI Milestone 1 handoff | None; scope still applies |
| [FREEZE #4](https://github.com/Nicegarrry/helm3/issues/4) | Freeze current-spec contracts and build deltas | [APPROVAL #2](https://github.com/Nicegarrry/helm3/issues/2) |
| [ACCESS #5](https://github.com/Nicegarrry/helm3/issues/5) | Prove bounded live Pi and active-orchestrator model access | [APPROVAL #2](https://github.com/Nicegarrry/helm3/issues/2) |
| [KERNEL #6](https://github.com/Nicegarrry/helm3/issues/6) | Persist commands, events, attempts and uncertain effects | [APPROVAL #2](https://github.com/Nicegarrry/helm3/issues/2), [FREEZE #4](https://github.com/Nicegarrry/helm3/issues/4) |
| [AUTHORITY #7](https://github.com/Nicegarrry/helm3/issues/7) | Enforce leases, reserve and refusal classes | [APPROVAL #2](https://github.com/Nicegarrry/helm3/issues/2), [KERNEL #6](https://github.com/Nicegarrry/helm3/issues/6) |
| [ECONOMY #8](https://github.com/Nicegarrry/helm3/issues/8) | Expose model registry, pools and honest resource reality | [APPROVAL #2](https://github.com/Nicegarrry/helm3/issues/2), [KERNEL #6](https://github.com/Nicegarrry/helm3/issues/6) |
| [CALIBRATION #9](https://github.com/Nicegarrry/helm3/issues/9) | Measure calibration and accepted-outcome metrics | [APPROVAL #2](https://github.com/Nicegarrry/helm3/issues/2), [ECONOMY #8](https://github.com/Nicegarrry/helm3/issues/8) |
| [WORKSPACE #10](https://github.com/Nicegarrry/helm3/issues/10) | Isolate worktrees and enforce writer ownership | [APPROVAL #2](https://github.com/Nicegarrry/helm3/issues/2), [KERNEL #6](https://github.com/Nicegarrry/helm3/issues/6) |
| [PI-SLICE #11](https://github.com/Nicegarrry/helm3/issues/11) | Prove Pi-native worker lifecycle vertical slice | [APPROVAL #2](https://github.com/Nicegarrry/helm3/issues/2), [AUTHORITY #7](https://github.com/Nicegarrry/helm3/issues/7), [WORKSPACE #10](https://github.com/Nicegarrry/helm3/issues/10), [ACCESS #5](https://github.com/Nicegarrry/helm3/issues/5) |
| [PI-EXTENSION #12](https://github.com/Nicegarrry/helm3/issues/12) | Control Pi tools and native session operations | [APPROVAL #2](https://github.com/Nicegarrry/helm3/issues/2), [PI-SLICE #11](https://github.com/Nicegarrry/helm3/issues/11) |
| [CONTEXT #13](https://github.com/Nicegarrry/helm3/issues/13) | Manage context lifecycle, compaction and model change | [APPROVAL #2](https://github.com/Nicegarrry/helm3/issues/2), [PI-EXTENSION #12](https://github.com/Nicegarrry/helm3/issues/12) |
| [EXTERNAL #14](https://github.com/Nicegarrry/helm3/issues/14) | Track narrow external cognition contracts | [APPROVAL #2](https://github.com/Nicegarrry/helm3/issues/2), [KERNEL #6](https://github.com/Nicegarrry/helm3/issues/6), [AUTHORITY #7](https://github.com/Nicegarrry/helm3/issues/7), [ECONOMY #8](https://github.com/Nicegarrry/helm3/issues/8) |
| [MAP-TRACKER #15](https://github.com/Nicegarrry/helm3/issues/15) | Operate a GitHub-backed fluid Map and closure predicate | [APPROVAL #2](https://github.com/Nicegarrry/helm3/issues/2), [KERNEL #6](https://github.com/Nicegarrry/helm3/issues/6) |
| [FABLE #16](https://github.com/Nicegarrry/helm3/issues/16) | Run Fable through typed Helm control-plane tools | [APPROVAL #2](https://github.com/Nicegarrry/helm3/issues/2), [KERNEL #6](https://github.com/Nicegarrry/helm3/issues/6), [AUTHORITY #7](https://github.com/Nicegarrry/helm3/issues/7), [ECONOMY #8](https://github.com/Nicegarrry/helm3/issues/8), [MAP-TRACKER #15](https://github.com/Nicegarrry/helm3/issues/15), [PI-SLICE #11](https://github.com/Nicegarrry/helm3/issues/11), [ACCESS #5](https://github.com/Nicegarrry/helm3/issues/5), [ORCH-DRIVER #27](https://github.com/Nicegarrry/helm3/issues/27), [ORCH-OWNERSHIP #28](https://github.com/Nicegarrry/helm3/issues/28) |
| [SUPERVISOR #17](https://github.com/Nicegarrry/helm3/issues/17) | Reconcile deterministically and coalesce judgement wakes | [APPROVAL #2](https://github.com/Nicegarrry/helm3/issues/2), [AUTHORITY #7](https://github.com/Nicegarrry/helm3/issues/7), [PI-SLICE #11](https://github.com/Nicegarrry/helm3/issues/11), [MAP-TRACKER #15](https://github.com/Nicegarrry/helm3/issues/15), [ORCH-OWNERSHIP #28](https://github.com/Nicegarrry/helm3/issues/28) |
| [REASONING #18](https://github.com/Nicegarrry/helm3/issues/18) | Choose dynamic review and alternative cognitive approaches | [APPROVAL #2](https://github.com/Nicegarrry/helm3/issues/2), [FABLE #16](https://github.com/Nicegarrry/helm3/issues/16), [EXTERNAL #14](https://github.com/Nicegarrry/helm3/issues/14), [CONTEXT #13](https://github.com/Nicegarrry/helm3/issues/13), [CONSULT #30](https://github.com/Nicegarrry/helm3/issues/30) |
| [QUALITY #19](https://github.com/Nicegarrry/helm3/issues/19) | Run gates, independent review and repair against acceptance | [APPROVAL #2](https://github.com/Nicegarrry/helm3/issues/2), [PI-SLICE #11](https://github.com/Nicegarrry/helm3/issues/11), [MAP-TRACKER #15](https://github.com/Nicegarrry/helm3/issues/15), [JOURNAL #31](https://github.com/Nicegarrry/helm3/issues/31) |
| [INTEGRATION #20](https://github.com/Nicegarrry/helm3/issues/20) | Prepare and merge only exact fresh evidence | [APPROVAL #2](https://github.com/Nicegarrry/helm3/issues/2), [QUALITY #19](https://github.com/Nicegarrry/helm3/issues/19), [AUTHORITY #7](https://github.com/Nicegarrry/helm3/issues/7) |
| [CLIENTS #21](https://github.com/Nicegarrry/helm3/issues/21) | Expose shared API through CLI and local cockpit | [APPROVAL #2](https://github.com/Nicegarrry/helm3/issues/2), [KERNEL #6](https://github.com/Nicegarrry/helm3/issues/6), [MAP-TRACKER #15](https://github.com/Nicegarrry/helm3/issues/15), [ECONOMY #8](https://github.com/Nicegarrry/helm3/issues/8) |
| [IMPORT #22](https://github.com/Nicegarrry/helm3/issues/22) | Classify and import approved Milestone 1 behaviour | [APPROVAL #2](https://github.com/Nicegarrry/helm3/issues/2), [HANDOFF #3](https://github.com/Nicegarrry/helm3/issues/3), [KERNEL #6](https://github.com/Nicegarrry/helm3/issues/6) |
| [ACCEPTANCE #23](https://github.com/Nicegarrry/helm3/issues/23) | Prove the complete autonomous feature scenario | [APPROVAL #2](https://github.com/Nicegarrry/helm3/issues/2), [FABLE #16](https://github.com/Nicegarrry/helm3/issues/16), [SUPERVISOR #17](https://github.com/Nicegarrry/helm3/issues/17), [QUALITY #19](https://github.com/Nicegarrry/helm3/issues/19), [INTEGRATION #20](https://github.com/Nicegarrry/helm3/issues/20), [CLIENTS #21](https://github.com/Nicegarrry/helm3/issues/21), [CALIBRATION #9](https://github.com/Nicegarrry/helm3/issues/9), [PI-EXTENSION #12](https://github.com/Nicegarrry/helm3/issues/12), [CONTEXT #13](https://github.com/Nicegarrry/helm3/issues/13), [EXTERNAL #14](https://github.com/Nicegarrry/helm3/issues/14), [REASONING #18](https://github.com/Nicegarrry/helm3/issues/18), [INTERCHANGE #32](https://github.com/Nicegarrry/helm3/issues/32), [CONSULT #30](https://github.com/Nicegarrry/helm3/issues/30), [FAILOVER #33](https://github.com/Nicegarrry/helm3/issues/33), [JOURNAL #31](https://github.com/Nicegarrry/helm3/issues/31) |
| [LEGACY #24](https://github.com/Nicegarrry/helm3/issues/24) | Retire legacy worker path after Pi-native proof | [APPROVAL #2](https://github.com/Nicegarrry/helm3/issues/2), [ACCEPTANCE #23](https://github.com/Nicegarrry/helm3/issues/23), [IMPORT #22](https://github.com/Nicegarrry/helm3/issues/22) |
| [OUTCOME-CLOSURE #25](https://github.com/Nicegarrry/helm3/issues/25) | Close Helm 3 outcome against Brief and legacy evidence | [APPROVAL #2](https://github.com/Nicegarrry/helm3/issues/2), [ACCEPTANCE #23](https://github.com/Nicegarrry/helm3/issues/23), [LEGACY #24](https://github.com/Nicegarrry/helm3/issues/24), [IMPORT #22](https://github.com/Nicegarrry/helm3/issues/22) |
| [PREP #26](https://github.com/Nicegarrry/helm3/issues/26) | Prepare independent private repository, Brief, Map and SDK evidence | None; scope still applies |
| [ORCH-DRIVER #27](https://github.com/Nicegarrry/helm3/issues/27) | Define the small shared orchestrator-driver and Helm tool contract | [APPROVAL #2](https://github.com/Nicegarrry/helm3/issues/2), [FREEZE #4](https://github.com/Nicegarrry/helm3/issues/4), [ACCESS #5](https://github.com/Nicegarrry/helm3/issues/5) |
| [ORCH-OWNERSHIP #28](https://github.com/Nicegarrry/helm3/issues/28) | Fence one active orchestrator with durable lease epochs | [APPROVAL #2](https://github.com/Nicegarrry/helm3/issues/2), [KERNEL #6](https://github.com/Nicegarrry/helm3/issues/6), [AUTHORITY #7](https://github.com/Nicegarrry/helm3/issues/7) |
| [ASTRA #29](https://github.com/Nicegarrry/helm3/issues/29) | Run Astra through Codex SDK and the common Helm tools | [APPROVAL #2](https://github.com/Nicegarrry/helm3/issues/2), [ORCH-DRIVER #27](https://github.com/Nicegarrry/helm3/issues/27), [ORCH-OWNERSHIP #28](https://github.com/Nicegarrry/helm3/issues/28), [AUTHORITY #7](https://github.com/Nicegarrry/helm3/issues/7), [ECONOMY #8](https://github.com/Nicegarrry/helm3/issues/8), [MAP-TRACKER #15](https://github.com/Nicegarrry/helm3/issues/15), [PI-SLICE #11](https://github.com/Nicegarrry/helm3/issues/11), [ACCESS #5](https://github.com/Nicegarrry/helm3/issues/5) |
| [CONSULT #30](https://github.com/Nicegarrry/helm3/issues/30) | Consult an independent frontier peer and record disposition | [APPROVAL #2](https://github.com/Nicegarrry/helm3/issues/2), [FABLE #16](https://github.com/Nicegarrry/helm3/issues/16), [ASTRA #29](https://github.com/Nicegarrry/helm3/issues/29), [ORCH-OWNERSHIP #28](https://github.com/Nicegarrry/helm3/issues/28), [ECONOMY #8](https://github.com/Nicegarrry/helm3/issues/8) |
| [INTERCHANGE #32](https://github.com/Nicegarrry/helm3/issues/32) | Prove Fable and Astra interchange with comparable outcomes | [APPROVAL #2](https://github.com/Nicegarrry/helm3/issues/2), [FABLE #16](https://github.com/Nicegarrry/helm3/issues/16), [ASTRA #29](https://github.com/Nicegarrry/helm3/issues/29), [CALIBRATION #9](https://github.com/Nicegarrry/helm3/issues/9), [QUALITY #19](https://github.com/Nicegarrry/helm3/issues/19) |
| [JOURNAL #31](https://github.com/Nicegarrry/helm3/issues/31) | Preserve raw execution artifacts with recoverable Log indexes | [APPROVAL #2](https://github.com/Nicegarrry/helm3/issues/2), [KERNEL #6](https://github.com/Nicegarrry/helm3/issues/6) |
| [FAILOVER #33](https://github.com/Nicegarrry/helm3/issues/33) | Transfer orchestrator ownership across providers without losing the fleet | [APPROVAL #2](https://github.com/Nicegarrry/helm3/issues/2), [ORCH-OWNERSHIP #28](https://github.com/Nicegarrry/helm3/issues/28), [INTERCHANGE #32](https://github.com/Nicegarrry/helm3/issues/32), [SUPERVISOR #17](https://github.com/Nicegarrry/helm3/issues/17), [JOURNAL #31](https://github.com/Nicegarrry/helm3/issues/31), [CONTEXT #13](https://github.com/Nicegarrry/helm3/issues/13) |
| [ADDENDUM-PREP #34](https://github.com/Nicegarrry/helm3/issues/34) | Save addendum, revise Map and prepare context-clean handoff | None; scope still applies |

## Proposed dependency overview

```mermaid
flowchart TD
  A[Context clean and human approval] --> B[Bounded SDK access and contract freeze]
  B --> C[Commands, raw evidence, authority and epochs]
  C --> D[Native Pi sessions, scopes and envelopes]
  B --> E[Small orchestrator driver contract]
  D --> F[First frontier driver]
  E --> F
  F --> G[Second driver early and comparable feature]
  G --> H[Selective peer consultation]
  G --> I[Controlled cross-provider failover]
  C --> J[Map, economy, semantic API and cockpit]
  D --> K[Gates, same-session repair and integration]
  H --> L[Full original plus addendum acceptance]
  I --> L
  J --> L
  K --> L
  M[Opus M1 immutable handoff] --> N[History and behaviour reuse]
  N --> O[Full outcome closure]
  L --> O
```

The native issue graph is authoritative; this overview omits edges for readability. A first and second driver describe proving order, not a mandatory Fable-first implementation dependency. See [build-plan.md](build-plan.md), [coverage.md](coverage.md), and [approval-packet.md](approval-packet.md).
