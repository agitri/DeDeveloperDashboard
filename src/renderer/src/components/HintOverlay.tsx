import { formatBinding } from "../keyboard/keys";
import { useUi } from "../state/ui";

/**
 * Hold ⌘ (or press ?) and the UI shows its keys. Tabs draw their own chips in
 * the strip; this is the rest — a compact sheet of everything else that is
 * bound right now.
 *
 * Hints are how shortcuts get learned. A hidden cheat sheet nobody opens is how
 * they die (§5.10).
 */
export function HintOverlay({ keymap }: { keymap: Record<string, string[]> }) {
  const visible = useUi((s) => s.hintsVisible);
  if (!visible) return null;

  const groups: { title: string; entries: [string, string][] }[] = [
    {
      title: "App",
      entries: [
        ["Command palette", "app.palette"],
        ["Settings", "app.settings"],
        ["Back to board", "app.board"],
      ],
    },
    {
      title: "Tabs",
      entries: [
        ["New tab", "tab.new"],
        ["Close tab", "tab.close"],
        ["Rename tab", "tab.rename"],
        ["Next / previous", "tab.next"],
        // The numbers are per environment, and that is the part worth saying:
        // ⌘3 is the third tab of the world you are in, not the third on screen.
        ["Go to tab 1…9 of this environment", "tab.go.1"],
      ],
    },
    {
      title: "Environments",
      entries: [
        ["Go to environment 1…9", "env.go.1"],
        ["…and again to fold the one you are in", "env.go.1"],
        ["New environment", "env.new"],
      ],
    },
    {
      title: "Board",
      entries: [
        ["Add widget", "widget.add"],
        ["Remove focused widget", "widget.remove"],
        ["Rearrange all widgets", "widget.arrange"],
        ["Focus next / previous widget", "focus.next"],
      ],
    },
    {
      // The three levels of focus, in the order you descend them: the widget
      // above, then the row, then the button on it.
      title: "Inside a widget",
      entries: [
        ["Next / previous item", "item.next"],
        ["Next / previous button on the row", "control.next"],
        ["Press the button, or open the item", "item.open"],
        ["Launch project", "item.launch"],
        ["Comment", "item.comment"],
        ["Approve", "item.approve"],
        ["Archive", "item.archive"],
      ],
    },
    {
      title: "Notes",
      entries: [
        ["Edit focused note", "edit.focused"],
        ["Save and render", "notes.save"],
      ],
    },
  ];

  return (
    <div
      className="hint"
      style={{
        right: 14,
        bottom: 14,
        display: "grid",
        gridTemplateColumns: "repeat(3, minmax(180px, 1fr))",
        gap: 14,
        padding: "12px 14px",
        border: "1px solid var(--line-strong)",
        borderRadius: 6,
        background: "var(--surface)",
        boxShadow: "var(--shadow)",
      }}
    >
      {groups.map((group) => (
        <div key={group.title}>
          <div className="mono-label" style={{ marginBottom: 6 }}>
            {group.title}
          </div>
          {group.entries.map(([label, actionId]) => {
            const binding = keymap[actionId]?.[0];
            if (!binding) return null;
            return (
              <div
                key={actionId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  justifyContent: "space-between",
                  padding: "2px 0",
                  color: "var(--ink-2)",
                  fontSize: 12,
                }}
              >
                <span>{label}</span>
                <kbd className="kbd">{formatBinding(binding)}</kbd>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
