#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

APP_DIR=/opt/major-neto
STATE_DIR=/var/lib/major-neto-deploy
INCOMING_DIR="$STATE_DIR/incoming"
STAGING_DIR="$STATE_DIR/staging"
SOURCE_BACKUP_DIR="$STATE_DIR/source-backups"
DB_BACKUP_DIR="$STATE_DIR/database-backups"
REVISION_FILE="$STATE_DIR/current-revision"
LOCK_FILE=/var/lock/major-neto-deploy.lock

revision="${1:-}"
expected_checksum="${2:-}"

if [[ ! "$revision" =~ ^[0-9a-f]{40}$ ]]; then
  echo 'Revisão inválida.' >&2
  exit 2
fi
if [[ ! "$expected_checksum" =~ ^[0-9a-f]{64}$ ]]; then
  echo 'Checksum inválido.' >&2
  exit 2
fi

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo 'Já existe outro deploy em andamento.' >&2
  exit 3
fi

archive="$INCOMING_DIR/$revision.tgz"
stage="$(mktemp -d "$STAGING_DIR/$revision.XXXXXX")"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
source_backup="$SOURCE_BACKUP_DIR/$timestamp-${revision:0:12}"
db_backup="$DB_BACKUP_DIR/$timestamp-${revision:0:12}.sqlite"
rollback_image="major-neto-app:rollback-${revision:0:12}"
source_changed=0

cleanup() {
  rm -rf -- "$stage"
  rm -f -- "$archive"
}
trap cleanup EXIT

health_check() {
  cd "$APP_DIR"
  docker compose exec -T web wget -qO- http://app:3000/api/health >/dev/null 2>&1
}

rollback() {
  local exit_code=$?
  trap - ERR
  if (( source_changed == 1 )); then
    echo 'Falha no deploy; restaurando versão anterior.' >&2
    rsync -a --delete \
      --exclude='.env' --exclude='data/' --exclude='deploy/runtime/' \
      --exclude='log/' --exclude='tokens/' --exclude='uploads/' \
      --exclude='userDataDir/' --exclude='WhatsAppImages/' \
      "$source_backup/" "$APP_DIR/"
    docker tag "$rollback_image" major-neto-app:latest
    cd "$APP_DIR"
    docker compose up -d --no-deps --no-build app
  fi
  exit "$exit_code"
}
trap rollback ERR

mkdir -p "$INCOMING_DIR" "$STAGING_DIR" "$SOURCE_BACKUP_DIR" "$DB_BACKUP_DIR"
if [[ ! -s "$archive" ]]; then
  echo 'Pacote do deploy não encontrado.' >&2
  exit 4
fi

actual_checksum="$(sha256sum "$archive" | cut -d ' ' -f 1)"
if [[ "$actual_checksum" != "$expected_checksum" ]]; then
  echo 'O checksum do pacote não confere.' >&2
  exit 5
fi

if tar -tzf "$archive" | grep -Eq '(^/|(^|/)\.\.(/|$)|^deploy/runtime(/|$)|^\.env$)'; then
  echo 'O pacote contém um caminho proibido.' >&2
  exit 6
fi

tar -xzf "$archive" -C "$stage"
for required in compose.yaml Dockerfile package.json package-lock.json server/index.js public/index.html; do
  if [[ ! -f "$stage/$required" ]]; then
    echo "Arquivo obrigatório ausente: $required" >&2
    exit 7
  fi
done

ln -s "$APP_DIR/deploy/runtime" "$stage/deploy/runtime"
docker compose --project-name major-neto --project-directory "$stage" -f "$stage/compose.yaml" build app
rm "$stage/deploy/runtime"

container_id="$(cd "$APP_DIR" && docker compose ps -q app)"
container_backup="/data/ci-backup-${revision:0:12}.sqlite"
cd "$APP_DIR"
docker compose exec -T app node - "$container_backup" <<'NODE'
const Database = require('better-sqlite3');
const target = process.argv[2];
const source = process.env.DATABASE_PATH || '/data/major-neto.sqlite';
const database = new Database(source, { readonly: true });
database.backup(target)
  .then(() => database.close())
  .catch((error) => { console.error(error.message); process.exitCode = 1; });
NODE
docker cp "$container_id:$container_backup" "$db_backup"
docker compose exec -T app rm -f "$container_backup"

mkdir "$source_backup"
rsync -a \
  --exclude='.git/' --exclude='.env' --exclude='node_modules/' \
  --exclude='data/' --exclude='deploy/runtime/' --exclude='log/' \
  --exclude='tokens/' --exclude='uploads/' --exclude='userDataDir/' \
  --exclude='WhatsAppImages/' --exclude='major-neto-deploy.tgz' \
  "$APP_DIR/" "$source_backup/"

docker tag major-neto-app:latest "$rollback_image"
source_changed=1
rsync -a --delete \
  --exclude='.env' --exclude='data/' --exclude='deploy/runtime/' \
  --exclude='log/' --exclude='tokens/' --exclude='uploads/' \
  --exclude='userDataDir/' --exclude='WhatsAppImages/' \
  "$stage/" "$APP_DIR/"

cd "$APP_DIR"
docker compose up -d --no-deps --no-build app

healthy=0
for _attempt in $(seq 1 30); do
  if health_check; then
    healthy=1
    break
  fi
  sleep 2
done
if (( healthy != 1 )); then
  echo 'A aplicação não ficou saudável após o deploy.' >&2
  false
fi

printf '%s\n' "$revision" > "$REVISION_FILE"
mapfile -t old_databases < <(find "$DB_BACKUP_DIR" -maxdepth 1 -type f -name '*.sqlite' -printf '%T@ %p\n' | sort -nr | tail -n +8 | cut -d ' ' -f 2-)
if (( ${#old_databases[@]} > 0 )); then
  rm -f -- "${old_databases[@]}"
fi

trap - ERR
echo "Deploy concluído: $revision"
