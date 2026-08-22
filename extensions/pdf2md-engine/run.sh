#!/usr/bin/env bash
# Wrapper that ensures libstdc++.so.6 is on LD_LIBRARY_PATH for PyMuPDF,
# then execs the given command. Resolves the gcc lib dir once and caches it
# under ~/.cache (never next to this script, which may be a stowed dotfile).
set -euo pipefail

CACHE="${HOME}/.cache/pi-pdf2md/.gcc_lib_path"

if [ ! -f "$CACHE" ]; then
  GCCLIB="$(find /nix/store -maxdepth 4 -name 'libstdc++.so.6' 2>/dev/null | head -1 || true)"
  if [ -n "$GCCLIB" ]; then
    mkdir -p "$(dirname "$CACHE")"
    echo "$(dirname "$GCCLIB")" > "$CACHE"
  fi
fi

if [ -f "$CACHE" ]; then
  GCCDIR="$(cat "$CACHE")"
  export LD_LIBRARY_PATH="$GCCDIR:${LD_LIBRARY_PATH:-}"
fi

exec "$@"
