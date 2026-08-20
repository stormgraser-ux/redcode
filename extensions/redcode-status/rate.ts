// redcode-status/rate — the arithmetic, separated from the event plumbing so
// it can be tested without a running agent.

export interface Turn {
  /** ms from request start to the first CONTENT delta. */
  ttftMs: number | null;
  /** Decode rate over the streaming portion only. */
  tokPerSec: number | null;
  /** Output tokens the provider reported for the turn. */
  output: number | null;
}

/** Decode rate, timed from the FIRST CONTENT DELTA rather than the first byte.
 *
 *  This distinction is the whole reason this file exists. A server may emit a
 *  message_start frame before it has prefilled anything, so timing from the
 *  first byte folds the entire prefill into what you then call the decode rate
 *  — and reports ~40 tok/s for a model doing ~124. Prefill is a different
 *  measurement with different causes; averaging the two produces a number that
 *  is not either of them.
 *
 *  Returns null for spans too short to divide by, rather than a spike. */
export function decodeRate(outputTokens: number, streamMs: number): number | null {
  if (!Number.isFinite(outputTokens) || outputTokens <= 0) return null;
  if (!Number.isFinite(streamMs) || streamMs < 50) return null;
  return outputTokens / (streamMs / 1000);
}

/** Human ttft: sub-second in ms, above that in seconds. A turn against a local
 *  model at long context can legitimately sit in the tens of seconds, so this
 *  never abbreviates into uselessness. */
export function fmtTtft(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  return ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Compact token counts: 1234 -> 1.2k, 1234567 -> 1.2M. */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** Percentage of the context window in use, or null when the window is
 *  unknown — which it often is for a private endpoint whose /v1/models says
 *  nothing about it. A made-up denominator is worse than no percentage. */
export function contextPct(used: number, window: number | null | undefined): number | null {
  if (!window || !Number.isFinite(window) || window <= 0) return null;
  if (!Number.isFinite(used) || used < 0) return null;
  return (used / window) * 100;
}

/** Which colour a rate should be drawn in.
 *
 *  `live` means the turn is still streaming, so the figure is provisional and
 *  will keep moving; settled figures are final. They are coloured apart so a
 *  number that is still climbing is not read as a result. */
export function rateColour(live: boolean): string {
  return live ? "warning" : "success";
}

/** Assemble the status segments. Returns plain parts; the caller themes them.
 *  Nothing is emitted for a measurement that has not happened yet, so the line
 *  is empty on a fresh session rather than a row of placeholder dashes. */
export function segments(turn: Turn): Array<{ key: string; text: string }> {
  const out: Array<{ key: string; text: string }> = [];
  if (turn.tokPerSec !== null) {
    out.push({ key: "rate", text: `${turn.tokPerSec.toFixed(0)} tok/s` });
  }
  if (turn.ttftMs !== null) {
    out.push({ key: "ttft", text: `ttft ${fmtTtft(turn.ttftMs)}` });
  }
  if (turn.output !== null && turn.output > 0) {
    out.push({ key: "out", text: `${fmtTokens(turn.output)} out` });
  }
  return out;
}
