// redcode-commands — muscle-memory aliases and a one-key effort switch.
//
// /clear  -> pi calls it /new  (Claude Code muscle memory)
// /exit   -> pi calls it /quit
// /effort -> change thinking level without walking /settings > /thinking > back
//
// These are ADDITIVE aliases, not renames. pi's own /new and /quit keep working,
// so nothing in the docs or in anyone else's muscle memory breaks — you simply
// get a second door to the same room.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// pi's full ladder, weakest to strongest. The model decides which of these are
// real; see below.
const ALL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Level = (typeof ALL_LEVELS)[number];

/** Levels this model will actually accept, in ladder order.
 *
 *  CRITICAL: filtered through the model's thinkingLevelMap. Qwen 3.8 via NInfer
 *  supports only off/low/medium/xhigh — asking for `high` returns a 400 that pi
 *  silently retries, so the turn HANGS rather than erroring (reproduced
 *  2026-08-16, killed at 3 minutes). A cycle command that stepped blindly
 *  through all seven would walk straight into that on the second press, so the
 *  unsupported ones are excluded here rather than discovered the hard way. */
function supported(model: any): Level[] {
  const map = model?.thinkingLevelMap;
  // No map means the provider takes pi's names as-is (e.g. zai/glm-5.3).
  if (!map) return [...ALL_LEVELS];
  return ALL_LEVELS.filter((l) => map[l] != null);
}

export default function (pi: ExtensionAPI) {
  // The model is reachable as ctx.model in handlers, but getArgumentCompletions
  // is handed only the argument prefix — no ctx. So the active model is cached
  // here from the events that change it, otherwise tab-completion cannot know
  // which levels are legal and would happily offer one that hangs the turn.
  let currentModel: any = null;
  pi.on("session_start", async (_e, ctx: any) => { currentModel = ctx.model ?? currentModel; });
  pi.on("model_select", async (event: any) => { currentModel = event.model ?? currentModel; });

  // ------------------------------------------------------------- /clear
  pi.registerCommand("clear", {
    description: "Start a fresh session (alias for /new)",
    handler: async (_args, ctx) => {
      await ctx.newSession();
    },
  });

  // -------------------------------------------------------------- /exit
  pi.registerCommand("exit", {
    description: "Quit pi (alias for /quit)",
    handler: async (_args, ctx) => {
      ctx.shutdown();
    },
  });

  // ------------------------------------------------------------ /effort
  pi.registerCommand("effort", {
    description: "Show, cycle, or set the thinking level (no arg = cycle up)",
    getArgumentCompletions: (prefix: string) => {
      const levels = supported(currentModel);
      const cur = pi.getThinkingLevel();
      return levels
        .filter((l) => l.startsWith(prefix))
        .map((l) => ({
          value: l,
          label: l === cur ? `${l}  (current)` : l,
          description:
            l === "off"
              ? "no thinking block"
              : l === "xhigh"
                ? "longest reasoning — this model's maximum"
                : `${l} reasoning budget`,
        }));
    },
    handler: async (args, ctx) => {
      const levels = supported(ctx.model ?? currentModel);
      const cur = pi.getThinkingLevel() as Level;
      const arg = args.trim().toLowerCase();

      if (!levels.length) {
        ctx.ui.notify("This model exposes no thinking levels.", "warning");
        return;
      }

      // Bare /effort reports rather than changes, so it is safe to type when
      // you only want to know where you are.
      if (arg === "?" || arg === "show") {
        ctx.ui.notify(`thinking: ${cur}   (available: ${levels.join(", ")})`, "info");
        return;
      }

      let next: Level;
      if (!arg) {
        // Cycle UP and wrap. Wrapping matters: without it the command goes dead
        // at the top and you are back in the settings menu you wanted to avoid.
        const i = levels.indexOf(cur);
        next = levels[(i + 1) % levels.length];
      } else {
        const match = levels.find((l) => l === arg);
        if (!match) {
          const rejected = (ALL_LEVELS as readonly string[]).includes(arg);
          ctx.ui.notify(
            rejected
              ? `'${arg}' is a pi level but this model rejects it — it would hang the turn. Available: ${levels.join(", ")}`
              : `unknown level '${arg}'. Available: ${levels.join(", ")}`,
            "warning",
          );
          return;
        }
        next = match;
      }

      pi.setThinkingLevel(next);
      ctx.ui.notify(`thinking: ${cur} -> ${next}`, "info");
    },
  });
}
