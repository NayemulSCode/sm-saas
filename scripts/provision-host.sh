#!/usr/bin/env bash
#
# Provision a fresh VPS. The IaC substitute (§41).
#
# Committed and runnable, rather than a wiki page nobody updates. Two people
# cannot maintain Terraform and a product at the same time, and a shell script
# that is actually run is worth more than a state file that has drifted.
#
# IDEMPOTENT: safe to re-run on a host that is already set up. That is what
# makes it usable at 02:00, when the question is "did that step actually
# happen?" and the answer has to be "run it again and see".
#
#   sudo ./scripts/provision-host.sh
#
# It does NOT deploy the application. See scripts/deploy.sh.

set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:-sm}"
APP_DIR="${APP_DIR:-/opt/sm-saas}"
SSH_PORT="${SSH_PORT:-22}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo $0" >&2
  exit 1
fi

# ── packages ─────────────────────────────────────────────────────────────────

say "Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  ca-certificates curl gnupg ufw fail2ban unattended-upgrades \
  postgresql-client-18 restic

# ── Docker ───────────────────────────────────────────────────────────────────

if ! have docker; then
  say "Docker"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
else
  say "Docker already installed"
fi

# ── deploy user ──────────────────────────────────────────────────────────────

say "Deploy user: ${DEPLOY_USER}"
if ! id -u "$DEPLOY_USER" >/dev/null 2>&1; then
  # No login shell password: SSH keys only.
  adduser --disabled-password --gecos '' "$DEPLOY_USER"
fi
usermod -aG docker "$DEPLOY_USER"

install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0750 "$APP_DIR"
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0750 "$APP_DIR/backups"

# ── firewall ─────────────────────────────────────────────────────────────────
#
# PostgreSQL is NOT exposed. It is reached over the Compose network only, and
# an open 5432 on a public IP is found by a scanner within the hour.

say "Firewall"
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow "${SSH_PORT}/tcp" comment 'ssh'
ufw allow 80/tcp comment 'http'
ufw allow 443/tcp comment 'https'
ufw --force enable
ufw status verbose

# ── SSH hardening ────────────────────────────────────────────────────────────

say "SSH"
SSHD_DROPIN=/etc/ssh/sshd_config.d/99-sm.conf
cat > "$SSHD_DROPIN" <<EOF
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
chmod 644 "$SSHD_DROPIN"
# Validate before reloading: a syntax error here locks everyone out of a box
# whose console may be a web form on a provider dashboard.
sshd -t && systemctl reload ssh

# ── automatic security updates ───────────────────────────────────────────────

say "Unattended upgrades"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

# ── swap ─────────────────────────────────────────────────────────────────────
#
# 2 GB on an 8 GB host. Not to be used — it is there so that a memory spike
# degrades into slowness rather than the OOM killer choosing PostgreSQL.

if [[ ! -f /swapfile ]]; then
  say "Swap"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  # Low swappiness: swap as a safety net, not as routine memory.
  sysctl -w vm.swappiness=10
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-sm.conf
fi

# ── secrets file ─────────────────────────────────────────────────────────────

ENV_FILE="$APP_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  say "Creating ${ENV_FILE} — FILL IT IN BEFORE DEPLOYING"
  cat > "$ENV_FILE" <<'EOF'
# chmod 600, root-owned. Never in the repo, never in the image (§33).
NODE_ENV=production
APP_URL=https://CHANGE_ME
PLATFORM_HOST=admin.CHANGE_ME

DATABASE_URL_APP=postgres://sm_app:CHANGE_ME@postgres:5432/sm_saas
DATABASE_URL_PLATFORM=postgres://sm_platform:CHANGE_ME@postgres:5432/sm_saas
DATABASE_URL_MIGRATOR=postgres://postgres:CHANGE_ME@postgres:5432/sm_saas

# openssl rand -hex 32
SESSION_SECRET=CHANGE_ME
ENCRYPTION_KEY=CHANGE_ME

SMS_PROVIDER=mock
LOG_LEVEL=info
TZ=Asia/Dhaka
EOF
fi
# Root-owned and unreadable by anyone else, including the deploy user's own
# processes except through Compose's env_file.
chown root:root "$ENV_FILE"
chmod 600 "$ENV_FILE"

say "Done"
cat <<EOF

Next:
  1. Fill in ${ENV_FILE} (it is chmod 600, root-owned).
  2. Add the deploy user's SSH key to /home/${DEPLOY_USER}/.ssh/authorized_keys
  3. Copy docker-compose.yml and Caddyfile into ${APP_DIR}
  4. ./scripts/deploy.sh <image-digest>

NOT done here, and deliberately:
  - PostgreSQL WAL archiving to R2. archive_command is /bin/true until the R2
    bucket exists; §36.1 needs it before this host holds real data.
  - The streaming replica. Financial RPO is 60s, not 0, until it exists.
EOF
