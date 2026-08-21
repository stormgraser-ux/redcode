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
import { escalatesPrivilege, fetchesRemoteContent } from "./taint.ts";

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
  // One-way: set when untrusted external content enters, never cleared except
  // by the user via /trust-reset. See taint.ts for why it is per-session.
  let tainted: { where: string; at: number } | null = null;

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;

    const command = event.input.command;
    if (!command) return;

    if (authorised.has(command)) {
      authorised.delete(command);
      if (ctx.hasUI) ctx.ui.notify("Running user-authorised command.", "warning");
      return;
    }

    // A command that BOTH fetches and escalates closes the gap between the two
    // inside a single tool call, where a per-command taint check cannot see it.
    // Measured: asked to fetch a page and then sudo, the model emitted
    // `webfetch https://example.com; sudo -n id` as ONE command and got root.
    // Ordering is not a defence here (the fetch half may be a redirect chain
    // that resolves at run time), so the pair is refused outright and the model
    // is told to split it — at which point the normal taint rule applies.
    {
      const f = fetchesRemoteContent(command);
      const e = escalatesPrivilege(command);
      if (f.yes && e.yes) {
        const finding: Finding = {
          verdict: "deny",
          reason: `one command both fetches from ${f.where} and runs \`${e.how}\``,
          command,
        };
        refusals.push({ command, finding, at: Date.now() });
        if (refusals.length > MAX_REMEMBERED) refusals.shift();
        return {
          block: true,
          reason:
            `Blocked by blast-radius: this single command both pulls content from ` +
            `${f.where} and runs \`${e.how}\`. Web content must not be able to reach ` +
            `root in the same breath it arrives.\n\n` +
            `Split it into two separate bash calls. The privileged one must come ` +
            `FIRST — once anything is fetched, this session cannot escalate again.`,
        };
      }
    }

    // Privilege check BEFORE the taint is applied, so the command that does
    // the fetching is itself judged against the trust level in force when it
    // was issued.
    if (tainted) {
      const esc = escalatesPrivilege(command);
      if (esc.yes) {
        const finding: Finding = {
          verdict: "deny",
          reason:
            `privilege escalation after untrusted web content entered this session ` +
            `(from ${tainted.where})`,
          command,
        };
        refusals.push({ command, finding, at: Date.now() });
        if (refusals.length > MAX_REMEMBERED) refusals.shift();

        return {
          block: true,
          reason:
            `Blocked by blast-radius: this session is TAINTED. It pulled in content ` +
            `from ${tainted.where}, so \`${esc.how}\` is refused for the rest of the session.\n\n` +
            `This is not about this particular command. Anything read from the internet ` +
            `may be trying to steer you, and root is not recoverable if it succeeds.\n\n` +
            `Do the non-privileged parts of the task now. If the privileged step is ` +
            `genuinely required, stop and tell the user what you need to run and why — ` +
            `they can authorise it once with /allow, or start a clean session.`,
        };
      }
    }

    const fetch = fetchesRemoteContent(command);

    const finding = worst(classifyCommand(command, ctx.cwd, home));

    // Taint only once the command is actually going to run — a refused fetch
    // never brought anything in, so it must not cost the session its root.
    if (fetch.yes && !finding && !tainted) {
      tainted = { where: fetch.where ?? "the internet", at: Date.now() };
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Session tainted by web content from ${tainted.where}.\n` +
            `sudo/pkexec/su are now refused for the rest of this session. ` +
            `/trust-status for detail, /trust-reset to clear it deliberately.`,
          "warning",
        );
      }
    }

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

  pi.registerCommand("trust-status", {
    description: "Show whether web content has cost this session its root access",
    handler: async (_args, ctx) => {
      if (!tainted) {
        ctx.ui.notify(
          "Session is CLEAN — no untrusted web content seen, sudo available.",
          "info",
        );
        return;
      }
      const mins = Math.round((Date.now() - tainted.at) / 60000);
      ctx.ui.notify(
        `Session is TAINTED.\n\n` +
          `Source: ${tainted.where}\n` +
          `Since:  ${mins} minute${mins === 1 ? "" : "s"} ago\n\n` +
          `sudo, pkexec, doas, su and runuser are refused. Ordinary commands ` +
          `are unaffected. Start a new session to get root back, or /trust-reset ` +
          `if you are satisfied nothing hostile came in.`,
        "warning",
      );
    },
  });

  pi.registerCommand("trust-reset", {
    description: "Clear the web-content taint and restore privilege escalation",
    handler: async (_args, ctx) => {
      if (!tainted) { ctx.ui.notify("Session is already clean.", "info"); return; }
      const ok = await ctx.ui.confirm(
        "Restore root access to this session?",
        `This session read content from ${tainted.where}.\n\n` +
          `Clearing the taint gives the model sudo again while that content is ` +
          `still in its context. Only do this if you have looked at what came ` +
          `back and are satisfied it was not trying to steer the agent.\n\n` +
          `Starting a fresh session is the safer option and costs only the context.`,
      );
      if (!ok) { ctx.ui.notify("Taint left in place.", "info"); return; }
      tainted = null;
      ctx.ui.notify("Taint cleared — privilege escalation allowed again.", "warning");
    },
  });
}
