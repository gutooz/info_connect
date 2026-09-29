#!/usr/bin/env bash
set -Eeuo pipefail
cd /opt/major-neto

install -d -m 700 deploy/runtime
if [[ ! -f deploy/runtime/wpp.env ]]; then
  printf 'SECRET_KEY=%s\n' "$(openssl rand -hex 32)" > deploy/runtime/wpp.env
fi
if [[ ! -f deploy/runtime/app.env ]]; then
  cp deploy/runtime.example/app.env deploy/runtime/app.env
fi
if [[ ! -f deploy/runtime/web.env ]]; then
  cp deploy/runtime.example/web.env deploy/runtime/web.env
fi
chmod 600 deploy/runtime/*.env

docker compose build
docker compose up -d wppconnect

ready=0
for attempt in {1..60}; do
  if docker compose exec -T wppconnect node -e 'fetch("http://127.0.0.1:21465/healthz").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
if [[ "$ready" != 1 ]]; then
  echo 'WPPConnect não respondeu ao healthz.' >&2
  exit 1
fi

token="$(docker compose exec -T wppconnect node -e 'fetch(`http://127.0.0.1:21465/api/major/${process.env.SECRET_KEY}/generate-token`,{method:"POST"}).then(r=>r.json()).then(x=>{if(!x.token)process.exit(1);process.stdout.write(x.token)}).catch(()=>process.exit(1))')"
WPP_TOKEN="$token" python3 - <<'PY'
import os
from pathlib import Path

path = Path('deploy/runtime/app.env')
lines = path.read_text().splitlines()
lines = [f'WPP_CONNECT_TOKEN={os.environ["WPP_TOKEN"]}' if line.startswith('WPP_CONNECT_TOKEN=') else line for line in lines]
path.write_text('\n'.join(lines) + '\n')
PY
unset token
docker compose up -d
docker compose ps
