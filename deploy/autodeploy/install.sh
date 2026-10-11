#!/usr/bin/env bash
# Install the release-tag auto-deploy on the supplier server (run once, as a sudo-capable user):
#   curl -fsSL https://raw.githubusercontent.com/micallb/dietary-supplement-analysis/main/deploy/autodeploy/install.sh | sudo bash
# or from a checkout: sudo bash deploy/autodeploy/install.sh
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }

RAW=${RAW:-https://raw.githubusercontent.com/micallb/dietary-supplement-analysis/main/deploy/autodeploy}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")

mkdir -p /usr/local/share/dsa-autodeploy
for f in autodeploy.sh backend-compose.yaml; do
  if [ -n "$HERE" ] && [ -f "$HERE/$f" ]; then cp "$HERE/$f" "/usr/local/share/dsa-autodeploy/$f"
  else curl -fsSL "$RAW/$f" -o "/usr/local/share/dsa-autodeploy/$f"; fi
done
install -m 755 /usr/local/share/dsa-autodeploy/autodeploy.sh /usr/local/bin/dsa-autodeploy

# What to follow: the highest vX.Y.Z tag, or the release branch when it carries a newer version.
[ -f /etc/dsa-autodeploy.env ] || cat > /etc/dsa-autodeploy.env <<'ENV'
# Read by /usr/local/bin/dsa-autodeploy. See deploy/autodeploy/autodeploy.sh.
TRACK=tags
TRACK_FALLBACK_BRANCH=release
ENV

cat > /etc/systemd/system/dsa-autodeploy.service <<'UNIT'
[Unit]
Description=Deploy the newest dietary-supplement-analysis release tag
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/dsa-autodeploy
TimeoutStartSec=20min
UNIT

cat > /etc/systemd/system/dsa-autodeploy.timer <<'UNIT'
[Unit]
Description=Check GitHub for a new dietary-supplement-analysis release every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
RandomizedDelaySec=30s

[Install]
WantedBy=timers.target
UNIT

git config --system --add safe.directory '*' 2>/dev/null || true
systemctl daemon-reload
systemctl enable --now dsa-autodeploy.timer
echo "installed: $(systemctl list-timers dsa-autodeploy.timer --no-pager | sed -n 2p)"
echo "logs: journalctl -u dsa-autodeploy -n 50   or   /opt/pocket/services/dietary-supplement-analysis/autodeploy/deploy.log"
