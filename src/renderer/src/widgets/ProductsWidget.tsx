import { useCallback, useEffect, useState } from "react";
import { Empty, Status } from "../components/Status";
import { ipc } from "../lib/ipc";
import { blocker, byProject, filterByProject, since, verdict } from "../lib/products";
import { useFocus } from "../state/focus";
import { useUi } from "../state/ui";
import type { Product } from "../types";
import type { WidgetViewProps } from "./registry";
import { useRemembered } from "../state/remembered";
import { firstLoad } from "../state/timing";

/**
 * The things your repos know how to run.
 *
 * A product is declared in `<repo>/.ddd/config.json`, so it travels with the
 * checkout — and so it arrives from whoever wrote that file. Nothing here runs
 * until it has been approved in this environment, and the approval is bound to
 * the exact command and directory: editing either one asks again.
 *
 * A product outlives DDD. Closing the dashboard does not stop your services;
 * they are re-adopted on the next launch by checking the PID's start time,
 * which is how a recycled PID is told apart from the process we started.
 */
export function ProductsWidget({ widget, environmentId, focused, itemIndex }: WidgetViewProps) {
  const [products, setProducts] = useRemembered<Product[]>(`products:${environmentId}`, []);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const showToast = useUi((s) => s.showToast);

  const refresh = useCallback(async () => {
    try {
      setProducts(await firstLoad("products", () => ipc.productsList(environmentId)));
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoaded(true);
    }
  }, [environmentId, setProducts]);

  useEffect(() => {
    void refresh();
    const seconds = widget.refreshSeconds ?? 5;
    const timer = setInterval(() => void refresh(), seconds * 1000);
    return () => clearInterval(timer);
  }, [refresh, widget.refreshSeconds]);

  // An action never leaves the row looking unchanged: refresh straight after,
  // so "up" appears because it is up rather than because we assumed.
  const act = useCallback(
    async (key: string, run: () => Promise<unknown>) => {
      setBusy(key);
      try {
        await run();
        await refresh();
      } catch (e) {
        showToast(String(e));
      } finally {
        setBusy(null);
      }
    },
    [refresh, showToast],
  );

  const projectId = typeof widget.filter.projectId === "string" ? widget.filter.projectId : undefined;
  const groups = byProject(filterByProject(products, projectId));
  const flat = groups.flatMap((g) => g.products);

  const registerWidget = useFocus((s) => s.registerWidget);
  const unregisterWidget = useFocus((s) => s.unregisterWidget);
  useEffect(() => {
    registerWidget(widget.id, flat.length);
    return () => unregisterWidget(widget.id);
  }, [widget.id, flat.length, registerWidget, unregisterWidget]);

  if (error) {
    return <Empty title="Could not read your products" body={error} />;
  }
  // Checked against `flat` — the filtered list actually on screen — not the
  // unfiltered `products`: a widget scoped to one project has to show its own
  // empty state even when other projects have products declared.
  if (loaded && flat.length === 0) {
    const scoped = projectId !== undefined && products.length > 0;
    return (
      <Empty
        title={scoped ? "No products for this project" : "No products declared"}
        body={
          scoped ? (
            <>
              This project has no products declared in its{" "}
              <code>.ddd/config.json</code>.
            </>
          ) : (
            <>
              A product is something a repo knows how to run. Declare one in that
              repo&rsquo;s <code>.ddd/config.json</code> and it shows up here — and
              travels with the checkout.
            </>
          )
        }
        meta={
          scoped ? undefined : (
            <code>{'{ "products": [{ "id": "serve", "run": "npm run dev" }] }'}</code>
          )
        }
      />
    );
  }

  let index = -1;
  return (
    <div className="rows">
      {groups.map((group) => (
        <div key={group.projectId}>
          {groups.length > 1 && (
            <div className="mono-label section-head">{group.projectId}</div>
          )}
          {group.products.map((product) => {
            index += 1;
            const v = verdict(product.state);
            const running = product.state.state === "running";
            const why = blocker(product);
            const working = busy === product.key;
            const open = reading === product.key;
            return (
              <div key={product.key}>
                <div className={`row${focused && index === itemIndex ? " selected" : ""}`}>
                  <div className="row-main">
                    <div className="row-title">{product.name}</div>
                    <div className="row-sub">
                      <Status state={v.state} label={v.label} title={v.title} />
                      {running && product.state.state === "running" && (
                        <span className="meta ink-3">{since(product.state.since)}</span>
                      )}
                      {product.state.state === "exited" && (
                        <span className="meta ink-3">
                          ran {since(product.state.since)} ago
                        </span>
                      )}
                      {product.port != null && (
                        <span className="meta ink-3">:{product.port}</span>
                      )}
                      {/* `.pathline`, not `.mono-label`: that one uppercases,
                          and a command is case-sensitive — `PYTHON -M X` is
                          not a thing you could run. */}
                      <span className="pathline" title={product.run}>
                        {product.run}
                      </span>
                    </div>
                    {why && <div className="row-sub widget-note">{why}</div>}
                  </div>
                  <div className="row-actions">
                    {product.needsApproval && product.dirExists && (
                      // Approval is a separate act from running, deliberately:
                      // the command is on screen above this button, and reading
                      // it is the entire point of the gate.
                      <button
                        className="btn sm"
                        disabled={working}
                        title={`Approve running: ${product.run}`}
                        onClick={() =>
                          void act(product.key, () =>
                            ipc.productApprove(
                              environmentId,
                              product.key,
                              product.run,
                              product.dir,
                            ),
                          )
                        }
                      >
                        Approve…
                      </button>
                    )}
                    {running ? (
                      <button
                        className="btn sm"
                        disabled={working}
                        title="Ask it to stop (SIGTERM)"
                        onClick={() =>
                          void act(product.key, () => ipc.productStop(environmentId, product.key))
                        }
                      >
                        ■ Stop
                      </button>
                    ) : (
                      <button
                        className="btn sm"
                        disabled={working || why !== null}
                        title={why ?? `Run: ${product.run}`}
                        onClick={() =>
                          void act(product.key, () =>
                            ipc.productStart(
                              environmentId,
                              product.key,
                              product.run,
                              product.dir,
                            ),
                          )
                        }
                      >
                        ▶ Start
                      </button>
                    )}
                    <button
                      className="btn sm"
                      title="What it printed"
                      onClick={() => setReading(open ? null : product.key)}
                    >
                      {open ? "▾" : "▸"} Output
                    </button>
                  </div>
                </div>
                {open && <Output env={environmentId} productKey={product.key} />}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** The captured log, read in full only while someone is looking at it. */
function Output({ env, productKey }: { env: string; productKey: string }) {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const read = () =>
      void ipc.productLog(env, productKey).then((log) => {
        if (!cancelled) setText(log);
      });
    read();
    // Only while open: a log nobody is reading is not worth a poll.
    const timer = setInterval(read, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [env, productKey]);

  return (
    <div className="row-detail">
      {text === null ? (
        <span className="mono-label">reading…</span>
      ) : text.trim() === "" ? (
        <span className="mono-label">nothing printed yet</span>
      ) : (
        <pre className="product-log">{text}</pre>
      )}
    </div>
  );
}
