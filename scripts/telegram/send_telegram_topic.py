#!/usr/bin/env python3
"""Telegram topic sender for digest notifications."""
import json
import os
import sys
import time
import urllib.error
import urllib.request

CONFIG = os.environ.get("TELEGRAM_CONFIG")
MAX_LEN = int(os.environ.get("TELEGRAM_MAX_LEN", "3800"))
TIMEOUT_SECONDS = int(os.environ.get("TELEGRAM_TIMEOUT_SECONDS", "30"))
ASSUME_SENT_ON_TIMEOUT = os.environ.get("TELEGRAM_ASSUME_SENT_ON_TIMEOUT", "true").lower() in {
    "1",
    "true",
    "yes",
    "on",
}


def token():
    env_token = os.environ.get("TELEGRAM_BOT_TOKEN")
    if env_token:
        return env_token
    if not CONFIG:
        raise RuntimeError("Set TELEGRAM_BOT_TOKEN or TELEGRAM_CONFIG before sending Telegram messages")
    with open(CONFIG) as handle:
        cfg = json.load(handle)
    return cfg["channels"]["telegram"]["botToken"]


def chat_id():
    value = os.environ.get("TELEGRAM_CHAT_ID")
    if not value:
        raise RuntimeError("Set TELEGRAM_CHAT_ID before sending Telegram messages")
    return int(value)


def topic_id():
    value = os.environ.get("TELEGRAM_TOPIC_ID")
    return int(value) if value else None


def chunks(text, limit=MAX_LEN):
    text = text.strip()
    if not text:
        return []
    while len(text) > limit:
        cut = text.rfind("\n\n", 0, limit)
        if cut < limit * 0.5:
            cut = text.rfind("\n", 0, limit)
        if cut < limit * 0.5:
            cut = limit
        yield text[:cut].strip()
        text = text[cut:].strip()
    if text:
        yield text


def send(part):
    url = f"https://api.telegram.org/bot{token()}/sendMessage"
    payload = {
        "chat_id": chat_id(),
        "text": part,
    }
    thread_id = topic_id()
    if thread_id is not None:
        payload["message_thread_id"] = thread_id
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as response:
        return json.loads(response.read())


def send_text(text, dry_run=None):
    parts = list(chunks(text))
    if dry_run is None:
        dry_run = os.environ.get("DRY_RUN") == "1"
    if dry_run:
        destination = os.environ.get("TELEGRAM_TOPIC_ID") or os.environ.get("TELEGRAM_CHAT_ID") or "configured chat"
        return f"DRY_RUN: would send {len(parts)} Telegram message(s) to {destination}, {len(text)} chars total"

    assumed_timeouts = 0
    for index, part in enumerate(parts):
        if len(parts) > 1:
            part = f"({index + 1}/{len(parts)})\n" + part
        try:
            result = send(part)
        except TimeoutError:
            if not ASSUME_SENT_ON_TIMEOUT:
                raise
            assumed_timeouts += 1
            time.sleep(0.8)
            continue
        except urllib.error.URLError as exc:
            if not (ASSUME_SENT_ON_TIMEOUT and isinstance(exc.reason, TimeoutError)):
                raise
            assumed_timeouts += 1
            time.sleep(0.8)
            continue
        if not result.get("ok"):
            raise RuntimeError(f"Telegram send failed: {result.get('description', 'Unknown error')}")
        time.sleep(0.8)
    if assumed_timeouts:
        return f"sent {len(parts)} Telegram message(s); assumed delivered after {assumed_timeouts} timeout(s)"
    return f"sent {len(parts)} Telegram message(s)"


def main():
    if len(sys.argv) > 1:
        with open(sys.argv[1]) as handle:
            text = handle.read()
    else:
        text = sys.stdin.read()
    print(send_text(text))


if __name__ == "__main__":
    main()
