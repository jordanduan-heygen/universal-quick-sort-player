from __future__ import annotations

import argparse
import json
import os
import socket
import threading
import time
import sys
import urllib.request
import webbrowser
from pathlib import Path

import uvicorn

from . import __version__


def _open_when_ready(url: str) -> None:
    time.sleep(1.2)
    webbrowser.open(url)


def _quick_sort_is_running(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=.5) as response:
            return response.status == 200 and json.loads(response.read())["ok"] is True
    except Exception:
        return False


def _running_version(port: int) -> str | None:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=.5) as response:
            return str(json.loads(response.read()).get("app_version") or "") or None
    except Exception:
        return None


def _port_is_available(port: int) -> bool:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False


def _available_port(preferred: int) -> int:
    if _port_is_available(preferred):
        return preferred
    return next((port for port in range(preferred + 1, preferred + 21) if _port_is_available(port)), preferred)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run Quick Sort Player locally with live reload")
    parser.add_argument("--port", type=int, default=int(os.environ.get("QUICK_SORT_PORT", "8767")))
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--no-reload", action="store_true")
    args = parser.parse_args()

    frozen = bool(getattr(sys, "frozen", False))
    already_running = _quick_sort_is_running(args.port)
    same_build = not frozen or not already_running or _running_version(args.port) == __version__
    if already_running and same_build:
        url = f"http://127.0.0.1:{args.port}"
        print(f"Quick Sort Player is already running: {url}")
        if not args.no_browser:
            webbrowser.open(url)
        return 0

    # A different packaged build may still own the default port. Start this build on the
    # next port rather than silently reopening stale code.
    port = _available_port(args.port)
    url = f"http://127.0.0.1:{port}"
    if not args.no_browser:
        threading.Thread(target=_open_when_ready, args=(url,), daemon=True).start()
    print(f"Quick Sort Player: {url}")
    print("Local-only server. Press Ctrl+C to stop.")

    source_dir = Path(__file__).resolve().parents[1]
    app_target = "quicksortplayer.server:app"
    if frozen:
        from .server import app
        app_target = app
    reload_enabled = not args.no_reload and not frozen
    reload_options = {}
    if reload_enabled:
        reload_options = {
            "reload_dirs": [str(source_dir)],
            "reload_includes": ["*.py", "*.html", "*.css", "*.js"],
        }
    uvicorn.run(
        app_target,
        host="127.0.0.1",
        port=port,
        reload=reload_enabled,
        log_level="warning",
        **reload_options,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
