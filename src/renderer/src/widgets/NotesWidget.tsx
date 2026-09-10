import { useEffect, useRef, useState, type ReactNode } from "react";
import { parse, type Block, type Inline } from "../lib/markdown";
import {
  DEFAULT_TOOLBAR,
  TOOLBAR_BUTTONS,
  applyButton,
  buttonById,
  toggleTask,
} from "../lib/toolbar";
import { useStore } from "../state/store";
import { useUi } from "../state/ui";
import type { MenuItem } from "../components/ContextMenu";
import type { Widget } from "../types";
import type { WidgetViewProps } from "./registry";

/**
 * Notes live in the widget's own `config` inside layout.json — which is the
 * point: your board file is readable, diffable and shareable, notes included.
 *
 * Two modes. Rendered markdown at rest; a textarea plus a formatting toolbar
 * while editing. ⌘E enters (only while this widget is focused — otherwise ⌘E
 * still renames the tab), ⌘S and Escape leave.
 */
export function NotesWidget({ widget, focused }: WidgetViewProps) {
  const updateWidget = useStore((s) => s.updateWidget);
  const editingNoteId = useUi((s) => s.editingNoteId);
  const editNote = useUi((s) => s.editNote);
  const [text, setText] = useState(() => String(widget.config.text ?? ""));
  const editing = editingNoteId === widget.id;

  // Debounced so a paragraph of typing is one layout write, not eighty.
  useEffect(() => {
    if (text === (widget.config.text ?? "")) return;
    const timer = setTimeout(() => {
      updateWidget(widget.id, { config: { ...widget.config, text } });
    }, 350);
    return () => clearTimeout(timer);
  }, [text, widget.id, widget.config, updateWidget]);

  // A note deleted mid-edit would otherwise leave ⌘S pointing at nothing.
  useEffect(() => {
    return () => {
      if (useUi.getState().editingNoteId === widget.id) useUi.getState().editNote(null);
    };
  }, [widget.id]);

  if (editing) {
    return (
      <Editor
        widget={widget}
        text={text}
        setText={setText}
        onDone={() => editNote(null)}
      />
    );
  }

  return (
    <Rendered
      text={text}
      focused={focused}
      onEdit={() => editNote(widget.id)}
      onToggleTask={(line) => setText((current) => toggleTask(current, line))}
    />
  );
}

/** The widget's own right-click rows, spliced into the generic widget menu. */
export function notesMenuItems(widget: Widget): MenuItem[] {
  return [
    {
      kind: "action",
      label: "Edit note",
      run: () => useUi.getState().editNote(widget.id),
    },
    {
      kind: "submenu",
      label: "Toolbar",
      items: TOOLBAR_BUTTONS.map((button) => {
        const current = toolbarOf(widget);
        const on = current.includes(button.id);
        return {
          kind: "action" as const,
          label: `${on ? "✓ " : "   "}${button.title}`,
          run: () =>
            useStore.getState().updateWidget(widget.id, {
              config: {
                ...widget.config,
                // Store the whole list, not a diff: the catalog can grow, and
                // a stored diff would silently change meaning when it does.
                toolbar: on
                  ? current.filter((id) => id !== button.id)
                  : [...current, button.id],
              },
            }),
        };
      }),
    },
  ];
}

function toolbarOf(widget: Widget): string[] {
  const stored = widget.config.toolbar;
  return Array.isArray(stored) ? (stored as string[]) : DEFAULT_TOOLBAR;
}

