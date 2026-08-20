// redcode-btw — pure logic for the /btw side call.
//
// Kept free of pi imports so it runs under bare `node --experimental-strip-types`
// in side.test.ts. The extension (index.ts) owns the pi wiring: command, entry
// renderer, pinned answer overlay, and the one-shot provider stream.

/** What a completed /btw Q&A records. Persisted as a custom-entry `data`. */
export interface BtwData {
  question: string;
  answer: string;
  model: string;
  ts: number;
  stopReason?: string;
  /** The model emitted a tool call instead of (or before) answering. */
  triedTool?: boolean;
}

/**
 * The side user message. The side request deliberately carries the SAME tools
 * as the main session (the rendered prefix must match for the engine's cache
 * hit), so this message is what actually keeps the answer tool-free. The
 * guarantee is also structural: the side call has no tool executor, so even a
 * model that reaches for a tool changes nothing on disk.
 */
export function sideQuestionText(question: string): string {
  return (
    "Side question about this conversation. Answer it directly and concisely in plain " +
    "text, from the context you already have. Do NOT use any tools or make any tool " +
    "calls — this is a one-shot side question, so just reply with text.\n\n" +
    question
  );
}

/**
 * Pull the plain-text answer out of an assistant message's content blocks.
 * Content is an array of { type: "text" | "thinking" | "toolCall", ... } blocks;
 * only the text blocks form the visible answer.
 */
export function extractAnswer(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (c) =>
        c && typeof c === "object" && (c as any).type === "text" &&
        typeof (c as any).text === "string",
    )
    .map((c) => (c as any).text)
    .join("");
}

/** True if any content block is a tool call. */
export function hasToolCall(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some(
    (c) => c && typeof c === "object" && (c as any).type === "toolCall",
  );
}

/** Last `n` lines of a string, for the live overlay body. */
export function tailLines(text: string, n: number): string[] {
  const trimmed = text.replace(/\s+$/, "");
  if (!trimmed) return [];
  return trimmed.split("\n").slice(-n);
}

/** One-line collapse for the header. */
export function truncate(text: string, max = 70): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  return one.slice(0, max - 1) + "…";
}

/**
 * The note shown when the model answered with a tool call instead of text.
 * The side call never executes tools, so the only real failure is "no text to
 * show" — this says what happened and where to go instead.
 */
export function toolRefusalNote(): string {
  return (
    "(the model reached for a tool instead of answering — side questions are tool-" +
    "less, so nothing ran. Rephrase it, or ask in the main session.)"
  );
}