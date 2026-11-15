from pathlib import Path
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
from types import SimpleNamespace

from fastapi.testclient import TestClient
from PIL import Image
from pillow_heif import from_pillow
import pymupdf
import pytest

from quicksortplayer import server
from quicksortplayer import file_ops
from quicksortplayer.server import app


client = TestClient(app)


def test_health():
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["ok"] is True


def test_lists_folder_with_categories(tmp_path: Path):
    (tmp_path / "Folder").mkdir()
    (tmp_path / "photo.jpg").write_bytes(b"not decoded in a list")
    (tmp_path / "clip.mp4").write_bytes(b"not decoded in a list")
    response = client.get("/api/list", params={"path": str(tmp_path)})
    assert response.status_code == 200
    items = {item["name"]: item for item in response.json()["items"]}
    assert items["Folder"]["is_dir"] is True
    assert items["photo.jpg"]["category"] == "images"
    assert items["clip.mp4"]["category"] == "videos"


def test_image_thumbnail(tmp_path: Path):
    image_path = tmp_path / "sample.png"
    Image.new("RGB", (800, 400), "#4cb3f0").save(image_path)
    response = client.get("/api/thumbnail", params={"path": str(image_path)})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/jpeg")


def test_static_app_loads():
    response = client.get("/")
    assert response.status_code == 200
    assert "Quick Sort" in response.text


def test_media_supports_seekable_byte_ranges(tmp_path: Path):
    video = tmp_path / "large.mp4"
    video.write_bytes(b"0123456789")
    response = client.get("/api/media", params={"path": str(video)}, headers={"Range": "bytes=2-5"})
    assert response.status_code == 206
    assert response.content == b"2345"
    assert response.headers["accept-ranges"] == "bytes"
    assert response.headers["content-range"] == "bytes 2-5/10"
    assert response.headers["content-length"] == "4"

    suffix = client.get("/api/media", params={"path": str(video)}, headers={"Range": "bytes=-3"})
    assert suffix.status_code == 206
    assert suffix.content == b"789"

    invalid = client.get("/api/media", params={"path": str(video)}, headers={"Range": "bytes=20-30"})
    assert invalid.status_code == 416


def test_cached_browser_proxy_is_seekable(tmp_path: Path, monkeypatch):
    video = tmp_path / "unsupported.mov"
    video.write_bytes(b"original-video")
    monkeypatch.setattr(server, "PROXY_DIR", tmp_path / "proxies")
    proxy = server.browser_proxy_path(video)
    proxy.parent.mkdir()
    proxy.write_bytes(b"browser-compatible-video")

    started = client.post("/api/browser-proxy/start", json={"path": str(video)})
    assert started.json() == {"status": "ready", "progress": 100, "error": None}
    response = client.get(
        "/api/browser-proxy/file", params={"path": str(video)}, headers={"Range": "bytes=8-17"},
    )
    assert response.status_code == 206
    assert response.content == b"compatible"
    assert response.headers["content-type"].startswith("video/mp4")


@pytest.mark.parametrize("probe", [
    "Stream #0:0: Video: h264 (High), yuv420p(progressive), 1920x1080",
    "Stream #0:0: Video: h264 (Main), yuv420p, 1280x720",
])
def test_browser_proxy_remuxes_compatible_h264(probe: str):
    assert server.h264_can_be_remuxed(probe)


@pytest.mark.parametrize("probe", [
    "Stream #0:0: Video: hevc (Main), yuv420p, 3840x2160",
    "Stream #0:0: Video: h264 (High 10), yuv420p10le, 1920x1080",
    "Stream #0:0: Video: h264 (High 4:2:2), yuv422p, 1920x1080",
])
def test_browser_proxy_transcodes_incompatible_video(probe: str):
    assert not server.h264_can_be_remuxed(probe)


def test_video_repair_explains_missing_moov_atom(tmp_path: Path, monkeypatch):
    video = tmp_path / "incomplete.mp4"
    video.write_bytes(b"\x00\x00\x00\x18ftypisomtruncated")
    monkeypatch.setattr(server, "run_media_command", lambda *_args, **_kwargs: SimpleNamespace(
        returncode=1, stderr="moov atom not found\nInvalid data found when processing input",
    ))
    response = client.post("/api/video-repair", json={"path": str(video)})
    assert response.status_code == 422
    assert "incomplete" in response.json()["detail"].lower()
    assert "cannot be reconstructed" in response.json()["detail"].lower()


