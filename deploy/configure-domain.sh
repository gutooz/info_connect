#!/usr/bin/env bash
set -Eeuo pipefail

domain='pizzarialetitona.com'
webroot='/var/www/html'

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y nginx certbot apache2-utils
install -d -m 0755 "$webroot/.well-known/acme-challenge"

cat > /etc/nginx/sites-available/major-neto <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    location /.well-known/acme-challenge/ {
        root ${webroot};
    }

    location / {
        return 404;
    }
}
NGINX

rm -f /etc/nginx/sites-enabled/default
ln -sfn /etc/nginx/sites-available/major-neto /etc/nginx/sites-enabled/major-neto
nginx -t
systemctl enable --now nginx
systemctl reload nginx

certbot certonly --webroot -w "$webroot" -d "$domain" \
    --agree-tos --register-unsafely-without-email --non-interactive

password="$(openssl rand -hex 16)"
htpasswd -bBc /etc/nginx/.htpasswd-major-neto admin "$password" >/dev/null
chmod 640 /etc/nginx/.htpasswd-major-neto
chown root:www-data /etc/nginx/.htpasswd-major-neto

cat > /etc/nginx/sites-available/major-neto <<NGINX
limit_req_zone \$binary_remote_addr zone=major_api:10m rate=10r/s;

server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    location /.well-known/acme-challenge/ {
        root ${webroot};
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${domain};

    ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_timeout 1d;
    ssl_session_cache shared:SSL:10m;
    ssl_session_tickets off;

    client_max_body_size 24m;
    auth_basic "Major Neto";
    auth_basic_user_file /etc/nginx/.htpasswd-major-neto;

    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    location /api/ {
        limit_req zone=major_api burst=20 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX

nginx -t
systemctl reload nginx
systemctl enable certbot.timer >/dev/null 2>&1 || true
echo "DOMAIN_READY=https://${domain}"
echo "PANEL_USER=admin"
echo "PANEL_PASSWORD=${password}"
