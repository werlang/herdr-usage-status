#!/usr/bin/env python3
"""Print Claude subscription usage as one JSON object for the usage-status mod.

Reads the OAuth token Claude Code keeps in the login Keychain, asks Anthropic's
usage endpoint for the current limits, and prints only the windows the bar
needs. The token never leaves this process and is never written to stdout.

A successful result is cached on disk so the meter can keep showing the last
known numbers, clearly marked stale, while the endpoint is rate limited.
"""

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

KEYCHAIN_SERVICE = "Claude Code-credentials"
USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
CACHE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache-claude.json")
CACHE_MAX_AGE = 7 * 24 * 3600
WINDOWS = ("five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet")


def access_token():
    """Return Claude Code's OAuth token without exposing it to the caller."""
    result = subprocess.run(
        ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
        capture_output=True,
        text=True,
        timeout=10,
    )
    if result.returncode != 0:
        raise RuntimeError("Claude credentials not found in Keychain")
    credentials = json.loads(result.stdout)
    token = credentials.get("claudeAiOauth", {}).get("accessToken")
    if not token:
        raise RuntimeError("Claude Keychain item has no access token")
    return token


def fetch_usage(token):
    """Fetch the usage document for this token."""
    request = urllib.request.Request(
        USAGE_URL,
        headers={
            "Authorization": f"Bearer {token}",
            "anthropic-beta": "oauth-2025-04-20",
            "User-Agent": "claude-code/2.1.317",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


def summarize(body):
    """Keep only the utilization and reset time of each named window."""
    windows = {}
    for name in WINDOWS:
        window = body.get(name)
        if isinstance(window, dict):
            windows[name] = {
                "utilization": window.get("utilization"),
                "resets_at": window.get("resets_at"),
            }
    return windows


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
        summary = summarize(fetch_usage(access_token()))
        fetched_at = time.time()
        write_cache(summary, fetched_at)
        print(json.dumps({"ok": True, "fetched_at": fetched_at, **summary}))
    except urllib.error.HTTPError as error:
        retry_after = error.headers.get("Retry-After")
        warning = f"usage request failed ({error.code})"
        cached = cached_result(warning)
        if cached:
            print(json.dumps({**cached, "retry_after": retry_after}))
        else:
            print(json.dumps({"ok": False, "error": warning, "retry_after": retry_after}))
    except Exception as error:  # noqa: BLE001 - the mod shows any failure as offline
        warning = str(error)[:200]
        cached = cached_result(warning)
        print(json.dumps(cached if cached else {"ok": False, "error": warning}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
