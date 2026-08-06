/**
 * The agent loop: send a conversation (optionally with a system prompt) to a
 * ChatProvider, execute any tool calls it makes, feed results back, and
 * repeat until the model produces a plain-text answer. This is the "harness"
 * core that planning (and later report) mode is built on.
 */
import type { ChatMessage, ChatProvider, ToolCall, ToolDefinition } from "../provider/types.ts";

export interface AgentTool {
  /** The description sent to the model. */
  definition: ToolDefinition;
  /** Executes the tool with parsed JSON args; result string is fed back. */
  execute: (args: Record<string, unknown>) => string | Promise<string>;
  /**
   * This tool blocks on the user (e.g. `ask_user`). Iterations spent only on
   * user-driven tools don't count against `maxIterations`: that budget exists
   * to stop a model spinning on its own, and a turn the person has to answer
   * with a keystroke can't spin. `HARD_MAX_ITERATIONS` still bounds the loop.
   */
  userDriven?: boolean;
}

export interface AgentOptions {
  provider: ChatProvider;
  /** Base system instruction (e.g. the user's system-prompt.md + campaign context). */
  systemPrompt?: string;
  tools: AgentTool[];
  /** Called with each assistant text delta (drives the streaming transcript). */
  onText?: (delta: string) => void;
  /** Called just before a tool executes. */
  onTool?: (name: string) => void;
  maxIterations?: number;
}

export interface AgentResult {
  /** The full conversation (including system/tool messages) for future turns. */
  messages: ChatMessage[];
  /** The final plain-text assistant answer. */
  answer: string;
}

const DEFAULT_MAX_ITERATIONS = 10;

/**
 * Absolute ceiling on turns, including user-driven ones. High enough that a
 * long question-and-answer exchange never hits it, low enough that nothing can
 * loop indefinitely.
 */
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
    const { content, toolCalls } = await streamTurn(options, messages, toolDefs);

    const assistant: ChatMessage = { role: "assistant", content, tool_calls: toolCalls };
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
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
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
