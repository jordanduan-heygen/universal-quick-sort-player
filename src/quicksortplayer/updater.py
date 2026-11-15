from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path


RELEASE_API = "https://api.github.com/repos/jordanduan-heygen/universal-quick-sort-player/releases/latest"
CHECK_INTERVAL = 6 * 60 * 60
STATE_DIR = Path(os.environ.get("QUICK_SORT_STATE_DIR", Path.home() / ".quick-sort-player"))
UPDATE_DIR = STATE_DIR / "updates"
CHECK_FILE = UPDATE_DIR / "last-check.json"


def version_tuple(value: str) -> tuple[int, ...]:
    numbers = re.findall(r"\d+", value)
    return tuple(int(number) for number in numbers[:3]) or (0,)


def request(url: str, timeout: int = 30):
    return urllib.request.urlopen(urllib.request.Request(
        url,
        headers={"Accept": "application/vnd.github+json", "User-Agent": "Quick-Sort-Player-Updater"},
    ), timeout=timeout)


def download(url: str, destination: Path) -> None:
    temporary = destination.with_suffix(destination.suffix + ".part")
    try:
        with request(url, 60) as response, temporary.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def cached_current(current_version: str) -> bool:
    try:
        cached = json.loads(CHECK_FILE.read_text(encoding="utf-8"))
        fresh = time.time() - float(cached["checked_at"]) < CHECK_INTERVAL
        return fresh and version_tuple(str(cached["latest_version"])) <= version_tuple(current_version)
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return False


def maybe_install_update(current_version: str, forwarded_args: list[str] | None = None) -> bool:
    if sys.platform != "win32" or not getattr(sys, "frozen", False) or cached_current(current_version):
        return False
    try:
        with request(RELEASE_API) as response:
            release = json.loads(response.read())
        latest = str(release.get("tag_name") or "").lstrip("v")
        assets = {asset.get("name"): asset.get("browser_download_url") for asset in release.get("assets", [])}
        UPDATE_DIR.mkdir(parents=True, exist_ok=True)
        CHECK_FILE.write_text(json.dumps({"checked_at": time.time(), "latest_version": latest}), encoding="utf-8")
        if not latest or version_tuple(latest) <= version_tuple(current_version):
            return False
        exe_url = assets.get("Quick.Sort.Player.exe")
        checksum_url = assets.get("Quick.Sort.Player.exe.sha256")
        if not exe_url or not checksum_url:
            return False
        with request(checksum_url) as response:
            expected = response.read().decode("utf-8", errors="replace").split()[0].lower()
        destination = UPDATE_DIR / f"Quick Sort Player v{latest}.exe"
        if not destination.exists() or sha256(destination) != expected:
            print(f"Downloading Quick Sort Player v{latest} update…")
            download(exe_url, destination)
        if sha256(destination) != expected:
            destination.unlink(missing_ok=True)
            print("Update checksum did not match; continuing with the current version.")
            return False
        arguments = [str(destination), *(forwarded_args or [])]
        creation_flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        subprocess.Popen(arguments, creationflags=creation_flags)
        print(f"Launching Quick Sort Player v{latest}…")
        return True
    except Exception as error:
        print(f"Update check skipped: {error}")
        return False
