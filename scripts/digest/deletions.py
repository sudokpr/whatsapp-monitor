#!/usr/bin/env python3
"""Helpers for excluding soft-deleted WhatsApp messages."""

import json


def message_key(record):
    group_id = record.get("groupId")
    message_id = record.get("id")
    if not isinstance(group_id, str) or not isinstance(message_id, str):
        return None
    if not group_id or not message_id:
        return None
    return group_id, message_id


def load_deleted_message_keys(path):
    keys = set()
    try:
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                if not line.strip():
                    continue
                try:
                    key = message_key(json.loads(line))
                except json.JSONDecodeError:
                    continue
                if key:
                    keys.add(key)
    except FileNotFoundError:
        pass
    return keys


def exclude_deleted_messages(messages, deleted_keys):
    return [
        message
        for message in messages
        if message_key(message) not in deleted_keys
    ]


def hide_deleted_reply_text(messages, deleted_keys):
    sanitized = []
    for message in messages:
        reply = message.get("replyTo")
        reply_id = reply.get("id") if isinstance(reply, dict) else None
        reply_key = (message.get("groupId"), reply_id)
        if (
            not isinstance(reply_id, str)
            or reply_key not in deleted_keys
            or "text" not in reply
        ):
            sanitized.append(message)
            continue

        clean_message = dict(message)
        clean_reply = dict(reply)
        clean_reply.pop("text", None)
        clean_message["replyTo"] = clean_reply
        sanitized.append(clean_message)
    return sanitized
