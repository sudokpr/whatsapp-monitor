#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

from image_analysis.analyzer import analyze_image_file, default_db_path, init_db, query_analysis


def main() -> int:
    parser = argparse.ArgumentParser(description="Analyse WhatsApp gallery images.")
    parser.add_argument("--group-id", help="WhatsApp group JID to analyse")
    parser.add_argument("--media-id", help="Single WhatsApp message/media ID to analyse")
    parser.add_argument("--force", action="store_true", help="Re-analyse images that already have successful results")
    parser.add_argument("--api-base", default=os.environ.get("WHATSAPP_API_BASE", "http://localhost:3000"))
    parser.add_argument("--token", default=os.environ.get("WHATSAPP_MEDIA_TOKEN", ""))
    parser.add_argument("--file", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--db", type=Path, default=default_db_path())
    parser.add_argument("--json", action="store_true", help="Print JSON output")
    parser.add_argument("--query", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()

    init_db(args.db)
    if args.query:
        print(json.dumps(query_analysis(args.db, args.group_id, args.media_id)))
        return 0

    if args.file:
        if not args.group_id or not args.media_id:
            parser.error("--file requires --group-id and --media-id")
        result = analyze_image_file(args.file, args.group_id, args.media_id, db_path=args.db, force=args.force)
        print(json.dumps(result) if args.json else f"Analysed {args.group_id}/{args.media_id}: {result['blur_label']}, {result['brightness_label']}")
        return 0

    if not args.group_id and not args.media_id:
        parser.error("set --group-id or --media-id")

    body = {"groupId": args.group_id, "mediaId": args.media_id, "force": args.force}
    response = _post_json(args.api_base.rstrip("/") + "/api/image-analysis/run", body, args.token)
    print(json.dumps(response, indent=2) if args.json else f"Queued {response.get('queued', 0)} image(s)")
    return 0


def _post_json(url: str, body: dict[str, object], token: str) -> dict[str, object]:
    data = json.dumps(body).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if token:
        headers["x-api-key"] = token
    request = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"API request failed: HTTP {exc.code} {detail}") from exc
    except urllib.error.URLError as exc:
        raise SystemExit(f"API request failed: {exc.reason}") from exc


if __name__ == "__main__":
    sys.exit(main())
