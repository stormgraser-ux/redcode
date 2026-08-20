// redcode-btw — a quick side question that never touches the main conversation.
//
//   /btw <question>   asks the model a one-shot side question using the current
//                     session's effective context, streams the answer into a
//                     pinned overlay (esc closes it; esc while it is still
//                     streaming cancels the side call), and records the Q&A as
//                     a persistent transcript entry. The question and answer
//                     never enter the main LLM conversation history.
//   /btw              re-shows the most recent side Q&A in a dismissible panel.
//
// Why it is shaped the way it is (the non-obvious parts):
//
//  * Warm prefix — and what it actually buys. The side request re-derives the
//    EXACT prefix the main session last sent — ctx.getSystemPrompt() (the final
//    chained prompt), the wire messages (convertToLlm over the session context),
//    and the active tools in agent-state order. NInfer caches on the rendered
//    token prefix PER LANE: it reuses the retained KV of the lane the request is
//    admitted to (verified in request_plan_impl.h — prefix_matches is only ever
//    run against sequences[lane]). Consequence, measured against the live
//    engine (qwen3.8-27b-nvfp4, ~110K context):
//      - Between turns (main turn idle, its lane Complete + retained): the side
//        call is admitted to that lane and APPENDS at its frontier — warm hit,
//        96-99% cached, TTFT ~0.5-1.5s (the "restore_response_checkpoint" /
//        "append_frontier" paths in the request log). Same client, keep-alive
//        connection: confirmed 62.3% cached on a synthetic A→B pair.
//      - Mid-turn (main turn Active on lane 0, concurrency 2): the side call
//        MUST take the free lane 1, which has no retained KV → COLD prefill of
//        the whole shared prefix at ~6.5K tok/s (~6s @40K, ~17s @110K). It still
//        runs concurrently with the main turn (that is the point of concurrency
//        2) and its answer is still correct — it just pays the cold prefill.
//    Either way the side answer stays OUT of the main history (see below).
//
//  * Matching thinking level. NInfer's Qwen template renders level-specific
//    reasoning instructions into the head of the system block (low → one string,
//    xhigh → another, medium/off → nothing). A side call at a different level
//    diverges near token 0 and re-prefills everything — slower than just
//    thinking — so the side call reuses the session's current level.
//
//  * Tools stay in the prompt. tool_choice:"none" would STRIP the tools block
//    from the rendered prompt (NInfer's uses_tools() is false for it), breaking
//    the prefix. So tool_choice is left at its default (auto) and the no-tools
//    behaviour comes from an explicit instruction in the question plus the fact
//    that the side call has no tool executor — nothing can run even if the model
//    emits a call.
//
//  * Not a side session. There is no second pi session and nothing to unload:
//    one provider stream, disposed when done. The engine's shared KV pool LRU-
//    evicts the side tail on its own. The answer persists as a CUSTOM ENTRY
//    (appendEntry), which sessionEntryToContextMessages maps to [] — a storage
//    entry that never re-enters LLM context.
//
//  * The answer is an overlay, not output — and the ONLY visible output. The
//    entry above is the durable record, deliberately invisible: no entry
//    renderer is registered for CUSTOM_TYPE, so pi's addCustomEntryToChat
//    skips it (it early-returns when no renderer is registered — no raw-JSON
//    fallback). The thing you READ is a pinned overlay (ui.custom with
//    overlay:true), composited on top of the streaming output by the TUI. A
//    transcript line zips away under a fast main stream before it can be read;
//    the overlay stays in place until dismissed. It CAPTURES keyboard focus
//    while open (TUI.showOverlay focuses it), so esc reaches the overlay's
//    handler — not the editor's esc, which would abort the MAIN turn. Esc
//    therefore cancels the side call while it is still streaming and just
//    closes the panel once the answer (or an error) is on screen. pi's TUI
//    renders event-driven with no animation loop, so the overlay runs its own
//    100 ms timer to animate the spinner and keep the panel alive through a
//    silent cold prefill (up to ~17 s mid-turn at 110K context).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { Box, Text, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  type BtwData,
  extractAnswer,
  hasToolCall,
  sideQuestionText,
  toolRefusalNote,
  truncate,
} from "./side.ts";

const CUSTOM_TYPE = "redcode-btw";

