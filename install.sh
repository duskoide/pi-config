#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PI_DIR="${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}"
PI_HOME_DIR="${PI_HOME_DIR:-${HOME}/.pi}"
PI_VERSION="${PI_VERSION:-0.85.1}"
PI_PACKAGE="@earendil-works/pi-coding-agent"
HERDR_CONFIG_DIR="${HERDR_CONFIG_DIR:-${XDG_CONFIG_HOME:-${HOME}/.config}/herdr}"
SKIP_EXTERNAL_INSTALLS="${PI_CONFIG_SKIP_EXTERNAL_INSTALLS:-0}"

log() { printf 'config: %s\n' "$*"; }
fail() { printf 'config: error: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "Node.js is required"
command -v npm >/dev/null 2>&1 || fail "npm is required"

# Existing files are never overwritten silently. This keeps the installer
# reversible while the repository remains the source of truth for these paths.
link_file() {
  local source="$1"
  local destination="$2"
  [[ -f "$source" ]] || fail "portable source is missing: $source"
  mkdir -p "$(dirname -- "$destination")"

  if [[ -L "$destination" && "$(readlink -f -- "$destination" 2>/dev/null || true)" == "$source" ]]; then
    return
  fi

  if [[ -e "$destination" || -L "$destination" ]]; then
    local backup="${destination}.pre-config.$(date +%Y%m%d%H%M%S)"
    while [[ -e "$backup" || -L "$backup" ]]; do
      backup="${destination}.pre-config.$(date +%Y%m%d%H%M%S).$$"
    done
    mv -- "$destination" "$backup"
    log "moved existing ${destination##*/} to ${backup##*/}"
  fi
  ln -s -- "$source" "$destination"
}

remove_obsolete_link() {
  local destination="$1"
  local old_source="$2"
  if [[ -L "$destination" && "$(readlink -- "$destination")" == "$old_source" ]]; then
    rm -- "$destination"
    log "removed obsolete managed link ${destination##*/}"
  fi
}

export PI_CODING_AGENT_DIR="$PI_DIR"

if [[ "$SKIP_EXTERNAL_INSTALLS" == "1" ]]; then
  log "skipping Pi, Herdr, and package installations (test mode)"
else
  # --- Pi -----------------------------------------------------------------

  desired_pi_version="$(npm view "${PI_PACKAGE}@${PI_VERSION}" version)"
  [[ -n "$desired_pi_version" ]] || fail "could not resolve Pi version: ${PI_VERSION}"
  installed_pi_version="$(pi --version 2>/dev/null || true)"
  if [[ "$installed_pi_version" != "$desired_pi_version" ]]; then
    log "installing Pi ${desired_pi_version} (${PI_VERSION})"
    npm install --global --ignore-scripts "${PI_PACKAGE}@${desired_pi_version}"
  fi

  # --- Herdr --------------------------------------------------------------

  # The official installer always installs the latest stable release. If
  # Herdr is already on PATH, keep that installation as-is.
  if ! command -v herdr >/dev/null 2>&1; then
    log "installing Herdr"
    command -v curl >/dev/null 2>&1 || fail "curl is required to install Herdr"
    curl -fsSL https://herdr.dev/install.sh | sh
    command -v herdr >/dev/null 2>&1 || log "warning: Herdr installed outside PATH (check ~/.local/bin)"
  fi
  if command -v herdr >/dev/null 2>&1; then
    log "$(herdr --version 2>/dev/null | head -n1)"
  fi
fi

# --- Portable static configuration ----------------------------------------

# These are deliberately allowlisted. Pi-managed credentials, sessions,
# caches, catalogs, state, and generated integrations stay on the machine.
mkdir -p "$PI_DIR" "$PI_HOME_DIR"

for relative in \
  settings.json \
  keybindings.json \
  custom-providers.json \
  pi-searxng-suite.json \
  provider-failover.json \
  agents/general-purpose.md \
  agents/Plan.md; do
  link_file "$REPO_DIR/.pi/agent/$relative" "$PI_DIR/$relative"
done

link_file "$REPO_DIR/.pi/web-search.json" "$PI_HOME_DIR/web-search.json"

# Remove the old permission-system link when upgrading an installation made by
# the previous repository layout. Other machine-local files are untouched.
remove_obsolete_link \
  "$PI_DIR/extensions/pi-permission-system/config.json" \
  "$REPO_DIR/.pi/agent/extensions/pi-permission-system/config.json"

# Herdr's config is portable; its sockets, locks, logs, and session data are
# intentionally not managed by this repository.
mkdir -p "$HERDR_CONFIG_DIR"
link_file "$REPO_DIR/herdr/config.toml" "$HERDR_CONFIG_DIR/config.toml"
if [[ "$SKIP_EXTERNAL_INSTALLS" != "1" ]] && command -v herdr >/dev/null 2>&1; then
  herdr server reload-config >/dev/null 2>&1 || true
fi

# --- Pi package setup ------------------------------------------------------

if [[ "$SKIP_EXTERNAL_INSTALLS" != "1" ]]; then
  # The local package contains only this repository's custom extensions and
  # skills. Third-party resources remain individually installed and pinned in
  # settings.json, matching Pi's current package model.
  log "installing local package dependencies"
  (cd "$REPO_DIR" && npm install --production --ignore-scripts --legacy-peer-deps)

  while IFS= read -r package_source; do
    [[ -n "$package_source" ]] || continue
    log "installing ${package_source}"
    pi install --no-approve "$package_source" >/dev/null
  done < <(
    node - "$PI_DIR/settings.json" <<'NODE'
const fs = require("node:fs");
const settings = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
for (const entry of settings.packages ?? []) {
  const source = typeof entry === "string" ? entry : entry?.source;
  if (/^(npm:|git:|https?:|ssh:)/.test(source ?? "")) console.log(source);
}
NODE
  )

  # Register Herdr's Pi integration when available. It writes generated
  # lifecycle glue into PI_DIR and is therefore not copied into the repo.
  if command -v herdr >/dev/null 2>&1; then
    herdr integration install pi >/dev/null 2>&1 \
      && log "installed Herdr Pi integration" \
      || log "warning: Herdr Pi integration install failed"
  fi
fi

log "checking Pi configuration"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));' \
  "$PI_DIR/settings.json" "$REPO_DIR/package.json"

if [[ "$SKIP_EXTERNAL_INSTALLS" == "1" ]]; then
  log "test mode complete"
else
  pi --version
  log "ready; authenticate with /login on this machine"
fi
