from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


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


def move_paths(paths: Iterable[Path], destination_dir: Path) -> list[MoveRecord]:
    destination_dir = destination_dir.expanduser().resolve()
    destination_dir.mkdir(parents=True, exist_ok=True)
    records: list[MoveRecord] = []
    for raw_path in paths:
        source = raw_path.expanduser().resolve()
        if not source.exists():
            continue
        if source == destination_dir or destination_dir in source.parents:
            continue
        destination = collision_safe_path(destination_dir / source.name)
        moved = Path(shutil.move(str(source), str(destination)))
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
