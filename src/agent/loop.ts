import type { ChatMessage, ChatProvider, ToolCall, ToolDefinition, UsageInfo } from "../provider/types.ts";

export interface AgentTool {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>) => string | Promise<string>;
  /**
   * Blocks on user input. Turns using only these tools skip the model runaway
   * budget but still count toward HARD_MAX_ITERATIONS.
   */
  userDriven?: boolean;
}

export interface AgentOptions {
  provider: ChatProvider;
  systemPrompt?: string;
  tools: AgentTool[];
  onText?: (delta: string) => void;
  onTool?: (name: string) => void;
  /**
   * Paired with every `onTool`, including unknown or failed tools. Tools run
   * serially, so no name is needed.
   */
  onToolEnd?: () => void;
  onUsage?: (usage: UsageInfo) => void;
  /**
   * Receives each live message object as it joins the conversation. Assistant
   * messages arrive empty before streaming and are mutated in place; the same
   * objects are returned in `AgentResult.messages`.
   */
  onMessage?: (message: ChatMessage) => void;
  maxIterations?: number;
}

export interface AgentResult {
  messages: ChatMessage[];
  answer: string;
}

const DEFAULT_MAX_ITERATIONS = 10;

/** Absolute ceiling on all turns, including user-driven ones. */
const HARD_MAX_ITERATIONS = 100;

export async function runAgent(
  options: AgentOptions,
  initialMessages: ChatMessage[],
): Promise<AgentResult> {
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const toolDefs = options.tools.map((t) => t.definition);
  const messages: ChatMessage[] =
    options.systemPrompt && options.systemPrompt.trim() !== ""
      ? [{ role: "system", content: options.systemPrompt }, ...initialMessages]
      : [...initialMessages];

  // Two budgets: `spent` tracks model-driven iterations (the runaway guard),
  // `turns` bounds the loop overall. See AgentTool.userDriven.
  let spent = 0;
  for (let turns = 0; spent < maxIterations && turns < HARD_MAX_ITERATIONS; turns++) {
    // Announced before the request so a UI has somewhere to stream into, but
    // deliberately not in `messages` yet: an empty assistant turn must not be
    // sent to the provider. It is filled in and pushed once the stream ends.
    const assistant: ChatMessage = { role: "assistant", content: "" };
    options.onMessage?.(assistant);

    const { content, toolCalls } = await streamTurn(options, messages, toolDefs);
    // Assign because a mirroring caller may already hold the streamed content.
    assistant.content = content;
    if (toolCalls.length > 0) assistant.tool_calls = toolCalls;
    messages.push(assistant);

    if (toolCalls.length === 0) {
      return { messages, answer: content };
    }

    let userDrivenOnly = true;
    for (const call of toolCalls) {
      const tool = options.tools.find((t) => t.definition.function.name === call.function.name);
      // An unknown tool is a model mistake, so it counts against the budget.
      if (!tool?.userDriven) userDrivenOnly = false;
      options.onTool?.(call.function.name);
      const result = tool
        ? await runTool(tool, call)
        : `Unknown tool: ${call.function.name}`;
      options.onToolEnd?.();
      const toolMessage: ChatMessage = { role: "tool", tool_call_id: call.id, content: result };
      messages.push(toolMessage);
      options.onMessage?.(toolMessage);
    }
    if (!userDrivenOnly) spent++;
  }

  throw new Error(`Agent exceeded ${maxIterations} tool iterations`);
}

interface Accum {
  id: string;
  name: string;
  args: string;
}

async function streamTurn(
  options: AgentOptions,
  messages: ChatMessage[],
  tools: ToolDefinition[],
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  let content = "";
  const acc = new Map<number, Accum>();

  for await (const event of options.provider.streamChat(messages, { tools })) {
    if (event.type === "text") {
      content += event.delta;
      options.onText?.(event.delta);
      continue;
    }
    if (event.type === "usage") {
      options.onUsage?.(event.usage);
      continue;
    }
    const delta = event.toolCall;
    const call = acc.get(delta.index) ?? { id: "", name: "", args: "" };
    if (delta.id) call.id = delta.id;
    if (delta.name) call.name = delta.name;
    if (delta.arguments) call.args += delta.arguments;
    acc.set(delta.index, call);
  }

  const toolCalls: ToolCall[] = [...acc.values()]
    .filter((c) => c.id !== "" && c.name !== "")
    .map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args } }));

  return { content, toolCalls };
}

async function runTool(tool: AgentTool, call: ToolCall): Promise<string> {
  try {
    const args = call.function.arguments.trim() === "" ? {} : (JSON.parse(call.function.arguments) as Record<string, unknown>);
    return String(await tool.execute(args));
  } catch (err) {
    return `Tool error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
