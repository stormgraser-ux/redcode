// taint-test.ts — run with: node --experimental-strip-types taint-test.ts
//
// The two failure directions matter differently, so both are covered:
//   * a MISSED fetch means the session keeps root while holding hostile text
//   * a FALSE taint on loopback means every session loses root in seconds and
//     the whole control gets switched off as useless
// The loopback cases are therefore not padding; they are the ones that decide
// whether this survives contact with the machine.

import { escalatesPrivilege, fetchesRemoteContent } from "./taint.ts";

let pass = 0;
const failures: string[] = [];

function fetches(command: string, expected: boolean, note = "") {
  const got = fetchesRemoteContent(command).yes;
  if (got === expected) pass++;
  else failures.push(`fetch: expected ${expected}, got ${got} — ${command}${note ? `  (${note})` : ""}`);
}

function escalates(command: string, expected: boolean) {
  const got = escalatesPrivilege(command).yes;
  if (got === expected) pass++;
  else failures.push(`escalate: expected ${expected}, got ${got} — ${command}`);
}

// --- public content taints -------------------------------------------------
fetches("webfetch https://example.com", true);
fetches("websearch 'some question'", true);
fetches("curl -s https://api.github.com/repos/x/y", true);
fetches("wget https://example.com/file.tar.gz", true);
fetches("curl https://example.com | head", true);
fetches("cd /tmp && curl -fsSL https://get.example.sh", true, "second segment");
fetches("curl -H 'Accept: application/json' https://example.com/a?b=c", true);
fetches("curl example.com/path", true, "bare domain, no scheme");
fetches("curl $URL", true, "unparseable target fails closed");
fetches("/usr/bin/curl https://example.com", true, "absolute path still counts");
fetches("time curl https://example.com", true, "wrapper skipped");
fetches("FOO=bar curl https://example.com", true, "assignment skipped");

// --- local content does NOT taint ------------------------------------------
fetches("curl -s http://127.0.0.1:8080/v1/models", false);
fetches("curl http://localhost:8188/queue", false);
fetches("curl -fsS http://172.20.10.1:8899/healthz", false, "docker bridge");
fetches("curl http://192.168.1.50:8096/health", false, "LAN NAS");
fetches("curl http://100.101.102.103:8080/", false, "tailnet CGNAT");
fetches("curl https://storm.tail1234.ts.net/", false, "MagicDNS");
fetches("webfetch http://127.0.0.1:3080 --allow-local", false);

// --- not fetchers at all ---------------------------------------------------
fetches("ls -la", false);
fetches("git status", false);
fetches("echo https://example.com", false, "a URL in an echo is not a fetch");
fetches("rg 'https://example.com' src/", false, "grepping for a URL is not a fetch");

// --- escalation detection --------------------------------------------------
escalates("sudo systemctl restart nginx", true);
escalates("sudo -n faillock --user red --reset", true);
escalates("pkexec firewall-cmd --reload", true);
escalates("doas pacman -Syu", true);
escalates("su - root", true);
escalates("/usr/bin/sudo ls", true);
escalates("ls && sudo ls", true);
escalates("echo sudo", false);
escalates("git commit -m 'add sudo helper'", false);
escalates("rg sudo scripts/", false);
escalates("npm run build", false);

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log("  FAIL " + f);
  process.exit(1);
}

// --- combined fetch+escalate in ONE command (the measured bypass) ----------
// The model emitted exactly this when asked to fetch then sudo, and got root.
{
  const combined = [
    "webfetch https://example.com; sudo -n id",
    "curl -s https://example.com && sudo systemctl restart x",
    "sudo -n id; curl https://example.com",
  ];
  for (const c of combined) {
    const both = fetchesRemoteContent(c).yes && escalatesPrivilege(c).yes;
    if (both) pass++;
    else failures.push(`combined: expected fetch+escalate both true — ${c}`);
  }
  // Loopback plus sudo is NOT the dangerous pair and must stay allowed.
  const local = "curl -s http://127.0.0.1:8080/health; sudo -n id";
  if (!fetchesRemoteContent(local).yes && escalatesPrivilege(local).yes) pass++;
  else failures.push(`combined: loopback+sudo should not count as a fetch — ${local}`);
}

console.log(`${pass} passed, ${failures.length} failed (with combined cases)`);
if (failures.length) process.exit(1);
