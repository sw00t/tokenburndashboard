"use client";

import { type CSSProperties, useEffect, useState } from "react";

import savedDisplayDefaults from "../data/display-defaults.json";
import { defaultPalette, paletteByKey } from "./themes";

/** View-only settings, kept per browser in localStorage. */
export type DisplaySettings = {
  titleScale: number;
  figureScale: number;
  panelFigureScale: number;
  density: number;
  palette: string;
  /** Phone only: tighter tiles, smaller heatmap cells and type, so the trend fits on the first screen. */
  compact: boolean;
};

export type ScaleKey = "titleScale" | "figureScale" | "panelFigureScale" | "density";

const STORAGE_KEY = "token-burn-display";

/**
 * What a browser with no saved settings starts from. The built-ins are the
 * floor; data/display-defaults.json overrides them, and "Save as default"
 * writes that file, so the current look can become the default without
 * editing code and carries to a deployed copy or a cleared browser.
 */
const defaultDisplay: DisplaySettings = {
  titleScale: 1,
  figureScale: 1,
  panelFigureScale: 1,
  density: 1,
  palette: defaultPalette.key,
  compact: true,
  ...(savedDisplayDefaults as Partial<DisplaySettings>),
};

/** Steps of 10%, between `min` and 200%. Density may go lower than the type scales. */
function clampScale(value: number, min: number) {
  return Math.min(2, Math.max(min, Math.round(value * 10) / 10));
}

/**
 * Display settings plus everything that follows from them: the palette pushed
 * onto <html>/<body>, the CSS variables for <main>, and persistence.
 * `hydrated` turns true after the saved settings load; clock-dependent UI waits
 * for it so the prerendered HTML never disagrees with the client.
 */
export function useDisplaySettings() {
  const [display, setDisplay] = useState<DisplaySettings>(defaultDisplay);
  const [hydrated, setHydrated] = useState(false);
  const palette = paletteByKey(display.palette);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) setDisplay({ ...defaultDisplay, ...JSON.parse(saved) });
    } catch {
      /* storage unavailable */
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(display));
    } catch {
      /* storage unavailable */
    }
  }, [display, hydrated]);

  useEffect(() => {
    // Push the palette to <html> and <body> too, so the page ground outside <main> matches.
    for (const [name, value] of Object.entries(palette.vars)) {
      if (name.startsWith("--")) document.documentElement.style.setProperty(name, String(value));
    }
    document.documentElement.style.background = palette.vars["--bg"];
    document.documentElement.style.colorScheme = palette.scheme;
    document.body.style.background = palette.vars["--bg"];
    document.body.style.color = palette.vars["--ink"];
  }, [palette]);

  const bump = (key: ScaleKey, delta: number) =>
    setDisplay((prev) => ({ ...prev, [key]: clampScale(prev[key] + delta, key === "density" ? 0.2 : 0.5) }));

  const mainStyle = {
    ...palette.vars,
    "--title-scale": display.titleScale,
    "--figure-scale": display.figureScale,
    "--panel-figure-scale": display.panelFigureScale,
    "--density": display.density,
  } as CSSProperties;

  return { display, setDisplay, bump, palette, mainStyle, hydrated };
}

export type DisplayControls = ReturnType<typeof useDisplaySettings>;
