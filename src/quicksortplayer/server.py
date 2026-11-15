from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import tarfile
import zipfile
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from imageio_ffmpeg import get_ffmpeg_exe
from PIL import Image, ImageOps
from pillow_heif import register_heif_opener
import pymupdf
from pydantic import BaseModel
from send2trash import send2trash
from starlette.concurrency import run_in_threadpool

from .file_ops import AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, MoveRecord, category_for, move_paths, undo_moves


APP_STARTED = str(time.time_ns())
PACKAGE_DIR = Path(__file__).resolve().parent
STATIC_DIR = PACKAGE_DIR / "static"
STATE_DIR = Path(os.environ.get("QUICK_SORT_STATE_DIR", Path.home() / ".quick-sort-player"))
THUMB_DIR = STATE_DIR / "thumbnails"
CONFIG_FILE = STATE_DIR / "config.json"
REVIEW_FILE = STATE_DIR / "review.json"
MAX_THUMB_EDGE = 320
TEXT_EXTENSIONS = {
    ".bat", ".c", ".cc", ".cfg", ".conf", ".cpp", ".cs", ".css", ".csv", ".env", ".go", ".h", ".hpp",
    ".html", ".ini", ".java", ".js", ".json", ".jsx", ".log", ".lua", ".md", ".mjs", ".php", ".plist",
    ".ps1", ".py", ".rb", ".rs", ".sh", ".sql", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
}
ARCHIVE_EXTENSIONS = {".7z", ".bz2", ".gz", ".rar", ".tar", ".tgz", ".xz", ".zip"}
BROWSER_IMAGE_EXTENSIONS = {".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"}

register_heif_opener()

app = FastAPI(title="Quick Sort Player", docs_url=None, redoc_url=None)
undo_stack: list[list[MoveRecord]] = []
index_jobs: dict[str, dict[str, object]] = {}


