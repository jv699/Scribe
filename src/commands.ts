/**
 * Screen-specific slash commands handed to the chat screen. Like
 * `completions.ts`, this lives outside `screens/` so it can be tested without
 * a renderer, and keeps the chat screen ignorant of the store.
 */
import { mapReadiness } from "./agent/tools/draw-map.ts";
import type { ActiveOneshot } from "./agent/tools/types.ts";
import type { ChatCommand } from "./screens/chat.ts";
import { findOneshot } from "./store/oneshots.ts";

export const SAVE_REQUEST = "Save this plan.";
export const MAP_REQUEST = "Draw the full-page map for this plan.";

export function saveUpdateRequest(displayName: string): string {
  return `Save the latest version of this plan to "${displayName}".`;
}

/**
 * The Drafting Table's commands. Each turns into a plain-language request the
 * agent acts on with its tools, after checking locally whatever it can, so a
 * request that can't succeed costs no model turn.
 */
export function oneshotCommands(oneshotsDir: string, active: ActiveOneshot): ChatCommand[] {
  return [
    {
      name: "save",
      description: "Save the plan, or save changes to the open one",
      /**
       * An explicit request, which is what save_session waits for. A plan
       * that is already saved or open gets its changes saved in place, so
       * saving twice doesn't leave a second copy behind.
       */
      run: async (chat) => {
        if (!chat.hasMessages()) {
          chat.notice("Nothing to save yet — plan something first.");
          return;
        }
        // Re-read so a plan deleted outside the app is saved afresh.
        const saved = active.current && (await findOneshot(oneshotsDir, active.current.slug));
        chat.send(saved ? saveUpdateRequest(saved.displayName) : SAVE_REQUEST);
      },
    },
    {
      name: "map",
      description: "Draw a full-page map of the saved plan",
      /**
       * Only once the plan is fully planned — saved or opened, with a
       * `## Map` schematic. draw_map enforces the same gate on its own.
       */
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
