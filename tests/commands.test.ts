import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAP_REQUEST, SAVE_REQUEST, oneshotCommands, saveUpdateRequest } from "../src/commands.ts";
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

/** Runs a Drafting Table command against a recording chat, returning what it sent and said. */
async function runCommand(name: string, active: ActiveOneshot, { hasMessages = true } = {}) {
  const sent: string[] = [];
  const notices: { text: string; tone: string | undefined }[] = [];
  const chat: ChatCommandContext = {
    send: (text) => void sent.push(text),
    notice: (text, tone) => void notices.push({ text, tone }),
    hasMessages: () => hasMessages,
  };
  const command = oneshotCommands(dir, active).find((candidate) => candidate.name === name)!;
  await command.run(chat);
  return { sent, notices };
}

const runMap = (active: ActiveOneshot) => runCommand("map", active);

describe("/save", () => {
  test("asks to save a new plan when none is open", async () => {
    expect(await runCommand("save", { current: null })).toEqual({ sent: [SAVE_REQUEST], notices: [] });
  });

  test("asks to save changes in place once the plan is saved or open", async () => {
    await saveOneshot(dir, { title: "Abbey", content: "plan" });
    const result = await runCommand("save", { current: await findOneshot(dir, "abbey") });
    expect(result).toEqual({ sent: [saveUpdateRequest("Abbey")], notices: [] });
    expect(result.sent[0]).toBe('Save the latest version of this plan to "Abbey".');
  });

  test("saves afresh when the open plan was deleted outside the app", async () => {
    const path = await saveOneshot(dir, { title: "Abbey", content: "plan" });
    const active: ActiveOneshot = { current: await findOneshot(dir, "abbey") };
    await unlink(path);
    expect((await runCommand("save", active)).sent).toEqual([SAVE_REQUEST]);
  });

  test("has nothing to save in an empty conversation, without a model turn", async () => {
    expect(await runCommand("save", { current: null }, { hasMessages: false })).toEqual({
      sent: [],
      notices: [{ text: "Nothing to save yet — plan something first.", tone: undefined }],
    });
  });

  test("lists before /map", () => {
    expect(oneshotCommands(dir, { current: null }).map((command) => command.name)).toEqual(["save", "map"]);
  });
});

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
