import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AGENTS, toolsFor, type AgentId } from "../src/agent/agents.ts";
import { runAgent, type AgentTool } from "../src/agent/loop.ts";
import {
  ASK_DECLINED,
  makeAskChannel,
  parseAskResult,
  type AskAnswer,
  type AskChannel,
  type AskQuestion,
} from "../src/agent/ask.ts";
import { registry, resolveTools, toolNames } from "../src/agent/tools/index.ts";
import { buildPlanningSystemPrompt, buildReportSystemPrompt } from "../src/agent/context.ts";
import type { ChatEvent, ChatMessage, ChatProvider } from "../src/provider/types.ts";
import { createCampaign, loadCampaign, type Campaign } from "../src/store/campaigns.ts";
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
let campaign: Campaign;
/** No PDFs by default — enough for the decline/grant assertions; sources tests populate it themselves. */
let sourcesDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scribe-agent-"));
  campaign = await createCampaign(dir, { name: "CoS", system: "5e", description: "Gothic horror." });
  campaignDir = campaign.dir;
  await createSession(campaign, "Death House");
  sourcesDir = join(dir, "Sources");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * A channel whose UI always picks `answers`, so tool-level tests don't need a
 * renderer. `asked` records what the widget would have been shown.
 */
function stubAskChannel(answers: string[] | null): AskChannel & { asked: AskQuestion[] } {
  const channel = makeAskChannel();
  const asked: AskQuestion[] = [];
  channel.attach(async (question) => {
    asked.push(question);
    return answers === null ? null : { question: question.question, answers };
  });
  return Object.assign(channel, { asked });
}

/**
 * A context with everything available, so `toolsFor` resolves a full grant.
 * Individual tests narrow it to assert the decline paths.
 */
const fullContext = () => ({ campaign, ask: stubAskChannel(["ok"]), sourcesDir, defaultSystem: campaign.system });

/** Resolve an agent's tools against the fixture campaign and pick one by name. */
function grantedTool(agent: AgentId, name: string): AgentTool {
  const tool = toolsFor(agent, fullContext()).find((t) => t.definition.function.name === name);
  if (!tool) throw new Error(`"${name}" is not granted to the "${agent}" agent`);
  return tool;
}