def test_temporal_video_match_rejects_shared_intro():
    same_intro = "0000000000000000"
    left = {"duration": 60, "hashes": [same_intro, *["0000000000000000"] * 6]}
    different_after_intro = {"duration": 60, "hashes": [same_intro, *["ffffffffffffffff"] * 6]}
    close_copy = {"duration": 60.5, "hashes": ["0000000000000001"] * 7}
    assert server.temporal_video_fingerprints_match(left, different_after_intro) is False
    assert server.temporal_video_fingerprints_match(left, close_copy) is True


def test_duplicate_scan_skips_video_with_missing_ffmpeg_diagnostics(tmp_path: Path, monkeypatch):
    broken = tmp_path / "broken.mp4"
    broken.write_bytes(b"not a readable video")
    monkeypatch.setattr(server, "THUMB_DIR", tmp_path / "cache")
    monkeypatch.setattr(
        server,
        "run_media_command",
        lambda *_args, **_kwargs: SimpleNamespace(returncode=1, stdout=None, stderr=None),
    )

    result = server.find_duplicates(tmp_path)

    assert result["scanned"] == 1
    assert result["video_scanned"] == 1
    assert result["groups"] == []


def test_windows_reveal_selects_exact_file(tmp_path: Path, monkeypatch):
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"video")
    commands = []
    monkeypatch.setattr(server.sys, "platform", "win32")
    monkeypatch.setattr(server.subprocess, "Popen", lambda command: commands.append(command))
    response = client.post("/api/reveal", json={"path": str(video)})
    assert response.status_code == 200
    assert commands == [f'explorer.exe /select,"{video}"']


