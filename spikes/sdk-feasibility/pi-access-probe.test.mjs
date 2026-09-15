import assert from "node:assert/strict";
import { runLiveProbe } from "./pi-access-probe.mjs";

function fixture({ auth = { type: "oauth", source: "secret-not-for-receipt" }, response, hang = false } = {}) {
  const calls = [];
  let lastSignal;
  const runtimeFactory = async (options) => {
    calls.push(["create", options]);
    return {
      checkAuth: async () => auth,
      getModel: (provider, id) => ({ provider, id }),
      complete: async (model, context, options) => {
        calls.push(["complete", model, context, options]); lastSignal = options.signal;
        if (hang) return new Promise(() => {});
        return response ?? { provider: model.provider, model: model.id, stopReason: "stop",
          content: [{ type: "text", text: "HELM3_ACCESS_OK" }], usage: { input: 10, output: 3, cost: { total: 99 } } };
      },
    };
  };
  return { calls, runtimeFactory, signal: () => lastSignal };
}
const disarmed = fixture();
await assert.rejects(runLiveProbe({ approved: false, runtimeFactory: disarmed.runtimeFactory }));
assert.equal(disarmed.calls.length, 0);
for (const auth of [null, { type: "api_key" }, { type: "unrecognized" }]) {
  const f = fixture({ auth });
  const result = await runLiveProbe({ approved: true, runtimeFactory: f.runtimeFactory });
  assert.equal(result.outcome, "refused_before_model_request");
  assert.equal(f.calls.filter(([kind]) => kind === "complete").length, 0);
}
const allowed = fixture();
const success = await runLiveProbe({ approved: true, runtimeFactory: allowed.runtimeFactory });
assert.equal(success.outcome, "succeeded");
assert.equal(allowed.calls[0][1].modelsPath, null);
assert.equal(allowed.calls[0][1].allowModelNetwork, false);
assert.equal(allowed.calls.filter(([kind]) => kind === "complete").length, 1);
const call = allowed.calls.find(([kind]) => kind === "complete");
assert.deepEqual(call[2].tools, []);
assert.equal(call[3].maxRetries, 0);
assert.equal(call[3].toolChoice, "none");
assert.equal(call[3].transport, "sse");
assert.equal(success.usage.cost, null);
assert.equal(JSON.stringify(success).includes("secret-not-for-receipt"), false);
assert.equal(success.actualProvider, "openai-codex");
for (const response of [
  { stopReason: "error", content: [], usage: {} },
  { provider: "other", model: "other", stopReason: "stop", content: [{ type: "text", text: "HELM3_ACCESS_OK" }] },
  { provider: "openai-codex", model: "gpt-5.6-luna", stopReason: "stop", content: [{ type: "text", text: "wrong" }] },
]) {
  const f = fixture({ response });
  assert.equal((await runLiveProbe({ approved: true, runtimeFactory: f.runtimeFactory })).outcome, "response_not_accepted");
  assert.equal(f.calls.filter(([kind]) => kind === "complete").length, 1);
}
const hanging = fixture({ hang: true });
const timeout = await runLiveProbe({ approved: true, runtimeFactory: hanging.runtimeFactory, timeoutMs: 10 });
assert.equal(timeout.outcome, "host_timeout_abort_requested");
assert.equal(hanging.signal().aborted, true);
assert.equal(hanging.calls.filter(([kind]) => kind === "complete").length, 1);
console.log(JSON.stringify({ harnessExecution: "passed", network: "none", cases: 10 }));
