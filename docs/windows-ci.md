# Testing redcode on a fresh Windows machine

`.github/workflows/windows-smoke.yml` runs the README's Windows install path
on a **pristine GitHub-hosted Windows image** — no pi, no redcode, no
leftover config, the state a real first-time user starts from. A local VM is
worse at simulating that: it accumulates state the moment you install
anything once, and you end up testing on a machine you already contaminated.

GitHub-hosted Windows minutes burn at 2x (2000 private / free public), so the
workflow splits by cost:

| Job | When it runs | Needs secrets | What it proves |
|---|---|---|---|
| `install-smoke` (Node 22 **and** 24) | every push/PR to `main` | none | fresh install: `npm i -g pi`, `install.sh` under Git Bash, unit tests, `pi-patch`, and one full round trip of real pi + real profile + real client against the bundled mock server |
| `e2e` | "Run workflow" with **run-e2e** checked | yes | the same, but the runner joins your tailnet and the round trip goes to your real model server with a real key — TLS, tailnet DNS, and the model's actual request shape included |
| `desktop` | "Run workflow" with **run-desktop** checked | yes | nothing, automatically. It installs *nothing* and hands you the pristine machine over Remote Desktop so you can drive the install by hand and watch it — see *Driving the install by hand* |

On **failure** of a manually-dispatched run, `mxschmitt/action-tmate` starts a
tmate session on the still-alive runner and prints the connection string in
the Checks tab. You then have ~30 minutes of a real Windows shell:

```sh
pacman -S tmate        # on your Linux box, if you don't have it
tmate <host> <password>
```

tmate is pinned to `limit-access-to-actor: true`, so only the GitHub account
that dispatched the run can attach, authenticating with that account's SSH
keys. **This repo is public and Actions logs are world-readable** — without
that pin the printed connection string is an open shell to anyone watching a
red run, and on the tailnet-joined `e2e` runner that shell is inside your
tailnet holding a live key to your model server. For the same reason tmate
only arms on `workflow_dispatch`: a failing pull request from a stranger's
fork must not hand its author a session.

There is also a web terminal URL in the same log section. On a Git Bash
runner you can also start the profile by hand to watch it fail:

```bash
cd /d/a/redcode/redcode        # the checkout path
node scripts/mock-openai.mjs & # or point at your server
./scripts/windows-smoke.sh smoke
```

tmate is the interactive path for a *failed* run. To drive a machine
deliberately, use the `desktop` job below — the `e2e` runner has Remote
Desktop off and no usable password on `runneradmin`, so it is not reachable
that way.

## Driving the install by hand

The point of the `desktop` job: a genuinely fresh Windows machine, on your
tailnet, with a mouse — without ever building or maintaining a local VM.

1. **Actions → Windows smoke → Run workflow**, tick **run-desktop**, set
   **desktop-minutes** (default 45), run it.
2. Wait for the *Where to connect* step to print an address (about a
   minute).
3. On your Linux box:

   ```sh
   redcode-ci-desktop            # finds the runner on the tailnet
   redcode-ci-desktop 100.x.y.z  # or name it explicitly
   ```

   That wrapper reads the password from
   `~/.config/redcode/ci-rdp-password` and feeds it to FreeRDP on **stdin** —
   never as `/p:<password>`, because argv is world-readable through `ps`.
   GitHub secrets cannot be read back, so that local file is the only
   readable copy of `RDP_PASSWORD`; rotate the two together or you get a
   bare auth failure with no explanation.
4. You land on the pristine desktop. There is a `START-HERE.txt` on it with
   the install steps and the Windows-specific things that tend to bite
   (Git Bash vs PowerShell, CRLF checkouts, paths with spaces).
5. **Do not close the console window on that desktop.** It is titled
   `DO-NOT-CLOSE` and starts minimised, because it is not a log viewer —
   it is the Actions job itself. Closing it terminates the run and the
   machine is destroyed within seconds, which from your end looks exactly
   like the tailnet dropping. Expect to lose a session and some time to
   this once if you forget.
6. **Cancel the run** when you are done. The clock bills at 2x either way.

The machine is destroyed at the end of the run. Nothing you do on it
persists — which is the feature: the next run is pristine again, with no VM
image rotting on your disk between attempts.

### What this costs you, in security terms

The `desktop` job makes the runner **listen** on 3389 on a tailnet
interface. `tmate` never listens at all — it dials out. That difference is
the whole risk delta, and it is why the job is opt-in per run:

- **Tag the auth key.** This matters more than the open port. An untagged
  key joins the ephemeral runner as *your user's device*, inheriting your
  rights across the entire tailnet. Tagged and scoped, a compromised runner
  reaches one TCP port on one host instead of roaming. See *Scoping the CI
  tag* below — the rule is short, but there are four ways to write it that
  do not do what they look like they do.
- **`RDP_PASSWORD` must be long and random.** The job refuses to start
  under 20 characters. GitHub masks secrets in logs, but masking is
  best-effort and any transform of the value defeats it — so the workflow
  never echoes it, not even partially.
- **NLA stays on**, so an unauthenticated peer cannot open a session at all.
- **The runner is GitHub's computer**, briefly inside your private network.
  Do not sign into anything on it you would not sign into on a stranger's
  laptop. The job deliberately puts no model-server key in its environment.

