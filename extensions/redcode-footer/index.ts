// redcode-footer — the whole dock below the command line, in two lines.
//
// WHY REPLACE pi's FOOTER AT ALL. The one fact worth a glance mid-session is
// how full the context is, and pi renders it as "1.4%/205k" in the middle of a
// run of `·`-separated text. A proportion answers "how close to the edge"
// instantly; a percentage buried in a sentence does not. Once you are drawing
// a bar you have to own the line, because the alternative is the same number
// rendered twice, in two roundings, updated on two timers — which is worse
// than either alone.
//
// THE LAYOUT. Two lines, each with a left half and a right half:
//
//   PLAN  (ninfer) qwen3.8-27b · xhigh                    ctx ▕████████░░▏ 199k/205k
//   ~/code/thing (main) · ↑13.2M ↓102k          134 tok/s · ttft 17.4s · 5.5k out
//
// The organising rule is STANDING STATE RIGHT, IDENTITY LEFT. The right column
// is quantities against limits, always in the same place, so the eye lands on
// them without reading. The left column is who and where, which you read once
// and then ignore. Line 1 is what is true now; line 2 is where you are and
// what the last turn did.
//
// WHAT MUST NOT BE LOST. pi's own footer renders the cwd/branch line, the
// stats line, and — easy to miss — the EXTENSION STATUS LINE
// (`footerData.getExtensionStatuses()`), which is where redcode-status
// publishes tok/s and ttft, and where the mode indicator publishes. A
// replacement that drops it makes those vanish with no error at all, and the
// obvious conclusion is "the status extension broke". All of it is reproduced
// here; that is most of why this file is longer than the layout suggests.
//
// NO VRAM GAUGE, unlike the localops footer this is ported from. That bar is
// scaled to a watchdog kill line on the machine running the model. A guest's
// GPU is not doing the work, so the honest version of that gauge for a remote
// endpoint is no gauge.
//
// NO CACHE SEGMENTS. pi's stock footer can show R/W/CH ratios from
// prompt_tokens_details.cached_tokens. Many OpenAI-compatible servers never
// send that field, and rendering "CH 0.0%" against an engine that is in fact
// hitting its prefix cache is worse than silence — it is a confident wrong
// answer about the thing you would be checking.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fitCells, fmt, gauge, lay, num, truncate, visibleWidth } from "./format.ts";

