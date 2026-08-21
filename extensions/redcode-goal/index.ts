// goal — keep working until a condition is met, with no evaluator model.
//
// Modelled on the OpenCode /goal plugins rather than Claude Code's /goal. The
// difference is the whole point: Claude Code judges completion with a second,
// smaller model reading the transcript. On this box that model would have to be
// local (no VRAM to spare beside a 27B) or cloud (paying a frontier model to
// grade a 27B). So completion is decided by two evaluator-free signals instead:
//
//   1. A SHELL COMMAND. `--verify "npm test"` runs after every turn; exit 0
//      means done. This is the primary path and the only trustworthy one: a 27B
//      declaring itself finished is the weakest signal available, being the same
//      overconfidence that makes it rewrite plan steps.
//
//   2. A SENTINEL MARKER, for work no command can check. The model writes
//      GOAL_COMPLETE: or GOAL_BLOCKED: on its own line. Detection is
//      line-anchored and code-fence-aware, so the model explaining the protocol
//      or printing an example inside a ``` block does not end the run.
//
// The loop rides `agent_settled`, pi's analogue of OpenCode's `session.idle`:
// when pi would otherwise hand control back, an unmet goal injects one nudge to
// force another turn.
//
// Stopping is deliberately over-provisioned, because the failure mode of an
// agent loop is burning an afternoon, not money — tokens are free locally,
// wall-clock is not:
//   - turn cap and wall-clock cap (defaults 30 turns / 120 minutes)
//   - no-tool-call stall: N consecutive turns that did nothing but talk
//   - blocked marker, verify command erroring out, or the user pressing Esc
//
// Nothing here needs to relax the safety gate: blast-radius never prompts, in
// any mode, so a goal run cannot stall on a dialog nobody is there to answer.
// If the agent hits a refusal it believes is essential, it stops and says so,
// and the user authorises it with /allow on their own schedule.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { clearGoal, readGoal, writeGoal, type GoalRun } from "./goal-state.ts";

const DEFAULT_TURNS = 30;
const DEFAULT_MINUTES = 120;
const STALL_TURNS = 3; // consecutive no-tool-call turns before pausing

const PROTOCOL =
  "You are now working toward a goal and will be prompted to continue automatically " +
  "until it is met.\n" +
  "- Work in small verified steps. Prefer running commands that prove progress.\n" +
  "- When the goal is genuinely met, write GOAL_COMPLETE: on its own line, followed by " +
  "a one-line summary of the evidence (what you ran and what it showed).\n" +
  "- If you are truly stuck or the goal is impossible, write GOAL_BLOCKED: on its own " +
  "line with the reason.\n" +
  "- Do not write either marker inside a code block, and do not write them speculatively. " +
  "Writing GOAL_COMPLETE: without having verified the work is the single worst failure here.";

/** Strip fenced and indented code, then look for a line-anchored marker.
 *  Without this, a model that merely explains the protocol ends its own run. */
export function findMarker(text: string): "complete" | "blocked" | null {
  const lines = text.split("\n");
  let fence: string | null = null;
  let found: "complete" | "blocked" | null = null;

  for (const raw of lines) {
    const line = raw.trimEnd();
    const fenceMatch = line.trim().match(/^(```+|~~~+)(.*)$/);
    if (fenceMatch) {
      const tick = fenceMatch[1][0];
      const info = fenceMatch[2].trim();
      if (fence === null) {
        fence = tick; // opening fence, info string allowed (```bash)
      } else if (fence === tick && info === "") {
        fence = null; // a CLOSING fence carries no info string, per CommonMark
      }
      // Anything else (a different tick, or ```bash while already open) is
      // content inside the block. Treating it as a close would expose the
      // following lines and allow a fenced example to end the run.
      continue;
    }
    if (fence !== null) continue;
    if (/^ {4,}|^\t/.test(raw)) continue; // indented code block

    if (/^GOAL_COMPLETE:/.test(line.trim())) found = "complete";
    else if (/^GOAL_BLOCKED:/.test(line.trim())) found = "blocked";
  }
  return found;
}

function runVerify(cmd: string, cwd: string): Promise<{ ok: boolean; output: string; failed: boolean }> {
  return new Promise((resolve) => {
    execFile(
      "bash",
      ["-lc", cmd],
      { cwd, timeout: 10 * 60 * 1000, maxBuffer: 2 * 1024 * 1024 },
      (err: any, stdout, stderr) => {
        const output = `${stdout ?? ""}${stderr ?? ""}`.trim().slice(-2000);
        if (!err) return resolve({ ok: true, output, failed: false });
        // A command that could not run at all (not found, timeout) is a broken
        // goal, not an unmet one — looping on it would never converge.
        const broken = err.code === "ENOENT" || err.killed === true;
        resolve({ ok: false, output, failed: broken });
      },
    );
  });
}

