import { useCallback, useEffect, useMemo, useState } from "react";
import { compiledFilterOf, presetFilterOf, resolveFilter } from "../lib/instructions";
import { ipc } from "../lib/ipc";
import { useFocus } from "../state/focus";
import { useStore } from "../state/store";
import { useUi } from "../state/ui";
import type { AiActionInfo, AiContext, Item, ItemAction, ItemFilter } from "../types";
import type { WidgetViewProps } from "./registry";
import { Empty } from "../components/Status";
import { useRemembered } from "../state/remembered";
import { firstLoad } from "../state/timing";

/**
 * The one view for every item source.
 *
 * "My PRs", "PR comments only", "Issues assigned to me" and "everything from
 * this repo" are not four widgets — they are this widget with four filters
 * (§5.2). Adding GitHub did not add a view; adding Gmail will not either.
 *
 * It reads the cache and never fetches. The scheduler owns the network, which
 * is why putting the same widget on five tabs costs nothing.
 */
export function ItemsWidget({ widget, environmentId, focused, itemIndex }: WidgetViewProps) {
  const [items, setItems] = useRemembered<Item[]>(`items:${environmentId}:${widget.id}`, []);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState<{ itemId: string; action: string } | null>(null);
  const registerWidget = useFocus((s) => s.registerWidget);
  const unregisterWidget = useFocus((s) => s.unregisterWidget);
  const showToast = useUi((s) => s.showToast);
  const logEvent = useStore((s) => s.logEvent);

  // The widget's own filter, with any compiled instructions merged under it.
  // Precedence and the reasoning behind it live in one place: lib/instructions.
  const filter = useMemo(() => resolveFilter(widget.filter, presetFilterOf(widget), compiledFilterOf(widget)) as ItemFilter, [widget]);

  const load = useCallback(async () => {
    try {
      // A widget's stored filter that names neither `kind` nor
      // `excludeKinds` is the catch-all "Everything" feed — and repos now
      // live in the same cache as everything else. A catch-all feed means
      // "things that want my attention"; a repo is a directory entry, not
      // something that wants attention, so it's opt-in via the dedicated
      // Repositories widget, not something every pre-existing widget
      // suddenly fills up with. Applied only to the query sent, not written
      // back into `widget.filter` — a widget explicitly scoped to `kind:
      // "repo"` (or one with its own `excludeKinds`) must not be touched.
      const effective = filter.kind == null && filter.excludeKinds == null ? { ...filter, excludeKinds: ["repo"] } : filter;
      setItems(await firstLoad("items", () => ipc.itemsQuery(environmentId, effective)));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [environmentId, filter, setItems]);

  useEffect(() => {
    void load();
  }, [load]);

  // The scheduler tells us when the cache moved. No polling here — that would
  // be a second cadence competing with the one that owns the rate limit.
  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void ipc
      .onItemsChanged(({ environmentId: changed }) => {
        if (changed === environmentId) void load();
      })
      .then((unlisten) => (cancelled ? unlisten() : (dispose = unlisten)));
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [environmentId, load]);

  const perform = useCallback(
    async (item: Item, action: string, input?: string) => {
      if (action === "open") {
        if (item.url) void ipc.openExternal(item.url);
        return;
      }
      try {
        const outcome = await ipc.itemAction(environmentId, item.id, action, input);
        showToast(outcome);
        setComposing(null);
        void load();
      } catch (e) {
        showToast(String(e));
      }
    },
    [environmentId, load, showToast],
  );

  // Verbs the keyboard layer can bind without knowing what this widget holds.
  useEffect(() => {
    registerWidget(
      widget.id,
      items.length,
      (index) => {
        const item = items[index];
        if (item?.url) void ipc.openExternal(item.url);
      },
      {
        comment: (index) => {
          const item = items[index];
          // An outbound action never fires straight from a keypress: the key
          // opens the composer, the human submits it (principle #3).
          if (item) setComposing({ itemId: item.id, action: "comment" });
        },
        approve: (index) => {
          const item = items[index];
          if (item?.actions.some((a) => a.id === "approve")) {
            setComposing({ itemId: item.id, action: "approve" });
          }
        },
        archive: (index) => {
          const item = items[index];
          if (item?.actions.some((a) => a.id === "mark_read")) void perform(item, "mark_read");
        },
      },
    );
    return () => unregisterWidget(widget.id);
  }, [widget.id, items, registerWidget, unregisterWidget, perform]);

  if (error) {
    return <div className="widget-error">{error}</div>;
  }

  if (items.length === 0) {
    return (
      <Empty
        title="Nothing here yet."
        body={
          filter.connectionId
            ? "The scheduler will fill this in on its next pass."
            : "Connect an account in Settings → Connections, then this fills itself."
        }
        meta={
          <button
            className="btn sm"
            onClick={() => {
              void ipc.syncNow(environmentId, filter.connectionId ?? undefined).then(load);
              logEvent({ kind: "sync.manual" });
            }}
          >
            Sync now
          </button>
        }
      />
    );
  }

  return (
    <div className="rows">
      {items.map((item, index) => (
        <ItemRow
          key={item.id}
          item={item}
          environmentId={environmentId}
          selected={focused && index === itemIndex}
          composing={composing?.itemId === item.id ? composing.action : null}
          onCompose={(action) => setComposing({ itemId: item.id, action })}
          onCancel={() => setComposing(null)}
          onPerform={(action, input) => void perform(item, action, input)}
        />
      ))}
    </div>
  );
}

function ItemRow({
  item,
  environmentId,
  selected,
  composing,
  onCompose,
  onCancel,
  onPerform,
}: {
  item: Item;
  environmentId: string;
  selected: boolean;
  composing: string | null;
  onCompose: (action: string) => void;
  onCancel: () => void;
  onPerform: (action: string, input?: string) => void;
}) {
  const [aiActions, setAiActions] = useState<AiActionInfo[]>([]);
  const [context, setContext] = useState<AiContext | null>(null);
  const [showContext, setShowContext] = useState(false);
  const [panel, setPanel] = useState<{ label: string; text: string; note: string } | null>(null);
  const [thinking, setThinking] = useState<string | null>(null);
  const showToast = useUi((s) => s.showToast);

  // Asked for, not guessed: a new action shows up on the right rows without a
  // change here.
  useEffect(() => {
    let cancelled = false;
    void ipc
      .aiActionsFor(environmentId, item.id)
      .then((actions) => {
        if (cancelled) return;
        setAiActions(actions);
        // The count comes with the actions rather than on click, so the control
        // is informative at rest — the same reason the widget's [AI] button
        // carries a dot instead of making you open it to find out. Reading a
        // directory is cheap and nothing is sent.
        if (actions.length > 0) {
          void ipc
            .aiContextFor(environmentId, item.id)
            .then((c) => !cancelled && setContext(c))
            .catch(() => {});
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [environmentId, item.id]);

  async function runPanelAction(action: AiActionInfo) {
    setThinking(action.id);
    try {
      const draft = await ipc.aiDraft(environmentId, item.id, action.id);
      if (draft.refusal) {
        showToast(draft.refusal);
        return;
      }
      setPanel({ label: action.label, text: draft.text, note: describe(draft) });
    } catch (e) {
      showToast(String(e));
    } finally {
      setThinking(null);
    }
  }

  return (
    <div className={`row stacked${selected ? " selected" : ""}${item.unread ? " unread" : ""}`}>
      <div className="row-line">
        {/* The unread mark is always in the DOM: it is the first grid column,
            and a row that omitted it would sit 10px left of its neighbours. */}
        <span className="row-mark" title={item.unread ? "Unread" : undefined} />
        <div className="row-main">
          <div className="row-title">{item.title}</div>
          <div className="row-sub">
            {item.body}
            <FilterReason item={item} />
          </div>
        </div>
        <span className="row-time">{relative(item.updatedAt)}</span>
        <div className="row-actions" data-open={selected || undefined}>
          {aiActions.length > 0 && (
            // The same shape as the widget's [AI] button: a marked control that
            // shows what an action will be given *before* it runs. The count is
            // the project card's own `icm N` vocabulary.
            <button
              className={`btn sm${showContext ? " primary" : ""}`}
              title="What these actions will be given — the project context, before anything runs"
              onClick={() => setShowContext((open) => !open)}
            >
              icm {context ? (context.plan?.files.length ?? 0) : "…"}
            </button>
          )}
          {aiActions
            .filter((a) => a.target === "panel")
            .map((action) => (
              <button
                key={action.id}
                className="btn sm"
                title="Produces a proposal — nothing is sent"
                disabled={thinking !== null}
                onClick={() => void runPanelAction(action)}
              >
                {thinking === action.id ? "…" : action.label}
              </button>
            ))}
          {item.actions.map((action) => (
            <ActionButton
              key={action.id}
              action={action}
              onClick={() =>
                // Outbound actions open a composer to be approved; read-only
                // ones just happen.
                action.outbound && action.id !== "mark_read" ? onCompose(action.id) : onPerform(action.id)
              }
            />
          ))}
        </div>
      </div>

      {showContext && <IcmPanel context={context} onClose={() => setShowContext(false)} />}

      {panel && (
        <div className="item-detail">
          <div className="note drafted">
            <div className="mono-label caption">
              {panel.label} · {panel.note}
            </div>
            {panel.text}
            <div className="button-row">
              <button className="btn" onClick={() => setPanel(null)}>
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      {composing && (
        <Composer
          action={composing}
          onCancel={onCancel}
          onSubmit={(text) => onPerform(composing, text)}
          onDraft={aiActions.some((a) => a.target === "composer") ? () => ipc.aiDraft(environmentId, item.id, "mail.draft") : undefined}
        />
      )}
    </div>
  );
}

/** Provenance for a proposal: which model, and whether it saw project context. */
/**
 * What an AI action on this item will be given, before it is given.
 *
 * The [AI] button on a widget shows you the instruction, the file it lives in,
 * and what was made of it — all before it applies. This is the same idea for
 * the other half of the AI layer: an action's context was only ever reported
 * afterwards, as the words "with project context", which tells you it happened
 * and nothing about what happened.
 */
function IcmPanel({ context, onClose }: { context: AiContext | null; onClose: () => void }) {
  if (!context) return <div className="item-detail ink-3">reading…</div>;

  const { plan } = context;
  return (
    <div className="item-detail stack">
      <div className="mono-label caption">what these actions will be given</div>

      {!plan ? (
        <div className="ink-2">
          This item is not matched to a project on disk, so an action gets the item and nothing else. Map its repository to a checkout and
          its <code>.ddd/icm/</code> is read from then on.
        </div>
      ) : plan.missing ? (
        <div className="ink-2">
          <b>{context.project}</b> has no <code>.ddd/icm/</code> folder, so an action gets the item and nothing else. Anything you write
          there — conventions, architecture, what you are in the middle of — is read on every action.
        </div>
      ) : plan.files.length === 0 ? (
        <div className="ink-2">
          <b>{context.project}</b> has an <code>.ddd/icm/</code> folder with nothing in it.
        </div>
      ) : (
        <>
          {plan.files.map((file) => (
            <div key={file.path} className="row-sub">
              <span className="ink-2 finding-name">{file.name}</span>
              <span className="meta ink-3">
                {file.truncated ? `${format(file.used)} of ${format(file.bytes)} — clipped` : format(file.bytes)}
              </span>
            </div>
          ))}
          {plan.skipped.length > 0 && <div className="tone-warn">past the budget, not read: {plan.skipped.join(", ")}</div>}
          <div className="mono-label">
            {format(plan.totalUsed)} of {format(plan.budget)} budget · sent with every action on this item
          </div>
        </>
      )}

      <div className="button-row">
        {plan && !plan.missing && (
          <button className="btn sm" onClick={() => void ipc.revealPath(plan.dir)}>
            Open the folder
          </button>
        )}
        <button className="btn sm" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

/** Bytes, in the units a person reads. */
function format(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} kB`;
}

function describe(draft: { model: string; usedProjectContext: boolean; costMicros: number }): string {
  const cost = draft.costMicros > 0 ? ` · $${(draft.costMicros / 1_000_000).toFixed(4)}` : "";
  return `${draft.model}${draft.usedProjectContext ? " · with project context" : " · no project context"}${cost}`;
}

/**
 * Why the signal filter made the call it made.
 *
 * A filter you cannot argue with is a filter you stop trusting — and this is
 * the surface where a wrong verdict becomes a bug report instead of a shrug.
 */
function FilterReason({ item }: { item: Item }) {
  const reasons = item.refs.filter((r) => r.startsWith("noise:") || r.startsWith("signal:"));
  if (reasons.length === 0) return null;

  const noise = reasons.some((r) => r.startsWith("noise:"));
  return (
    <span
      title={reasons.join("\n")}
      style={{
        marginLeft: item.body ? 8 : 0,
        paddingLeft: item.body ? 8 : 0,
        borderLeft: item.body ? "1px solid var(--line)" : undefined,
        color: noise ? "var(--ink-3)" : "var(--ok)",
        cursor: "help",
      }}
    >
      {reasons[0]!.replace(/^(noise|signal):/, "")}
      {reasons.length > 1 && ` +${reasons.length - 1}`}
    </span>
  );
}

function ActionButton({ action, onClick }: { action: ItemAction; onClick: () => void }) {
  return (
    <button
      className="btn sm"
      // The dot marks anything that leaves the machine, so "this sends
      // something" is visible before you click rather than after.
      title={action.outbound ? `${action.label} — sends to the source` : action.label}
      onClick={onClick}
    >
      {action.outbound && <span className="tone-warn">•</span>}
      {action.label}
    </button>
  );
}

/**
 * The approval gate, as a piece of UI. Nothing reaches `item_action` without
 * passing through something like this — including, later, anything the AI
 * drafted: it arrives pre-filled here, and a person still presses Send.
 */
function Composer({
  action,
  onSubmit,
  onCancel,
  onDraft,
}: {
  action: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
  /** Fills the box with a proposal. It is still the human who presses Send. */
  onDraft?: () => Promise<{ text: string; refusal?: string | null; model: string; usedProjectContext: boolean; costMicros: number }>;
}) {
  const [text, setText] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [provenance, setProvenance] = useState<string | null>(null);
  const showToast = useUi((s) => s.showToast);
  const needsText = action !== "approve";

  async function draft() {
    if (!onDraft) return;
    setDrafting(true);
    try {
      const result = await onDraft();
      if (result.refusal) {
        showToast(result.refusal);
        return;
      }
      // Replaces the box contents; the human edits from here.
      setText(result.text);
      setProvenance(describe(result));
    } catch (e) {
      showToast(String(e));
    } finally {
      setDrafting(false);
    }
  }

  return (
    <div className="item-detail stack">
      <textarea
        className="field draft"
        autoFocus
        rows={3}
        placeholder={action === "approve" ? "Optional approval note…" : `Your ${action}…`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSubmit(text);
        }}
      />
      <div className="button-row">
        <button className="btn primary" disabled={needsText && !text.trim()} onClick={() => onSubmit(text)}>
          Send {action}
        </button>
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        {onDraft && (
          <button className="btn" disabled={drafting} onClick={() => void draft()}>
            {drafting ? "Drafting…" : "Draft with AI"}
          </button>
        )}
        <span className="mono-label">{provenance ?? "⌘↩ to send · esc to cancel"}</span>
      </div>
    </div>
  );
}

function relative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
