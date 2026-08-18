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

# 5) agent auth LIVENESS — a token being PRESENT is not enough (a stale/expired
#    token still parses). On 2026-08-18 the dispatcher was healthy but every
#    agent replied "Not logged in · Please run /login" because the Claude Max
#    OAuth had lapsed (oauth-credentials.json missing, .env fallback token
#    expired) — invisible to a presence check. Resolve the token the way
#    container-runner does (oauth-credentials.json accessToken first, else the
#    .env fallback) and actually exercise it against the API via the claude
#    binary. Edge case: a valid refreshToken with an expired accessToken would
#    false-positive here (nanoclaw's own refresh isn't replicated) — acceptable,
#    it yields a "check Holly" nudge, never a silent failure.
CRED=/opt/nanoclaw/oauth-credentials.json
tok=""
[ -f "$CRED" ] && tok=$(node -e 'try{const c=require("/opt/nanoclaw/oauth-credentials.json");process.stdout.write(c.accessToken||c.access_token||"")}catch(e){}' 2>/dev/null)
[ -z "$tok" ] && tok=$(grep -E '^CLAUDE_CODE_OAUTH_TOKEN=' "$ENV_FILE" 2>/dev/null | sed 's/^[^=]*=//')
if [ -z "$tok" ]; then
  crit "no Claude credential — oauth-credentials.json missing AND CLAUDE_CODE_OAUTH_TOKEN empty in .env; run /login"
elif ! command -v claude >/dev/null 2>&1; then
  warn "claude binary not found — cannot verify auth (token is present)"
else
  probe=$(cd /tmp && runuser -u nanoclaw -- env HOME=/home/nanoclaw CLAUDE_CODE_OAUTH_TOKEN="$tok" timeout 30 claude -p "Reply with the single word: OK" </dev/null 2>&1 | tr -d '\r')
  if printf '%s' "$probe" | grep -qiE "Not logged in|Invalid bearer token|authentication_error|Please run /login|401"; then
    reason=$(printf '%s' "$probe" | grep -oiE "Not logged in|Invalid bearer token|authentication_error" | head -1)
    crit "Claude auth FAILED — agents cannot log in (${reason:-auth error}); refresh via /login then update CLAUDE_CODE_OAUTH_TOKEN / oauth-credentials.json"
  elif printf '%s' "$probe" | grep -qiE '(^|[^A-Za-z])OK([^A-Za-z]|$)'; then
    ok "Claude auth live (probe returned OK)"
  else
    warn "Claude auth probe inconclusive: $(printf '%s' "$probe" | tr '\n' ' ' | head -c 140)"
  fi
fi

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
