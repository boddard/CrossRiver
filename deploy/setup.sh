#!/usr/bin/env bash
# Install or update F the Bus online on an Ubuntu server. Safe to run again to update.
#
#   bash setup.sh tunnel <TOKEN>                    # Cloudflare Tunnel: HTTPS via Cloudflare, no open ports
#   bash setup.sh bus.example.com you@example.com   # nginx + free Let's Encrypt HTTPS certificate
#   bash setup.sh bus.example.com                   # nginx, plain HTTP
#   bash setup.sh                                   # update; or, first time with no tunnel, http://SERVER-IP:3100
#
# For a tunnel, create it in the Cloudflare dashboard with a public hostname pointing at http://localhost:3100
# and pass the token from its install command. For nginx, point the domain's DNS A record here first.
set -euo pipefail

TUNNEL_TOKEN=""
if [ "${1:-}" = "tunnel" ]; then
  TUNNEL_TOKEN="${2:-}"
  if [ "${#TUNNEL_TOKEN}" -lt 50 ]; then
    echo "That doesn't look like a tunnel token. Copy the long token from the Cloudflare install command."; exit 1
  fi
  set --
fi
DOMAIN="${1:-}"
EMAIL="${2:-}"
APP=/opt/crossriver
REPO=https://github.com/boddard/CrossRiver.git
BRANCH=main

if [ "$(id -u)" -ne 0 ]; then echo "Run this as root (or with sudo)."; exit 1; fi

echo "==> Installing packages"
apt-get update -qq
apt-get install -y -qq git curl ca-certificates >/dev/null
# The service runs /usr/bin/node. A Node installed per-user (nvm, n, a tarball) isn't readable by the
# service account, so install the system package there; other apps keep using their own Node.
if [ ! -x /usr/bin/node ] || [ "$(/usr/bin/node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  echo "==> Installing Node.js 20 at /usr/bin/node"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "    node $(/usr/bin/node -v)"

echo "==> Fetching the game into $APP"
if [ -d "$APP/.git" ]; then
  git -C "$APP" fetch -q origin "$BRANCH"
  git -C "$APP" reset -q --hard "origin/$BRANCH"
else
  git clone -q --branch "$BRANCH" "$REPO" "$APP"
fi
cd "$APP"
PATH="/usr/bin:$PATH" /usr/bin/npm ci --omit=dev --no-audit --no-fund --silent

# The service runs as its own unprivileged user; the code stays owned by root and read-only to it.
id crossriver >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin crossriver

echo "==> Installing the service"
cp deploy/crossriver.service /etc/systemd/system/crossriver.service
mkdir -p /etc/systemd/system/crossriver.service.d
HAS_TUNNEL=0
if [ -n "$TUNNEL_TOKEN" ] || systemctl is-enabled -q cloudflared 2>/dev/null; then HAS_TUNNEL=1; fi
if [ -z "$DOMAIN" ] && [ "$HAS_TUNNEL" -eq 0 ]; then
  # No domain and no tunnel: listen on all addresses so phones can reach http://SERVER-IP:3100 directly.
  printf '[Service]\nEnvironment=HOST=0.0.0.0\n' > /etc/systemd/system/crossriver.service.d/override.conf
else
  rm -f /etc/systemd/system/crossriver.service.d/override.conf
fi
# Port 3100 must be free for the game (another app on this server already uses 3000).
systemctl stop crossriver 2>/dev/null || true
if ss -ltn '( sport = :3100 )' | grep -q LISTEN; then
  echo "Another program is already using port 3100:"; ss -ltnp '( sport = :3100 )' | tail -n +2
  echo "Stop it, or change PORT in $APP/deploy/crossriver.service, then run this again."; exit 1
fi
systemctl daemon-reload
systemctl enable -q crossriver
systemctl restart crossriver
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS http://127.0.0.1:3100/healthz 2>/dev/null | grep -q '^ok'; then echo "    game server is running on port 3100"; break; fi
  if [ "$i" -eq 10 ]; then echo "The game server didn't start. Recent log:"; journalctl -u crossriver -n 20 --no-pager; exit 1; fi
  sleep 1
done

if [ -n "$TUNNEL_TOKEN" ]; then
  echo "==> Connecting the Cloudflare Tunnel"
  if ! command -v cloudflared >/dev/null; then
    mkdir -p --mode=0755 /usr/share/keyrings
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" > /etc/apt/sources.list.d/cloudflared.list
    apt-get update -qq
    apt-get install -y -qq cloudflared >/dev/null
  fi
  # Replace any earlier tunnel so a new token takes effect.
  if [ -f /etc/systemd/system/cloudflared.service ]; then cloudflared service uninstall >/dev/null 2>&1 || true; fi
  cloudflared service install "$TUNNEL_TOKEN"
  sleep 3
  systemctl is-active -q cloudflared && echo "    tunnel is connected"
  echo
  echo "Done. Open the public hostname you set on the tunnel (for example https://bus.b21g.com) on your phone."
  exit 0
fi
if [ "$HAS_TUNNEL" -eq 1 ] && [ -z "$DOMAIN" ]; then
  echo
  echo "Done. Updated and restarted. The Cloudflare Tunnel keeps serving it on your public hostname."
  exit 0
fi

if [ -z "$DOMAIN" ]; then
  if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow 3100/tcp >/dev/null; fi
  IP=$(curl -fsS https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
  echo
  echo "Done. Open http://$IP:3100 on your phone."
  echo "Tip: run again with a domain and email to get HTTPS: bash $APP/deploy/setup.sh bus.example.com you@example.com"
  exit 0
fi

echo "==> Setting up nginx for $DOMAIN"
if ! command -v nginx >/dev/null; then
  if ss -ltn '( sport = :80 )' | grep -q LISTEN; then
    echo "Something other than nginx is already using port 80 (Apache or a control panel?)."
    echo "The game is running on 127.0.0.1:3100. Point your existing web server at it, with WebSocket"
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
