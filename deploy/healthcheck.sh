#!/usr/bin/env bash
# Read-only health and security check for the server. It changes nothing and prints no secrets.
#   bash healthcheck.sh        (run as root for the full picture)
set -u
h() { printf '\n== %s\n' "$1"; }
has() { command -v "$1" >/dev/null 2>&1; }

h "System"
echo "Host: $(hostname)   OS: $(. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-unknown}")   Kernel: $(uname -r)"
echo "Uptime: $(uptime -p 2>/dev/null)   Load: $(cut -d' ' -f1-3 /proc/loadavg)   CPUs: $(nproc)"
[ -f /var/run/reboot-required ] && echo "REBOOT REQUIRED (updates waiting for a restart)" || echo "No reboot pending"

h "Memory and disk"
free -h | sed -n '1,3p'
df -h -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null | sed -n '1,8p'

h "Updates"
if has apt-get; then
  apt-get -s upgrade 2>/dev/null | grep -c '^Inst' | xargs echo "Packages with updates:"
  apt-get -s upgrade 2>/dev/null | grep '^Inst' | grep -ci securi | xargs echo "  of which security:"
  dpkg -l unattended-upgrades 2>/dev/null | grep -q '^ii' && echo "Automatic security updates: installed" || echo "Automatic security updates: NOT installed"
fi

h "Firewall"
if has ufw; then ufw status verbose 2>/dev/null | sed -n '1,25p'; else echo "ufw not installed"; fi
has nft && echo "nftables rules: $(nft list ruleset 2>/dev/null | grep -c 'accept\|drop')"

h "Listening ports (what the outside world can reach if the firewall allows it)"
ss -tulpn 2>/dev/null | awk 'NR==1 || /LISTEN|UNCONN/' | awk '{print $1, $5, $7}' | column -t | sed -n '1,40p'

h "SSH settings"
if has sshd; then
  sshd -T 2>/dev/null | grep -Ei '^(port|permitrootlogin|passwordauthentication|pubkeyauthentication|maxauthtries|x11forwarding|permitemptypasswords) ' || echo "(run as root to read sshd settings)"
fi
echo "Authorised SSH keys for root: $(grep -cvE '^\s*(#|$)' /root/.ssh/authorized_keys 2>/dev/null || echo 0)"

h "Login attempts"
if has journalctl; then
  echo "Failed SSH logins, last 24h: $(journalctl -u ssh -u sshd --since '24 hours ago' 2>/dev/null | grep -ci 'failed password\|invalid user')"
  echo "Top sources of failed logins (24h):"
  journalctl -u ssh -u sshd --since '24 hours ago' 2>/dev/null | grep -i 'failed password\|invalid user' | grep -oE 'from [0-9a-f.:]+' | sort | uniq -c | sort -rn | head -5
fi
echo "Recent successful logins:"
last -n 5 -a 2>/dev/null | head -6
if has fail2ban-client; then fail2ban-client status 2>/dev/null | sed -n '1,4p'; else echo "fail2ban: not installed"; fi

h "Accounts"
echo "Users with a login shell: $(awk -F: '$7 !~ /(nologin|false)$/ {print $1}' /etc/passwd | xargs)"
echo "Users with UID 0 (root-level): $(awk -F: '$3 == 0 {print $1}' /etc/passwd | xargs)"
echo "Members of sudo: $(getent group sudo | cut -d: -f4)"

h "Services"
echo "Failed services: $(systemctl --failed --no-legend 2>/dev/null | awk '{print $1}' | xargs)"
for s in crossriver crossriver-tunnel cloudflared nginx apache2 docker; do
  st=$(systemctl is-active "$s" 2>/dev/null); [ "$st" = "inactive" ] && systemctl list-unit-files "$s.service" >/dev/null 2>&1 || true
  [ -n "$st" ] && [ "$st" != "unknown" ] && echo "$s: $st"
done
has docker && docker ps --format '{{.Names}}  {{.Image}}  {{.Ports}}' 2>/dev/null | sed 's/^/docker: /'
has pm2 && pm2 ls 2>/dev/null | sed -n '1,15p'

h "Apps"
curl -fsS -m 3 http://127.0.0.1:3100/healthz 2>/dev/null | sed 's/^/F the Bus (3100): /' || echo "F the Bus (3100): not responding"
code=$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/ 2>/dev/null); echo "Port 3000 (Rattle): HTTP $code"
echo "Node.js: $(/usr/bin/node -v 2>/dev/null || echo none)   cloudflared: $(cloudflared --version 2>/dev/null | head -1 || echo none)"

h "Backups and scheduled jobs"
echo "Root crontab entries: $(crontab -l 2>/dev/null | grep -cvE '^\s*(#|$)')"
ls /etc/cron.d 2>/dev/null | xargs echo "cron.d:"

h "Done"
echo "Nothing was changed. Paste everything above back to Claude."
