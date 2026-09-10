import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/global.css";
import "./styles/console.css";
import { isConsole } from "./lib/look";

/**
 * The Console look, behind a flag.
 *
 * The design handoff in docs/design/design_handoff_ddd_console, ported. Both
 * systems ship; the look decides which stylesheet and which shell renders:
 *
 *   ?look=console   the handoff's system
 *   ?look=classic   what shipped
 *
 * The choice sticks in localStorage, so a reload keeps it.
 */
// macOS draws its traffic lights over the window's own content, so the chrome
// has to leave them a lane. The stylesheet has always had rules keyed to this
// attribute; nothing ever set it, so the lane was never reserved and the
// lights sat on top of the rail.
if (/Mac/i.test(navigator.userAgent)) {
  document.documentElement.setAttribute("data-platform", "mac");
}

if (isConsole) {
  document.documentElement.setAttribute("data-look", "console");
  // The design's base rules hang off `.ddd`; it lives on <html> so the whole
  // document is inside the system rather than a container within it.
  document.documentElement.classList.add("ddd");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
