#!/usr/bin/env bash
set -Eeuo pipefail

public_key_file="${1:-}"
deploy_script="${2:-}"
deploy_user=major-deploy
state_dir=/var/lib/major-neto-deploy

if [[ $EUID -ne 0 ]]; then
  echo 'Execute este instalador como root.' >&2
  exit 2
fi
if [[ ! -f "$public_key_file" || ! -f "$deploy_script" ]]; then
  echo 'Informe a chave pública e o script de deploy.' >&2
  exit 2
fi

if ! id "$deploy_user" >/dev/null 2>&1; then
  useradd --system --create-home --shell /bin/bash "$deploy_user"
fi

install -d -o "$deploy_user" -g "$deploy_user" -m 0700 "/home/$deploy_user/.ssh"
touch "/home/$deploy_user/.ssh/authorized_keys"
key_blob="$(awk '{print $2}' "$public_key_file")"
if ! grep -Fq "$key_blob" "/home/$deploy_user/.ssh/authorized_keys"; then
  printf 'restrict %s\n' "$(cat "$public_key_file")" >> "/home/$deploy_user/.ssh/authorized_keys"
fi
chown "$deploy_user:$deploy_user" "/home/$deploy_user/.ssh/authorized_keys"
chmod 0600 "/home/$deploy_user/.ssh/authorized_keys"

install -d -o root -g root -m 0755 "$state_dir"
install -d -o "$deploy_user" -g "$deploy_user" -m 0750 "$state_dir/incoming"
install -d -o root -g root -m 0700 \
  "$state_dir/staging" "$state_dir/source-backups" "$state_dir/database-backups"
install -o root -g root -m 0755 "$deploy_script" /usr/local/sbin/deploy-major-neto

sudoers_file=/etc/sudoers.d/major-neto-deploy
printf '%s\n' "$deploy_user ALL=(root) NOPASSWD: /usr/local/sbin/deploy-major-neto" > "$sudoers_file"
chmod 0440 "$sudoers_file"
visudo -cf "$sudoers_file"

echo "Usuário $deploy_user configurado para deploy."
