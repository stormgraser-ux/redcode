// Reasoning-echo policy.
//
// ============================================================================
// READ THIS BEFORE CHANGING THE DEFAULT. Stripping reasoning inside an agentic
// tool-calling chain is measurably harmful, and the default is "all" (keep
// everything) for that reason — NOT by oversight.
// ============================================================================
//
// The context measurement that motivated this extension is real: in a
// 480-entry tcb-autobattler session, reasoning echo accounted for 60,491 and
// 41,055 tokens at the two compaction points, and stripping it would have put
// both peaks (200,896 -> 140,405; 201,453 -> 160,398) under the 188,416
// threshold. Both compactions would have disappeared.
//
// The research says do not cash that in:
//
// 1. Qwen's own guidance carries an explicit carve-out. The Qwen docs say
//    "The thinking block should only be included in the final round EXCEPT FOR
//    MULTI-STEP TOOL CALLS." The HF model card's shorter "historical model
//    output should only include the final output part" is the same rule with
//    the exception elided — and an agentic run is entirely inside the
//    exception.
//
// 2. `preserve_thinking` is a deliberate model-card-level feature of the Qwen
//    3.6/3.8 dense line, not a default worth discarding. It is the flag NInfer
//    is launched with (`--preserve-thinking`), and it exists precisely so the
//    model can attend to what it already worked out across a multi-turn agent
//    conversation.
//
// 3. MiniMax measured the ablation directly for M2 — preserved vs discarded
//    interleaved thinking across tool calls:
//        Tau2              87   -> 64
//        BrowseComp        44.0 -> 31.4
//        GAIA              75.7 -> 67.9
//        xBench            72.0 -> 66.0
//        SWE-Bench Verified 69.4 -> 67.2
//    Different model, same architectural question, and the only direct
//    ablation available. Their stated failure mode is exactly what a plan
//    implementation is made of: "cumulative understanding breaks down, state
//    drift increases, self-correction weakens, and planning degrades —
//    especially on long-horizon toolchains and run-and-fix loops."
//
// So the context saving is real and so is the cost, and the cost lands on the
// workload this box exists to run. Compaction is the cheaper loss.

/**
 * - `all`    keep every reasoning block. The default, and what the evidence
 *            above supports for agentic work.
 * - `turns`  Qwen's actual published rule: drop reasoning from messages at or
 *            before the last user message, keep the in-flight tool chain.
 *            Safe by guidance, but saves little in an autonomous run — the
 *            measured session had 2 user messages against 214 assistant
 *            messages, so almost everything was "current turn".
 * - `none`   drop all reasoning. Against guidance. Only when context is the
 *            binding constraint and the task is short-horizon.
 */
export type EchoMode = "all" | "turns" | "none";

export interface StripResult {
  messages: unknown[];
  /** Number of assistant messages that had reasoning removed. */
  stripped: number;
  /** Characters of reasoning removed from this request. */
  chars: number;
}

function isRole(raw: unknown, role: string): boolean {
  return Boolean(raw) && typeof raw === "object" && (raw as { role?: string }).role === role;
}

/**
 * Index of the last real user message, i.e. the start of the current turn.
 * Tool results are a separate role in the OpenAI-shaped payload, so they do
 * not falsely advance the boundary the way they would in Qwen's Jinja template.
 */
function lastUserIndex(messages: unknown[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isRole(messages[i], "user")) return i;
  }
  return -1;
}

/**
 * Apply the reasoning-echo policy.
 *
 * Never mutates the input: pi hands us the payload it is about to serialize,
 * and those message objects can be shared with session state. Editing them in
 * place would corrupt what gets persisted.
 *
 * CACHE NOTE. `none` is byte-stable across turns — request N+1's prefix is
 * exactly request N's — so the prefix cache is untouched. `turns` is NOT: the
 * boundary advances whenever a new user message arrives, which rewrites
 * history once per user turn and costs one full re-prefill (~70 s on NInfer).
 * That is affordable only because user turns are rare in an agentic run. Never
 * make the boundary advance per tool call.
 */
export function stripReasoning(messages: unknown[], mode: EchoMode): StripResult {
  if (mode === "all" || !Array.isArray(messages)) {
    return { messages, stripped: 0, chars: 0 };
  }
  const boundary = mode === "turns" ? lastUserIndex(messages) : Number.POSITIVE_INFINITY;

  let stripped = 0;
  let chars = 0;
  const out = messages.map((raw, index) => {
    const msg = raw as Record<string, unknown>;
    if (!msg || typeof msg !== "object") return raw;
    if (msg.role !== "assistant") return raw;
    // `turns`: everything after the last user message is the in-flight
    // multi-step tool call, which Qwen's rule explicitly exempts.
    if (index > boundary) return raw;
    const reasoning = msg.reasoning_content;
    if (reasoning === undefined || reasoning === null) return raw;
    stripped++;
    if (typeof reasoning === "string") chars += reasoning.length;
    const { reasoning_content: _drop, ...rest } = msg;
    return rest;
  });
  return { messages: out, stripped, chars };
}

export function parseMode(raw: string | undefined): EchoMode {
  if (raw === "none") return "none";
  if (raw === "turns") return "turns";
  return "all";
}
