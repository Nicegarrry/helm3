# GitHub Map tracker import evidence

## Scope and source

This is the read-only first import for MAP-TRACKER #15 and IMPORT #22. It is
pinned to `Nicegarrry/helm-cli@ae5c3ff18ef8c0e12d57973ecb21c928b020b5c7`.
The imported behaviour is the predecessor's fresh GitHub fact boundary in
`src/tracker/github.ts`, especially native dependency reads and its
fixture-backed `test/tracker.test.ts` oracle. Helm 3 does not import its
`wayfinder:task` query, task tiers, claim/comment/close mutations, provider
adapters, Herdr lifecycle assumptions, ledger, or fixed frontier workflow.

`GitHubMapTracker` in `src/tracker/index.ts` instead accepts an explicit
repository and Map parent issue. `snapshot()` performs fresh, argv-only `gh api`
reads of that parent, each recursively discovered native `sub_issues` page, and
each node's native `dependencies/blocked_by` page. It returns source identity,
observation time, complete/incomplete state, native membership nodes and a
descriptive `frontier`. The frontier excludes the Map parent and contains only
open membership nodes whose observed external blockers are closed. It chooses
no model, tier, role, route or mutation.

A page read failure, malformed response, output bound, pagination/node/request
limit, missing referenced issue, returned-identity mismatch, or membership cycle
makes the whole observation incomplete and returns no frontier. That is
deliberately different from an empty complete Map. REST states are normalized
from GitHub's lowercase payloads. A blocker retains its `OWNER/REPO` identity
and is freshly re-read from that repository; it is never reinterpreted as an
issue with the same number in the Map repository. Returned GitHub issue URLs must be canonical `https://github.com/OWNER/REPO/issues/N` URLs for the requested identity; unsafe or mismatched URLs are rejected.

The default transport runs `gh` without a shell, has a 10-second timeout and a
one-megabyte combined stdout/stderr ceiling. It asks an overdue process to stop,
then sends `SIGKILL` and closes local handles after a short bounded grace. This
does not prove descendant cancellation. Constructor limits cap pages at 50,
nodes at 1,000, requests at 10,000, timeout at 60 seconds and output at four
megabytes.

`src/tracker/observe.ts` is an operator-only JSON observer:

```sh
node --import tsx src/tracker/observe.ts --repo OWNER/REPO --map ISSUE_NUMBER
```

It has no mutation API and returns non-zero for an incomplete observation.
Running it against a real Map is a later dogfood receipt after independent
review; local fixture success is not a live GitHub proof.

## Behavioural mapping and local evidence

| Helm 3 path | Predecessor source/test | Classification | Evidence |
|---|---|---|---|
| `src/tracker/index.ts` | `src/tracker/github.ts`; `test/tracker.test.ts` native blocker cases | Behavioural: fresh external facts, native relationships, malformed/failed observations fail closed | `test/tracker/tracker.test.ts` covers recursive membership, lowercase REST state, fresh same/cross-repository blocker rereads, identity mismatch, malformed pages, transport failure, traversal limits and cycles. |
| `src/tracker/observe.ts` | predecessor's CLI adapter boundary only | New Helm 3 read-only operator seam | Fixture `gh` proves strict `--repo`/`--map` arguments and JSON output; it never invokes a provider. |
| `src/tracker/index.ts` transport | predecessor `execFileSync('gh', args)` discipline | Behavioural: argv data stays outside a shell | Fixture verifies runaway output has one bounded termination sequence and ignores later chunks; constructor tests reject unbounded page/node/request/time/output options. |
| predecessor labels/tiering and tracker mutations | `listOpenTasks`, `claim`, `comment`, `close`, `replaceComplexity` | Retired for this slice | No `wayfinder:task` dependency, automatic routing, model selection or GitHub mutation is exposed. |

Validated locally with Node 22.22.2:

```sh
npm ci --ignore-scripts
npm run typecheck
node --import tsx --test test/tracker/tracker.test.ts
```

These are provider-free fixture tests. They prove implementation conformance,
not live GitHub availability, complete Map semantics, command-host integration,
or closure mutation authority.
