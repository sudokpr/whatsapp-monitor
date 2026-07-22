#!/usr/bin/env bash
set -euo pipefail

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

METRICS_URL="${METRICS_URL:-http://127.0.0.1:3000/metrics}"
SERVICE_NAME="${SERVICE_NAME:-whatsapp-group-monitor.service}"
STATE_DIR="${STATE_DIR:-data/remediation}"
FAILURE_THRESHOLD="${FAILURE_THRESHOLD:-2}"
COOLDOWN_SECONDS="${COOLDOWN_SECONDS:-900}"
DAILY_RESTART_LIMIT="${DAILY_RESTART_LIMIT:-12}"
HIGH_RESTART_NOTIFY_THRESHOLD="${HIGH_RESTART_NOTIFY_THRESHOLD:-5}"
VERIFY_DELAY_SECONDS="${VERIFY_DELAY_SECONDS:-45}"
TELEGRAM_REMEDIATOR_NOTIFY="${TELEGRAM_REMEDIATOR_NOTIFY:-true}"

mkdir -p "$STATE_DIR"

failure_count_file="$STATE_DIR/whatsapp_connection_down_count"
last_restart_file="$STATE_DIR/whatsapp_connection_last_restart"
daily_count_file="$STATE_DIR/whatsapp_connection_daily_count"
daily_date_file="$STATE_DIR/whatsapp_connection_daily_date"

log() {
  printf '%s %s\n' "$(date --iso-8601=seconds)" "$*"
}

metric_value() {
  local metric_name="$1"
  awk -v metric="$metric_name" '
    $1 == metric { print $2; found = 1; exit }
    END { if (!found) exit 1 }
  '
}

read_int_file() {
  local file="$1"
  local default_value="$2"

  if [ -f "$file" ]; then
    tr -dc '0-9' < "$file" | awk '{ print $0 == "" ? 0 : $0 }'
  else
    printf '%s\n' "$default_value"
  fi
}

fetch_metrics() {
  curl -fsS --max-time 10 "$METRICS_URL"
}

telegram_enabled() {
  case "${TELEGRAM_REMEDIATOR_NOTIFY:-true}" in
    1 | true | TRUE | yes | YES | on | ON) return 0 ;;
    *) return 1 ;;
  esac
}

send_restart_notification() {
  local status="$1"
  local detail="$2"

  if ! telegram_enabled; then
    log "telegram_notify_skipped reason=disabled"
    return 0
  fi

  if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
    log "telegram_notify_skipped reason=missing_config"
    return 0
  fi

  local host
  host="$(hostname 2>/dev/null || printf 'unknown-host')"

  local message
  message="$(cat <<EOF
WhatsApp monitor remediator restarted ${SERVICE_NAME}

Host: ${host}
Status: ${status}
Detail: ${detail}
Time: $(date --iso-8601=seconds)
EOF
)"

  local telegram_output
  local telegram_status
  set +e
  telegram_output="$(printf '%s\n' "$message" | python3 scripts/telegram/send_telegram_topic.py 2>&1)"
  telegram_status=$?
  set -e

  if [ "$telegram_status" -eq 0 ]; then
    log "telegram_notify_sent status=$status"
  else
    telegram_output="$(printf '%s' "$telegram_output" | tr '\n' ' ' | tr -s ' ' | cut -c 1-240)"
    log "telegram_notify_failed status=$status error=${telegram_output:-unknown}"
  fi
}

metrics="$(fetch_metrics)" || {
  log "metrics_unreachable url=$METRICS_URL action=none"
  exit 0
}

monitor_up="$(printf '%s\n' "$metrics" | metric_value whatsapp_monitor_up || true)"
connection_up="$(printf '%s\n' "$metrics" | metric_value whatsapp_connection_up || true)"

if [ "$monitor_up" != "1" ]; then
  log "monitor_not_up monitor_up=${monitor_up:-missing} action=none"
  exit 0
fi

if [ "$connection_up" = "1" ]; then
  printf '0\n' > "$failure_count_file"
  log "connection_open action=none"
  exit 0
fi

if [ "$connection_up" != "0" ]; then
  log "connection_metric_unexpected connection_up=${connection_up:-missing} action=none"
  exit 0
fi

failure_count="$(read_int_file "$failure_count_file" 0)"
failure_count=$((failure_count + 1))
printf '%s\n' "$failure_count" > "$failure_count_file"

if [ "$failure_count" -lt "$FAILURE_THRESHOLD" ]; then
  log "connection_down count=$failure_count threshold=$FAILURE_THRESHOLD action=observe"
  exit 0
fi

now="$(date +%s)"
last_restart="$(read_int_file "$last_restart_file" 0)"
seconds_since_restart=$((now - last_restart))

if [ "$last_restart" -gt 0 ] && [ "$seconds_since_restart" -lt "$COOLDOWN_SECONDS" ]; then
  log "connection_down count=$failure_count cooldown_remaining=$((COOLDOWN_SECONDS - seconds_since_restart)) action=skip"
  exit 0
fi

today="$(date +%F)"
saved_day="$(cat "$daily_date_file" 2>/dev/null || true)"
if [ "$saved_day" != "$today" ]; then
  printf '%s\n' "$today" > "$daily_date_file"
  printf '0\n' > "$daily_count_file"
fi

daily_count="$(read_int_file "$daily_count_file" 0)"
if [ "$daily_count" -ge "$DAILY_RESTART_LIMIT" ]; then
  log "connection_down count=$failure_count daily_count=$daily_count daily_limit=$DAILY_RESTART_LIMIT action=skip"
  exit 0
fi

log "connection_down count=$failure_count daily_count=$daily_count daily_limit=$DAILY_RESTART_LIMIT action=restart service=$SERVICE_NAME"
systemctl --user restart "$SERVICE_NAME"

new_daily_count=$((daily_count + 1))
printf '%s\n' "$now" > "$last_restart_file"
printf '%s\n' "$new_daily_count" > "$daily_count_file"
printf '0\n' > "$failure_count_file"

sleep "$VERIFY_DELAY_SECONDS"

restart_detail() {
  local detail="$1"

  if [ "$new_daily_count" -ge "$HIGH_RESTART_NOTIFY_THRESHOLD" ]; then
    printf '%s; daily_restarts=%s/%s; high_restart_threshold=%s reached' \
      "$detail" "$new_daily_count" "$DAILY_RESTART_LIMIT" "$HIGH_RESTART_NOTIFY_THRESHOLD"
  else
    printf '%s; daily_restarts=%s/%s' "$detail" "$new_daily_count" "$DAILY_RESTART_LIMIT"
  fi
}

verify_metrics="$(fetch_metrics)" || {
  log "verify_failed reason=metrics_unreachable action=escalate"
  send_restart_notification "verification_failed" "$(restart_detail "metrics were unreachable after restart")"
  exit 1
}

verify_connection_up="$(printf '%s\n' "$verify_metrics" | metric_value whatsapp_connection_up || true)"
if [ "$verify_connection_up" = "1" ]; then
  log "verify_recovered connection_up=1"
  send_restart_notification "recovered" "$(restart_detail "whatsapp_connection_up=1 after restart")"
  exit 0
fi

log "verify_not_recovered connection_up=${verify_connection_up:-missing} action=escalate"
send_restart_notification "not_recovered" "$(restart_detail "whatsapp_connection_up=${verify_connection_up:-missing} after restart")"
exit 1
