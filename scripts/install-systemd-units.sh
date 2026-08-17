#!/usr/bin/env bash
# install-systemd-units.sh — install/refresh NanoClaw's host systemd units.
#
# These units live in /etc/systemd/system (outside the repo), so they were never
# version-controlled and could be lost on a host rebuild. That is exactly what
# happened to the health check's script (gone ~2026-05-17, unnoticed for 3
# months). This script makes the unit definitions reproducible from the repo.
#
# Installs:
#   - nanoclaw-health.service / .timer  — hourly health check + Telegram alert
#     (ExecStart => scripts/nanoclaw-health.sh, also in this repo).
#   - nanoclaw.service.d/override.conf  — raises the V8 heap / cgroup cap after
#     the 2026-08-16 OOM crash-loop. Load-bearing: without it the dispatcher can
#     OOM under a memory spike.
#
# Idempotent: safe to re-run. Requires root (writes /etc/systemd/system).
# Usage: sudo bash scripts/install-systemd-units.sh

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: must run as root (writes /etc/systemd/system). Try: sudo bash $0" >&2
  exit 1
fi

SYSD=/etc/systemd/system
NANOCLAW_HEALTH_SCRIPT=/opt/nanoclaw/scripts/nanoclaw-health.sh

echo "Installing NanoClaw systemd units into $SYSD ..."

# --- nanoclaw-health.service ---
cat > "$SYSD/nanoclaw-health.service" <<'UNIT'
[Unit]
Description=NanoClaw Health Check
After=nanoclaw.service

[Service]
Type=oneshot
ExecStart=/opt/nanoclaw/scripts/nanoclaw-health.sh
StandardOutput=append:/opt/nanoclaw/logs/health.log
StandardError=append:/opt/nanoclaw/logs/health.log
UNIT

# --- nanoclaw-health.timer (hourly) ---
cat > "$SYSD/nanoclaw-health.timer" <<'UNIT'
[Unit]
Description=Run NanoClaw health check hourly

[Timer]
OnCalendar=*:00:00
Persistent=true

[Install]
WantedBy=timers.target
UNIT

# --- nanoclaw.service heap/cgroup override (post-OOM restore) ---
mkdir -p "$SYSD/nanoclaw.service.d"
cat > "$SYSD/nanoclaw.service.d/override.conf" <<'UNIT'
# Added 2026-08-16 after a SIGABRT crash-loop: a scheduled_tasks table bloated
# to 5.5k rows was loaded whole into a per-run tasks snapshot and OOM'd the
# 768MB V8 heap. Root cause fixed in code (retention prune) + a one-time data
# prune; this raised cap is kept as defence-in-depth. Box has ample RAM.
[Service]
Environment=NODE_OPTIONS=--max-old-space-size=2048
MemoryMax=3G
UNIT

# Ensure the health script the service points at is executable.
if [ -f "$NANOCLAW_HEALTH_SCRIPT" ]; then
  chmod 755 "$NANOCLAW_HEALTH_SCRIPT"
else
  echo "WARN: $NANOCLAW_HEALTH_SCRIPT not found — health.service will fail until it exists." >&2
fi

systemctl daemon-reload
systemctl enable --now nanoclaw-health.timer

echo "Done. Installed + enabled:"
systemctl is-enabled nanoclaw-health.timer >/dev/null 2>&1 && echo "  nanoclaw-health.timer: enabled"
echo
echo "NOTE: the nanoclaw.service.d override only takes effect on the running"
echo "dispatcher after 'systemctl restart nanoclaw.service' (not applied to a"
echo "live process by daemon-reload alone). Restart during a maintenance window."
