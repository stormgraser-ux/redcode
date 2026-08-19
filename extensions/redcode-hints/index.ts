// redcode-hints — tell the model the few facts about its own harness that pi
// leaves implicit, and that it otherwise pays for guessing.
//
// MEASURED (tcb-autobattler, 2026-08-18, 259 tool calls): 87 of 102 bash calls
// opened with `cd <absolute path> &&`, and 75 of those cd'd to the session's
// own working directory — a no-op. pi's bash tool description says "Execute a
// bash command in the current working directory" but never says WHICH
// directory, so prefixing is the rational response to missing information, not
// a quirk.
//
// The token cost is minor (~1,000 output tokens a session). The correctness
// cost is not: twice in that session the model wrote a script into /tmp with a
// `cd project &&` prefix and then used a relative import, which resolved
// against /tmp and failed:
//     Cannot find module '/tmp/src/sim/match.ts'
// Both failures cost a full script regeneration.
//
// CACHE SAFETY. This appends to the system prompt, which is message 0 and sits
// at the head of the cached prefix. That is only safe because the text is
// STABLE for the whole session — cwd does not change mid-session (and `/cd`
// replaces the session outright). Never make this vary per turn: a changing
// system prompt invalidates the entire prefix on every request, which on the
// local engine is a ~70 s re-prefill.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    const cwd = ctx?.cwd;
    if (!cwd) return;
    const block =
      `\n\n<harness-facts>\n` +
      `The bash tool already runs every command in ${cwd}. Do not prefix commands ` +
      `with \`cd ${cwd} &&\` — it is a no-op. Use bash's own \`cd\` only to reach a ` +
      `DIFFERENT directory, and prefer absolute paths in scripts you write to /tmp, ` +
      `because a \`cd\` prefix does not change where a script's relative imports resolve.\n` +
      `</harness-facts>`;
    return { systemPrompt: `${event.systemPrompt}${block}` };
  });
}
