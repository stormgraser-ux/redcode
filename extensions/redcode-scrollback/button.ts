// Pure logic for the jump-to-bottom button: mouse parsing, hit testing, and
// the label. Kept separate from index.ts so it can be tested without a TUI.
//
// WHY HIT TESTING IS DONE AGAINST THE COMPOSED SCREEN LINES, not the layout
// tree. pi's extension widgets are added to a plain `Container`
// (interactive-mode.js:1768), and a plain Container has no layout node, so
// `renderLayoutFrame` renders it as a single leaf: our component never gets a
// LayoutBox of its own and there is nothing to look up its row in. What we DO
// have is `tui.currentLayout.lines` — the final composed screen, exactly what
// the user is looking at. Searching those for our own marker gives the true
// on-screen row with no assumptions about how many widgets or spacers sit
// above us.

/** Marker text carried in the rendered line; also what the user reads. */
export const BUTTON_TAG = "Jump to latest";

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

export type MouseKind = "press" | "release";

export interface MouseEvent {
  /** Raw SGR button code, before the wheel/motion bits are decoded. */
  raw: number;
  kind: MouseKind;
  /** 0-based screen column. */
  x: number;
  /** 0-based screen row. */
  y: number;
  wheel: boolean;
  motion: boolean;
  /** Button index with the wheel/motion modifier bits masked off. */
  button: number;
}

const SGR_MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

/**
 * Parse an SGR (1006) mouse report. pi enables 1006 unconditionally in
 * fullscreen mode (tui-alt-screen.js `ENABLE_ALL_MOTION_MOUSE`), so the legacy
 * X10 encoding is not worth handling — and misreading it would be worse than
 * ignoring it, since a false positive steals a click from selection.
 */
export function parseMouse(data: string): MouseEvent | undefined {
  const m = SGR_MOUSE.exec(data);
  if (!m) return undefined;
  const raw = Number.parseInt(m[1], 10);
  if (!Number.isFinite(raw)) return undefined;
  return {
    raw,
    kind: m[4] === "M" ? "press" : "release",
    x: Number.parseInt(m[2], 10) - 1,
    y: Number.parseInt(m[3], 10) - 1,
    wheel: (raw & 64) !== 0,
    motion: (raw & 32) !== 0,
    button: raw & 3,
  };
}

/** True when the event is a plain left-button press (not wheel, not drag). */
export function isLeftPress(event: MouseEvent): boolean {
  return event.kind === "press" && !event.wheel && !event.motion && event.button === 0;
}

/**
 * How far up from the bottom of the screen the button can possibly be: the
 * editor, the footer and any below-editor widgets sit under it. Searching only
 * this band means a transcript line that happens to contain the same words
 * cannot be mistaken for the button — which matters here, because the words are
 * ordinary English and this very file gets read in a pi session.
 */
const DOCK_ROWS = 24;

/**
 * The 0-based screen row the button occupies, or -1 if it is not on screen.
 *
 * The whole row is the target rather than the exact glyph span: the row holds
 * nothing else, and a forgiving target is the point of a click affordance.
 * Searched from the bottom up for the same anti-collision reason as DOCK_ROWS.
 */
export function buttonRow(lines: readonly string[] | undefined): number {
  if (!lines) return -1;
  const floor = Math.max(0, lines.length - DOCK_ROWS);
  for (let y = lines.length - 1; y >= floor; y--) {
    if (stripAnsi(lines[y] ?? "").includes(BUTTON_TAG)) return y;
  }
  return -1;
}

/**
 * How far below the viewport the live output is, in lines. Returns undefined
 * when the numbers are not available or not sane, and the label then omits the
 * count rather than printing a wrong one.
 */
export function linesBelow(
  scrollTop: number | undefined,
  viewportHeight: number | undefined,
  contentHeight: number | undefined,
): number | undefined {
  if (
    typeof scrollTop !== "number" ||
    typeof viewportHeight !== "number" ||
    typeof contentHeight !== "number"
  ) {
    return undefined;
  }
  const below = contentHeight - viewportHeight - scrollTop;
  if (!Number.isFinite(below) || below <= 0) return undefined;
  return Math.round(below);
}

/** Plain (unstyled) button text. Styling is applied per-segment in index.ts. */
export function buttonText(below: number | undefined): string {
  const count =
    below === undefined
      ? ""
      : `  ${below.toLocaleString()} line${below === 1 ? "" : "s"} below`;
  return `  ▼  ${BUTTON_TAG}${count}  `;
}
