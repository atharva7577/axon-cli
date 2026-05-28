#!/usr/bin/env sh
# AXON CLI -- POSIX installer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/atharva7577/axon-cli/main/install.sh | sh
#
# Detects node + npm, installs @axon/cli from the project's GitHub repo into
# the global npm prefix, then verifies the `axon` shim is on PATH. Logs to
# stderr so you can pipe stdout silently in CI.
#
# NOTE: ASCII only. Run via curl|sh it executes in a NEW shell, so `exit`
# is safe here (unlike install.ps1 piped via iex).
set -eu

REPO="atharva7577/axon-cli"
MIN_NODE_MAJOR=20

log()  { printf '%s\n' "$*" 1>&2; }
fail() { log "  [FAIL] $*"; exit 1; }
ok()   { log "  [OK]   $*"; }
hint() { log "  [!]    $*"; }

log ''
log '  ==> AXON CLI installer'
log ''

# --- node --------------------------------------------------------------------
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

# --- npm ---------------------------------------------------------------------
command -v npm >/dev/null 2>&1 || fail \
  "npm not found in PATH. It usually ships with Node - make sure your install is complete."

# --- install -----------------------------------------------------------------
log "  Installing @axon/cli from github:${REPO} ..."
log ''
# --install-links forces npm to COPY files instead of creating a junction to
# its temp git-clone dir. Without it, the temp dir gets cleaned up after the
# install and the global 'axon' shim points at a dangling path.
npm install -g "github:${REPO}" --install-links

# --- post-install PATH sanity -----------------------------------------------
PREFIX="$(npm prefix -g 2>/dev/null || true)"

log ''
if command -v axon >/dev/null 2>&1; then
  ok "@axon/cli installed and ready. Run 'axon' to start."
  log "         First-run wizard will appear when no API key is on file."
  log ''
  exit 0
fi

# axon not on PATH. Where did it go?
SHIM="${PREFIX}/bin/axon"
if [ -n "${PREFIX}" ] && [ -x "${SHIM}" ]; then
  ok "@axon/cli installed at: ${PREFIX}"
  hint "Add ${PREFIX}/bin to PATH and restart your shell."
  log "         Bash/Zsh:"
  log "             echo 'export PATH=\"${PREFIX}/bin:\$PATH\"' >> ~/.profile  (or ~/.bashrc, ~/.zshrc)"
  log ''
  log '         Or run it directly from this shell:'
  log "             ${SHIM} --version"
  log ''
else
  fail "npm reported success but no axon shim was found at expected prefix: ${PREFIX}
         Open an issue with the output above. Latest npm log is under \$HOME/.npm/_logs/."
fi
