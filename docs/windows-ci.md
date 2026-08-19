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

On **failure** of either job, `mxschmitt/action-tmate` starts a tmate session
on the still-alive runner and prints the connection string in the Checks tab.
You then have ~30 minutes of a real Windows shell:

```sh
pacman -S tmate        # on your Linux box, if you don't have it
tmate <host> <password>
```

There is also a web terminal URL in the same log section. On a Git Bash
runner you can also start the profile by hand to watch it fail:

```bash
cd /d/a/redcode/redcode        # the checkout path
node scripts/mock-openai.mjs & # or point at your server
./scripts/windows-smoke.sh smoke
```

The `e2e` runner is on your tailnet, so you can instead RDP to it from any
tailnet box: the runner's hostname appears as `<name>.ts.net` in
`tailscale status` on your machine.

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