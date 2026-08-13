/**
 * `@` mention sources for the chat prompt.
 *
 * Kept out of the screens so they stay ignorant of the store, and out of
 * `index.ts` so they can be tested without a renderer: these are pure data
 * builders over the campaign and the source library.
 */
import type { CompletionItem, CompletionSource } from "./components/autocomplete.ts";
import { loadCampaign, type Campaign } from "./store/campaigns.ts";
import { listOneshots } from "./store/oneshots.ts";
import { listSessions } from "./store/sessions.ts";
import { listSources } from "./store/sources.ts";

/**
 * Case-insensitive filter over label+description, shared by every `@` source
 * below so each one only has to build its full item list.
 */
export function filterCompletions(items: CompletionItem[], query: string): CompletionItem[] {
  const needle = query.toLowerCase();
  if (needle === "") return items;
  return items.filter((item) => `${item.label} ${item.description ?? ""}`.toLowerCase().includes(needle));
}

/**
 * `@` items for the source-document library: one per PDF, picking one inserts
 * a plain-language reference — "the ... source document" — rather than the
 * `@slug` markup, because that is what `search_sources`/`read_source_pages`
 * can act on, not a token the model has never been taught.
 */
export async function sourceItems(sourcesDir: string): Promise<CompletionItem[]> {
  const docs = await listSources(sourcesDir);
  return docs.map((doc) => ({
    label: `@${doc.slug}`,
    description: `${doc.system} · ${doc.pages} page${doc.pages === 1 ? "" : "s"}`,
    insert: `the "${doc.title}" source document`,
  }));
}

/** `@` completions for the Drafting Table, which has no campaign — sources only. */
export function sourceCompletions(sourcesDir: string): CompletionSource[] {
  return [
    {
      trigger: "@",
      items: async (query) => filterCompletions(await sourceItems(sourcesDir), query),
    },
  ];
}

/**
 * `@` completions for the Drafting Table: saved drafts plus reference PDFs in
 * one popup. Both libraries are re-read per keystroke so new files appear
 * without reopening the chat.
 */
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

/**
 * `@` mentions for a campaign chat: the campaign's two summary documents,
 * every session, and the source-document library. Picking one inserts a
 * plain-language reference rather than a markup token, because that is what
 * the agent can act on — "session 3 ("The Bell Tower")" points straight at
 * `read_session_notes(3)`, whereas `@session-3` would be syntax the model has
 * never been taught.
 *
 * Resolved on each keystroke rather than snapshotted, so sessions added while
 * the chat is open (or edited on disk) show up.
 */
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

        // Match titles too, so "@bell" finds the session called "The Bell
        // Tower" and not just labels that happen to start that way.
        return filterCompletions(items, query);
      },
    },
  ];
}
