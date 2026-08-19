// policy.ts — the tunable part. Edit this file, not classify.ts.
//
// The model is BLAST RADIUS, not permissions. A destructive command is judged
// by how much it can destroy, which is decided by how deep its target sits
// below a guarded anchor:
//
//   depth 0  (the anchor itself)      -> deny    e.g. rm -rf ~/code
//   depth <= promptDepth              -> prompt  e.g. rm -rf ~/code/sweepsites
//   deeper                            -> allow   e.g. rm -rf ~/code/sweepsites/src
//
// The intent is that the agent works freely and only ever stops at the point
// where a slip would destroy something whole. Ordinary edits, ordinary bash,
// and ordinary single-file deletes are never touched by this.

export type Verdict = "allow" | "prompt" | "deny";

/** Anchors below $HOME. `promptDepth` is how many levels below the anchor
 *  still deserve a confirmation. Use a large number to mean "always ask
 *  inside this tree" (for small, precious directories). */
export interface Anchor {
  path: string;        // absolute, $HOME already expanded
  promptDepth: number;
  why: string;
}

export function anchors(home: string): Anchor[] {
  return [
    // Projects. A project root is worth a confirmation; anything inside a
    // project is the agent's normal working area and is allowed outright.
    { path: `${home}/code`, promptDepth: 1, why: "a whole project" },
    { path: `${home}/tools`, promptDepth: 1, why: "a whole tool/MCP install" },

    // Config and identity. Small directories where losing one entry hurts,
    // so the prompt tier reaches further down.
    { path: `${home}/.ssh`, promptDepth: 99, why: "SSH keys" },
    { path: `${home}/.gnupg`, promptDepth: 99, why: "GPG keys" },
    { path: `${home}/.config`, promptDepth: 2, why: "app configuration" },
    { path: `${home}/dotfiles`, promptDepth: 2, why: "tracked dotfiles" },
    { path: `${home}/.claude`, promptDepth: 2, why: "Claude Code state" },
    { path: `${home}/.pi`, promptDepth: 2, why: "pi state" },

    // Expensive to reproduce.
    { path: `${home}/models`, promptDepth: 1, why: "downloaded model weights" },
    { path: `${home}/bin`, promptDepth: 1, why: "a launcher script" },
    { path: `${home}/Documents`, promptDepth: 1, why: "documents" },
  ];
}

/** Paths that are never a legitimate target for a recursive delete, whatever
 *  the depth. Also denied if the target is an ANCESTOR of one of these. */
export function alwaysDeny(home: string): string[] {
  return [
    "/", "/home", home,
    "/etc", "/usr", "/var", "/boot", "/bin", "/sbin", "/lib", "/lib64",
    "/opt", "/srv", "/proc", "/sys", "/dev", "/run", "/mnt", "/media", "/nix",
    "/swap", "/tmp",
  ];
}

/** Trees where recursive deletion is always fine below the top level. */
export function scratch(home: string): string[] {
  return ["/tmp", "/var/tmp", `${home}/.cache`, `${home}/Downloads`];
}

/** Fallback for a path under $HOME that matches no anchor above:
 *  depth 1 (e.g. ~/Pictures) prompts, anything deeper is allowed. */
export const HOME_FALLBACK_PROMPT_DEPTH = 1;

/** Commands that destroy a filesystem or a device outright. Always denied;
 *  there is no depth argument that makes these safe. Mirrors the hard safety
 *  rules in CLAUDE.md. */
export const CATASTROPHIC = [
  "mkfs", "mkswap", "fdisk", "sfdisk", "cfdisk", "parted", "sgdisk",
  "wipefs", "shred", "blkdiscard", "badblocks", "hdparm", "nvme",
];

/** Treat `git reset --hard` / `git clean -xfd` as prompt-tier: they destroy
 *  uncommitted work, which no amount of depth makes recoverable.
 *  Set to false if this gets annoying. */
export const GUARD_DESTRUCTIVE_GIT = true;
