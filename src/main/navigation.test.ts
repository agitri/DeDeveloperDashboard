import { describe, expect, it } from "vitest";
import { allowNavigation } from "./navigation";

/**
 * The window must never leave the app, but a reload IS a navigation to the
 * page's own URL — and the "Look changed — reload" toast depends on it.
 */
describe("navigation policy", () => {
  const prod = "file:///Users/me/nodeDDD/out/renderer/index.html";
  const dev = "http://localhost:5173/";

  it("allows a reload of the page itself", () => {
    expect(allowNavigation(prod, prod)).toBe(true);
    expect(allowNavigation(dev, dev)).toBe(true);
    expect(allowNavigation(dev, "http://localhost:5173/?look=console")).toBe(true);
    expect(allowNavigation(prod, prod + "?look=console")).toBe(true);
  });

  it("refuses to leave the app", () => {
    expect(allowNavigation(prod, "https://example.com/")).toBe(false);
    expect(allowNavigation(dev, "http://localhost:5173/other.html")).toBe(false);
    expect(allowNavigation(prod, "file:///etc/passwd")).toBe(false);
    expect(allowNavigation(dev, "https://localhost:5173/")).toBe(false);
    expect(allowNavigation(prod, "not a url")).toBe(false);
  });
});
