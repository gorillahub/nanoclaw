#!/usr/bin/env python3
"""Check Telegram webhook registration for NanoClaw Telegram agents.

Runs as a local helper. Intended to be executed as user `nanoclaw` (so it can
read /opt/nanoclaw/groups/telegram_*/.env).

Outputs *no secrets* — only webhook info (url, pending_update_count, last_error_*).
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


GROUPS = ["telegram_holly", "telegram_marcus", "telegram_wes", "telegram_sam"]
ENV_KEY_TOKEN_CANDIDATES = [
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_TOKEN",
    "BOT_TOKEN",
]


@dataclass
class WebhookInfo:
    group: str
    ok: bool
    url: str | None = None
    pending_update_count: int | None = None
    last_error_date: int | None = None
    last_error_message: str | None = None
    raw_subset: dict[str, Any] | None = None
    error: str | None = None


def _parse_dotenv(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in path.read_text().splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        if "=" not in s:
            continue
        k, v = s.split("=", 1)
        k = k.strip()
        v = v.strip()
        # strip optional surrounding quotes
        if len(v) >= 2 and ((v[0] == v[-1] == '"') or (v[0] == v[-1] == "'")):
            v = v[1:-1]
        out[k] = v
    return out


def _get_token(env: dict[str, str]) -> str | None:
    for k in ENV_KEY_TOKEN_CANDIDATES:
        v = env.get(k)
        if v:
            return v
    # heuristic: any key ending with _BOT_TOKEN
    for k, v in env.items():
        if k.endswith("_BOT_TOKEN") and v:
            return v
    return None


def _http_get_json(url: str) -> dict[str, Any]:
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=10) as resp:
        body = resp.read().decode("utf-8", errors="replace")
    return json.loads(body)


def check_group(group: str) -> WebhookInfo:
    env_path = Path(f"/opt/nanoclaw/groups/{group}/.env")
    if not env_path.exists():
        return WebhookInfo(group=group, ok=False, error=f"missing env file: {env_path}")

    env = _parse_dotenv(env_path)
    token = _get_token(env)
    if not token:
        return WebhookInfo(group=group, ok=False, error="no telegram bot token found in env")

    # Defensive: token should look like 123456:ABC...
    if not re.match(r"^\d+:[A-Za-z0-9_-]+$", token):
        return WebhookInfo(group=group, ok=False, error="telegram bot token format looks unexpected")

    data = _http_get_json(f"https://api.telegram.org/bot{token}/getWebhookInfo")
    if not isinstance(data, dict) or not data.get("ok"):
        return WebhookInfo(group=group, ok=False, error=f"telegram returned not ok: {data!r}")

    result = data.get("result") or {}
    subset = {
        "url": result.get("url"),
        "pending_update_count": result.get("pending_update_count"),
        "last_error_date": result.get("last_error_date"),
        "last_error_message": result.get("last_error_message"),
        "ip_address": result.get("ip_address"),
        "max_connections": result.get("max_connections"),
        "has_custom_certificate": result.get("has_custom_certificate"),
    }

    return WebhookInfo(
        group=group,
        ok=True,
        url=result.get("url"),
        pending_update_count=result.get("pending_update_count"),
        last_error_date=result.get("last_error_date"),
        last_error_message=result.get("last_error_message"),
        raw_subset=subset,
    )


def main() -> int:
    infos: list[WebhookInfo] = []
    for g in GROUPS:
        try:
            infos.append(check_group(g))
        except Exception as e:
            infos.append(WebhookInfo(group=g, ok=False, error=f"exception: {type(e).__name__}: {e}"))

    print(json.dumps([i.__dict__ for i in infos], indent=2, sort_keys=True))
    # non-zero if any failure
    return 0 if all(i.ok for i in infos) else 2


if __name__ == "__main__":
    raise SystemExit(main())
