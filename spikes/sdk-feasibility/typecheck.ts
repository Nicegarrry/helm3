import { tool } from "@anthropic-ai/claude-agent-sdk";
import { Codex, type Thread, type ThreadEvent, type TurnOptions } from "@openai/codex-sdk";
import { z } from "zod/v3";

tool(
  "record_evidence",
  "Record an evidence reference.",
  { issue: z.number().int().positive(), sha: z.string().length(40) },
  async (args) => ({ content: [{ type: "text", text: `${args.issue}:${args.sha}` }] }),
);

const codex = new Codex({ env: {} });
const thread: Thread = codex.startThread({
  approvalPolicy: "never",
  networkAccessEnabled: false,
  sandboxMode: "read-only",
  webSearchMode: "disabled",
});
const turnOptions: TurnOptions = { signal: new AbortController().signal };
const streamed: Promise<{ events: AsyncGenerator<ThreadEvent> }> = thread.runStreamed("offline only", turnOptions);
const resumed: Thread = codex.resumeThread("thread-id", { skipGitRepoCheck: true });

void streamed;
void resumed;
