#!/usr/bin/env bash
set -Eeuo pipefail

DEPLOY_USER=major-deploy
TARGET=/usr/local/sbin/restart-major-neto-wppconnect
SUDOERS_FILE=/etc/sudoers.d/major-neto-wppconnect-restart
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SOURCE="$SCRIPT_DIR/restart-wppconnect.sh"

if [[ $EUID -ne 0 ]]; then
  echo 'Execute este instalador como root.' >&2
  exit 2
fi
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  echo "O usuario $DEPLOY_USER nao existe." >&2
  exit 3
fi
if [[ ! -f "$SOURCE" ]]; then
  echo 'O comando de reinicio nao foi encontrado.' >&2
  exit 4
fi

install -o root -g root -m 0755 "$SOURCE" "$TARGET"

temporary_sudoers="$(mktemp)"
trap 'rm -f -- "$temporary_sudoers"' EXIT
printf '%s\n' "$DEPLOY_USER ALL=(root) NOPASSWD: $TARGET" > "$temporary_sudoers"
chmod 0440 "$temporary_sudoers"
visudo -cf "$temporary_sudoers"
install -o root -g root -m 0440 "$temporary_sudoers" "$SUDOERS_FILE"

echo 'Reinicio seguro do WPPConnect autorizado para o usuario de deploy.'
