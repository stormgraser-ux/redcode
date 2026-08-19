// redcode-modes — normal / discussion / plan, on shift+tab.
//
// WHAT THIS REPLACES. shift+tab was `app.thinking.cycle`. Reasoning effort now
// lives on /effort only, and the key drives the mode cycle instead. The
// built-in binding is ALSO unbound in ~/.pi/agent/keybindings.json — not
// because it has to be (pi checks extension shortcuts first, see
// custom-editor.js:26 "Check extension-registered shortcuts first"), but so the
// key does nothing surprising in a context where this extension is not loaded.
//
// THE THREE MODES
//
//   normal    stock pi. Every tool, no added instructions.
//   discuss   read-only, and told to argue rather than deliver. No plans.
//   plan      read-only, and told to investigate, then ASK about the judgement
//             calls, then submit a plan for approval.
//
// The interesting one is plan mode's middle phase. Codex's plan mode is good
// because it interrogates the user at exactly the points where taste decides
// the answer, instead of guessing and presenting the guess as a decision. That
// is the `ask_user` tool: the model batches its genuine forks, each becomes a
// real terminal dialog, and the answers come back as a tool result before the
// plan is written.
//
// HOW MODE RULES REACH THE MODEL. Appended to the system prompt via
// `before_agent_start`, which hands us the freshly assembled base every turn —
// so appending does not compound across turns.
//
// This is deliberately NOT done by injecting a block into the conversation.
// redcode-todo's header documents what that costs: per-request history
// mutation drops NInfer from `append_frontier` (~400ms) to a turn checkpoint,
// which measured ~70s of TTFT per turn. The system prompt is a stable prefix
// *within* a mode, so it is free; switching modes invalidates the KV cache
// once, which is the honest price of changing the rules mid-session. Cycle
// modes between tasks, not between turns of one task.
//
// ENFORCEMENT IS TWO-LAYER. `setActiveTools` removes edit/write from the prompt
// entirely (the model cannot call what it cannot see), and a `tool_call`
// handler blocks them anyway in case a tool arrives from somewhere else.
//
// KNOWN GAP: `bash` stays available in discuss and plan, because taking it away
// guts investigation — no git log, no npm ls, no rg. It is instructed to be
// read-only, not forced. Blast radius is owned by redcode-blast-radius, which
// is the right place for it; this extension does not second-guess that.

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MODE_CYCLE, MODE_LABEL, modeInstructions, type Mode } from "./prompts.ts";

/** Built-ins withheld in discuss and plan. `bash` is deliberately not here. */
const MUTATING = new Set(["edit", "write"]);

/** Registered only for plan mode; inert everywhere else. */
const PLAN_TOOLS = ["ask_user", "present_plan"];

const FREE_TEXT = "Something else (type it)";

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "plan"
  );
}

/**
 * Drop a leading `# …` from the plan body.
 *
 * The file is written as `# ${title}` followed by the body, and models
 * reliably open the body with their own H1 too — so the first plan on disk
 * carried two stacked headings. The `title` argument wins because it is what
 * names the file and what the approval dialog showed; the body's is the
 * duplicate. Only a FIRST-line H1 is removed, so a plan that legitimately
 * starts with prose and uses `#` later is untouched.
 */
