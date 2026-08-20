#!/usr/bin/env bash
# install.sh — put the redcode profile into ~/.pi/agent.
#
# Linux, macOS, and Windows under Git Bash. pi already requires bash on Windows,
# so there is one installer rather than a PowerShell copy that drifts out of
# sync with this one.
#
#   ./install.sh              copy the profile in (default)
#   ./install.sh --link       symlink instead, so `git pull` updates it live
#   ./install.sh --uninstall  remove what this installed, restore the backup
#
# NOTHING IS OVERWRITTEN WITHOUT A BACKUP. Anything displaced goes to
# ~/.pi/agent/.redcode-backup-<timestamp>/, and --uninstall puts the most recent
# one back.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Same override pi itself honours, so a sandbox install and the pi that reads it
# cannot disagree about where the profile went.
PI_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
EXT_DIR="$PI_DIR/extensions"
THEME_DIR="$PI_DIR/themes"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$PI_DIR/.redcode-backup-$STAMP"

MODE=copy
for arg in "$@"; do
    case "$arg" in
        --link) MODE=link ;;
        --uninstall) MODE=uninstall ;;
        -h|--help) sed -n '2,16p' "$0" | sed 's|^# \{0,1\}||'; exit 0 ;;
        *) echo "install.sh: unknown option '$arg'" >&2; exit 2 ;;
    esac
done

say() { printf '  %s\n' "$1"; }

# ------------------------------------------------------------------ uninstall
if [[ "$MODE" == uninstall ]]; then
    echo "redcode: uninstalling from $PI_DIR"
    for d in "$REPO"/extensions/*/; do
        name="$(basename "$d")"
        if [[ -e "$EXT_DIR/$name" || -L "$EXT_DIR/$name" ]]; then
            rm -rf "$EXT_DIR/$name"
            say "removed extension $name"
        fi
    done
    [[ -e "$THEME_DIR/crimson.json" || -L "$THEME_DIR/crimson.json" ]] &&
        rm -f "$THEME_DIR/crimson.json" && say "removed theme crimson"

    # Newest backup first. `ls -d` on a glob that matches nothing expands to the
    # literal pattern, hence the -d test before trusting it.
    latest="$(ls -1d "$PI_DIR"/.redcode-backup-* 2>/dev/null | sort | tail -1 || true)"
    if [[ -n "$latest" && -d "$latest" ]]; then
        cp -r "$latest"/. "$PI_DIR"/ 2>/dev/null || true
        say "restored what was displaced, from $(basename "$latest")"
    fi
    echo
    echo "Your endpoint config at $PI_DIR/redcode.json was NOT touched."
    echo "Delete it by hand if you want the stored API key gone."
    exit 0
fi

# --------------------------------------------------------------- requirements
if ! command -v pi >/dev/null 2>&1; then
    echo "redcode: pi is not installed." >&2
    echo "  npm install -g @earendil-works/pi-coding-agent" >&2
    exit 1
fi
if ! command -v node >/dev/null 2>&1; then
    echo "redcode: node is not on PATH (pi needs it)." >&2
    exit 1
fi

echo "redcode: installing into $PI_DIR ($MODE)"
mkdir -p "$EXT_DIR" "$THEME_DIR"

# --------------------------------------------------------------------- install
install_one() {
    local src="$1" dest="$2" label="$3"
    if [[ -e "$dest" || -L "$dest" ]]; then
        mkdir -p "$(dirname "$BACKUP/${dest#$PI_DIR/}")"
        mv "$dest" "$BACKUP/${dest#$PI_DIR/}"
        say "backed up existing $label"
    fi
    if [[ "$MODE" == link ]]; then
        ln -s "$src" "$dest"
        # Git Bash fakes ln -s with a copy unless MSYS=winsymlinks:nativestrict
        # AND Windows developer mode is on. It exits 0 either way, so --link
        # silently degrades to --copy and `git pull` stops updating the profile.
        # Say so rather than let it be discovered months later.
        if [[ ! -L "$dest" ]]; then
            say "note: $label was COPIED, not linked (this shell cannot make symlinks)"
        fi
    else
        cp -r "$src" "$dest"
    fi
    say "installed $label"
}

for d in "$REPO"/extensions/*/; do
    name="$(basename "$d")"
    install_one "${d%/}" "$EXT_DIR/$name" "extension $name"
done
install_one "$REPO/themes/crimson.json" "$THEME_DIR/crimson.json" "theme crimson"

# ------------------------------------------------------------------- settings
# Settings are MERGED, never replaced: this file holds the user's provider, API
# keys for other providers, and their own preferences. Clobbering it to set a
# theme would be an absurd trade.
node "$REPO/scripts/merge-settings.mjs" \
    "$PI_DIR/settings.json" "$REPO/settings/settings.defaults.json"

# Keybindings, same merge rules. redcode-modes binds shift+tab, which pi ships
# bound to app.thinking.cycle; pi refuses an extension shortcut that collides
# with a live built-in and logs "conflicts with built-in shortcut. Skipping."
# Unbinding the built-in is what frees the key. This was missing for the first
# releases and went unnoticed because the developer's own machine had the file
# by hand — a fresh install got modes with no way to reach them.
node "$REPO/scripts/merge-settings.mjs" \
    "$PI_DIR/keybindings.json" "$REPO/settings/keybindings.defaults.json"

# --------------------------------------------------------------------- patches
if ! node "$REPO/scripts/pi-patch"; then
    say "pi-patch did not apply — redcode still works, see scripts/pi-patch output above"
fi

[[ -d "$BACKUP" ]] && say "displaced files are in $BACKUP"

cat <<EOF

Installed. Next:

  1. Start it:      $REPO/bin/redcode
     (or add $REPO/bin to PATH, or just run \`pi\`)
  2. Connect:       /connect
     You need a base URL and an API key from whoever runs the model server.
  3. Choose model:  /model

The key is stored in $PI_DIR/redcode.json, owner-readable only.
EOF
