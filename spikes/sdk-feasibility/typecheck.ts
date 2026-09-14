import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v3";

tool(
  "record_evidence",
  "Record an evidence reference.",
  { issue: z.number().int().positive(), sha: z.string().length(40) },
  async (args) => ({ content: [{ type: "text", text: `${args.issue}:${args.sha}` }] }),
);
