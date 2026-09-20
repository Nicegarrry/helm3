# Live proof log

The faux-provider run in `report.md` proved the mechanics. This file records what was proven
against real models, a real `gh` and a real GitHub repository.

- **Date:** 2026-09-20
- **Machine:** macOS 27.0, arm64 (Apple Silicon), Node v22.22.2, Pi 0.85.1, pnpm 11.4.0
- **Checkout:** worktree of `claude/helm3-assessment-simplify-qsdefo` at
  `~/code/other/helm3-local-handoff`, `helm/node_modules` symlinked to the repo root's
- **`HELM_HOME`:** `~/.helm` · **`HELM_SPEND_CAP_USD`:** `5`
- **Target repo:** `~/code/web/brief` (`Nicegarrry/brief`)

## Models

| Role | Model as Pi names it | Notes |
| --- | --- | --- |
| Free smoke | `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free` | Synthetic scratch repo only |
| Builder | `opencode-go/qwen3.8-flash` | The model the handoff named |
| Reviewer | `google/gemini-3.8-flash` | Different family from the builder |

The handoff's preflight table expected `opencode-go/qwen3.8-flash`. At first run the
`opencode-go` provider was not logged in, so `pi --list-models` showed only `google` and
`openrouter`; the owner logged into OpenCode mid-run and the intended model became available
and was used.

## Preflight

```
node --version                         v22.22.2
cd helm && npm test                    95 tests, 95 pass, 0 fail
npx tsc --noEmit                       clean
gh auth status                         Logged in to github.com account Nicegarrry
```

`gh` was initially reported as an invalid token; the owner re-ran `gh auth login` before
section 2.3.

## Fix 1 — `defaultModelRuntime` disabled the operator's model config

**Symptom.** The first free-model spawn (`w-46658c27`) failed one second after `turn.start`:

```
error {"message":"No API key found for openrouter.\n\nUse /login to log into a provider..."}
state {"from":"running","to":"unknown"}
```

**Cause.** `helm/src/worker.ts` built its model runtime with `modelsPath: null`:

```ts
return ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
```

In `@earendil-works/pi-coding-agent`, `modelsPath: null` resolves to `undefined` and
`ModelConfig.load(undefined)` loads nothing; the default is `~/.pi/agent/models.json`
(`dist/core/model-runtime.js:76`). That file is where custom providers, their API keys and
pinned routes live. Every model configured there was therefore unresolvable, and built-in
models of a configured provider had no credential.

Measured directly, before changing anything:

| Model | `modelsPath: null` | default `modelsPath` |
| --- | --- | --- |
| `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free` | found, no credential | found |
| `openrouter/deepseek/deepseek-v4.1-flash` | **not found** | found, cost `0.3/1.2` |
| `google/gemini-3.8-flash` | found | found |

The middle row is the operator's ZDR/Baseten-pinned route. Under the old line Helm could not
run it at all, and its catalogue prices — which is what spend is summed from — were invisible.

**Fix.** Leave `modelsPath` unset so Pi loads the operator's `models.json`; keep
`allowModelNetwork: false` and `refreshOnCreate: false`. `defaultModelRuntime` is now exported
so it can be tested.

**Regression test.** `test/worker.test.ts`, "defaultModelRuntime loads the operator models.json
so configured providers resolve": writes a `models.json` declaring a provider that exists
nowhere else, points `PI_CODING_AGENT_DIR` at it, and asserts the model resolves. Verified to
fail with the old line (`not ok 1`) and pass with the new one. Suite: 95 → 96 tests.

## Wave A — the loop closes

### A1. Daemon

```
HELM_SPEND_CAP_USD=5 HELM_HOME=~/.helm ./helm/bin/helm.js serve --http --port 4747
helm serve listening on http://127.0.0.1:4747
```

`~/.helm/serve.json` → `{"port":4747,"pid":…}`. `curl http://127.0.0.1:4747/` returns the
plain `helm ps` table; the browser dashboard was open throughout.

`~/.helm` already held `ledger.db` from the old control plane. The new store is `helm.sqlite`,
so the two do not collide.

### A2. Free-model smoke, synthetic content only

