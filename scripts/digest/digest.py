#!/usr/bin/env python3
"""WhatsApp digest processor - generates digest from persisted WhatsApp messages."""
import json
import datetime
import re
import sys
import os
import sqlite3
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path

from input_guardrails import guard_message_text

# Get config from environment. Keep defaults aligned with config.sh so direct
# invocations read the live whatsapp-group-monitor persistence file.
repo_dir = Path(__file__).resolve().parents[2]
messages_log = os.environ.get('MESSAGES_LOG') or str(repo_dir / 'data' / 'messages.jsonl')
db_path = os.environ.get('DIGESTS_DB') or str(repo_dir / 'data' / 'digests.db')
window_hours = int(os.environ.get('DIGEST_WINDOW_HOURS', 3))
context_window_hours = int(os.environ.get('CONTEXT_WINDOW_HOURS', window_hours))
context_messages_per_group = int(os.environ.get('CONTEXT_MESSAGES_PER_GROUP', 0))
regular_messages_per_group = int(os.environ.get('REGULAR_MESSAGES_PER_GROUP', 0))
newsletter_messages_per_group = int(os.environ.get('NEWSLETTER_MESSAGES_PER_GROUP', 0))
digest_message_char_limit = int(os.environ.get('DIGEST_MESSAGE_CHAR_LIMIT', 0))
context_message_char_limit = int(os.environ.get('CONTEXT_MESSAGE_CHAR_LIMIT', 0))
participants_api = os.environ.get('PARTICIPANTS_API') or 'http://localhost:3000/participants'
state_key = os.environ.get('DIGEST_STATE_KEY', 'last_processed_ts')  # Allow per-LLM state keys
excluded_group_ids = {
    group_id.strip()
    for group_id in re.split(r'[\s,]+', os.environ.get('DIGEST_EXCLUDED_GROUP_IDS', ''))
    if group_id.strip()
}

# IST timezone
ist_tz = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
now = datetime.datetime.now(ist_tz)

# Get last processed timestamp from database
try:
    db = sqlite3.connect(db_path)
    cursor = db.cursor()
    cursor.execute("SELECT value FROM digest_state WHERE key=?", (state_key,))
    result = cursor.fetchone()
    last_processed_ts = int(result[0]) if result else 0
    db.close()
except Exception as e:
    print(f"Warning: Could not read digest_state[{state_key}]: {e}", file=sys.stderr)
    last_processed_ts = 0

# Calculate window start (fallback only if state is empty)
window_start = now - datetime.timedelta(hours=window_hours)
window_start_ts = int(window_start.timestamp() * 1000)

# Once state exists, it is authoritative. Falling back to the moving window on
# every run can skip unprocessed messages after a missed cron execution.
effective_start_ts = last_processed_ts if last_processed_ts > 0 else window_start_ts
window_start_str = datetime.datetime.fromtimestamp(effective_start_ts/1000, ist_tz).strftime('%Y-%m-%d %H:%M IST')

def message_timestamp(message):
    try:
        return int(message.get('timestamp') or 0)
    except (TypeError, ValueError):
        return 0

def is_whatsapp_status(message):
    return message.get('groupId') == 'status@broadcast'

def is_excluded_group(message):
    return message.get('groupId') in excluded_group_ids

def is_extractor_metadata_noise(message):
    text = (message.get('text') or '').strip()
    if not text:
        return False

    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        return False

    metadata_prefixes = ('groupId:', 'remoteJid:', 'id:', 'participant:', 'text:', 'url:')
    if not all(line.startswith(metadata_prefixes) for line in lines):
        return False

    # These rows were produced by an overly broad extractor fallback from
    # reactions/protocol/media metadata; they are not user-visible messages.
    return any(line.startswith(('groupId:', 'remoteJid:', 'url:')) for line in lines)

# Load messages
all_msgs = []
try:
    with open(messages_log) as f:
        for line_number, line in enumerate(f, start=1):
            if not line.strip():
                continue
            try:
                message = json.loads(line)
                if is_whatsapp_status(message):
                    continue
                if is_excluded_group(message):
                    continue
                if is_extractor_metadata_noise(message):
                    continue
                all_msgs.append(message)
            except json.JSONDecodeError as e:
                print(f"Warning: Skipping invalid JSON at {messages_log}:{line_number}: {e}", file=sys.stderr)
except FileNotFoundError:
    print(f"Warning: Messages log not found: {messages_log}", file=sys.stderr)