/** Names an agent actually resolves to, for access-control assertions. */
function grantedNames(agent: AgentId): string[] {
  return toolsFor(agent, fullContext()).map((t) => t.definition.function.name);
}

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

  test("user-driven tool calls don't burn the runaway-loop budget", async () => {
    // A long question-and-answer exchange is gated by the user's keystrokes, so
    // it can't be a runaway loop — the budget must not cut the turn short.
    let asks = 0;
    const provider: ChatProvider = {
      async *streamChat() {
        if (asks < 5) {
          asks++;
          yield toolCallDelta(0, `c${asks}`, "ask", "{}");
          return;
        }
        yield text("decided");
      },
    };
    const askish: AgentTool = {
      definition: {
        type: "function",
        function: { name: "ask", description: "asks", parameters: { type: "object", properties: {} } },
      },
      userDriven: true,
      execute: () => "answered",
    };

    const result = await runAgent({ provider, tools: [askish], maxIterations: 2 }, [
      { role: "user", content: "hi" },
    ]);
    expect(result.answer).toBe("decided");
    expect(asks).toBe(5);
  });

  test("a mix of user-driven and model-driven calls still counts", async () => {
    // Only turns made up *entirely* of user-driven calls are free; otherwise a
    // model could hide real work behind one ask per turn and loop forever.
    const provider: ChatProvider = {
      async *streamChat() {
        yield toolCallDelta(0, "c1", "ask", "{}");
        yield toolCallDelta(1, "c2", "echo", '{"word":"x"}');
      },
    };
    const askish: AgentTool = {
      definition: {
        type: "function",
        function: { name: "ask", description: "asks", parameters: { type: "object", properties: {} } },
      },
      userDriven: true,
      execute: () => "answered",
    };
    await expect(
      runAgent({ provider, tools: [askish, echoTool], maxIterations: 2 }, [{ role: "user", content: "hi" }]),
    ).rejects.toThrow(/exceeded/);
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
    const update = grantedTool("planning", "update_session_notes");
    const res = await update.execute({ number: 1, content: "## Plan\n\nAmbush!" });
    expect(res).toContain("Updated notes");

    const fresh = (await loadCampaign(campaignDir))!;
    const sessions = await listSessions(fresh);
    const raw = await readFile(sessions[0]!.path, "utf8");
    expect(raw).toContain("Ambush!");
    expect(raw).toContain("title: Death House"); // frontmatter preserved
  });

  test("rejects non-numeric session numbers", async () => {
    const update = grantedTool("planning", "update_session_notes");
    expect(await update.execute({ number: 999, content: "x" })).toBe("(session not found)");
    expect(await update.execute({ number: 0, content: "x" })).toBe("(session not found)");
    expect(await update.execute({ number: "1", content: "x" })).toBe("(session not found)");
  });

  test("read_session_notes returns the session body", async () => {
    const read = grantedTool("planning", "read_session_notes");
    expect(await read.execute({ number: 1 })).toContain("## Plan");
  });

  test("read_session_notes sees writes made earlier in the same run", async () => {
    // The agent drafts, then re-reads to refine — the read must not be served
    // from the campaign snapshot captured when tools were resolved.
    const update = grantedTool("planning", "update_session_notes");
    const read = grantedTool("planning", "read_session_notes");
    await update.execute({ number: 1, content: "## Plan\n\nThe windmill." });
    expect(await read.execute({ number: 1 })).toContain("The windmill.");
  });

  test("list_sessions returns formatted entries", async () => {
    const list = grantedTool("planning", "list_sessions");
    expect(await list.execute({})).toContain('1. "Death House" [planning]');
  });

  test("append_campaign_summary writes to the story so far", async () => {
    const append = grantedTool("report", "append_campaign_summary");
    expect(await append.execute({ entry: "They defeated the vampire spawn." })).toContain("Appended");

    const fresh = (await loadCampaign(campaignDir))!;
    expect(fresh.storySoFar).toContain("They defeated the vampire spawn.");
  });

  test("append_campaign_summary rejects an empty entry", async () => {
    const append = grantedTool("report", "append_campaign_summary");
    expect(await append.execute({ entry: "   " })).toBe("(entry cannot be empty)");
    expect(await append.execute({})).toBe("(entry cannot be empty)");
  });

  test("read_campaign_summary reflects an append from the same run", async () => {
    const append = grantedTool("report", "append_campaign_summary");
    const read = grantedTool("report", "read_campaign_summary");
    expect(await read.execute({})).toBe("(no story yet)");
    await append.execute({ entry: "Strahd showed himself." });
    expect(await read.execute({})).toContain("Strahd showed himself.");
  });
});

describe("save_session tool", () => {
  test("writes the one-shot file with frontmatter and returns the abbreviated path", async () => {
    const oneshotsDir = join(dir, "One-Shots");
    const tool = toolsFor("oneshot", { oneshotsDir })[0]!;
    const res = await tool.execute({
      title: "Lighthouse Siege",
      system: "5e",
      content: "## Hook\n\nA ghost crew attacks the harbor at dusk.",
    });

    expect(res).toContain('Saved one-shot "Lighthouse Siege"');
    expect(res).toContain("lighthouse-siege"); // the file name shows in the result

    const raw = await readFile(join(oneshotsDir, "lighthouse-siege.md"), "utf8");
    expect(raw).toContain("title: Lighthouse Siege");
    expect(raw).toContain("system: 5e");
    expect(raw).toContain("## Hook");
    expect(raw).toContain("A ghost crew attacks the harbor at dusk.");
  });

  test("empty title or content is rejected without writing a file", async () => {
    const oneshotsDir = join(dir, "One-Shots");
    const tool = toolsFor("oneshot", { oneshotsDir })[0]!;
    expect(await tool.execute({ title: "   ", content: "x" })).toBe("(title and content cannot be empty)");
    expect(await tool.execute({ title: "T", content: "" })).toBe("(title and content cannot be empty)");
    const entries = await readdir(oneshotsDir).catch(() => [] as string[]);
    expect(entries).toEqual([]);
  });
});