// Bound the side answer. On the engine, thinking and the answer share this
// budget, so leave room for both at the (matched) thinking level.
const SIDE_MAX_TOKENS = 8192;

// Overlay geometry, resolved by the TUI against the live terminal size.
// Percentages keep it proportioned on any terminal; the absolute row cap in
// BtwOverlay keeps it from dominating a very tall one.
const OVERLAY_WIDTH = "90%";
const OVERLAY_MAX_HEIGHT = "70%";
const OVERLAY_MAX_ROWS = 36;

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Phases of a side call, mirrored into the overlay as it progresses. */
type BtwPhase = "waiting" | "streaming" | "done" | "error";

/** Mutable state shared by the stream handler and the overlay component. */
interface BtwOverlayState {
  title: string;
  question: string;
  model: string;
  ts: number;
  phase: BtwPhase;
  answer: string;
  hasThinking: boolean;
  toolCall: boolean;
  errorText?: string;
  /** Abort the in-flight side call (wired by runSide). */
  onCancel?: () => void;
  /** Ask the TUI for a frame (wired by the overlay component). */
  requestRender?: () => void;
}

export default function (pi: ExtensionAPI) {
  // Concurrency guard: one side call at a time. The engine is sized for the main
  // turn plus exactly one side request — a second /btw would be a third.
  let inFlight = false;
  let aborter: AbortController | undefined;
  let overlayClose: (() => void) | undefined;

  function abortInFlight() {
    aborter?.abort();
    aborter = undefined;
    inFlight = false;
    // A session change kills the forked context too — close the panel so it
    // never renders an answer into a different session's TUI.
    const close = overlayClose;
    overlayClose = undefined;
    close?.();
  }

  // UI is optional: --print / headless runs have no TUI, so every ctx.ui call
  // is guarded and falls back to the console.
  function notify(ctx: any, msg: string, type: "info" | "warning" | "error" = "info") {
    if (ctx.hasUI && ctx.ui?.notify) ctx.ui.notify(msg, type);
    else console.error(`btw: ${msg}`);
  }

  // --------------------------------------------------------------- context
  /** The exact prefix the main session last sent to the model. */
  function forkContext(ctx: any) {
    const systemPrompt: string = ctx.getSystemPrompt();
    // buildSessionContext() resolves the compaction-aware messages for the LLM.
    // (It is on the runtime SessionManager but not the Readonly type, hence the
    // cast.) convertToLlm is the core's own AgentMessage→Message transform, so
    // the wire bytes match the main request.
    const messages = convertToLlm(
      (ctx.sessionManager as any).buildSessionContext().messages,
    );
    // Rebuild the active tools in agent-state order so the rendered tools block
    // is byte-identical. getActiveTools() returns names in that order;
    // getAllTools() carries the definitions.
    const names: string[] = pi.getActiveTools();
    const byName = new Map(pi.getAllTools().map((t: any) => [t.name, t]));
    const tools = names
      .map((n) => byName.get(n))
      .filter(Boolean)
      .map((t: any) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));
    return { systemPrompt, messages, tools };
  }

  /** Most recent redcode-btw entry in the session, if any. */
  function findLastBtw(ctx: any): BtwData | undefined {
    const entries: any[] = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.type === "custom" && e.customType === CUSTOM_TYPE && e.data) {
        return e.data as BtwData;
      }
    }
    return undefined;
  }

  // Note: there is deliberately NO entry renderer for CUSTOM_TYPE. The
  // appended entry is storage for the bare /btw re-show (findLastBtw); pi skips
  // custom entries with no registered renderer, so the overlay is the only
  // visible /btw surface (no duplicate copy in the main transcript).

  /**
   * Pinned /btw panel — the reading surface for the side answer (and the bare
   * /btw re-show). Renders from the shared BtwOverlayState on every frame: the
   * TUI re-renders the whole tree each frame and composites the overlay on top
   * of the streaming output, so a fresh Box per frame is the whole mechanism.
   *
   * While the side call is still producing output it runs its own 100 ms
   * timer: pi's TUI has no animation loop (renders are event-driven), so
   * without it the spinner would freeze during a silent cold prefill.
   *
   * Input: the overlay captures focus while open, so handleInput gets every
   * keypress. Esc cancels the side call while it is still streaming and just
   * closes the panel afterwards; enter/space close a finished panel.
   *
   * Delegates rendering to a fresh Box rather than extending Container so the
   * class type-checks even when pi-tui's types are unresolved by the repo lint
   * pass (pi-tui is nested under pi-coding-agent, not a direct dev dep).
   */
  class BtwOverlay {
    private theme: any;
    private done: () => void;
    private state: BtwOverlayState;
    private timer: ReturnType<typeof setInterval> | undefined;
    private disposed = false;

    // Layout, fixed at open time (the TUI resolves overlay size once, when
    // showOverlay is called).
    private innerW: number;
    private headerLines: string[];
    private qLines: string[];
    private bodyBudget: number;
    private wrapMemo = { key: "", visual: [] as string[] };

    constructor(state: BtwOverlayState, theme: any, tui: any, done: () => void) {
      this.state = state;
      this.theme = theme;
      this.done = done;
      const rows = tui?.terminal?.rows ?? 40;
      const cols = tui?.terminal?.columns ?? 120;
      const overlayW = Math.min(Math.floor(cols * 0.9), 150);
      const overlayH = Math.min(Math.floor(rows * 0.7), OVERLAY_MAX_ROWS);
      this.innerW = Math.max(10, overlayW - 4); // Box paddingX 2 either side

      const t = this.theme;
      const stamp = new Date(state.ts).toLocaleTimeString();
      this.headerLines = wrapTextWithAnsi(
        t.fg("accent", state.title + " ") +
          t.fg("dim", `${truncate(state.model, 40)}  ${stamp}`),
        this.innerW,
      );
      this.qLines = wrapTextWithAnsi(
        t.fg("text", t.bold("Q: ") + truncate(state.question, 400)),
        this.innerW,
      );
      // chrome = paddingY 2 + header + Q + separator + footer
      this.bodyBudget = Math.max(
        4,
        overlayH - 4 - this.headerLines.length - this.qLines.length,
      );

      state.requestRender = () => {
        if (!this.disposed) tui?.requestRender?.();
      };
      if (state.phase === "waiting" || state.phase === "streaming") {
        this.timer = setInterval(() => {
          if (this.disposed) return;
          if (this.state.phase === "done" || this.state.phase === "error") {
            this.stopTimer(); // static now — no more repaints needed
            return;
          }
          tui?.requestRender?.(); // spinner + keep the panel alive
        }, 100);
      }
    }

    private stopTimer() {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    }

    /** `text` pre-wrapped to the body width, memoized by (length, width). */
    private visualBody(text: string): string[] {
      const key = text.length + ":" + this.innerW;
      if (this.wrapMemo.key !== key) {
        const visual: string[] = [];
        for (const line of text.replace(/\s+$/, "").split("\n")) {
          for (const v of wrapTextWithAnsi("  " + line, this.innerW)) visual.push(v);
        }
        this.wrapMemo = { key, visual };
      }
      return this.wrapMemo.visual;
    }

    render(width: number): string[] {
      const s = this.state;
      const t = this.theme;
      const box = new Box(2, 1, (x: string) => t.bg("customMessageBg", x));
      for (const line of this.headerLines) box.addChild(new Text(line, 0, 0));
      for (const line of this.qLines) box.addChild(new Text(line, 0, 0));
      box.addChild(new Text(t.fg("dim", "─".repeat(this.innerW)), 0, 0));

      if (s.phase === "error") {
        const visual = this.visualBody(s.errorText ?? "the side call failed");
        const truncated = visual.length > this.bodyBudget;
        if (truncated)
          box.addChild(new Text(t.fg("dim", "  … (showing the end)"), 0, 0));
        const shown = truncated ? visual.slice(-(this.bodyBudget - 1)) : visual;
        for (const line of shown) box.addChild(new Text(t.fg("error", line), 0, 0));
      } else if (s.answer.trim()) {
        // The tail: while streaming this is the live frontier; afterwards it
        // is the end of the answer, which is what conclusions live in.
        const visual = this.visualBody(s.answer);
        const truncated = visual.length > this.bodyBudget;
        if (truncated)
          box.addChild(
            new Text(t.fg("dim", "  … (long answer — showing the end)"), 0, 0),
          );
        const shown = truncated ? visual.slice(-(this.bodyBudget - 1)) : visual;
        for (const line of shown) box.addChild(new Text(t.fg("text", line), 0, 0));
      } else if (s.toolCall) {
        for (const line of wrapTextWithAnsi("  " + toolRefusalNote(), this.innerW)) {
          box.addChild(new Text(t.fg("warning", line), 0, 0));
        }
      } else if (s.phase === "done") {
        box.addChild(new Text(t.fg("dim", "  (no answer)"), 0, 0));
      } else {
        const spin = SPIN[Math.floor(Date.now() / 100) % SPIN.length];
        box.addChild(
          new Text(
            t.fg("dim", `  ${spin} ${s.hasThinking ? "thinking…" : "waiting for first token…"}`),
            0,
            0,
          ),
        );
      }

      const hint =
        s.phase === "done"
          ? "esc / enter to close"
          : s.phase === "error"
            ? "esc to close"
            : "esc to cancel";
      box.addChild(new Text(t.fg("dim", hint), 0, 0));
      return box.render(width);
    }

    invalidate() {
      // Content is rebuilt from state on every frame — nothing to invalidate.
    }

    dispose() {
      this.disposed = true;
      this.stopTimer();
      this.state.requestRender = undefined;
    }

    handleInput(data: string) {
      const s = this.state;
      if (data === "\x1b") {
        // esc: cancel the side call while it is still producing, else just
        // close the panel. (Reaching here at all means the editor's esc —
        // which aborts the MAIN turn — did not.)
        if (s.phase === "waiting" || s.phase === "streaming") s.onCancel?.();
        this.done();
      } else if (
        (data === "\r" || data === " ") &&
        (s.phase === "done" || s.phase === "error")
      ) {
        this.done();
      }
    }
  }

  // -------------------------------------------------------------- side call
  async function runSide(question: string, ctx: any): Promise<void> {
    const model = ctx.model;
    const provider = ctx.modelRegistry.getProvider(model.provider);
    if (!provider || typeof provider.stream !== "function") {
      notify(ctx, "no streamable provider for this model — /btw can't run", "error");
      return;
    }

    // Resolve auth the same way pi's normal request path does. A direct
    // provider.stream() call does NOT pick up the provider's API key on its
    // own, so without this the side call would fail with "No API key".
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth?.ok) {
      notify(ctx, auth?.error ?? "no API key for this model — /btw can't run", "error");
      return;
    }

    inFlight = true;
    aborter = new AbortController();
    const signal = aborter.signal;

    const state: BtwOverlayState = {
      title: "⚡ btw",
      question,
      model: model.id,
      ts: Date.now(),
      phase: "waiting",
      answer: "",
      hasThinking: false,
      toolCall: false,
      onCancel: () => aborter?.abort(),
    };

    // The pinned answer overlay. It captures focus while open, so esc lands in
    // the overlay (cancel / close) and never in the editor's esc handler (which
    // would abort the main turn). Headless runs have no TUI — the console is
    // the surface there.
    let userClose: Promise<void> | undefined;
    if (ctx.hasUI) {
      let closeFn: (() => void) | undefined;
      const myClose = () => closeFn?.();
      overlayClose = myClose;
      const closePromise = ctx.ui.custom(
        (tui: any, theme: any, _kb: any, done: () => void) => {
          closeFn = done;
          return new BtwOverlay(state, theme, tui, done);
        },
        {
          overlay: true,
          overlayOptions: { width: OVERLAY_WIDTH, maxHeight: OVERLAY_MAX_HEIGHT },
        },
      );
      userClose = closePromise;
      // Swallow a rejection here: a factory failure (e.g. the TUI is torn down
      // mid-open) would otherwise be an unhandled rejection, which crashes the
      // process on Node ≥ 15. The `await` below still surfaces it to pi's
      // command-error path if the side call itself reaches the end.
      closePromise
        .finally(() => {
          if (overlayClose === myClose) overlayClose = undefined;
        })
        .catch(() => {});
    }

    const { systemPrompt, messages, tools } = forkContext(ctx);
    const context = {
      systemPrompt,
      // The warm prefix (everything up to here) plus exactly one appended user
      // message — the side question.
      messages: [
        ...messages,
        {
          role: "user",
          content: [{ type: "text", text: sideQuestionText(question) }],
          timestamp: Date.now(),
        },
      ],
      tools,
    };

    let stopReason: string | undefined;
    try {
      const stream = provider.stream(
        model,
        context,
        {
          maxTokens: SIDE_MAX_TOKENS,
          // Match the session's current level (see file header) so the rendered
          // prefix — including the level-specific reasoning instructions — is
          // byte-identical to the last main request.
          reasoningEffort: ctx.thinkingLevel,
          signal,
          apiKey: auth.apiKey,
          headers: auth.headers,
        } as any,
      );

      for await (const ev of stream as AsyncIterable<any>) {
        switch (ev.type) {
          case "text_delta":
            state.answer += ev.delta;
            state.phase = "streaming";
            state.requestRender?.();
            break;
          case "thinking_delta":
            state.hasThinking = true;
            state.requestRender?.();
            break;
          case "toolcall_start":
            state.toolCall = true;
            break;
          case "done":
            stopReason = ev.reason;
            // Prefer the canonical final message over accumulated deltas.
            state.answer = extractAnswer(ev.message?.content) || state.answer;
            if (hasToolCall(ev.message?.content)) state.toolCall = true;
            state.phase = "done";
            state.requestRender?.();
            break;
          case "error":
            state.phase = "error";
            state.errorText = ev.error?.errorMessage ?? "the side call failed";
            state.requestRender?.();
            break;
        }
      }
    } catch (err) {
      if (!signal.aborted) {
        state.phase = "error";
        state.errorText = err instanceof Error ? err.message : String(err);
        state.requestRender?.();
      }
    } finally {
      inFlight = false;
      aborter = undefined;
    }

    // Aborted: the panel is already closed (esc did it, or a session change).
    if (signal.aborted) return;

    if (!ctx.hasUI) {
      // Headless (--print): no overlay — print the answer (or the failure).
      if (state.phase === "error") console.error(`btw: ${state.errorText}`);
      else console.log(state.answer.trim() || toolRefusalNote());
      return;
    }

    // Durable record: the Q&A as a transcript entry. Invisible in the
    // transcript (no entry renderer registered) and never re-enters LLM
    // context — the overlay is the only visible surface, and the bare /btw
    // re-show reads this entry.
    if (state.phase === "done") {
      const record: BtwData = {
        question,
        answer: state.answer.trim(),
        model: model.id,
        ts: state.ts,
        stopReason,
        triedTool: state.toolCall && !state.answer.trim(),
      };
      pi.appendEntry(CUSTOM_TYPE, record);
    }

    // Stay open until dismissed — that is the point of the overlay.
    await userClose;
  }

  // ----------------------------------------------------------- bare /btw
  async function showLast(ctx: any): Promise<void> {
    const data = findLastBtw(ctx);
    if (!data) {
      notify(ctx, "no side questions yet — try /btw <question>", "info");
      return;
    }
    if (!ctx.hasUI) {
      // headless: no overlay, just print the last Q&A.
      console.log(
        `Q: ${data.question}\nA: ${data.answer?.trim() ? data.answer : toolRefusalNote()}`,
      );
      return;
    }
    const state: BtwOverlayState = {
      title: "⚡ last side question",
      question: data.question,
      model: data.model,
      ts: data.ts,
      phase: "done",
      answer: data.answer ?? "",
      hasThinking: false,
      toolCall: data.triedTool ?? false,
    };
    await ctx.ui.custom(
      (tui: any, theme: any, _kb: any, done: () => void) =>
        new BtwOverlay(state, theme, tui, done),
      {
        overlay: true,
        overlayOptions: { width: OVERLAY_WIDTH, maxHeight: OVERLAY_MAX_HEIGHT },
      },
    );
  }

  // ----------------------------------------------------------- registration
  pi.registerCommand("btw", {
    description:
      "Ask a quick side question without touching the main conversation (bare /btw re-shows the last one)",
    handler: async (args, ctx) => {
      const q = args.trim();
      if (!q) {
        await showLast(ctx);
        return;
      }
      if (inFlight) {
        notify(ctx, "a /btw is already in flight — let it finish first", "warning");
        return;
      }
      if (!ctx.model) {
        notify(ctx, "no model selected — pick one with /model", "error");
        return;
      }
      await runSide(q, ctx);
    },
  });

  // A session change voids the forked context; don't let an in-flight side call
  // finish and append its answer into a different session.
  pi.on("session_start", () => abortInFlight());
  pi.on("session_shutdown", () => abortInFlight());
  pi.on("session_before_switch", () => abortInFlight());
  pi.on("session_before_fork", () => abortInFlight());
}