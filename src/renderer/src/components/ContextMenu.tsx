import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useUi } from "../state/ui";

export type MenuItem =
  | {
      kind: "action";
      label: string;
      run: () => void;
      danger?: boolean;
      /** The reason it cannot run. Present means disabled — and says why. */
      disabled?: string;
    }
  | { kind: "submenu"; label: string; items: MenuItem[] }
  | { kind: "separator" };

/**
 * The one context menu, positioned at the pointer.
 *
 * Right-click is where people look for "what can I do to this". DDD answered
 * with the browser's own menu until now, which is how tab renaming stayed
 * undiscoverable despite working three different ways.
 *
 * `disabled` carries its reason as a string rather than a boolean: an item
 * that is greyed out and cannot say why should not be in the menu at all.
 */
export function ContextMenu() {
  const menu = useUi((s) => s.menu);
  const closeMenu = useUi((s) => s.closeMenu);

  if (!menu) return null;
  return <MenuSurface key={`${menu.x}:${menu.y}`} x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />;
}

function MenuSurface({
  x,
  y,
  items,
  onClose,
  nested = false,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  nested?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [openSub, setOpenSub] = useState<number | null>(null);
  const [cursor, setCursor] = useState<number>(-1);

  // Flip rather than overflow. Measured after layout because the menu's size
  // depends on its longest label, which we do not know up front.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      x: x + width > window.innerWidth ? Math.max(4, x - width) : x,
      y: y + height > window.innerHeight ? Math.max(4, y - height) : y,
    });
  }, [x, y]);

  // A submenu shares the root's dismissal; only the root listens, so a click
  // inside a submenu does not close the tree out from under itself.
  useEffect(() => {
    if (nested) return;
    function onPointerDown(e: PointerEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    // Capture, so a menu opened over a widget closes before that widget's own
    // handlers see the click.
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [nested, onClose]);

  // Keyboard-first is a requirement of this app, not a nicety (§5.10).
  // Memoised: it is an effect dependency, and a fresh array each render
  // would tear down and re-add the window listener on every keystroke.
  const selectable = useMemo(() => items.flatMap((item, i) => (item.kind === "separator" ? [] : [i])), [items]);
  useEffect(() => {
    if (nested) return;
    function onKey(e: KeyboardEvent) {
      if (selectable.length === 0) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((current) => {
          const at = selectable.indexOf(current);
          const step = e.key === "ArrowDown" ? 1 : -1;
          const next = (at + step + selectable.length) % selectable.length;
          return selectable[
            at === -1 ?
              step === 1 ?
                0
              : selectable.length - 1
            : next
          ]!;
        });
      }
      if (e.key === "Enter" && cursor >= 0) {
        const item = items[cursor];
        if (item?.kind === "action" && !item.disabled) {
          e.preventDefault();
          onClose();
          item.run();
        }
        if (item?.kind === "submenu") {
          e.preventDefault();
          setOpenSub(cursor);
        }
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [nested, items, cursor, selectable, onClose]);

  return (
    <div ref={ref} className="menu" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {items.map((item, i) => {
        if (item.kind === "separator") return <div key={i} className="menu-sep" />;
        if (item.kind === "submenu") {
          const rect = ref.current?.getBoundingClientRect();
          return (
            <div key={i} className="menu-row-wrap" onMouseEnter={() => setOpenSub(i)}>
              <button
                className={`menu-row${cursor === i ? " cursor" : ""}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => setOpenSub(openSub === i ? null : i)}
              >
                <span>{item.label}</span>
                <span className="menu-more">▸</span>
              </button>
              {openSub === i && rect && (
                <MenuSurface nested x={rect.right - 3} y={rect.top + i * 24} items={item.items} onClose={onClose} />
              )}
            </div>
          );
        }
        return (
          <button
            key={i}
            className={`menu-row${item.danger ? " danger" : ""}${cursor === i ? " cursor" : ""}`}
            disabled={item.disabled !== undefined}
            title={item.disabled}
            onMouseEnter={() => {
              setCursor(i);
              setOpenSub(null);
            }}
            onClick={() => {
              onClose();
              item.run();
            }}
          >
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Open the menu at the event's pointer, swallowing the browser's own. */
export function menuHandler(items: () => MenuItem[]) {
  return (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    useUi.getState().openMenu(e.clientX, e.clientY, items());
  };
}