function Editor({
  widget,
  text,
  setText,
  onDone,
}: {
  widget: Widget;
  text: string;
  setText: (v: string) => void;
  onDone: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);

  // Unknown ids are skipped rather than rendered as blanks: the catalog can
  // shrink between versions and a note should not break because of it.
  const buttons = toolbarOf(widget)
    .map(buttonById)
    .filter((b): b is NonNullable<typeof b> => b !== undefined);

  function press(id: string) {
    const area = ref.current;
    const button = buttonById(id);
    if (!area || !button) return;
    const edit = applyButton(button, text, area.selectionStart, area.selectionEnd);
    setText(edit.text);
    // Restore the selection after React has written the new value, or the
    // caret snaps to the end and the next button press targets the wrong text.
    requestAnimationFrame(() => {
      area.focus();
      area.setSelectionRange(edit.selStart, edit.selEnd);
    });
  }

  return (
    <div className="note-edit">
      {buttons.length > 0 && (
        <div className="note-toolbar">
          {buttons.map((button) => (
            <button
              key={button.id}
              className="btn"
              title={button.title}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => press(button.id)}
            >
              {button.label}
            </button>
          ))}
          <span className="grow" />
          <button className="btn primary" title="Save and render (⌘S)" onClick={onDone}>
            Done
          </button>
        </div>
      )}
      <textarea
        ref={ref}
        className="note-area"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Markdown…"
        spellCheck={false}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onDone();
          }
        }}
      />
    </div>
  );
}

function Rendered({
  text,
  focused,
  onEdit,
  onToggleTask,
}: {
  text: string;
  focused: boolean;
  onEdit: () => void;
  onToggleTask: (line: number) => void;
}) {
  const blocks = parse(text);

  // An empty note rendered as a blank pane is a dead end — there is nothing to
  // double-click. One click opens it.
  if (text.trim() === "") {
    return (
      <div className="note-empty" onClick={onEdit}>
        Empty note — click to write. Markdown supported.
      </div>
    );
  }

  return (
    <div
      className={`note-view prose${focused ? " focused" : ""}`}
      onDoubleClick={onEdit}
      title="Double-click to edit (⌘E while focused)"
    >
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} onToggleTask={onToggleTask} />
      ))}
    </div>
  );
}

function BlockView({
  block,
  onToggleTask,
}: {
  block: Block;
  onToggleTask: (line: number) => void;
}): ReactNode {
  switch (block.t) {
    case "heading": {
      const Tag = `h${block.level}` as "h1";
      return (
        <Tag className="note-h">
          <InlineView kids={block.kids} />
        </Tag>
      );
    }
    case "para":
      return (
        <p>
          <InlineView kids={block.kids} />
        </p>
      );
    case "quote":
      return (
        <blockquote>
          <InlineView kids={block.kids} />
        </blockquote>
      );
    case "code":
      return <pre className="note-code">{block.v}</pre>;
    case "rule":
      return <hr />;
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag>
          {/* Per item, not per list: a list mixing tasks with plain bullets
              must keep the bullet on the plain ones. */}
          {block.items.map((item, i) => (
            <li key={i} className={item.task ? "task" : undefined}>
              {item.task && (
                <input
                  type="checkbox"
                  checked={item.task.checked}
                  // The one place the rendered view writes: a checkbox you
                  // cannot tick is a picture of a checkbox.
                  onChange={() => onToggleTask(item.task!.line)}
                  onDoubleClick={(e) => e.stopPropagation()}
                />
              )}
              <InlineView kids={item.kids} />
            </li>
          ))}
        </Tag>
      );
    }
  }
}

function InlineView({ kids }: { kids: Inline[] }): ReactNode {
  return kids.map((node, i) => {
    switch (node.t) {
      case "text":
        return <span key={i}>{node.v}</span>;
      case "bold":
        return (
          <strong key={i}>
            <InlineView kids={node.kids} />
          </strong>
        );
      case "italic":
        return (
          <em key={i}>
            <InlineView kids={node.kids} />
          </em>
        );
      case "strike":
        return (
          <s key={i}>
            <InlineView kids={node.kids} />
          </s>
        );
      case "code":
        return (
          <code key={i} className="note-inline-code">
            {node.v}
          </code>
        );
      case "link":
        // The parser already refused anything that could execute; rel guards
        // the opener, and the widget never navigates itself.
        return (
          <a key={i} href={node.href} target="_blank" rel="noreferrer noopener">
            <InlineView kids={node.kids} />
          </a>
        );
    }
  });
}
