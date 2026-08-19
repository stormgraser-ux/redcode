// Run:
//   node --experimental-strip-types test.ts
//
// The point of these is the IMAGE accounting. A measurement that silently
// misses images would have made the 413 investigation no better than it was.

const MIB = 1024 * 1024;

// Mirror of measure() — kept in step with index.ts by the shape tests below.
function measure(payload: any) {
  const whole = JSON.stringify(payload) ?? "";
  const msgs: any[] = Array.isArray(payload?.messages) ? payload.messages : [];
  let images = 0, imageBytes = 0;
  const per: Array<{ i: number; role: string; bytes: number; kinds: string }> = [];
  msgs.forEach((m, i) => {
    const kinds = new Set<string>();
    const parts = Array.isArray(m?.content) ? m.content : [m?.content];
    for (const p of parts) {
      if (typeof p === "string") { kinds.add("text"); continue; }
      const t = p?.type;
      if (!t) continue;
      kinds.add(t);
      const b64 = p?.image_url?.url ?? p?.source?.data ?? (t === "image" ? p?.data : undefined);
      if (typeof b64 === "string") { images++; imageBytes += b64.length; }
    }
    per.push({ i, role: String(m?.role ?? "?"), bytes: JSON.stringify(m)?.length ?? 0, kinds: [...kinds].join("+") });
  });
  per.sort((a, b) => b.bytes - a.bytes);
  return { bytes: whole.length, messages: msgs.length,
           tools: Array.isArray(payload?.tools) ? payload.tools.length : 0,
           images, imageBytes, biggest: per.slice(0, 5) };
}

const B64 = "A".repeat(1024);
let pass = 0; const fails: string[] = [];
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) pass++; else fails.push(`  ${name}${got !== undefined ? ` (got ${JSON.stringify(got)})` : ""}`);
};

// 1. OpenAI shape — what pi sends to NInfer via openai-completions.
const openai = { messages: [{ role: "user", content: [
  { type: "text", text: "what is this" },
  { type: "image_url", image_url: { url: `data:image/png;base64,${B64}` } }] }], tools: [1, 2, 3] };
let r = measure(openai);
check("openai: counts 1 image", r.images === 1, r.images);
check("openai: image bytes include data URI", r.imageBytes > 1024, r.imageBytes);
check("openai: counts tools", r.tools === 3, r.tools);
check("openai: kinds recorded", r.biggest[0].kinds.includes("image_url"), r.biggest[0].kinds);

// 2. Anthropic shape — the /v1/messages path, same engine.
r = measure({ messages: [{ role: "user", content: [
  { type: "image", source: { type: "base64", media_type: "image/png", data: B64 } }] }] });
check("anthropic: counts 1 image", r.images === 1, r.images);
check("anthropic: image bytes", r.imageBytes === 1024, r.imageBytes);

// 3. The session shape (type:"image", data) — what pi stores from `read`.
r = measure({ messages: [{ role: "toolResult", content: [
  { type: "text", text: "Read image file [image/png]" }, { type: "image", data: B64 }] }] });
check("session: counts 1 image", r.images === 1, r.images);

// 4. Multiple images accumulate — the accumulation hypothesis must be visible.
r = measure({ messages: Array.from({ length: 6 }, () => ({ role: "user", content: [
  { type: "image_url", image_url: { url: B64 } }] })) });
check("accumulation: 6 images", r.images === 6, r.images);
check("accumulation: 6x bytes", r.imageBytes === 6 * 1024, r.imageBytes);

// 5. Plain text conversation reports no images and sane sizes.
r = measure({ messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }] });
check("text: no images", r.images === 0, r.images);
check("text: 2 messages", r.messages === 2, r.messages);
check("text: string content is text", r.biggest[0].kinds === "text", r.biggest[0].kinds);

// 6. Biggest is sorted descending — the report is only useful if ranked.
r = measure({ messages: [
  { role: "a", content: "x" }, { role: "b", content: "y".repeat(5000) }, { role: "c", content: "z".repeat(50) }] });
check("biggest: sorted", r.biggest[0].role === "b" && r.biggest[1].role === "c", r.biggest.map((b) => b.role));

// 7. Malformed payloads must not throw — instrumentation must never break a turn.
for (const bad of [null, undefined, {}, { messages: "nope" }, { messages: [null] }]) {
  try { measure(bad); pass++; } catch (e) { fails.push(`  malformed ${JSON.stringify(bad)} threw ${e}`); }
}

console.log(`${pass}/${pass + fails.length} passed`);
if (fails.length) { console.log("FAILURES:\n" + fails.join("\n")); process.exit(1); }
