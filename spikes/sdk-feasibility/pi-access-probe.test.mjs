import assert from "node:assert/strict";
import { PI_ACCESS_PROBE, classifyAuth, plannedReceipt } from "./pi-access-probe.mjs";

assert.deepEqual(classifyAuth(undefined), {
  status: "not_ready",
  reason: "credentials_not_configured",
});
assert.deepEqual(classifyAuth({ type: "oauth", source: "must-not-appear" }), {
  status: "ready",
  authType: "oauth",
});

const receipt = plannedReceipt({ type: "oauth", source: "must-not-appear" });
assert.equal(receipt.pool.unit, "requests");
assert.equal(receipt.pool.plannedLimit, 1);
assert.equal(receipt.controls.requestCount, 1);
assert.equal(receipt.controls.noTools, true);
assert.equal(receipt.controls.toolChoice, "none");
assert.equal(receipt.controls.maxRetries, 0);
assert.equal(receipt.controls.hostTimeoutMs, 30_000);
assert.equal(receipt.controls.outputTokenCap, null);
assert.equal(receipt.controls.remoteAbortGuaranteed, false);
assert.deepEqual(receipt.auth, { status: "ready", authType: "oauth" });
assert.equal(JSON.stringify(receipt).includes("must-not-appear"), false);
assert.equal(PI_ACCESS_PROBE.provider, "openai-codex");

console.log(JSON.stringify({ authStatusFixtures: "passed", network: "none" }));
