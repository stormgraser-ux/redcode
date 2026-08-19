// redcode-connect — point pi at a private OpenAI-compatible model server.
//
// This is the whole reason redcode can be public while the models behind it are
// not. Nothing in this repository contains a host, a key, or a tailnet name.
// You bring an endpoint and a key; `/connect` asks for both, checks them
// against the live server before saving anything, and writes them to a 0600
// file outside pi's settings.
//
// WHY A COMMAND AND NOT AN ENV VAR. An env var has to be re-exported per shell,
// leaks into `ps` for anything that inherits it, and cannot tell you WHY the
// server said no. `/connect` probes /v1/models first and reports the actual
// failure — DNS, refused, 401 — which is the difference between "it doesn't
// work" and a fix.
//
// WHY THE PROVIDER IS REGISTERED AT LOAD AND AGAIN ON /connect. pi applies
// registerProvider calls made after startup immediately, so a fresh connect
// takes effect without a restart. Registering at load is what makes the
// endpoint survive one.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CATALOG, FALLBACK, profileFor } from "./catalog.ts";
import {
  CONFIG_PATH,
  type Endpoint,
  loadConfig,
  normaliseBaseUrl,
  redact,
  saveConfig,
} from "./config.ts";

const PROBE_TIMEOUT_MS = 10_000;

interface ProbeOk {
  ok: true;
  modelIds: string[];
}
interface ProbeFail {
  ok: false;
  reason: string;
}
type ProbeResult = ProbeOk | ProbeFail;

/** Ask the server what it is serving, and turn every failure into a sentence
 *  that names the next thing to check. A bare "connection failed" sends people
 *  to the wrong layer more often than not. */
async function probe(baseUrl: string, apiKey: string): Promise<ProbeResult> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error: any) {
    const cause = error?.cause?.code ?? error?.name ?? "";
    if (cause === "ENOTFOUND" || cause === "EAI_AGAIN") {
      return {
        ok: false,
        reason:
          `cannot resolve the host in ${baseUrl}. If it is a Tailscale name, ` +
          `check that Tailscale is running and you are logged in to the right tailnet.`,
      };
    }
    if (cause === "ECONNREFUSED") {
      return {
        ok: false,
        reason: `nothing is listening at ${baseUrl}. The server may be down, or on a different port.`,
      };
    }
    if (cause === "TimeoutError" || cause === "AbortError") {
      return {
        ok: false,
        reason:
          `${baseUrl} did not answer within ${PROBE_TIMEOUT_MS / 1000}s. ` +
          `A firewall that drops rather than refuses looks exactly like this.`,
      };
    }
    if (String(cause).includes("CERT") || String(cause).includes("SELF_SIGNED")) {
      return { ok: false, reason: `TLS verification failed for ${baseUrl}: ${cause}` };
    }
    return { ok: false, reason: `${baseUrl}: ${error?.message ?? String(error)}` };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      reason:
        `the server rejected that API key (HTTP ${response.status}). The endpoint is ` +
        `reachable, so this is the key itself — ask whoever runs the server for a current one.`,
    };
  }
  if (!response.ok) {
    // Read the body before deciding what to say. The single most common cause
    // of a 400 here is a scheme mismatch, and the server says so in plain text
    // that would otherwise be thrown away in favour of a useless status code.
    const body = await response.text().catch(() => "");
    if (/HTTP request.*HTTPS server/i.test(body)) {
      return {
        ok: false,
        reason: `${baseUrl} is an HTTPS endpoint — retry with https:// on the front.`,
      };
    }
    return {
      ok: false,
      reason:
        `HTTP ${response.status} from ${baseUrl}/models. ` +
        `If that is a 404, the base URL probably needs (or already has) a /v1 on the end.`,
    };
  }

  try {
    const payload = (await response.json()) as { data?: Array<{ id?: string }> };
    const modelIds = (payload.data ?? []).map((m) => m.id).filter((id): id is string => !!id);
    if (modelIds.length === 0) {
      return { ok: false, reason: `${baseUrl} answered but is serving no models.` };
    }
    return { ok: true, modelIds };
  } catch {
    return {
      ok: false,
      reason: `${baseUrl}/models did not return JSON. Is that really an OpenAI-compatible server?`,
    };
  }
}

