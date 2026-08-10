#!/usr/bin/env bash
set -euo pipefail

# Install and activate the checked-in Pi configuration without replacing
# credentials, sessions, caches, or other runtime data.

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PI_DIR="${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}"
PI_VERSION="0.84.1"

log() { printf 'pi-config: %s\n' "$*"; }
fail() { printf 'pi-config: error: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "Node.js is required"
command -v npm >/dev/null 2>&1 || fail "npm is required"

if ! command -v pi >/dev/null 2>&1 || [[ "$(pi --version 2>/dev/null || true)" != "$PI_VERSION" ]]; then
  log "installing Pi ${PI_VERSION}"
  npm install --global --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}"
fi

mkdir -p "$PI_DIR"

link_static() {
  local source="$1"
  local relative="${source#"$REPO_DIR/.pi/agent/"}"
  local destination="$PI_DIR/$relative"
  mkdir -p "$(dirname -- "$destination")"

  if [[ -L "$destination" && "$(readlink -f -- "$destination" 2>/dev/null || true)" == "$source" ]]; then
    return
  fi
  if [[ -e "$destination" || -L "$destination" ]]; then
    local backup="${destination}.pre-pi-config.$(date +%Y%m%d%H%M%S)"
    mv -- "$destination" "$backup"
    log "moved existing ${relative} to ${backup##*/}"
  fi
  ln -s -- "$source" "$destination"
}

while IFS= read -r -d '' source; do
  link_static "$source"
done < <(
  find "$REPO_DIR/.pi/agent" -type f \
    ! -path '*/node_modules/*' \
    ! -name '*.cache.json' \
    ! -name 'auth.json' \
    ! -path '*/sessions/*' \
    ! -path '*/state/*' \
    -print0
)

# Install the local package's runtime dependency from its lockfile.
if [[ -f "$REPO_DIR/pi-herdr-worker/package-lock.json" ]]; then
  npm ci --omit=dev --prefix "$REPO_DIR/pi-herdr-worker" >/dev/null
fi

export PI_CODING_AGENT_DIR="$PI_DIR"

# Reconcile every pinned package into Pi's package cache. Running this after
# linking settings makes a clone self-contained instead of relying on a
# package cache copied from another machine. pi install is idempotent for an
# already-installed exact source.
while IFS= read -r package_source; do
  [[ -n "$package_source" ]] || continue
  log "installing ${package_source}"
  pi install --no-approve "$package_source" >/dev/null
 done < <(node -e 'for (const source of require(process.argv[1]).packages ?? []) console.log(source)' "$PI_DIR/settings.json")

log "checking Pi configuration"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));' \
  "$PI_DIR/settings.json" "$REPO_DIR/pi-herdr-worker/package.json"
pi --version
log "ready; authenticate with /login on this machine"
