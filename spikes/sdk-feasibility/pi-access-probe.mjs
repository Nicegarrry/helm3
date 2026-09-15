import assert from "node:assert/strict";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const PI_ACCESS_PROBE = Object.freeze({
  provider: "openai-codex",
  model: "gpt-5.6-luna",
  requestLimit: 1,
  requestUnit: "requests",
  timeoutMs: 30_000,
  maxRetries: 0,
  toolChoice: "none",
  outputTokenCap: null,
});

export function classifyAuth(auth) {
  if (!auth) return { status: "not_ready", reason: "credentials_not_configured" };
  return { status: "ready", authType: auth.type };
}

export function plannedReceipt(auth) {
  return {
    provider: PI_ACCESS_PROBE.provider,
    model: PI_ACCESS_PROBE.model,
    pool: { unit: PI_ACCESS_PROBE.requestUnit, plannedLimit: PI_ACCESS_PROBE.requestLimit },
    controls: {
      requestCount: PI_ACCESS_PROBE.requestLimit,
      noTools: true,
      toolChoice: PI_ACCESS_PROBE.toolChoice,
      maxRetries: PI_ACCESS_PROBE.maxRetries,
      hostTimeoutMs: PI_ACCESS_PROBE.timeoutMs,
      outputTokenCap: PI_ACCESS_PROBE.outputTokenCap,
      remoteAbortGuaranteed: false,
    },
    auth: classifyAuth(auth),
  };
}

export async function runLiveProbe() {
  assert.equal(process.env.HELM3_LIVE_ACCESS_PROBE, "1", "set HELM3_LIVE_ACCESS_PROBE=1 only after explicit approval");

  const runtime = await ModelRuntime.create({
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const auth = await runtime.checkAuth(PI_ACCESS_PROBE.provider);
  const receipt = plannedReceipt(auth);
  if (!auth) {
    console.log(JSON.stringify({ ...receipt, outcome: "refused_before_model_request" }));
    process.exitCode = 2;
    return;
  }

  const model = runtime.getModel(PI_ACCESS_PROBE.provider, PI_ACCESS_PROBE.model);
  assert.ok(model, "pinned Pi catalog must contain the planned model");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PI_ACCESS_PROBE.timeoutMs);
  try {
    const response = await runtime.complete(model, {
      messages: [{ role: "user", content: "Reply with exactly: HELM3_ACCESS_OK", timestamp: Date.now() }],
      tools: [],
    }, {
      signal: controller.signal,
      timeoutMs: PI_ACCESS_PROBE.timeoutMs,
      maxRetries: PI_ACCESS_PROBE.maxRetries,
      toolChoice: PI_ACCESS_PROBE.toolChoice,
      textVerbosity: "low",
      transport: "sse",
    });
    console.log(JSON.stringify({
      ...receipt,
      outcome: response.stopReason,
      usage: {
        input: response.usage.input ?? null,
        output: response.usage.output ?? null,
        cost: response.usage.cost?.total ?? null,
      },
    }));
  } catch (error) {
    console.log(JSON.stringify({
      ...receipt,
      outcome: controller.signal.aborted ? "host_timeout_abort_requested" : "request_failed",
      errorClass: error instanceof Error ? error.name : "unknown",
    }));
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  await runLiveProbe();
}
