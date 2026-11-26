#!/usr/bin/env bash
set -euo pipefail

# Deploy Pyria (web/, content/, assets/, server/) to elzar over SSH/rsync.
# Usage:
#   ./server/deploy_elzar.sh                # rsync files only
#   ./server/deploy_elzar.sh --restart      # rsync + restart systemd service

HOST="${PYRIA_DEPLOY_HOST:-elzar}"
REMOTE_DIR="${PYRIA_REMOTE_DIR:-/opt/pyria}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESTART=false

if [[ "${1:-}" == "--restart" ]]; then
  RESTART=true
fi

echo "Syncing Pyria from ${REPO_ROOT} to ${HOST}:${REMOTE_DIR}..."
rsync -avz --delete \
  --exclude '.git' \
  --exclude 'data/' \
  --exclude 'sidecar/' \
  --exclude '__pycache__/' \
  --exclude '*.pyc' \
  --exclude '.DS_Store' \
  "${REPO_ROOT}/web" \
  "${REPO_ROOT}/content" \
  "${REPO_ROOT}/assets" \
  "${REPO_ROOT}/server" \
  "${HOST}:${REMOTE_DIR}/"

if [[ "${RESTART}" == "true" ]]; then
  echo "Restarting pyria.service on ${HOST}..."
  ssh "${HOST}" "sudo systemctl restart pyria.service && sudo systemctl status --no-pager pyria.service"
else
  echo "Sync complete. Pass --restart to restart pyria.service on ${HOST}."
fi