@app.middleware("http")
async def disable_browser_cache(request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    return response


class MoveRequest(BaseModel):
    paths: list[str]
    destination: str


class PathsRequest(BaseModel):
    paths: list[str]


class RevealRequest(BaseModel):
    path: str


class ConfigRequest(BaseModel):
    destinations: dict[str, str]
    labels: dict[str, str] | None = None
    keybindings: dict[str, str] | None = None


class ReviewRequest(BaseModel):
    path: str
    status: Literal["unreviewed", "keep", "reject"] | None = None
    rating: int | None = None
    tags: list[str] | None = None


class RenameRequest(BaseModel):
    paths: list[str]
    pattern: str


def default_destinations() -> dict[str, str]:
    home = Path.home()
    return {
        "apps": str(home / "Sorted" / "Apps"),
        "videos": str(home / "Videos" / "Sorted"),
        "images": str(home / "Pictures" / "Sorted"),
        "files": str(home / "Documents" / "Sorted"),
    }


def default_labels() -> dict[str, str]:
    return {"apps": "Apps", "videos": "Media", "images": "Images", "files": "Files"}


def default_keybindings() -> dict[str, str]:
    return {
        "previous": "ArrowUp", "next": "ArrowDown", "open_folder": "Enter", "filter": "/",
        "palette": "Ctrl+K", "play": "Space", "zoom_in": "+", "zoom_out": "-", "fit": "0",
        "mute": "M", "fullscreen": "F", "speed_down": "[", "speed_up": "]",
        "jump_back": "J", "jump_forward": "L", "jump_back_30": "Shift+J", "jump_forward_30": "Shift+L",
        "keep": "K", "reject": "X", "trash": "Delete", "undo": "Ctrl+Z",
    }


def load_config() -> dict[str, object]:
    base: dict[str, object] = {
        "destinations": default_destinations(),
        "labels": default_labels(),
        "keybindings": default_keybindings(),
        "show_hidden": False,
    }
    try:
        stored = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        if isinstance(stored, dict):
            base.update(stored)
    except (OSError, json.JSONDecodeError):
        pass
    return base


def save_config(config: dict[str, object]) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    temporary = CONFIG_FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    temporary.replace(CONFIG_FILE)


def load_review() -> dict[str, dict[str, object]]:
    try:
        stored = json.loads(REVIEW_FILE.read_text(encoding="utf-8"))
        return stored if isinstance(stored, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_review(records: dict[str, dict[str, object]]) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    temporary = REVIEW_FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps(records, indent=2) + "\n", encoding="utf-8")
    temporary.replace(REVIEW_FILE)


def checked_path(raw: str, *, require_file: bool = False, require_dir: bool = False) -> Path:
    path = Path(raw).expanduser().resolve()
    if not path.exists():
        raise HTTPException(404, f"Path does not exist: {path}")
    if require_file and not path.is_file():
        raise HTTPException(400, "A file path is required")
    if require_dir and not path.is_dir():
        raise HTTPException(400, "A folder path is required")
    return path


def human_kind(path: Path) -> str:
    if path.is_dir():
        return "Folder"
    suffix = path.suffix.lower().removeprefix(".")
    labels = {
        "jpg": "JPEG image", "jpeg": "JPEG image", "png": "PNG image", "gif": "GIF image",
        "webp": "WebP image", "heic": "HEIC image", "heif": "HEIF image", "mp4": "MP4 video", "mov": "QuickTime video",
        "mkv": "Matroska video", "webm": "WebM video", "mp3": "MP3 audio", "wav": "WAV audio",
        "pdf": "PDF document", "csv": "CSV table", "json": "JSON document", "md": "Markdown document",
        "zip": "ZIP archive", "exe": "Windows application", "msi": "Windows installer",
    }
    return labels.get(suffix, f"{suffix.upper()} file" if suffix else "File")


def item_payload(path: Path) -> dict[str, object]:
    stat = path.stat()
    category = "folder" if path.is_dir() else category_for(path)
    suffix = path.suffix.lower()
    if suffix == ".ts" and path.is_file():
        try:
            sample = path.read_bytes()[:4096]
            looks_like_text = b"\x00" not in sample and sum(byte in b"\t\n\r" or 32 <= byte < 127 for byte in sample) >= len(sample) * .9
            if looks_like_text:
                category = "files"
        except OSError:
            looks_like_text = False
    else:
        looks_like_text = False
    if suffix == ".ts" and looks_like_text:
        preview_type = "text"
    elif suffix in IMAGE_EXTENSIONS:
        preview_type = "image"
    elif suffix in VIDEO_EXTENSIONS:
        preview_type = "video"
    elif suffix in AUDIO_EXTENSIONS:
        preview_type = "audio"
    elif suffix == ".pdf":
        preview_type = "pdf"
    elif suffix in TEXT_EXTENSIONS or (mimetypes.guess_type(path.name)[0] or "").startswith("text/"):
        preview_type = "text"
    elif suffix in ARCHIVE_EXTENSIONS:
        preview_type = "archive"
    else:
        preview_type = "file"
    previewable = preview_type != "file"
    return {
        "name": path.name,
        "path": str(path),
        "is_dir": path.is_dir(),
        "category": category,
        "kind": human_kind(path),
        "extension": suffix,
        "size": 0 if path.is_dir() else stat.st_size,
        "modified": stat.st_mtime,
        "previewable": previewable,
        "preview_type": preview_type,
        "browser_native": suffix in BROWSER_IMAGE_EXTENSIONS,
        "thumbnail": preview_type in {"image", "video", "audio", "pdf"},
    }


def common_locations() -> list[dict[str, str]]:
    home = Path.home()
    candidates = [
        ("Home", home, "H"),
        ("Desktop", home / "Desktop", "B"),
        ("Downloads", home / "Downloads", "D"),
        ("Pictures", home / "Pictures", "P"),
        ("Videos", home / "Videos", "V"),
        ("Documents", home / "Documents", "O"),
    ]
    if sys.platform == "darwin":
        candidates.append(("Applications", Path("/Applications"), "A"))
    elif sys.platform == "win32":
        program_files = os.environ.get("ProgramFiles")
        if program_files:
            candidates.append(("Applications", Path(program_files), "A"))
    return [
        {"name": name, "path": str(path.resolve()), "hotkey": hotkey}
        for name, path, hotkey in candidates if path.exists()
    ]


def thumb_cache_path(path: Path, marker: str = "thumb") -> Path:
    stat = path.stat()
    digest = hashlib.sha256(f"{path}:{stat.st_mtime_ns}:{stat.st_size}:{marker}".encode()).hexdigest()
    return THUMB_DIR / f"{digest}.jpg"


def create_thumbnail(path: Path, destination: Path) -> None:
    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".tmp.jpg")
    suffix = path.suffix.lower()
    if suffix == ".svg":
        document = pymupdf.open(stream=path.read_bytes(), filetype="svg")
        page = document[0]
        pixmap = page.get_pixmap(matrix=pymupdf.Matrix(2, 2), alpha=False)
        pixmap.save(str(temporary))
        document.close()
    elif suffix in IMAGE_EXTENSIONS:
        with Image.open(path) as image:
            image = ImageOps.exif_transpose(image)
            if image.mode not in {"RGB", "L"}:
                background = Image.new("RGB", image.size, "#111111")
                if "A" in image.getbands():
                    background.paste(image, mask=image.getchannel("A"))
                else:
                    background.paste(image)
                image = background
            image.thumbnail((MAX_THUMB_EDGE, MAX_THUMB_EDGE), Image.Resampling.LANCZOS)
            image.convert("RGB").save(temporary, "JPEG", quality=84, optimize=True)
    elif suffix in VIDEO_EXTENSIONS:
        command = [
            get_ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-ss", "1",
            "-i", str(path), "-frames:v", "1", "-vf",
            f"scale={MAX_THUMB_EDGE}:{MAX_THUMB_EDGE}:force_original_aspect_ratio=decrease",
            "-q:v", "4", "-y", str(temporary),
        ]
        subprocess.run(command, check=True, timeout=30)
    elif suffix in AUDIO_EXTENSIONS:
        command = [
            get_ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-i", str(path),
            "-filter_complex", "showwavespic=s=640x320:colors=4cb3f0", "-frames:v", "1", "-y", str(temporary),
        ]
        subprocess.run(command, check=True, timeout=30)
    elif suffix == ".pdf":
        document = pymupdf.open(path)
        if not document.page_count:
            raise ValueError("Empty PDF")
        pixmap = document[0].get_pixmap(matrix=pymupdf.Matrix(1.4, 1.4), alpha=False)
        pixmap.save(str(temporary))
        document.close()
    else:
        raise ValueError("No thumbnail generator for this file type")
    temporary.replace(destination)


