import hashlib
import io
import json
from pathlib import Path

from quicksortplayer import updater


def test_version_tuple_orders_releases():
    assert updater.version_tuple("v0.2.10") > updater.version_tuple("0.2.9")


def test_frozen_windows_update_is_verified_and_launched(tmp_path: Path, monkeypatch):
    payload = b"verified executable"
    expected = hashlib.sha256(payload).hexdigest()
    release = {
        "tag_name": "v0.2.9",
        "assets": [
            {"name": "Quick.Sort.Player.exe", "browser_download_url": "exe-url"},
            {"name": "Quick.Sort.Player.exe.sha256", "browser_download_url": "checksum-url"},
        ],
    }
    launched = []

    def fake_request(url, timeout=30):
        del timeout
        return io.BytesIO(json.dumps(release).encode() if url == updater.RELEASE_API else f"{expected}  Quick.Sort.Player.exe\n".encode())

    monkeypatch.setattr(updater, "UPDATE_DIR", tmp_path / "updates")
    monkeypatch.setattr(updater, "CHECK_FILE", tmp_path / "updates" / "last-check.json")
    monkeypatch.setattr(updater.sys, "platform", "win32")
    monkeypatch.setattr(updater.sys, "frozen", True, raising=False)
    monkeypatch.setattr(updater, "request", fake_request)
    monkeypatch.setattr(updater, "download", lambda _url, destination: destination.write_bytes(payload))
    monkeypatch.setattr(updater.subprocess, "Popen", lambda arguments, creationflags=0: launched.append((arguments, creationflags)))

    assert updater.maybe_install_update("0.2.8", ["--no-browser"]) is True
    assert launched[0][0][0].endswith("Quick Sort Player v0.2.9.exe")
    assert launched[0][0][1:] == ["--no-browser"]
