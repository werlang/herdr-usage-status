#!/usr/bin/env python3
"""Print Antigravity subscription usage as one JSON object for the usage-status mod.

Antigravity's read-only ``/usage`` print mode emits one tab-separated record
per quota line (group, label, percent remaining, reset time). It does not ask
the model for anything. The helper keeps the last good result so the meter can
show it, labelled stale, while the CLI or the network is unavailable.
"""

import json
import os
import subprocess
import sys
import time

CACHE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache-antigravity.json")
CACHE_MAX_AGE = 7 * 24 * 3600
PRIMARY = "gemini models"


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


def read_usage():
    """Run the read-only slash command and parse its tab-separated records."""
    result = subprocess.run(
        ["agy", "-p", "/usage"],
        capture_output=True,
        text=True,
        timeout=25,
        cwd=os.path.expanduser("~"),
    )
    if result.returncode != 0:
        message = result.stderr.strip().splitlines()[-1] if result.stderr.strip() else f"agy exited {result.returncode}"
        raise RuntimeError(message[:200])

    buckets = {}
    for line in result.stdout.splitlines():
        fields = [field.strip() for field in line.split("\t")]
        if len(fields) < 3:
            continue
        group, label, value = fields[0], fields[1], fields[2]
        reset = fields[3] if len(fields) > 3 else None
        if not value.endswith("%"):
            continue
        try:
            remaining = float(value.rstrip("%"))
        except ValueError:
            continue
        window = None
        lowered = label.lower()
        if "five hour" in lowered or "5 hour" in lowered or "5-hour" in lowered:
            window = "five_hour"
        elif "weekly" in lowered or "week" in lowered:
            window = "seven_day"
        if window is None:
            continue
        bucket = buckets.setdefault(group, {})
        bucket[window] = {
            "utilization": round(100 - remaining, 1),
            "remaining": remaining,
            "resets_at": reset or None,
        }

    if not buckets:
        raise RuntimeError("Antigravity returned no quota windows")
    return buckets


def choose(buckets):
    """Prefer the Gemini Models bucket; otherwise use the first one."""
    for name, windows in buckets.items():
        if name.strip().lower() == PRIMARY:
            return name, windows
    name = next(iter(buckets))
    return name, buckets[name]


def main():
    try:
        buckets = read_usage()
        name, windows = choose(buckets)
        summary = {
            "bucket": name,
            "five_hour": windows.get("five_hour"),
            "seven_day": windows.get("seven_day"),
            "buckets": [
                {"name": group, **value}
                for group, value in buckets.items()
                if group != name
            ],
        }
        fetched_at = time.time()
        write_cache(summary, fetched_at)
        print(json.dumps({"ok": True, "fetched_at": fetched_at, **summary}))
    except subprocess.TimeoutExpired:
        warning = "Antigravity usage timed out"
        cached = cached_result(warning)
        print(json.dumps(cached if cached else {"ok": False, "error": warning}))
    except Exception as error:  # noqa: BLE001 - the mod hides or shows the cached meter
        message = str(error)[:200]
        cached = cached_result(message)
        print(json.dumps(cached if cached else {"ok": False, "error": message}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