def create_rendered_image(path: Path, destination: Path) -> None:
    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".tmp.jpg")
    with Image.open(path) as image:
        image = ImageOps.exif_transpose(image)
        image.thumbnail((2400, 2400), Image.Resampling.LANCZOS)
        if image.mode not in {"RGB", "L"}:
            background = Image.new("RGB", image.size, "#111111")
            if "A" in image.getbands():
                background.paste(image, mask=image.getchannel("A"))
            else:
                background.paste(image)
            image = background
        image.convert("RGB").save(temporary, "JPEG", quality=92, optimize=True)
    temporary.replace(destination)


def create_video_frame(path: Path, destination: Path, seconds: float) -> None:
    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".tmp.jpg")
    command = [
        get_ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-ss", str(max(0, seconds)),
        "-i", str(path), "-frames:v", "1", "-vf",
        "scale=480:270:force_original_aspect_ratio=decrease", "-q:v", "4", "-y", str(temporary),
    ]
    subprocess.run(command, check=True, timeout=30)
    temporary.replace(destination)


def hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def perceptual_hash(path: Path) -> str | None:
    try:
        with Image.open(path) as image:
            pixels = list(ImageOps.grayscale(image).resize((8, 8), Image.Resampling.LANCZOS).get_flattened_data())
        average = sum(pixels) / len(pixels)
        bits = "".join("1" if value >= average else "0" for value in pixels)
        return f"{int(bits, 2):016x}"
    except Exception:
        return None


def find_duplicates(folder: Path) -> dict[str, object]:
    files = [path for path in folder.iterdir() if path.is_file()]
    by_size: dict[int, list[Path]] = {}
    for path in files:
        try:
            by_size.setdefault(path.stat().st_size, []).append(path)
        except OSError:
            pass
    exact: list[list[str]] = []
    for candidates in by_size.values():
        if len(candidates) < 2:
            continue
        by_hash: dict[str, list[str]] = {}
        for path in candidates:
            try:
                by_hash.setdefault(hash_file(path), []).append(str(path))
            except OSError:
                pass
        exact.extend(group for group in by_hash.values() if len(group) > 1)
    images = [path for path in files if path.suffix.lower() in IMAGE_EXTENSIONS][:500]
    visual_clusters: list[tuple[int, list[str]]] = []
    for path in images:
        fingerprint = perceptual_hash(path)
        if fingerprint:
            value = int(fingerprint, 16)
            cluster = next((group for representative, group in visual_clusters if (representative ^ value).bit_count() <= 6), None)
            if cluster is None:
                visual_clusters.append((value, [str(path)]))
            else:
                cluster.append(str(path))
    visual = [group for _, group in visual_clusters if len(group) > 1]
    return {"exact": exact, "visual": visual, "scanned": len(files), "visual_scanned": len(images)}


