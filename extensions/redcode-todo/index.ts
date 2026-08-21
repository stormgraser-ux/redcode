// redcode-todo — a visible plan checklist whose steps cannot silently move.
//
// Modelled on Claude Code's TodoWrite: the user sees where the model is in its
// plan at a glance, and the plan survives compaction.
//
// The interesting part is reconcile.ts. The tool takes the WHOLE list on every
// update (a 27B cannot track numeric ids reliably), but whole-list restatement
// invites drift — reworded steps, dropped steps, invented steps. So authority
// is split: the model owns STATUS, the extension owns TEXT, ORDER and
// MEMBERSHIP. Drift is repaired, reported back to the model, and surfaced to
// the user. `revise: true` is the explicit escape hatch for real replanning.
//
// Two further decisions:
//
// STATE LIVES IN TOOL-RESULT DETAILS, not a file. Rebuilt by scanning the
// session branch, so /fork and /tree land on the correct plan for that point in
// history. Reading getBranch() (raw) rather than buildContextEntries()
// (compaction-applied) is what makes it survive compaction.
//
// THE PLAN REMINDER IS OFF BY DEFAULT, AND THAT IS A CORRECTNESS FIX.
//
// This extension used to append a `<plan>` block to the last message on every
// request. The reasoning was that a trailing append costs no cache. THAT WAS
// WRONG, and it cost ~70s of TTFT per turn on NInfer (measured 2026-08-15:
// every request after the first `todo` call fell back to
// `reuse=restore_turn_checkpoint`, re-prefilling ~64K of a 77K prompt).
//
// The mechanism: the reminder is injected at request time and never persisted
// (grep a session file for `<plan>` — zero hits). So on turn N the tail message
// goes over the wire WITH the block, and on turn N+1 that same message, now
// mid-history, goes WITHOUT it. Every turn silently rewrites history.
//
// Why NInfer punishes this so hard: it does not truncate its KV cache to an
// arbitrary common prefix. It either extends the exact frontier
// (`append_frontier`, ~400ms) or falls back to the last saved turn checkpoint —
// which in practice sat at 12,901 tokens and never advanced. There is no middle
// ground, so ANY per-request mutation of the conversation, at the tail or not,
// is a cliff rather than a slope. The same is true of a new trailing message,
// which is why moving the reminder rather than removing it does not help.
//
// It is not needed anyway: the `todo` tool result is already in history
// verbatim, and calling `todo` again appends a fresh copy at the frontier,
// which is cache-free by construction.
//
// Set REDCODE_TODO_REMINDER=1 to restore the old behaviour on a backend that
// truncates to a common prefix (llama.cpp does). Do not set it for NInfer.

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { driftSummary, reconcile, type Item, type Status } from "./reconcile.ts";
import { appendNudge, planNudge, type NudgeState } from "./nudge.ts";
import { env } from "node:process";

/** See the header: injecting this costs a full re-prefill on NInfer. */
const REMINDER = env.REDCODE_TODO_REMINDER === "1";

interface Details {
  todos: Item[];
  nextId: number;
}

const Params = Type.Object({
  todos: Type.Array(
    Type.Object({
      text: Type.String({ description: "Short imperative description of the step" }),
      status: StringEnum(["pending", "in_progress", "completed"] as const),
    }),
    { description: "The COMPLETE plan, every step, with each step's current status." },
  ),
  revise: Type.Optional(
    Type.Boolean({
      description:
        "Set true ONLY to deliberately replace the plan because the approach changed. " +
        "Normal progress updates must leave this unset: step wording and order are " +
        "preserved automatically, so restating them imperfectly is harmless.",
    }),
  ),
});

const MARK: Record<Status, string> = { pending: "○", in_progress: "◐", completed: "✓" };
const COLOUR: Record<Status, string> = { pending: "dim", in_progress: "warning", completed: "success" };