### Scoping the CI tag

What `tag:ci` actually needs to reach is **one port on one host**: the
`tailscale serve` front door for the model server (`:8449` here). Not the
engine's loopback port, not the other engines' ports, not SSH, not anything
else. The `desktop` job needs *no* outbound tailnet access at all — RDP is
you reaching **it**, which your own user rule already covers, because `*` as
a destination includes tagged nodes.

So the addition is one grant:

```jsonc
{
  "hosts": {
    // A bare MagicDNS name is NOT a valid dst. Declare it here (or use the
    // raw 100.x address) or the policy fails to validate.
    "model-server": "100.101.102.103"   // your host's own 100.x address
  },
  "tagOwners": {
    // Prefer your own address over autogroup:admin. Owner and Admin are
    // separate roles in Tailscale, and you want to be certain you can mint
    // the key.
    "tag:ci": ["you@example.com"]
  },
  "grants": [
    // ... your existing grants stay exactly as they are ...
    { "src": ["tag:ci"], "dst": ["model-server"], "ip": ["tcp:8449"] }
  ]
}
```

Four ways to get this wrong, all of which look fine until they aren't:

1. **`autogroup:member` is wider than `autogroup:owner`, not narrower.** It
   is every non-shared user in the tailnet, so reaching for it while
   "tightening" hands every human member whatever you granted. If your
   policy scopes a rule to `autogroup:owner`, leave it there.
2. **Only narrow a `src: ["*"]` rule if you actually have one.** `*` does
   cover tagged nodes, so a wildcard grant would nullify the `tag:ci` scope
   above — but that wildcard is Tailscale's *starter* policy for a fresh
   tailnet, not something every tailnet has. Read your live policy before
   "fixing" it. `autogroup:owner` already excludes tagged devices, since a
   tagged device has no user identity.
3. **Add to the policy, do not replace it.** Rules for other people are easy
   to drop on the floor when you paste a fresh block.
4. **Shared users are not members.** An external user your tailnet shares a
   node *out* to is excluded by `autogroup:member`, so a member-scoped rule
   will not cover them.

Stay in one dialect. `grants` supersedes the legacy `acls` array; they can
legally coexist, but there is no reason to split one policy across both.

## One-time setup (for the e2e job)

1. **Tailscale auth key.** Admin console → *Keys* → *Create auth key*.
   Reusable (not expiring) is what a recurring workflow wants. Optionally
   give it a tag (e.g. `tag:ci`) and uncomment the `tags:` line in the
   workflow — the tag is what your ACL keys off. If your tailnet uses
   device approval, the action's ephemeral node is pre-approved.

2. **Repository secrets** (repo → Settings → Secrets and variables →
   Actions):

   | Secret | Value |
   |---|---|
   | `TAILSCALE_AUTHKEY` | the key from step 1 |
   | `REDCODE_BASE_URL` | exactly what you put in `/connect`, e.g. `https://host.your-tailnet.ts.net:8449/v1` |
   | `REDCODE_API_KEY` | a key for that server. Use a dedicated revocable CI key if your server supports several — the key never leaves the runner (it is written to `redcode.json` on the ephemeral VM and used in-process) |
   | `REDCODE_MODEL` | *(optional)* model id to test; default is the first model the server lists |
   | `RDP_PASSWORD` | *(only for the `desktop` job)* a long random password for `runneradmin`. Keep a readable copy at `~/.config/redcode/ci-rdp-password` — GitHub will not give it back to you |

3. **ACL.** The ephemeral runner node must be able to reach the model
   server. On a default-ACL tailnet (all of your devices talk to each
   other) there is nothing to do; with a custom ACL or a tagged key, allow
   the node to the server's port.

## Reading a run

- **`install-smoke`** green means: Git Bash ran the installer, the profile
  landed in `~/.pi/agent`, all unit tests passed on Windows, the patches
  anchored against this week's pi, and a real `pi --mode json` round trip
  completed through the profile's connect extension and the OpenAI
  client — against the mock, i.e. everything except your server.
- **`e2e`** green means the same with your tailnet, TLS, and model in the
  loop: the probe answered, the model answered, the response stopped on
  `stop` and said something.
- **`pi-patch: FAILED`** on a green install means pi moved its source and
  the anchors need re-deriving (the job tells you which anchors). Re-run
  after updating `scripts/pi-patch`; that is the normal upgrade dance.
- If `--list-models` shows the provider but the round trip fails, the
  event log and pi's stderr are dumped into the log above the failure —
  that is the layer to read before reaching for tmate.

## Notes and trade-offs

- **Node version.** The matrix tests 22 and 24 via `setup-node`, the two LTS
  lines a user plausibly has. The image also ships its own Node; delete the
  `setup-node` step (and the matrix) if you want to test that one instead.
- **The runner is destroyed after the workflow.** Anything you discover in
  tmate is a pointer, not a fix — the fix has to land in the repo.
- **tmate on Windows** runs inside the image's MSYS2 (`C:\msys64`); the
  connection string is an msys2 bash shell, not PowerShell. Both reach the
  same files.
- **Nothing here talks to your model server on automatic runs** — only the
  manual e2e job does, and only to the one endpoint in the secrets.