describe("source-document tools", () => {
  const FIXTURES = join(import.meta.dir, "fixtures");
  const RULES_PDF = join(FIXTURES, "rules.pdf");
  const BESTIARY_PDF = join(FIXTURES, "bestiary.pdf");

  test("granted to planning and oneshot but not report", () => {
    expect(grantedNames("planning")).toEqual(
      expect.arrayContaining(["list_sources", "search_sources", "read_source_pages"]),
    );
    const oneshotNames = toolsFor("oneshot", { oneshotsDir: join(dir, "One-Shots"), sourcesDir }).map(
      (t) => t.definition.function.name,
    );
    expect(oneshotNames).toEqual(
      expect.arrayContaining(["list_sources", "search_sources", "read_source_pages"]),
    );
    expect(grantedNames("report")).not.toEqual(
      expect.arrayContaining(["list_sources", "search_sources", "read_source_pages"]),
    );
  });

  test("all three tools decline a context with no sourcesDir", () => {
    const names = toolsFor("planning", { campaign, ask: stubAskChannel(["ok"]) }).map(
      (t) => t.definition.function.name,
    );
    expect(names).not.toContain("list_sources");
    expect(names).not.toContain("search_sources");
    expect(names).not.toContain("read_source_pages");
  });

  test("end-to-end over the wave-1 fixtures: list, search, and read a page", async () => {
    await mkdir(join(sourcesDir, "Shadowdark"), { recursive: true });
    await copyFile(RULES_PDF, join(sourcesDir, "Shadowdark", "rules.pdf"));
    await copyFile(BESTIARY_PDF, join(sourcesDir, "Shadowdark", "bestiary.pdf"));

    const list = grantedTool("planning", "list_sources");
    const listing = String(await list.execute({}));
    expect(listing).toContain("Shadowdark:");
    expect(listing).toContain("rules");
    expect(listing).toContain("bestiary");

    // The fixture campaign's system is "5e", but the fixtures live under
    // "Shadowdark" — search across everything rather than the (mismatched)
    // default scope; that scoping is exercised separately below.
    const search = grantedTool("planning", "search_sources");
    const hits = String(await search.execute({ query: "grapple", all_systems: true }));
    expect(hits).toContain("p.2");
    expect(hits.toLowerCase()).toContain("grapple");
    expect(hits).toContain("read_source_pages");

    const slugMatch = hits.match(/^\[([^\]]+)\]/);
    expect(slugMatch).not.toBeNull();
    const slug = slugMatch![1]!;

    const read = grantedTool("planning", "read_source_pages");
    const page = String(await read.execute({ document: slug, from: 2 }));
    expect(page.toLowerCase()).toContain("grapple");
  });

  test("an explicit system scopes search and does not widen", async () => {
    await mkdir(join(sourcesDir, "Shadowdark"), { recursive: true });
    await mkdir(join(sourcesDir, "Knave"), { recursive: true });
    await copyFile(RULES_PDF, join(sourcesDir, "Shadowdark", "rules.pdf"));
    await copyFile(BESTIARY_PDF, join(sourcesDir, "Knave", "bestiary.pdf"));

    const search = grantedTool("planning", "search_sources");
    // "grapple" lives only in the Shadowdark rulebook.
    expect(await search.execute({ query: "grapple", system: "Knave" })).toBe('(no matches for "grapple")');
  });

  test("a defaultSystem that matches no folder widens the search and says so", async () => {
    await mkdir(join(sourcesDir, "Shadowdark"), { recursive: true });
    await copyFile(RULES_PDF, join(sourcesDir, "Shadowdark", "rules.pdf"));

    // Campaigns store the system as free text ("D&D 5e"), which need not match
    // a folder name — the tool falls back to the whole library rather than
    // reporting a miss the user can't diagnose.
    const context = { campaign, ask: stubAskChannel(["ok"]), sourcesDir, defaultSystem: "D&D 5e" };
    const search = toolsFor("planning", context).find((t) => t.definition.function.name === "search_sources")!;

    const hits = String(await search.execute({ query: "grapple" }));
    expect(hits).toContain("searched every system instead");
    expect(hits).toContain("p.2");
  });

  test("read_source_pages reports an unknown document without throwing", async () => {
    const read = grantedTool("planning", "read_source_pages");
    expect(await read.execute({ document: "nope", from: 1 })).toBe(
      "(no such source document — call list_sources to see what is available)",
    );
  });
});

