// Plan-nudge decision, kept pure so it can be tested without a pi session.
//
// See the long comment at the call site in index.ts for WHY this is appended to
// a tool result rather than injected into the conversation: a tool_result hook
// replaces the content BEFORE the message is built, so the appended text is
// what gets persisted (agent-session.js:258). It is written once, at the
// frontier, and every later turn sends the same bytes — no history rewrite, no
// prefix-cache invalidation.

import type { Item } from "./reconcile.ts";

export interface NudgeState {
  /** Tool results seen since the last `todo` call. */
  since: number;
}

/**
 * Decide whether this tool result should carry a plan nudge.
 *
 * Returns the text to append, or null to leave the result alone. Mutates
 * `state.since` — the counter re-arms on every nudge so it fires at most once
 * per `after` tool calls, and resets to 0 on any `todo` result.
 */
export function planNudge(
  todos: Item[],
  toolName: string,
  state: NudgeState,
  after: number,
): string | null {
  // The plan is already verbatim in this result.
  if (toolName === "todo") {
    state.since = 0;
    return null;
  }
  if (after <= 0) return null; // escape hatch
  if (todos.length === 0) return null;

  const open = todos.filter((i) => i.status !== "completed");
  if (open.length === 0) return null; // a finished plan does not nag

  state.since++;
  if (state.since < after) return null;
  state.since = 0;

  const done = todos.length - open.length;
  const active = todos.find((i) => i.status === "in_progress");
  return (
    `\n\n<plan-check>Plan currently reads ${done}/${todos.length} complete` +
    (active ? `, with "${active.text}" in progress` : ", with nothing in progress") +
    ". If that no longer matches where you are, call todo with the full list and " +
    "updated statuses. If it is still accurate, ignore this.</plan-check>"
  );
}

/**
 * Append `nudge` to the last text block of a tool result, returning a NEW
 * array. Never mutates the input: the caller still holds a reference to
 * `result.content`, and editing it in place would be a second write to state
 * this extension does not own.
 */
export function appendNudge(content: unknown, nudge: string): { type: string; text: string }[] {
  const blocks = Array.isArray(content) ? [...content] : [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block: any = blocks[i];
    if (block?.type === "text" && typeof block.text === "string") {
      blocks[i] = { ...block, text: `${block.text}${nudge}` };
      return blocks as { type: string; text: string }[];
    }
  }
  // Image-only result (or empty): the nudge becomes its own block.
  blocks.push({ type: "text", text: nudge.trimStart() });
  return blocks as { type: string; text: string }[];
}
