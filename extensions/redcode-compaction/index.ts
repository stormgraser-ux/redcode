// redcode-compaction — an elapsed timer and progress bar for compaction.
//
// THE PROBLEM. pi's built-in compaction indicator is a spinner and a sentence:
// "Auto-compacting... (escape to cancel)". On a cloud model that is fine,
// because compaction takes a few seconds. Against the local engine it routinely
// runs 60-120s — a full re-prefill of the serialized conversation with no cache
// to reuse, followed by a long thinking-mode generation — and a bare spinner
// gives no way to tell a slow compaction from a wedged one.
//
// WHY THE BAR IS A PREDICTION AND NOT A TOKEN COUNTER. Summarization does not
// go through the agent loop; pi calls `agent.streamFunction` directly
// (agent-session.js:1653), so message_update and turn_end never fire for it. The
// only observable moments are `session_before_compact` and `session_compact`.
// Everything between them is invisible to an extension, so the bar is fitted
// rather than measured. See estimate.ts for the model and for the honesty
// constraints it is held to.
//
// CALIBRATION. The prediction's shape is fixed (prefill the summarization
// prompt, then decode a summary) and only its scale is learned, from the last
// dozen observed compactions in ~/.pi/agent/compaction-timings.json. One scalar
// per run cannot identify two rates, so fitting anything richer would be
// fitting noise.
//
// This widget REPLACES nothing. pi's own indicator keeps rendering, including
// the cancel hint, which is the one piece of information that must not depend
// on an extension being loaded.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  addSample,
  barCells,
  estimatePromptTokens,
  formatElapsed,
  predictMs,
  progressFraction,
  reasonLabel,
  type Sample,
} from "./estimate.ts";

const TIMINGS_FILE = join(homedir(), ".pi", "agent", "compaction-timings.json");
const BAR_W = 34;
const TICK_MS = 250;

/** Stop repainting after this long. A compaction still running here is wedged,
 *  and a widget that ticks forever hides that rather than showing it. */
const HARD_STOP_MS = 15 * 60 * 1000;

