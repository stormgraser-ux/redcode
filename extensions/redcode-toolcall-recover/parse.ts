// Tolerant reader for a Qwen XML tool-call block that reached the client as
// prose instead of as tool calls.
//
// The grammar the model is trained on is
//
//     <tool_call>
//     <function=NAME>
//     <parameter=KEY>
//     value
//     </parameter>
//     </function>
//     </tool_call>
//
// Two positions in that scaffold are BPE-ambiguous, and at the model's own
// thinking preset (temperature 1.0, top_k 20) it occasionally draws the
// neighbouring token:
//
//     "<function"  + "="  + " bash"   instead of "<function"  + "=b" + "ash"
//     "<parameter" + ">"  + "command" instead of "<parameter" + "="  + "command"
//
// One token wrong, one byte different, and a strict parser rejects the whole
// block — which is what turned a routine tool call into an ended turn with raw
// markup printed as the answer. Accept ':' and '>' as the separator and trim
// the name, exactly as a tolerant server-side parser would.

export type LeakedCall = { name: string; args: Record<string, unknown> };
export type LeakedParse =
  | { kind: "none" }
  | { kind: "malformed" }
  | { kind: "calls"; prefix: string; calls: LeakedCall[] };

const TOOL_OPEN = "<tool_call>";
const TOOL_CLOSE = "</tool_call>";
const FUNCTION_CLOSE = "</function>";
const PARAMETER_CLOSE = "</parameter>";

/** A tag name must not swallow markup — without this the '>' separator would
 *  also "succeed" on a nameless `<parameter>value</parameter>` pair. */
function plausibleName(name: string): boolean {
  return name.length > 0 && name.length <= 128 && !/[<>/\r\n]/.test(name);
}

/** Reads `<function=NAME>` / `<parameter=NAME>` from `pos`, tolerating the two
 *  observed separator misses and any whitespace inside the name. */
function openTag(text: string, pos: number, tag: string): { name: string; next: number } | null {
  if (!text.startsWith(tag, pos)) return null;
  let cursor = pos + tag.length;
  const separator = text[cursor];
  if (separator !== "=" && separator !== ":" && separator !== ">") return null;
  cursor += 1;
  const end = text.indexOf(">", cursor);
  if (end === -1) return null;
  const name = text.slice(cursor, end).trim();
  if (!plausibleName(name)) return null;
  return { name, next: end + 1 };
}

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function parseOneCall(block: string): LeakedCall | null {
  const opened = openTag(block, block.length - block.trimStart().length, "<function");
  if (!opened) return null;
  const functionEnd = block.indexOf(FUNCTION_CLOSE, opened.next);
  if (functionEnd === -1) return null;
  if (block.slice(functionEnd + FUNCTION_CLOSE.length).trim() !== "") return null;

  const params = block.slice(opened.next, functionEnd);
  const args: Record<string, unknown> = {};
  let pos = 0;
  for (;;) {
    while (pos < params.length && /\s/.test(params[pos])) pos += 1;
    if (pos >= params.length) break;
    const tag = openTag(params, pos, "<parameter");
    if (!tag) return null;
    const valueEnd = params.indexOf(PARAMETER_CLOSE, tag.next);
    // A missing close means the output was cut off mid-value. Executing a
    // truncated argument would run half a command or write half a file, so a
    // truncated block must stay malformed no matter how repairable it looks.
    if (valueEnd === -1) return null;
    args[tag.name] = parseValue(params.slice(tag.next, valueEnd).trim());
    pos = valueEnd + PARAMETER_CLOSE.length;
  }
  return { name: opened.name, args };
}

/** Decodes every `<tool_call>` block in `text`. Returns "malformed" if any block
 *  fails, so a partial recovery never half-executes a turn. */
export function parseLeakedToolCalls(text: string): LeakedParse {
  const first = text.indexOf(TOOL_OPEN);
  if (first === -1) return { kind: "none" };

  const prefix = text.slice(0, first).replace(/\s+$/, "");
  const calls: LeakedCall[] = [];
  let pos = first;
  while (pos < text.length) {
    while (pos < text.length && /\s/.test(text[pos])) pos += 1;
    if (pos >= text.length) break;
    if (!text.startsWith(TOOL_OPEN, pos)) return { kind: "malformed" };
    const close = text.indexOf(TOOL_CLOSE, pos + TOOL_OPEN.length);
    if (close === -1) return { kind: "malformed" };
    const call = parseOneCall(text.slice(pos + TOOL_OPEN.length, close));
    if (!call) return { kind: "malformed" };
    calls.push(call);
    pos = close + TOOL_CLOSE.length;
  }
  if (calls.length === 0) return { kind: "malformed" };
  return { kind: "calls", prefix, calls };
}
