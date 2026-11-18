#!/usr/bin/env bash
# Runs ONCE on a brand-new Ubuntu 24.04 server, as root (or with sudo):
#
#   ssh root@<server> 'bash -s' < scripts/server-setup.sh
#   (on AWS the first user is "ubuntu":  ssh ubuntu@<server> 'sudo bash -s' < scripts/server-setup.sh)
#
# It turns a bare machine into one that is reasonable to put on the internet:
#   - a "deploy" user that can run Docker but isn't root, reachable with your SSH key;
#   - SSH by key only (no passwords), no root login;
#   - a firewall that allows SSH, HTTP and HTTPS and nothing else;
#   - automatic security updates;
#   - Docker, 2 GB of swap (so a memory spike slows the box down instead of killing it);
#   - nightly backups and a weekly certificate check.
# Safe to run again.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)."; exit 1; }

apt-get update -q
apt-get install -y -q ca-certificates curl ufw unattended-upgrades fail2ban

# --- Docker (official install script) ---
if ! command -v docker > /dev/null; then
  curl -fsSL https://get.docker.com | sh
fi

# --- The deploy user, with the same SSH key you just logged in with ---
if ! id deploy > /dev/null 2>&1; then
  adduser --disabled-password --gecos "" deploy
fi
usermod -aG docker deploy
src_home="$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6)"
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
if [ -s "$src_home/.ssh/authorized_keys" ]; then
  install -m 600 -o deploy -g deploy "$src_home/.ssh/authorized_keys" /home/deploy/.ssh/authorized_keys
else
  echo "No SSH key found to copy to the deploy user. Add one to /home/deploy/.ssh/authorized_keys before logging out."
fi

# --- SSH: keys only ---
cat > /etc/ssh/sshd_config.d/10-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
if [ -s /home/deploy/.ssh/authorized_keys ]; then
  systemctl reload ssh
else
  rm /etc/ssh/sshd_config.d/10-hardening.conf # don't lock anyone out
fi

# --- Firewall ---
# Note: Docker publishes container ports itself and bypasses ufw. That's why the
# production Compose file publishes only 80/443 publicly and everything else on 127.0.0.1.
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# --- Security updates, applied automatically ---
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

# --- Swap ---
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile > /dev/null && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# --- Docker: cap log size so logs can't fill the disk ---
if [ ! -f /etc/docker/daemon.json ]; then
  echo '{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }' > /etc/docker/daemon.json
  systemctl restart docker
fi

# --- Scheduled jobs for the deploy user ---
cat > /etc/cron.d/marketplace <<'EOF'
# Nightly backup at 03:15, certificate check on Mondays at 04:30 (server time, UTC).
15 3 * * *  deploy  cd /home/deploy/marketplace && ./scripts/prod-backup.sh >> /home/deploy/marketplace/cron.log 2>&1
30 4 * * 1  deploy  cd /home/deploy/marketplace && ./scripts/prod-cert.sh  >> /home/deploy/marketplace/cron.log 2>&1
EOF

echo
echo "Done. From now on log in as:  ssh deploy@$(curl -fsS --max-time 5 https://api.ipify.org || hostname -I | cut -d' ' -f1)"
