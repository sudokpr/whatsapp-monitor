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
- `GET /media/:groupId/:messageId` fetches stored message media on demand from
  WhatsApp servers when the message has a persisted media descriptor. If
  `WHATSAPP_MEDIA_TOKEN` is set, pass it as `?token=...` or `x-api-key`.
- `GET /stats` returns daily message counts and top users/groups
- `GET /metrics` returns Prometheus text metrics for monitor health, WhatsApp
  connection state, message capture, persistence, and API requests
- `POST /send-message` sends a WhatsApp text message through the active
  Baileys connection with JSON body `{ "jid": "...", "text": "..." }`.
  If `WHATSAPP_SEND_TOKEN` is set, pass it as `x-api-key` or a bearer token.

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
history to `data/digests.db`, and stores configured model summaries.

Python dependencies are managed with `uv` from `pyproject.toml`:

```bash
npm run py:sync
npm run digest:preview
```

Local digest settings live in `.env` and are loaded by
`scripts/digest/config.sh`. Use `.env.example` as the template for model
selection and feature toggles.

`npm run digest` runs the configured digest summarizers, stores each model
output, optionally sends a model comparison, and advances `digest_state` after a
successful run. Telegram delivery is disabled by default; set
`SEND_TELEGRAM=true` only when you want to mirror summaries there.
WhatsApp delivery is available through the local monitor API; set
`SEND_WHATSAPP=true` and `WHATSAPP_DIGEST_JID` to a contact, LID, or group JID
when you want digest summaries sent on WhatsApp. For sending to the same
account, the LID route may be required for readable delivery. If the monitor
uses `WHATSAPP_SEND_TOKEN`, set the same value for the digest process. Outbound
summaries start with the digest window and message/group counts.
Set `DIGEST_EXCLUDED_GROUP_IDS` to a comma- or space-separated list of group
JIDs to keep delivery/control groups out of future summaries.
Captioned image/video/document/audio messages store only WhatsApp media
metadata, not the media bytes. Digest deliveries append clickable media links
for those rows; clicking a link asks the running monitor to download and decrypt
the media from WhatsApp if it is still available. Set `WHATSAPP_MEDIA_BASE_URL`
to a URL reachable from where you read the digest, and set
`WHATSAPP_MEDIA_TOKEN` if you want those links token-protected.
Digest deliveries also include one time-bounded gallery link per conversation.
The responsive gallery lazily streams photos and video ranges from WhatsApp and
does not write media files to the Pi. Digests with more than five media items
use gallery links instead of listing every media URL.
`npm run digest:preview` exercises the pipeline without delivery sends or state
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

### Prometheus metrics

The monitor exposes scrape metrics at `GET /metrics`.

The digest cron job can also emit one Prometheus text snapshot per run:

```bash
PROMETHEUS_METRICS_ENABLED=true
PROMETHEUS_METRICS_FILE=data/metrics/whatsapp_digest.prom
PROMETHEUS_METRICS_PUSH_URL=
PROMETHEUS_METRICS_USERNAME=
PROMETHEUS_METRICS_PASSWORD=
```

`PROMETHEUS_METRICS_PUSH_URL` posts the text exposition payload to a compatible
ingestion endpoint, such as a Pushgateway grouping URL or a text import endpoint.
Strict Prometheus remote-write endpoints require protobuf/snappy encoding; point
those through an agent or gateway that accepts text exposition.
