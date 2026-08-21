// taint.ts — drop root the moment untrusted web content enters the session.
//
// THE PROBLEM. This agent runs as `red`, which is NOPASSWD: ALL. That is
// deliberate and mostly what is wanted — the whole point of the box is that an
// agent can restart services, edit firewall rules and install packages without
// parking itself on a dialog nobody is there to answer. But it means the
// distance between "the model read a web page" and "the model has silent root"
// is zero. A prompt injection on any fetched page inherits the entire machine.
//
// THE MODEL. Privilege is not per-command, it is per-session and it is
// one-way. A session starts trusted and keeps full root. The first time
// untrusted external content is pulled in, the session is TAINTED, and from
// that point on privilege escalation is refused for the rest of the session.
// Nothing else changes: every non-privileged command still runs untouched, so
// the agent can keep working, it just cannot be talked into `sudo` by
// something it read.
//
// This is the right shape because it matches where the trust actually changes.
// Gating sudo by command pattern is hopeless (the interesting damage is done
// by legitimate-looking commands), and asking per sudo call reintroduces
// exactly the prompt fatigue blast-radius exists to avoid. Asking once, at the
// moment trust is lost, costs one new session when it fires and nothing at all
// when it does not.
//
// LOOPBACK AND PRIVATE ADDRESSES DO NOT TAINT. This host curls 127.0.0.1
// constantly — NInfer probes, the arbiter, the relay, ComfyUI. If those
// tainted the session, every session would be tainted within seconds and the
// rule would be worthless, which is the usual way a control like this dies.
// Only genuinely external content counts.
//
// WHAT THIS IS NOT. It is advisory, not a kernel boundary. It reads the bash
// command pi is about to run; a model that writes a shell script and executes
// it, or that reaches the network through a tool this does not recognise, gets
// past it. Closing that properly means running the agent as a user that has no
// sudo at all, with a narrow privileged helper — that is the real fix and this
// does not replace it. What this does buy is that the common path — fetch a
// page, get injected, run sudo — is refused by default and visibly.

/** Commands that acquire privilege. `sudoedit` is here because it is sudo. */
const ESCALATORS = [
  "sudo", "sudoedit", "pkexec", "doas", "su", "runuser", "machinectl",
];

/** Commands that pull remote content. Kept small on purpose: each entry has to
 *  be something whose whole job is fetching, or the false-taint rate climbs
 *  and the rule gets switched off. */
const FETCHERS = ["webfetch", "websearch", "curl", "wget", "http", "https", "xh"];

/** Hosts whose content is not "the internet". */
function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h === "::1" || h === "0.0.0.0") return true;
  // IPv4 literals: loopback, RFC1918, link-local, CGNAT.
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // tailnet / CGNAT
    return false;
  }
  // Tailscale MagicDNS names are the tailnet, not the internet.
  if (h.endsWith(".ts.net")) return true;
  return false;
}

/** Split on shell separators so `foo && curl https://x` is seen as two
 *  commands. Crude by design — this only needs to find the verb of each
 *  segment and any URL in it. */
function segments(command: string): string[] {
  return command.split(/(?:\|\||&&|[;|\n])/g).map((s) => s.trim()).filter(Boolean);
}

function firstWord(segment: string): string {
  // Skip leading VAR=value assignments and `command`/`env` wrappers.
  const words = segment.split(/\s+/).filter(Boolean);
  for (const w of words) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue;
    if (w === "command" || w === "env" || w === "exec" || w === "nohup" || w === "time") continue;
    return w.replace(/^.*\//, ""); // basename, so /usr/bin/sudo counts
  }
  return "";
}

/** True if this command reaches out to a public host. */
export function fetchesRemoteContent(command: string): { yes: boolean; where?: string } {
  for (const seg of segments(command)) {
    const verb = firstWord(seg);
    if (!FETCHERS.includes(verb)) continue;

    // websearch has no URL argument and is always the open internet.
    if (verb === "websearch") return { yes: true, where: "websearch" };

    const urls = seg.match(/(?:https?:\/\/)[^\s'"`)>]+/gi) ?? [];
    if (urls.length === 0) {
      // A fetcher with no parseable URL (a variable, a here-doc, a bare
      // domain). Unknowable, so assume the internet — same failure direction
      // as the rest of blast-radius.
      const bare = seg.match(/\s(?:--url[= ])?([a-z0-9-]+\.[a-z]{2,}(?:\/\S*)?)/i);
      if (bare && !isLocalHost(bare[1].split("/")[0])) {
        return { yes: true, where: bare[1].split("/")[0] };
      }
      if (verb === "curl" || verb === "wget" || verb === "webfetch") {
        return { yes: true, where: "an unparseable target" };
      }
      continue;
    }

    for (const u of urls) {
      let host: string;
      try {
        host = new URL(u).hostname;
      } catch {
        return { yes: true, where: "an unparseable URL" };
      }
      if (!isLocalHost(host)) return { yes: true, where: host };
    }
  }
  return { yes: false };
}

/** True if this command tries to gain privilege. */
export function escalatesPrivilege(command: string): { yes: boolean; how?: string } {
  for (const seg of segments(command)) {
    const verb = firstWord(seg);
    if (ESCALATORS.includes(verb)) return { yes: true, how: verb };
  }
  return { yes: false };
}