function stripLeadingH1(body: string): string {
  const text = body.replace(/^\s+/, "");
  if (!/^#\s+\S/.test(text)) return text;
  const nl = text.indexOf("\n");
  // A body that is ONLY a heading leaves nothing behind — guard the -1, which
  // would otherwise slice(0) and hand the duplicate straight back.
  return nl === -1 ? "" : text.slice(nl + 1).replace(/^\s+/, "");
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export default function (pi: ExtensionAPI) {
  let mode: Mode = "normal";
  let cwd = process.cwd();

  // Set when the user picks "clear context, then implement". The dialog runs
  // inside a TOOL, whose ExtensionContext has no newSession() — only a COMMAND
  // context does. So the choice is parked here and replayed as a command once
  // the agent settles.
  let pendingFreshStart: string | undefined;

  /** Tool names this extension is responsible for switching on and off. */
  const managed = () => new Set([...MUTATING, ...PLAN_TOOLS]);

  function applyTools(): void {
    const active = new Set(pi.getActiveTools());
    const all = new Set(pi.getAllTools().map((t) => t.name));

    // Start from "everything this extension manages is off", then switch on
    // what the current mode is entitled to. Tools we do not manage are left
    // exactly as they are — redcode-mcp owns its own names and must not be
    // clobbered here.
    for (const name of managed()) active.delete(name);

    if (mode === "normal") {
      for (const name of MUTATING) if (all.has(name)) active.add(name);
    } else if (mode === "plan") {
      for (const name of PLAN_TOOLS) if (all.has(name)) active.add(name);
    }

    pi.setActiveTools([...active]);
  }

  function paint(ctx: ExtensionContext): void {
    ctx.ui.setStatus("mode", mode === "normal" ? undefined : MODE_LABEL[mode]);
  }

  function setMode(next: Mode, ctx: ExtensionContext, announce = true): void {
    mode = next;
    applyTools();
    paint(ctx);
    if (announce) {
      ctx.ui.notify(
        `mode: ${MODE_LABEL[mode]}${mode === "normal" ? "" : " — edits are off"}`,
        "info",
      );
    }
  }

  // ---------------------------------------------------------------- mode rules

  pi.on("before_agent_start", (event) => {
    const block = modeInstructions(mode);
    if (!block) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
  });

  // Backstop for the withheld tools. setActiveTools already keeps these out of
  // the prompt; this catches a call arriving by any other route.
  pi.on("tool_call", (event) => {
    if (mode === "normal") return;
    if (!MUTATING.has(event.toolName)) return;
    return {
      block: true,
      reason:
        `${MODE_LABEL[mode]} mode does not edit files. ` +
        (mode === "plan"
          ? "Finish investigating and call present_plan instead."
          : "Say what you would change and why; the user will switch modes if they want it done."),
    };
  });

  // ------------------------------------------------------------------- binding

  pi.registerShortcut("shift+tab", {
    description: "Cycle mode (normal / discussion / plan)",
    handler: (ctx) => {
      const next = MODE_CYCLE[(MODE_CYCLE.indexOf(mode) + 1) % MODE_CYCLE.length];
      setMode(next, ctx);
    },
  });

  pi.registerCommand("mode", {
    description: "Show or set the mode (normal / discuss / plan)",
    getArgumentCompletions: (prefix: string) => {
      const hits = MODE_CYCLE.filter((m) => m.startsWith(prefix));
      return hits.length > 0 ? hits.map((m) => ({ value: m, label: MODE_LABEL[m] })) : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const want = args.trim().toLowerCase();
      if (!want) {
        ctx.ui.notify(`mode: ${MODE_LABEL[mode]}`, "info");
        return;
      }
      const found = MODE_CYCLE.find((m) => m === want || MODE_LABEL[m] === want);
      if (!found) {
        ctx.ui.notify(`mode: unknown '${want}' — use ${MODE_CYCLE.join(", ")}`, "error");
        return;
      }
      setMode(found, ctx);
    },
  });

  // -------------------------------------------------------- plan mode: asking

  const AskParams = Type.Object({
    questions: Type.Array(
      Type.Object({
        question: Type.String({ description: "The decision, as a direct question." }),
        options: Type.Array(Type.String(), {
          description:
            "2-4 concrete alternatives with different consequences. Say what each implies.",
        }),
      }),
      { description: "Every question you need answered, asked in one batch." },
    ),
  });

  pi.registerTool({
    name: "ask_user",
    label: "Ask",
    description:
      "Ask the user to settle the judgement calls in a plan, in one batch, before writing " +
      "it. Only for forks where different answers produce materially different plans AND " +
      "you cannot settle it from the code or the stated goal. Never for permission to " +
      "proceed. Returns the user's choices.",
    promptSnippet: "Ask the user to settle a design decision",
    parameters: AskParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const questions = params.questions as { question: string; options: string[] }[];
      if (!ctx.hasUI) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "No interactive UI is available, so the user cannot be asked. Decide these " +
                "yourself, state each assumption explicitly in the plan, and continue.",
            },
          ],
          isError: true,
        };
      }
      if (questions.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No questions asked. Continue." }],
          isError: true,
        };
      }

      const lines: string[] = [];
      for (const [i, q] of questions.entries()) {
        const title = `(${i + 1}/${questions.length}) ${q.question}`;
        const choice = await ctx.ui.select(title, [...q.options, FREE_TEXT]);

        if (choice === undefined) {
          lines.push(`Q: ${q.question}\nA: [skipped — use your own judgement and say so]`);
          continue;
        }
        if (choice === FREE_TEXT) {
          const typed = await ctx.ui.input(q.question, "your answer");
          lines.push(`Q: ${q.question}\nA: ${typed?.trim() || "[skipped]"}`);
          continue;
        }
        lines.push(`Q: ${q.question}\nA: ${choice}`);
      }

      return {
        content: [
          {
            type: "text" as const,
            text:
              `The user answered:\n\n${lines.join("\n\n")}\n\n` +
              "Treat these as decided. Reflect them in the plan and do not re-ask.",
          },
        ],
      };
    },
  });

  // ----------------------------------------------------- plan mode: submitting

  const PlanParams = Type.Object({
    title: Type.String({ description: "Short title for the plan, a few words." }),
    plan: Type.String({
      description:
        "The complete plan as markdown: Goal, Approach, Steps, Verification, Risks.",
    }),
  });

  pi.registerTool({
    name: "present_plan",
    label: "Plan",
    description:
      "Submit a finished plan for the user's approval. Call this only after investigating " +
      "and after settling the judgement calls with ask_user. Writes the plan to disk and " +
      "asks the user what to do with it.",
    promptSnippet: "Submit a plan for approval",
    parameters: PlanParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const title = String(params.title);
      const body = String(params.plan);

      // On disk BEFORE the dialog: "clear context and implement" throws away
      // the conversation, so the plan has to survive outside it.
      const dir = join(cwd, ".pi", "plans");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${stamp()}-${slugify(title)}.md`);
      writeFileSync(path, `# ${title}\n\n${stripLeadingH1(body)}\n`);

      if (!ctx.hasUI) {
        return {
          content: [
            { type: "text" as const, text: `Plan written to ${path}. No UI to approve it.` },
          ],
        };
      }

      const IMPLEMENT = "Implement it now";
      const FRESH = "Clear context, then implement";
      const REVISE = "Revise the plan";
      const REJECT = "Reject the plan";

      const choice = await ctx.ui.select(`Plan ready: ${title}`, [
        IMPLEMENT,
        FRESH,
        REVISE,
        REJECT,
      ]);

      if (choice === IMPLEMENT) {
        setMode("normal", ctx, false);
        ctx.ui.notify(`mode: normal — implementing ${title}`, "info");
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Plan approved and saved to ${path}. Edits are enabled again. ` +
                "Implement it now, following the steps in order.",
            },
          ],
        };
      }

      if (choice === FRESH) {
        pendingFreshStart = path;
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Plan approved and saved to ${path}. The user wants it implemented in a ` +
                "fresh session. Stop here and say nothing further — the handover is automatic.",
            },
          ],
        };
      }

      if (choice === REVISE) {
        const notes = await ctx.ui.input("What should change?", "your revisions");
        return {
          content: [
            {
              type: "text" as const,
              text: notes?.trim()
                ? `The user wants changes before approving:\n\n${notes.trim()}\n\n` +
                  "Revise the plan and call present_plan again. Still in plan mode — no edits."
                : "The user wants changes but did not say what. Ask them what to change.",
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Plan rejected (kept at ${path} for reference). Do not implement it. ` +
              "Ask the user what they want instead.",
          },
        ],
      };
    },
  });

  // ------------------------------------------------- the fresh-session handover
  //
  // newSession() is only on a COMMAND context, and a tool never gets one. So the
  // tool parks the choice and we replay it here as a real command invocation
  // once the agent has settled.

  pi.on("agent_settled", () => {
    if (!pendingFreshStart) return;
    const path = pendingFreshStart;
    pendingFreshStart = undefined;
    pi.sendUserMessage(`/plan-go ${path}`, { expandPromptTemplates: true });
  });

  pi.registerCommand("plan-go", {
    description: "Start a fresh session that implements a saved plan",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const path = args.trim();
      if (!path) {
        ctx.ui.notify("plan-go: needs a plan file path", "error");
        return;
      }
      // Everything that touches the OLD ctx must happen before newSession().
      // Afterwards this ctx is dead: pi throws "This extension ctx is stale
      // after session replacement or reload" for any use of a captured ctx
      // once the session has been replaced — including a harmless-looking
      // ui.notify inside withSession. Post-replacement work uses `fresh`.
      setMode("normal", ctx, false);
      ctx.ui.notify(`plan-go: starting a fresh session for ${path}`, "info");

      await ctx.newSession({
        withSession: async (fresh) => {
          fresh.ui.notify(`plan-go: implementing ${path}`, "info");
          await fresh.sendUserMessage(
            `Implement the approved plan at \`${path}\`.\n\n` +
              "Read it first. It was written with full knowledge of this repository and " +
              "the user has already approved it, so follow it rather than re-planning. " +
              "If a step turns out to be wrong once you are in the code, say so and stop " +
              "rather than silently improvising.",
          );
        },
      });
      // No reporting on the result here — if newSession() succeeded, `ctx` is
      // stale and touching it throws. A cancelled switch leaves the old session
      // in place with the plan still on disk, which the notify above already
      // named.
    },
  });

  // ------------------------------------------------------------------ lifecycle

  pi.on("session_start", (_e, ctx) => {
    cwd = ctx.cwd ?? process.cwd();
    mode = "normal";
    applyTools();
    paint(ctx);
  });
}
