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
  connection state, message capture, persistence, local storage, and API
  requests
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
metadata, not the media bytes. Digest deliveries include one time-bounded
gallery link per conversation; when no gallery is available, a small digest can
instead include individual media links. Opening either asks the running monitor
to download and decrypt the media from WhatsApp if it is still available. Set
`WHATSAPP_MEDIA_BASE_URL` to a URL reachable from where you read the digest, and
set `WHATSAPP_MEDIA_TOKEN` if you want those links token-protected.
The responsive gallery lazily streams photos and video ranges from WhatsApp and
does not write media files to the Pi except for short-lived image-analysis temp
files.
`npm run digest:preview` exercises the pipeline without delivery sends or state
advancement.

### Image analysis

The media gallery can analyse image and sticker quality in the background using
classical Python image-processing code. The monitor downloads each queued image
to `data/image-analysis/cache/`, runs `scripts/analyse_images.py --file ...`,
then deletes the temp media file. Results are stored in SQLite at
`data/image_analysis.db`; derived previews are stored under
`data/image-analysis/previews/`.

Install the Python dependencies before using the analyzer:

```bash
npm run py:sync
```

Opening a gallery page queues missing image analyses automatically. Existing
successful rows are skipped unless forced. To queue old images from the command
line while the monitor is running:

```bash
python scripts/analyse_images.py --group-id GROUP_ID
python scripts/analyse_images.py --group-id GROUP_ID --force
python scripts/analyse_images.py --media-id MEDIA_ID
```

If `WHATSAPP_MEDIA_TOKEN` is set, pass it through the environment or with
`--token`. The same operation is available over HTTP:

- `POST /api/image-analysis/run` with `{ "groupId": "...", "force": false }`
- `GET /api/image-analysis?groupId=...`
- `GET /api/image-analysis/:groupId/:messageId/preview/:kind` where `kind` is
  `grayscale`, `edges`, `fourier`, or `histogram`

Configurable thresholds:

```bash
IMAGE_ANALYSIS_CONCURRENCY=1
IMAGE_ANALYSIS_MAX_DIMENSION=1024
IMAGE_ANALYSIS_BLUR_BLURRY=80
IMAGE_ANALYSIS_BLUR_SLIGHTLY_BLURRY=180
IMAGE_ANALYSIS_DUPLICATE_HASH_DISTANCE=4
IMAGE_ANALYSIS_SIMILAR_HASH_DISTANCE=6
IMAGE_ANALYSIS_HEAVY_BLOCKINESS=9
```

The first version intentionally uses understandable signal-processing
operations: grayscale intensity for brightness/contrast, variance of the
Laplacian for blur, Canny edges for edge density, a high-pass residual for an
approximate noise estimate, lightweight colour clustering, perceptual hashes,
an approximate JPEG blockiness score, and a 2D FFT for educational frequency
energy diagnostics. Noise, compression, and Fourier metrics are estimates, not
definitive image-quality judgements.

Example JSON output:

```json
{
  "media_id": "3EB0...",
  "group_id": "1203...@g.us",
  "status": "success",
  "width": 1600,
  "height": 1200,
  "brightness_mean": 141.6,
  "brightness_label": "normal",
  "contrast_stddev": 52.4,
  "blur_score": 236.8,
  "blur_label": "sharp",
  "edge_density": 0.083,
  "noise_score": 4.7,
  "dominant_colors": [{ "rgb": [210, 204, 190], "percent": 0.32 }],
  "similar_matches": [],
  "compression_label": "normal",
  "low_frequency_energy": 0.91,
  "medium_frequency_energy": 0.08,
  "high_frequency_energy": 0.01
}
```

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

Storage metrics are emitted by the monitor process:

- `whatsapp_storage_data_dir_bytes`
- `whatsapp_storage_messages_jsonl_bytes`
- `whatsapp_storage_archive_bytes`
- `whatsapp_storage_archive_files`
- `whatsapp_storage_free_bytes`
- `whatsapp_storage_total_bytes`

Image analysis metrics are emitted by the monitor process when the gallery
analyzer is enabled:

- `whatsapp_image_analysis_queue_depth`
- `whatsapp_image_analysis_running`
- `whatsapp_image_analysis_concurrency`
- `whatsapp_image_analysis_enqueued_total`
- `whatsapp_image_analysis_skipped_existing_total`
- `whatsapp_image_analysis_runs_total{status="success|error"}`
- `whatsapp_image_analysis_duration_seconds_bucket`
- `whatsapp_image_analysis_duration_seconds_sum`
- `whatsapp_image_analysis_duration_seconds_count`
- `whatsapp_image_analysis_last_duration_seconds`
- `whatsapp_image_analysis_last_run_timestamp_seconds`
- `whatsapp_image_analysis_last_success_timestamp_seconds`
- `whatsapp_image_analysis_last_failure_timestamp_seconds`
- `whatsapp_image_analysis_records{status="success|error|processing"}`
- `whatsapp_image_analysis_signal_records{signal="blurry|dark|duplicates|compressed|screenshots"}`

Average image analysis latency can be queried with
`rate(whatsapp_image_analysis_duration_seconds_sum[5m]) / rate(whatsapp_image_analysis_duration_seconds_count[5m])`.
P99 image analysis latency can be queried with
`histogram_quantile(0.99, rate(whatsapp_image_analysis_duration_seconds_bucket[5m]))`.

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

Digest run metrics:

- `whatsapp_digest_last_run_timestamp_seconds`
- `whatsapp_digest_last_success_timestamp_seconds`
- `whatsapp_digest_last_failure_timestamp_seconds`
- `whatsapp_digest_last_duration_seconds`
- `whatsapp_digest_last_message_count`
- `whatsapp_digest_last_group_count`
- `whatsapp_digest_last_suspected_prompt_injection_count`
- `whatsapp_digest_last_context_suspected_prompt_injection_count`
- `whatsapp_digest_last_sent_to_telegram`
- `whatsapp_digest_telegram_enabled`
- `whatsapp_digest_last_sent_to_whatsapp`
- `whatsapp_digest_whatsapp_enabled`
- `whatsapp_digest_state_last_processed_timestamp_seconds`
- `whatsapp_digest_last_message_timestamp_seconds`

Digest LLM request metrics are labeled by `provider`, `model`, `phase`,
`status`, and `source`:

- `whatsapp_digest_llm_last_request_duration_seconds`
- `whatsapp_digest_llm_last_prompt_tokens`
- `whatsapp_digest_llm_last_completion_tokens`
- `whatsapp_digest_llm_last_total_tokens`
- `whatsapp_digest_llm_last_prompt_chars`
- `whatsapp_digest_llm_last_completion_chars`

The daily DietPi backup job can emit a Prometheus text snapshot and push it to
a Pushgateway-compatible endpoint:

```bash
BACKUP_PROMETHEUS_METRICS_ENABLED=true
BACKUP_PROMETHEUS_METRICS_FILE=data/metrics/whatsapp_backup.prom
BACKUP_PROMETHEUS_METRICS_PUSH_URL=http://prometheus-pushgateway:9091/metrics/job/whatsapp_backup
```

Backup run metrics:

- `whatsapp_backup_last_run_timestamp_seconds`
- `whatsapp_backup_last_success_timestamp_seconds`
- `whatsapp_backup_last_failure_timestamp_seconds`
- `whatsapp_backup_last_duration_seconds`
- `whatsapp_backup_last_exit_code`
