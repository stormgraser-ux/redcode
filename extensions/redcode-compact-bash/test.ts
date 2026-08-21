// Run:
//   node --experimental-strip-types test.ts

import {
  DEFAULT_TIMEOUT_S,
  LONG_DEFAULT_TIMEOUT_S,
  LONG_MAX_TIMEOUT_S,
  MAX_TIMEOUT_S,
  resolveTimeout,
} from "./timeout.ts";
import { isShort, summarise } from "./summarise.ts";

const HEREDOC_CASE = [
  "cat > /tmp/ub_interactive.py <<'EOF'",
  "import json, subprocess",
  "def sh(cmd): return subprocess.check_output(cmd, shell=True)",
  "EOF",
  "cat /tmp/ub_interactive.py | ssh deploy@nas.example 'python3 -'",
].join("\n");

const cases: [name: string, command: string, head: string, hidden: number][] = [
  ["one-liner untouched", "ls -la", "ls -la", 0],
  ["two lines untouched", "ls -la\necho hi", "ls -la\necho hi", 0],
  ["the real heredoc", HEREDOC_CASE, "cat > /tmp/ub_interactive.py <<EOF", 4],
  ["unquoted heredoc", "cat > a.py <<EOF\nx=1\ny=2\nEOF", "cat > a.py <<EOF", 3],
  ["dash heredoc", "cat <<-EOF\na\nb\nEOF", "cat <<EOF", 3],
  ["double-quoted delimiter", 'cat > a <<"END"\nx\nEND', "cat > a <<END", 2],
  [
    "plain multiline falls back to first line",
    "echo one\necho two\necho three\necho four",
    "echo one",
    3,
  ],
  ["heredoc-looking but no delimiter", "echo a << b c\nx\ny\nz", "echo a << b c", 3],
];

let pass = 0;
const fails: string[] = [];
for (const [name, command, head, hidden] of cases) {
  const got = summarise(command);
  if (got.head === head && got.hidden === hidden) pass++;
  else fails.push(`  ${name}: expected {${JSON.stringify(head)}, ${hidden}}, got {${JSON.stringify(got.head)}, ${got.hidden}}`);
}

// isShort must agree with summarise's no-op case, or the renderer and the
// summariser disagree about when to collapse.
for (const [name, command, , hidden] of cases) {
  const expected = hidden === 0;
  if (isShort(command) === expected) pass++;
  else fails.push(`  ${name}: isShort disagreed with summarise`);
}

// --- timeout policy -------------------------------------------------------
// The property that matters: nothing is ever unbounded. Everything else is
// about not strangling the jobs that legitimately take an hour.
const timeoutCases: [name: string, command: string, requested: unknown, expected: number][] = [
  ["omitted becomes the default", "ls -la", undefined, DEFAULT_TIMEOUT_S],
  ["the 2382s hang is now bounded", "cd /x && node --experimental-strip-types overlay.test.ts", undefined, DEFAULT_TIMEOUT_S],
  ["a sane value is honoured", "sleep 30", 30, 30],
  ["1700s is clamped", "sleep 2000", 1700, MAX_TIMEOUT_S],
  ["120000s is clamped", "sleep 2000", 120000, MAX_TIMEOUT_S],
  ["zero is treated as absent", "ls", 0, DEFAULT_TIMEOUT_S],
  ["a string is treated as absent", "ls", "60", DEFAULT_TIMEOUT_S],
  ["NaN is treated as absent", "ls", Number.NaN, DEFAULT_TIMEOUT_S],
  ["long tool gets the long default", "make -j8", undefined, LONG_DEFAULT_TIMEOUT_S],
  ["long tool still capped", "make -j8", 999999, LONG_MAX_TIMEOUT_S],
  ["long tool honours a smaller value", "ninja -C build", 300, 300],
  ["long tool after cd", "cd ~/src/project/build && ninja app", undefined, LONG_DEFAULT_TIMEOUT_S],
  ["long tool behind sudo", "sudo pacman -Syu", undefined, LONG_DEFAULT_TIMEOUT_S],
  ["long tool with env prefix", "CUDA_VISIBLE_DEVICES=0 ffmpeg -i in.mov out.mp4", undefined, LONG_DEFAULT_TIMEOUT_S],
  ["absolute path is matched", "/usr/local/bin/rsync -a src/ dst/", undefined, LONG_DEFAULT_TIMEOUT_S],
  ["long tool later in a pipeline", "cat x | ffmpeg -i - out.mp4", undefined, LONG_DEFAULT_TIMEOUT_S],
  ["quick git is NOT long", "git status", undefined, DEFAULT_TIMEOUT_S],
  ["git clone IS long", "git clone https://example/x.git", undefined, LONG_DEFAULT_TIMEOUT_S],
  ["node is never long", "node server.js", undefined, DEFAULT_TIMEOUT_S],
  ["merely naming a tool is not enough", "echo ninja > /tmp/x", undefined, DEFAULT_TIMEOUT_S],
];
for (const [name, command, requested, expected] of timeoutCases) {
  const got = resolveTimeout(command, requested);
  if (got.timeout === expected) pass++;
  else fails.push(`  ${name}: expected ${expected}s, got ${got.timeout}s`);
}

// The invariant, stated directly.
const unbounded = timeoutCases.filter(([, c, r]) => !Number.isFinite(resolveTimeout(c, r).timeout));
if (unbounded.length === 0) pass++;
else fails.push(`  ${unbounded.length} command(s) resolved to an unbounded timeout`);

const total = cases.length * 2 + timeoutCases.length + 1;
console.log(`${pass}/${total} passed`);
if (fails.length) { console.log("FAILURES:\n" + fails.join("\n")); process.exit(1); }
