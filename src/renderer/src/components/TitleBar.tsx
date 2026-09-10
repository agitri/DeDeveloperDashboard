import { useStore } from "../state/store";

/**
 * The window's own bar — the one strip that belongs to the operating system
 * rather than to the board.
 *
 * Both looks draw their chrome edge-to-edge under an overlay title bar, so the
 * webview covers the area the window would normally be picked up by. Without a
 * declared drag region the window cannot be moved at all.
 *
 * `data-tauri-drag-region` is the entire mechanism, and it has to be on every
 * element the pointer can actually land on: Tauri matches the event target
 * exactly, so an attribute on the bar alone stops working the moment a child
 * sits under the cursor. What this replaces — `-webkit-app-region: drag` — is a
 * Chromium property that WKWebView and WebView2 both ignore, which is why
 * dragging by the rail never worked.
 *
 * Tauri's own handler also maps a double-click here to maximise/restore, so the
 * bar behaves like a title bar without us implementing either gesture.
 */
export function TitleBar() {
  const activeTab = useStore((s) => (s.ready ? s.activeTab() : null));
  const environments = useStore((s) => s.environments());
  const env = environments.find((e) => e.id === activeTab?.environmentId);

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-name" data-tauri-drag-region>
        {env && (
          <span
            className="titlebar-swatch"
            data-tauri-drag-region
            style={{ background: env.color }}
          />
        )}
        <span data-tauri-drag-region>
          {env ? `${env.name}${activeTab ? ` — ${activeTab.name}` : ""}` : "DDD"}
        </span>
      </div>
    </div>
  );
}