recent_msgs = [m for m in all_msgs if message_timestamp(m) > effective_start_ts]
recent_msgs.sort(key=message_timestamp)
last_message_ts = max((message_timestamp(m) for m in recent_msgs), default=0)

context_start_ts = effective_start_ts - int(context_window_hours * 60 * 60 * 1000)
context_msgs = [
    m for m in all_msgs
    if context_start_ts < message_timestamp(m) <= effective_start_ts
]
context_msgs.sort(key=message_timestamp)

# Get participant mapping
try:
    with urllib.request.urlopen(participants_api, timeout=12) as response:
        participants_response = response.read().decode("utf-8")
except (urllib.error.URLError, TimeoutError, OSError):
    participants_response = ''
try:
    lid_map = json.loads(participants_response) if participants_response else {}
except json.JSONDecodeError:
    lid_map = {}

def resolve(lid):
    jid = lid_map.get(lid, '')
    return jid.replace('@s.whatsapp.net', '') if jid else lid.replace('@lid', '')[:8]

def ts_to_time(ts):
    try:
        return datetime.datetime.fromtimestamp(ts/1000, ist_tz).strftime('%H:%M')
    except:
        return '??'

def extract_urls(text):
    return re.findall(r'https?://[^\s<>"\'\)]+', text)

def link_summary(text):
    urls = extract_urls(text)
    if not urls:
        return ''
    lower_urls = [url.lower() for url in urls]
    if any('youtube.com/shorts' in url or 'youtu.be/' in url for url in lower_urls):
        return 'Shared YouTube short'
    if any('chat.whatsapp.com' in url for url in lower_urls):
        return 'Shared WhatsApp group link'
    if any('maps.app.goo.gl' in url or 'google.com/maps' in url for url in lower_urls):
        return 'Shared map/location link'
    return ''

def normalized_message_text(text):
    guarded, _ = guard_message_text(text)
    return redact_phone_numbers(guarded)

def counted_message_text(text, count):
    if count <= 1:
        return text
    if text == 'Shared YouTube short':
        return f'Shared {count} YouTube shorts'
    if text == 'Shared WhatsApp group link':
        return f'Shared {count} WhatsApp group links'
    if text == 'Shared map/location link':
        return f'Shared {count} map/location links'
    return text

def limit_text(text, limit):
    if limit <= 0 or len(text) <= limit:
        return text
    return f"{text[:limit].rstrip()} ... [truncated {len(text) - limit} chars]"

def redact_phone_numbers(text):
    """Remove phone-like identifiers before text is sent to any LLM."""
    if not text:
        return ''

    urls = []

    def stash_url(match):
        urls.append(match.group(0))
        return f"__URL_{len(urls) - 1}__"

    redacted = re.sub(r'https?://[^\s<>"\'\)]+', stash_url, str(text))
    redacted = re.sub(r'@\d{8,24}@(s\.whatsapp\.net|lid|g\.us|newsletter)\b', '@contact', redacted)
    redacted = re.sub(r'@\d{8,24}\b', '@contact', redacted)
    redacted = re.sub(r'\b\d{8,24}@(s\.whatsapp\.net|lid|g\.us|newsletter)\b', 'contact', redacted)
    redacted = re.sub(
        r'(?<![\w/])(?:\+?\d[\d\s().-]{8,}\d)(?![\w/])',
        '[phone]',
        redacted,
    )

    for index, url in enumerate(urls):
        redacted = redacted.replace(f"__URL_{index}__", url)
    return redacted

def redact_conversation_name(name):
    redacted = redact_phone_numbers(name or 'Unknown')
    redacted = re.sub(r'DM:\s*(?:contact|\[phone\](?:@\w+)?)', 'DM:contact', redacted)
    return redacted

def is_newsletter_group(group_name):
    name = (group_name or '').lower()
    return 'newsletter' in name or 'bulletin' in name

by_group = defaultdict(list)
for m in recent_msgs:
    by_group[m['groupName']].append(m)

context_by_group = defaultdict(list)
active_groups = set(by_group)
for m in context_msgs:
    group_name = m.get('groupName')
    if group_name in active_groups:
        context_by_group[group_name].append(m)

def limited_messages(messages, limit, *, from_end=False):
    if limit <= 0:
        return messages
    return messages[-limit:] if from_end else messages[:limit]

context_count = sum(
    len(limited_messages(msgs, context_messages_per_group, from_end=True))
    for msgs in context_by_group.values()
)

