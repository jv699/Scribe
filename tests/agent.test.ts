import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAgent, type AgentTool } from "../src/agent/loop.ts";
import { makeCampaignTools } from "../src/agent/tools.ts";
import { buildPlanningSystemPrompt, buildReportSystemPrompt } from "../src/agent/context.ts";
import type { ChatEvent, ChatMessage, ChatProvider } from "../src/provider/types.ts";
import { createCampaign, loadCampaign } from "../src/store/campaigns.ts";
import { createSession, listSessions } from "../src/store/sessions.ts";

// --- fake provider helpers ---

const text = (delta: string): ChatEvent => ({ type: "text", delta });

function toolCallDelta(index: number, id: string, name: string, args: string): ChatEvent {
  return { type: "tool_call", toolCall: { index, id, name, arguments: args } };
}

/** A provider that replies with tool calls, then (after results come back) text. */
function makeToolProvider(): ChatProvider & { received: ChatMessage[][] } {
  const received: ChatMessage[][] = [];
  return {
    received,
    async *streamChat(messages) {
      received.push([...messages]);
      const hasToolResult = messages.some((m) => m.role === "tool");
      if (hasToolResult) {
        yield text("Plan written to session notes.");
        return;
      }
      yield toolCallDelta(0, "call_1", "echo", '{"word":"hello"}');
    },
  };
}

const echoTool: AgentTool = {
  definition: {
    type: "function",
    function: {
      name: "echo",
      description: "Echoes its input back.",
      parameters: { type: "object", properties: { word: { type: "string" } }, required: ["word"] },
    },
  },
  execute: (args) => `echoed: ${String(args["word"])}`,
};

// --- store setup ---

let dir: string;
let campaignDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scribe-agent-"));
  const campaign = await createCampaign(dir, { name: "CoS", system: "5e", description: "Gothic horror." });
  campaignDir = campaign.dir;
  await createSession(campaign, "Death House");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("agent loop", () => {
  test("executes tool calls and feeds results back until a text answer", async () => {
    const provider = makeToolProvider();
    const result = await runAgent(
      { provider, systemPrompt: "You are a planner.", tools: [echoTool], onTool: () => {} },
      [{ role: "user", content: "Plan session 1" }],
    );

    expect(result.answer).toBe("Plan written to session notes.");
    expect(provider.received.length).toBe(2);

    // First turn: system + user, tool calls requested via options
    expect(provider.received[0]![0]).toEqual({ role: "system", content: "You are a planner." });
    // Second turn includes assistant tool_call + tool result messages
    const second = provider.received[1]!;
    const assistant = second.find((m) => m.role === "assistant");
    expect(assistant?.tool_calls?.[0]?.function.name).toBe("echo");
    const toolMsg = second.find((m) => m.role === "tool");
    expect(toolMsg?.tool_call_id).toBe("call_1");
    expect(toolMsg?.content).toBe("echoed: hello");
  });

  test("reports unknown and failing tools gracefully", async () => {
    const provider: ChatProvider = {
      async *streamChat(messages) {
        if (messages.some((m) => m.role === "tool")) {
          yield text("done");
          return;
        }
        yield toolCallDelta(0, "c1", "missing_tool", "{}");
      },
    };
    const result = await runAgent({ provider, tools: [echoTool] }, [{ role: "user", content: "hi" }]);
    const toolMsg = result.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toBe("Unknown tool: missing_tool");
    expect(result.answer).toBe("done");
  });

  test("returns a plain text answer with no tool calls", async () => {
    const provider: ChatProvider = {
      async *streamChat() {
        yield text("Just talking.");
      },
    };
    const result = await runAgent({ provider, tools: [] }, [{ role: "user", content: "hi" }]);
    expect(result.answer).toBe("Just talking.");
    expect(result.messages).toHaveLength(2); // user + assistant
  });

  test("throws when the model loops too many times", async () => {
    const provider: ChatProvider = {
      async *streamChat() {
        yield toolCallDelta(0, "c1", "echo", '{"word":"x"}');
      },
    };
    await expect(
      runAgent({ provider, tools: [echoTool], maxIterations: 2 }, [{ role: "user", content: "hi" }]),
    ).rejects.toThrow(/exceeded/);
  });
});

describe("campaign tools", () => {
  test("update_session_notes writes the session file body", async () => {
    const tools = await makeCampaignTools(campaignDir);
    const update = tools.find((t) => t.definition.function.name === "update_session_notes")!;
    const res = await update.execute({ number: 1, content: "## Plan\n\nAmbush!" });
    expect(res).toContain("Updated notes");

    const campaign = await loadCampaign(campaignDir)!;
    const sessions = await listSessions(campaign!);
    const raw = await readFile(sessions[0]!.path, "utf8");
    expect(raw).toContain("Ambush!");
    expect(raw).toContain("title: Death House"); // frontmatter preserved
  });

  test("rejects non-numeric session numbers", async () => {
    const tools = await makeCampaignTools(campaignDir);
    const update = tools.find((t) => t.definition.function.name === "update_session_notes")!;
    const res = await update.execute({ number: 999, content: "x" });
    expect(res).toBe("(session not found)");
  });

  test("read_session_notes returns the session body", async () => {
    const tools = await makeCampaignTools(campaignDir);
    const read = tools.find((t) => t.definition.function.name === "read_session_notes")!;
    const res = await read.execute({ number: 1 });
    expect(res).toContain("## Plan");
  });

  test("list_sessions returns formatted entries", async () => {
    const tools = await makeCampaignTools(campaignDir);
    const list = tools.find((t) => t.definition.function.name === "list_sessions")!;
    const res = await list.execute({});
    expect(res).toContain('1. "Death House" [planning]');
  });

  test("append_campaign_summary is only present in report mode", async () => {
    const planning = await makeCampaignTools(campaignDir);
    expect(planning.find((t) => t.definition.function.name === "append_campaign_summary")).toBeUndefined();

    const report = await makeCampaignTools(campaignDir, { report: true });
    expect(report.find((t) => t.definition.function.name === "append_campaign_summary")).toBeDefined();
  });

  test("append_campaign_summary writes to the story so far", async () => {
    const tools = await makeCampaignTools(campaignDir, { report: true });
    const append = tools.find((t) => t.definition.function.name === "append_campaign_summary")!;
    const res = await append.execute({ entry: "They defeated the vampire spawn." });
    expect(res).toContain("Appended");

    const campaign = (await loadCampaign(campaignDir))!;
    expect(campaign.storySoFar).toContain("They defeated the vampire spawn.");
  });
});

describe("planning context", () => {
  test("assembles system prompt from file, campaign, and session", async () => {
    const campaign = (await loadCampaign(campaignDir))!;
    const sessions = await listSessions(campaign);
    const prompt = await buildPlanningSystemPrompt(campaign, sessions[0]!);

    expect(prompt).toContain("You are Scribe"); // default system prompt
    expect(prompt).toContain("Name: CoS");
    expect(prompt).toContain("Gothic horror.");
    expect(prompt).toContain('session 1 — "Death House"');
  });

  test("report prompt frames the session as played and points at the append tool", async () => {
    const campaign = (await loadCampaign(campaignDir))!;
    const sessions = await listSessions(campaign);
    const prompt = await buildReportSystemPrompt(campaign, sessions[0]!);

    expect(prompt).toContain("You are Scribe");
    expect(prompt).toContain("The user just played session 1");
    expect(prompt).toContain("append_campaign_summary");
  });
});
