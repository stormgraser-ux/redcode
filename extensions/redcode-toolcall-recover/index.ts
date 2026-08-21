// toolcall-recover — a tool call that arrived as prose still runs.
//
// THE FAILURE. Qwen-family models write tool calls as an XML scaffold:
//
//     <tool_call>
//     <function=bash>
//     <parameter=command>
//     ls
//     </parameter>
//     </function>
//     </tool_call>
//
// Two positions in that scaffold sit on a BPE merge boundary — the places where
// more than one token sequence decodes to legal text, so the model has to
// commit to a merge it was never explicitly trained to prefer:
//
//     "<function"  + "=b" + "ash"     vs  "<function"  + "=" + " bash"
//     "<parameter" + "="  + "command" vs  "<parameter" + ">" + "command"
//
// Qwen's own recommended thinking preset is temperature 1.0, and at that
// temperature the neighbouring token occasionally wins. One token wrong, one
// byte different. A strict server-side parser then rejects the whole block,
// hands it back as ordinary content, and THE TURN ENDS: raw markup printed as
// the assistant's answer, no tool run, nothing to continue from but typing
// "continue" yourself.
//
// It is rare and it never goes away. Counted from one local engine's request
// log over four days: 4 in 2,005 tool-calling turns that finished normally —
// about one dead turn per 500, so roughly a one-in-five chance somewhere in a
// hundred-turn session. That is exactly the frequency that reads as "the model
// is getting worse" rather than as a decoding accident.
//
// WHAT THIS DOES. On message_end, an assistant message that stopped normally,
// carries no tool calls, and whose text holds a COMPLETE <tool_call> block is
// rewritten into real toolCall content parts, tolerating both near misses.
//
// Why that is enough to revive the turn: a message_end handler may return a
// replacement message, pi awaits every one of them before the agent loop reads
// `message.content` for toolCall parts, and the runner mutates that same
// message object in place. So the recovered calls are executed on this turn.
//
// WHAT IT DELIBERATELY WILL NOT DO:
//   - stopReason "length": the block is truncated, so its last argument value
//     is half-written. Executing that runs half a command or writes half a
//     file. pi already compacts and retries a length stop; leave it alone.
//   - partial recovery: if any block in the tail fails to parse, nothing is
//     rewritten. Half a turn is worse than a visible failure.
//   - the same call twice running: that means the recovery is not making
//     progress, so the second one is dropped rather than looped.
//
// If your server already repairs these (a tolerant tool-call parser is the
// better place for it, since it covers every client), this costs one string
// search per assistant message and does nothing.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseLeakedToolCalls } from "./parse.ts";

let counter = 0;
/** Guard against a pathological loop: the same call recovered twice running
 *  means the recovery is not making progress, so stop repairing it. */
let lastRecovered = "";

/** pi's tool-call ids are opaque; only uniqueness within the turn matters. */
function recoveredId(): string {
  counter += 1;
  return `call_recovered_${Date.now().toString(16)}_${counter}`;
}

export default function (pi: ExtensionAPI) {
  pi.on("message_end", (event: any, ctx: any) => {
    const message = event?.message;
    if (message?.role !== "assistant") return;
    if (message.stopReason !== "stop") return;
    if (!Array.isArray(message.content)) return;
    if (message.content.some((c: any) => c?.type === "toolCall")) return;

    const textParts = message.content.filter((c: any) => c?.type === "text");
    if (textParts.length === 0) return;
    const text = textParts.map((c: any) => c.text ?? "").join("");
    if (!text.includes("<tool_call>")) return;

    const parsed = parseLeakedToolCalls(text);
    if (parsed.kind !== "calls") {
      if (parsed.kind === "malformed") {
        ctx?.ui?.notify?.(
          "leaked tool-call markup could not be repaired — the turn ended without running a tool",
        );
      }
      return;
    }

    const signature = JSON.stringify(parsed.calls);
    if (signature === lastRecovered) return;
    lastRecovered = signature;

    const content = message.content.filter((c: any) => c?.type !== "text");
    if (parsed.prefix) content.push({ type: "text", text: parsed.prefix });
    for (const call of parsed.calls) {
      content.push({ type: "toolCall", id: recoveredId(), name: call.name, arguments: call.args });
    }
    return { message: { ...message, content } };
  });
}
