"""Prometheus metric emission helpers for the digest cron job."""
import os
import socket
import time
from pathlib import Path

import requests


REPO_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = REPO_DIR / "data"


def _env_bool(name, default=False):
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _float(value, default=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _labels(extra=None):
    labels = {
        "job": os.environ.get("PROMETHEUS_METRICS_JOB") or "whatsapp_digest",
        "instance": os.environ.get("PROMETHEUS_METRICS_INSTANCE") or socket.gethostname(),
    }
    labels.update(extra or {})
    return labels


def _format_labels(labels):
    if not labels:
        return ""
    rendered = ",".join(
        f'{key}="{_escape_label_value(value)}"'
        for key, value in sorted(labels.items())
    )
    return f"{{{rendered}}}"


def _escape_label_value(value):
    return str(value).replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')


def _line(name, value, labels=None):
    return f"{name}{_format_labels(_labels(labels))} {value}"


def render_digest_metrics(**fields):
    status = fields.get("status") or "unknown"
    now = _float(fields.get("now"), time.time())
    started_at = _float(fields.get("started_at"), now)
    duration = max(0.0, now - started_at)
    success = 1 if status in {"success", "empty"} else 0
    failure = 1 if status == "failure" else 0

    lines = [
        "# HELP whatsapp_digest_last_run_timestamp_seconds Unix timestamp of the latest digest cron run.",
        "# TYPE whatsapp_digest_last_run_timestamp_seconds gauge",
        _line("whatsapp_digest_last_run_timestamp_seconds", now, {"status": status}),
        "# HELP whatsapp_digest_last_success_timestamp_seconds Unix timestamp of the latest successful digest cron run.",
        "# TYPE whatsapp_digest_last_success_timestamp_seconds gauge",
        _line("whatsapp_digest_last_success_timestamp_seconds", now if success else 0, {"status": status}),
        "# HELP whatsapp_digest_last_failure_timestamp_seconds Unix timestamp of the latest failed digest cron run.",
        "# TYPE whatsapp_digest_last_failure_timestamp_seconds gauge",
        _line("whatsapp_digest_last_failure_timestamp_seconds", now if failure else 0, {"status": status}),
        "# HELP whatsapp_digest_last_duration_seconds Duration of the latest digest cron run.",
        "# TYPE whatsapp_digest_last_duration_seconds gauge",
        _line("whatsapp_digest_last_duration_seconds", f"{duration:.6f}", {"status": status}),
        "# HELP whatsapp_digest_last_message_count Number of new messages found by the latest digest cron run.",
        "# TYPE whatsapp_digest_last_message_count gauge",
        _line("whatsapp_digest_last_message_count", _int(fields.get("message_count")), {"status": status}),
        "# HELP whatsapp_digest_last_group_count Number of groups with new messages in the latest digest cron run.",
        "# TYPE whatsapp_digest_last_group_count gauge",
        _line("whatsapp_digest_last_group_count", _int(fields.get("group_count")), {"status": status}),
        "# HELP whatsapp_digest_last_sent_to_telegram Whether the latest digest run sent at least one Telegram message.",
        "# TYPE whatsapp_digest_last_sent_to_telegram gauge",
        _line("whatsapp_digest_last_sent_to_telegram", _int(fields.get("sent_to_telegram")), {"status": status}),
        "# HELP whatsapp_digest_telegram_enabled Whether Telegram delivery is enabled for the digest cron job.",
        "# TYPE whatsapp_digest_telegram_enabled gauge",
        _line("whatsapp_digest_telegram_enabled", _int(fields.get("telegram_enabled")), {"status": status}),
        "# HELP whatsapp_digest_last_sent_to_whatsapp Whether the latest digest run sent at least one WhatsApp message.",
        "# TYPE whatsapp_digest_last_sent_to_whatsapp gauge",
        _line("whatsapp_digest_last_sent_to_whatsapp", _int(fields.get("sent_to_whatsapp")), {"status": status}),
        "# HELP whatsapp_digest_whatsapp_enabled Whether WhatsApp delivery is enabled for the digest cron job.",
        "# TYPE whatsapp_digest_whatsapp_enabled gauge",
        _line("whatsapp_digest_whatsapp_enabled", _int(fields.get("whatsapp_enabled")), {"status": status}),
        "# HELP whatsapp_digest_state_last_processed_timestamp_seconds Unix timestamp of the digest state cursor.",
        "# TYPE whatsapp_digest_state_last_processed_timestamp_seconds gauge",
        _line(
            "whatsapp_digest_state_last_processed_timestamp_seconds",
            _float(fields.get("last_processed_ts")) / 1000,
            {"status": status},
        ),
        "# HELP whatsapp_digest_last_message_timestamp_seconds Unix timestamp of the latest message included in a digest run.",
        "# TYPE whatsapp_digest_last_message_timestamp_seconds gauge",
        _line(
            "whatsapp_digest_last_message_timestamp_seconds",
            _float(fields.get("last_message_ts")) / 1000,
            {"status": status},
        ),
        "",
    ]
    return "\n".join(str(line) for line in lines)


def emit_digest_metrics(log, **fields):
    if not _env_bool("PROMETHEUS_METRICS_ENABLED", False):
        return

    rendered = render_digest_metrics(**fields)
    output_path = Path(
        os.environ.get("PROMETHEUS_METRICS_FILE")
        or DATA_DIR / "metrics" / "whatsapp_digest.prom"
    )
    try:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(rendered, encoding="utf-8")
    except Exception as exc:
        log(f"Prometheus metrics file write failed: {exc}")

    push_url = os.environ.get("PROMETHEUS_METRICS_PUSH_URL") or os.environ.get("PROMETHEUS_REMOTE_WRITE_URL")
    if not push_url:
        return

    auth = None
    username = os.environ.get("PROMETHEUS_METRICS_USERNAME") or os.environ.get("PROMETHEUS_REMOTE_WRITE_USERNAME")
    password = os.environ.get("PROMETHEUS_METRICS_PASSWORD") or os.environ.get("PROMETHEUS_REMOTE_WRITE_PASSWORD")
    if username or password:
        auth = (username or "", password or "")

    timeout = _float(os.environ.get("PROMETHEUS_METRICS_TIMEOUT_SECONDS"), 10.0)
    try:
        response = requests.post(
            push_url,
            data=rendered.encode("utf-8"),
            headers={"Content-Type": "text/plain; version=0.0.4; charset=utf-8"},
            auth=auth,
            timeout=timeout,
        )
        response.raise_for_status()
    except Exception as exc:
        log(f"Prometheus metrics push failed: {exc}")