ordered_groups = [grp for grp, _ in sorted(by_group.items(), key=lambda x: -len(x[1]))]
label_counts = defaultdict(int)
group_labels = {}
for grp in ordered_groups:
    label = redact_conversation_name(grp)
    label_counts[label] += 1
    if label_counts[label] > 1 and label.startswith('DM:contact'):
        label = f"{label}-{label_counts[label]}"
    group_labels[grp] = label
if label_counts.get('DM:contact', 0) > 1:
    first_dm = next((grp for grp in ordered_groups if group_labels.get(grp) == 'DM:contact'), None)
    if first_dm:
        group_labels[first_dm] = 'DM:contact-1'

lines = []
lines.append(f"📱 WHATSAPP DIGEST — since last run")
lines.append(f"Showing msgs from {datetime.datetime.fromtimestamp(effective_start_ts/1000, ist_tz).strftime('%H:%M')} to {now.strftime('%H:%M')} IST | {len(recent_msgs)} msgs | {len(by_group)} groups\n")

for grp in ordered_groups:
    msgs = by_group[grp]
    participants = set(m['sender'] for m in msgs)
    newsletter_group = is_newsletter_group(grp)
    group_label = group_labels[grp]
    sender_labels = {}

    def sender_label(sender):
        if sender not in sender_labels:
            sender_labels[sender] = f"participant-{len(sender_labels) + 1}"
        return sender_labels[sender]

    lines.append(f"📌 {group_label} ({len(msgs)} msgs, {len(participants)} participants)")

    context_for_group = limited_messages(
        context_by_group.get(grp, []),
        context_messages_per_group,
        from_end=True,
    )
    if context_for_group:
        context_start = datetime.datetime.fromtimestamp(context_start_ts/1000, ist_tz).strftime('%H:%M')
        context_end = datetime.datetime.fromtimestamp(effective_start_ts/1000, ist_tz).strftime('%H:%M')
        lines.append(f"   Context from previous window ({context_start}-{context_end}, not new):")
        for m in context_for_group:
            text = normalized_message_text(m.get('text', ''))
            if not text:
                continue
            sender = sender_label(m.get('sender', ''))
            time = ts_to_time(message_timestamp(m))
            lines.append(f"   [{time}] {sender}: {limit_text(text, context_message_char_limit)}")
        lines.append("   News updates:" if newsletter_group else "   New messages:")
    
    conversations = []
    for m in msgs:
        text = (m.get('text') or '').strip()
        if not text:
            continue
        conversations.append(m)
    
    message_limit = newsletter_messages_per_group if newsletter_group else regular_messages_per_group
    display_entries = []
    for m in limited_messages(conversations, message_limit):
        sender = sender_label(m.get('sender', ''))
        time = ts_to_time(m['timestamp'])
        text = normalized_message_text(m.get('text', ''))
        if display_entries and display_entries[-1]['text'] == text and text.startswith('Shared '):
            display_entries[-1]['count'] += 1
            continue
        display_entries.append({'time': time, 'sender': sender, 'text': text, 'count': 1})

    for entry in display_entries:
        text = limit_text(counted_message_text(entry['text'], entry['count']), digest_message_char_limit)
        lines.append(f"   [{entry['time']}] {entry['sender']}: {text}")
    
    links = []
    for m in msgs:
        for u in extract_urls(m['text']):
            u = u.split('?')[0]
            if any(x in u.lower() for x in ['townscript','marathon','register','event','run']):
                if 'chat.whatsapp.com' not in u and u not in links:
                    links.append(u)
    
    if links:
        for l in links[:2]:
            lines.append(f"   🔗 {l}")
    lines.append("")

output = '\n'.join(lines)

# Output digest to stdout
print(output)

# NOTE: state update moved to outer orchestrator (gemini_6hr_digest.sh)
# The orchestrator will update digest_state only after successful processing and DB insertion.

# Also return metadata for DB storage
digest_metadata = {
    'window_start': window_start_str,
    'window_end': now.strftime('%Y-%m-%d %H:%M IST'),
    'effective_start_ts': effective_start_ts,
    'last_processed_ts': last_processed_ts,
    'last_message_ts': last_message_ts,
    'messages_log': messages_log,
    'message_count': len(recent_msgs),
    'group_count': len(by_group),
    'context_count': context_count,
    'context_window_hours': context_window_hours,
    'digest_message_char_limit': digest_message_char_limit,
    'context_message_char_limit': context_message_char_limit,
    'digest': output
}

# Store as JSON to stderr for script to capture
print(json.dumps(digest_metadata, indent=2), file=sys.stderr)