/** Build pi's model definitions for one endpoint: what the server reports,
 *  described by the catalog, corrected by the user's overrides. */
function modelsFor(endpoint: Endpoint, modelIds: string[]) {
  return modelIds.map((id) => {
    const profile = profileFor(id);
    const override = endpoint.models?.find((m) => m.id === id);
    const vision = override?.vision ?? profile.vision;
    return {
      id,
      name: override?.name ?? profile.label,
      reasoning: true,
      input: vision ? ["text", "image"] : ["text"],
      // Someone else's GPU and someone else's electricity, but no invoice.
      // Reporting a real price here would put fiction in pi's session totals.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: override?.contextWindow ?? profile.contextWindow,
      maxTokens: override?.maxTokens ?? profile.maxTokens,
      ...(profile.thinkingLevelMap ? { thinkingLevelMap: profile.thinkingLevelMap } : {}),
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: profile.supportsReasoningEffort,
        maxTokensField: "max_tokens",
        ...(profile.thinkingFormat ? { thinkingFormat: profile.thinkingFormat } : {}),
      },
    };
  });
}

function register(pi: ExtensionAPI, endpoint: Endpoint, modelIds: string[]): void {
  pi.registerProvider(endpoint.name, {
    name: `${endpoint.name} (redcode)`,
    baseUrl: endpoint.baseUrl,
    apiKey: endpoint.apiKey,
    api: "openai-completions",
    models: modelsFor(endpoint, modelIds) as any,
  });
}

