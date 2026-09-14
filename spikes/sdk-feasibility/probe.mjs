import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createSdkMcpServer, InMemorySessionStore, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v3";

const root = await mkdtemp(join(tmpdir(), "helm3-sdk-probe-"));
try {
  const cwd = join(root, "cwd");
  const sessionDir = join(root, "sessions");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(sessionDir), mkdir(agentDir)]);

  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    credentials: new InMemoryCredentialStore(),
  });
  const faux = fauxProvider({ provider: "helm3-faux", models: [{ id: "offline" }] });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey("helm3-faux", "offline-test-key");
  const sessionManager = SessionManager.create(cwd, sessionDir);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "touch must-not-run" })),
    fauxAssistantMessage("offline completion"),
  ]);
  const pi = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    sessionManager,
    model: faux.getModel(),
    noTools: "all",
  });

  const piEvents = [];
  const unsubscribe = pi.session.subscribe((event) => piEvents.push(event.type));
  pi.session.setSessionName("offline-persisted-session");
  const piSessionFile = pi.session.getSessionStats().sessionFile;
  const piSessionId = pi.session.getSessionStats().sessionId;
  const persistedManager = pi.session.sessionManager;
  const persistedName = persistedManager.getSessionName();
  await pi.session.prompt("Exercise the deterministic offline model.");
  const persistedHeaderId = persistedManager.getHeader().id;
  pi.session.dispose();
  unsubscribe();

  const reopened = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    sessionManager: SessionManager.open(piSessionFile, sessionDir, cwd),
    noTools: "all",
  });
  const reopenedStats = reopened.session.getSessionStats();
  const reopenedManager = SessionManager.open(piSessionFile, sessionDir, cwd);
  const reopenedHeader = reopenedManager.getHeader();
  const forbiddenToolSideEffect = await access(join(cwd, "must-not-run")).then(() => true).catch(() => false);
  reopened.session.dispose();

  let claudeToolCalls = 0;
  const typedTool = tool(
    "record_evidence",
    "Record an evidence reference.",
    { issue: z.number().int().positive(), sha: z.string().length(40) },
    async (args) => {
      claudeToolCalls += 1;
      return { content: [{ type: "text", text: `${args.issue}:${args.sha}` }] };
    },
  );
  const server = createSdkMcpServer({ name: "offline-sdk-probe", tools: [typedTool] });
  const store = new InMemorySessionStore();
  const observedEventTypes = [...new Set(piEvents)];
  const expectedEvents = ["agent_start", "tool_execution_start", "tool_execution_end", "agent_end"];

  assert.ok(piSessionFile, "Pi must create a session file path");
  assert.equal(faux.state.callCount, 2, "Pi should consume exactly two local faux responses");
  assert.equal(forbiddenToolSideEffect, false, "suppressed bash tool must not write a file");
  assert.ok(expectedEvents.every((event) => observedEventTypes.includes(event)), "Pi must publish lifecycle and tool events");
  assert.equal(reopenedStats.sessionId, piSessionId, "Pi SDK reopen must retain session id");
  assert.equal(reopenedHeader.id, persistedHeaderId, "Pi persisted header must survive reopen");
  assert.equal(reopenedManager.getSessionName(), "offline-persisted-session", "Pi session name must persist");
  assert.equal(claudeToolCalls, 0, "Claude typed-tool handler must not run during construction");
  assert.ok(server.instance, "Claude SDK must create an MCP server");
  assert.ok(store, "Claude SDK must construct its in-memory session store");

  console.log(JSON.stringify({
    network: "Pi prompt used only a local faux provider; no Claude query or remote provider request invoked",
    pi: {
      created: true,
      sessionFileBasename: piSessionFile.split("/").at(-1),
      noTools: "all",
      fauxProviderCalls: faux.state.callCount,
      forbiddenToolSideEffect,
      subscribeEventTypes: observedEventTypes,
      reopenedSdkSessionIdMatches: true,
      reopenedPersistedHeaderIdMatches: true,
      reopenedName: reopenedManager.getSessionName(),
      persistedName,
    },
    claude: {
      typedToolName: typedTool.name,
      typedToolHandlerNotInvoked: true,
      mcpServerCreated: true,
      inMemorySessionStore: store.constructor.name,
    },
  }));
} finally {
  await rm(root, { recursive: true, force: true });
}
