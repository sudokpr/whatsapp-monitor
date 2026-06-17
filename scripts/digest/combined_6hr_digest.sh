#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/config.sh"

LOCK_DIR="$SCRIPT_DIR/.combined-digest.lock"
LOCK_PID_FILE="$LOCK_DIR/pid"

acquire_lock() {
    if mkdir "$LOCK_DIR" 2>/dev/null; then
        echo "$$" > "$LOCK_PID_FILE"
        return 0
    fi

    if [[ -f "$LOCK_PID_FILE" ]]; then
        existing_pid="$(cat "$LOCK_PID_FILE" 2>/dev/null || true)"
        if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" 2>/dev/null; then
            echo "[$(date '+%Y-%m-%d %H:%M:%S')] Combined digest already running under pid $existing_pid; exiting" >> "$LOG_FILE"
            exit 0
        fi
    fi

    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Removing stale combined digest lock" >> "$LOG_FILE"
    rmdir "$LOCK_DIR" 2>/dev/null || rm -f "$LOCK_PID_FILE"
    rm -rf "$LOCK_DIR"
    mkdir "$LOCK_DIR"
    echo "$$" > "$LOCK_PID_FILE"
}

cleanup_lock() {
    rm -f "$LOCK_PID_FILE"
    rmdir "$LOCK_DIR" 2>/dev/null || true
}

acquire_lock
trap cleanup_lock EXIT

UV_BIN="${UV_BIN:-$(command -v uv || true)}"
if [[ -z "$UV_BIN" && -x "$HOME/.local/bin/uv" ]]; then
    UV_BIN="$HOME/.local/bin/uv"
fi

if [[ -z "$UV_BIN" ]]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Error: uv not found in PATH" >> "$LOG_FILE"
    exit 1
fi

export MESSAGES_LOG DIGESTS_DB DIGEST_WINDOW_HOURS CONTEXT_WINDOW_HOURS CONTEXT_MESSAGES_PER_GROUP REGULAR_MESSAGES_PER_GROUP NEWSLETTER_MESSAGES_PER_GROUP DIGEST_MESSAGE_CHAR_LIMIT CONTEXT_MESSAGE_CHAR_LIMIT PARTICIPANTS_API
export SEND_TELEGRAM TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID TELEGRAM_TOPIC_ID TELEGRAM_CONFIG RETENTION_DAYS DELETE_DIGEST_MD OLLAMA_URL OLLAMA_MODEL OLLAMA_API_KEY OLLAMA_TIMEOUT_SECONDS OLLAMA_CHUNK_CHARS OLLAMA_NUM_CTX OLLAMA_MERGE_CHUNKS ENABLE_OLLAMA LOG_FILE
export ENABLE_CODEX CODEX_TIMEOUT_SECONDS CODEX_LLM_CWD CODEX_LLM_MODEL CODEX_LLM_SANDBOX CODEX_LLM_EPHEMERAL CODEX_LLM_BASE_INSTRUCTIONS ENABLE_MODEL_COMPARISON
export DSPY_PROMPT_MODE DSPY_LM_MODEL DSPY_LM_API_BASE
if declare -p OLLAMA_MODELS >/dev/null 2>&1; then
    export OLLAMA_MODELS_LIST="${OLLAMA_MODELS[*]}"
else
    export OLLAMA_MODELS_LIST="${OLLAMA_MODELS_LIST:-$OLLAMA_MODEL}"
fi
export DIGEST_STATE_KEY="${DIGEST_STATE_KEY:-last_processed_ts}"
export DIGEST_PROCESSING_MODE="${DIGEST_PROCESSING_MODE:-process}"

cd "$REPO_DIR"
unset VIRTUAL_ENV
"$UV_BIN" run --prerelease allow python "$SCRIPT_DIR/combined_digest.py"