def index_folder(folder: Path) -> None:
    key = str(folder)
    paths = [path for path in folder.iterdir() if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS | VIDEO_EXTENSIONS | AUDIO_EXTENSIONS | {".pdf"}]
    index_jobs[key] = {"status": "running", "done": 0, "total": len(paths)}
    for number, path in enumerate(paths, 1):
        try:
            destination = thumb_cache_path(path)
            if not destination.exists():
                create_thumbnail(path, destination)
        except Exception:
            pass
        index_jobs[key] = {"status": "running", "done": number, "total": len(paths)}
    index_jobs[key] = {"status": "complete", "done": len(paths), "total": len(paths)}


def choose_folder_native() -> str | None:
    if sys.platform == "darwin":
        result = subprocess.run(
            ["osascript", "-e", "POSIX path of (choose folder with prompt \"Choose a folder\")"],
            text=True, capture_output=True,
        )
        return result.stdout.strip() if result.returncode == 0 else None
    if sys.platform == "win32":
        script = (
            "Add-Type -AssemblyName System.Windows.Forms; "
            "$d=New-Object System.Windows.Forms.FolderBrowserDialog; "
            "if($d.ShowDialog() -eq 'OK'){[Console]::Write($d.SelectedPath)}"
        )
        result = subprocess.run(
            ["powershell", "-NoProfile", "-STA", "-Command", script],
            text=True, capture_output=True,
        )
        return result.stdout.strip() if result.returncode == 0 else None
    executable = shutil.which("zenity")
    if executable:
        result = subprocess.run([executable, "--file-selection", "--directory"], text=True, capture_output=True)
        return result.stdout.strip() if result.returncode == 0 else None
    return None


def source_version() -> str:
    candidates = list(PACKAGE_DIR.glob("*.py")) + list(STATIC_DIR.glob("*"))
    latest = max((path.stat().st_mtime_ns for path in candidates if path.is_file()), default=0)
    return str(latest)


@app.get("/api/health")
def health() -> dict[str, object]:
    return {"ok": True, "started": APP_STARTED, "version": source_version()}


@app.get("/api/locations")
def locations() -> dict[str, object]:
    return {"locations": common_locations(), "config": load_config(), "platform": sys.platform}


@app.get("/api/list")
def list_directory(path: str = Query(default=str(Path.home())), show_hidden: bool = False) -> dict[str, object]:
    folder = checked_path(path, require_dir=True)
    try:
        entries = [entry for entry in folder.iterdir() if show_hidden or not entry.name.startswith(".")]
        entries.sort(key=lambda entry: (not entry.is_dir(), entry.name.casefold()))
        items = []
        for entry in entries:
            try:
                items.append(item_payload(entry))
            except OSError:
                continue
    except PermissionError as error:
        raise HTTPException(403, str(error)) from error
    parent = str(folder.parent) if folder.parent != folder else None
    return {"path": str(folder), "parent": parent, "items": items}


@app.get("/api/media")
def media(path: str) -> FileResponse:
    file_path = checked_path(path, require_file=True)
    media_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    return FileResponse(file_path, media_type=media_type, filename=file_path.name, content_disposition_type="inline")


@app.get("/api/thumbnail")
async def thumbnail(path: str) -> Response:
    file_path = checked_path(path, require_file=True)
    destination = thumb_cache_path(file_path)
    if not destination.exists():
        try:
            await run_in_threadpool(create_thumbnail, file_path, destination)
        except Exception:
            return Response(status_code=204)
    return FileResponse(destination, media_type="image/jpeg")


@app.get("/api/rendered-image")
async def rendered_image(path: str) -> Response:
    file_path = checked_path(path, require_file=True)
    if file_path.suffix.lower() not in IMAGE_EXTENSIONS:
        raise HTTPException(400, "An image file is required")
    destination = thumb_cache_path(file_path, "rendered:2400")
    if not destination.exists():
        try:
            await run_in_threadpool(create_rendered_image, file_path, destination)
        except Exception as error:
            raise HTTPException(415, f"This image codec could not be decoded: {file_path.suffix}") from error
    return FileResponse(destination, media_type="image/jpeg")


