# OpenRouter: explicit model and provider routes

OpenRouter is an additional paid API resource pool. A funded account is not a licence to spend its full balance: Helm still requires an existing human authority, expiring lease, registered model facts and a bounded request policy. Unknown earlier usage stays reserved. This integration does not resume a paused general build or automatically choose models.

## Access-tested route, 17 September 2026

The initial route is `deepseek/deepseek-v4.1-flash` through **Baseten**, at the observed OpenRouter endpoint prices of US$0.30 input / US$1.20 output per million tokens and US$0.03 cache-read tokens. The provider lists a 1,048,576-token context and 32,768-token maximum completion. These are dated route facts, not perpetual prices or model capability certification.

A synthetic API test returned `HELM_ROUTE_OK` and identified the upstream provider as BaseTen. A separate Pi ModelRuntime request returned `HELM_PI_OK` with the final request constrained to Baseten. Each consumed 21 input and 6 output tokens, costing US$0.0000135. Fireworks also accepted a separate native-shaped streaming request, but both routes subsequently returned HTTP429 from their upstream shared capacity pools. The final bounded native Helm attempt captured a Fireworks shared-pool429. Full live-worker completion has not yet been qualified; access success does not establish sustained availability.

The [OpenRouter provider directory](https://openrouter.ai/providers) lists US headquarters for Baseten and Fireworks, but its API returns no data-centre locations for either. **Provider selection is verified; physical inference geography is not.** Baseten documents optional region-locked environments separately. Do not label this generic OpenRouter endpoint as guaranteed US-only processing. Qualification used only synthetic/public content. The integration passed 370 tests, including provider-free native execution and replay. Failed live attempts remain visible in the ledger and their unknown monetary reservations remain held; a provider error is not treated as a completed engineering task.

## Pi setup

Pi 0.85.1 supports OpenRouter natively. Keep the account key outside repositories and reference it from the local `~/.pi/agent/models.json` credential field; Pi supports environment references or a request-time credential command. Do not paste a real key into shared examples, prompts or logs. No interactive OAuth is needed for this API account.

Because the installed catalog predates this model, add an explicit model definition under `providers.openrouter.models`. Use API `openai-completions`, base URL `https://openrouter.ai/api/v1`, the exact model ID above and the observed model limits/rates. Pin its `compat.openRouterRouting` to:

```json
{
  "only": ["baseten"],
  "allow_fallbacks": false,
  "require_parameters": true,
  "data_collection": "deny",
  "zdr": true,
  "max_price": { "prompt": 0.3, "completion": 1.2 }
}
```

Check readiness without inference:

```sh
pi --offline --list-models deepseek-v4.1
pi auth check --provider openrouter --model deepseek/deepseek-v4.1-flash --json --no-refresh
```

After authorising a task and budget, select it interactively:

```sh
pi --provider openrouter --model deepseek/deepseek-v4.1-flash
```

The standalone Pi command is not a Helm lease or spending guard. Use Helm's native command for bounded factory work. Do not enable an unpinned route merely because another model appears in Pi's catalog.

## Helm integration

The native command carries the explicit OpenRouter route as durable configuration. Alongside its normal model identity and policy fields, set `openRouterRouting` to the object above and supply:

```json
{
  "openRouterModel": {
    "name": "DeepSeek V4.1 Flash (Baseten)",
    "reasoning": true,
    "input": ["text", "image"]
  }
}
```

The model's context/output limits and costs derive from the declared bounded policy. Helm registers this inline definition against Pi's built-in OpenRouter provider; it does not execute commands or read a mutable external model file to discover model facts. The provider allowlist, privacy requirements and prices are bound to the saved run identity. Replaying that identity observes its prior result rather than selecting a new provider, creating a new grant or making another model call. Model registry capability floors still apply: connectivity proves access, not engineering competence.

The runtime checks the final outgoing request after SDK payload construction. Routing, model identity and output limits cannot be widened by model sampling parameters or hooks. The final payload reinstates the approved model, route and output cap; unapproved model fallback lists, extra billable plugins and oversized payloads refuse before HTTP. Provider unavailability is a failure or unknown outcome, not permission to try a different host.

For other OpenRouter models, independently qualify the exact model/provider route, current prices, tool support and data policy, then register appropriate role capabilities. No deterministic model router is introduced.

## Explicit public free profile

Helm also supports one opt-in training-allowed profile for public-only work. Set `openRouterDataPolicy` to `public-training-allowed` in the durable native command and access policy. The profile is pinned to `nvidia/nemotron-3-ultra-550b-a55b:free` (the dated `...-20260604:free` identity is accepted as an alias), OpenRouter provider `nvidia`, no fallback, required parameters, `data_collection: allow`, `zdr: false`, and zero prompt/completion price caps. Every declared input, output and cache rate must be zero, so its reservation is zero while unknown outcomes remain observable.

This profile requires `dataClassification: public`, `contextRefs: []`, and `readableRoots: []`. Objective and acceptance artifacts remain the only host-supplied context; file-read context is denied. The final payload replaces SDK-generated system/developer metadata with a minimal public-safe Helm instruction while preserving curated user, assistant, and tool messages. The profile must be explicitly selected; an omitted data policy continues to mean the existing private deny/ZDR route.

Sources: [model endpoints](https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints), [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection), [Baseten security practices](https://www.baseten.co/security-practices/), [Baseten regional environments](https://www.baseten.co/resources/changelog/regional-environments/).

Native qualification at source head `15658a7070126e2c081ebc14b0dd270bdc2e2da6` completed a synthetic file-write task: two successful model requests, one authorised write, valid WorkerResult, and both monetary reservations settled at zero. The host independently parsed and compared the output file. Captured outgoing payloads contained no local host paths. This establishes native tool/envelope compatibility, not a general engineering capability tier. Privileged operators attest that objective/acceptance contents are public; the profile is not an automatic content classifier.
