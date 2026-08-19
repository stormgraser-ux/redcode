#!/usr/bin/env bash
# windows-smoke.sh — run the redcode install on a clean machine and prove it
# actually works, from Git Bash.
#
#   ./scripts/windows-smoke.sh install
#     fingerprint, install.sh, unit tests, patch:check. No endpoint needed.
#
#   ./scripts/windows-smoke.sh smoke
#     the full round trip, as far as a machine can go:
#       1. start the local mock server (unless REDCODE_BASE_URL is set, which
#          is how the CI e2e job points it at the real server over the tailnet)
#       2. write redcode.json the way /connect does
#       3. select the model the way /model does
#       4. pi --list-models: proves the connect extension probed the server
#          and registered the provider
#       5. one real round trip through bin/redcode in --mode json, with the
#          event log asserted by scripts/assert-smoke.mjs
#       6. scripts/pi-patch-test.mjs: the compaction hook, driven with
#          synthetic turns against the real patched pi on this machine
#
# Environment (all optional):
#   REDCODE_BASE_URL   e.g. https://host.tailnet.ts.net:8449/v1
#   REDCODE_API_KEY    a key for that server (default: the mock's key)
#   REDCODE_MODEL      model id to use (default: the first the server lists)
#   REDCODE_NAME       provider name in redcode.json (default: ci)
#   SMOKE_PROMPT       the prompt to send (default: a fixed short one)
#   MOCK_PORT          port for the local mock (default: 18901)
#
# Runs under Git Bash on Windows and under plain bash on Linux/macOS, so the
# same script rehearses locally before it ever sees a runner.

set -euo pipefail

stage="${1:-smoke}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="${REDCODE_NAME:-ci}"
PROMPT="${SMOKE_PROMPT:-Reply with exactly: redcode-smoke-ok. One line, nothing else.}"

fail() { echo "smoke: FAIL: $*" >&2; exit 1; }

# ------------------------------------------------------------------- install
if [[ "$stage" == install ]]; then
    echo "== fingerprint"
    node --version
    npm --version
    git --version
    pi --version 2>/dev/null || fail "pi is not on PATH — npm install -g @earendil-works/pi-coding-agent"

    echo "== install.sh"
    bash "$REPO/install.sh"

    echo "== unit tests"
    node "$REPO/scripts/test.mjs"

    echo "== patch:check"
    node "$REPO/scripts/pi-patch" --check

    echo "install stage: OK"
    exit 0
fi

