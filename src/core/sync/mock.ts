/**
 * A fake source, so the board can be built and demoed without credentials.
 * Port of `sync/mock.rs`. Mail runs through the *real* classifier so the mock
 * proves the filter is wired up, not just that rows render.
 */
import type { Item, ItemAction } from "../models";
import { itemId, type ActionRequest, type FetchContext, type SourceAdapter } from "./adapter";
import { classify, kindFor, mailSignals } from "./signal";

const SAMPLE: [string, string, string, string][] = [
  ["pr-142", "pull_request", "ddd", "Normalize the Item model across adapters"],
  ["pr-138", "pull_request", "ddd", "Grid canvas: only drag from the header"],
  ["cmt-91", "comment", "ddd", "Jordy commented on #142: can we keep refs stable?"],
  ["issue-77", "issue", "rene-it", "Outlook adapter: device-code flow"],
  ["issue-64", "issue", "rene-it", "Recap hook drops files edited via shell"],
];

const INBOX: [string, string, string[], boolean][] = [
  ["Jordy <jordy@vanbeurden.nl>", "Thursday still ok for the walkthrough?", [], true],
  ["noreply@github.com", "[GitHub] Your weekly digest", ["list-unsubscribe"], false],
  ["ci@buildserver.example", "Build failed: main #4821", [], false],
  ["Marjolein <m@rene-it.nl>", "Invoice question", [], true],
  ["newsletter@substack.com", "Weekly digest: 5 things", ["list-unsubscribe", "list-id"], false],
];

const minutesAgo = (now: number, minutes: number) => new Date(now - minutes * 60_000).toISOString();

export class MockAdapter implements SourceAdapter {
  readonly source = "mock";

  async fetch(cx: FetchContext): Promise<Item[]> {
    const now = Date.now();
    const items: Item[] = SAMPLE.map(([key, kind, project, title], index) => ({
      id: itemId(cx.connection.id, key),
      environmentId: cx.environmentId,
      connectionId: cx.connection.id,
      source: "mock",
      kind,
      project,
      title,
      body: "Sample item from the mock adapter.",
      url: `https://example.invalid/${key}`,
      refs: [],
      actions: [
        { id: "comment", label: "Comment", outbound: true },
        { id: "open", label: "Open", outbound: false },
      ] satisfies ItemAction[],
      // Staggered so ordering by recency is visibly doing something.
      updatedAt: minutesAgo(now, 17 * index),
      unread: index < 2,
    }));

    INBOX.forEach(([from, subject, headers, direct], index) => {
      const verdict = classify(mailSignals({ from, subject, headers, addressedDirectly: direct }));
      items.push({
        id: itemId(cx.connection.id, `mail-${index}`),
        environmentId: cx.environmentId,
        connectionId: cx.connection.id,
        source: "mock",
        kind: kindFor(verdict),
        project: null,
        title: `${from} — ${subject}`,
        body: `score ${verdict.score}`,
        url: null,
        refs: [...verdict.reasons],
        actions: [
          { id: "reply", label: "Reply", outbound: true },
          { id: "archive", label: "Archive", outbound: true },
        ],
        updatedAt: minutesAgo(now, 9 * index),
        unread: index === 0,
      });
    });

    return items;
  }

  async perform(_cx: FetchContext, request: ActionRequest): Promise<string> {
    return `mock: ${request.action} on ${request.item.title} (${request.input ?? "no input"})`;
  }
}