@app.get("/api/text-preview")
def text_preview(path: str) -> dict[str, object]:
    file_path = checked_path(path, require_file=True)
    raw = file_path.read_bytes()[:512_000]
    if b"\x00" in raw[:8192]:
        raise HTTPException(415, "This file is binary")
    content = raw.decode("utf-8", errors="replace")
    return {"content": content, "truncated": file_path.stat().st_size > len(raw), "encoding": "UTF-8"}


@app.get("/api/archive-preview")
def archive_preview(path: str) -> dict[str, object]:
    file_path = checked_path(path, require_file=True)
    names: list[str] = []
    try:
        if zipfile.is_zipfile(file_path):
            with zipfile.ZipFile(file_path) as archive:
                names = archive.namelist()[:2000]
        elif tarfile.is_tarfile(file_path):
            with tarfile.open(file_path) as archive:
                names = [member.name for member in archive.getmembers()[:2000]]
        else:
            return {"entries": [], "supported": False, "message": "Open this archive in the default app to inspect it."}
    except (OSError, zipfile.BadZipFile, tarfile.TarError) as error:
        raise HTTPException(415, str(error)) from error
    return {"entries": names, "supported": True, "truncated": len(names) == 2000}


@app.get("/api/video-frame")
async def video_frame(path: str, time: float = 0) -> Response:
    file_path = checked_path(path, require_file=True)
    if file_path.suffix.lower() not in VIDEO_EXTENSIONS:
        raise HTTPException(400, "A video file is required")
    destination = thumb_cache_path(file_path, f"frame:{time:.2f}")
    if not destination.exists():
        try:
            await run_in_threadpool(create_video_frame, file_path, destination, time)
        except Exception:
            return Response(status_code=204)
    return FileResponse(destination, media_type="image/jpeg")


@app.get("/api/review")
def review(folder: str) -> dict[str, object]:
    folder_path = checked_path(folder, require_dir=True)
    prefix = str(folder_path) + os.sep
    records = {path: value for path, value in load_review().items() if path.startswith(prefix)}
    return {"records": records}


@app.put("/api/review")
def update_review(request: ReviewRequest) -> dict[str, object]:
    path = checked_path(request.path)
    records = load_review()
    record = records.get(str(path), {"status": "unreviewed", "rating": 0, "tags": []})
    if request.status is not None:
        record["status"] = request.status
    if request.rating is not None:
        record["rating"] = max(0, min(5, request.rating))
    if request.tags is not None:
        record["tags"] = [tag.strip() for tag in request.tags if tag.strip()][:20]
    record["updated"] = time.time()
    records[str(path)] = record
    save_review(records)
    return record


@app.get("/api/metadata")
def metadata(path: str) -> dict[str, object]:
    file_path = checked_path(path)
    stat = file_path.stat()
    result: dict[str, object] = {
        "name": file_path.name, "path": str(file_path), "kind": human_kind(file_path),
        "size": stat.st_size, "created": stat.st_ctime, "modified": stat.st_mtime,
        "extension": file_path.suffix.lower(),
    }
    if file_path.suffix.lower() in IMAGE_EXTENSIONS:
        try:
            with Image.open(file_path) as image:
                result["width"], result["height"] = image.size
                exif = image.getexif()
                result["camera"] = exif.get(272)
                result["maker"] = exif.get(271)
                result["captured"] = exif.get(36867)
                result["lens"] = exif.get(42036)
        except Exception:
            pass
    elif file_path.suffix.lower() in VIDEO_EXTENSIONS | AUDIO_EXTENSIONS:
        try:
            probe = subprocess.run([get_ffmpeg_exe(), "-hide_banner", "-i", str(file_path)], text=True, capture_output=True, timeout=15)
            duration = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", probe.stderr)
            bitrate = re.search(r"bitrate:\s*(\d+\s*kb/s)", probe.stderr)
            video = re.search(r"Video:\s*([^,]+).*?(\d{2,5})x(\d{2,5})", probe.stderr)
            audio = re.search(r"Audio:\s*([^,]+)", probe.stderr)
            if duration:
                result["duration"] = int(duration.group(1)) * 3600 + int(duration.group(2)) * 60 + float(duration.group(3))
            if bitrate:
                result["bitrate"] = bitrate.group(1)
            if video:
                result.update({"video_codec": video.group(1).strip(), "width": int(video.group(2)), "height": int(video.group(3))})
            if audio:
                result["audio_codec"] = audio.group(1).strip()
        except Exception:
            pass
    return result


