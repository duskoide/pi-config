#!/usr/bin/env bash
set -euo pipefail

# Install Pi and Herdr and activate the checked-in configuration for both
# without replacing credentials, sessions, caches, or other runtime data.

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PI_DIR="${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}"
PI_VERSION="${PI_VERSION:-latest}"
PI_PACKAGE="@earendil-works/pi-coding-agent"
HERDR_CONFIG_DIR="${HERDR_CONFIG_DIR:-${XDG_CONFIG_HOME:-${HOME}/.config}/herdr}"

log() { printf 'config: %s\n' "$*"; }
fail() { printf 'config: error: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "Node.js is required"
command -v npm >/dev/null 2>&1 || fail "npm is required"

# --- Pi -------------------------------------------------------------------

# Follow the current stable release by default. Set PI_VERSION to an exact
# version when a reproducible or rollback install is needed.
desired_pi_version="$(npm view "${PI_PACKAGE}@${PI_VERSION}" version)"
[[ -n "$desired_pi_version" ]] || fail "could not resolve Pi version: ${PI_VERSION}"
installed_pi_version="$(pi --version 2>/dev/null || true)"
if [[ "$installed_pi_version" != "$desired_pi_version" ]]; then
  log "installing Pi ${desired_pi_version} (${PI_VERSION})"
  npm install --global --ignore-scripts "${PI_PACKAGE}@${desired_pi_version}"
fi

# --- Herdr ----------------------------------------------------------------

# The official installer always installs the latest stable release (version
# pinning is not supported). If herdr is already on PATH, keep it as-is.
if ! command -v herdr >/dev/null 2>&1; then
  log "installing Herdr"
  command -v curl >/dev/null 2>&1 || fail "curl is required to install Herdr"
  curl -fsSL https://herdr.dev/install.sh | sh
  command -v herdr >/dev/null 2>&1 || log "warning: herdr installed to a directory not on PATH (check ~/.local/bin)"
fi
if command -v herdr >/dev/null 2>&1; then
  log "herdr $(herdr --version 2>/dev/null | head -n1 | awk '{print $2}')"
fi

# Link the checked-in Herdr config. Existing files or symlinks (including
# home-manager-managed ones) are moved to a timestamped backup first; the
# repo copy becomes the source of truth.
mkdir -p "$HERDR_CONFIG_DIR"
if [[ -f "$REPO_DIR/herdr/config.toml" ]]; then
  herdr_config="$HERDR_CONFIG_DIR/config.toml"
  if [[ -L "$herdr_config" && "$(readlink -f -- "$herdr_config" 2>/dev/null || true)" == "$REPO_DIR/herdr/config.toml" ]]; then
    :
  else
    if [[ -e "$herdr_config" || -L "$herdr_config" ]]; then
      backup="${herdr_config}.pre-config.$(date +%Y%m%d%H%M%S)"
      mv -- "$herdr_config" "$backup"
      log "moved existing herdr config.toml to ${backup##*/}"
    fi
    ln -s -- "$REPO_DIR/herdr/config.toml" "$herdr_config"
  fi
  # Hot-reload into a running server when possible.
  herdr server reload-config >/dev/null 2>&1 || true
fi

mkdir -p "$PI_DIR"
PI_HOME_DIR="${PI_HOME_DIR:-${HOME}/.pi}"

# --- Pi static configuration ----------------------------------------------

# Link every static file under repo/.pi while preserving Pi's layout. Agent
# files use PI_CODING_AGENT_DIR; top-level files such as web-search.json use
# PI_HOME_DIR (default ~/.pi).
link_static() {
  local source="$1"
  local relative="${source#"$REPO_DIR/.pi/"}"
  local destination
  if [[ "$relative" == agent/* ]]; then
    destination="$PI_DIR/${relative#agent/}"
  else
    destination="$PI_HOME_DIR/$relative"
  fi
  mkdir -p "$(dirname -- "$destination")"

  if [[ -L "$destination" && "$(readlink -f -- "$destination" 2>/dev/null || true)" == "$source" ]]; then
    return
  fi
  if [[ -e "$destination" || -L "$destination" ]]; then
    local backup="${destination}.pre-config.$(date +%Y%m%d%H%M%S)"
    mv -- "$destination" "$backup"
    log "moved existing ${relative} to ${backup##*/}"
  fi
  ln -s -- "$source" "$destination"
}

while IFS= read -r -d '' source; do
  link_static "$source"
done < <(
  find "$REPO_DIR/.pi" -type f \
    ! -path '*/node_modules/*' \
    ! -name '*.cache.json' \
    ! -name 'auth.json' \
    ! -path '*/sessions/*' \
    ! -path '*/state/*' \
    -print0
)

# --- Package dependencies --------------------------------------------------

# Install all bundled npm dependencies for the unified package.
# --legacy-peer-deps: pi supplies the @earendil-works/* core packages at
# runtime, so they are declared as peerDependencies but not installed here.
# This replaces the old per-package install loop.
log "installing package dependencies"
(cd "$REPO_DIR" && npm install --production --legacy-peer-deps)

export PI_CODING_AGENT_DIR="$PI_DIR"

# Register the unified local package with pi. pi install is idempotent
# for an already-installed path.
log "registering unified package: $REPO_DIR"
pi install --no-approve "$REPO_DIR" >/dev/null

# Apply pi-config patches to bundled packages (idempotent; re-applied after
# npm install so upgrades never lose them).
node "$REPO_DIR/patches/patch-pi-permission-system.mjs" "$REPO_DIR"

# Register Herdr's pi integration (agent state reporting) when Herdr is
# available. It installs a Herdr-managed extension into $PI_DIR/extensions.
if command -v herdr >/dev/null 2>&1; then
  herdr integration install pi >/dev/null 2>&1 \
    && log "installed Herdr pi integration" \
    || log "warning: Herdr pi integration install failed"
fi

log "checking Pi configuration"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));' \
  "$PI_DIR/settings.json"
pi --version
log "ready; authenticate with /login on this machine"
