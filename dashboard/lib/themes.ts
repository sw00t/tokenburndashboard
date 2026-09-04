export type Rgb = [number, number, number];

export type Palette = {
  key: string;
  label: string;
  scheme: "dark" | "light";
  vars: Record<string, string>;
  /** heatmap colour for cache-read heavy days */
  cached: Rgb;
  /** heatmap colour for fresh-heavy days */
  fresh: Rgb;
  /** the "billed" trust tier and the money axis; deliberately unlike accent/fresh/good/warn */
  billed: Rgb;
};

const rgb = (c: Rgb) => `${c[0]}, ${c[1]}, ${c[2]}`;

function make(
  key: string,
  label: string,
  scheme: "dark" | "light",
  v: {
    bg: string; panel: string; panel2: string; line: string; ink: string; soft: string; muted: string;
    accent: string; accentInk: string; good: string; warn: string; bad: string; freshHex: string;
    billedHex: string;
  },
  cached: Rgb,
  fresh: Rgb,
): Palette {
  const inkRgb = hexToRgb(v.ink);
  const billed = hexToRgb(v.billedHex);
  return {
    key, label, scheme, cached, fresh, billed,
    vars: {
      "--bg": v.bg, "--panel": v.panel, "--panel-2": v.panel2, "--line": v.line,
      "--ink": v.ink, "--soft": v.soft, "--muted": v.muted,
      "--accent": v.accent, "--accent-ink": v.accentInk,
      "--good": v.good, "--warn": v.warn, "--bad": v.bad, "--fresh": v.freshHex,
      "--billed": v.billedHex,
      "--ink-rgb": rgb(inkRgb), "--cached-rgb": rgb(cached), "--fresh-rgb": rgb(fresh),
      "--billed-rgb": rgb(billed),
      colorScheme: scheme,
    },
  };
}

function hexToRgb(hex: string): Rgb {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export const palettes: Palette[] = [
  make("ink", "Ink", "dark", {
    bg: "#101012", panel: "#18191c", panel2: "#202127", line: "#303238", ink: "#f0ece4", soft: "#c6c0b5", muted: "#88847b",
    accent: "#18c1e8", accentInk: "#06232b", good: "#3ae88d", warn: "#ffdf43", bad: "#f2453d", freshHex: "#ff9f43",
    billedHex: "#b48bff",
  }, [24, 193, 232], [255, 159, 67]),
  make("paper", "Paper", "light", {
    bg: "#f6f3ec", panel: "#ffffff", panel2: "#f0ece3", line: "#dcd6c8", ink: "#1a1a1f", soft: "#4a4840", muted: "#7a766c",
    accent: "#0f7fa6", accentInk: "#ffffff", good: "#1f8f57", warn: "#9a6b00", bad: "#c62f2a", freshHex: "#d9631e",
    billedHex: "#6d3fb0",
  }, [15, 127, 166], [217, 99, 30]),
  make("forest", "Forest", "dark", {
    bg: "#0d1410", panel: "#131c16", panel2: "#1a261e", line: "#28382d", ink: "#eef3e9", soft: "#c3ccbb", muted: "#7f8c7a",
    accent: "#6fd48a", accentInk: "#06200f", good: "#a3e635", warn: "#f5d565", bad: "#ef6b5a", freshHex: "#f2b95c",
    billedHex: "#8fb8ff",
  }, [111, 212, 138], [242, 185, 92]),
  make("ember", "Ember", "dark", {
    bg: "#140f0e", panel: "#1d1513", panel2: "#271c19", line: "#3a2a26", ink: "#f5ece6", soft: "#d2c3ba", muted: "#8f7f77",
    accent: "#ff7a45", accentInk: "#2a0f05", good: "#7fe0a8", warn: "#ffd166", bad: "#ff4d4d", freshHex: "#5cc8ff",
    billedHex: "#c48bff",
  }, [255, 122, 69], [92, 200, 255]),
  make("dusk", "Dusk", "dark", {
    bg: "#12111a", panel: "#1a1826", panel2: "#232032", line: "#353149", ink: "#efecf8", soft: "#c9c3dc", muted: "#8b859f",
    accent: "#a78bfa", accentInk: "#1b1030", good: "#5eead4", warn: "#fde68a", bad: "#fb7185", freshHex: "#fbbf24",
    billedHex: "#f472b6",
  }, [167, 139, 250], [251, 191, 36]),
  make("mono", "Mono", "dark", {
    bg: "#0b0b0b", panel: "#141414", panel2: "#1d1d1d", line: "#2e2e2e", ink: "#f5f5f5", soft: "#c9c9c9", muted: "#8a8a8a",
    accent: "#e5e5e5", accentInk: "#0b0b0b", good: "#d4d4d4", warn: "#a3a3a3", bad: "#f87171", freshHex: "#8c8c8c",
    billedHex: "#ffffff",
  }, [229, 229, 229], [140, 140, 140]),
];

export const defaultPalette = palettes[0];

export function paletteByKey(key: string) {
  return palettes.find((p) => p.key === key) || defaultPalette;
}
