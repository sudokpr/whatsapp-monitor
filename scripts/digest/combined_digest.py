#!/usr/bin/env python3
"""Run one WhatsApp digest window through configured summarizers."""
import datetime
import contextlib
import io
import json
import os
import runpy
import signal
import sqlite3
import sys
import time
from pathlib import Path

import requests

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
REPO_DIR = SCRIPT_DIR.parents[1]
TELEGRAM_DIR = REPO_DIR / "scripts" / "telegram"
if str(TELEGRAM_DIR) not in sys.path:
    sys.path.insert(0, str(TELEGRAM_DIR))

from codex_llm import ask_codex_text, build_codex_llm_config
from prompt_builder import (
    build_chunk_prompt,
    build_merge_prompt,
    build_model_comparison_prompt,
    build_prompt,
)
from prometheus_metrics import emit_digest_metrics
from send_telegram_topic import send_text

ENV_FILE = REPO_DIR / ".env"
STATE_KEY = os.environ.get("DIGEST_STATE_KEY", "last_processed_ts")
LEGACY_STATE_KEYS = ("last_processed_ts", "last_processed_ts_gemini", "last_processed_ts_ollama")
RUN_STARTED_AT = datetime.datetime.now().timestamp()
LLM_METRICS = []


def load_env_file(path):
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'\"")
        if value.startswith("${") and ":-" in value and value.endswith("}"):
            inner = value[2:-1]
            env_key, default = inner.split(":-", 1)
            value = os.environ.get(env_key, default)
        os.environ.setdefault(key, value)


load_env_file(ENV_FILE)

def parse_model_list(value, fallback):
    raw = (value or fallback or "").strip().strip("()").replace('"', "")
    return [model for model in raw.replace(",", " ").split() if model]

DIGESTS_DB = os.environ.get("DIGESTS_DB") or str(REPO_DIR / "data" / "digests.db")
RETENTION_DAYS = int(os.environ.get("RETENTION_DAYS") or 30)
LOG_FILE = os.environ.get("LOG_FILE") or str(REPO_DIR / "data" / "summary.log")
OLLAMA_URL = os.environ.get("OLLAMA_URL") or "http://localhost:11434"
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL") or "llama3.1"
OLLAMA_API_KEY = (os.environ.get("OLLAMA_API_KEY") or "").strip()
OLLAMA_MODELS = parse_model_list(
    os.environ.get("OLLAMA_MODELS_LIST")
    or os.environ.get("OLLAMA_MODELS"),
    OLLAMA_MODEL,
)
OLLAMA_TIMEOUT_SECONDS = int(os.environ.get("OLLAMA_TIMEOUT_SECONDS") or 300)
OLLAMA_CHUNK_CHARS = int(os.environ.get("OLLAMA_CHUNK_CHARS") or 3500)
OLLAMA_NUM_CTX = int(os.environ.get("OLLAMA_NUM_CTX") or 8192)
OLLAMA_MERGE_CHUNKS = (os.environ.get("OLLAMA_MERGE_CHUNKS") or "false").strip().lower() == "true"
ENABLE_OLLAMA = (os.environ.get("ENABLE_OLLAMA") or "false").strip().lower() == "true"
ENABLE_CODEX = (os.environ.get("ENABLE_CODEX") or "false").strip().lower() == "true"
CODEX_TIMEOUT_SECONDS = int(os.environ.get("CODEX_TIMEOUT_SECONDS") or 600)
ENABLE_MODEL_COMPARISON = (
    os.environ.get("ENABLE_MODEL_COMPARISON") or "true"
).strip().lower() == "true"
PROCESSING_MODE = (os.environ.get("DIGEST_PROCESSING_MODE") or "process").strip().lower()
DELETE_DIGEST_MD = (os.environ.get("DELETE_DIGEST_MD") or "false").strip().lower() == "true"
SEND_TELEGRAM = (os.environ.get("SEND_TELEGRAM") or "false").strip().lower() == "true"
SEND_WHATSAPP = (os.environ.get("SEND_WHATSAPP") or "false").strip().lower() == "true"
WHATSAPP_DIGEST_JID = (os.environ.get("WHATSAPP_DIGEST_JID") or "").strip()
WHATSAPP_SEND_API = os.environ.get("WHATSAPP_SEND_API") or "http://localhost:3000/send-message"
WHATSAPP_SEND_TOKEN = (os.environ.get("WHATSAPP_SEND_TOKEN") or "").strip()
WHATSAPP_TIMEOUT_SECONDS = int(os.environ.get("WHATSAPP_TIMEOUT_SECONDS") or 30)
WHATSAPP_MAX_LEN = int(os.environ.get("WHATSAPP_MAX_LEN") or 3500)


IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))


def log(message):
    timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{timestamp}] {message}"
    if sys.stdout.isatty():
        print(line)
    with open(LOG_FILE, "a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def estimate_tokens(text):
    if not text:
        return 0
    try:
        import tiktoken

        encoding = tiktoken.get_encoding("o200k_base")
        return len(encoding.encode(text))
    except Exception:
        return max(1, round(len(text) / 4))


def record_llm_metric(provider, model, phase, status, started_at, prompt, completion="", usage=None, token_source="estimated"):
    usage = usage or {}
    prompt_tokens = usage.get("prompt_tokens")
    completion_tokens = usage.get("completion_tokens")
    total_tokens = usage.get("total_tokens")
    if prompt_tokens is None:
        prompt_tokens = estimate_tokens(prompt)
    if completion_tokens is None:
        completion_tokens = estimate_tokens(completion)
    if total_tokens is None:
        total_tokens = int(prompt_tokens) + int(completion_tokens)
    LLM_METRICS.append(
        {
            "provider": provider,
            "model": model,
            "phase": phase,
            "status": status,
            "token_source": token_source,
            "duration_seconds": max(0.0, time.monotonic() - started_at),
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": total_tokens,
            "prompt_chars": len(prompt or ""),
            "completion_chars": len(completion or ""),
        }
    )


def ensure_schema():
    conn = sqlite3.connect(DIGESTS_DB)
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS digest_state (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS digests (
            id INTEGER PRIMARY KEY,
            run_timestamp TEXT,
            window_start TEXT,
            window_end TEXT,
            message_count INTEGER,
            group_count INTEGER,
            raw_digest TEXT,
            prompt TEXT,
            summary_ollama TEXT,
            summary_codex TEXT,
            summary_comparison TEXT,
            sent_to_telegram INTEGER,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    cur.execute("PRAGMA table_info(digests)")
    existing = {row[1] for row in cur.fetchall()}
    for column in (
        "summary_ollama",
        "summary_codex",
        "summary_comparison",
        "prompt",
    ):
        if column not in existing:
            cur.execute(f"ALTER TABLE digests ADD COLUMN {column} TEXT")
    if "sent_to_telegram" not in existing:
        cur.execute("ALTER TABLE digests ADD COLUMN sent_to_telegram INTEGER DEFAULT 0")
    conn.commit()
    conn.close()


def seed_shared_state_from_legacy():
    conn = sqlite3.connect(DIGESTS_DB)
    cur = conn.cursor()
    cur.execute(
        "SELECT key, value FROM digest_state WHERE key IN ({})".format(
            ",".join("?" for _ in LEGACY_STATE_KEYS)
        ),
        LEGACY_STATE_KEYS,
    )
    values = []
    for key, value in cur.fetchall():
        try:
            values.append((key, int(value)))
        except (TypeError, ValueError):
            pass
    if values:
        latest_key, latest_value = max(values, key=lambda item: item[1])
        cur.execute(
            """
            INSERT INTO digest_state (key, value, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET
                value = CASE
                    WHEN CAST(digest_state.value AS INTEGER) < CAST(excluded.value AS INTEGER)
                    THEN excluded.value
                    ELSE digest_state.value
                END,
                updated_at = CURRENT_TIMESTAMP
            """,
            (STATE_KEY, str(latest_value)),
        )
        log(f"Seeded {STATE_KEY} from {latest_key}={latest_value}")
    conn.commit()
    conn.close()


def run_digest():
    previous_env = {}
    for key in (
        "DIGEST_STATE_KEY",
        "MESSAGES_LOG",
        "DELETED_MESSAGES_LOG",
        "DIGESTS_DB",
        "DIGEST_WINDOW_HOURS",
        "CONTEXT_WINDOW_HOURS",
        "CONTEXT_MESSAGES_PER_GROUP",
        "PARTICIPANTS_API",
    ):
        previous_env[key] = os.environ.get(key)

    os.environ["DIGEST_STATE_KEY"] = STATE_KEY
    os.environ.setdefault("MESSAGES_LOG", str(REPO_DIR / "data" / "messages.jsonl"))
    os.environ.setdefault("DELETED_MESSAGES_LOG", str(REPO_DIR / "data" / "deleted-messages.jsonl"))
    os.environ.setdefault("DIGESTS_DB", DIGESTS_DB)

    stdout = io.StringIO()
    stderr = io.StringIO()
    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            runpy.run_path(str(SCRIPT_DIR / "digest.py"), run_name="__main__")
    finally:
        for key, old_value in previous_env.items():
            if old_value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = old_value

    stderr_text = stderr.getvalue()
    metadata_start = stderr_text.find("{")
    metadata = json.loads(stderr_text[metadata_start:]) if metadata_start >= 0 else {}
    digest = metadata.get("digest") or stdout.getvalue()
    metadata["digest"] = digest
    return metadata


def clean_llm_summary(summary):
    lines = []
    for raw_line in summary.splitlines():
        line = raw_line.strip()
        lower = line.lower()
        if not line:
            lines.append("")
            continue
        if lower.startswith(("here is", "here's")) and "digest" in lower:
            continue
        line = line.replace("**", "")
        lines.append(line)

    while lines and not lines[0]:
        lines.pop(0)
    while lines and not lines[-1]:
        lines.pop()
    if lines and lines[-1].strip().lower() == "next actions:":
        lines.pop()
        while lines and not lines[-1]:
            lines.pop()
    return "\n".join(lines).strip()


def combine_chunk_summaries(chunk_summaries):
    cleaned = []
    for summary in chunk_summaries:
        text = summary.split(":\n", 1)[1] if summary.startswith("Chunk ") and ":\n" in summary else summary
        text = clean_llm_summary(text)
        if text:
            cleaned.append(text)
    return "\n\n".join(cleaned).strip()


def strip_previous_window_context(raw_digest):
    lines = []
    skipping_context = False
    for raw_line in raw_digest.splitlines():
        stripped = raw_line.strip()
        if stripped.startswith("Context from previous window"):
            skipping_context = True
            continue
        if skipping_context and stripped in {"New messages:", "News updates:"}:
            skipping_context = False
            lines.append(raw_line)
            continue
        if skipping_context:
            continue
        lines.append(raw_line)
    return "\n".join(lines).strip()


def split_digest_for_ollama(raw_digest, max_chars):
    if max_chars <= 0 or len(raw_digest) <= max_chars:
        return [raw_digest]

    marker = "\n📌 "
    parts = raw_digest.split(marker)
    header = parts[0].strip()
    sections = []
    for part in parts[1:]:
        sections.append("📌 " + part.strip())

    chunks = []
    current = header

    def flush_current():
        nonlocal current
        if current.strip():
            chunks.append(current.strip())
        current = header

    for section in sections:
        candidate = f"{current}\n\n{section}" if current.strip() else section
        if len(candidate) <= max_chars:
            current = candidate
            continue

        if current.strip() != header:
            flush_current()
            candidate = f"{current}\n\n{section}"
            if len(candidate) <= max_chars:
                current = candidate
                continue

        lines = section.splitlines()
        section_header = lines[0] if lines else "📌 Continued conversation"
        current = f"{header}\n\n{section_header}"
        for line in lines[1:]:
            candidate = f"{current}\n{line}"
            if len(candidate) > max_chars and current.strip() != f"{header}\n\n{section_header}".strip():
                flush_current()
                current = f"{header}\n\n{section_header} (continued)\n{line}"
            else:
                current = candidate

    if current.strip():
        chunks.append(current.strip())
    return chunks


def call_ollama_prompt(model, prompt, label="request"):
    started_at = time.monotonic()
    try:
        log(f"Ollama {model} {label}: prompt_size={len(prompt)} chars, timeout={OLLAMA_TIMEOUT_SECONDS}s")
        headers = {"Authorization": f"Bearer {OLLAMA_API_KEY}"} if OLLAMA_API_KEY else None
        response = requests.post(
            f"{OLLAMA_URL}/api/chat",
            headers=headers,
            json={
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "stream": False,
                "options": {"num_ctx": OLLAMA_NUM_CTX},
            },
            timeout=OLLAMA_TIMEOUT_SECONDS,
        )
        if response.status_code != 200:
            log(f"Ollama {model} {label} failed: {response.status_code} - {response.text}")
            record_llm_metric("ollama", model, label, "failure", started_at, prompt, token_source="actual")
            return ""
        payload = response.json()
        summary = clean_llm_summary(payload.get("message", {}).get("content", "").strip())
        usage = {
            "prompt_tokens": payload.get("prompt_eval_count"),
            "completion_tokens": payload.get("eval_count"),
        }
        usage["total_tokens"] = (usage["prompt_tokens"] or 0) + (usage["completion_tokens"] or 0)
        record_llm_metric(
            "ollama",
            model,
            label,
            "success" if summary else "empty",
            started_at,
            prompt,
            summary,
            usage=usage,
            token_source="actual",
        )
        return summary
    except Exception as exc:
        log(f"Ollama {model} {label} failed: {exc}")
        record_llm_metric("ollama", model, label, "failure", started_at, prompt, token_source="estimated")
        return ""


def call_ollama(model, raw_digest):
    raw_digest = strip_previous_window_context(raw_digest)
    chunks = split_digest_for_ollama(raw_digest, OLLAMA_CHUNK_CHARS)
    if len(chunks) == 1:
        return call_ollama_prompt(model, build_prompt(raw_digest), "single")

    log(
        f"Ollama {model} chunking enabled: raw_digest={len(raw_digest)} chars, "
        f"chunk_target={OLLAMA_CHUNK_CHARS}, chunks={len(chunks)}, num_ctx={OLLAMA_NUM_CTX}"
    )
    chunk_summaries = []
    for index, chunk in enumerate(chunks, start=1):
        summary = call_ollama_prompt(
            model,
            build_chunk_prompt(chunk, index, len(chunks)),
            f"chunk {index}/{len(chunks)}",
        )
        if not summary:
            log(f"Ollama chunk {index}/{len(chunks)} returned no summary")
            continue
        chunk_summaries.append(f"Chunk {index}/{len(chunks)}:\n{summary}")

    if not chunk_summaries:
        return ""

    joined = "\n\n".join(chunk_summaries)
    if len(chunk_summaries) == 1:
        return chunk_summaries[0].split(":\n", 1)[1]
    if not OLLAMA_MERGE_CHUNKS:
        log("Ollama merge disabled; using concatenated chunk summaries")
        return combine_chunk_summaries(chunk_summaries)

    merged = call_ollama_prompt(model, build_merge_prompt(joined), "merge")
    if merged:
        return merged
    log("Ollama merge failed; using concatenated chunk summaries")
    return joined


def call_ollama_models(raw_digest, metadata):
    summaries = {}
    telegram_sent_any = False
    whatsapp_sent_any = False
    for model in OLLAMA_MODELS:
        log(f"Calling Ollama {model}")
        try:
            summary = call_ollama(model, raw_digest)
        except Exception as exc:
            log(f"Ollama {model} failed: {exc}")
            continue
        if not summary:
            log(f"Ollama {model} returned no summary")
            continue
        summaries[model] = summary
        telegram_sent, whatsapp_sent = send_summary(f"Ollama digest ({model})", summary, metadata)
        telegram_sent_any = telegram_sent or telegram_sent_any
        whatsapp_sent_any = whatsapp_sent or whatsapp_sent_any

    return summaries, telegram_sent_any, whatsapp_sent_any


def call_codex(prompt, label="summary"):
    codex_env = os.environ.copy()
    for key in (
        "CODEX_LLM_CWD",
        "CODEX_LLM_MODEL",
        "CODEX_LLM_SANDBOX",
        "CODEX_LLM_EPHEMERAL",
        "CODEX_LLM_BASE_INSTRUCTIONS",
    ):
        value = os.environ.get(key)
        if value is not None:
            codex_env[key] = value

    cfg = build_codex_llm_config(codex_env)

    def timeout_handler(_signum, _frame):
        raise TimeoutError

    old_handler = signal.getsignal(signal.SIGALRM)
    started_at = time.monotonic()
    model = cfg.model or "default"
    try:
        log(f"Codex LLM request: prompt_size={len(prompt)} chars, timeout={CODEX_TIMEOUT_SECONDS}s")
        signal.signal(signal.SIGALRM, timeout_handler)
        signal.setitimer(signal.ITIMER_REAL, CODEX_TIMEOUT_SECONDS)
        result = ask_codex_text(prompt, cfg)
    except TimeoutError:
        log(f"Codex LLM timed out after {CODEX_TIMEOUT_SECONDS}s")
        record_llm_metric("codex", model, label, "timeout", started_at, prompt)
        return ""
    except Exception as exc:
        log(f"Codex LLM failed: {exc}")
        record_llm_metric("codex", model, label, "failure", started_at, prompt)
        return ""
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, old_handler)
    summary = clean_llm_summary(result.strip())
    record_llm_metric("codex", model, label, "success" if summary else "empty", started_at, prompt, summary)
    return summary


def compare_model_summaries(model_summaries, reference_digest):
    if not ENABLE_MODEL_COMPARISON:
        log("Model comparison disabled by configuration")
        return ""
    if len(model_summaries) < 2:
        log("Model comparison skipped: fewer than two summaries available")
        return ""
    comparison_prompt = build_model_comparison_prompt(model_summaries, reference_digest)
    log(f"Model comparison request: summaries={len(model_summaries)}, prompt_size={len(comparison_prompt)} chars")
    return call_codex(comparison_prompt, "comparison")


def format_delivery_message(label, summary, metadata=None):
    lines = [label]
    if metadata:
        window_start = metadata.get("window_start") or "unknown"
        window_end = metadata.get("window_end") or "unknown"
        message_count = metadata.get("message_count", 0)
        group_count = metadata.get("group_count", 0)
        lines.extend([
            f"Window: {window_start} to {window_end}",
            f"Messages: {message_count} across {group_count} conversations",
        ])
    lines.append("")
    lines.append(summary)
    if metadata:
        gallery_links = metadata.get("gallery_links") or []
        if gallery_links:
            lines.extend(["", "Media galleries:"])
            for item in gallery_links:
                group = item.get("group") or "conversation"
                count = item.get("count") or 0
                lines.append(f"{group}: {count} item{'s' if count != 1 else ''}")
                lines.append(item.get("url") or "")
                lines.append("")
        media_links = metadata.get("media_links") or []
        if not gallery_links and media_links and len(media_links) <= 5:
            lines.extend(["", "Media links:"])
            for item in media_links[:20]:
                group = item.get("group") or "conversation"
                time = item.get("time") or "??"
                media_label = item.get("label") or "media"
                text = item.get("text") or ""
                url = item.get("url") or ""
                context = f" - {text}" if text else ""
                lines.append(f"{time} {group}: {media_label}{context}".strip())
                lines.append(url)
                lines.append("")
            if len(media_links) > 20:
                lines.append(f"- ... {len(media_links) - 20} more media links omitted")
        message_links = metadata.get("message_links") or []
        if message_links:
            lines.extend(["", "Message links:"])
            for item in message_links[:20]:
                group = item.get("group") or "conversation"
                time = item.get("time") or "??"
                sender = item.get("sender") or "participant"
                context = item.get("context") or "Link shared"
                url = item.get("url") or ""
                lines.append(f"{time} {group} ({sender}): {context}".strip())
                lines.append(url)
                lines.append("")
            if len(message_links) > 20:
                lines.append(f"- ... {len(message_links) - 20} more message links omitted")
    return "\n".join(str(line) for line in lines)


def send_to_telegram(label, summary, metadata=None):
    if not summary:
        return False
    if not SEND_TELEGRAM:
        log(f"Telegram skipped for {label}: SEND_TELEGRAM=false")
        return False
    message = format_delivery_message(label, summary, metadata)
    try:
        result = send_text(message)
    except Exception as exc:
        log(f"Telegram send failed for {label}: {exc}")
        return False
    log(f"Telegram sent for {label}: {result}")
    return True


def message_chunks(text, limit):
    if limit <= 0 or len(text) <= limit:
        return [text]

    parts = []
    remaining = text
    while len(remaining) > limit:
        split_at = remaining.rfind("\n\n", 0, limit)
        if split_at < max(1, limit // 2):
            split_at = remaining.rfind("\n", 0, limit)
        if split_at < max(1, limit // 2):
            split_at = limit
        parts.append(remaining[:split_at].strip())
        remaining = remaining[split_at:].strip()
    if remaining:
        parts.append(remaining)
    return parts


def send_to_whatsapp(label, summary, metadata=None):
    if not summary:
        return False
    if not SEND_WHATSAPP:
        log(f"WhatsApp skipped for {label}: SEND_WHATSAPP=false")
        return False
    if not WHATSAPP_DIGEST_JID:
        log(f"WhatsApp send failed for {label}: WHATSAPP_DIGEST_JID is not set")
        return False

    message = format_delivery_message(label, summary, metadata)
    parts = message_chunks(message, WHATSAPP_MAX_LEN)
    try:
        for index, part in enumerate(parts, start=1):
            payload = {
                "jid": WHATSAPP_DIGEST_JID,
                "text": f"Part {index}/{len(parts)}\n\n{part}" if len(parts) > 1 else part,
            }
            response = requests.post(
                WHATSAPP_SEND_API,
                json=payload,
                headers={"x-api-key": WHATSAPP_SEND_TOKEN} if WHATSAPP_SEND_TOKEN else None,
                timeout=WHATSAPP_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
    except Exception as exc:
        log(f"WhatsApp send failed for {label}: {exc}")
        return False
    log(f"WhatsApp sent for {label}: {len(parts)} message(s) to {WHATSAPP_DIGEST_JID}")
    return True


def send_summary(label, summary, metadata=None):
    return send_to_telegram(label, summary, metadata), send_to_whatsapp(label, summary, metadata)


def insert_digest(metadata, prompt, ollama_summary, codex_summary, comparison_summary, sent_to_telegram):
    conn = sqlite3.connect(DIGESTS_DB)
    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO digests (
            run_timestamp, window_start, window_end, message_count, group_count,
            raw_digest, prompt, summary_ollama, summary_codex, summary_comparison,
            sent_to_telegram
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            datetime.datetime.now(IST).strftime("%F-%H%M"),
            metadata.get("window_start", ""),
            metadata.get("window_end", ""),
            int(metadata.get("message_count", 0)),
            int(metadata.get("group_count", 0)),
            metadata.get("digest", ""),
            prompt,
            ollama_summary,
            codex_summary,
            comparison_summary,
            1 if sent_to_telegram else 0,
        ),
    )
    digest_id = cur.lastrowid
    conn.commit()
    conn.close()
    return digest_id


def update_state(last_message_ts):
    conn = sqlite3.connect(DIGESTS_DB)
    cur = conn.cursor()
    for key in LEGACY_STATE_KEYS:
        cur.execute(
            """
            INSERT INTO digest_state (key, value, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
            """,
            (key, str(last_message_ts)),
        )
    conn.commit()
    conn.close()


def cleanup():
    conn = sqlite3.connect(DIGESTS_DB)
    cur = conn.cursor()
    cur.execute("DELETE FROM digests WHERE created_at < datetime('now', '-' || ? || ' days')", (RETENTION_DAYS,))
    deleted = cur.rowcount
    conn.commit()
    conn.close()
    if deleted:
        log(f"Cleaned up {deleted} old digest entries")


def main():
    ensure_schema()
    seed_shared_state_from_legacy()
    log(
        f"Starting combined digest run (mode: {PROCESSING_MODE}, "
        f"Ollama: {', '.join(OLLAMA_MODELS)}; "
        f"Codex: {'enabled' if ENABLE_CODEX else 'disabled'}; "
        f"comparison: {'enabled' if ENABLE_MODEL_COMPARISON else 'disabled'}; "
        f"Telegram: {'enabled' if SEND_TELEGRAM else 'disabled'}; "
        f"WhatsApp: {'enabled' if SEND_WHATSAPP else 'disabled'})"
    )
    metadata = run_digest()
    message_count = int(metadata.get("message_count", 0))
    group_count = int(metadata.get("group_count", 0))
    last_message_ts = int(metadata.get("last_message_ts", 0) or 0)
    suspected_prompt_injection_count = int(metadata.get("suspected_prompt_injection_count", 0) or 0)
    context_suspected_prompt_injection_count = int(
        metadata.get("context_suspected_prompt_injection_count", 0) or 0
    )
    log(f"Digest window: messages={message_count}, groups={group_count}, start={metadata.get('window_start', '')}")
    if message_count == 0:
        log("No new messages; state unchanged")
        emit_digest_metrics(
            log,
            status="empty",
            started_at=RUN_STARTED_AT,
            now=datetime.datetime.now().timestamp(),
            message_count=0,
            group_count=0,
            sent_to_telegram=0,
            telegram_enabled=1 if SEND_TELEGRAM else 0,
            sent_to_whatsapp=0,
            whatsapp_enabled=1 if SEND_WHATSAPP else 0,
            last_processed_ts=metadata.get("last_processed_ts", 0),
            last_message_ts=metadata.get("last_message_ts", 0),
            suspected_prompt_injection_count=suspected_prompt_injection_count,
            context_suspected_prompt_injection_count=context_suspected_prompt_injection_count,
            llm_metrics=LLM_METRICS,
        )
        return

    raw_digest = metadata.get("digest", "")
    reference_digest = raw_digest
    if not DELETE_DIGEST_MD:
        digest_path = Path(DIGESTS_DB).resolve().parent / "digest.md"
        digest_path.write_text(raw_digest, encoding="utf-8")
        reference_digest = digest_path.read_text(encoding="utf-8")
    prompt = build_prompt(raw_digest)

    telegram_sent_any = False
    whatsapp_sent_any = False
    model_summaries = []
    codex_summary = ""
    if ENABLE_CODEX:
        codex_summary = call_codex(prompt)
        if codex_summary:
            model_summaries.append(("Codex", codex_summary))
            telegram_sent, whatsapp_sent = send_summary("Codex digest", codex_summary, metadata)
            telegram_sent_any = telegram_sent or telegram_sent_any
            whatsapp_sent_any = whatsapp_sent or whatsapp_sent_any
        else:
            log("Codex LLM returned no summary")
    else:
        log("Codex LLM disabled by configuration")

    ollama_summaries = {}
    if ENABLE_OLLAMA and not codex_summary:
        log("Codex summary unavailable; trying Ollama fallback")
        ollama_summaries, ollama_telegram_sent_any, ollama_whatsapp_sent_any = call_ollama_models(raw_digest, metadata)
        model_summaries.extend((f"Ollama {model}", summary) for model, summary in ollama_summaries.items())
        telegram_sent_any = ollama_telegram_sent_any or telegram_sent_any
        whatsapp_sent_any = ollama_whatsapp_sent_any or whatsapp_sent_any
    elif ENABLE_OLLAMA:
        log("Ollama fallback skipped: Codex summary succeeded")
    else:
        log("Ollama disabled by configuration")

    if not ollama_summaries and not codex_summary:
        raise RuntimeError("All configured LLMs failed; state was not advanced")

    ollama_summary = "\n\n".join(
        f"=== {model} ===\n{summary}" for model, summary in ollama_summaries.items()
    )
    comparison_summary = compare_model_summaries(model_summaries, reference_digest)
    if comparison_summary:
        telegram_sent, whatsapp_sent = send_summary("Model comparison", comparison_summary, metadata)
        telegram_sent_any = telegram_sent or telegram_sent_any
        whatsapp_sent_any = whatsapp_sent or whatsapp_sent_any

    digest_id = insert_digest(
        metadata,
        prompt,
        ollama_summary,
        codex_summary,
        comparison_summary,
        telegram_sent_any,
    )
    delivery_enabled = SEND_TELEGRAM or SEND_WHATSAPP
    delivery_sent_any = telegram_sent_any or whatsapp_sent_any
    if delivery_enabled and not delivery_sent_any:
        raise RuntimeError(f"No configured delivery succeeded for digest ID:{digest_id}; state was not advanced")
    if PROCESSING_MODE == "process" and last_message_ts > 0:
        update_state(last_message_ts)
        log(f"Updated digest_state {STATE_KEY} and legacy keys to {last_message_ts}")
    elif PROCESSING_MODE != "process":
        log("Preview mode: digest_state was not advanced")
    cleanup()
    log(f"Combined digest complete (ID:{digest_id}, msgs:{message_count}, groups:{group_count})")
    emit_digest_metrics(
        log,
        status="success",
        started_at=RUN_STARTED_AT,
        now=datetime.datetime.now().timestamp(),
        message_count=message_count,
        group_count=group_count,
        sent_to_telegram=1 if telegram_sent_any else 0,
        telegram_enabled=1 if SEND_TELEGRAM else 0,
        sent_to_whatsapp=1 if whatsapp_sent_any else 0,
        whatsapp_enabled=1 if SEND_WHATSAPP else 0,
        last_processed_ts=last_message_ts,
        last_message_ts=last_message_ts,
        suspected_prompt_injection_count=suspected_prompt_injection_count,
        context_suspected_prompt_injection_count=context_suspected_prompt_injection_count,
        llm_metrics=LLM_METRICS,
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        log(f"Fatal error: {exc}")
        emit_digest_metrics(
            log,
            status="failure",
            started_at=RUN_STARTED_AT,
            now=datetime.datetime.now().timestamp(),
            telegram_enabled=1 if SEND_TELEGRAM else 0,
            whatsapp_enabled=1 if SEND_WHATSAPP else 0,
            llm_metrics=LLM_METRICS,
        )
        sys.exit(1)
