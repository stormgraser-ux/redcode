// redcode-thinkstrip — reasoning-echo policy. DEFAULTS TO OFF.
//
// This extension exists to make a measured trade inspectable, not to apply it.
// See strip.ts for the evidence: Qwen's published rule exempts multi-step tool
// calls, `preserve_thinking` is a deliberate feature of the 3.6/3.8 dense line,
// and MiniMax's direct ablation shows discarding interleaved thinking costs
// 23 points on Tau2 and 12.6 on BrowseComp. An agentic plan implementation is
// exactly the workload that loses.
//
// So the default is `all`: change nothing. `/reasoning-echo` reports what the
// other modes WOULD save on the current conversation, so the trade can be
// re-examined with real numbers instead of re-litigated from intuition.
//
//   REDCODE_REASONING_ECHO=all     (default) keep everything
//   REDCODE_REASONING_ECHO=turns   Qwen's published rule: drop reasoning from
//                                   completed user turns, keep the in-flight
//                                   tool chain. Costs one re-prefill per user
//                                   turn; saves little in an autonomous run.
//   REDCODE_REASONING_ECHO=none    drop all reasoning. Against guidance.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { env } from "node:process";
import { type EchoMode, parseMode, stripReasoning } from "./strip.ts";

export default function (pi: ExtensionAPI) {
  const mode: EchoMode = parseMode(env.REDCODE_REASONING_ECHO);

  // Always measured, even in `all`, so the saving is a number rather than an
  // argument. Peak rather than sum: the same reasoning is re-sent every
  // request, so a running total would mean nothing.
  let requests = 0;
  let peakWouldStrip = 0;
  let peakWouldSaveChars = 0;
  let peakTurnsChars = 0;

  pi.on("before_provider_request", (event: any) => {
    const payload = event.payload as Record<string, unknown> | undefined;
    if (!payload || !Array.isArray(payload.messages)) return;

    // Measure the counterfactual regardless of mode.
    const asNone = stripReasoning(payload.messages, "none");
    const asTurns = stripReasoning(payload.messages, "turns");
    if (asNone.stripped > 0) {
      requests++;
      peakWouldStrip = Math.max(peakWouldStrip, asNone.stripped);
      peakWouldSaveChars = Math.max(peakWouldSaveChars, asNone.chars);
      peakTurnsChars = Math.max(peakTurnsChars, asTurns.chars);
    }

    if (mode === "all") return;
    const applied = mode === "none" ? asNone : asTurns;
    if (applied.stripped === 0) return;
    return { ...payload, messages: applied.messages };
  });

  pi.registerCommand("reasoning-echo", {
    description: "Show what reasoning history is costing, and what stripping it would save",
    handler: async (_args, ctx) => {
      const tok = (chars: number) => Math.round(chars / 4).toLocaleString();
      if (requests === 0) {
        ctx.ui.notify(
          `Reasoning echo mode: ${mode}. No reasoning seen yet this session.`,
          "info",
        );
        return;
      }
      ctx.ui.notify(
        `Reasoning echo mode: ${mode}\n` +
          `  requests seen:        ${requests}\n` +
          `  peak messages:        ${peakWouldStrip} carrying reasoning\n` +
          `  peak cost of echo:    ~${tok(peakWouldSaveChars)} tokens\n` +
          `  'turns' would save:   ~${tok(peakTurnsChars)} tokens\n` +
          `  'none'  would save:   ~${tok(peakWouldSaveChars)} tokens\n\n` +
          `Default is 'all' deliberately: Qwen's rule exempts multi-step tool calls, and\n` +
          `MiniMax's ablation puts the cost of discarding interleaved thinking at\n` +
          `Tau2 87->64, BrowseComp 44.0->31.4. See docs/pi-agent-efficiency.md.`,
        "info",
      );
    },
  });
}
