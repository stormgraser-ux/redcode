// redcode-status — per-turn dynamics under the command line: decode rate,
// time to first token, output size.
//
// WHY NOT THE LOCALOPS ONE. That statusline reads the inference engine's own
// JSONL request log for prefill rate, cache reuse, rounds/s and tokens/round.
// Those are the most interesting numbers on it and none of them can travel:
// they exist only on the machine running the engine, and a guest talking to a
// remote server has no such file. What IS portable is everything the client
// can observe for itself, which turns out to be the two numbers you actually
// watch — how fast it is writing, and how long it sat there first.
//
// THE MEASUREMENT TRAP. Decode rate is timed from the first CONTENT delta, not
// from the first byte of the response. Servers commonly emit a message_start
// frame before prefilling anything, so timing from the first byte folds the
// whole prefill into the decode rate and reports ~40 tok/s for a model doing
// ~124. Time-to-first-token is measured to that same first content delta, for
// the same reason: the interesting quantity is when it started SAYING
// something, not when the socket first moved.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { decodeRate, segments, type Turn } from "./rate.ts";

/** How often to repaint while a turn is streaming. Fast enough that the figure
 *  reads as live, slow enough not to fight the renderer for the terminal. */
const POLL_MS = 1500;

export default function (pi: ExtensionAPI) {
  let requestAt: number | null = null;
  let firstDeltaAt: number | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;

  const turn: Turn = { ttftMs: null, tokPerSec: null, output: null };

  const render = (ctx: any, live: boolean) => {
    if (!ctx.hasUI) return;
    const t = ctx.ui.theme;
    const parts = segments(turn).map((seg) => {
      if (seg.key === "rate") {
        // Provisional and final rates are coloured apart, so a figure that is
        // still climbing is not misread as the result.
        return t.fg(live ? "warning" : "success", seg.text);
      }
      return t.fg("dim", seg.text);
    });
    // The model, provider and thinking level are NOT shown here: pi's own
    // footer already renders them on the right, with strictly more detail than
    // a bare id. Printing them again would be duplication in which this copy
    // is the worse one.
    ctx.ui.setStatus("redcode", parts.join(t.fg("dim", " · ")));
  };

  const stopPoll = () => {
    if (poll) {
      clearInterval(poll);
      poll = null;
    }
  };

  pi.on("session_start", async (_e, ctx) => {
    render(ctx, false);
  });

  pi.on("turn_start", async (_e, ctx) => {
    requestAt = Date.now();
    firstDeltaAt = null;
    if (!poll) poll = setInterval(() => render(ctx, true), POLL_MS);
  });

  pi.on("message_update", async (event: any, ctx) => {
    const ev = event.assistantMessageEvent;
    if (!ev) return;
    // Thinking and tool-call deltas count: they are the model producing
    // output. Anything else is framing, and starting the clock on framing is
    // exactly the mistake this extension exists to avoid.
    const isContent =
      ev.type === "text_delta" || ev.type === "thinking_delta" || ev.type === "toolcall_delta";
    if (!isContent) return;

    if (firstDeltaAt === null) {
      firstDeltaAt = Date.now();
      if (requestAt !== null) turn.ttftMs = firstDeltaAt - requestAt;
      render(ctx, true);
    }
  });

  pi.on("message_end", async (event: any, ctx) => {
    if (event.message?.role !== "assistant") return;
    const output = event.message?.usage?.output ?? null;
    if (output !== null) turn.output = output;
    if (output !== null && firstDeltaAt !== null) {
      const rate = decodeRate(output, Date.now() - firstDeltaAt);
      if (rate !== null) turn.tokPerSec = rate;
    }
    render(ctx, true);
  });

  pi.on("agent_settled", async (_e, ctx) => {
    stopPoll();
    render(ctx, false);
  });

  pi.on("session_shutdown", async () => {
    stopPoll();
  });
}
