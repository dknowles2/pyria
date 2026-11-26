#!/usr/bin/env bash
set -euo pipefail

# Deploy Pyria to elzar (~/pyria) and manage its user systemd service.
# Usage:
#   ./server/deploy_elzar.sh                # sync files only
#   ./server/deploy_elzar.sh --restart      # sync + install/restart user systemd service + health check

HOST="${PYRIA_DEPLOY_HOST:-elzar}"
REMOTE_DIR="${PYRIA_REMOTE_DIR:-\$HOME/pyria}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESTART=false

if [[ "${1:-}" == "--restart" ]]; then
  RESTART=true
fi

echo "Syncing Pyria from ${REPO_ROOT} to ${HOST}:${REMOTE_DIR}..."
ssh "${HOST}" "mkdir -p ${REMOTE_DIR} \$HOME/.local/share/pyria \$HOME/.config/systemd/user"

COPYFILE_DISABLE=1 tar -C "${REPO_ROOT}" \
  --no-xattrs \
  --exclude '.git' \
  --exclude 'data' \
  --exclude 'sidecar' \
  --exclude '__pycache__' \
  --exclude '*.pyc' \
  --exclude '._*' \
  --exclude '.DS_Store' \
  -czf - web content assets server | ssh "${HOST}" "tar -xzf - -C ${REMOTE_DIR} && find ${REMOTE_DIR} -name '._*' -delete"

if [[ "${RESTART}" == "true" ]]; then
  echo "Installing & restarting user systemd service pyria.service on ${HOST}..."
  ssh "${HOST}" "cp ${REMOTE_DIR}/server/pyria.service \$HOME/.config/systemd/user/pyria.service && systemctl --user daemon-reload && systemctl --user enable pyria.service && systemctl --user restart pyria.service && sleep 1 && systemctl --user status --no-pager pyria.service"
  echo "Checking health endpoint on ${HOST}..."
  ssh "${HOST}" "python3 -c \"import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=5).read().decode())\""
else
  echo "Sync complete. Pass --restart to install/restart pyria.service on ${HOST}."
fi
