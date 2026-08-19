// redcode-connect/config — where the endpoint and its key are kept.
//
// ~/.pi/agent/redcode.json, mode 0600. NOT pi's settings.json: settings.json is
// the file people paste into issues and gists, and a bearer token that reaches
// somebody's private model server does not belong in it. Separate file,
// separate permissions, and `/connect status` redacts it on the way back out.
//
// The key is never passed as a command-line argument anywhere in this project.
// argv is world-readable through `ps` and /proc, so a flag is a disclosure to
// every local account on the machine.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ModelOverride {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  vision?: boolean;
}

export interface Endpoint {
  /** pi provider id. Also what `/model` groups under, so keep it short. */
  name: string;
  /** Full base URL including /v1. */
  baseUrl: string;
  apiKey: string;
  /** Per-model corrections to the built-in catalog. Optional. */
  models?: ModelOverride[];
}

export interface RedcodeConfig {
  endpoints: Endpoint[];
}

/** pi's config directory, honouring the same override pi itself reads.
 *
 *  Hardcoding ~/.pi/agent breaks every non-default install — sandboxes, a
 *  second profile, anything that sets PI_CODING_AGENT_DIR — in the most
 *  confusing way available: the profile installs, the extension loads, and the
 *  provider simply never appears, because the config it wants is in a directory
 *  nothing wrote to. */
function configDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export const CONFIG_PATH = join(configDir(), "redcode.json");

export function loadConfig(): RedcodeConfig {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as RedcodeConfig;
    if (!Array.isArray(parsed?.endpoints)) return { endpoints: [] };
    // Drop anything malformed rather than throwing. A half-edited config should
    // cost you one endpoint, not the ability to start pi at all.
    return {
      endpoints: parsed.endpoints.filter(
        (e) => e && typeof e.name === "string" && typeof e.baseUrl === "string",
      ),
    };
  } catch {
    return { endpoints: [] };
  }
}

export function saveConfig(config: RedcodeConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  // Create with 0600 rather than writing and then narrowing: between those two
  // steps the key sits on disk world-readable, and that window is exactly when
  // an attacker with a read loop wins. On Windows the mode is largely ignored
  // by the filesystem, so the file inherits the user profile's ACL — which is
  // per-user, and the reason this is not a hole there either.
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(CONFIG_PATH, 0o600); // pre-existing file: writeFileSync's mode does not apply
  } catch {
    // Windows and some network filesystems refuse this. Not fatal.
  }
}

export function configExists(): boolean {
  return existsSync(CONFIG_PATH);
}

/** Show enough of a key to recognise it, never enough to use it. */
export function redact(key: string): string {
  if (key.length <= 10) return "…";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

/** Hosts that are reached without TLS in practice: an engine on this machine,
 *  or one on the LAN behind a router. Anything else on the open internet or a
 *  tailnet is served over HTTPS. */
function isLocalHost(host: string): boolean {
  const name = host.split(":")[0]?.toLowerCase() ?? "";
  return (
    name === "localhost" ||
    name === "::1" ||
    /^127\./.test(name) ||
    /^10\./.test(name) ||
    /^192\.168\./.test(name) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(name)
  );
}

/** Normalise what a human types into something fetchable.
 *
 *  People paste the host, or the host with a trailing slash, or the whole
 *  /v1/chat/completions URL they found in someone's config. They all mean the
 *  same endpoint, and a mismatch surfaces as a bare 404 with no hint that the
 *  URL was the problem.
 *
 *  A MISSING SCHEME DEFAULTS TO HTTPS, not http. Getting this backwards costs a
 *  confusing round trip: a TLS server answers plain HTTP with 400 and the body
 *  "Client sent an HTTP request to an HTTPS server", which looks like a broken
 *  server rather than a missing "s". Loopback and private-LAN addresses keep
 *  http, because a local engine is almost never behind TLS. Either way an
 *  explicit scheme is always honoured. */
export function normaliseBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) {
    url = `${isLocalHost(url) ? "http" : "https"}://${url}`;
  }
  url = url.replace(/\/v1\/(chat\/completions|models|messages|responses)$/i, "/v1");
  if (!/\/v1$/i.test(url)) url = `${url}/v1`;
  return url;
}
