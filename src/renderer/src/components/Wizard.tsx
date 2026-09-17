import { useEffect } from "react";
import { useWizard } from "../onboarding/useWizard";
import { useUi } from "../state/ui";
import { useStore } from "../state/store";
import { Spotlight } from "./Spotlight";

/**
 * The tour's coach panel: a non-blocking corner card, not a `.scrim` modal —
 * the whole point of a DO wizard is that the real board stays interactive
 * underneath it (§ design doc, "Never a trap"). Renders nothing when the tour
 * is not running.
 */
export function Wizard() {
  const active = useWizard((s) => s.active);
  const step = useWizard((s) => s.step);
  const progress = useWizard((s) => s.progress);
  const showHint = useWizard((s) => s.showHint);
  const reward = useWizard((s) => s.reward);
  const skip = useWizard((s) => s.skip);
  const exit = useWizard((s) => s.exit);
  const showMe = useWizard((s) => s.showMe);
  // The "create an environment" step spans two UI states: on the board its
  // target is the settings gear (press ⌘⇧N), but once ⌘⇧N has opened
  // Settings → Environments the gear is behind you — follow the spotlight to
  // the actual Create control so we're not dimming the panel while pointing at
  // an irrelevant corner.
  const view = useStore((s) => s.view);
  const settingsPanel = useUi((s) => s.settingsPanel);

  useEffect(() => {
    if (!active) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // WidgetPicker/CommandPalette/FeaturesGuide close on Escape with
      // `preventDefault` but not `stopPropagation` — if one of them is open,
      // this Escape is theirs to dismiss, not the tour's to exit on.
      // We MUST read the flags in the CAPTURE phase (third arg `true`): those
      // overlays clear their own open-flag in a bubble-phase React handler, so
      // a bubble-phase listener here would read state they already reset and
      // exit the tour anyway. Capture runs before their handler, so we still
      // see the overlay as open. Matches the capture-phase global handlers in
      // SettingsPage/ContextMenu.
      const { paletteOpen, pickerOpen, guideOpen } = useUi.getState();
      if (paletteOpen || pickerOpen || guideOpen) return;
      e.preventDefault();
      exit();
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [active, exit]);

  if (!active || !step) return null;

  const isBookend = step.id === "welcome" || step.id === "finish";
  const advanceLabel = step.id === "finish" ? "Finish" : isBookend ? "Next" : "Skip step";

  const spotlightTarget =
    step.id === "environment" && view === "settings" && settingsPanel === "environments"
      ? "env-create"
      : step.target;

  return (
    <>
      <Spotlight target={spotlightTarget} intense={showHint} />
      <div className="wizard-panel" role="dialog" aria-label="Guided tour">
        {reward ? (
          <div className="wizard-reward" aria-hidden="true">
            🎉
          </div>
        ) : (
          <>
            <div className="wizard-head">
              <span className="mono-label wizard-progress">
                {progress.current}/{progress.total}
              </span>
              <button
                className="icon-btn wizard-exit"
                title="Exit tour"
                aria-label="Exit tour"
                onClick={exit}
              >
                ×
              </button>
            </div>
            <h3 className="wizard-title">{step.title}</h3>
            <p className="wizard-instruction">{step.instruction}</p>
            {step.shortcut && <kbd className="kbd wizard-key">{step.shortcut}</kbd>}
            {showHint && <p className="wizard-hint">{step.hint}</p>}
            <div className="wizard-actions">
              <button className="btn sm" onClick={showMe}>
                Show me
              </button>
              <div className="wizard-actions-end">
                <button className="btn sm" onClick={exit}>
                  Exit
                </button>
                <button className="btn sm primary" onClick={skip}>
                  {advanceLabel}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
