SERVICE ?= whatsapp-group-monitor.service
LOG_LINES ?= 120
PORT ?= 3000

.PHONY: help install dev build start py-sync digest digest-preview health service-status service-restart service-stop logs logs-follow digest-logs digest-logs-follow status

help:
	@printf '%s\n' \
		'Targets:' \
		'  install             Install Node dependencies' \
		'  dev                 Run the monitor in development' \
		'  build               Build TypeScript' \
		'  start               Run the built service' \
		'  py-sync             Sync Python dependencies' \
		'  digest-preview      Preview digest without Telegram or state changes' \
		'  digest              Run the digest pipeline' \
		'  health              Check the local HTTP health endpoint' \
		'  status              Check service status and health endpoint' \
		'  service-status      Show the systemd user service status' \
		'  service-restart     Restart the systemd user service' \
		'  service-stop        Stop the systemd user service' \
		'  logs                Show recent monitor service logs' \
		'  logs-follow         Follow monitor service logs' \
		'  digest-logs         Show recent digest cron log lines' \
		'  digest-logs-follow  Follow digest cron log'

install:
	npm install

dev:
	npm run dev

build:
	npm run build

start:
	npm start

py-sync:
	npm run py:sync

digest-preview:
	npm run digest:preview

digest:
	npm run digest

health:
	curl -fsS http://127.0.0.1:$(PORT)/health

status: service-status health

service-status:
	systemctl --user --no-pager --full status $(SERVICE)

service-restart:
	systemctl --user restart $(SERVICE)

service-stop:
	systemctl --user stop $(SERVICE)

logs:
	journalctl --user -u $(SERVICE) --no-pager -n $(LOG_LINES)

logs-follow:
	journalctl --user -u $(SERVICE) -f

digest-logs:
	tail -n $(LOG_LINES) data/summary.log

digest-logs-follow:
	tail -f data/summary.log
