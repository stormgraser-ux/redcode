// redcode-header/layout — the drawing half, with no I/O in it.
//
// Split out from index.ts so the geometry can be tested without a terminal, a
// theme, or a filesystem. Everything here takes a Snapshot and returns lines.

export interface Snapshot {
  endpoint?: { name: string; host: string; model?: string };
  repo?: { name: string; branch: string; dirty: number; ahead: number; behind: number };
  cwd: string;
  context: string[];
  notes: string[];
}

export interface Cell {
  title: string;
  lines: string[];
}

/** Minimal theme surface, so tests can pass a plain object. */
export interface ThemeLike {
  fg(key: string, s: string): string;
}

export const WORDMARK = [
  "        ██             █▀▀▄ █▀▀▀ █▀▀▄ ▄▀▀▀ ▄▀▀▄ █▀▀▄ █▀▀▀",
  "  ██ ███████████████▀  █▀█  █▀▀  █  █ █    █  █ █  █ █▀▀ ",
  "        ██             ▀  ▀ ▀▀▀▀ ▀▀▀   ▀▀▀  ▀▀  ▀▀▀  ▀▀▀▀",
];
/** Where the dagger ends and REDCODE begins, so the two colour apart. */
export const WORDMARK_SPLIT = 23;

/** Printed width, ignoring SGR escapes (which are zero width). */
export function vis(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

export function pad(s: string, w: number): string {
  const d = w - vis(s);
  return d > 0 ? s + " ".repeat(d) : s;
}

/** Truncate to `w` printed cells, preserving colour codes and marking the cut. */
export function cut(s: string, w: number): string {
  if (vis(s) <= w) return s;
  if (w <= 0) return "";
  let out = "";
  let n = 0;
  let i = 0;
  while (i < s.length && n < w - 1) {
    const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
    if (m) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    out += s[i];
    i++;
    n++;
  }
  return `${out}…\x1b[0m`;
}

/** Word-wrap to `w` printed cells, re-emitting the active SGR on each
 *  continuation line — otherwise everything after a break that lands inside a
 *  coloured run renders in the terminal default. */
export function wrap(s: string, w: number): string[] {
  if (vis(s) <= w) return [s];
  const lines: string[] = [];
  let line = "";
  let n = 0;
  let sgr = "";
  let i = 0;
  let lastBreak = -1;
  let lastBreakN = 0;

  const flush = (keep: string) => {
    lines.push(line);
    line = sgr + keep;
    n = vis(keep);
  };

  while (i < s.length) {
    const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
    if (m) {
      sgr = m[0] === "\x1b[0m" ? "" : m[0];
      line += m[0];
      i += m[0].length;
      continue;
    }
    if (s[i] === " ") {
      lastBreak = line.length + 1;
      lastBreakN = n + 1;
    }
    line += s[i];
    n++;
    i++;
    if (n >= w) {
      if (lastBreak > 0 && lastBreakN > 1) {
        const carry = line.slice(lastBreak);
        line = line.slice(0, lastBreak - 1);
        flush(carry);
      } else {
        flush("");
      }
      lastBreak = -1;
      lastBreakN = 0;
    }
  }
  if (vis(line)) lines.push(line);
  return lines;
}

const GAP = 4;
/** Past this a cell wraps rather than widening, so one long path cannot set
 *  the width of the whole frame and maroon every other cell in whitespace. */
const MAX_CELL = 34;

export function natural(cell: Cell): number {
  return Math.min(MAX_CELL, Math.max(cell.title.length, ...cell.lines.map(vis), 0));
}

export function reflow(cell: Cell): Cell {
  const w = natural(cell);
  return { title: cell.title, lines: cell.lines.flatMap((l) => wrap(l, w)) };
}

/** Lay cells side by side at their own natural widths, wrapping to a new row
 *  when they no longer fit. Equal-width columns were the obvious choice and
 *  the wrong one: one long path would set the width of every column. */
export function columns(theme: ThemeLike, cells: Cell[], width: number): string[] {
  const c = (k: string, s: string) => theme.fg(k, s);
  const out: string[] = [];

  const rows: Cell[][] = [];
  let row: Cell[] = [];
  let used = 0;
  for (const cell of cells) {
    const w = Math.min(natural(cell), width);
    if (row.length && used + GAP + w > width) {
      rows.push(row);
      row = [];
      used = 0;
    }
    row.push(cell);
    used += (row.length > 1 ? GAP : 0) + w;
  }
  if (row.length) rows.push(row);

  for (const [i, r] of rows.entries()) {
    if (i > 0) out.push("");
    const widths = r.map((cell) => Math.min(natural(cell), width));
    const height = Math.max(...r.map((cell) => cell.lines.length));
    const join = (parts: string[]) =>
      parts.map((s, j) => (j === parts.length - 1 ? s : pad(s, widths[j]))).join(" ".repeat(GAP));
    out.push(join(r.map((cell) => c("muted", cell.title))));
    for (let n = 0; n < height; n++) {
      out.push(join(r.map((cell, j) => cut(cell.lines[n] ?? "", widths[j]))));
    }
  }
  return out;
}

/** The whole header. Cells are omitted entirely when empty, so this is a
 *  statement about what is true right now rather than a fixed dashboard of
 *  "none" placeholders. */
export function build(theme: ThemeLike, snap: Snapshot, width: number): string[] {
  const c = (k: string, s: string) => theme.fg(k, s);
  const body: string[] = [];

  // The mark is drawn flat in one accent colour on purpose: a single unbroken
  // block is the most striking thing on the screen precisely because nothing
  // else is allowed to be, and it carries no state to encode.
  const narrow = width < vis(WORDMARK[0]);
  if (narrow) {
    body.push(c("accent", "REDCODE"));
  } else {
    for (const row of WORDMARK) {
      body.push(
        c("error", row.slice(0, WORDMARK_SPLIT)) + c("accent", row.slice(WORDMARK_SPLIT)),
      );
    }
  }
  body.push("");

  // The endpoint line owns the masthead: which server is answering is the one
  // fact that decides what everything else in the session means. Unconfigured
  // is the state a brand new install is in, so say what to do about it rather
  // than leaving a blank.
  if (snap.endpoint) {
    const e = snap.endpoint;
    const bits = [c("accent", e.name), c("dim", e.host)];
    if (e.model) bits.push(c("dim", e.model));
    body.push(bits.join("   "));
  } else {
    body.push(c("warning", "no endpoint configured") + c("dim", "   run /connect"));
  }

  if (snap.repo) {
    const r = snap.repo;
    const bits = [c("text", r.name), c("accent", r.branch)];
    if (r.dirty) bits.push(c("warning", `${r.dirty} dirty`));
    if (r.ahead) bits.push(c("dim", `^${r.ahead}`));
    if (r.behind) bits.push(c("dim", `v${r.behind}`));
    body.push(bits.join("  "));
  } else {
    body.push(c("dim", snap.cwd));
  }

  const cells: Cell[] = [];
  // Where you are, when that is not already implied by a repo line.
  if (snap.repo) cells.push({ title: "cwd", lines: [c("dim", snap.cwd)] });
  // What is auto-loaded into the system prompt before you type anything —
  // the only listing here that changes what the model already believes.
  if (snap.context.length) {
    cells.push({ title: "context", lines: snap.context.map((p) => c("dim", p)) });
  }
  if (snap.notes.length) {
    cells.push({ title: "notes", lines: snap.notes.map((n) => c("warning", n)) });
  }

  const out = [""];
  // Clamp every masthead line. The cells are laid out to fit by construction,
  // but these are free-form and a long host name or branch will happily run
  // past the frame — and a header line wider than the terminal does not just
  // look wrong, it corrupts the TUI's redraw for the rest of the session.
  out.push(...body.map((l) => cut(l, width)));
  if (cells.length) {
    out.push("");
    out.push(...columns(theme, cells.map(reflow), width));
  }
  out.push("");
  return out;
}
