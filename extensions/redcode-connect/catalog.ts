// redcode-connect/catalog — what pi needs to know about a model that the
// server will not tell it.
//
// An OpenAI-compatible `/v1/models` response is three fields: id, object,
// owned_by. It carries no context window, no modality, and no list of accepted
// reasoning levels. pi needs all three, and guessing them wrong is not a
// cosmetic problem:
//
//   * context window too high  -> pi sends a prompt the server rejects
//   * modality wrong           -> images are refused client-side, or sent to a
//                                 text-only engine and 400 back
//   * reasoning level wrong    -> the WORST failure. An unsupported
//                                 `reasoning_effort` returns a 400 that pi
//                                 silently retries, so the turn HANGS instead
//                                 of erroring. Reproduced against Qwen 3.8 on
//                                 2026-08-16 and killed at three minutes.
//
// So there is a table. Entries are matched against the model id the server
// reports. Anything unmatched still works — see FALLBACK — it just gets
// conservative defaults, and the user can override any field per-endpoint in
// ~/.pi/agent/redcode.json.

export interface ModelProfile {
  /** Matched against the server's model id, longest match wins. */
  idPrefix: string;
  label: string;
  contextWindow: number;
  maxTokens: number;
  vision: boolean;
  /** pi's level names -> the provider's. null HIDES a level rather than
   *  silently downgrading it, which is what keeps a hanging turn impossible. */
  thinkingLevelMap?: Record<string, string | null> | undefined;
  supportsReasoningEffort: boolean;
  /** Top-level `enable_thinking` instead of graded effort. NOT
   *  "qwen-chat-template" — that variant sends `chat_template_kwargs`, which
   *  NInfer rejects with a 400 on every single request. */
  thinkingFormat?: "qwen" | undefined;
  note: string;
}

/** Qwen 3.8's template accepts exactly these. minimal/high/max return
 *  "not supported by the loaded chat template" — all seven were probed against
 *  a live engine on 2026-08-16 and re-probed against the NVFP4 build on
 *  2026-08-17 with identical results. */
const QWEN38_LEVELS: Record<string, string | null> = {
  off: "none",
  minimal: null,
  low: "low",
  medium: "medium",
  high: null,
  xhigh: "xhigh",
  max: null,
};

export const CATALOG: ModelProfile[] = [
  {
    idPrefix: "qwen3.8-27b-nvfp4",
    label: "Qwen 3.8 27B (NVFP4)",
    contextWindow: 131072,
    maxTokens: 32768,
    vision: true,
    thinkingLevelMap: QWEN38_LEVELS,
    supportsReasoningEffort: true,
    note: "faster prefill, less context",
  },
  {
    idPrefix: "qwen3.8-27b",
    label: "Qwen 3.8 27B",
    contextWindow: 204800,
    maxTokens: 32768,
    vision: true,
    thinkingLevelMap: QWEN38_LEVELS,
    supportsReasoningEffort: true,
    note: "dense daily driver — most context",
  },
  {
    idPrefix: "qwen3.6-35b-a3b",
    label: "Qwen 3.6 35B-A3B (MoE)",
    contextWindow: 262144,
    maxTokens: 32768,
    vision: true,
    // BINARY, where 3.8's is graded. Every graded level 400s here with
    // `reasoning_effort_not_supported`; only "none" is accepted. There is no
    // value meaning "think harder", so the lever is the top-level
    // `enable_thinking` boolean, which is exactly what thinkingFormat "qwen"
    // sends and all that it sends. Applying the 3.8 map here would either fail
    // every graded turn or pin thinking off forever.
    thinkingLevelMap: undefined,
    supportsReasoningEffort: false,
    thinkingFormat: "qwen",
    note: "the fast one — ~680 tok/s, most context, 3.6-era quality",
  },
];

/** Deliberately timid. An unknown model gets a small window and no reasoning
 *  levels at all: pi will compact earlier than it needs to and offer no effort
 *  ladder, both of which are recoverable annoyances. The alternative — assuming
 *  a large window and a full ladder — produces rejected prompts and hung turns,
 *  which are not. Override it in redcode.json once you know the real numbers. */
export const FALLBACK: Omit<ModelProfile, "idPrefix" | "label"> = {
  contextWindow: 32768,
  maxTokens: 8192,
  vision: false,
  thinkingLevelMap: undefined,
  supportsReasoningEffort: false,
  note: "unknown model — conservative defaults, override in redcode.json",
};

export function profileFor(modelId: string): ModelProfile {
  const matches = CATALOG.filter((p) => modelId.startsWith(p.idPrefix));
  // Longest prefix wins, so "qwen3.8-27b-nvfp4" is not swallowed by
  // "qwen3.8-27b". Sorting the table by hand would work until someone adds a
  // row in the wrong place; deciding it here means order never matters.
  matches.sort((a, b) => b.idPrefix.length - a.idPrefix.length);
  if (matches[0]) return matches[0];
  return { idPrefix: "", label: modelId, ...FALLBACK };
}
