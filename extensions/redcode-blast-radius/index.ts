// blast-radius — stop the agent from blowing things up, and never stop anything
// else.
//
// This is NOT a permission system and it NEVER PROMPTS. Ordinary bash, edits,
// writes and single-file deletes all run untouched and unlogged. Only the small
// set of commands that can destroy a whole tree is inspected, and those are
// judged by BLAST RADIUS — how deep the target sits below a guarded anchor:
//
//   rm -rf ~/code                     -> refused
//   rm -rf ~/code/sweepsites          -> refused, narrower alternative suggested
//   rm -rf ~/code/sweepsites/src      -> runs
//
// WHY THERE IS NO CONFIRMATION DIALOG. An earlier version asked before the
// middle tier. That is wrong for how this machine is actually used: long
// unattended runs are the norm, and a dialog nobody is present to answer does
// not make anything safer — it silently parks the agent until someone notices,
// which costs far more than the command ever would. So the classifier decides
// every time, and the answer is always immediate.
//
// THE ESCAPE HATCH IS /allow. A refusal tells the model to stop and say so if it
// believes the command is genuinely required. The user then runs /allow, picks
// the command from the recent refusals, confirms, and it is authorised ONCE.
// The pause happens on the user's schedule instead of the agent's.
//
// Tune it in policy.ts. The classifier and its 57-case suite are in classify.ts.
//
// Deliberate gap: `write` and `edit` are not gated. Clobbering one file is not a
// blast radius, and gating them would reintroduce the diff-approval friction
// this is meant to avoid.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { classifyCommand, suggestion, worst, type Finding } from "./classify.ts";

interface Refusal {
  command: string;
  finding: Finding;
  at: number;
}

const MAX_REMEMBERED = 10;

export default function (pi: ExtensionAPI) {
  const home = homedir();
  const refusals: Refusal[] = [];
  // Exact command strings the user has authorised. One-shot: consumed on use,
  // so an approval cannot silently apply to a later, different invocation.
  const authorised = new Set<string>();

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;

    const command = event.input.command;
    if (!command) return;

    if (authorised.has(command)) {
      authorised.delete(command);
      if (ctx.hasUI) ctx.ui.notify("Running user-authorised command.", "warning");
      return;
    }

    const finding = worst(classifyCommand(command, ctx.cwd, home));
    if (!finding) return; // the overwhelmingly common path

    refusals.push({ command, finding, at: Date.now() });
    if (refusals.length > MAX_REMEMBERED) refusals.shift();

    const target = finding.target ? `\n\nTarget: ${finding.target}` : "";
    const hint = suggestion(finding);

    return {
      block: true,
      reason:
        `Blocked by blast-radius: ${finding.reason}.${target}\n\n` +
        // Naming the narrower shape turns a refusal into a course correction.
        // A bare "no" tends to produce a retry of the same command.
        (hint ? `Suggestion: ${hint}\n\n` : "") +
        `Do not retry this command as written. If it is genuinely required and ` +
        `there is no narrower alternative, stop and tell the user why — they can ` +
        `authorise it with /allow. Otherwise continue with the rest of the task.`,
    };
  });

  pi.registerCommand("allow", {
    description: "Authorise a command the safety gate refused (one-shot)",
    handler: async (args, ctx) => {
      if (refusals.length === 0) {
        ctx.ui.notify("Nothing has been refused in this session.", "info");
        return;
      }

      // Most recent first — the one the agent just tried is usually the target.
      const recent = [...refusals].reverse();
      const labels = recent.map((r) => {
        const cmd = r.command.length > 70 ? `${r.command.slice(0, 67)}...` : r.command;
        return `[${r.finding.verdict}] ${cmd}`;
      });

      let pick = 0;
      const raw = (args ?? "").trim();
      if (raw) {
        const n = Number(raw);
        if (Number.isInteger(n) && n >= 1 && n <= recent.length) pick = n - 1;
        else {
          const found = recent.findIndex((r) => r.command.includes(raw));
          if (found === -1) { ctx.ui.notify(`No refused command matching "${raw}".`, "warning"); return; }
          pick = found;
        }
      } else {
        const chosen = await ctx.ui.select("Authorise which refused command?", labels);
        if (!chosen) return;
        pick = labels.indexOf(chosen);
        if (pick === -1) return;
      }

      const r = recent[pick];
      const hint = suggestion(r.finding);

      // The two tiers are confirmed differently on purpose. A refusal that was
      // only ever "ask first" needs one confirmation. A hard deny — $HOME, a
      // whole project, a system root — is something the classifier considers
      // never appropriate from an agent, so overriding it is spelled out in
      // full and confirmed twice.
      const detail =
        `${r.command}\n\n` +
        `Reason: ${r.finding.reason}` +
        (r.finding.target ? `\nTarget: ${r.finding.target}` : "") +
        (hint ? `\n\nSuggested alternative: ${hint}` : "");

      const ok = await ctx.ui.confirm(
        r.finding.verdict === "deny" ? "Override a HARD refusal?" : "Authorise this command?",
        detail,
      );
      if (!ok) { ctx.ui.notify("Not authorised.", "info"); return; }

      if (r.finding.verdict === "deny") {
        const sure = await ctx.ui.confirm(
          "Are you certain?",
          `This target is one the gate treats as never safe from an agent.\n\n` +
            `${r.finding.target ?? r.command}\n\n` +
            `It will be run once, exactly as written. There is no undo.`,
        );
        if (!sure) { ctx.ui.notify("Not authorised.", "info"); return; }
      }

      authorised.add(r.command);
      ctx.ui.notify("Authorised once. Ask the agent to retry it.", "warning");
      // pi.sendUserMessage, NOT ctx.sendUserMessage: the method lives on
      // ExtensionAPI and ReplacedSessionContext, but not on the
      // ExtensionCommandContext a command handler receives.
      pi.sendUserMessage(
        `I have authorised this command once. Run it exactly as written, then continue:\n\n` +
          "```bash\n" + r.command + "\n```",
      );
    },
  });

  pi.registerCommand("refusals", {
    description: "List commands the safety gate refused this session",
    handler: async (_args, ctx) => {
      if (refusals.length === 0) { ctx.ui.notify("Nothing refused this session.", "info"); return; }
      ctx.ui.notify(
        [...refusals]
          .reverse()
          .map((r, i) => `${i + 1}. [${r.finding.verdict}] ${r.command}\n   ${r.finding.reason}`)
          .join("\n"),
        "info",
      );
    },
  });
}
