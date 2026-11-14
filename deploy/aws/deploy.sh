#!/usr/bin/env bash
# Safe update for the check-in app on an AWS EC2 server.
#
#   sudo -u checkin /opt/checkin/deploy/aws/deploy.sh            # deploy latest main
#   BRANCH=release sudo -u checkin /opt/checkin/deploy/aws/deploy.sh
#
# The database and uploads live on the separate /data volume, so replacing the code never
# touches them. Steps: check the data volume -> back up the database -> fetch code ->
# install + build -> restart (a few seconds) -> health check -> roll the code back if unhealthy.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/checkin}"
ENV_FILE="${ENV_FILE:-/etc/checkin/checkin.env}"
BRANCH="${BRANCH:-main}"
SERVICE="${SERVICE:-checkin}"

log() { printf '\n==> %s\n' "$*"; }

cd "$APP_DIR"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
PORT="${PORT:-4000}"

# Refuse to deploy during the morning check-in rush unless forced.
HOUR="$(TZ="${DEPLOY_TZ:-Africa/Kigali}" date +%H)"
if [[ "$HOUR" == "07" || "$HOUR" == "08" ]] && [[ "${FORCE:-}" != "1" ]]; then
  echo "It's the morning check-in window (07:00-09:00). Deploy later, or run with FORCE=1."
  exit 1
fi

log "Checking the data volume"
if ! mountpoint -q "$(dirname "$DB_PATH")" && [[ "${ALLOW_UNMOUNTED:-}" != "1" ]]; then
  echo "$(dirname "$DB_PATH") is not a mounted volume. Refusing to deploy (data would not persist)."
  exit 1
fi
if [[ -f "$DB_PATH" ]]; then
  log "Backing up the database"
  node server/scripts/backup.js
else
  echo "No database yet at $DB_PATH (first deploy?). Skipping backup."
fi

log "Fetching $BRANCH"
PREV="$(git rev-parse HEAD)"
git fetch --quiet origin "$BRANCH"
git checkout --quiet "$BRANCH"
git reset --quiet --hard "origin/$BRANCH"
NEW="$(git rev-parse HEAD)"
echo "$PREV -> $NEW"

build() {
  npm ci --prefix server --omit=dev --no-audit --no-fund
  npm ci --prefix client --no-audit --no-fund
  npm run build --prefix client
}

log "Installing and building"
build

log "Restarting $SERVICE"
sudo systemctl restart "$SERVICE"

healthy() {
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

if healthy; then
  log "Deployed $NEW. Healthy."
  sudo journalctl -u "$SERVICE" -n 5 --no-pager | grep '\[db\]' || true
  exit 0
fi

log "Health check FAILED. Rolling the code back to $PREV"
git reset --quiet --hard "$PREV"
build
sudo systemctl restart "$SERVICE"
if healthy; then
  echo "Rolled back to $PREV and healthy again. The database was not changed by the rollback;"
  echo "if the failed release changed data, restore the newest file from \$BACKUP_DIR (see README)."
else
  echo "Rollback is not healthy either. Check: sudo journalctl -u $SERVICE -n 100"
fi
exit 1
