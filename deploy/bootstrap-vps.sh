#!/usr/bin/env bash
set -Eeuo pipefail

secret="$(openssl rand -hex 32)"
SECRET_KEY="$secret" python3 - <<'PY'
import os
from pathlib import Path

Path('/etc/major-neto/wpp.env').write_text(
    f"SECRET_KEY={os.environ['SECRET_KEY']}\n"
)
Path('/etc/major-neto/app.env').write_text("\n".join([
    'NODE_ENV=production',
    'PORT=3000',
    'HOST=127.0.0.1',
    'DATABASE_PATH=/opt/major-neto/data/major-neto.sqlite',
    'DEMO_MODE=false',
    'WPP_CONNECT_URL=http://127.0.0.1:21465',
    'WPP_CONNECT_SESSION=major',
    'WPP_CONNECT_TOKEN=',
    'META_GRAPH_VERSION=v23.0',
    'META_IG_USER_ID=',
    'META_ACCESS_TOKEN=',
    'AI_BASE_URL=https://api.openai.com/v1',
    'AI_MODEL=gpt-4o-mini',
    'AI_API_KEY=',
]) + "\n")
PY

chmod 600 /etc/major-neto/*.env
systemctl restart wppconnect.service
curl --retry 15 --retry-delay 1 --retry-connrefused -fsS http://127.0.0.1:21465/healthz >/dev/null

curl -fsS http://127.0.0.1:21465/healthz >/dev/null
response="$(curl -fsS -X POST "http://127.0.0.1:21465/api/major/${secret}/generate-token")"
token="$(printf '%s' "$response" | python3 -c 'import json, sys; print(json.load(sys.stdin).get("token", ""))')"
test -n "$token"

TOKEN="$token" python3 - <<'PY'
import os
from pathlib import Path

path = Path('/etc/major-neto/app.env')
token = os.environ['TOKEN']
lines = []
for line in path.read_text().splitlines():
    if line.startswith('WPP_CONNECT_TOKEN='):
        line = f'WPP_CONNECT_TOKEN={token}'
    lines.append(line)
path.write_text('\n'.join(lines) + '\n')
PY

systemctl daemon-reload
systemctl enable --now major-neto.service
systemctl restart major-neto.service
echo 'BOOTSTRAP_COMPLETE'
