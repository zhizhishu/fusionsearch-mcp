import { useCallback, useEffect, useRef, useState } from "react";

type ResizeOptions = {
  storageKey: string;
  initial: number;
  min: number;
  max: number;
};

/**
 * Pointer-driven horizontal resize hook. Returns the current width plus an
 * onPointerDown handler that should be wired to a thin drag handle. The width
 * is clamped to [min, max] and persisted to localStorage under storageKey.
 */
export function useResizableWidth({ storageKey, initial, min, max }: ResizeOptions) {
  const [width, setWidth] = useState<number>(() => {
    if (typeof localStorage === "undefined") return initial;
    const raw = localStorage.getItem(storageKey);
    if (raw == null) return initial;
    const n = Number(raw);
    if (!Number.isFinite(n)) return initial;
    return Math.max(min, Math.min(max, n));
  });
  const [dragging, setDragging] = useState(false);

  const widthRef = useRef(width);
  widthRef.current = width;

  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(storageKey, String(width));
  }, [storageKey, width]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = widthRef.current;
      setDragging(true);

      function onMove(e: PointerEvent) {
        const next = Math.max(min, Math.min(max, startWidth + (e.clientX - startX)));
        setWidth(next);
      }
      function onUp() {
        setDragging(false);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        document.body.style.removeProperty("cursor");
        document.body.style.removeProperty("user-select");
      }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [min, max]
  );

  return { width, dragging, onPointerDown };
}
