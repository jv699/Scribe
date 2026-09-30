/**
 * Screen-specific slash commands handed to the chat screen. Like
 * `completions.ts`, this lives outside `screens/` so it can be tested without
 * a renderer, and keeps the chat screen ignorant of the store.
 */
import { mapReadiness } from "./agent/tools/draw-map.ts";
import type { ActiveOneshot } from "./agent/tools/types.ts";
import type { ChatCommand } from "./screens/chat.ts";

export const MAP_REQUEST = "Draw the full-page map for this plan.";

/**
 * `/map` asks for a full-page map only once the plan is fully planned — saved
 * or opened, with a `## Map` schematic — so an unready plan costs no model
 * turn. draw_map enforces the same gate on its own.
 */
export function oneshotCommands(oneshotsDir: string, active: ActiveOneshot): ChatCommand[] {
  return [
    {
      name: "map",
      description: "Draw a full-page map of the saved plan",
      run: async (chat) => {
        const readiness = await mapReadiness(oneshotsDir, active);
        if (readiness.ok) {
          chat.send(MAP_REQUEST);
          return;
        }
        switch (readiness.problem) {
          case "unsaved":
            chat.notice("Save the plan first — /map draws from a saved plan's ## Map schematic.");
            return;
          case "missing":
            chat.notice(`"${readiness.name}" is no longer in the one-shots folder.`, "danger");
            return;
          case "no-schematic":
            chat.notice(`"${readiness.name}" has no ## Map schematic yet — ask Scribe to add one, then try /map again.`);
            return;
        }
      },
    },
  ];
}
