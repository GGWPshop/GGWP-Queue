#!/bin/bash
set -euo pipefail

APP_DIR="/opt/ggwp/apps/ggwp-queue"
COMPOSE="docker compose -f infra/docker-compose.prod.yml"

echo "[ggwp-queue] Deploying..."
cd "$APP_DIR"

git fetch origin main
git reset --hard origin/main
echo "[ggwp-queue] Pulled: $(git rev-parse --short HEAD)"

$COMPOSE build --no-cache
$COMPOSE up -d --remove-orphans

echo "[ggwp-queue] Waiting for health..."
sleep 5
CONTAINER="ggwp-queue"
for i in $(seq 1 12); do
  STATUS=$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo "missing")
  echo "  [$i/12] $CONTAINER: $STATUS"
  [ "$STATUS" = "healthy" ] && break
  sleep 5
done

FINAL=$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo "missing")
if [ "$FINAL" != "healthy" ]; then
  echo "[ggwp-queue] ERROR: container not healthy ($FINAL)"
  docker logs --tail=50 "$CONTAINER"
  exit 1
fi

echo "[ggwp-queue] Deploy complete. SHA=$(git rev-parse --short HEAD)"