Scratch repo created locally: `git init` + `README.md` + a `helm.json` gate of
`test -f hello.txt`. No private code.

```
helm spawn --repo <scratch> \
  --objective "Create a file named hello.txt in the repository root containing a short friendly greeting. Nothing else." \
  --model openrouter/nvidia/nemotron-3-ultra-550b-a55b:free
→ w-236e5095, branch helm/w-236e5095
```

Tool calls recorded in the event log: `ls`, `write`, `read`. Result `succeeded`. Helm committed
the worker's change to head `56a8b9e`, diff `hello.txt | 3 +++`.

```
helm gate w-236e5095
→ passed: true, head 56a8b9e, check "hello-exists" exit 0 in 5ms
```

Spend: **$0.0000** (free route).

### A3. Real task, real model, real PR

Target `~/code/web/brief`. Gate configured in `~/code/web/brief/helm.json`:

```json
{ "gates": [
    { "name": "install", "command": "pnpm install --frozen-lockfile --prefer-offline" },
    { "name": "unit",    "command": "pnpm vitest run --project unit" } ] }
```

Chosen because brief's default `package.json` gates cannot pass on a fresh checkout: `pnpm test`
runs both vitest projects and the 22 `convex` files need generated bindings
(`Cannot find module './_generated/api'`), which `pnpm codegen` produces by starting a local
Convex. The `unit` project is 152 files / 2,693 tests and is green on `main`. `helm.json` is read
from the **source repo**, not the worktree (`gate.ts` `defaultChecks(row.repo)`), so no commit to
brief was needed to configure it.

Task: `packages/shared/src/targets.ts` carries an `SG-9` comment that says
"`targets.test.ts` pins it" — and no such file exists. The worker was asked to write it and to
change nothing else.

```
helm spawn --repo ~/code/web/brief --model opencode-go/qwen3.8-flash --objective "…" --acceptance "…"
→ w-5445a1ae, branch helm/w-5445a1ae
```

The worker read `targets.ts`, `ids.ts` and the sibling `ids.test.ts`, ran
`pnpm install --frozen-lockfile --prefer-offline`, wrote the file, then ran the targeted vitest
command, the full `unit` project, `prettier --check`, `eslint` and `tsc --noEmit` itself before
reporting. Result `succeeded`, head `96d59be`, diff
`packages/shared/src/targets.test.ts | 142 ++++`, one file, no existing file touched.

The test it produced follows brief's own convention of citing ticket ids, and pins the `SG-9`
omission by name — asserting that a `sug_` id *does* match `ID_PATTERN` while `targetKind`
still returns `null`, which is the half that would silently break if someone "fixed" the missing
`case 'sug'`.

```
helm gate w-5445a1ae
→ passed: true, head 96d59be
  install  exit 0    332ms
  unit     exit 0  17,311ms   (2,709 passed | 2 skipped)

helm pr w-5445a1ae --draft --title "test(shared): add the targets.test.ts that SG-9 promises"
→ { ok: true, number: 248, url: https://github.com/Nicegarrry/brief/pull/248, head: 96d59be }
```

**`src/github.ts` worked against real `gh` on first contact — no fix was needed.** The
`gh pr create` URL parsing returned the right number, and `gh pr view --json` field shapes
parsed correctly, including the checks array:

```
helm pr-status w-5445a1ae
→ state open, mergeable true, head 96d59be
  "lint · typecheck · test · build"  QUEUED
  "Vercel"                           SUCCESS
  "Vercel Preview Comments"          COMPLETED / SUCCESS
```

Confirmed independently with `gh pr view 248 --repo Nicegarrry/brief --json …`: draft, open,
head `96d59bee42de5ef358e83ec5dfb21c086f8eeeaa`, one file
`packages/shared/src/targets.test.ts` `+142/-0`.

Spend after Wave A: **$0.009541** total, all of it the builder; 4 unknown-cost events.

### Observation — `helm status` does not show the cap

`run.status` from the CLI reported `"spendCapUsd": 0` while the daemon was running with
`HELM_SPEND_CAP_USD=5`. The cap is read from the environment of whichever process answers, and
the CLI reads the store directly rather than asking the daemon. Spend itself is correct. See
Wave B3 for whether enforcement is affected.