export default function (pi: ExtensionAPI) {
  let turns = 0;
  let noToolTurns = 0;
  let paused = false;
  let lastAssistantText = "";

  const stop = (ctx: any, why: string, level: "info" | "warning" | "error" = "info") => {
    clearGoal();
    paused = true;
    if (ctx.hasUI) {
      ctx.ui.setStatus("goal", undefined);
      ctx.ui.notify(`Goal ended: ${why}`, level);
    }
  };

  const paint = (ctx: any, g: GoalRun) => {
    if (!ctx.hasUI) return;
    const mins = Math.round((Date.now() - g.startedAt) / 60000);
    ctx.ui.setStatus(
      "goal",
      ctx.ui.theme.fg("accent", "◎ goal ") +
        ctx.ui.theme.fg("dim", `turn ${turns}/${g.maxTurns} · ${mins}/${g.maxMinutes}m`),
    );
  };

  pi.on("session_start", async (_e, _ctx) => {
    // A goal never survives a restart: the loop drives real work and silently
    // resuming one the user has forgotten about is the wrong default.
    clearGoal();
  });
  pi.on("session_shutdown", async () => clearGoal());

  pi.on("turn_end", async (event: any) => {
    const results = event.toolResults ?? [];
    if (results.length === 0) noToolTurns++;
    else noToolTurns = 0;
  });

  pi.on("message_end", async (event: any) => {
    if (event.message?.role !== "assistant") return;
    const content = event.message.content;
    lastAssistantText = Array.isArray(content)
      ? content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n")
      : typeof content === "string"
        ? content
        : "";
  });

  pi.on("agent_settled", async (_e, ctx) => {
    const g = readGoal();
    if (!g || paused) return;

    turns++;
    paint(ctx, g);

    // --- hard stops ---------------------------------------------------------
    if (turns >= g.maxTurns) return stop(ctx, `turn cap reached (${g.maxTurns})`, "warning");
    if (Date.now() - g.startedAt > g.maxMinutes * 60_000)
      return stop(ctx, `time cap reached (${g.maxMinutes}m)`, "warning");

    // --- the model gave up --------------------------------------------------
    const marker = findMarker(lastAssistantText);
    if (marker === "blocked") return stop(ctx, "the agent reported it is blocked", "warning");

    // --- primary signal: the shell gate ------------------------------------
    if (g.verify) {
      const r = await runVerify(g.verify, ctx.cwd);
      if (r.ok) return stop(ctx, `verified — \`${g.verify}\` exited 0`);
      if (r.failed) return stop(ctx, `verify command could not run: ${g.verify}`, "error");

      // The model claimed done but the command disagrees. Say so plainly:
      // the command wins, and the claim was wrong.
      const correction = marker === "complete"
        ? `You wrote GOAL_COMPLETE: but the verification command still fails. The command is authoritative.\n\n`
        : "";
      pi.sendUserMessage(
        `${correction}Goal not yet met. \`${g.verify}\` is still failing:\n\n` +
          "```\n" + (r.output || "(no output)") + "\n```\n\n" +
          `Goal: ${g.condition}\nContinue working toward it.`,
        { deliverAs: "followUp" },
      );
      return;
    }

    // --- fallback signal: self-declared marker ------------------------------
    if (marker === "complete") return stop(ctx, "the agent reported the goal complete");

    // --- stall detection ----------------------------------------------------
    // Talking without acting is the classic stuck loop. Only meaningful for
    // unverified goals; a verify command already forces real work.
    if (noToolTurns >= STALL_TURNS)
      return stop(ctx, `no tool calls for ${STALL_TURNS} turns — likely stuck`, "warning");

    pi.sendUserMessage(
      `Goal not yet met: ${g.condition}\n\nContinue working toward it. ` +
        `When it is genuinely met, write GOAL_COMPLETE: on its own line with the evidence.`,
      { deliverAs: "followUp" },
    );
  });

  pi.registerCommand("goal", {
    description: "Work until a condition is met — /goal <condition> [--verify <cmd>] [--turns N] [--time M]",
    handler: async (args, ctx) => {
      const raw = (args ?? "").trim();
      const existing = readGoal();

      if (raw === "" ) {
        if (!existing) { ctx.ui.notify("No goal set. Use /goal <condition> [--verify <cmd>]", "info"); return; }
        const mins = Math.round((Date.now() - existing.startedAt) / 60000);
        ctx.ui.notify(
          `Goal: ${existing.condition}\n` +
            (existing.verify ? `Verify: ${existing.verify}\n` : "Verify: (none — marker only)\n") +
            `Turn ${turns}/${existing.maxTurns}, ${mins}/${existing.maxMinutes} min`,
          "info",
        );
        return;
      }

      if (raw === "clear" || raw === "stop") {
        if (!existing) { ctx.ui.notify("No goal active.", "info"); return; }
        stop(ctx, "cleared by user");
        return;
      }

      // Parse flags off the end; everything else is the condition.
      let condition = raw;
      let verify: string | undefined;
      let maxTurns = DEFAULT_TURNS;
      let maxMinutes = DEFAULT_MINUTES;

      const vm = condition.match(/--verify\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
      if (vm) { verify = vm[1] ?? vm[2] ?? vm[3]; condition = condition.replace(vm[0], "").trim(); }
      const tm = condition.match(/--turns\s+(\d+)/);
      if (tm) { maxTurns = Number(tm[1]); condition = condition.replace(tm[0], "").trim(); }
      const mm = condition.match(/--time\s+(\d+)/);
      if (mm) { maxMinutes = Number(mm[1]); condition = condition.replace(mm[0], "").trim(); }

      if (!condition) { ctx.ui.notify("Give a condition: /goal <what done looks like>", "warning"); return; }

      turns = 0;
      noToolTurns = 0;
      paused = false;
      const g: GoalRun = { pid: process.pid, condition, verify, startedAt: Date.now(), maxTurns, maxMinutes };
      writeGoal(g);
      paint(ctx, g);

      ctx.ui.notify(
        `Goal set${verify ? ` (verified by \`${verify}\`)` : " (marker only — no verify command)"}. ` +
          `Caps: ${maxTurns} turns / ${maxMinutes} min. Esc or /goal clear to stop.`,
        "info",
      );

      // pi.sendUserMessage, NOT ctx.sendUserMessage: the method lives on
      // ExtensionAPI and ReplacedSessionContext, but not on the
      // ExtensionCommandContext a command handler receives.
      pi.sendUserMessage(`${PROTOCOL}\n\nGoal: ${condition}\n\nBegin.`);
    },
  });
}
