# AGENTS.md

## Project

This repo contains a local WhatsApp group monitor built with TypeScript and
Baileys, plus Python digest sidecar scripts under `scripts/digest/`.

## Commands

- Install Node dependencies: `npm install`
- Run the monitor in development: `npm run dev`
- Build TypeScript: `npm run build`
- Run built service: `npm start`
- Sync Python dependencies: `npm run py:sync`
- Preview digest without sending Telegram messages: `npm run digest:preview`
- Run the digest pipeline: `npm run digest`
- Install/start the user systemd service: `make service-install`
- Restart/stop/status service: `make service-restart`, `make service-stop`,
  `make service-status`
- Show/follow monitor logs: `make logs`, `make logs-follow`
- Force a new WhatsApp QR login: `make qr-login`

## Metrics and Alerts

The TypeScript monitor exposes Prometheus text metrics at `GET /metrics`.
Important monitor metrics include:

- `whatsapp_connection_up`
- `whatsapp_connection_state`
- `whatsapp_disconnects_total`
- `whatsapp_reconnects_total`
- `whatsapp_messages_received_total`
- `whatsapp_messages_persisted_total`
- `whatsapp_message_persist_failures_total`
- `whatsapp_last_message_timestamp_seconds`
- `whatsapp_last_message_age_seconds`
- `whatsapp_groups_discovered`
- `whatsapp_http_requests_total`
- `whatsapp_http_request_duration_seconds_sum`
- `whatsapp_http_request_duration_seconds_count`

The digest cron path can emit Prometheus text metrics when enabled with
`PROMETHEUS_METRICS_ENABLED=true`. By default it writes
`data/metrics/whatsapp_digest.prom`; configure `PROMETHEUS_METRICS_PUSH_URL`
to POST that text payload to a compatible ingestion endpoint. Strict
remote-write endpoints need a gateway/agent that accepts text exposition.

Important digest metrics include:

- `whatsapp_digest_last_run_timestamp_seconds`
- `whatsapp_digest_last_success_timestamp_seconds`
- `whatsapp_digest_last_failure_timestamp_seconds`
- `whatsapp_digest_last_duration_seconds`
- `whatsapp_digest_last_message_count`
- `whatsapp_digest_last_group_count`
- `whatsapp_digest_last_sent_to_telegram`
- `whatsapp_digest_telegram_enabled`
- `whatsapp_digest_last_sent_to_whatsapp`
- `whatsapp_digest_whatsapp_enabled`
- `whatsapp_digest_state_last_processed_timestamp_seconds`
- `whatsapp_digest_last_message_timestamp_seconds`

Sample alert rules live in `prometheus-alerts.yml`.

## Local Data

Do not commit runtime or personal data. The `data/` directory is local state and
can contain WhatsApp auth keys, group IDs, phone numbers, captured messages,
digest databases, logs, and model state.

Local configuration belongs in `.env` and `data/config.json`. Keep shareable
examples in `.env.example` or `*.sample.*` / `*.example.*` files.

## Git Hygiene

- Keep `node_modules/`, `.venv/`, `dist/`, `.env*`, and `data/` out of Git.
- Commit source files, lockfiles, docs, and configuration examples.
- Before committing, check `git status --short --ignored` and make sure ignored
  local data is not staged.
