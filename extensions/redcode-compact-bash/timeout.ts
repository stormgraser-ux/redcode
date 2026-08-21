// Timeout policy for the bash tool.
//
// THE GAP. pi's bash schema says "Timeout in seconds (optional, no default
// timeout)", and `resolveTimeoutMs(undefined)` returns undefined, so no timer is
// ever armed: an omitted timeout means run forever. Measured over 1,419 real
// bash calls in this profile, 1,281 (90%) omitted it — one `node ... .test.ts`
// that never exited blocked a session for 2,382 seconds. The only ceiling
// upstream is MAX_TIMEOUT_MS (~24.8 days), so the 138 calls that DID set one
// included 90,000s and 120,000s.
//
// THE POLICY. Nothing is ever unbounded. Ordinary commands default to 120s and
// are capped at 900s. Commands that are legitimately long here — benchmarks,
// builds, model servers, media renders, package upgrades — are recognised by
// program name and get a much longer default and cap instead.
//
// The allowlist is a convenience heuristic, NOT a security boundary: it decides
// how long something may run, never whether it may run. `blast-radius` is the
// gate that decides that, and it is unaffected by anything here.

export const DEFAULT_TIMEOUT_S = 120;
export const MAX_TIMEOUT_S = 900;
export const LONG_DEFAULT_TIMEOUT_S = 3600;
export const LONG_MAX_TIMEOUT_S = 21600;

// Programs whose whole purpose is to run for a long time.
// REDCODE_LONG_PROGRAMS adds your own, comma-separated: the list below cannot
// know that `train.py` or `render-all` is a six-hour job on your machine, and a
// project's long jobs are exactly the ones this policy would otherwise cut off
// at two minutes.
const LONG_PROGRAMS = new Set([
  // model servers and benchmark harnesses
  "llama-server", "ninfer-serve", "vllm", "ollama", "redcode",
  // media and model generation
  "comfyui", "ffmpeg",
  // builds and transfers
  "ninja", "make", "gradle", "mvn", "bazel",
  "rsync", "scp", "wget",
  ...(process.env.REDCODE_LONG_PROGRAMS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
]);

// Programs that are usually quick but have one long subcommand. Matching the
// bare program would hand a 6-hour cap to `git status`.
const LONG_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["pacman", "-Syu"], ["pacman", "-Syyu"], ["pacman", "-S"],
  ["apt", "install"], ["apt", "upgrade"], ["apt-get", "install"], ["apt-get", "upgrade"],
  ["dnf", "install"], ["dnf", "upgrade"], ["brew", "install"], ["brew", "upgrade"],
  ["git", "clone"], ["git", "fetch"],
  ["npm", "install"], ["npm", "ci"],
  ["pip", "install"], ["uv", "pip"],
  ["cargo", "build"], ["cargo", "test"],
  ["cmake", "--build"],
  ["docker", "build"], ["docker", "compose"],
  ["hf", "download"], ["huggingface-cli", "download"],
];

// Wrappers that precede the real program.
const PREFIXES = new Set(["sudo", "nohup", "time", "nice", "ionice", "env", "command", "exec", "stdbuf"]);

function basename(token: string): string {
  const cut = token.lastIndexOf("/");
  return cut === -1 ? token : token.slice(cut + 1);
}

/** Split into segments that each begin at a command position. */
function segments(command: string): string[] {
  return command
    .split(/\n|;|&&|\|\||\||&/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Drop `VAR=val` assignments and wrapper words to reach the real program. */
function programWords(segment: string): string[] {
  const words = segment.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length) {
    const w = words[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || PREFIXES.has(basename(w))) {
      i++;
      continue;
    }
    break;
  }
  return words.slice(i);
}

export function isLongRunning(command: string): boolean {
  for (const segment of segments(command)) {
    const words = programWords(segment);
    if (words.length === 0) continue;
    const program = basename(words[0]!);
    if (LONG_PROGRAMS.has(program)) return true;
    for (const [head, sub] of LONG_PAIRS) {
      if (program === head && words.slice(1).some((w) => w === sub)) return true;
    }
  }
  return false;
}

export interface ResolvedTimeout {
  /** Seconds actually handed to the built-in. Never undefined. */
  timeout: number;
  /** True when the model's own value was reduced. */
  clamped: boolean;
  /** True when the model supplied nothing and a default was injected. */
  defaulted: boolean;
  long: boolean;
}

export function resolveTimeout(command: string, requested: unknown): ResolvedTimeout {
  const long = isLongRunning(command);
  const max = long ? LONG_MAX_TIMEOUT_S : MAX_TIMEOUT_S;
  const fallback = long ? LONG_DEFAULT_TIMEOUT_S : DEFAULT_TIMEOUT_S;

  // Anything not a usable positive number is treated as absent, so a malformed
  // value becomes the default rather than reaching pi and throwing.
  const asked = typeof requested === "number" && Number.isFinite(requested) && requested > 0 ? requested : undefined;
  if (asked === undefined) return { timeout: fallback, clamped: false, defaulted: true, long };
  if (asked > max) return { timeout: max, clamped: true, defaulted: false, long };
  return { timeout: asked, clamped: false, defaulted: false, long };
}

/**
 * Replacement text for pi's bare "Command timed out after N seconds". A bare
 * failure invites the model to retry the same blocking command with a bigger
 * number; naming the detached pattern gives it somewhere to go instead.
 */
export function timeoutGuidance(resolved: ResolvedTimeout): string {
  const how =
    "If this command genuinely needs longer, do not raise the timeout — start it detached and poll it, e.g. " +
    "`nohup <cmd> > /tmp/job.log 2>&1 &` then read /tmp/job.log. " +
    "If it should have been fast, it is hung: check for a process waiting on input or an unclosed handle.";
  if (resolved.clamped) {
    return `The requested timeout was capped at ${resolved.timeout}s by redcode policy. ${how}`;
  }
  if (resolved.defaulted) {
    return `No timeout was set, so the redcode default of ${resolved.timeout}s applied. ${how}`;
  }
  return how;
}
