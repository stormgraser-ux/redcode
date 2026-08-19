import { classifyCommand, worst } from "./classify.ts";

const HOME = "/home/dev";
const CWD = "/home/dev/code/redcode";

type Case = [expected: string, command: string, cwd?: string];

const cases: Case[] = [
  // ---- the user's stated rules ----
  ["deny",   "rm -rf ~"],
  ["deny",   "rm -rf /home/dev"],
  ["deny",   "rm -rf $HOME"],
  ["deny",   "rm -rf ~/code"],
  ["deny",   "rm -rf ~/code/"],
  ["prompt", "rm -rf ~/code/sweepsites"],
  ["allow",  "rm -rf ~/code/sweepsites/src"],
  ["allow",  "rm -rf ~/code/sweepsites/src/api/handlers"],

  // ---- globs collapse to their parent ----
  ["deny",   "rm -rf ~/code/*"],
  ["prompt", "rm -rf ~/code/sweepsites/*"],
  ["allow",  "rm -rf ~/code/sweepsites/src/*"],

  // ---- relative paths resolve against cwd (cwd = ~/code/redcode) ----
  ["allow",  "rm -rf build"],
  ["allow",  "rm -rf ./dist"],
  ["deny",   "rm -rf ..",        "/home/dev/code/redcode"],   // -> ~/code, the anchor itself
  ["deny",   "rm -rf ../..",     "/home/dev/code/redcode"],   // -> ~

  // ---- paths that cannot be resolved at all ----
  // normalise() returns null once `..` pops past the root, and a target the
  // classifier cannot name is one it must not vouch for, so these land on
  // prompt. An earlier version signalled this with a NUL-prefixed sentinel
  // string; that made the source binary to git, and any editor stripping
  // control characters would have turned "unresolvable" back into an ordinary
  // relative path — failing open, in a guardrail.
  ["prompt", "rm -rf ../../../../../../../../..", "/home/dev/code/redcode"],
  ["prompt", "rm -rf /../..",                     "/home/dev/code/redcode"],
  ["prompt", "rm -rf ~otheruser/x",               "/home/dev/code/redcode"],

  // ---- system roots ----
  ["deny",   "rm -rf /"],
  ["deny",   "rm -rf /home"],
  ["deny",   "rm -rf /etc"],
  ["deny",   "rm -rf /usr/lib"],          // contains nothing guarded, but /usr is a root ancestor
  ["deny",   "rm -rf --no-preserve-root /"],
  ["deny",   "sudo rm -rf /var"],

  // ---- precious small trees ----
  ["prompt", "rm -rf ~/.ssh/id_ed25519"],
  ["deny",   "rm -rf ~/.ssh"],
  ["prompt", "rm -rf ~/.config/hypr"],
  ["prompt", "rm -rf ~/models/qwen"],
  ["prompt", "rm -rf ~/bin/pixelgen"],

  // ---- scratch is free ----
  ["allow",  "rm -rf /tmp/foo"],
  ["allow",  "rm -rf /tmp/a/b/c"],
  ["deny",   "rm -rf /tmp"],
  ["allow",  "rm -rf ~/.cache/uv"],

  // ---- non-recursive rm is never touched ----
  ["allow",  "rm file.txt"],
  ["allow",  "rm -f ~/code/sweepsites/package.json"],
  ["allow",  "rm ~/code/sweepsites/a.js ~/code/sweepsites/b.js"],

  // ---- unresolvable targets escalate, never pass ----
  ["prompt", "rm -rf $SOMEDIR"],
  ["prompt", "rm -rf $(cat list.txt)"],
  ["prompt", "rm -rf ~otheruser/stuff"],

  // ---- chained commands: worst segment wins ----
  ["deny",   "cd /tmp && rm -rf ~/code"],
  ["allow",  "npm run build && rm -rf ./dist"],
  ["prompt", "echo hi; rm -rf ~/code/sweepsites"],

  // ---- catastrophic verbs ----
  ["deny",   "mkfs.ext4 /dev/sda1"],
  ["deny",   "dd if=/dev/zero of=/dev/sda"],
  ["deny",   "shred -u /home/dev/.ssh/id_rsa"],
  ["allow",  "dd if=/dev/zero of=/tmp/testfile bs=1M count=10"],

  // ---- recursive ownership ----
  ["deny",   "sudo chmod -R 777 /usr"],
  ["allow",  "chmod -R 755 ~/code/sweepsites/scripts"],

  // ---- find -delete ----
  ["deny",   "find / -name '*.tmp' -delete"],
  ["allow",  "find ~/code/sweepsites/tmp -name '*.log' -delete"],

  // ---- git ----
  ["prompt", "git reset --hard HEAD~3"],
  ["prompt", "git clean -xfd"],
  ["allow",  "git status"],
  ["allow",  "git commit -m 'wip'"],

  // ---- ordinary work must never be disturbed ----
  ["allow",  "ls -la"],
  ["allow",  "grep -r foo src/"],
  ["allow",  "cargo build --release"],
  ["allow",  "docker compose up -d"],
  ["allow",  "python3 script.py"],
  ["allow",  "mv old.txt new.txt"],
];

let pass = 0;
const fails: string[] = [];
for (const [expected, command, cwd] of cases) {
  const findings = classifyCommand(command, cwd ?? CWD, HOME);
  const w = worst(findings);
  const got = w ? w.verdict : "allow";
  if (got === expected) pass++;
  else fails.push(`  expected ${expected.padEnd(6)} got ${got.padEnd(6)}  ${command}${w ? `   [${w.reason}]` : ""}`);
}

console.log(`${pass}/${cases.length} passed`);
if (fails.length) {
  console.log("FAILURES:");
  console.log(fails.join("\n"));
  process.exit(1);
}
