// redcode-escape-clear — double-tap escape to empty the command line.
//
// THE GESTURE WAS FREE. pi's escape chain, in priority order, is: abort a
// streaming turn, abort a running bash tool, leave bash mode (which clears the
// text), then — only when the editor is ALREADY EMPTY — the double-escape
// tree/fork selector. With text in the editor and nothing running, escape does
// nothing at all. That is the slot this fills, so nothing has to be taken away
// from anything else to get it.
//
// WHY NOT A SHORTCUT. registerShortcut binds a key outright, which would seize
// escape from the abort paths above. Those are the ones you need most and the
// ones you reach for under pressure. A raw input listener can look at the key,
// decline to act, and let the real handler run — which is the only safe shape
// for a key this overloaded.
//
// THE STREAMING GUARD IS NOT OPTIONAL. While a turn is streaming, escape means
// "abort", and pi restores any queued messages back into the editor as part of
// that. Clearing the editor in that window would delete work the user typed
// while waiting, at the exact moment they asked to get it back. So this only
// ever acts when the agent is idle.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";

/** How long the two presses may be apart. Matches pi's own double-escape
 *  window so one gesture does not have two different timings depending on
 *  whether the editor happened to be empty. */
export const DOUBLE_ESCAPE_MS = 500;

/** A bare escape key, as a legacy terminal sends it. Arrow keys, function keys
 *  and mouse reports all arrive as ESC followed by more bytes in the same
 *  chunk, so an exact match is what separates "the user pressed escape" from
 *  "the terminal described an arrow". */
export const ESC = "\x1b";

/** Kitty's keyboard protocol, which pi ENABLES, does not send a bare ESC.
 *
 *  This is the whole reason the first version of this extension worked when
 *  driven through a plain pty and did nothing at all in the real terminal. pi
 *  pushes the protocol at startup (`\x1b[>...u`, popped with `\x1b[<u`), and a
 *  terminal that accepts it reports Escape as a CSI-u sequence instead:
 *
 *      \x1b[27u          escape, no modifiers
 *      \x1b[27;1u        escape, modifier state 1
 *      \x1b[27;1:3u      escape, RELEASE  (event type 3)
 *      \x1b[27:27;1u     escape, with the alternate-key field populated
 *
 *  A pty that never answers the negotiation leaves pi in legacy mode, which is
 *  why a synthetic `\x1b` test passes while the real key does nothing.
 *
 *  EVENT TYPE MATTERS. With release events enabled, one physical press yields
 *  BOTH a press and a release sequence. Counting both would turn a single tap
 *  into a "double escape" and wipe the line on one press. Only event type 1
 *  (press) counts; 2 (repeat, i.e. the key held down) and 3 (release) do not.
 *
 *  Returns true only for an Escape PRESS, in either encoding. */
export function isEscapePress(data: string): boolean {
  if (data === ESC) return true;
  const m = /^\x1b\[([0-9:]+)(?:;([0-9:]+))?u$/.exec(data);
  if (!m) return false;
  const keyCode = m[1].split(":")[0];
  if (keyCode !== "27") return false;
  const eventType = m[2]?.split(":")[1] ?? "1";
  return eventType === "1";
}

export interface ClearDecision {
  /** Wipe the editor. */
  clear: boolean;
  /** Swallow the key so no later handler sees it. */
  consume: boolean;
  /** Timestamp to remember as the most recent escape, or null to forget. */
  remember: number | null;
}

/** Pure decision, so the rules can be tested without a terminal.
 *
 *  Returns clear+consume only for the second of two escapes, pressed close
 *  together, while idle, with something to clear. Every other case declines
 *  and lets pi's own handler do whatever it would have done. */
export function decide(args: {
  data: string;
  now: number;
  lastEscapeAt: number | null;
  text: string;
  streaming: boolean;
}): ClearDecision {
  const none: ClearDecision = { clear: false, consume: false, remember: args.lastEscapeAt };
  if (!isEscapePress(args.data)) return none;

  // Streaming or bash: escape belongs to abort. Forget any pending first press
  // too, so a press from before a turn started cannot combine with one after it
  // to clear the editor the abort just repopulated.
  if (args.streaming) return { clear: false, consume: false, remember: null };

  // Nothing to clear: this is pi's empty-editor double-escape, which opens the
  // tree selector. Leave it entirely alone, including its timing.
  if (!args.text.trim()) return { clear: false, consume: false, remember: null };

  const first = args.lastEscapeAt;
  if (first !== null && args.now - first < DOUBLE_ESCAPE_MS) {
    // Forget the timestamp rather than keeping it: otherwise a third press
    // would pair with the second and clear an editor the user has just started
    // retyping into.
    return { clear: true, consume: true, remember: null };
  }
  return { clear: false, consume: false, remember: args.now };
}

export default function (pi: ExtensionAPI) {
  let lastEscapeAt: number | null = null;
  let streaming = false;

  pi.on("turn_start", async () => {
    streaming = true;
    lastEscapeAt = null;
  });
  pi.on("agent_settled", async () => {
    streaming = false;
  });

  pi.on("session_start", async (_e: unknown, ctx: any) => {
    if (!ctx.hasUI) return;

    ctx.ui.onTerminalInput((data: string) => {
      const text = typeof ctx.ui.getEditorText === "function" ? ctx.ui.getEditorText() : null;
      if (process.env.REDCODE_ESC_DEBUG) {
        try {
          appendFileSync(
            "/tmp/redcode-esc-debug.log",
            `${JSON.stringify({
              bytes: [...data].map((ch) => ch.charCodeAt(0)),
              isEsc: isEscapePress(data),
              raw: JSON.stringify(data),
              text,
              hasGetEditorText: typeof ctx.ui.getEditorText === "function",
              hasSetEditorText: typeof ctx.ui.setEditorText === "function",
              streaming,
              lastEscapeAt,
            })}\n`,
          );
        } catch {
          /* debugging must never break input */
        }
      }
      const decision = decide({
        data,
        now: Date.now(),
        lastEscapeAt,
        text: text ?? "",
        streaming,
      });
      lastEscapeAt = decision.remember;
      if (!decision.clear) return undefined;
      ctx.ui.setEditorText("");
      return { consume: decision.consume };
    });
  });
}
