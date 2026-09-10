import { describe, expect, it } from "vitest";
import { CSP, DEV_CSP, directive } from "./csp";

/**
 * This app holds keychain credentials and can spawn processes. It must not
 * also be able to load a remote script. Every outbound request is made by the
 * main process, so the renderer has no legitimate reason to reach the network.
 */
describe("the renderer's content policy", () => {
  it("lets the page talk to nothing but itself", () => {
    expect(directive(CSP, "connect-src")).toBe("'self'");
  });

  it("runs no remote and no inline script", () => {
    expect(directive(CSP, "script-src")).toBe("'self'");
  });

  it("embeds nothing", () => {
    expect(directive(CSP, "object-src")).toBe("'none'");
    expect(directive(CSP, "frame-src")).toBe("'none'");
    expect(directive(CSP, "frame-ancestors")).toBe("'none'");
    expect(directive(CSP, "form-action")).toBe("'none'");
  });

  it("names no host and no wildcard anywhere", () => {
    expect(CSP).not.toMatch(/https?:\/\//);
    expect(CSP).not.toMatch(/\*/);
  });

  it("in development adds only what Vite's dev server needs", () => {
    expect(directive(DEV_CSP, "connect-src")).toBe("'self' ws://localhost:5173 http://localhost:5173");
    expect(directive(DEV_CSP, "script-src")).toBe("'self' 'unsafe-inline'");
    expect(directive(DEV_CSP, "object-src")).toBe("'none'");
  });
});
