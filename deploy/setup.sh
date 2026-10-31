#!/usr/bin/env bash
# Install or update F the Bus online on an Ubuntu server. Safe to run again to update.
#
#   bash setup.sh bus.example.com you@example.com   # domain + free HTTPS certificate (recommended)
#   bash setup.sh bus.example.com                   # domain, plain HTTP
#   bash setup.sh                                   # no domain: http://SERVER-IP:3000
#
# Point the domain's DNS A record at this server before running with a domain.
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
APP=/opt/crossriver
REPO=https://github.com/boddard/CrossRiver.git
BRANCH=main

if [ "$(id -u)" -ne 0 ]; then echo "Run this as root (or with sudo)."; exit 1; fi

echo "==> Installing packages"
apt-get update -qq
apt-get install -y -qq git curl ca-certificates >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  echo "==> Installing Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "    node $(node -v)"

echo "==> Fetching the game into $APP"
if [ -d "$APP/.git" ]; then
  git -C "$APP" fetch -q origin "$BRANCH"
  git -C "$APP" reset -q --hard "origin/$BRANCH"
else
  git clone -q --branch "$BRANCH" "$REPO" "$APP"
fi
cd "$APP"
npm ci --omit=dev --no-audit --no-fund --silent

# The service runs as its own unprivileged user; the code stays owned by root and read-only to it.
id crossriver >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin crossriver

echo "==> Installing the service"
cp deploy/crossriver.service /etc/systemd/system/crossriver.service
mkdir -p /etc/systemd/system/crossriver.service.d
if [ -z "$DOMAIN" ]; then
  # No domain: listen on all addresses so phones can reach http://SERVER-IP:3000 directly.
  printf '[Service]\nEnvironment=HOST=0.0.0.0\n' > /etc/systemd/system/crossriver.service.d/override.conf
else
  rm -f /etc/systemd/system/crossriver.service.d/override.conf
fi
systemctl daemon-reload
systemctl enable -q crossriver
systemctl restart crossriver
sleep 1
curl -fsS http://127.0.0.1:3000/healthz >/dev/null && echo "    game server is running"

if [ -z "$DOMAIN" ]; then
  if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow 3000/tcp >/dev/null; fi
  IP=$(curl -fsS https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
  echo
  echo "Done. Open http://$IP:3000 on your phone."
  echo "Tip: run again with a domain and email to get HTTPS: bash $APP/deploy/setup.sh bus.example.com you@example.com"
  exit 0
fi

echo "==> Setting up nginx for $DOMAIN"
if ! command -v nginx >/dev/null; then
  if ss -ltn '( sport = :80 )' | grep -q LISTEN; then
    echo "Something other than nginx is already using port 80 (Apache or a control panel?)."
    echo "The game is running on 127.0.0.1:3000. Point your existing web server at it, with WebSocket"
    echo "upgrade headers on /ws, or ask Claude for a config for your web server."
    exit 1
  fi
  apt-get install -y -qq nginx >/dev/null
fi
sed "s/DOMAIN_HERE/$DOMAIN/" deploy/nginx-crossriver.conf > /etc/nginx/sites-available/crossriver
ln -sf /etc/nginx/sites-available/crossriver /etc/nginx/sites-enabled/crossriver
nginx -t -q
systemctl reload nginx
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow 'Nginx Full' >/dev/null; fi

if [ -n "$EMAIL" ]; then
  echo "==> Getting a free HTTPS certificate"
  apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
  certbot --nginx -d "$DOMAIN" -m "$EMAIL" --agree-tos --non-interactive --redirect --keep-until-expiring -q
  echo
  echo "Done. Open https://$DOMAIN on your phone."
else
  echo
  echo "Done. Open http://$DOMAIN on your phone."
fi
