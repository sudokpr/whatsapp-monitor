# WhatsApp Group Monitor

Minimal local TypeScript service for watching WhatsApp group messages through
Baileys and exposing recently captured messages over HTTP.

## Run

```bash
npm install
npm run dev
```

On first run, scan the QR code printed in the terminal from WhatsApp Linked
Devices. Baileys auth files are persisted in `data/auth`.

The API listens on port `3000` unless `PORT` is set:

- `GET /health` returns `ok`
- `GET /groups` returns discovered groups from the active connection
- `GET /listings` returns the last 100 stored group messages
- `GET /stats` returns daily message counts and top users/groups

## Group config

After the socket connects it fetches all participating groups, logs each
`{ id, name }`, and writes the list to `data/groups.json`.

Edit `data/config.json` to limit message capture:

```json
{
  "monitoredGroups": [
    "groupid1@g.us",
    "groupid2@g.us"
  ]
}
```

An empty `monitoredGroups` array means all group messages are processed.
The config file is read when each incoming group message is handled, so changes
apply without restarting the process.

## Digest sidecar

The active digest pipeline has been moved into this repo under
`scripts/digest/`. It reads `data/messages.jsonl`, writes digest state and
history to `data/digests.db`, and sends summaries through
`scripts/telegram/send_telegram_topic.py`.

Python dependencies are managed with `uv` from `pyproject.toml`:

```bash
npm run py:sync
npm run digest:preview
```

Local digest settings live in `.env` and are loaded by
`scripts/digest/config.sh`. Use `.env.example` as the template for model
selection and feature toggles.

`npm run digest` runs the configured digest summarizers, sends Telegram
notifications when configured, stores each model output, optionally sends a
model comparison, and advances `digest_state` after a successful run.
`npm run digest:preview` exercises the pipeline without Telegram sends or state
advancement.

`npm run py:sync` uses `uv sync --prerelease allow` because the Codex Python
client currently resolves through pre-release packages.

Ollama digest generation is optional and disabled by default. Set
`ENABLE_OLLAMA=true`, `OLLAMA_URL`, and `OLLAMA_MODEL` in `.env` to enable it.
For Ollama Cloud, use `OLLAMA_URL=https://ollama.com` and set
`OLLAMA_API_KEY`.
Set `ENABLE_MODEL_COMPARISON=false` to skip the comparison summary.

DSPy prompt generation is configured in `scripts/digest/config.sh`. By default
`DSPY_PROMPT_MODE=auto` uses the deterministic fallback prompt unless
`DSPY_LM_MODEL` is set and `dspy` can configure that LM. Set
`DSPY_PROMPT_MODE=static` to force the fallback prompt.

Example cron entry:

```cron
0 6,10,14,18,22 * * * cd /path/to/whatsapp-group-monitor && scripts/digest/combined_6hr_digest.sh >> data/summary.log 2>&1
```
