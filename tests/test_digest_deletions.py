import json
import sys
import tempfile
import unittest
from pathlib import Path


DIGEST_DIR = Path(__file__).resolve().parents[1] / "scripts" / "digest"
sys.path.insert(0, str(DIGEST_DIR))

from deletions import (
    exclude_deleted_messages,
    hide_deleted_reply_text,
    load_deleted_message_keys,
)


class DigestDeletionTests(unittest.TestCase):
    def test_tombstoned_message_is_excluded_but_original_is_retained(self):
        messages = [
            {"groupId": "group-1", "id": "message-1", "text": "deleted text"},
            {"groupId": "group-1", "id": "message-2", "text": "kept text"},
        ]

        with tempfile.TemporaryDirectory() as directory:
            tombstones = Path(directory) / "deleted-messages.jsonl"
            tombstones.write_text(
                json.dumps({
                    "groupId": "group-1",
                    "id": "message-1",
                    "deletedAt": 123,
                }) + "\n",
                encoding="utf-8",
            )
            deleted_keys = load_deleted_message_keys(tombstones)

        self.assertEqual(
            exclude_deleted_messages(messages, deleted_keys),
            [{"groupId": "group-1", "id": "message-2", "text": "kept text"}],
        )
        self.assertEqual(messages[0]["text"], "deleted text")

    def test_missing_or_invalid_tombstone_file_is_safe(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "missing.jsonl"
            self.assertEqual(load_deleted_message_keys(path), set())
            path.write_text("not-json\n{}\n", encoding="utf-8")
            self.assertEqual(load_deleted_message_keys(path), set())

    def test_deleted_quoted_text_is_hidden_from_retained_reply(self):
        messages = [{
            "groupId": "group-1",
            "id": "message-2",
            "text": "retained reply",
            "replyTo": {
                "id": "message-1",
                "sender": "participant-1",
                "text": "deleted quoted text",
            },
        }]

        sanitized = hide_deleted_reply_text(
            messages,
            {("group-1", "message-1")},
        )

        self.assertEqual(
            sanitized[0]["replyTo"],
            {"id": "message-1", "sender": "participant-1"},
        )
        self.assertEqual(messages[0]["replyTo"]["text"], "deleted quoted text")


if __name__ == "__main__":
    unittest.main()
