// Pure formatting and layout for the footer. No pi imports, so it can be
// tested directly with `node --experimental-strip-types format.test.ts`.

/** Minimal theme shape. The real one is pi's Theme; only fg is used here. */
export interface Paint {
  fg(name: string, text: string): string;
}

/** 1234 -> "1.2k", 1_234_567 -> "1.2M". Matches pi's own scale so the two
 *  halves of a ratio are directly comparable at a glance. */
export function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}

/** Coerce a usage field to a finite number, whatever the provider actually put
 *  there. This is not paranoia: NInfer's `cost` arrives as an OBJECT rather
 *  than a number, and `0 + {}` in JS silently yields the STRING
 *  "0[object Object]" instead of throwing. The accumulator then stops being a
 *  number and the failure surfaces far away, at the `.toFixed()` call — which
 *  is what killed pi on 2026-08-17. */
export function num(v: any): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  if (v && typeof v === "object") return num(v.total ?? v.amount ?? v.usd ?? 0);
  return 0;
}

/** Visible cell count. The padding maths must not count colour codes. */
export function visibleWidth(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

export function truncate(s: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(s) <= width) return s;
  let out = "";
  let w = 0;
  let i = 0;
  while (i < s.length && w < width - 1) {
    const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
    if (m) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    out += s[i];
    i++;
    w++;
  }
  return `${out}…`;
}

/**
 * One line, left-aligned content and right-aligned content.
 *
 * THE RIGHT SIDE WINS WHEN SPACE RUNS OUT. Everything on the right is a
 * number against a limit — context fill, VRAM, throughput — and those are what
 * the footer exists to answer at a glance. The left side is identity and
 * location, which a truncated path still conveys.
 */
export function lay(left: string, right: string, width: number): string {
  if (!right) return truncate(left, width);
  if (!left) return " ".repeat(Math.max(0, width - visibleWidth(right))) + right;

  let l = left;
  const rw = visibleWidth(right);
  if (visibleWidth(l) + 2 + rw > width) {
    const avail = width - rw - 2;
    // Below this a truncated left side is "…" and a wasted column; drop it.
    if (avail < 8) return truncate(right, width);
    l = truncate(l, avail);
  }
  const pad = Math.max(1, width - visibleWidth(l) - rw);
  return l + " ".repeat(pad) + right;
}

// Eighth-block partials give sub-cell resolution, so a 12-cell bar reads like
// a 96-cell one. `#`/`-` could not show movement inside a cell at all.
const PARTIALS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
const FULL = "█";
const EMPTY = "░";

/**
 * A proportional bar of `cells` columns.
 *
 * Colour is the ONLY carrier of the percentage — three distinguishable steps
 * (theme border tone → amber → bright), never a red/green pair.
 */
export function bar(t: Paint, frac: number, cells: number, colour = "border"): string {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(frac) ? frac : 0));
  const exact = clamped * cells;
  const full = Math.min(cells, Math.floor(exact));
  const partial = full < cells ? PARTIALS[Math.round((exact - full) * 8)] ?? "" : "";
  const empty = Math.max(0, cells - full - (partial ? 1 : 0));
  return (
    t.fg(colour, FULL.repeat(full) + partial) + t.fg("borderMuted", EMPTY.repeat(empty))
  );
}

/** Fill colour for a proportion. Shared by every gauge so the steps mean the
 *  same thing wherever they appear. */
export function fillColour(frac: number): string {
  if (!Number.isFinite(frac)) return "borderMuted";
  if (frac >= 0.9) return "error";
  if (frac >= 0.7) return "warning";
  return "border";
}

/** `ctx ▕███████░░░▏ 199k/205k` */
export function gauge(
  t: Paint,
  label: string,
  frac: number,
  value: string,
  cells: number,
): string {
  const colour = fillColour(frac);
  return (
    t.fg("dim", `${label} `) +
    t.fg("borderMuted", "▕") +
    bar(t, frac, cells, colour) +
    t.fg("borderMuted", "▏") +
    t.fg(colour === "border" ? "muted" : colour, ` ${value}`)
  );
}

/**
 * Pick the widest bar size that lets both gauges sit beside `left`.
 *
 * Returns the chosen cell count, or 0 when even the smallest bar does not fit
 * — at which point the caller drops the bars and keeps the bare numbers, which
 * are what actually matter.
 */
export function fitCells(
  leftWidth: number,
  fixedRightWidth: number,
  gaugeCount: number,
  width: number,
): number {
  for (const cells of [14, 11, 8, 6]) {
    if (leftWidth + 2 + fixedRightWidth + gaugeCount * (cells + 2) <= width) return cells;
  }
  return 0;
}
