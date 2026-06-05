#!/bin/bash
# Configuration for the WhatsApp digest workflow inside whatsapp-group-monitor.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
DATA_DIR="$REPO_DIR/data"

if [[ -f "$REPO_DIR/.env" ]]; then
    set -a
    source "$REPO_DIR/.env"
    set +a
fi

# Paths
TASK_DIR="$SCRIPT_DIR"
STATE_FILE="$DATA_DIR/state.json"
MESSAGES_LOG="${MESSAGES_LOG:-$DATA_DIR/messages.jsonl}"
DIGESTS_DB="${DIGESTS_DB:-$DATA_DIR/digests.db}"

# API endpoints
WHATSAPP_API="${WHATSAPP_API:-http://localhost:3000/listings}"
PARTICIPANTS_API="${PARTICIPANTS_API:-http://localhost:3000/participants}"

# Ollama. Disabled by default; set ENABLE_OLLAMA=true and choose a model in
# local `.env` to include a local Ollama summary in the digest.
OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
OLLAMA_MODEL="${OLLAMA_MODEL:-llama3.1}"
OLLAMA_MODELS=("$OLLAMA_MODEL")
OLLAMA_MODELS_LIST="${OLLAMA_MODELS[*]}"
OLLAMA_TIMEOUT_SECONDS="${OLLAMA_TIMEOUT_SECONDS:-300}"
OLLAMA_CHUNK_CHARS="${OLLAMA_CHUNK_CHARS:-3500}"
OLLAMA_NUM_CTX="${OLLAMA_NUM_CTX:-8192}"
OLLAMA_MERGE_CHUNKS="${OLLAMA_MERGE_CHUNKS:-false}"
ENABLE_OLLAMA="${ENABLE_OLLAMA:-false}"

# Codex Python client LLM comparison
ENABLE_CODEX="${ENABLE_CODEX:-true}"
CODEX_TIMEOUT_SECONDS="${CODEX_TIMEOUT_SECONDS:-600}"
CODEX_LLM_CWD="${CODEX_LLM_CWD:-$REPO_DIR}"
CODEX_LLM_SANDBOX="${CODEX_LLM_SANDBOX:-read_only}"
CODEX_LLM_EPHEMERAL="${CODEX_LLM_EPHEMERAL:-true}"
CODEX_LLM_MODEL="${CODEX_LLM_MODEL:-gpt-5.4-mini}"
CODEX_LLM_BASE_INSTRUCTIONS="${CODEX_LLM_BASE_INSTRUCTIONS:-}"
ENABLE_MODEL_COMPARISON="${ENABLE_MODEL_COMPARISON:-true}"

# DSPy prompt generation. "auto" uses DSPy only when it is installed and an LM
# is configured; "static" always uses the deterministic fallback prompts.
DSPY_PROMPT_MODE="${DSPY_PROMPT_MODE:-auto}"
DSPY_LM_MODEL="${DSPY_LM_MODEL:-}"
DSPY_LM_API_BASE="${DSPY_LM_API_BASE:-$OLLAMA_URL}"

# Logging and retention
LOG_FILE="${LOG_FILE:-$DATA_DIR/summary.log}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
DELETE_DIGEST_MD="${DELETE_DIGEST_MD:-false}"

# Telegram topic sender
SEND_TELEGRAM="${SEND_TELEGRAM:-true}"
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}"
TELEGRAM_TOPIC_ID="${TELEGRAM_TOPIC_ID:-}"
TELEGRAM_CONFIG="${TELEGRAM_CONFIG:-}"

# Digest window and context
DIGEST_WINDOW_HOURS="${DIGEST_WINDOW_HOURS:-3}"
CONTEXT_WINDOW_HOURS="${CONTEXT_WINDOW_HOURS:-3}"
CONTEXT_MESSAGES_PER_GROUP="${CONTEXT_MESSAGES_PER_GROUP:-0}"
REGULAR_MESSAGES_PER_GROUP="${REGULAR_MESSAGES_PER_GROUP:-0}"
NEWSLETTER_MESSAGES_PER_GROUP="${NEWSLETTER_MESSAGES_PER_GROUP:-0}"
DIGEST_MESSAGE_CHAR_LIMIT="${DIGEST_MESSAGE_CHAR_LIMIT:-0}"
CONTEXT_MESSAGE_CHAR_LIMIT="${CONTEXT_MESSAGE_CHAR_LIMIT:-0}"

# process -> advance digest_state after success; preview -> keep state unchanged.
DIGEST_PROCESSING_MODE="${DIGEST_PROCESSING_MODE:-process}"
