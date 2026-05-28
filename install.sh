#!/usr/bin/env sh
# AXON CLI — POSIX installer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/atharva7577/axon-cli/main/install.sh | sh
#
# Detects node + npm, refuses cleanly when missing, then installs the latest
# @axon/cli from this repo's main branch into the global npm prefix. Logs to
# stderr so you can pipe stdout silently in CI.
set -eu

REPO="atharva7577/axon-cli"
MIN_NODE_MAJOR=20

log()  { printf '%s\n' "$*" 1>&2; }
fail() { log "✗ $*"; exit 1; }

log ""
log "  AXON CLI installer"
log ""

# ─── node ────────────────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || fail \
  "Node.js not found in PATH.
    Install Node ${MIN_NODE_MAJOR}+ from https://nodejs.org/ (or via your package manager), then re-run."

NODE_VERSION="$(node -v 2>/dev/null | sed 's/^v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
case "${NODE_MAJOR}" in
  ''|*[!0-9]*) fail "Could not parse node version: ${NODE_VERSION}" ;;
esac
if [ "${NODE_MAJOR}" -lt "${MIN_NODE_MAJOR}" ]; then
  fail "Node ${NODE_VERSION} found. AXON CLI requires Node ${MIN_NODE_MAJOR} or newer."
fi

# ─── npm ─────────────────────────────────────────────────────────────────────
command -v npm >/dev/null 2>&1 || fail \
  "npm not found in PATH. It usually ships with Node — make sure your install is complete."

# ─── install ─────────────────────────────────────────────────────────────────
log "  Installing @axon/cli from github:${REPO}…"
log ""
# --install-links forces npm to COPY files instead of creating a junction to
# its temp git-clone dir. Without it, the temp dir gets cleaned up after the
# install and the global \`axon\` shim points at a dangling path. See
# https://github.com/npm/cli/issues#installing-from-git-on-windows
npm install -g "github:${REPO}" --install-links

# ─── done ────────────────────────────────────────────────────────────────────
log ""
log "  ✓ Done. Run \`axon\` to get started."
log "    First-run wizard will appear when no API key is on file."
log ""
