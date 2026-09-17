# Helm model roster and cost classes

Updated 17 September 2026. This is the operator's dated model roster; live registry facts, provider state and the Core ledger govern execution. Catalogue entries are not capability certificates.

## Two separate classifications

**Capability tiers remain T0–T4**, with separate build and review floors, carried forward from the accepted Helm CLI behavioural evidence. A free model may eventually qualify for any capability tier, but zero price does not assign one.

**Cost classes** describe the resource pool: `free`, `subscription`, `api`, or `topup`. `free` means the selected route currently charges zero for inference; requests, time, concurrency, context and provider quotas are still scarce. Unknown quota remains unknown. A changed price or unavailable route refuses; it never triggers paid fallback.

## Current roster

| Model / route | Cost class | Observed evidence | Current use / constraint |
| --- | --- | --- | --- |
| NVIDIA Nemotron 3 Ultra via OpenRouter / Nvidia `:free` | Free | Raw probe: 44 tokens, US$0. Native Helm worker wrote a synthetic artifact, returned a valid envelope, and settled two requests at US$0 (#132) | Public/synthetic-only, native access qualified. Provider logs use for security/product improvement. General coding/review tier remains unassigned. |
| DeepSeek V4.1 Flash via OpenRouter / Baseten or Fireworks | API | Raw/Pi access passed; full native task qualification blocked by shared-pool429 (#130) | Explicit provider pinning, no fallback, ZDR/data-collection deny; physical region unverified. Not yet a general engineering worker. |
| Qwen 3.8 Flash via OpenCode Go | Subscription pool; conservative accounting in the existing API ledger | Accepted predecessor mechanical build and review probes; native Helm build/tool/envelope evidence | Candidate for T0 mechanical builds and calibrated independent review. Higher seam floors require separate evidence. |
| GLM 5.3 Flash via OpenCode Go | Subscription pool; conservative accounting in the existing API ledger | Native Helm independent reviews and accepted same-session claim correction | Bounded source review with host-run verification; no automatic builder promotion. |
| Gemini 3.8 Flash | API | Native Helm review/structured-result evidence; thinking compatibility tested | Selectively use for independent review and qualified tasks; low/medium/high thinking, not minimal. |
| Kimi variants | Route-specific | Predecessor evidence exists for specific versions; not interchangeable | Select exact qualified model, provider and role; no blanket family capability. |
| Muse Spark 1.3 Contributor | Subscription/contributor route | Predecessor probes; training-use terms | No private context; a distinct approved public route still needs qualification. |
| GPT-5.6 Luna | ChatGPT subscription | Existing bounded worker/review evidence | Only permitted ChatGPT worker; minimise use. Coordinator is a separate exception. |

Do not infer model hosting from its laboratory's country. Preserve exact provider, model version, role, route policy, prices and evidence provenance.

## Qualification path

Catalogue and policy check → bounded access probe → native tool and terminal-envelope task → host verifies claims → independent task-quality calibration → explicit role capability update. Record failures, capacity limits, cost, time and human interventions. A small probe establishes a narrow floor, not broad coding quality.

For collecting free routes, provide only deliberately curated public/synthetic objectives and acceptance text. Initial Helm support excludes inherited context references and filesystem-read scope. Private histories, credentials, customer data and unpublished code are excluded. Public-source review packets must be separately curated; repository visibility does not make local state safe to forward.

Sources: [Nemotron model and free-endpoint notice](https://openrouter.ai/nvidia/nemotron-3-ultra-550b-a55b-20260604:free), [OpenRouter qualification #130](https://github.com/Nicegarrry/helm3/issues/130), [free-route qualification #132](https://github.com/Nicegarrry/helm3/issues/132), [model economy evidence](economy-evidence.md), [open-model build evidence](open-model-waves.md). Predecessor calibration source: `Nicegarrry/helm-cli@ae5c3ff18ef8c0e12d57973ecb21c928b020b5c7`, `docs/research/go-model-allocation-2026-09-07.md`; its dated results do not establish current account capacity.

Public classification is a privileged operator attestation about the selected artifact contents, not an automatic confidentiality or personal-data scan. Operators must inspect the curated objective and acceptance text before approving that classification.
