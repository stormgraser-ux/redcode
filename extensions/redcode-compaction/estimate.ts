// Compaction progress estimation, kept pure so it can be tested without a pi
// session or a live engine.
//
// WHY AN ESTIMATE AT ALL, RATHER THAN REAL PROGRESS. pi runs summarization by
// calling `agent.streamFunction` directly (agent-session.js:1653), not through
// the agent loop, so none of the streaming events an extension can subscribe to
// — message_update, turn_end — fire for it. The only two observable moments are
// `session_before_compact` and `session_compact`. Between them the extension is
// blind, so the bar cannot be a token counter and must be a prediction.
//
// It is still worth drawing. The question a user asks while staring at a stalled
// terminal is "is this nearly done or have I got another minute", and a
// calibrated prediction answers that far better than a spinner does. The
// honesty requirement is that it must never claim to be finished when it is
// not: the bar is clamped below 100% for as long as compaction is actually
// running, and overruns are shown as an explicit "over" state rather than
// silently pinning at full.

/** Serialized tool results are truncated to this many chars (compaction/utils.js). */
const TOOL_RESULT_MAX_CHARS = 2000;

/**
 * Measured on this box: prefill saturates around 3,300 tok/s, capped by BF16
 * tensor math rather than bandwidth. See docs/ninfer.md.
 */
const PREFILL_TOK_S = 3300;

/**
 * Decode rate for the summarization request. Lower than the ~56 tok/s a short
 * chat turn sees, because summarization runs at the session thinking level and
 * long outputs decode against a growing KV.
 */
const DECODE_TOK_S = 45;

/**
 * Typical summary length including reasoning tokens. The hard ceiling is
 * 0.8 * reserveTokens = 13,107, but summaries land far below it; this is the
 * central estimate the calibration factor then corrects.
 */
const EXPECTED_OUTPUT_TOKENS = 2200;

/** Never predict a job shorter than this; sub-second predictions make the bar jump. */
const MIN_PREDICTION_MS = 4000;

/** Calibration samples older than this many entries are dropped. */
export const MAX_SAMPLES = 12;

export interface Sample {
  /** Estimated prompt tokens for the summarization request. */
  promptTokens: number;
  /** Observed wall-clock duration in ms. */
  ms: number;
}

/**
 * Estimate the token count of the text pi will actually send for summarization.
 *
 * This deliberately mirrors serializeConversation(): tool results are truncated
 * to 2,000 chars there, so counting them in full would overestimate a
 * tool-heavy session by a wide margin — which is exactly the kind of session
 * that reaches compaction.
 */
export function estimatePromptTokens(messages: unknown[]): number {
  let chars = 0;
  for (const raw of messages) {
    const msg = raw as { role?: string; content?: unknown };
    if (!msg || typeof msg !== "object") continue;
    const isToolResult = msg.role === "toolResult";
    let msgChars = 0;

    if (typeof msg.content === "string") {
      msgChars = msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const raw2 of msg.content) {
        const block = raw2 as { type?: string; text?: string; thinking?: string; arguments?: unknown };
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && typeof block.text === "string") msgChars += block.text.length;
        else if (block.type === "thinking" && typeof block.thinking === "string") msgChars += block.thinking.length;
        else if (block.type === "toolCall") {
          try {
            msgChars += JSON.stringify(block.arguments ?? {}).length;
          } catch {
            // Circular or otherwise unserializable arguments: skip rather than throw.
          }
        }
      }
    }

    if (isToolResult && msgChars > TOOL_RESULT_MAX_CHARS) msgChars = TOOL_RESULT_MAX_CHARS;
    chars += msgChars;
  }
  return Math.ceil(chars / 4);
}

/**
 * The physics-only prediction, before calibration: prefill the summarization
 * prompt, then decode a summary.
 */
export function baselineMs(promptTokens: number): number {
  const prefill = (promptTokens / PREFILL_TOK_S) * 1000;
  const decode = (EXPECTED_OUTPUT_TOKENS / DECODE_TOK_S) * 1000;
  return Math.max(MIN_PREDICTION_MS, prefill + decode);
}

/**
 * Learn a single scale factor from past runs.
 *
 * One scalar per compaction (total duration) cannot identify two rates, so the
 * SHAPE of baselineMs is held fixed and only its scale is fitted. The median is
 * used rather than the mean because one compaction that queued behind another
 * GPU claimant would otherwise drag every later prediction with it.
 */
export function calibration(samples: Sample[]): number {
  const ratios = samples
    .filter((s) => s.ms > 0 && s.promptTokens >= 0)
    .map((s) => s.ms / baselineMs(s.promptTokens))
    .filter((r) => Number.isFinite(r) && r > 0)
    .sort((a, b) => a - b);
  if (ratios.length === 0) return 1;
  const mid = Math.floor(ratios.length / 2);
  const median = ratios.length % 2 === 1 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
  // Clamp: a wildly off sample (aborted run, engine restart) should nudge the
  // prediction, not replace it.
  return Math.min(4, Math.max(0.25, median));
}

export function predictMs(promptTokens: number, samples: Sample[]): number {
  return Math.max(MIN_PREDICTION_MS, baselineMs(promptTokens) * calibration(samples));
}

export function addSample(samples: Sample[], sample: Sample): Sample[] {
  return [...samples, sample].slice(-MAX_SAMPLES);
}

/**
 * Progress fraction in [0, 0.99]. Never reaches 1 while running: a bar that
 * reads 100% next to a still-spinning job is worse than one that reads 99%,
 * because it tells the user the process is stuck rather than slow.
 */
export function progressFraction(elapsedMs: number, predictedMs: number): number {
  if (predictedMs <= 0) return 0;
  return Math.max(0, Math.min(0.99, elapsedMs / predictedMs));
}

/** `1m 31s` / `47s`. Matches the elapsed-time style pi uses elsewhere. */
export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/**
 * Render the bar as plain text. Colour is applied by the caller, which owns the
 * theme; keeping this pure is what makes it testable.
 */
export function barCells(frac: number, width: number): { filled: number; width: number } {
  const w = Math.max(1, width);
  return { filled: Math.max(0, Math.min(w, Math.round(frac * w))), width: w };
}

/** Label for the compaction reason, matching pi's own wording. */
export function reasonLabel(reason: string): string {
  if (reason === "overflow") return "Context overflow — compacting";
  if (reason === "manual") return "Compacting conversation";
  return "Auto-compacting conversation";
}