# --------------------------------------------------------------------- smoke
MOCK_PID=""
cleanup() {
    if [[ -n "$MOCK_PID" ]]; then
        kill "$MOCK_PID" 2>/dev/null || true
        wait "$MOCK_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT

if [[ -z "${REDCODE_BASE_URL:-}" ]]; then
    export REDCODE_BASE_URL="http://127.0.0.1:${MOCK_PORT:-18901}/v1"
    export REDCODE_API_KEY="${REDCODE_API_KEY:-mock-key}"
    echo "== starting the local mock (no REDCODE_BASE_URL set)"
    node "$REPO/scripts/mock-openai.mjs" "${MOCK_PORT:-18901}" &
    MOCK_PID=$!
    for _ in $(seq 1 50); do
        if curl -sf -H "Authorization: Bearer $REDCODE_API_KEY" \
            "$REDCODE_BASE_URL/models" >/dev/null 2>&1; then break; fi
        sleep 0.2
    done
    curl -sf -H "Authorization: Bearer $REDCODE_API_KEY" \
        "$REDCODE_BASE_URL/models" >/dev/null \
        || fail "mock server did not come up on $REDCODE_BASE_URL"
    echo "   mock ready at $REDCODE_BASE_URL"
else
    echo "== using real endpoint $REDCODE_BASE_URL"
fi

# What the server is serving. The first id is the default; REDCODE_MODEL
# overrides it, the way a human would pick in /model.
model_ids="$(curl -sf -H "Authorization: Bearer $REDCODE_API_KEY" \
    "$REDCODE_BASE_URL/models" \
    | node --input-type=module -e '
        let d = "";
        process.stdin.on("data", (c) => (d += c));
        process.stdin.on("end", () => {
            const ids = JSON.parse(d).data.map((m) => m.id).filter(Boolean);
            if (ids.length === 0) process.exit(1);
            process.stdout.write(ids.join(" "));
        });
    ')" || fail "the endpoint answered but listed no models"
MODEL="${REDCODE_MODEL:-${model_ids%% *}}"
echo "   endpoint '$NAME' serves: $(echo "$model_ids" | tr ' ' '\n' | head -5 | tr '\n' ' ')→ using $MODEL"

# ------------------------------------------------- endpoint + model selection
# The two writes below are exactly what /connect and /model do: redcode.json
# (0600, outside pi's settings) and the provider/model pair in settings.json
# (merged, never replaced).

pi_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -p "$pi_dir"
umask 077
cat > "$pi_dir/redcode.json" <<EOF
{
  "endpoints": [
    {
      "name": "$NAME",
      "baseUrl": "$REDCODE_BASE_URL",
      "apiKey": "$REDCODE_API_KEY"
    }
  ]
}
EOF

SEL_FILE="$pi_dir/settings.json" SEL_PROVIDER="$NAME" SEL_MODEL="$MODEL" node --input-type=module -e '
    import { existsSync, readFileSync, writeFileSync } from "node:fs";
    const { SEL_FILE, SEL_PROVIDER, SEL_MODEL } = process.env;
    let s = {};
    if (existsSync(SEL_FILE)) {
        try { s = JSON.parse(readFileSync(SEL_FILE, "utf8")); } catch { s = {}; }
    }
    s.provider = SEL_PROVIDER;
    s.model = SEL_MODEL;
    writeFileSync(SEL_FILE, JSON.stringify(s, null, 2) + "\n");
'
echo "== wrote $pi_dir/redcode.json and selected $NAME/$MODEL in settings.json"

# ------------------------------------------------------- list-models (probe)
# The connect extension probes every configured endpoint at load and registers
# the ones that answer, so the model appearing here proves: extension loaded,
# network path works (tailnet or loopback), server answered, key accepted.
echo "== pi --list-models"
list_out="$(pi --list-models)"
# --list-models prints columns (provider  model  context  …), so match the
# first two fields of a line rather than a "provider/model" substring.
awk -v p="$NAME" -v m="$MODEL" '$1 == p && $2 == m { found = 1 } END { exit !found }' \
    <<<"$list_out" \
    || { echo "$list_out"; fail "$NAME / $MODEL not in --list-models"; }
echo "   $NAME / $MODEL is listed"

# ------------------------------------------------- one real round trip
echo "== round trip: bin/redcode --mode json"
workdir="$(mktemp -d)"
out="$workdir/events.jsonl"
err="$workdir/stderr.log"

set +e
(
    cd "$workdir"
    "$REPO/bin/redcode" --mode json --provider "$NAME" --model "$MODEL" "$PROMPT" \
        >"$out" 2>"$err"
)
rc=$?
set -e

if [[ $rc -ne 0 ]]; then
    echo "----- pi stderr -----"; cat "$err"
    echo "----- events (tail) -----"; tail -30 "$out" 2>/dev/null || true
    fail "pi exited $rc"
fi

node "$REPO/scripts/assert-smoke.mjs" "$out" "$NAME" "$MODEL" \
    || { echo "----- pi stderr -----"; cat "$err"; fail "event log assertions failed"; }

# ------------------------------------------------- patch behaviour on this OS
echo "== pi-patch-test (compaction hook, real pi on this machine)"
node "$REPO/scripts/pi-patch-test.mjs"

rm -rf "$workdir"
echo "smoke stage: OK"