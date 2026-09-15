import assert from "node:assert/strict";
import { request } from "node:http";
import { afterEach, test } from "node:test";
import { createOperatorServer, formatOperatorJson, listenOperatorServer, renderOperatorHtml, validateOperatorSnapshot } from "../../src/operator/index.js";
import type { OperatorSnapshot } from "../../src/operator/index.js";

const snapshot: OperatorSnapshot = {
  schemaVersion: 1, observedAt: "2026-09-15T00:00:00.000Z", source: { kind: "fixture", evidenceMode: "fixture", id: "fixture", observedAt: "2026-09-15T00:00:00.000Z" }, unknowns: ["provider quota"], map: { state: "unknown", repository: null, parentIssue: null, nodes: null, frontier: null, summary: "tracker adapter not connected" },
  run: { runId: "run-1", owner: { orchestrator: "astra", epoch: 4 }, leases: { orchestrator: { state: "active", id: "lease-1", expiresAt: null }, autonomy: { state: "unknown", id: null, expiresAt: null } } },
  attempts: [{ attemptId: "attempt-1", mapNodeId: "node-1", role: "worker", state: "running", model: { id: "offline", family: "test", pool: "fixture" }, workspace: { path: "/tmp/worktree", baseSha: "abc" }, startedAt: snapshotTime(), endedAt: null, outcome: null, epoch: 4 }],
  pendingCommands: [{ commandId: "command-1", kind: "observe", state: "queued", createdAt: snapshotTime(), epoch: 4 }], needsYou: [{ id: "need-1", kind: "decision", summary: "choose <route>", createdAt: snapshotTime() }],
  resources: { units: [{ poolId: "fixture", unit: "usd", used: 1.5, reserved: null, limit: null, unknown: "limit not exposed" }], context: [{ attemptId: "attempt-1", used: null, window: null, occupancy: "unknown" }] }, quality: { gate: { passed: null, total: null }, integration: { passed: null, total: null } },
};
function snapshotTime(): string { return "2026-09-15T00:00:00.000Z"; }

const servers: ReturnType<typeof createOperatorServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); });

test("CLI JSON and HTML use the same injected snapshot and escape fields", () => {
  assert.equal(JSON.parse(formatOperatorJson(snapshot)).needsYou[0].summary, "choose <route>");
  const html = renderOperatorHtml(snapshot);
  assert.match(html, /choose/); assert.doesNotMatch(html, /choose <route>/); assert.match(html, /choose &lt;route&gt;/);
});

test("runtime validation rejects fields outside the public projection", () => {
  assert.throws(() => validateOperatorSnapshot({ ...snapshot, leakedTranscript: "secret" }), /unknown field/);
  assert.throws(() => validateOperatorSnapshot({ ...snapshot, run: { ...snapshot.run, leaked: "secret" } }), /unknown field/);
  assert.throws(() => validateOperatorSnapshot({ ...snapshot, toJSON: () => ({ leaked: "secret" }) }), /unknown field/);
  const validated = validateOperatorSnapshot(snapshot); (snapshot.attempts[0] as { state: string }).state = "changed"; assert.equal(validated.attempts[0].state, "running");
  assert.throws(() => validateOperatorSnapshot({ ...snapshot, source: { ...snapshot.source, observedAt: { toJSON: () => ({ leaked: "synthetic-secret" }) } } }), /string or null/);
});

test("loopback API returns the injected snapshot and rejects non-loopback origins", async () => {
  const server = createOperatorServer({ read: async () => snapshot }); servers.push(server); const address = await listenOperatorServer(server);
  const get = (path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string }>((resolve, reject) => { const req = request({ host: address.host, port: address.port, path, headers }, (res) => { let body = ""; res.setEncoding("utf8"); res.on("data", (chunk) => { body += chunk; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body })); }); req.on("error", reject); req.end(); });
  const good = await get("/api/operator/snapshot", { origin: `http://${address.host}:${address.port}` }); assert.equal(good.status, 200); assert.deepEqual(JSON.parse(good.body), snapshot);
  const bad = await get("/api/operator/snapshot", { origin: "https://evil.example" }); assert.equal(bad.status, 403);
  const wrongPort = await get("/api/operator/snapshot", { host: `127.0.0.1:${address.port + 1}`, origin: `http://127.0.0.1:${address.port + 1}` }); assert.equal(wrongPort.status, 403);
});

test("server has no write endpoint", async () => {
  const server = createOperatorServer({ read: async () => snapshot }); servers.push(server); const address = await listenOperatorServer(server);
  const status = await new Promise<number>((resolve, reject) => { const req = request({ method: "POST", host: address.host, port: address.port, path: "/api/operator/snapshot" }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); }); req.on("error", reject); req.end(); });
  assert.equal(status, 405);
});