@app.get("/api/duplicates")
async def duplicates(path: str) -> dict[str, object]:
    folder = checked_path(path, require_dir=True)
    return await run_in_threadpool(find_duplicates, folder)


@app.post("/api/index")
def start_index(request: RevealRequest) -> dict[str, object]:
    folder = checked_path(request.path, require_dir=True)
    current = index_jobs.get(str(folder))
    if not current:
        index_jobs[str(folder)] = {"status": "queued", "done": 0, "total": 0}
        threading.Thread(target=index_folder, args=(folder,), daemon=True).start()
    return index_jobs.get(str(folder), {"status": "queued", "done": 0, "total": 0})


@app.get("/api/index")
def index_status(path: str) -> dict[str, object]:
    folder = checked_path(path, require_dir=True)
    return index_jobs.get(str(folder), {"status": "idle", "done": 0, "total": 0})


@app.post("/api/rename")
def rename_files(request: RenameRequest) -> dict[str, object]:
    paths = [checked_path(value) for value in request.paths]
    if not request.pattern.strip():
        raise HTTPException(400, "A rename pattern is required")
    planned: list[tuple[Path, Path]] = []
    for index, source in enumerate(paths, 1):
        date = time.strftime("%Y-%m-%d", time.localtime(source.stat().st_mtime))
        stem = request.pattern.replace("{name}", source.stem).replace("{index}", f"{index:03d}").replace("{date}", date)
        target = source.with_name(f"{stem}{source.suffix}")
        if target != source and target.exists():
            raise HTTPException(409, f"A file already exists: {target.name}")
        planned.append((source, target))
    renamed = []
    review_records = load_review()
    for source, target in planned:
        source.rename(target)
        if str(source) in review_records:
            review_records[str(target)] = review_records.pop(str(source))
        renamed.append({"from": str(source), "to": str(target)})
    save_review(review_records)
    return {"renamed": renamed}


@app.post("/api/move")
def move(request: MoveRequest) -> dict[str, object]:
    destination = Path(request.destination).expanduser().resolve()
    records = move_paths([Path(value) for value in request.paths], destination)
    if records:
        undo_stack.append(records)
        review_records = load_review()
        changed = False
        for record in records:
            if str(record.source) in review_records:
                review_records[str(record.destination)] = review_records.pop(str(record.source))
                changed = True
        if changed:
            save_review(review_records)
    return {"moved": len(records), "destination": str(destination)}


@app.post("/api/undo")
def undo() -> dict[str, object]:
    if not undo_stack:
        return {"restored": 0, "skipped": 0}
    restored, skipped = undo_moves(undo_stack.pop())
    return {"restored": len(restored), "skipped": len(skipped)}


@app.post("/api/trash")
def trash(request: PathsRequest) -> dict[str, object]:
    paths = [checked_path(value) for value in request.paths]
    review_records = load_review()
    for path in paths:
        send2trash(str(path))
        review_records.pop(str(path), None)
    save_review(review_records)
    return {"trashed": len(paths)}


@app.post("/api/reveal")
def reveal(request: RevealRequest) -> dict[str, bool]:
    path = checked_path(request.path)
    if sys.platform == "win32":
        subprocess.Popen(["explorer", "/select,", str(path)])
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "-R", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path.parent if path.is_file() else path)])
    return {"ok": True}


@app.post("/api/open")
def open_in_default_app(request: RevealRequest) -> dict[str, bool]:
    path = checked_path(request.path)
    if sys.platform == "win32":
        os.startfile(str(path))  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)])
    return {"ok": True}


@app.post("/api/pick-folder")
async def pick_folder() -> dict[str, str | None]:
    selected = await run_in_threadpool(choose_folder_native)
    return {"path": selected}


@app.put("/api/config")
def update_config(request: ConfigRequest) -> dict[str, object]:
    config = load_config()
    config["destinations"] = request.destinations
    if request.labels is not None:
        config["labels"] = request.labels
    if request.keybindings is not None:
        config["keybindings"] = request.keybindings
    save_config(config)
    return config


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