def test_review_state_round_trip(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(server, "REVIEW_FILE", tmp_path / "review.json")
    photo = tmp_path / "photo.jpg"
    photo.write_bytes(b"photo")
    response = client.put("/api/review", json={"path": str(photo), "status": "keep", "rating": 4, "tags": ["grad", "favorite"]})
    assert response.status_code == 200
    folder = client.get("/api/review", params={"folder": str(tmp_path)}).json()["records"]
    assert folder[str(photo)]["rating"] == 4
    assert folder[str(photo)]["status"] == "keep"


def test_duplicate_scan_and_metadata(tmp_path: Path):
    first = tmp_path / "one.png"
    second = tmp_path / "two.png"
    Image.new("RGB", (32, 24), "#4cb3f0").save(first)
    second.write_bytes(first.read_bytes())
    duplicates = client.get("/api/duplicates", params={"path": str(tmp_path)})
    assert duplicates.status_code == 200
    assert any({str(first), str(second)} == set(group) for group in duplicates.json()["exact"])
    group = duplicates.json()["groups"][0]
    assert group["kind"] == "exact"
    assert group["confidence"] == 100
    assert group["reclaimable"] == first.stat().st_size
    assert len(group["files"]) == 2
    metadata = client.get("/api/metadata", params={"path": str(first)}).json()
    assert metadata["width"] == 32
    assert metadata["height"] == 24


def test_duplicate_scan_runs_as_background_job(tmp_path: Path):
    server.duplicate_jobs.clear()
    first = tmp_path / "one.txt"
    second = tmp_path / "two.txt"
    first.write_text("same")
    second.write_text("same")
    started = client.post("/api/duplicates/start", json={"path": str(tmp_path)})
    assert started.status_code == 200
    assert started.json()["status"] in {"queued", "running"}
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        status = client.get("/api/duplicates/status", params={"path": str(tmp_path)}).json()
        if status["status"] == "complete":
            break
        time.sleep(.02)
    assert status["status"] == "complete"
    assert status["result"]["groups"][0]["kind"] == "exact"


def test_subfolders_are_listed_for_sidebar_tree(tmp_path: Path):
    child = tmp_path / "Child"
    grandchild = child / "Grandchild"
    grandchild.mkdir(parents=True)
    response = client.get("/api/subfolders", params={"path": str(tmp_path)})
    assert response.status_code == 200
    assert response.json()["folders"] == [{"name": "Child", "path": str(child), "has_children": True}]


def test_batch_rename_contract(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(server, "REVIEW_FILE", tmp_path / "review.json")
    source = tmp_path / "original.txt"
    source.write_text("hello")
    response = client.post("/api/rename", json={"paths": [str(source)], "pattern": "sorted_{index}_{name}"})
    assert response.status_code == 200
    assert (tmp_path / "sorted_001_original.txt").read_text() == "hello"


def test_move_and_undo_returns_restored_paths(tmp_path: Path):
    server.undo_stack.clear()
    source_folder = tmp_path / "source"
    destination = tmp_path / "destination"
    source_folder.mkdir()
    source = source_folder / "clip.mp4"
    source.write_bytes(b"video")
    moved = client.post("/api/move", json={"paths": [str(source)], "destination": str(destination)})
    assert moved.status_code == 200
    assert (destination / source.name).exists()
    undone = client.post("/api/undo", json={}).json()
    assert undone["paths"] == [str(source)]
    assert source.exists()


def test_move_reports_windows_disk_full_clearly(tmp_path: Path, monkeypatch):
    source = tmp_path / "large.mp4"
    source.write_bytes(b"video")
    destination = tmp_path / "destination"
    monkeypatch.setattr(server, "move_paths", lambda _paths, _destination: (_ for _ in ()).throw(OSError(28, "disk full")))
    monkeypatch.setattr(server, "required_copy_space", lambda _paths, _destination: 5 * 1024**3)
    monkeypatch.setattr(server.shutil, "disk_usage", lambda _path: shutil._ntuple_diskusage(10 * 1024**3, 9 * 1024**3, 1 * 1024**3))
    response = client.post("/api/move", json={"paths": [str(source)], "destination": str(destination)})
    assert response.status_code == 507
    assert "needs about 5.00 GB" in response.json()["detail"]
    assert "only 1.00 GB" in response.json()["detail"]


def test_move_retries_temporary_windows_file_lock(tmp_path: Path, monkeypatch):
    source = tmp_path / "clip.mp4"
    destination = tmp_path / "sorted.mp4"
    source.write_bytes(b"video")
    attempts = []
    real_move = shutil.move

    class LockedFileError(PermissionError):
        winerror = 32

    def temporarily_locked(raw_source, raw_destination):
        attempts.append(1)
        if len(attempts) < 3:
            raise LockedFileError(13, "file is being used")
        return real_move(raw_source, raw_destination)

    monkeypatch.setattr(file_ops.shutil, "move", temporarily_locked)
    monkeypatch.setattr(file_ops.time, "sleep", lambda _seconds: None)
    moved = file_ops.move_with_lock_retry(source, destination)
    assert moved == destination
    assert destination.read_bytes() == b"video"
    assert len(attempts) == 3


def test_move_releases_active_media_streams(tmp_path: Path):
    source = tmp_path / "clip.mp4"
    source.write_bytes(b"video")
    destination = tmp_path / "sorted"
    stream = server.open_media_stream(source)
    try:
        moved = client.post("/api/move", json={"paths": [str(source)], "destination": str(destination)})
        assert moved.status_code == 200
        assert stream.closed
        assert (destination / source.name).read_bytes() == b"video"
    finally:
        if not stream.closed:
            stream.close()


def test_slow_move_does_not_block_other_media_requests(tmp_path: Path, monkeypatch):
    moving = tmp_path / "moving.mp4"
    moving.write_bytes(b"move me")
    playing = tmp_path / "playing.mp4"
    playing.write_bytes(b"play me while another file moves")
    destination = tmp_path / "sorted"
    move_started = threading.Event()
    finish_move = threading.Event()

    def slow_move(_paths, _destination):
        move_started.set()
        assert finish_move.wait(timeout=3)
        return []

    monkeypatch.setattr(server, "move_paths", slow_move)
    response_holder = []
    worker = threading.Thread(
        target=lambda: response_holder.append(client.post(
            "/api/move", json={"paths": [str(moving)], "destination": str(destination)},
        )),
    )
    worker.start()
    try:
        assert move_started.wait(timeout=2)
        media = client.get("/api/media", params={"path": str(playing)}, headers={"Range": "bytes=0-6"})
        assert media.status_code == 206
        assert media.content == b"play me"
    finally:
        finish_move.set()
        worker.join(timeout=3)
    assert response_holder[0].status_code == 200


def test_trash_releases_active_media_streams(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(server, "REVIEW_FILE", tmp_path / "review.json")
    source = tmp_path / "clip.mp4"
    source.write_bytes(b"video")
    stream = server.open_media_stream(source)
    monkeypatch.setattr(server, "trash_with_lock_retry", lambda path: path.unlink())
    try:
        trashed = client.post("/api/trash", json={"paths": [str(source)]})
        assert trashed.status_code == 200
        assert trashed.json()["trashed"] == 1
        assert stream.closed
        assert not source.exists()
    finally:
        if not stream.closed:
            stream.close()


def test_cancel_media_work_stops_tracked_processes(tmp_path: Path):
    source = tmp_path / "clip.mp4"
    source.write_bytes(b"video")
    process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    server.track_media_process(source, process)
    try:
        assert server.cancel_media_work([source]) == 1
        assert process.poll() is not None
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()


def test_run_media_command_allows_probe_style_nonzero_exit(tmp_path: Path):
    source = tmp_path / "clip.mp4"
    source.write_bytes(b"video")
    result = server.run_media_command(
        [sys.executable, "-c", "import sys; print('probe output', file=sys.stderr); sys.exit(1)"],
        source,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 1
    assert "probe output" in result.stderr


def test_run_media_command_check_raises_for_failed_conversion(tmp_path: Path):
    source = tmp_path / "clip.mp4"
    source.write_bytes(b"video")
    with pytest.raises(subprocess.CalledProcessError):
        server.run_media_command(
            [sys.executable, "-c", "import sys; sys.exit(1)"],
            source,
            check=True,
        )


def test_trash_retries_temporary_windows_file_lock(tmp_path: Path, monkeypatch):
    source = tmp_path / "clip.mp4"
    source.write_bytes(b"video")
    attempts = []

    class LockedFileError(PermissionError):
        winerror = 32

    def temporarily_locked(_path):
        attempts.append(1)
        if len(attempts) < 3:
            raise LockedFileError(13, "file is being used by Python")

    monkeypatch.setattr(file_ops, "send2trash", temporarily_locked)
    monkeypatch.setattr(file_ops.time, "sleep", lambda _seconds: None)
    response = client.post("/api/trash", json={"paths": [str(source)]})
    assert response.status_code == 200
    assert response.json()["trashed"] == 1
    assert len(attempts) == 3


def test_custom_shortcuts_are_persisted(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(server, "CONFIG_FILE", tmp_path / "config.json")
    response = client.put("/api/config", json={
        "destinations": {"photos": str(tmp_path / "Photos")},
        "labels": {"photos": "Best photos"},
        "keybindings": {"keep": "Q", "move:photos": "7"},
    })
    assert response.status_code == 200
    assert response.json()["keybindings"]["keep"] == "Q"
    assert server.load_config()["labels"]["photos"] == "Best photos"


def test_saved_locations_are_persisted_and_listed(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(server, "CONFIG_FILE", tmp_path / "config.json")
    saved = tmp_path / "External media"
    saved.mkdir()
    response = client.put("/api/config", json={
        "destinations": {}, "saved_locations": [{"name": "Camera drive", "path": str(saved)}],
    })
    assert response.status_code == 200
    locations = client.get("/api/locations").json()["locations"]
    assert any(location["name"] == "Camera drive" and location["path"] == str(saved) for location in locations)


def test_windows_drive_roots_are_listed(monkeypatch):
    monkeypatch.setattr(server.sys, "platform", "win32")
    monkeypatch.setattr(server, "windows_drives", lambda: [Path("C:\\"), Path("D:\\")])
    locations = server.common_locations({"saved_locations": []})
    drive_paths = {str(location["path"]) for location in locations if location["source"] == "drive"}
    assert drive_paths == {"C:\\", "D:\\"}


@pytest.mark.skipif(sys.platform != "win32", reason="Windows runner check")
def test_real_windows_system_drive_is_exposed():
    locations = client.get("/api/locations").json()["locations"]
    assert any(location["source"] == "drive" and str(location["path"]).upper().startswith("C:") for location in locations)


@pytest.mark.skipif(sys.platform != "win32", reason="Windows runner check")
def test_real_cross_drive_move_when_two_writable_drives_exist(tmp_path: Path):
    other_drives = [drive for drive in server.windows_drives() if drive.drive.casefold() != tmp_path.drive.casefold()]
    destination_root = next((drive for drive in other_drives if drive.exists() and os.access(drive, os.W_OK)), None)
    if destination_root is None:
        pytest.skip("The Windows runner exposes only one writable drive")
    source = tmp_path / "cross-drive-test.txt"
    source.write_text("cross-drive")
    with tempfile.TemporaryDirectory(dir=destination_root) as temporary:
        records = server.move_paths([source], Path(temporary))
        assert len(records) == 1
        assert records[0].destination.read_text() == "cross-drive"


def test_heic_thumbnail_and_browser_render(tmp_path: Path):
    path = tmp_path / "photo.heic"
    from_pillow(Image.new("RGB", (120, 80), "#4cb3f0")).save(path)
    thumbnail = client.get("/api/thumbnail", params={"path": str(path)})
    rendered = client.get("/api/rendered-image", params={"path": str(path)})
    assert thumbnail.status_code == 200
    assert rendered.status_code == 200
    assert rendered.headers["content-type"].startswith("image/jpeg")


def test_pdf_text_and_archive_previews(tmp_path: Path):
    pdf = tmp_path / "document.pdf"
    document = pymupdf.open()
    page = document.new_page()
    page.insert_text((72, 72), "Quick Sort PDF")
    document.save(pdf)
    document.close()
    assert client.get("/api/thumbnail", params={"path": str(pdf)}).status_code == 200

    text = tmp_path / "notes.md"
    text.write_text("# Notes\nHello files")
    assert "Hello files" in client.get("/api/text-preview", params={"path": str(text)}).json()["content"]

    archive = tmp_path / "bundle.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr("inside/readme.txt", "hello")
    entries = client.get("/api/archive-preview", params={"path": str(archive)}).json()["entries"]
    assert "inside/readme.txt" in entries


def test_cached_audio_analysis_endpoint(tmp_path: Path, monkeypatch):
    media = tmp_path / "clip.mp4"
    media.write_bytes(b"media")
    monkeypatch.setattr(server, "THUMB_DIR", tmp_path / "cache")
    monkeypatch.setattr(server, "analyze_audio", lambda _path: {
        "duration": 12.5, "waveform": [0.1, 0.8, 0.2], "silence": [[2.0, 3.0]],
    })
    response = client.get("/api/audio-analysis", params={"path": str(media)})
    assert response.status_code == 200
    assert response.json()["silence"] == [[2.0, 3.0]]
    assert len(list((tmp_path / "cache").glob("*.json"))) == 1


def test_cached_video_sprite_endpoint(tmp_path: Path, monkeypatch):
    media = tmp_path / "clip.mp4"
    media.write_bytes(b"media")
    monkeypatch.setattr(server, "THUMB_DIR", tmp_path / "cache")
    monkeypatch.setattr(server, "create_video_sprite", lambda _path, destination, _count: (
        destination.parent.mkdir(parents=True, exist_ok=True), destination.write_bytes(b"jpeg")
    ))
    response = client.get("/api/video-sprite", params={"path": str(media), "count": 40})
    assert response.status_code == 200
    assert response.headers["x-sprite-columns"] == "10"
    assert response.headers["x-sprite-count"] == "40"


def test_video_sprite_generates_from_real_ffmpeg_probe(tmp_path: Path, monkeypatch):
    """The sprite endpoint probes duration with FFmpeg, which exits 1 for probes only."""
    monkeypatch.setattr(server, "THUMB_DIR", tmp_path / "cache")
    media = tmp_path / "tiny.mp4"
    subprocess.run(
        [
            server.get_ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=1",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(media),
        ],
        check=True, capture_output=True, timeout=120,
    )
    response = client.get("/api/video-sprite", params={"path": str(media), "count": 10})
    assert response.status_code == 200
    assert response.content[:2] == b"\xff\xd8"