export default async function (pi: ExtensionAPI) {
  const config = loadConfig();
  // Which endpoints answered, so /connect status can distinguish "configured"
  // from "working" — they are not the same thing and conflating them is how a
  // dead server gets diagnosed as a broken config.
  const live = new Map<string, string[]>();

  // Probe every configured endpoint in parallel and register the ones that
  // answer. Serial probing would make two dead endpoints cost 20s of startup.
  await Promise.all(
    config.endpoints.map(async (endpoint) => {
      const result = await probe(endpoint.baseUrl, endpoint.apiKey);
      if (result.ok) {
        live.set(endpoint.name, result.modelIds);
        register(pi, endpoint, result.modelIds);
      } else {
        // Do NOT fail startup, and do NOT swallow it. An unregistered provider
        // surfaces later as `Unknown provider "x"`, which reads as a broken
        // config rather than an unreachable server.
        pi.on("session_start", async (_event, ctx) => {
          if (!ctx.hasUI) return;
          ctx.ui.notify(`redcode: '${endpoint.name}' unavailable — ${result.reason}`, "warning");
        });
      }
    }),
  );

  if (config.endpoints.length === 0) {
    pi.on("session_start", async (_event, ctx) => {
      if (!ctx.hasUI) return;
      ctx.ui.notify("redcode: no endpoint configured yet. Run /connect to add one.", "info");
    });
  }

  // ------------------------------------------------------------- /connect
  pi.registerCommand("connect", {
    description: "Connect to a redcode model endpoint (or show/remove existing ones)",
    getArgumentCompletions: (prefix: string) =>
      ["status", "remove"]
        .filter((s) => s.startsWith(prefix))
        .map((s) => ({
          value: s,
          label: s,
          description: s === "status" ? "list configured endpoints" : "remove an endpoint",
        })),
    handler: async (args: string, ctx: any) => {
      const current = loadConfig();
      const sub = args.trim().toLowerCase();

      if (sub === "status") {
        if (current.endpoints.length === 0) {
          ctx.ui.notify(`No endpoints configured. Run /connect to add one.`, "info");
          return;
        }
        const lines = current.endpoints.map((e) => {
          const ids = live.get(e.name);
          const state = ids ? `ok — ${ids.join(", ")}` : "not answering";
          return `  ${e.name}  ${e.baseUrl}  key ${redact(e.apiKey)}  [${state}]`;
        });
        ctx.ui.notify(`Endpoints (${CONFIG_PATH}):\n${lines.join("\n")}`, "info");
        return;
      }

      if (sub === "remove") {
        await removeInteractively(ctx);
        return;
      }

      // --- interactive add -------------------------------------------------
      const rawUrl = await ctx.ui.input(
        "Model endpoint URL",
        "https://host.tailnet.ts.net:8449/v1",
      );
      if (!rawUrl?.trim()) return;
      const baseUrl = normaliseBaseUrl(rawUrl);

      const apiKey = await ctx.ui.input("API key", "sk-…");
      if (!apiKey?.trim()) return;

      ctx.ui.notify(`Checking ${baseUrl}…`, "info");
      const result = await probe(baseUrl, apiKey.trim());
      if (!result.ok) {
        // Nothing is written on a failed probe. Saving a key that does not work
        // means the next session starts with a warning and no way to tell
        // whether the key or the server is at fault.
        ctx.ui.notify(`Not connected — ${result.reason}`, "error");
        return;
      }

      const suggested = defaultName(result.modelIds[0] ?? "redcode", current.endpoints);
      const nameInput = await ctx.ui.input(
        "Name this endpoint (used as the provider name in /model)",
        suggested,
      );
      const name = (nameInput?.trim() || suggested).replace(/\s+/g, "-").toLowerCase();

      const endpoint: Endpoint = { name, baseUrl, apiKey: apiKey.trim() };
      const endpoints = [...current.endpoints.filter((e) => e.name !== name), endpoint];
      saveConfig({ endpoints });

      register(pi, endpoint, result.modelIds);
      live.set(name, result.modelIds);

      const unknown = result.modelIds.filter((id) => !CATALOG.some((p) => id.startsWith(p.idPrefix)));
      const caveat = unknown.length
        ? `\n\nNot in the model catalog: ${unknown.join(", ")}. They will work, but with ` +
          `conservative defaults (${FALLBACK.contextWindow.toLocaleString()} ctx, no image input, ` +
          `no thinking levels). Override them in ${CONFIG_PATH} — see the README.`
        : "";

      ctx.ui.notify(
        `Connected '${name}' — ${result.modelIds.join(", ")}.\n` +
          `Pick it in /model. Key saved to ${CONFIG_PATH} (owner-readable only).${caveat}`,
        "info",
      );
    },
  });

  // ---------------------------------------------------------- /disconnect
  pi.registerCommand("disconnect", {
    description: "Remove a redcode endpoint and its stored key",
    handler: async (_args: string, ctx: any) => removeInteractively(ctx),
  });

  /** Shared by `/connect remove` and `/disconnect` — the same operation reached
   *  two ways, because "disconnect" is what people type and "connect remove" is
   *  where it belongs. */
  async function removeInteractively(ctx: any): Promise<void> {
    const current = loadConfig();
    if (current.endpoints.length === 0) {
      ctx.ui.notify("Nothing to remove.", "info");
      return;
    }
    // ui.select takes plain strings, so the label IS the key. Names are unique
    // in the config, which is what makes matching one back safe.
    const labels = current.endpoints.map((e) => `${e.name}  (${e.baseUrl})`);
    const chosen = await ctx.ui.select("Remove which endpoint?", labels);
    if (!chosen) return;
    const target = current.endpoints[labels.indexOf(chosen)];
    if (!target) return;

    saveConfig({ endpoints: current.endpoints.filter((e) => e.name !== target.name) });
    pi.unregisterProvider(target.name);
    live.delete(target.name);
    ctx.ui.notify(
      `Removed '${target.name}'. Its key is gone from ${CONFIG_PATH}. ` +
        `If it was shared with you, ask the owner to revoke it server-side too.`,
      "info",
    );
  }
}

/** A provider name derived from what the server is actually serving, so the
 *  first suggestion is usually the one to accept. */
function defaultName(modelId: string, existing: Endpoint[]): string {
  const base = modelId.split(/[-.]/)[0]?.toLowerCase() || "redcode";
  if (!existing.some((e) => e.name === base)) return base;
  for (let i = 2; i < 100; i++) {
    if (!existing.some((e) => e.name === `${base}${i}`)) return `${base}${i}`;
  }
  return base;
}
