// Unit tests for endpoint URL normalisation and key redaction. Run:
//   node --experimental-strip-types config.test.ts
import { normaliseBaseUrl, redact } from "./config.ts";

let pass = 0;
const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) pass++;
  else fails.push(`  ${name}${detail ? ` — ${detail}` : ""}`);
};
const eq = (name: string, got: string, want: string) =>
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// --- scheme inference ------------------------------------------------------
// A bare remote host means HTTPS. Defaulting to http costs a confusing round
// trip: the TLS server answers with 400 "Client sent an HTTP request to an
// HTTPS server", which reads as a broken server rather than a missing "s".
eq("bare remote host -> https", normaliseBaseUrl("host.example.ts.net:8449"),
   "https://host.example.ts.net:8449/v1");
eq("bare domain -> https", normaliseBaseUrl("models.example.com"),
   "https://models.example.com/v1");

// A local engine is almost never behind TLS, so loopback and private ranges
// keep http.
eq("localhost -> http", normaliseBaseUrl("localhost:8091"), "http://localhost:8091/v1");
eq("127.0.0.1 -> http", normaliseBaseUrl("127.0.0.1:8091"), "http://127.0.0.1:8091/v1");
eq("192.168.x -> http", normaliseBaseUrl("192.168.1.50:8091"), "http://192.168.1.50:8091/v1");
eq("10.x -> http", normaliseBaseUrl("10.0.0.5:8091"), "http://10.0.0.5:8091/v1");
eq("172.16.x -> http", normaliseBaseUrl("172.16.0.5:8091"), "http://172.16.0.5:8091/v1");
// 172.32 is OUTSIDE the private range, which stops at 172.31.
eq("172.32.x is public -> https", normaliseBaseUrl("172.32.0.5:8091"), "https://172.32.0.5:8091/v1");

// An explicit scheme always wins, in both directions.
eq("explicit http kept", normaliseBaseUrl("http://host.example.com"), "http://host.example.com/v1");
eq("explicit https on a LAN ip kept", normaliseBaseUrl("https://192.168.1.50:8091"),
   "https://192.168.1.50:8091/v1");

// --- path handling ---------------------------------------------------------
eq("trailing slash", normaliseBaseUrl("https://h.example:8449/"), "https://h.example:8449/v1");
eq("many trailing slashes", normaliseBaseUrl("https://h.example:8449///"),
   "https://h.example:8449/v1");
eq("already has /v1", normaliseBaseUrl("https://h.example:8449/v1"), "https://h.example:8449/v1");
eq("full completions url", normaliseBaseUrl("https://h.example:8449/v1/chat/completions"),
   "https://h.example:8449/v1");
eq("models url", normaliseBaseUrl("https://h.example:8449/v1/models"), "https://h.example:8449/v1");
eq("anthropic messages url", normaliseBaseUrl("https://h.example:8449/v1/messages"),
   "https://h.example:8449/v1");
eq("surrounding whitespace", normaliseBaseUrl("  https://h.example:8449  "),
   "https://h.example:8449/v1");

// --- redaction -------------------------------------------------------------
// Enough to recognise a key, never enough to use one.
const key = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
const shown = redact(key);
check("redaction keeps a recognisable head", shown.startsWith("sk-abc"));
check("redaction keeps a recognisable tail", shown.endsWith("6789"));
check("redaction drops the middle", !shown.includes("klmnopqrst"), shown);
check("redaction shortens", shown.length < key.length);
eq("a short key reveals nothing at all", redact("sk-short"), "…");

if (fails.length) {
  console.log(`${pass} passed, ${fails.length} FAILED`);
  console.log(fails.join("\n"));
  process.exit(1);
}
console.log(`${pass}/${pass} passed`);
