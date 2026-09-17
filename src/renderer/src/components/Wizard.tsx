import { useEffect } from "react";
import { useWizard } from "../onboarding/useWizard";
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

  useEffect(() => {
    if (!active) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        exit();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, exit]);

  if (!active || !step) return null;

  const isBookend = step.id === "welcome" || step.id === "finish";
  const advanceLabel = step.id === "finish" ? "Finish" : isBookend ? "Next" : "Skip step";

  return (
    <>
      <Spotlight target={step.target} intense={showHint} />
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
