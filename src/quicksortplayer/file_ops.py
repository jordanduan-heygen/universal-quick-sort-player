from __future__ import annotations

import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, TypeVar

from send2trash import send2trash


IMAGE_EXTENSIONS = {
    ".avif", ".bmp", ".dds", ".gif", ".heic", ".heif", ".ico", ".jfif", ".jpeg", ".jpg", ".jxl",
    ".pbm", ".pgm", ".png", ".ppm", ".qoi", ".svg", ".tga", ".tif", ".tiff", ".webp"
}
VIDEO_EXTENSIONS = {
    ".3gp", ".avi", ".flv", ".m2ts", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".mts",
    ".ogv", ".ts", ".vob", ".webm", ".wmv"
}
AUDIO_EXTENSIONS = {
    ".aac", ".aif", ".aiff", ".alac", ".ape", ".flac", ".m4a", ".mid", ".midi", ".mka", ".mp3",
    ".oga", ".ogg", ".opus", ".wav", ".wma"
}
APP_EXTENSIONS = {
    ".app", ".appx", ".bat", ".cmd", ".com", ".exe", ".lnk", ".msi", ".msix", ".ps1"
}


@dataclass(frozen=True)
class MoveRecord:
    source: Path
    destination: Path


def category_for(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in IMAGE_EXTENSIONS:
        return "images"
    if suffix in VIDEO_EXTENSIONS or suffix in AUDIO_EXTENSIONS:
        return "videos"
    if suffix in APP_EXTENSIONS:
        return "apps"
    return "files"


def collision_safe_path(destination: Path) -> Path:
    if not destination.exists():
        return destination
    for number in range(1, 100_000):
        candidate = destination.with_name(f"{destination.stem} ({number}){destination.suffix}")
        if not candidate.exists():
            return candidate
    raise RuntimeError(f"Could not find a free filename near {destination}")


def path_size(path: Path) -> int:
    if path.is_file():
        return path.stat().st_size
    total = 0
    for child in path.rglob("*"):
        try:
            if child.is_file():
                total += child.stat().st_size
        except OSError:
            continue
    return total


def required_copy_space(paths: Iterable[Path], destination_dir: Path) -> int:
    """Return bytes needed for cross-volume moves; same-volume renames need no copy space."""
    destination_device = destination_dir.stat().st_dev
    destination_drive = destination_dir.drive.casefold()
    required = 0
    for source in paths:
        source = source.expanduser().resolve()
        try:
            cross_volume = source.stat().st_dev != destination_device
            if source.drive and destination_drive:
                cross_volume = source.drive.casefold() != destination_drive
            if cross_volume:
                required += path_size(source)
        except OSError:
            continue
    return required


Result = TypeVar("Result")


def is_file_lock_error(error: OSError) -> bool:
    """Return whether Windows refused an operation because a file handle is still open."""
    return getattr(error, "winerror", None) == 32 or error.errno in {13, 16, 32}


def retry_locked(operation: Callable[[], Result], attempts: int = 12) -> Result:
    """Windows can retain browser, FFmpeg, or antivirus handles briefly after playback stops."""
    for attempt in range(attempts):
        try:
            return operation()
        except OSError as error:
            if not is_file_lock_error(error) or attempt == attempts - 1:
                raise
            time.sleep(.08 * (attempt + 1))
    raise RuntimeError("unreachable")


def move_with_lock_retry(source: Path, destination: Path) -> Path:
    return retry_locked(lambda: Path(shutil.move(str(source), str(destination))))


def trash_with_lock_retry(path: Path) -> None:
    retry_locked(lambda: send2trash(str(path)))


def move_paths(paths: Iterable[Path], destination_dir: Path) -> list[MoveRecord]:
    paths = list(paths)
    destination_dir = destination_dir.expanduser().resolve()
    destination_dir.mkdir(parents=True, exist_ok=True)
    required = required_copy_space(paths, destination_dir)
    free = shutil.disk_usage(destination_dir).free
    if required > free:
        raise OSError(28, f"Destination needs {required} bytes but only {free} bytes are free")
    records: list[MoveRecord] = []
    for raw_path in paths:
        source = raw_path.expanduser().resolve()
        if not source.exists():
            continue
        if source == destination_dir or destination_dir in source.parents:
            continue
        destination = collision_safe_path(destination_dir / source.name)
        moved = move_with_lock_retry(source, destination)
        records.append(MoveRecord(source, moved.resolve()))
    return records


def undo_moves(records: Iterable[MoveRecord]) -> tuple[list[MoveRecord], list[MoveRecord]]:
    restored: list[MoveRecord] = []
    skipped: list[MoveRecord] = []
    for record in reversed(list(records)):
        if not record.destination.exists() or record.source.exists():
            skipped.append(record)
            continue
        record.source.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(record.destination), str(record.source))
        restored.append(record)
    return restored, skipped