describe("ask channel", () => {
  test("declines when no UI is attached", async () => {
    const channel = makeAskChannel();
    expect(channel.available).toBe(false);
    expect(await channel.ask({ question: "Which?", options: [{ label: "A" }] })).toBeNull();
  });

  test("detaching settles a question still on screen", async () => {
    // The property that stops a turn hanging when the user leaves the chat
    // mid-question: nothing ever resolves the widget, so detach must.
    const channel = makeAskChannel();
    const detach = channel.attach(() => new Promise<AskAnswer | null>(() => {}));
    const pending = channel.ask({ question: "Which?", options: [{ label: "A" }] });
    detach();
    expect(await pending).toBeNull();
    expect(channel.available).toBe(false);
  });

  test("a handler that throws reads as a decline, not an error", async () => {
    const channel = makeAskChannel();
    channel.attach(() => Promise.reject(new Error("widget exploded")));
    expect(await channel.ask({ question: "Which?", options: [{ label: "A" }] })).toBeNull();
  });

  test("attaching replaces the previous handler", async () => {
    const channel = makeAskChannel();
    channel.attach(async () => ({ question: "q", answers: ["first"] }));
    channel.attach(async () => ({ question: "q", answers: ["second"] }));
    const answer = await channel.ask({ question: "q", options: [{ label: "x" }] });
    expect(answer?.answers).toEqual(["second"]);
  });
});

