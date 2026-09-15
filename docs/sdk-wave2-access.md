# Wave 2 Pi ACCESS route — 2026-09-15

Scope: resolve the first native Pi worker route for [ACCESS #5](https://github.com/Nicegarrry/helm3/issues/5) without a provider request, login change, purchase, API fallback, or credential-value access. This document is not a live-access receipt.

## Finding

The pinned `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` `0.85.1` packages support two relevant subscription OAuth providers:

| Pi provider | Upstream documented subscription route | Existing host observation | Can it reuse the existing CLI session without configuration change? |
| --- | --- | --- | --- |
| `openai-codex` | ChatGPT Plus/Pro OAuth | Codex CLI reports a ChatGPT login; Pi reports `credentials_not_configured` | No documented bridge; Pi needs its own OAuth credential |
| `anthropic` | Claude Pro/Max OAuth | Claude CLI reports a first-party Claude Max session; Pi reports `credentials_not_configured` | No documented bridge; Pi needs its own OAuth credential |

Pi's provider factories own their OAuth flows, and Pi's coding-agent credential storage is its own `agentDir/auth.json` (default `~/.pi/agent/auth.json`). The pinned source exposes no import path for Codex CLI or Claude CLI session storage. The upstream Pi docs describe Pi OAuth login and its own persistent credential store, while the official OpenAI docs describe a Codex CLI ChatGPT-login cache. Those are distinct stores and flows. A new Pi OAuth credential is therefore required before Pi can issue either subscription request on this host.

The minimum user interaction, if separately authorised, is one Pi OAuth login for the chosen provider: browser sign-in/consent plus its localhost callback. OpenAI Codex also has a device-code OAuth path. Either route writes a Pi credential and is a login/configuration change, so it remains outside the current authority. The exact local, interactive command for the OpenAI route is:

```sh
cd spikes/sdk-feasibility
/Users/sa/.nvm/versions/node/v22.22.2/bin/node node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js --provider openai-codex --model gpt-5.6-luna --no-tools --no-session
```

Run it with no prompt argument, complete the Pi OpenAI OAuth screen, then exit Pi without submitting a message. It does not use an API key or ask Pi to print a bearer token. Confirm only with `pi auth check --provider openai-codex --no-refresh --json`; do not use `--credentials`.

Sources: [Pi 0.85.1 provider and OAuth documentation](https://raw.githubusercontent.com/earendil-works/pi/v0.85.1/packages/ai/README.md), [official OpenAI authentication documentation](https://learn.chatgpt.com/docs/auth), and the installed pinned package source under `spikes/sdk-feasibility/node_modules`.

## Proposed first request after explicit Pi-login and probe approval

Use `openai-codex/gpt-5.6-luna`, because it is the supported Pi route aligned with the existing ChatGPT subscription session. This is a route proposal only; model availability remains unobserved until the request completes.

```sh
cd spikes/sdk-feasibility
HELM3_LIVE_ACCESS_PROBE=1 /Users/sa/.nvm/versions/node/v22.22.2/bin/node pi-access-probe.mjs
```

The harness makes at most one model request. It passes an empty tool list plus `toolChoice: "none"`, `maxRetries: 0`, SSE transport, a 30-second request timeout, and a host `AbortSignal` at 30 seconds. It prints a compact receipt containing provider/model, auth class, outcome, usage if returned, and the planned request pool. It never prints a credential value, auth source, response text, or headers.

The enforceable planned pool unit is **requests**, with a limit of **1**. Subscription quota is unknown. The pinned OpenAI Codex request builder does not serialize Pi's generic `maxTokens` option into the Codex request body, so no output-token cap is claimed. The harness records `outputTokenCap: null`. A host abort requests cancellation, but remote completion and post-abort charge are not guaranteed; it records that uncertainty rather than retrying.

Before any run, re-check the Pi route with its non-refreshing auth check. A missing Pi credential refuses before a model request. This avoids an API-key route, paid fallback, automatic retry, and a silent login attempt.

## Provider-free verification

```sh
cd spikes/sdk-feasibility
/Users/sa/.nvm/versions/node/v22.22.2/bin/npm run pi-access-probe-test
```

The fixture verifies that an absent credential produces `credentials_not_configured`; a ready synthetic OAuth status retains only the credential class; and the receipt retains the one-request, no-tool, zero-retry, timeout, unknown-output-bound, and remote-abort-uncertain controls. It makes no provider request and reads no real credential.
