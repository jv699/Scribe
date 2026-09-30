/**
 * Draws a full-page ASCII map of the active one-shot into `<slug>.map.md`
 * beside it. The model supplies only a grid layout; `src/map.ts` does all the
 * drawing. Gated on a fully planned document: saved (or loaded) and carrying
 * the `## Map` schematic the one-shot prompt asks for. `/map` in the Drafting
 * Table checks the same gate before asking for a map.
 */
import {
  CONNECTION_TYPES,
  MAX_COLUMNS,
  MAX_LOCATIONS,
  MAX_NAME_LENGTH,
  MAX_ROWS,
  ROOM_SIZES,
  hasMapSchematic,
  parseMapSpec,
  renderMap,
} from "../../map.ts";
import { findOneshot, writeOneshotMap, type SavedOneshot } from "../../store/oneshots.ts";
import { abbreviateHome } from "../../store/settings.ts";
import type { ActiveOneshot, ToolSpec } from "./types.ts";

export type MapReadiness =
  | { ok: true; plan: SavedOneshot }
  | { ok: false; problem: "unsaved" }
  | { ok: false; problem: "missing" | "no-schematic"; name: string };

/** Re-reads the active plan so the gate sees edits made outside the app. */
export async function mapReadiness(oneshotsDir: string, active: ActiveOneshot): Promise<MapReadiness> {
  const current = active.current;
  if (!current) return { ok: false, problem: "unsaved" };
  const plan = await findOneshot(oneshotsDir, current.slug);
  if (!plan) return { ok: false, problem: "missing", name: current.displayName };
  if (!hasMapSchematic(plan.body)) return { ok: false, problem: "no-schematic", name: plan.displayName };
  return { ok: true, plan };
}

function layoutProblems(errors: string[]): string {
  return `(no map drawn; fix the layout and call draw_map again:\n- ${errors.join("\n- ")})`;
}

export const drawMapTool: ToolSpec = {
  name: "draw_map",
  label: "Drawing the map",
  pastLabel: "Drew the map",
  definition: {
    type: "function",
    function: {
      name: "draw_map",
      description:
        "Draw a full-page ASCII map of the saved one-shot selected by read_oneshot or save_session, and save it " +
        'to its own file beside the plan. The plan must already have a "## Map" schematic. You give the layout; ' +
        `Scribe does the drawing. Place each location in one cell of a grid of at most ${MAX_COLUMNS} columns by ` +
        `${MAX_ROWS} rows (column 1 is the left edge, row 1 the top), keeping the schematic's arrangement. ` +
        "Connections are drawn straight along a row or column, or with one turn, and cannot pass through another " +
        "location's cell. If the layout has problems the result lists them; adjust and call again.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "The map title, usually the plan's title" },
          locations: {
            type: "array",
            description: `The plan's numbered locations, at most ${MAX_LOCATIONS}`,
            items: {
              type: "object",
              properties: {
                id: { type: "integer", description: "The location's number in the plan" },
                name: {
                  type: "string",
                  description: `The location's short name, as in the plan; at most ${MAX_NAME_LENGTH} characters`,
                },
                column: { type: "integer", description: `1-${MAX_COLUMNS}, left to right` },
                row: { type: "integer", description: `1-${MAX_ROWS}, top to bottom` },
                size: { type: "string", enum: [...ROOM_SIZES], description: "Relative size; defaults to medium" },
              },
              required: ["id", "name", "column", "row"],
            },
          },
          connections: {
            type: "array",
            items: {
              type: "object",
              properties: {
                from: { type: "integer", description: "A location id" },
                to: { type: "integer", description: "A location id; one-way connections run from → to" },
                type: { type: "string", enum: [...CONNECTION_TYPES], description: "Defaults to open" },
              },
              required: ["from", "to"],
            },
          },
        },
        required: ["locations", "connections"],
      },
    },
  },
  create({ oneshotsDir, activeOneshot }) {
    if (!oneshotsDir || !activeOneshot) return null;
    return {
      definition: drawMapTool.definition,
      execute: async (args) => {
        const readiness = await mapReadiness(oneshotsDir, activeOneshot);
        if (!readiness.ok) {
          switch (readiness.problem) {
            case "unsaved":
              return "(no map drawn: save the plan with save_session, or open one with read_oneshot, first)";
            case "missing":
              return `(no map drawn: "${readiness.name}" is no longer in the one-shots folder)`;
            case "no-schematic":
              return `(no map drawn: "${readiness.name}" has no "## Map" schematic yet; offer to add one first)`;
          }
        }
        const { plan } = readiness;
        const spec = parseMapSpec(args, plan.data["title"] ?? plan.displayName);
        if (!spec.ok) return layoutProblems(spec.errors);
        const page = renderMap(spec.value);
        if (!page.ok) return layoutProblems(page.errors);
        const { title, locations, connections } = spec.value;
        const path = await writeOneshotMap(plan, title, page.value);
        return (
          `Drew the full-page map for "${plan.displayName}" to ${abbreviateHome(path)} ` +
          `(${locations.length} locations, ${connections.length} connections). ` +
          "It is saved beside the plan; tell the user where it is rather than reproducing it."
        );
      },
    };
  },
};
