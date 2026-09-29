#!/usr/bin/env bash
set -Eeuo pipefail
project_dir="${PROJECT_DIR:-/opt/major-neto}"
cd "$project_dir"

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

panel_domain="$(grep -m1 '^PANEL_DOMAIN=' deploy/runtime/web.env | cut -d= -f2-)"
if [[ -z "$panel_domain" ]]; then
  echo 'PANEL_DOMAIN precisa estar configurado em deploy/runtime/web.env.' >&2
  exit 1
fi

PANEL_DOMAIN="$panel_domain" python3 - <<'PY'
import os
import secrets
from pathlib import Path

path = Path('deploy/runtime/app.env')
domain = os.environ['PANEL_DOMAIN']
lines = path.read_text().splitlines()
values = {}
for line in lines:
    if '=' in line and not line.lstrip().startswith('#'):
        key, value = line.split('=', 1)
        values[key] = value

desired = {
    'PUBLIC_BASE_URL': f'https://{domain}',
    'WPP_WEBHOOK_SECRET': values.get('WPP_WEBHOOK_SECRET') or secrets.token_hex(32),
}
desired['WPP_WEBHOOK_SECRET'] = (
    secrets.token_hex(32)
    if 'GERADO_NA_VPS' in desired['WPP_WEBHOOK_SECRET']
    else desired['WPP_WEBHOOK_SECRET']
)

updated = []
seen = set()
for line in lines:
    if '=' in line and not line.lstrip().startswith('#'):
        key = line.split('=', 1)[0]
        if key in desired:
            line = f'{key}={desired[key]}'
            seen.add(key)
    updated.append(line)
for key, value in desired.items():
    if key not in seen:
        updated.append(f'{key}={value}')
path.write_text('\n'.join(updated) + '\n')
PY

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

default_session="$(grep -m1 '^WPP_CONNECT_SESSION=' deploy/runtime/app.env | cut -d= -f2-)"
if [[ ! "$default_session" =~ ^[a-zA-Z0-9_-]{1,26}$ ]]; then
  echo 'WPP_CONNECT_SESSION invalida em deploy/runtime/app.env.' >&2
  exit 1
fi
token="$(docker compose exec -T -e WPP_SESSION="$default_session" wppconnect node -e 'fetch(`http://127.0.0.1:21465/api/${encodeURIComponent(process.env.WPP_SESSION)}/${process.env.SECRET_KEY}/generate-token`,{method:"POST"}).then(r=>r.json()).then(x=>{if(!x.token)process.exit(1);process.stdout.write(x.token)}).catch(()=>process.exit(1))')"
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
