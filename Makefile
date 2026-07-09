SERVICE ?= whatsapp-group-monitor.service
LOG_LINES ?= 120
PORT ?= 3000
MONITOR_LOG ?= data/monitor.log
SYSTEMD_USER_DIR ?= $(HOME)/.config/systemd/user
SERVICE_TEMPLATE ?= systemd/$(SERVICE)
SERVICE_UNIT ?= $(SYSTEMD_USER_DIR)/$(SERVICE)
NPM_BIN ?= $(shell command -v npm)
SERVICE_PATH ?= $(PATH)

.PHONY: help install dev build start py-sync digest digest-preview health service-install service-status service-restart service-stop qr-login logs logs-follow digest-logs digest-logs-follow status backup-run backup-timers backup-status backup-logs backup-logs-follow

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
		'  service-install     Install and start the systemd user service' \
		'  service-status      Show the systemd user service status' \
		'  service-restart     Restart the systemd user service' \
		'  service-stop        Stop the systemd user service' \
		'  qr-login            Stop service, reset auth, and run dev to print login QR' \
		'  logs                Show recent monitor service logs' \
		'  logs-follow         Follow monitor service logs' \
		'  digest-logs         Show recent digest cron log lines' \
		'  digest-logs-follow  Follow digest cron log' \
		'  backup-run          Run the DietPi backup now' \
		'  backup-timers       Show the DietPi backup timer schedule' \
		'  backup-status       Show the DietPi backup service/timer status' \
		'  backup-logs         Show recent DietPi backup logs' \
		'  backup-logs-follow  Follow DietPi backup logs'

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

service-install:
	@test -n "$(NPM_BIN)" || { printf 'npm not found in PATH\n' >&2; exit 1; }
	mkdir -p $(dir $(MONITOR_LOG))
	mkdir -p $(SYSTEMD_USER_DIR)
	sed \
		-e 's#__WORKING_DIRECTORY__#$(CURDIR)#g' \
		-e 's#__NPM__#$(NPM_BIN)#g' \
		-e 's#__PATH__#$(SERVICE_PATH)#g' \
		-e 's#__LOG_FILE__#$(CURDIR)/$(MONITOR_LOG)#g' \
		$(SERVICE_TEMPLATE) > $(SERVICE_UNIT)
	systemctl --user daemon-reload
	systemctl --user enable --now $(SERVICE)

service-status:
	systemctl --user --no-pager --full status $(SERVICE)

service-restart:
	systemctl --user restart $(SERVICE)

service-stop:
	systemctl --user stop $(SERVICE)

qr-login:
	systemctl --user stop $(SERVICE)
	@if [ -d data/auth ]; then \
		backup="data/auth.logged-out.$$(date +%Y%m%d-%H%M%S)"; \
		mv data/auth "$$backup"; \
		printf 'Archived existing WhatsApp auth to %s\n' "$$backup"; \
	else \
		printf 'No existing data/auth directory found; starting fresh login.\n'; \
	fi
	npm run dev

logs:
	tail -n $(LOG_LINES) $(MONITOR_LOG)

logs-follow:
	tail -f $(MONITOR_LOG)

digest-logs:
	tail -n $(LOG_LINES) data/summary.log

digest-logs-follow:
	tail -f data/summary.log

backup-run:
	systemctl --user start whatsapp-group-monitor-backup.service

backup-timers:
	systemctl --user list-timers whatsapp-group-monitor-backup.timer --no-pager

backup-status:
	systemctl --user status whatsapp-group-monitor-backup.timer whatsapp-group-monitor-backup.service --no-pager

backup-logs:
	journalctl --user -u whatsapp-group-monitor-backup.service -n $(LOG_LINES) --no-pager

backup-logs-follow:
	journalctl --user -u whatsapp-group-monitor-backup.service -f
