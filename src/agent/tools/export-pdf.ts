/**
 * Exports the active one-shot as a printable PDF, `<slug>.pdf` beside the
 * plan, with its full-page map (if one has been drawn) on a landscape page at
 * the end. The PDF is a printout of the saved markdown, which stays the real
 * copy, so a plan must be saved (or opened) first. `/pdf` in the Drafting
 * Table runs the same export directly, without a model turn.
 */
import { renderPlanPdf } from "../../pdf.ts";
import { findOneshot, readOneshotMap, writeOneshotPdf, type SavedOneshot } from "../../store/oneshots.ts";
import { abbreviateHome } from "../../store/settings.ts";
import type { ActiveOneshot, ToolSpec } from "./types.ts";

export type PdfExport =
  | { ok: true; plan: SavedOneshot; path: string; pages: number; withMap: boolean }
  | { ok: false; problem: "unsaved" }
  | { ok: false; problem: "missing"; name: string };

/**
 * Renders the active plan as it is on disk (re-read, so edits made outside
 * the app are printed) and writes its PDF. Throws when a file Scribe didn't
 * make is in the way.
 */
export async function exportActivePdf(oneshotsDir: string, active: ActiveOneshot): Promise<PdfExport> {
  const current = active.current;
  if (!current) return { ok: false, problem: "unsaved" };
  const plan = await findOneshot(oneshotsDir, current.slug);
  if (!plan) return { ok: false, problem: "missing", name: current.displayName };
  const map = await readOneshotMap(plan);
  const pdf = renderPlanPdf({
    title: plan.data["title"] || plan.displayName,
    body: plan.body,
    slug: plan.slug,
    ...(map ? { map } : {}),
    ...(plan.data["system"] ? { subtitle: plan.data["system"] } : {}),
  });
  const path = await writeOneshotPdf(plan, pdf.bytes);
  return { ok: true, plan, path, pages: pdf.pages, withMap: map !== null };
}

/** "3 pages, including the map" — shared wording for the tool and /pdf. */
export function describePdf(result: Extract<PdfExport, { ok: true }>): string {
  const pages = `${result.pages} ${result.pages === 1 ? "page" : "pages"}`;
  return `${abbreviateHome(result.path)} (${pages}${result.withMap ? ", including the map" : ""})`;
}

export const exportPdfTool: ToolSpec = {
  name: "export_pdf",
  label: "Making the PDF",
  pastLabel: "Made the PDF",
  definition: {
    type: "function",
    function: {
      name: "export_pdf",
      description:
        "Make a printable PDF of the saved one-shot selected by read_oneshot or save_session, saved beside the " +
        "plan as a US Letter PDF. Its full-page map, if one has been drawn, is included on its own page. The PDF " +
        "is made from the saved markdown, so save any changes first; call again to refresh it after edits.",
      parameters: { type: "object", properties: {} },
    },
  },
  create({ oneshotsDir, activeOneshot }) {
    if (!oneshotsDir || !activeOneshot) return null;
    return {
      definition: exportPdfTool.definition,
      execute: async () => {
        let result: PdfExport;
        try {
          result = await exportActivePdf(oneshotsDir, activeOneshot);
        } catch (error) {
          return `(no PDF made: ${(error as Error).message})`;
        }
        if (!result.ok) {
          return result.problem === "unsaved"
            ? "(no PDF made: save the plan with save_session, or open one with read_oneshot, first)"
            : `(no PDF made: "${result.name}" is no longer in the one-shots folder)`;
        }
        return `Saved a PDF of "${result.plan.displayName}" to ${describePdf(result)}. Tell the user where it is.`;
      },
    };
  },
};
