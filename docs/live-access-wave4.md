# Wave 4 bounded Pi access

This is a provider-free implementation note and a configuration recipe. It does
not prove that an account is provisioned, that a key can access a model, or that
a live request has run. Credentials and their local locations are operational
state and do not belong in this repository.

## Verified routes

Pi `0.85.1` includes two relevant built-in provider registrations in its pinned
catalogue:

| Route | Pi provider/model | Authentication | Native endpoint |
| --- | --- | --- | --- |
| Preferred open-coding route | `opencode-go/kimi-k2.7-code` | `OPENCODE_API_KEY` | `https://opencode.ai/zen/go/v1/chat/completions` |
| Direct Gemini route | `google/<currently-pinned-model>` | `GEMINI_API_KEY` | `https://generativelanguage.googleapis.com/v1beta` |

OpenCode Go and Zen are separate products. Go is a $10/month subscription with
per-model 5-hour, weekly, and monthly usage limits; its documentation publishes
the Go models endpoint and a static route table. Zen is pay-as-you-go and its
documentation says that auto-reload can charge a balance below $5. Helm must not
use Zen, enable balance fallback, or enable auto-reload for this overnight
authority. [OpenCode Go documentation](https://opencode.ai/docs/go/)
describes the Go API endpoints, model-specific limits, and its current Pi
client note. [OpenCode Zen documentation](https://opencode.ai/docs/zen/)
describes the separate pay-as-you-go balance and auto-reload behaviour.

Kimi K2.7 Code is the starting model choice because it is explicitly a coding
model and is present in both OpenCode's current Go route table and Pi's pinned
`opencode-go` catalogue. Its nominal Go token rates are $0.95 input and $4.00
output per million tokens. Those rates are a declared accounting upper-bound,
not a claim that a subscription request is an observed dollar charge. Do not
silently substitute a closed model, a Zen credit route, or Gemini.

The direct Gemini route is technically available to Pi, but is a separate key
and billing domain. Google's documentation says API keys authenticate requests
and track account usage; upgrading to paid tier requires Cloud Billing and a
prepayment. It is therefore only eligible when a pre-existing authority maps it
to the same aggregate Helm pool. [Gemini API getting started](https://ai.google.dev/gemini-api/docs/get-started)

## Enforced request boundary

`BoundedPiAccess` is injected into `PiNativeWorker`. The worker wraps
`ModelRuntime.streamSimple`, which is the Pi `0.85.1` boundary whose lazy stream
consumption reaches the provider. Pi's `before_provider_request` extension hook
can replace a payload but has no blocking result; it is not used as the spending
boundary.

Before every stream is consumed, the access gate:

- pins provider, model, API family, base URL, and context window to declared
  policy facts, refusing a catalogue mismatch;
- serializes the complete Pi context including tool schemas and applies a UTF-8
  packet-byte cap. This is a payload-size guard, not a token estimate;
- reserves the complete pinned context window plus the declared worst-case
  billed output before every request, because local JSON byte counts cannot
  prove provider tokenisation;
- overwrites `maxTokens`, `maxRetries`, and the abort signal with fixed policy
  values;
- requires a fresh effect ID, allowing the host to persist a separate
  reservation for every provider HTTP request, including tool-loop turns;
- limits tool effects for the session and disables automatic envelope repair by
  default; and
- records only provider, model, caps, reservation, and final usage status. It
  never records an API key or request headers.

The host's `commandForEffect` must resolve only each **model** effect through
the access gate and use one shared `overnight-api-usd`/`usd` resource pool for
every provider. Workspace writes do not have a model reservation. The existing
kernel persists reservations transactionally. Settlement recomputes cost only
from validated native input/output/cache token fields and the frozen price
table; the SDK's reported dollar total is never trusted. Failed, timed-out,
aborted, or unusable telemetry is `unknown` and leaves the full upper bound
charged. There is no retry, fallback, compaction, or provider/model discovery
in this path.

If a Pi stream fails after dispatch, the runtime aborts the local session and
records the parent attempt as `unknown`. It does not report a clean worker stop:
the outer host effect has no trustworthy terminal observation, so both the
attempt and its full reservation remain quarantined. A later recovery needs a
new, observed local-state decision; it must not retry this request.

This containment does not establish why a live aborted session may take a long
time to drain its event journal. Treat that slow-flush cause as unresolved.

## Binding recipe

Create one gate for the whole worker session and pass it to both the Pi worker
and the host settlement callback:

```ts
const access = new BoundedPiAccess({
  poolId: 'overnight-api-usd',
  provider: 'opencode-go',
  model: 'kimi-k2.7-code',
  api: 'openai-completions',
  baseUrl: 'https://opencode.ai/zen/go/v1',
  authEnvironment: 'OPENCODE_API_KEY',
  contextWindow: 262_144,
  inputUsdPerMillion: 0.95,
  outputUsdPerMillion: 4.00,
  cacheReadUsdPerMillion: 0.19,
  cacheWriteUsdPerMillion: 0,
  maxPacketBytes: 32_000,
  maxOutputTokens: 1_200,
  maxBilledOutputTokens: 262_144,
  maxRequests: 2,
  maxToolCalls: 2,
  timeoutMs: 30_000,
});

const authority = host.piAuthority({
  attemptId, actorId, executorId,
  commandForEffect(effect) {
    if (effect.kind !== 'model.request') return workspaceWriteCommand(effect);
    const reservation = access.reservation(effect.effectId);
    return modelRequestCommand(effect, reservation); // resourceRequest => reservation
  },
  observedSettlement(effect) {
    const settlement = access.settlement(effect.effectId);
    return settlement?.state === 'known'
      ? settlement
      : settlement ? { state: 'unknown' as const } : undefined;
  },
});

const binding = createBoundedPiWorkerBinding({
  access, authority: () => authority,
  workerFor: (command) => ({ ...trustedWorkerBase, commandId: command.commandId }),
  prompt, correction,
});
const runtime = new PiNativeRuntime(binding);
```

The human authority and autonomy lease must both declare the same
`overnight-api-usd` pool with `unit: 'usd'` and a combined limit of `10`. A
separate provider pool would not enforce the combined ceiling. The live probe
should start with a minimal synthetic prompt and the smallest requested caps;
only after its receipt is observed may a scoped coding task use the remaining
authority.
