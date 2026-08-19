// redcode-reqsize — record how big each provider request actually is.
//
// WHY. On 2026-08-16 a /sweepsites-fix run died with NInfer's
//   413 {"code":"request_too_large","message":"request body exceeds the
//        configured payload limit"}
// and left NOTHING to diagnose. NInfer enforces --max-request-mib BEFORE it
// parses the JSON, so a rejected request never reaches the request log — the
// engine log simply stops. The pi session file is no better: it stores the
// conversation, not the serialized payload, and the failing turn is never
// written because it never completed. The trigger was clearly a screenshot
// entering context (vision was enabled that morning, so `read` stopped
// refusing PNGs), but the exact payload could not be reconstructed after the
// fact, and replaying the same image succeeded.
//
// So: measure the payload at the moment it is built, every time, and keep the
// last one around. The next 413 should be explicable in one command.
//
// COST. One JSON.stringify of the payload per request. That is the same work
// the transport is about to do anyway, and it is off the GPU path entirely, so
// it does not touch tok/s. Written synchronously with appendFileSync so a
// crash or a hard kill cannot lose the very record we care about — the last
// one before the failure.

import { appendFileSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LOG = join(homedir(), ".pi", "agent", "request-sizes.jsonl");
const DUMPS = join(homedir(), ".pi", "agent", "payloads");
const MIB = 1024 * 1024;

// Sizes alone were not enough. The 2026-08-16 413 fired on a 1.392 MiB payload
// against a 384 MiB limit, and replaying the same image by hand — with both
// Content-Length and chunked transfer — returned 200. So the trigger is
// something in the exact bytes pi sends, not their volume, and the only way to
// find it is to keep the bytes and replay them verbatim.
//
// Dump only requests carrying media: those are rare, and a plain-text turn is
// already fully described by the size line. Keep the newest few and delete the
// rest, because these are ~1.4 MiB each and this is a diagnostic, not an
// archive.
const KEEP_DUMPS = 6;

/** Warn in the TUI above this. Well under NInfer's 384 MiB default, because by
 *  the time you are near the limit the session is already unusable. */
const WARN_MIB = 32;

interface Sample {
  bytes: number;
  messages: number;
  tools: number;
  images: number;
  imageBytes: number;
  biggest: Array<{ i: number; role: string; bytes: number; kinds: string }>;
}

/** Walk the built payload rather than pi's session: this is the thing that
 *  actually goes on the wire, including tool schemas and any provider-level
 *  rewriting done by earlier extensions. */
function measure(payload: any): Sample {
  const whole = JSON.stringify(payload) ?? "";
  const msgs: any[] = Array.isArray(payload?.messages) ? payload.messages : [];

  let images = 0;
  let imageBytes = 0;
  const per: Array<{ i: number; role: string; bytes: number; kinds: string }> = [];

  msgs.forEach((m, i) => {
    const kinds = new Set<string>();
    const content = m?.content;
    const parts = Array.isArray(content) ? content : [content];
    for (const p of parts) {
      if (typeof p === "string") { kinds.add("text"); continue; }
      const t = p?.type;
      if (!t) continue;
      kinds.add(t);
      // Both shapes appear in the wild: OpenAI's image_url.url data: URI and
      // the Anthropic-style source.data. Count either as image payload.
      const b64 = p?.image_url?.url ?? p?.source?.data ?? (t === "image" ? p?.data : undefined);
      if (typeof b64 === "string") { images++; imageBytes += b64.length; }
    }
    per.push({ i, role: String(m?.role ?? "?"), bytes: JSON.stringify(m)?.length ?? 0, kinds: [...kinds].join("+") });
  });

  per.sort((a, b) => b.bytes - a.bytes);
  return {
    bytes: whole.length,
    messages: msgs.length,
    tools: Array.isArray(payload?.tools) ? payload.tools.length : 0,
    images,
    imageBytes,
    biggest: per.slice(0, 5),
  };
}

/** Persist the exact payload so it can be replayed with curl byte-for-byte. */
function dump(payload: any, tag: string): string | null {
  try {
    mkdirSync(DUMPS, { recursive: true });
    const path = join(DUMPS, `${new Date().toISOString().replace(/[:.]/g, "-")}-${tag}.json`);
    writeFileSync(path, JSON.stringify(payload));
    const old = readdirSync(DUMPS).filter((f) => f.endsWith(".json")).sort();
    for (const f of old.slice(0, Math.max(0, old.length - KEEP_DUMPS))) {
      try { unlinkSync(join(DUMPS, f)); } catch { /* already gone */ }
    }
    return path;
  } catch {
    return null;
  }
}

function write(row: Record<string, unknown>): void {
  try {
    appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n");
  } catch {
    // Never let instrumentation break a turn.
  }
}

export default function (pi: ExtensionAPI) {
  let last: Sample | null = null;
  let warned = false;

  pi.on("before_provider_request", async (event: any, ctx: any) => {
    let s: Sample;
    try {
      s = measure(event?.payload);
    } catch {
      return; // a payload shape we cannot walk is not worth failing over
    }
    last = s;

    const dumped = s.images > 0 ? dump(event.payload, "media") : null;

    write({
      kind: "request",
      mib: +(s.bytes / MIB).toFixed(3),
      bytes: s.bytes,
      messages: s.messages,
      tools: s.tools,
      images: s.images,
      imageMib: +(s.imageBytes / MIB).toFixed(3),
      biggest: s.biggest,
      dump: dumped,
    });

    // Surface it before the failure, not after. Once per session: a repeated
    // toast every turn on a big session would be its own kind of useless.
    if (!warned && s.bytes > WARN_MIB * MIB && ctx?.hasUI) {
      warned = true;
      ctx.ui.notify(
        `Request payload is ${(s.bytes / MIB).toFixed(1)} MiB ` +
          `(${s.images} image${s.images === 1 ? "" : "s"}, ${(s.imageBytes / MIB).toFixed(1)} MiB of it). ` +
          `See ~/.pi/agent/request-sizes.jsonl`,
        "warning",
      );
    }
  });

  pi.on("after_provider_response", async (event: any, ctx: any) => {
    const status = Number(event?.status);

    // Log EVERY status, not just failures. On the 2026-08-16 413 no error row
    // appeared at all, which left two indistinguishable possibilities: the hook
    // does not fire for that path, or it fired and the status looked fine.
    // Recording success too tells them apart next time.
    if (Number.isFinite(status) && status < 400) {
      write({ kind: "response", status, requestMib: last ? +(last.bytes / MIB).toFixed(3) : null });
      return;
    }

    // Pair the failure with the payload that caused it — the whole point.
    write({
      kind: "error",
      status: Number.isFinite(status) ? status : String(event?.status),
      requestMib: last ? +(last.bytes / MIB).toFixed(3) : null,
      messages: last?.messages ?? null,
      images: last?.images ?? null,
      imageMib: last ? +(last.imageBytes / MIB).toFixed(3) : null,
      biggest: last?.biggest ?? null,
      headers: event?.headers ?? null,
    });

    if (status === 413 && ctx?.hasUI) {
      ctx.ui.notify(
        `413 request_too_large on a ${last ? (last.bytes / MIB).toFixed(1) : "?"} MiB payload ` +
          `(${last?.images ?? "?"} images). Captured in ~/.pi/agent/request-sizes.jsonl`,
        "error",
      );
    }
  });

  pi.registerCommand("reqsize", {
    description: "Show the last provider request's payload size breakdown",
    handler: async (_args, ctx) => {
      if (!last) { ctx.ui.notify("No provider request recorded yet.", "info"); return; }
      const lines = [
        `Payload: ${(last.bytes / MIB).toFixed(2)} MiB across ${last.messages} messages, ${last.tools} tools`,
        `Images : ${last.images} (${(last.imageBytes / MIB).toFixed(2)} MiB)`,
        "Largest messages:",
        ...last.biggest.map((b) => `  #${b.i} ${b.role} ${(b.bytes / MIB).toFixed(3)} MiB [${b.kinds}]`),
        `Log: ${LOG}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