export default function (pi: ExtensionAPI) {
  let ctxRef: any = null;
  let installed = false;

  const buildFooter = (_tui: any, theme: any, footerData: any) => ({
    render(width: number): string[] {
      const t = theme;
      const model = ctxRef?.model;

      // ---- left 1: mode chip, then who is answering ---------------------
      const statuses: Map<string, string> = new Map(
        (footerData?.getExtensionStatuses?.() as Map<string, string>) ?? [],
      );
      // The mode is behavioural, not telemetry: in plan or discussion mode the
      // agent will not touch the disk, and that belongs at the start of the
      // line rather than sorted into the middle of a throughput readout.
      const mode = statuses.get("mode");
      statuses.delete("mode");

      const l1: string[] = [];
      if (mode) l1.push(t.fg("warning", mode));
      if (model) {
        const provider = model.provider ? `(${model.provider}) ` : "";
        l1.push(t.fg("accent", `${provider}${model.id}`));
        if (model.reasoning) {
          const level = ctxRef?.thinkingLevel ?? "off";
          // pi themes carry a colour per thinking level; using it makes the
          // level readable as a level rather than as one more word.
          const key = `thinking${level.charAt(0).toUpperCase()}${level.slice(1)}`;
          l1.push(level === "off" ? t.fg("dim", "thinking off") : t.fg(key, level));
        }
      }
      const left1 = l1.join(t.fg("dim", " · "));

      // ---- right 1: standing state, as a bar ----------------------------
      // The context window may be unknown: an OpenAI-compatible /v1/models
      // says nothing about it, so redcode-connect's catalog supplies it and a
      // model outside that table has none. No window means no gauge, rather
      // than a bar drawn against a number nobody stands behind.
      const usage = ctxRef?.getContextUsage?.();
      const win = usage?.contextWindow ?? model?.contextWindow ?? 0;
      const ctxTokens = usage?.tokens ?? null;
      const ctxFrac = win && ctxTokens !== null ? ctxTokens / win : Number.NaN;
      const ctxValue = win ? `${ctxTokens === null ? "?" : fmt(ctxTokens)}/${fmt(win)}` : "";

      const gauges: Array<{ label: string; frac: number; value: string }> = [];
      if (ctxValue) gauges.push({ label: "ctx", frac: ctxFrac, value: ctxValue });

      // Fixed cost of the right half = labels, brackets, values, separators.
      const fixed =
        gauges.reduce((n, g) => n + g.label.length + 1 + 1 + g.value.length, 0) +
        Math.max(0, gauges.length - 1) * 2;
      const cells = fitCells(visibleWidth(left1), fixed, gauges.length, width);

      const right1 = gauges
        .map((g) =>
          // Below the narrowest bar the bars are dropped and the bare numbers
          // kept: the figure is the part that matters, the bar is the part
          // that makes it scannable.
          cells > 0
            ? gauge(t, g.label, g.frac, g.value, cells)
            : t.fg("dim", `${g.label} `) + t.fg("muted", g.value),
        )
        .join("  ");

      // ---- left 2: where am I, and what this session has cost ------------
      let pwd = ctxRef?.cwd ?? process.cwd();
      const home = process.env.HOME ?? process.env.USERPROFILE;
      if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;
      const branch = footerData?.getGitBranch?.();
      if (branch) pwd = `${pwd} (${branch})`;
      const name = ctxRef?.sessionManager?.getSessionName?.();
      if (name) pwd = `${pwd} • ${name}`;

      // Cumulative session tokens: a running total of what was PUT ON THE
      // WIRE, which counts every re-sent prompt as fresh input. It is not a
      // measure of cache health and should not be read as one.
      const totals = { input: 0, output: 0, cost: 0 };
      try {
        for (const e of ctxRef?.sessionManager?.getEntries?.() ?? []) {
          const u =
            e.type === "message"
              ? e.message?.usage
              : e.type === "branch_summary" || e.type === "compaction"
                ? e.usage
                : undefined;
          if (!u) continue;
          totals.input += num(u.input);
          totals.output += num(u.output);
          totals.cost += num(u.cost);
        }
      } catch {
        /* session shape changed — degrade to no totals, never throw */
      }

      const l2 = [t.fg("dim", pwd)];
      const wire: string[] = [];
      if (totals.input) wire.push(`↑${fmt(totals.input)}`);
      if (totals.output) wire.push(`↓${fmt(totals.output)}`);
      // Number() again at the point of use, not just at accumulation. A footer
      // renders on a timer, so anything it throws is an uncaught exception in a
      // Timeout callback — which kills pi outright rather than blanking a line.
      if (Number.isFinite(totals.cost) && totals.cost > 0) {
        wire.push(`$${Number(totals.cost).toFixed(3)}`);
      }
      if (wire.length) l2.push(t.fg("borderMuted", wire.join(" ")));
      const left2 = l2.join(t.fg("borderMuted", " · "));

      // ---- right 2: what the last turn did -------------------------------
      const right2 = Array.from(statuses.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, text]) => text)
        .filter((text) => text && text.length > 0)
        .join(t.fg("dim", " · "));

      return [
        truncate(lay(left1, right1, width), width),
        truncate(lay(left2, right2, width), width),
      ];
    },
    invalidate() {},
  });

  const keep = async (_e: any, ctx: any) => {
    ctxRef = ctx ?? ctxRef;
    // TUI only: setFooter is meaningless in rpc/json/print modes.
    if (!installed && ctx?.ui?.setFooter && ctx.mode === "tui") {
      installed = true;
      ctx.ui.setFooter(buildFooter);
    }
  };

  pi.on("session_start", keep);
  pi.on("model_select", keep as any);
  pi.on("turn_end", keep as any);
  pi.on("turn_start", keep as any);

  // Escape hatch: if this footer ever misbehaves mid-session, get pi's back
  // without editing files or restarting.
  pi.registerCommand("footer", {
    description: "Toggle between the redcode footer and pi's built-in one",
    handler: async (args: string, ctx: any) => {
      if (args.trim() === "default") {
        ctx.ui.setFooter(undefined);
        ctx.ui.notify(
          "restored pi's built-in footer (reload pi to get the redcode one back)",
          "info",
        );
      } else {
        ctx.ui.notify("usage: /footer default   — restores pi's built-in footer", "info");
      }
    },
  });
}
