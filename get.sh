#!/usr/bin/env bash
# One-line bootstrap:
#   curl -fsSL https://raw.githubusercontent.com/duskoide/pi-config/main/get.sh | bash
#
# Env overrides: PI_CONFIG_DIR (checkout path), PI_CONFIG_REPO, PI_CONFIG_REF,
# plus everything install.sh accepts (PI_VERSION, PI_CONFIG_SKIP_EXTERNAL_INSTALLS, ...).
set -euo pipefail

REPO="${PI_CONFIG_REPO:-https://github.com/duskoide/pi-config.git}"
REF="${PI_CONFIG_REF:-main}"
DEST="${PI_CONFIG_DIR:-$HOME/pi-config}"

log() { printf 'bootstrap: %s\n' "$*"; }
fail() { printf 'bootstrap: error: %s\n' "$*" >&2; exit 1; }

for cmd in git node npm curl; do
  command -v "$cmd" >/dev/null 2>&1 || fail "$cmd is required"
done

if [[ -d "$DEST/.git" ]]; then
  log "updating existing checkout at $DEST"
  if [[ -n "$(git -C "$DEST" status --porcelain)" ]]; then
    log "local changes present; skipping pull"
  else
    git -C "$DEST" fetch --quiet origin "$REF"
    git -C "$DEST" checkout --quiet "$REF"
    git -C "$DEST" merge --ff-only --quiet "origin/$REF" || log "cannot fast-forward; keeping current checkout"
  fi
elif [[ -e "$DEST" ]]; then
  fail "$DEST exists and is not a git checkout"
else
  log "cloning $REPO ($REF) into $DEST"
  git clone --quiet --branch "$REF" "$REPO" "$DEST"
fi

exec "$DEST/install.sh"
