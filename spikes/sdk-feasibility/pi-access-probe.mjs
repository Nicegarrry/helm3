import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

export const PI_ACCESS_PROBE = Object.freeze({
  provider: "openai-codex", model: "gpt-5.6-luna", requestLimit: 1,
  requestUnit: "requests", timeoutMs: 30_000, maxRetries: 0,
  toolChoice: "none", outputTokenCap: null,
});

export function classifyAuth(auth) {
  if (!auth) return { status: "not_ready", reason: "credentials_not_configured" };
  if (auth.type !== "oauth") return { status: "not_ready", reason: "subscription_oauth_required" };
  return { status: "ready", authType: "oauth" };
}

export function plannedReceipt(auth) {
  return {
    requestedProvider: PI_ACCESS_PROBE.provider, requestedModel: PI_ACCESS_PROBE.model,
    pool: { unit: "requests", plannedLimit: 1, remainingQuota: null },
    controls: { requestCount: 1, noTools: true, toolChoice: "none", maxRetries: 0,
      hostTimeoutMs: PI_ACCESS_PROBE.timeoutMs, outputTokenCap: null, remoteAbortGuaranteed: false },
    auth: classifyAuth(auth),
  };
}

async function defaultRuntimeFactory(options) {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  return ModelRuntime.create(options);
}

/** Dependency injection permits exercising the exact execution path without a provider. */
export async function runLiveProbe({
  approved = process.env.HELM3_LIVE_ACCESS_PROBE === "1",
  runtimeFactory = defaultRuntimeFactory,
  timeoutMs = PI_ACCESS_PROBE.timeoutMs,
} = {}) {
  assert.equal(approved, true, "explicit probe approval is required before creating the runtime");
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= PI_ACCESS_PROBE.timeoutMs);
  const controller = new AbortController();
  let timer;
  let receipt = plannedReceipt(undefined);
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("deadline")); }, timeoutMs);
  });
  try {
    return await Promise.race([deadline, (async () => {
      // Disable ambient provider/model overrides and model-catalog networking.
      const runtime = await runtimeFactory({ modelsPath: null, allowModelNetwork: false,
        refreshOnCreate: false, signal: controller.signal });
      const auth = await runtime.checkAuth(PI_ACCESS_PROBE.provider, { signal: controller.signal });
      receipt = plannedReceipt(auth);
      receipt.controls.hostTimeoutMs = timeoutMs;
      if (receipt.auth.status !== "ready") return { ...receipt, outcome: "refused_before_model_request" };
      const model = runtime.getModel(PI_ACCESS_PROBE.provider, PI_ACCESS_PROBE.model);
      assert.ok(model && model.provider === PI_ACCESS_PROBE.provider && model.id === PI_ACCESS_PROBE.model,
        "pinned catalog must resolve the exact planned model");
      controller.signal.throwIfAborted();
      const response = await runtime.complete(model, {
        messages: [{ role: "user", content: "Reply with exactly: HELM3_ACCESS_OK", timestamp: Date.now() }], tools: [],
      }, { signal: controller.signal, timeoutMs, maxRetries: 0, toolChoice: "none", textVerbosity: "low", transport: "sse" });
      const actualProvider = response.provider ?? null;
      const actualModel = response.model ?? null;
      const marker = response.content?.filter((part) => part.type === "text").map((part) => part.text).join("").trim();
      const success = response.stopReason === "stop" && marker === "HELM3_ACCESS_OK"
        && actualProvider === PI_ACCESS_PROBE.provider && actualModel === PI_ACCESS_PROBE.model;
      const finite = (value) => Number.isFinite(value) && value >= 0 ? value : null;
      return { ...receipt, outcome: success ? "succeeded" : "response_not_accepted", actualProvider, actualModel,
        usage: { input: finite(response.usage?.input), output: finite(response.usage?.output),
          cost: null, costState: "unknown", costReason: "catalog pricing is not observed subscription consumption" } };
    })()]);
  } catch {
    return { ...receipt, outcome: controller.signal.aborted ? "host_timeout_abort_requested" : "request_failed" };
  } finally { clearTimeout(timer); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const receipt = await runLiveProbe();
  console.log(JSON.stringify(receipt));
  if (receipt.outcome !== "succeeded") process.exitCode = 2;
}
