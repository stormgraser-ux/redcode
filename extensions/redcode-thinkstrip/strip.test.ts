// Unit tests for the reasoning-echo policy. Run:
//   node --experimental-strip-types strip.test.ts
import { parseMode, stripReasoning } from "./strip.ts";

let pass = 0;
const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) pass++;
  else fails.push(`  ${name}${detail ? ` — ${detail}` : ""}`);
};

/** A completed turn, then a second user turn with an in-flight tool chain. */
const convo = () => [
  { role: "system", content: "sys" }, // 0
  { role: "user", content: "first ask" }, // 1
  { role: "assistant", content: "a1", reasoning_content: "OLD-ONE", tool_calls: [{ id: "1" }] }, // 2
  { role: "tool", content: "result", tool_call_id: "1" }, // 3
  { role: "assistant", content: "a2", reasoning_content: "OLD-TWO" }, // 4
  { role: "user", content: "second ask" }, // 5
  { role: "assistant", content: "a3", reasoning_content: "LIVE-ONE", tool_calls: [{ id: "2" }] }, // 6
  { role: "tool", content: "result2", tool_call_id: "2" }, // 7
  { role: "assistant", content: "a4", reasoning_content: "LIVE-TWO" }, // 8
];

// 1. THE DEFAULT IS A TRUE NO-OP. This is the guarantee that matters most:
//    Qwen exempts multi-step tool calls, so shipping any stripping by default
//    would silently degrade exactly the workload this box runs.
{
  check("default mode is all", parseMode(undefined) === "all");
  check("garbage defaults to all", parseMode("yes-please") === "all");
  check("empty string defaults to all", parseMode("") === "all");
  const input = convo();
  const r = stripReasoning(input, "all");
  check("mode=all strips nothing", r.stripped === 0 && r.chars === 0);
  check("mode=all returns the same array", r.messages === (input as unknown));
}

// 2. `turns` implements Qwen's ACTUAL rule: history loses reasoning, the
//    in-flight tool chain after the last user message keeps it.
{
  const { messages, stripped } = stripReasoning(convo(), "turns");
  const json = JSON.stringify(messages);
  check("strips completed turns only", stripped === 2, String(stripped));
  check("OLD-ONE dropped", !json.includes("OLD-ONE"));
  check("OLD-TWO dropped", !json.includes("OLD-TWO"));
  check("LIVE-ONE kept (in-flight tool chain)", json.includes("LIVE-ONE"));
  check("LIVE-TWO kept (in-flight tool chain)", json.includes("LIVE-TWO"));
}

// 3. `none` drops everything, including the in-flight chain.
{
  const { messages, stripped } = stripReasoning(convo(), "none");
  check("none strips every assistant", stripped === 4, String(stripped));
  check("nothing survives", !JSON.stringify(messages).includes("-ONE"));
}

// 4. With no user message at all, `turns` must strip nothing — there is no
//    completed turn, so everything is in-flight.
{
  const noUser = [
    { role: "system", content: "s" },
    { role: "assistant", content: "a", reasoning_content: "R" },
  ];
  check("turns with no user message strips nothing", stripReasoning(noUser, "turns").stripped === 0);
}

// 5. Non-reasoning fields survive. Dropping tool_calls would break the
//    conversation outright rather than just make it cheaper.
{
  const { messages } = stripReasoning(convo(), "turns");
  const a1 = messages[2] as any;
  check("content preserved", a1.content === "a1");
  check("tool_calls preserved", Array.isArray(a1.tool_calls) && a1.tool_calls[0].id === "1");
  check("role preserved", a1.role === "assistant");
  check("reasoning key removed", !("reasoning_content" in a1));
  check("user message untouched", (messages[1] as any).content === "first ask");
  check("tool message untouched", (messages[3] as any).tool_call_id === "1");
}

// 6. Never mutate the caller's messages.
{
  for (const mode of ["turns", "none"] as const) {
    const input = convo();
    const before = JSON.stringify(input);
    const { messages } = stripReasoning(input, mode);
    check(`${mode}: input not mutated`, JSON.stringify(input) === before);
    check(`${mode}: returns a new array`, messages !== (input as unknown));
    check(`${mode}: untouched entries are shared, not copied`, messages[0] === input[0]);
  }
}

// 7. Cache stability. `none` must be byte-stable as the conversation grows;
//    `turns` is only stable while no NEW user message arrives.
{
  const turnN = convo();
  const turnN1 = [
    ...convo(),
    { role: "tool", content: "r3" },
    { role: "assistant", content: "a5", reasoning_content: "LIVE-THREE" },
  ];
  const a = stripReasoning(turnN, "none").messages;
  const b = stripReasoning(turnN1, "none").messages;
  check(
    "none: prefix byte-identical as the chain grows",
    JSON.stringify(b.slice(0, a.length)) === JSON.stringify(a),
  );

  const c = stripReasoning(turnN, "turns").messages;
  const d = stripReasoning(turnN1, "turns").messages;
  check(
    "turns: prefix stable while the tool chain grows",
    JSON.stringify(d.slice(0, c.length)) === JSON.stringify(c),
  );

  // The documented exception: a new user message advances the boundary and
  // rewrites history. One re-prefill per user turn, never per tool call.
  const withNewUser = [...turnN1, { role: "user", content: "third ask" }];
  const e = stripReasoning(withNewUser, "turns").messages;
  check(
    "turns: a NEW user message does rewrite history (documented cost)",
    JSON.stringify(e.slice(0, c.length)) !== JSON.stringify(c),
  );
}

// 8. Malformed input must never throw — this runs on every provider request.
{
  let threw = false;
  try {
    for (const mode of ["all", "turns", "none"] as const) {
      stripReasoning([null, undefined, 5, "s", {}, { role: "assistant" }] as unknown[], mode);
      stripReasoning(undefined as unknown as unknown[], mode);
      stripReasoning([], mode);
    }
  } catch {
    threw = true;
  }
  check("survives malformed messages", !threw);
  check("non-array passes through", stripReasoning(null as any, "none").stripped === 0);
  check(
    "assistant without reasoning untouched",
    stripReasoning([{ role: "assistant", content: "x" }], "none").stripped === 0,
  );
  check(
    "null reasoning not counted",
    stripReasoning([{ role: "assistant", reasoning_content: null }], "none").stripped === 0,
  );
}

// 9. Mode parsing.
{
  check("'none' parses", parseMode("none") === "none");
  check("'turns' parses", parseMode("turns") === "turns");
  check("'all' parses", parseMode("all") === "all");
}

const total = pass + fails.length;
console.log(`${pass}/${total} passed`);
if (fails.length) {
  console.log("FAILURES:\n" + fails.join("\n"));
  process.exit(1);
}
