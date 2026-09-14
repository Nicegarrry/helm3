import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Codex } from "@openai/codex-sdk";

const root = await mkdtemp(join(tmpdir(), "helm3-codex-sdk-conformance-"));
const executable = join(root, "fake-codex.mjs");
const tracePath = join(root, "trace.jsonl");

const fakeCodex = `#!/usr/bin/env node
import { appendFile } from "node:fs/promises";

const args = process.argv.slice(2);
const input = await new Promise((resolve) => {
  let value = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { value += chunk; });
  process.stdin.on("end", () => resolve(value));
});
await appendFile(process.env.MOCK_TRACE_PATH, JSON.stringify({ args, input }) + "\\n");
if (input === "block-until-aborted") {
  console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-cancelled" }));
  process.on("SIGTERM", () => process.exit(143));
  setInterval(() => {}, 1_000);
} else {
  const resumed = args.includes("resume");
  const id = resumed ? args[args.indexOf("resume") + 1] : "thread-local-conformance";
  console.log(JSON.stringify({ type: "thread.started", thread_id: id }));
  console.log(JSON.stringify({ type: "turn.started" }));
  console.log(JSON.stringify({ type: "item.completed", item: { id: "message-1", type: "agent_message", text: resumed ? "resumed" : "started" } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }));
}
`;

try {
  await writeFile(executable, fakeCodex, { mode: 0o700 });
  await chmod(executable, 0o700);

  const codex = new Codex({
    codexPathOverride: executable,
    env: { MOCK_TRACE_PATH: tracePath, PATH: process.env.PATH ?? "" },
  });
  const thread = codex.startThread({
    model: "gpt-5.6-terra",
    sandboxMode: "read-only",
    approvalPolicy: "never",
    networkAccessEnabled: false,
    webSearchMode: "disabled",
    skipGitRepoCheck: true,
  });
  assert.equal(thread.id, null, "a new SDK thread has no id before the first event");

  const first = await thread.run("first-turn");
  assert.equal(thread.id, "thread-local-conformance");
  assert.equal(first.finalResponse, "started");
  assert.equal(first.usage?.cache_write_input_tokens, 0);

  const resumed = codex.resumeThread(thread.id, { skipGitRepoCheck: true });
  assert.equal(resumed.id, "thread-local-conformance");
  const second = await resumed.run("second-turn");
  assert.equal(second.finalResponse, "resumed");

  const controller = new AbortController();
  const cancellable = codex.startThread({ skipGitRepoCheck: true });
  const { events } = await cancellable.runStreamed("block-until-aborted", { signal: controller.signal });
  const iterator = events[Symbol.asyncIterator]();
  const started = await iterator.next();
  assert.equal(started.value?.type, "thread.started");
  controller.abort();
  await assert.rejects(iterator.next(), /AbortError|abort/i, "the SDK must propagate AbortSignal cancellation");

  const trace = (await readFile(tracePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(trace.length, 3, "each local conformance turn launches the fake executable once");
  assert.deepEqual(trace[0].args.slice(0, 2), ["exec", "--experimental-json"]);
  assert.ok(trace[0].args.includes("--model") && trace[0].args.includes("gpt-5.6-terra"));
  assert.ok(trace[0].args.includes("--sandbox") && trace[0].args.includes("read-only"));
  assert.ok(trace[0].args.includes("--skip-git-repo-check"));
  assert.ok(trace[1].args.includes("resume") && trace[1].args.includes("thread-local-conformance"));

  console.log(JSON.stringify({
    network: "none; the pinned SDK launched only a generated local fake executable",
    sdk: "@openai/codex-sdk@0.154.0",
    lifecycle: {
      startThread: true,
      run: true,
      resumeThread: true,
      streamedEvents: true,
      abortSignalCancellation: true,
    },
    nativeDriverGaps: ["interrupt", "stop", "checkpoint", "handoff"],
  }));
} finally {
  await rm(root, { recursive: true, force: true });
}
