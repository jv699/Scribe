// Mentions insert plain-language references that the agent's tools can resolve.
import type { CompletionItem, CompletionSource } from "./components/autocomplete.ts";
import { loadCampaign, type Campaign } from "./store/campaigns.ts";
import { listOneshots } from "./store/oneshots.ts";
import { listSessions } from "./store/sessions.ts";
import { listSources } from "./store/sources.ts";

export function filterCompletions(items: CompletionItem[], query: string): CompletionItem[] {
  const needle = query.toLowerCase();
  if (needle === "") return items;
  return items.filter((item) => `${item.label} ${item.description ?? ""}`.toLowerCase().includes(needle));
}

export async function sourceItems(sourcesDir: string): Promise<CompletionItem[]> {
  const docs = await listSources(sourcesDir);
  return docs.map((doc) => ({
    label: `@${doc.slug}`,
    description: `${doc.system} · ${doc.pages} page${doc.pages === 1 ? "" : "s"}`,
    insert: `the "${doc.title}" source document`,
  }));
}

/** Re-read libraries per keystroke so new files appear without reopening chat. */
export function oneshotCompletions(oneshotsDir: string, sourcesDir: string): CompletionSource[] {
  return [
    {
      trigger: "@",
      items: async (query) => {
        const drafts = await listOneshots(oneshotsDir);
        const items: CompletionItem[] = [
          ...drafts.map((draft) => ({
            label: `@oneshot-${draft.slug}`,
            description: `${draft.displayName} · saved one-shot`,
            insert: `the saved one-shot "${draft.slug}"`,
          })),
          ...(await sourceItems(sourcesDir)),
        ];
        return filterCompletions(items, query);
      },
    },
  ];
}

/** Re-read campaign data per keystroke to include sessions added or edited on disk. */
export function campaignCompletions(campaign: Campaign, sourcesDir: string): CompletionSource[] {
  return [
    {
      trigger: "@",
      items: async (query) => {
        const fresh = (await loadCampaign(campaign.dir)) ?? campaign;
        const sessions = await listSessions(fresh);
        const items: CompletionItem[] = [
          {
            label: "@background",
            description: "The campaign premise",
            insert: "the campaign background",
          },
          {
            label: "@story-so-far",
            description: "The running campaign summary",
            insert: "the campaign's story so far",
          },
          ...sessions.map((session) => ({
            label: `@session-${session.number}`,
            description: `${session.title} · ${session.status}`,
            insert: `session ${session.number} ("${session.title}")`,
          })),
          ...(await sourceItems(sourcesDir)),
        ];

        return filterCompletions(items, query);
      },
    },
  ];
}