export default function (pi: ExtensionAPI) {
  let todos: Item[] = [];
  let nextId = 1;
  // Every drift note this session, so the widget's badge is inspectable via
  // /todos. A count alone tells you something was repaired but not what, which
  // is the one thing you actually want to know when you see the warning.
  const driftLog: string[] = [];

  const rebuild = (ctx: ExtensionContext) => {
    todos = [];
    nextId = 1;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const msg: any = entry.message;
      if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;
      const d = msg.details as Details | undefined;
      if (d?.todos) { todos = d.todos; nextId = d.nextId ?? todos.length + 1; }
    }
  };

  const paint = (ctx: any) => {
    if (!ctx.hasUI) return;
    if (todos.length === 0) { ctx.ui.setWidget("todo", undefined); return; }
    const t = ctx.ui.theme;
    const done = todos.filter((i) => i.status === "completed").length;
    const header =
      t.fg("accent", "  Plan  ") +
      t.fg("dim", `${done}/${todos.length}`) +
      (driftLog.length
        ? t.fg("warning", `  ⚠ ${driftLog.length} drift repaired`) + t.fg("dim", " (/todos)")
        : "");
    ctx.ui.setWidget("todo", [
      header,
      ...todos.map((i) =>
        `  ${t.fg(COLOUR[i.status], MARK[i.status])} ` +
        (i.status === "completed" ? t.fg("dim", i.text) : t.fg("text", i.text))),
    ]);
  };

  const asText = () =>
    todos
      .map((i) => `[${i.status === "completed" ? "x" : i.status === "in_progress" ? "~" : " "}] ${i.text}`)
      .join("\n");

  pi.on("session_start", async (_e, ctx) => { rebuild(ctx); paint(ctx); });
  pi.on("session_tree", async (_e, ctx) => { rebuild(ctx); paint(ctx); });

  // Opt-in only. See the header: this rewrites history every turn.
  pi.on("context", async (event: any) => {
    if (!REMINDER) return;
    if (todos.length === 0) return;
    if (!todos.some((i) => i.status !== "completed")) return;

    const messages = event.messages;
    const last = messages[messages.length - 1];
    if (!last) return;

    // Skip when the last message is the todo tool's own result: the plan is
    // already verbatim in that text.
    if (last.role === "toolResult" && (last as any).toolName === "todo") return;

    const reminder = `\n\n<plan>\n${asText()}\n</plan>`;
    if (typeof last.content === "string") {
      last.content += reminder;
    } else if (Array.isArray(last.content)) {
      const lastText = [...last.content].reverse().find((b: any) => b?.type === "text");
      if (lastText) lastText.text += reminder;
      else last.content.push({ type: "text", text: reminder });
    } else {
      return;
    }
    return { messages };
  });

  pi.registerTool({
    name: "todo",
    label: "Plan",
    description:
      "Record or update the plan for a multi-step task. Send the COMPLETE list every " +
      "time with each step's current status; exactly one step should be in_progress. " +
      "Step wording and order are preserved by the harness, so you cannot corrupt the " +
      "plan by restating it imperfectly. Set revise:true only to deliberately replan.",
    promptSnippet: "Track a multi-step plan the user can see",
    promptGuidelines: [
      "Use todo at the start of any task needing more than two steps, and update it as each step completes.",
      "When calling todo, send the entire plan, not only the steps that changed.",
    ],
    parameters: Params,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const before = todos.length;
      const r = reconcile(todos, params.todos as any, nextId, params.revise === true);
      todos = r.items;
      nextId = r.nextId;

      const notes = driftSummary(r.drift);
      driftLog.push(...notes);
      paint(ctx);

      if (notes.length && ctx.hasUI) {
        ctx.ui.notify(`Plan drift repaired: ${notes.length} change(s) rejected`, "warning");
      }

      const done = todos.filter((i) => i.status === "completed").length;
      let text = `Plan updated (${done}/${todos.length} complete):\n${asText()}`;
      if (notes.length) {
        // Tell the model what was rejected, so it stops re-sending the drifted
        // version on the next update instead of fighting the harness.
        text +=
          `\n\nNOTE — the plan is authoritative and was preserved:\n` +
          notes.map((n) => `- ${n}`).join("\n") +
          `\nUse the wording above from now on. If the plan genuinely needs to change, call todo again with revise:true.`;
      }
      if (params.revise === true && before > 0) text += `\n\n(Plan was explicitly revised.)`;

      return { content: [{ type: "text", text }], details: { todos: [...todos], nextId } as Details };
    },
  });

  // ---------------------------------------------------------- the plan nudge
  //
  // THE PROBLEM. Measured 2026-08-18 on a live 12-step implementation session:
  // the model called `todo` ONCE (step 1 in_progress, 11 pending) and then ran
  // 71 more tool calls — 21 write, 20 bash, 8 edit — without touching it again.
  // The widget honestly read 0/12 while the work was on step 4. With REMINDER
  // off there is nothing pulling the model back to the tool except one line of
  // promptGuidelines, which loses against 70 tool calls of momentum.
  //
  // WHY THIS IS CACHE-SAFE AND THE OLD REMINDER WAS NOT. The `context` hook
  // above mutates a message that ALREADY EXISTS in history, at request time,
  // and the mutation is never persisted — so turn N sends that message with the
  // block and turn N+1 sends the same message without it. Every turn rewrites
  // history, and NInfer answers that with a full re-prefill (~70s, see header).
  //
  // A `tool_result` hook is a different animal. Its return value REPLACES the
  // content before the message is built, so the appended text is what gets
  // WRITTEN TO HISTORY — verified at agent-session.js:258,
  // `const content = hookResult?.content ?? result.content ?? []`. It is
  // written once, at the frontier, and every later turn sends those exact same
  // bytes. Nothing upstream of it changes. That is the identical property that
  // makes a fresh `todo` call free, and it is why this does not touch the
  // prefix cache.
  //
  // The rule to preserve if this is ever edited: only ever append to the tool
  // result being generated RIGHT NOW. The moment this reaches backwards for an
  // earlier message, it becomes the thing that cost 70s a turn.
  const NUDGE_AFTER = Number(env.REDCODE_TODO_NUDGE_AFTER ?? 10);
  const nudgeState: NudgeState = { since: 0 };

  pi.on("tool_result", (event: any) => {
    const nudge = planNudge(todos, event.toolName, nudgeState, NUDGE_AFTER);
    if (!nudge) return;
    return { content: appendNudge(event.content, nudge) as any };
  });

  pi.registerCommand("todos", {
    description: "Show the current plan",
    handler: async (_args, ctx) => {
      if (todos.length === 0) { ctx.ui.notify("No plan recorded.", "info"); return; }
      ctx.ui.notify(
        asText() +
          (driftLog.length
            ? `\n\nDrift repaired this session (${driftLog.length}):\n` +
              driftLog.map((n) => `  - ${n}`).join("\n")
            : ""),
        "info",
      );
    },
  });
}
