# Operator entrypoint — current through Wave 10

## Current boundary

Wave 4 and onward are approved for bounded execution under [overnight authority](overnight-authority.md), including provider-free dogfood, scoped worker dispatch, independent review and useful Map updates. Accepted main is `4970c0c0951f34bc289b77e7443bc938a5fcfa9f` after PR #91. The predecessor M1 is complete and reuse is authorised only from the pinned source recorded in [predecessor-m1.md](predecessor-m1.md). Historical Wave 2/3 handoffs are context, not the current boundary.

## Orient

1. Read `AGENTS.md`, the [Brief](brief.md), [original design](design-source.md), [addendum](design-addendum.md), [protocol](protocol.md), [overnight authority](overnight-authority.md), and [predecessor M1 receipt](predecessor-m1.md).
2. Read current GitHub [approval](https://github.com/Nicegarrry/helm3/issues/2), [handoff](https://github.com/Nicegarrry/helm3/issues/3) and [Map](https://github.com/Nicegarrry/helm3/issues/1) state. Cached documents never establish authority.
3. Verify repository status and worktree ownership. Do not overwrite an existing worker's WIP.
4. Run `python3 scripts/check-preparation.py`; use Node 22.22.2 for focused checks and provider-free fixture observations. Do not confuse fixture success with authenticated model access.

For a morning smoke check, run both `node --import tsx src/dogfood/observe.ts --orchestrator fable --state-directory <new-empty-path>` and the equivalent `astra` command. The current fixture executes six turns: initial worker spawn, red gate, same-session repair, green gate, Map update and Map close, and should report four faux model requests, two workspace writes and an autonomy-lease expiry refusal.

## Historical approval gate

The context-clean and explicit first-wave approval gate is complete. Its foundation-only description is historical; current authority and bounds are in [overnight-authority.md](overnight-authority.md). Do not claim a Codex SDK probe or subscription entitlement from unrelated evidence.

## After explicit build approval

Record the exact approved contract revision and concrete delegation: repositories, allowed actions, run expiry, provider/pool limits, reserve, max attempts/concurrency and merge scope. Bounded real Pi/OpenCode attempts have occurred under the overnight authority, but live frontier/OAuth access and full acceptance remain open. Start any further live request only under current bounded authority and verified route facts. Do not infer auth interoperability from an installed CLI or this chat's model selector; the provider-free Fable/Astra fixture needs no account access.

Freeze the agreed contracts, then dispatch brief-checked isolated worktrees. Preserve one writer per worktree. Keep a frontier reserve; workers use Terra/Luna where appropriate. Report accepted outcomes and hard blockers at the six-hour checkpoint. The target is the complete brief, not just a unit-test count or the number of open worker sessions.

## When Opus hands over

Receive the immutable packet without altering the source checkout. After authorisation, inspect a separate SHA-pinned checkout and classify reusable code/tests according to [migration-handoff.md](migration-handoff.md). Preserve source history/provenance through an explicitly selected transition. Full completion remains blocked on that transition; do not import live WIP or guess the Milestone 1 boundary.

## Stop conditions

Lease expiry/revocation blocks further spending/effects while observation continues. Unknown external outcomes are reconciled before retry. Missing enforceable bounds, unmet model/role/policy floors, stale integration evidence or an ownership conflict refuse the operation. Engineering ambiguity wakes the active orchestrator; only product/authority/high-impact decisions reach the human. A human pause stops dispatch/build/publish activity and preserves WIP.

## Historical saved projection viewer

To inspect an already-exported cockpit API response without opening its original Helm state, save the explicit JSON response and serve it locally:

```sh
curl --fail http://127.0.0.1:PORT/api/operator/snapshot > preserved-snapshot.json
node --import tsx src/operator/saved-viewer.ts --snapshot preserved-snapshot.json
```

The viewer accepts one bounded regular JSON file, validates the existing snapshot schema, and exposes the existing GET-only loopback cockpit/API. It does not open a host, kernel, journal, credentials, or provider. Its UI, startup output, and `X-Helm-Projection: historical-untrusted` API header mark the result as an untrusted historical projection that cannot authorize actions. The displayed snapshot keeps its original timestamps and source/evidence fields. `src/operator/cli.ts --url http://127.0.0.1:PORT --json` preserves the existing bare snapshot JSON for live views; for this historical viewer it returns `{ "snapshot": ..., "projection": { "mode": "historical-untrusted", "actionAuthority": "none" } }`, so machine users cannot miss the boundary.

## Provider-free fixture scenarios

The observation command runs only local faux-provider fixtures; it does not establish authenticated frontier behavior, independent fork review, production merge, or full acceptance. Its default remains the same-session repair flow:

```sh
node --import tsx src/dogfood/observe.ts --orchestrator fable --state-directory <new-empty-path>
node --import tsx src/dogfood/observe.ts --orchestrator astra --state-directory <new-empty-path> --scenario default
```

Use the optional `native-fork` scenario to exercise the already-implemented local source/child native-session fork flow. It reports `fixture: true` and `scenario: "native-fork"`; its four faux model requests, two writes, gate, and Map close are fixture evidence only:

```sh
node --import tsx src/dogfood/observe.ts --orchestrator fable --state-directory <new-empty-path> --scenario native-fork
node --import tsx src/dogfood/observe.ts --orchestrator astra --state-directory <new-empty-path> --scenario native-fork --serve
```
