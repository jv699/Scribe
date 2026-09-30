import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAP_REQUEST, oneshotCommands } from "../src/commands.ts";
import type { ActiveOneshot } from "../src/agent/tools/types.ts";
import type { ChatCommandContext } from "../src/screens/chat.ts";
import { findOneshot, saveOneshot } from "../src/store/oneshots.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scribe-commands-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Runs /map against a recording chat, returning what it sent and said. */
async function runMap(active: ActiveOneshot) {
  const sent: string[] = [];
  const notices: { text: string; tone: string | undefined }[] = [];
  const chat: ChatCommandContext = {
    send: (text) => void sent.push(text),
    notice: (text, tone) => void notices.push({ text, tone }),
  };
  const map = oneshotCommands(dir, active).find((command) => command.name === "map")!;
  await map.run(chat);
  return { sent, notices };
}

describe("/map", () => {
  test("asks for the map once the plan is saved with a ## Map schematic", async () => {
    await saveOneshot(dir, { title: "Abbey", content: "## Map\n\n[1 Gate]" });
    const result = await runMap({ current: await findOneshot(dir, "abbey") });
    expect(result).toEqual({ sent: [MAP_REQUEST], notices: [] });
  });

  test("says to save first when no plan is active, without a model turn", async () => {
    const result = await runMap({ current: null });
    expect(result.sent).toEqual([]);
    expect(result.notices).toEqual([
      { text: "Save the plan first — /map draws from a saved plan's ## Map schematic.", tone: undefined },
    ]);
  });

  test("asks for a schematic when the saved plan has none", async () => {
    await saveOneshot(dir, { title: "Abbey", content: "## Hook\n\nNo map." });
    const result = await runMap({ current: await findOneshot(dir, "abbey") });
    expect(result.sent).toEqual([]);
    expect(result.notices[0]?.text).toBe(
      '"Abbey" has no ## Map schematic yet — ask Scribe to add one, then try /map again.',
    );
  });

  test("notices a plan deleted outside the app", async () => {
    const path = await saveOneshot(dir, { title: "Abbey", content: "## Map" });
    const active: ActiveOneshot = { current: await findOneshot(dir, "abbey") };
    await unlink(path);
    const result = await runMap(active);
    expect(result.sent).toEqual([]);
    expect(result.notices).toEqual([{ text: '"Abbey" is no longer in the one-shots folder.', tone: "danger" }]);
  });
});
