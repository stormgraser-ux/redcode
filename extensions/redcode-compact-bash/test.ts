// Run:
//   node --experimental-strip-types test.ts
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

console.log(`${pass}/${cases.length * 2} passed`);
if (fails.length) { console.log("FAILURES:\n" + fails.join("\n")); process.exit(1); }