function loadSamples(): Sample[] {
  try {
    const parsed = JSON.parse(readFileSync(TIMINGS_FILE, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is Sample =>
        s && typeof s.promptTokens === "number" && typeof s.ms === "number",
    );
  } catch {
    // No file yet, or unreadable: an uncalibrated prediction is still useful.
    return [];
  }
}

function saveSamples(samples: Sample[]): void {
  try {
    writeFileSync(TIMINGS_FILE, `${JSON.stringify(samples, null, 2)}\n`);
  } catch {
    // Calibration is a nicety. Never let it break a compaction.
  }
}

/**
 * Warn when pi's dist has lost the mid-chain compaction patch.
 *
 * `redcode` re-applies it on every launch, so this only fires for a bare `pi`
 * or a launcher that skips the step — but that is exactly the case where an npm
 * upgrade silently reverts the patch and nothing else would say so. Extensions
 * load long after agent-session.js is imported, so this cannot fix it in place;
 * it reports, and the fix takes effect on the next launch.
 */
function checkPatched(ctx: any): void {
  if (!ctx?.hasUI) return;
  try {
    // Locate pi's dist from THIS process, not from `which pi`. `which` is not a
    // Windows program — pi needs bash there, but extensions run in Node, which
    // does not inherit Git Bash's PATH, so shelling out to `which` throws and
    // the whole check silently vanishes into the catch below. process.argv[1] is
    // the running dist/cli.js on every platform.
    const cli = realpathSync(process.argv[1]);
    const target = join(dirname(cli), "core", "agent-session.js");
    // The marker string is historical (these extensions began life as LocalOps)
    // and is what scripts/pi-patch writes. Do not "tidy" it in one place only —
    // the patcher and this check must agree or every launch cries wolf.
    if (readFileSync(target, "utf8").includes("LOCALOPS-MIDCHAIN-COMPACTION")) return;
    ctx.ui.notify(
      "pi is missing the mid-chain compaction patch — long tool chains will " +
        "truncate before compacting. Run redcode's scripts/pi-patch, then restart.",
      "warning",
    );
  } catch {
    // Never let a diagnostic break a session.
  }
}

export default function (pi: ExtensionAPI) {
  let samples = loadSamples();

  let timer: NodeJS.Timeout | null = null;
  let startedAt = 0;
  let predicted = 0;
  let promptTokens = 0;
  let label = "";

  const clear = (ctx: any) => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (ctx?.hasUI) ctx.ui.setWidget("redcode-compaction", undefined);
  };

  const paint = (ctx: any) => {
    if (!ctx?.hasUI || !timer) return;
    const elapsed = Date.now() - startedAt;
    const t = ctx.ui.theme;

    // Past the prediction the bar has nothing left to say, so it stops
    // pretending and reports the overrun instead. Silently pinning at 99%
    // would make a wedged compaction look identical to a slow one.
    const over = elapsed > predicted;
    const frac = progressFraction(elapsed, predicted);
    const { filled, width } = barCells(frac, BAR_W);

    let bar = "";
    for (let i = 0; i < width; i++) {
      bar += i < filled ? t.fg(over ? "warning" : "accent", "━") : t.fg("borderMuted", "─");
    }

    const pct = `${Math.round(frac * 100)}%`;
    const right = over
      ? t.fg("warning", `over est. by ${formatElapsed(elapsed - predicted)}`)
      : t.fg("dim", `~${formatElapsed(Math.max(0, predicted - elapsed))} left`);

    ctx.ui.setWidget(
      "redcode-compaction",
      [
        t.fg("accent", `  ${label}… `) + t.fg("dim", `(${formatElapsed(elapsed)})`),
        `  ${bar} ` + t.fg(over ? "warning" : "text", pct),
        t.fg("dim", `  ${promptTokens.toLocaleString()} tok to summarize  `) + right,
      ],
      { placement: "aboveEditor" },
    );
  };

  pi.on("session_start", async (_e, ctx) => checkPatched(ctx));

  pi.on("session_before_compact", async (event: any, ctx) => {
    // This handler is awaited before compaction starts, so it must not block.
    // Start the clock and return; the interval does the work.
    const prep = event.preparation ?? {};
    const toSummarize = [
      ...(prep.messagesToSummarize ?? []),
      ...(prep.turnPrefixMessages ?? []),
    ];
    promptTokens = estimatePromptTokens(toSummarize);
    predicted = predictMs(promptTokens, samples);
    startedAt = Date.now();
    label = reasonLabel(event.reason);

    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      if (Date.now() - startedAt > HARD_STOP_MS) {
        clear(ctx);
        return;
      }
      paint(ctx);
    }, TICK_MS);
    paint(ctx);

    // Cancelling (escape) resolves neither session_compact nor an error path
    // that reaches this extension, so the abort signal is the only reliable way
    // to take the widget down on a user cancel.
    event.signal?.addEventListener?.("abort", () => clear(ctx), { once: true });

    return undefined;
  });

  pi.on("session_compact", async (_event, ctx) => {
    if (!timer) return;
    const elapsed = Date.now() - startedAt;
    clear(ctx);
    // Only successful compactions calibrate. An aborted or failed one has a
    // duration that means nothing about how long the work takes.
    samples = addSample(samples, { promptTokens, ms: elapsed });
    saveSamples(samples);
  });

  // Safety nets. session_compact does not fire when compaction fails, and a
  // stale progress widget pinned above the editor is worse than none.
  pi.on("agent_settled", async (_e, ctx) => clear(ctx));
  pi.on("message_start", async (_e, ctx) => clear(ctx));
  pi.on("session_shutdown", async () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  });

  pi.registerCommand("compaction-stats", {
    description: "Show measured compaction timings and the calibration factor",
    handler: async (_args, ctx) => {
      if (samples.length === 0) {
        ctx.ui.notify(
          "No compactions measured yet. The first one runs on an uncalibrated estimate.",
          "info",
        );
        return;
      }
      const lines = samples.map(
        (s) => `  ${s.promptTokens.toLocaleString().padStart(9)} tok  →  ${formatElapsed(s.ms)}`,
      );
      const nextGuess = predictMs(promptTokens || 60000, samples);
      ctx.ui.notify(
        `Compaction timings (last ${samples.length}):\n${lines.join("\n")}\n\n` +
          `Prediction for a 60,000-token summarization: ~${formatElapsed(nextGuess)}`,
        "info",
      );
    },
  });
}
