#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR=/opt/major-neto
SERVICE=wppconnect

if [[ $EUID -ne 0 ]]; then
  echo 'Este comando precisa ser executado como root.' >&2
  exit 2
fi
if [[ ! -f "$APP_DIR/compose.yaml" ]]; then
  echo 'A instalacao do Major Neto nao foi encontrada.' >&2
  exit 3
fi

cd "$APP_DIR"
docker compose restart "$SERVICE"

for _attempt in $(seq 1 30); do
  if docker compose exec -T "$SERVICE" node -e \
    "fetch('http://127.0.0.1:21465/healthz').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"; then
    echo 'WPPConnect reiniciado e saudavel.'
    exit 0
  fi
  sleep 2
done

docker compose logs --tail=50 "$SERVICE"
echo 'O WPPConnect nao ficou saudavel depois do reinicio.' >&2
exit 1