describe("ask_user tool", () => {
  const askTool = (channel: AskChannel): AgentTool => {
    const tool = toolsFor("planning", { campaign, ask: channel }).find(
      (t) => t.definition.function.name === "ask_user",
    );
    if (!tool) throw new Error("ask_user was not granted");
    return tool;
  };

  test("declines a context with no ask channel", () => {
    // Same shape as the campaign tools' decline: headless runs get no tool
    // rather than a call that blocks forever.
    expect(grantedNames("planning")).toContain("ask_user");
    expect(toolsFor("planning", { campaign }).map((t) => t.definition.function.name)).not.toContain(
      "ask_user",
    );
  });

  test("is marked user-driven so it can't be mistaken for a runaway loop", () => {
    expect(askTool(stubAskChannel(["A"])).userDriven).toBe(true);
  });

  test("passes the question through and formats the answer as the result", async () => {
    const channel = stubAskChannel(["The missing bell-ringer"]);
    const result = await askTool(channel).execute({
      question: "Which hook should drive session 2?",
      header: "Session hook",
      options: [{ label: "The missing bell-ringer", description: "A quiet disappearance" }],
    });

    expect(channel.asked[0]?.question).toBe("Which hook should drive session 2?");
    expect(channel.asked[0]?.header).toBe("Session hook");
    expect(channel.asked[0]?.options[0]?.description).toBe("A quiet disappearance");
    expect(result).toBe("Asked: Which hook should drive session 2?\nAnswer: The missing bell-ringer");
    // The result is also what the transcript renders, so it must parse back.
    expect(parseAskResult(String(result))?.answer).toBe("The missing bell-ringer");
  });

  test("joins multiple answers", async () => {
    const result = await askTool(stubAskChannel(["Rain", "Fog"])).execute({
      question: "Which omens?",
      options: [{ label: "Rain" }, { label: "Fog" }],
      multiple: true,
    });
    expect(result).toBe("Asked: Which omens?\nAnswer: Rain, Fog");
  });

  test("a dismissed question is a normal result, not an error", async () => {
    const result = await askTool(stubAskChannel(null)).execute({
      question: "Which?",
      options: [{ label: "A" }],
    });
    expect(result).toBe(ASK_DECLINED);
  });

  test("accepts plain-string options, dedupes, and caps at nine", async () => {
    // Models ignore the object schema often enough that strings must work.
    const channel = stubAskChannel(["A"]);
    await askTool(channel).execute({
      question: "Which?",
      options: ["A", "A", "  ", "B", ...Array.from({ length: 12 }, (_, i) => `Opt ${i}`)],
    });
    const labels = channel.asked[0]!.options.map((o) => o.label);
    expect(labels.slice(0, 3)).toEqual(["A", "B", "Opt 0"]);
    expect(labels).toHaveLength(9);
    expect(new Set(labels).size).toBe(9);
  });

  test("coerces string booleans, which models emit for flags", async () => {
    const channel = stubAskChannel(["A"]);
    await askTool(channel).execute({
      question: "Which?",
      options: ["A"],
      multiple: "true",
      custom: "false",
    });
    expect(channel.asked[0]?.multiple).toBe(true);
    expect(channel.asked[0]?.custom).toBe(false);
  });

  test("rejects an empty question or missing options without asking", async () => {
    const channel = stubAskChannel(["A"]);
    const tool = askTool(channel);
    expect(await tool.execute({ question: "  ", options: ["A"] })).toBe("(question cannot be empty)");
    expect(await tool.execute({ question: "Which?", options: [] })).toBe("(provide at least one option)");
    expect(await tool.execute({ question: "Which?" })).toBe("(provide at least one option)");
    expect(channel.asked).toEqual([]);
  });
});

describe("tool registry", () => {
  test("every spec's name matches its registry key and definition", () => {
    for (const [key, spec] of Object.entries(registry)) {
      expect(spec.name).toBe(key);
      expect(spec.definition.function.name).toBe(key);
    }
  });

  test("toolNames covers the whole registry", () => {
    expect(toolNames.map(String).sort()).toEqual(Object.keys(registry).sort());
  });

  test("resolveTools preserves the requested order", () => {
    const tools = resolveTools(["update_session_notes", "list_sessions"], { campaign });
    expect(tools.map((t) => t.definition.function.name)).toEqual(["update_session_notes", "list_sessions"]);
  });

  test("campaign tools decline a context with no campaign", () => {
    // The property the Drafting Table depends on: resolving is safe, not fatal.
    expect(resolveTools(toolNames, {})).toEqual([]);
  });
});

describe("agent gateway", () => {
  test("planning cannot append to the campaign summary", () => {
    expect(grantedNames("planning")).not.toContain("append_campaign_summary");
  });

  test("report can append to the campaign summary", () => {
    expect(grantedNames("report")).toContain("append_campaign_summary");
  });

  test("oneshot resolves save_session only when a one-shots dir is configured", () => {
    const oneshotsDir = join(dir, "One-Shots");
    expect(toolsFor("oneshot", { oneshotsDir }).map((t) => t.definition.function.name)).toEqual(["save_session"]);
    // Declines without a dir — plain streaming remains the fallback.
    expect(toolsFor("oneshot", {})).toEqual([]);
    expect(toolsFor("oneshot", { campaign })).toEqual([]);
  });

  test("every granted name resolves to a real tool for a campaign agent", () => {
    for (const agent of ["planning", "report"] as const) {
      expect(grantedNames(agent)).toEqual(AGENTS[agent].tools.map(String));
    }
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
