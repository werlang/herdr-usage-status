#!/usr/bin/env python3
"""Redeem one banked Codex rate-limit reset for the usage-status mod.

Usage: ``codex-reset.py <credit-id>``

It does not call the backend itself. It starts ``codex app-server`` over stdio
and sends the same ``account/rateLimitResetCredit/consume`` request the Codex
TUI uses, so the Codex CLI keeps ownership of auth (including token refresh)
and of the request format. Prints one JSON object:
``{"ok": true, "outcome": "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed"}``
or ``{"ok": false, "error": "..."}``.
"""

import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
import uuid

TIMEOUT = 45
CANDIDATES = (
    os.path.expanduser("~/.local/bin/codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
)


def codex_binary():
    """Find the Codex CLI even when Herdr runs helpers with a minimal PATH."""
    found = shutil.which("codex")
    if found:
        return found
    for path in CANDIDATES:
        if os.access(path, os.X_OK):
            return path
    raise RuntimeError("Codex CLI not found")


class AppServer:
    """A minimal JSON-RPC client for ``codex app-server`` over stdio."""

    def __init__(self):
        self.process = subprocess.Popen(
            [codex_binary(), "app-server"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        self.lines = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()
        self.deadline = time.time() + TIMEOUT

    def _read(self):
        for line in self.process.stdout:
            self.lines.put(line)
        self.lines.put(None)

    def send(self, message):
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()

    def call(self, request_id, method, params):
        """Send a request and wait for its response, skipping notifications."""
        self.send({"id": request_id, "method": method, "params": params})
        while True:
            left = self.deadline - time.time()
            if left <= 0:
                raise RuntimeError("Codex app-server timed out")
            try:
                line = self.lines.get(timeout=left)
            except queue.Empty:
                raise RuntimeError("Codex app-server timed out") from None
            if line is None:
                raise RuntimeError("Codex app-server exited")
            try:
                message = json.loads(line)
            except ValueError:
                continue
            if message.get("id") != request_id:
                continue
            if "error" in message:
                error = message["error"] or {}
                raise RuntimeError(str(error.get("message") or error)[:200])
            return message.get("result") or {}

    def close(self):
        try:
            self.process.stdin.close()
            self.process.terminate()
            self.process.wait(timeout=5)
        except Exception:  # noqa: BLE001 - best effort shutdown
            self.process.kill()


def main():
    if len(sys.argv) != 2 or not sys.argv[1].strip():
        print(json.dumps({"ok": False, "error": "usage: codex-reset.py <credit-id>"}))
        return 0
    server = None
    try:
        server = AppServer()
        server.call(1, "initialize", {"clientInfo": {"name": "herdr-usage-status", "version": "0.2.0"}})
        server.send({"method": "initialized"})
        result = server.call(
            2,
            "account/rateLimitResetCredit/consume",
            {"creditId": sys.argv[1].strip(), "idempotencyKey": str(uuid.uuid4())},
        )
        print(json.dumps({"ok": True, "outcome": result.get("outcome")}))
    except Exception as error:  # noqa: BLE001 - the mod shows any failure in the popover
        print(json.dumps({"ok": False, "error": str(error)[:200]}))
    finally:
        if server:
            server.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
