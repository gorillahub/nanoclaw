#!/usr/bin/env bash
# nanoclaw-health.sh — hourly health check for the NanoClaw dispatcher.
#
# Restored + rewritten 2026-08-17. The original lived only on the host, never in
# git, and went missing ~2026-05-17 — leaving the box with 3 months of no
# monitoring, during which the dispatcher crash-looped (scheduled_tasks bloat ->
# V8 heap OOM) unnoticed and every agent went silent on Telegram. This version
# is committed to the repo so it can't vanish again, and it ALERTS Craig on
# Telegram when something is actually wrong.
#
# Checks: service active; restart-storm (crash-loop); host-process memory vs the
# cgroup cap (the OOM class); scheduled_tasks bloat (the precursor that caused
# the outage); agent auth token present; runaway log files. Every result is
# logged; one Telegram alert is sent if any CRITICAL fires. Exit 0 always — the
# alert (not the unit's failed state) is the signal.
#
# Installed at /opt/nanoclaw/scripts/nanoclaw-health.sh, run by
# nanoclaw-health.timer (hourly). HEALTH_TEST=1 logs but never sends Telegram.

set -u

ENV_FILE=/opt/nanoclaw/.env
SVC=nanoclaw.service
STORE_DB=/opt/nanoclaw/store/messages.db
NR_STATE=/opt/nanoclaw/logs/.health-nrestarts

ts()  { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "$(ts) [nanoclaw-health] $1"; }

CRIT=()
crit() { CRIT+=("$1"); log "CRITICAL: $1"; }
warn() { log "WARN: $1"; }
ok()   { log "OK: $1"; }

TELEGRAM_BOT_TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" 2>/dev/null | sed 's/^TELEGRAM_BOT_TOKEN=//')
TELEGRAM_CHAT_ID=$(grep -E '^TELEGRAM_CHAT_ID=' "$ENV_FILE" 2>/dev/null | sed 's/^TELEGRAM_CHAT_ID=//')

send_telegram() {
  if [ -n "${HEALTH_TEST:-}" ]; then log "(test mode) would send alert"; return; fi
  if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
    log "cannot alert — TELEGRAM_BOT_TOKEN/CHAT_ID missing from $ENV_FILE"; return
  fi
  if curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
       -d "chat_id=${TELEGRAM_CHAT_ID}" --data-urlencode "text=$1" >/dev/null 2>&1; then
    log "alert sent to Telegram"
  else
    log "alert send FAILED"
  fi
}

# 1) dispatcher is active
state=$(systemctl is-active "$SVC" 2>/dev/null || echo unknown)
if [ "$state" = "active" ]; then ok "$SVC is active"; else crit "$SVC is '$state' (not active)"; fi

# 2) restart storm (crash-loop) — delta of NRestarts since the last check
nr=$(systemctl show "$SVC" -p NRestarts --value 2>/dev/null); nr=${nr:-0}
prev=$(cat "$NR_STATE" 2>/dev/null || echo "$nr")
echo "$nr" > "$NR_STATE" 2>/dev/null || true
delta=$(( nr - prev )); [ "$delta" -lt 0 ] && delta=0
if [ "$delta" -ge 3 ]; then crit "restart storm — $delta restarts since last check (crash-loop)"
else ok "restarts since last check: $delta (total $nr)"; fi

# 3) host-process memory vs the cgroup cap (the OOM class)
mem=$(systemctl show "$SVC" -p MemoryCurrent --value 2>/dev/null)
cap=$(systemctl show "$SVC" -p MemoryMax --value 2>/dev/null)
if [[ "$mem" =~ ^[0-9]+$ && "$cap" =~ ^[0-9]+$ && "$cap" -gt 0 ]]; then
  pct=$(( mem * 100 / cap )); mmb=$(( mem/1024/1024 )); cmb=$(( cap/1024/1024 ))
  if   [ "$pct" -ge 95 ]; then crit "memory ${mmb}MB / ${cmb}MB (${pct}%) — near cap, OOM risk"
  elif [ "$pct" -ge 80 ]; then warn "memory ${mmb}MB / ${cmb}MB (${pct}%) — elevated"
  else ok "memory ${mmb}MB / ${cmb}MB (${pct}%)"; fi
else ok "memory usage vs cap unavailable"; fi

# 4) scheduled_tasks bloat — the precursor to the 2026-08-16 OOM
if [ -f "$STORE_DB" ]; then
  cnt=$(cd /opt/nanoclaw && node -e 'try{const d=new(require("better-sqlite3"))("store/messages.db",{readonly:true,timeout:3000});process.stdout.write(String(d.prepare("select count(*) n from scheduled_tasks").get().n))}catch(e){process.stdout.write("-1")}' 2>/dev/null)
  cnt=${cnt:--1}
  if   [ "$cnt" -lt 0 ] 2>/dev/null; then warn "could not read scheduled_tasks count (db busy?)"
  elif [ "$cnt" -ge 4000 ]; then crit "scheduled_tasks bloated to $cnt rows — retention failing, OOM precursor"
  elif [ "$cnt" -ge 2000 ]; then warn "scheduled_tasks growing: $cnt rows"
  else ok "scheduled_tasks: $cnt rows"; fi
fi

# 5) agent auth token present
tok=$(grep -E '^CLAUDE_CODE_OAUTH_TOKEN=' "$ENV_FILE" 2>/dev/null | sed 's/^[^=]*=//')
[ -n "$tok" ] && ok "CLAUDE_CODE_OAUTH_TOKEN present" || crit "CLAUDE_CODE_OAUTH_TOKEN missing/empty in .env"

# 6) runaway logs
big=$(find /opt/nanoclaw/logs -maxdepth 1 -type f -size +500M 2>/dev/null | tr '\n' ' ')
[ -n "$big" ] && warn "log file(s) over 500MB: $big" || ok "log files within size limits"

# summary + alert
if [ "${#CRIT[@]}" -gt 0 ]; then
  msg="🔴 NanoClaw health — ${#CRIT[@]} critical issue(s) on gorillabot-2:"
  for c in "${CRIT[@]}"; do msg="$msg"$'\n'"• $c"; done
  send_telegram "$msg"
  log "=== health check complete — ${#CRIT[@]} CRITICAL ==="
else
  log "=== health check complete — all OK ==="
fi
exit 0
