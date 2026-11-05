#!/usr/bin/env bash
# One-time, idempotent preparation of a fresh Ubuntu 24.04 DEMO server (run as root ON THE SERVER).
# Does NOT deploy the app. Safe to re-run. Review before running.
set -euo pipefail
DEPLOY_USER="${DEPLOY_USER:-om}"

echo "== packages"
apt-get update -y && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y
DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl git ufw fail2ban unattended-upgrades

echo "== 2 GB swap (protects 2 GB RAM from OOM during image pulls/migrations)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
sysctl -w vm.swappiness=10 >/dev/null && echo 'vm.swappiness=10' > /etc/sysctl.d/99-om.conf

echo "== Docker"
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh

echo "== deploy user"
id "$DEPLOY_USER" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$DEPLOY_USER"
usermod -aG docker "$DEPLOY_USER"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
if [ -s /root/.ssh/authorized_keys ] && [ ! -s "/home/$DEPLOY_USER/.ssh/authorized_keys" ]; then
  install -m 600 -o "$DEPLOY_USER" -g "$DEPLOY_USER" /root/.ssh/authorized_keys "/home/$DEPLOY_USER/.ssh/authorized_keys"
fi

echo "== firewall: only SSH, HTTP, HTTPS"
ufw default deny incoming && ufw default allow outgoing
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp
ufw --force enable

echo "== SSH hardening (only if a key is already installed, so you cannot lock yourself out)"
if [ -s "/home/$DEPLOY_USER/.ssh/authorized_keys" ]; then
  cat > /etc/ssh/sshd_config.d/99-om.conf <<'CFG'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
CFG
  systemctl reload ssh
  echo "password login disabled; key login only"
else
  echo "WARNING: no SSH key found for $DEPLOY_USER — password login left enabled. Add a key, then re-run."
fi
systemctl enable --now fail2ban unattended-upgrades
echo "done. free -h:"; free -h; df -h /
