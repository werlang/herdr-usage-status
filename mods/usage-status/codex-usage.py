#!/usr/bin/env python3
"""Print Codex subscription usage as one JSON object for the usage-status mod.

Reads the ChatGPT OAuth credentials the Codex CLI keeps in
``$CODEX_HOME/auth.json`` (or ``~/.codex/auth.json``) and asks the same
``wham/usage`` endpoint the CLI polls. It never refreshes the token: the
Codex CLI owns that rotation, and a meter should not race it. When the
token is expired the mod simply keeps its last values (or hides Codex).
"""

import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
CACHE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache-codex.json")
CACHE_MAX_AGE = 7 * 24 * 3600


def auth_path():
    root = os.environ.get("CODEX_HOME") or os.path.join(os.path.expanduser("~"), ".codex")
    return os.path.join(root, "auth.json")


def jwt_claims(token):
    """Decode a token payload without verifying it."""
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload))
    except Exception:
        return {}


def jwt_account_id(token):
    """Read the ChatGPT account id from the token when auth.json omits it."""
    return jwt_claims(token).get("https://api.openai.com/auth", {}).get("chatgpt_account_id")


def jwt_expired(token):
    """Whether the access token's own exp claim has passed."""
    exp = jwt_claims(token).get("exp")
    return isinstance(exp, (int, float)) and exp <= time.time()


def credentials():
    """Return (access token, account id), or None when Codex is not signed in."""
    path = auth_path()
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    if str(data.get("auth_mode", "")).lower() not in ("", "chatgpt"):
        return None
    tokens = data.get("tokens") or {}
    token = tokens.get("access_token")
    if not token:
        return None
    return token, tokens.get("account_id") or jwt_account_id(token)


def reset_iso(value):
    """Normalize a reset timestamp to ISO-8601."""
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float)):
        seconds = value / 1000 if value > 1e12 else value
        return datetime.fromtimestamp(seconds, timezone.utc).isoformat()
    return None


def window(value):
    """Normalize one rate-limit window."""
    if not isinstance(value, dict):
        return None
    used = value.get("used_percent")
    if used is None:
        left = value.get("percent_left")
        if left is not None:
            used = 100 - float(left)
    if used is None:
        return None
    reset = value.get("reset_at")
    if reset is None:
        reset = value.get("resets_at")
    if reset is None:
        reset = value.get("reset_time_ms")
    if reset is None:
        after = value.get("reset_after_seconds")
        if after is not None:
            reset = time.time() + float(after)
    return {"utilization": round(float(used), 1), "resets_at": reset_iso(reset)}


def bucket(rate):
    """Map primary/secondary or five_hour/weekly fields onto the two Codex windows."""
    result = {"five_hour": None, "seven_day": None}
    fields = (
        ("primary_window", "five_hour"),
        ("secondary_window", "seven_day"),
        ("five_hour", "five_hour"),
        ("weekly", "seven_day"),
        ("primary", "five_hour"),
        ("secondary", "seven_day"),
    )
    for key, fallback in fields:
        raw = rate.get(key)
        parsed = window(raw)
        if not parsed:
            continue
        kind = fallback
        seconds = raw.get("limit_window_seconds") if isinstance(raw, dict) else None
        if isinstance(seconds, (int, float)):
            if seconds <= 6 * 3600:
                kind = "five_hour"
            elif seconds >= 6 * 86400:
                kind = "seven_day"
        result[kind] = parsed
    return result


def read_cache():
    """Return the last successful summary, if it is recent enough."""
    try:
        with open(CACHE_PATH, encoding="utf-8") as handle:
            cached = json.load(handle)
        if time.time() - float(cached.get("fetched_at", 0)) <= CACHE_MAX_AGE:
            return cached
    except Exception:
        pass
    return None


def write_cache(summary, fetched_at):
    """Persist the last successful summary without making the meter fail."""
    try:
        with open(CACHE_PATH, "w", encoding="utf-8") as handle:
            json.dump({"fetched_at": fetched_at, **summary}, handle)
    except Exception:
        pass


def cached_result(warning):
    """Show the last known numbers, labelled with the warning that caused them."""
    cached = read_cache()
    if not cached:
        return None
    return {"ok": True, "cached": True, "warning": warning, **cached}


def main():
    try:
        found = credentials()
        if not found:
            print(json.dumps({"ok": False, "missing": True, "error": "Codex is not signed in"}))
            return 0
        token, account = found
        if jwt_expired(token):
            message = "Codex token expired"
            cached = cached_result(message)
            print(json.dumps(cached if cached else {"ok": False, "missing": True, "error": message}))
            return 0
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "User-Agent": "codex-cli/0.98.0",
        }
        if account:
            headers["ChatGPT-Account-Id"] = account
        request = urllib.request.Request(USAGE_URL, headers=headers)
        with urllib.request.urlopen(request, timeout=15) as response:
            body = json.loads(response.read().decode("utf-8"))
        rate = body.get("rate_limit") or body.get("rate_limits") or {}
        if not isinstance(rate, dict):
            rate = {}
        summary = {"plan": body.get("plan_type"), **bucket(rate)}
        fetched_at = time.time()
        write_cache(summary, fetched_at)
        print(json.dumps({"ok": True, "fetched_at": fetched_at, **summary}))
    except urllib.error.HTTPError as error:
        message = "Codex token expired" if error.code == 401 else f"Codex usage request failed ({error.code})"
        cached = cached_result(message)
        print(json.dumps(cached if cached else {"ok": False, "error": message}))
    except Exception as error:  # noqa: BLE001 - the mod hides or shows the cached meter
        message = str(error)[:200]
        cached = cached_result(message)
        print(json.dumps(cached if cached else {"ok": False, "error": message}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
