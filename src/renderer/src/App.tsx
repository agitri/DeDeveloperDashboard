import { useEffect, useRef, useState } from "react";
import { Canvas } from "./components/Canvas";
import { ConsoleRail } from "./components/ConsoleRail";
import { CommandPalette } from "./components/CommandPalette";
import { EnvironmentOverview } from "./components/EnvironmentOverview";
import { ContextMenu } from "./components/ContextMenu";
import { FeaturesGuide } from "./components/FeaturesGuide";
import { HintOverlay } from "./components/HintOverlay";
import { SettingsPage } from "./components/SettingsPage";
import { TabStrip } from "./components/TabStrip";
import { TitleBar } from "./components/TitleBar";
import { WidgetPicker } from "./components/WidgetPicker";
import { Wizard } from "./components/Wizard";
import { IS_MAC, formatBinding } from "./keyboard/keys";
import { useGlobalKeys, useKeymap } from "./keyboard/useKeyboard";
import { ipc } from "./lib/ipc";
import { isConsole, rememberLook } from "./lib/look";
import { useWizard } from "./onboarding/useWizard";
import { useStore } from "./state/store";
import { useUi } from "./state/ui";

export default function App() {
  const ready = useStore((s) => s.ready);
  const load = useStore((s) => s.load);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const activeTab = useStore((s) => (s.ready ? s.activeTab() : null));
  const overviewEnvId = useStore((s) => s.overviewEnvId);
  const environments = useStore((s) => s.environments());
  const theme = useStore((s) => (s.ready ? s.appearance().theme : "system"));
  const hintsEnabled = useStore((s) => (s.ready ? s.appearance().showShortcutHints : true));
  const toast = useUi((s) => s.toast);
  const togglePalette = useUi((s) => s.togglePalette);

  const keymap = useKeymap();
  useGlobalKeys(keymap);

  // The rail's width. Persisted directly rather than through layout.json: it is
  // a property of this window, not of the board, and it must not travel when a
  // layout is exported.
  const [railWide, setRailWide] = useState(() => localStorage.getItem("ddd:railWide") === "1");

  useEffect(() => {
    void load();
    document.documentElement.dataset.platform = IS_MAC ? "mac" : "other";
  }, [load]);

  // First-run: once the board has actually loaded, an absent or unfinished
  // tour starts itself. Guarded with a ref rather than `global.wizard` alone —
  // `start` persists `step` on its own first advance, and without the ref that
  // write would immediately re-arm this same effect. Native-only: the browser
  // preview has no `~/.ddd/global.json` for it to mean anything against.
  const firstRunRef = useRef(false);
  useEffect(() => {
    if (!ready || firstRunRef.current || !ipc.isNative) return;
    const wizard = useStore.getState().global?.wizard;
    if (wizard?.completed) return;
    firstRunRef.current = true;
    useWizard.getState().start(wizard?.step ?? 0);
  }, [ready]);

  // Theme. `system` follows the OS live rather than only at startup.
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = theme === "system" ? (media.matches ? "dark" : "light") : theme;
      document.documentElement.dataset.theme = resolved;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  // The look is decided before React mounts, from a localStorage cache, because
  // settings arrive over async IPC. Keep the cache in step with the setting so
  // the next window load renders what was chosen.
  const look = useStore((s) => (s.ready ? s.appearance().look : undefined));
  const [lookChanged, setLookChanged] = useState(false);
  useEffect(() => {
    if (rememberLook(look)) setLookChanged(true);
  }, [look]);

  // The accent is never a brand colour — it is whichever environment you are
  // currently looking at. Focus rings, active markers and selections all read it.
  useEffect(() => {
    const env = environments.find((e) => e.id === activeTab?.environmentId);
    const color = activeTab?.color ?? env?.color;
    if (!color) return;
    document.documentElement.style.setProperty("--accent", color);
    // The Console system names the same idea `--env`, and reads it for focus
    // rings, active tiles and the tint under the board. Set both so a look
    // change is only ever a stylesheet swap.
    document.documentElement.style.setProperty("--env", color);
  }, [activeTab?.color, activeTab?.environmentId, environments]);

  if (!ready) {
    return (
      <div style={{ display: "grid", placeContent: "center", height: "100%", color: "var(--ink-3)" }}>
        <span className="mono-label">loading board…</span>
      </div>
    );
  }

  const paletteBinding = keymap["app.palette"]?.[0];
  const settingsBinding = keymap["app.settings"]?.[0];

  const content =
    view === "settings" ? (
      <SettingsPage keymap={keymap} />
    ) : overviewEnvId ? (
      <EnvironmentOverview envId={overviewEnvId} />
    ) : (
      <Canvas tab={activeTab} />
    );

  const overlays = (
    <>
      <CommandPalette keymap={keymap} />
      <ContextMenu />
      <WidgetPicker />
      <FeaturesGuide />
      <Wizard />
      {hintsEnabled && <HintOverlay keymap={keymap} />}
      {toast && <div className="toast">{toast}</div>}
      {lookChanged && (
        // Changing the look is a reload, not a re-render: the stylesheet and
        // the shell are both chosen at boot. Saying so beats a setting that
        // appears to do nothing.
        <div className="toast">
          Look changed — <button className="btn sm" onClick={() => location.reload()}>reload</button>{" "}
          to see it
        </div>
      )}
    </>
  );

  function openAppSettings() {
    if (view === "settings") return setView("board");
    // The rail's gear is the *app's* settings. An environment's own settings
    // have their own way in — right-click its block. Landing on a global panel
    // with no environment pinned is what keeps the two distinct.
    useUi.getState().openSettingsPanel("appearance");
    setView("settings");
  }

  // The Console system folds the icon rail and the tab strip into one column,
  // so the whole shell is a two-column grid rather than three stacked bands.
  if (isConsole) {
    return (
      <div className={`window${railWide ? " rail-wide" : ""}`}>
        <TitleBar />
        <ConsoleRail
          keymap={keymap}
          wide={railWide}
          onToggleWide={() => {
            const next = !railWide;
            setRailWide(next);
            localStorage.setItem("ddd:railWide", next ? "1" : "0");
          }}
          onOpenSettings={openAppSettings}
        />
        <div className="board" data-wizard-target="board">
          {content}
        </div>
        {overlays}
      </div>
    );
  }

  return (
    <div className="shell">
      <TitleBar />
      <header className="rail">
        <div className="mark">
          <b>DDD</b>
          <span>your day, one board</span>
        </div>
        <div className="rail-spacer" />
        <button className="palette-hint" onClick={() => togglePalette(true)}>
          <span>Search actions, tabs, projects</span>
          {paletteBinding && <kbd className="kbd">{formatBinding(paletteBinding)}</kbd>}
        </button>
        <button
          className="icon-btn"
          title="Features guide"
          aria-label="Features guide"
          onClick={() => useUi.getState().toggleGuide()}
        >
          ?
        </button>
        <button
          className="icon-btn"
          data-wizard-target="settings"
          title={
            settingsBinding
              ? `App settings (${formatBinding(settingsBinding)})`
              : "App settings"
          }
          aria-label="App settings"
          onClick={openAppSettings}
        >
          {view === "settings" ? "←" : "⚙"}
        </button>
      </header>

      <TabStrip keymap={keymap} />

      {content}
      {overlays}
    </div>
  );
}
