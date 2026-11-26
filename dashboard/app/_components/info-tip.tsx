"use client";

import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

const WIDTH = 320;
const MARGIN = 12;

/**
 * A small "i" that holds explanatory text, so notes stay off the page until
 * wanted. Hover shows it; a click or tap pins it open (phones have no hover);
 * Escape, scrolling, or a tap elsewhere closes it.
 *
 * The box is position: fixed and placed from the icon's on-screen rectangle,
 * because panels clip their overflow and an absolutely positioned box would be
 * cut off at the panel edge. It opens below the icon, or above it when the
 * icon sits in the lower part of the viewport.
 */
export function InfoTip({ children, label = "More information" }: { children: ReactNode; label?: string }) {
  const button = useRef<HTMLButtonElement>(null);
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [style, setStyle] = useState<CSSProperties | null>(null);
  const open = hovered || pinned;

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const width = Math.min(WIDTH, window.innerWidth - MARGIN * 2);
    const left = Math.min(Math.max(MARGIN, r.right - width), window.innerWidth - MARGIN - width);
    const below = r.bottom < window.innerHeight * 0.6;
    setStyle(
      below
        ? { position: "fixed", left, width, top: r.bottom + 6 }
        : { position: "fixed", left, width, bottom: window.innerHeight - r.top + 6 },
    );
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => {
      setPinned(false);
      setHovered(false);
    };
    const onPointer = (event: PointerEvent) => {
      if (!button.current?.parentElement?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && close();
    document.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close);
    };
  }, [open]);

  return (
    <span className="infoTip" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <button
        ref={button}
        type="button"
        className="infoTipButton"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setPinned((prev) => !prev)}
      >
        i
      </button>
      {open && style && (
        <span role="tooltip" className="infoTipBody" style={style}>
          {children}
        </span>
      )}
    </span>
  );
}
