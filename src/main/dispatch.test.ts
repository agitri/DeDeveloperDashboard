import { describe, expect, it } from "vitest";
import { DddError } from "../core/error";
import { dispatch, type HostHandler } from "./dispatch";
import type { Handler } from "./commands";

describe("dispatch", () => {
  it("replies with an error envelope for an unknown command", async () => {
    const reply = await dispatch("nope", {}, undefined, {}, {});
    expect(reply).toEqual({ ok: false, error: "unknown command nope" });
  });

  it("does not resolve inherited names like constructor or toString from a renderer", async () => {
    const reply = await dispatch("constructor", {}, null, {}, {});
    expect(reply).toEqual({ ok: false, error: "unknown command constructor" });
  });

  it("maps a handler returning undefined to value: null", async () => {
    const commands: Record<string, Handler> = { noop: () => undefined };
    const reply = await dispatch("noop", {}, undefined, {}, commands);
    expect(reply).toEqual({ ok: true, value: null });
  });

  it("unwraps a DddError to its bare message", async () => {
    const commands: Record<string, Handler> = {
      fail: () => {
        throw DddError.invalid("bad");
      },
    };
    const reply = await dispatch("fail", {}, undefined, {}, commands);
    expect(reply).toEqual({ ok: false, error: "bad" });
  });

  it("stringifies a thrown non-Error", async () => {
    const commands: Record<string, Handler> = {
      fail: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- the envelope must survive a non-Error throw
        throw "oops";
      },
    };
    const reply = await dispatch("fail", {}, undefined, {}, commands);
    expect(reply).toEqual({ ok: false, error: "oops" });
  });

  it("prefers the host handler over a command of the same name", async () => {
    const host: Record<string, HostHandler> = { shared: () => "from host" };
    const commands: Record<string, Handler> = { shared: () => "from commands" };
    const reply = await dispatch("shared", {}, undefined, host, commands);
    expect(reply).toEqual({ ok: true, value: "from host" });
  });

  it("passes args and event through to the handler", async () => {
    const event = { marker: true };
    const host: Record<string, HostHandler> = {
      echo: (args, e) => ({ args, sameEvent: e === event }),
    };
    const reply = await dispatch("echo", { a: 1 }, event, host, {});
    expect(reply).toEqual({ ok: true, value: { args: { a: 1 }, sameEvent: true } });
  });
});
