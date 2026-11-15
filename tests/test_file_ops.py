from pathlib import Path

from quicksortplayer.file_ops import (
    category_for,
    collision_safe_path,
    move_paths,
    trash_with_lock_retry,
    undo_moves,
)


def test_categories():
    assert category_for(Path("photo.JPG")) == "images"
    assert category_for(Path("movie.mkv")) == "videos"
    assert category_for(Path("song.mp3")) == "videos"
    assert category_for(Path("installer.msi")) == "apps"
    assert category_for(Path("notes.txt")) == "files"


def test_collision_safe_path(tmp_path: Path):
    original = tmp_path / "clip.mp4"
    original.touch()
    assert collision_safe_path(original).name == "clip (1).mp4"


def test_move_and_undo(tmp_path: Path):
    source_dir = tmp_path / "incoming"
    destination = tmp_path / "sorted"
    source_dir.mkdir()
    source = source_dir / "photo.jpg"
    source.write_bytes(b"image")
    records = move_paths([source], destination)
    assert len(records) == 1
    assert not source.exists()
    assert records[0].destination.read_bytes() == b"image"
    restored, skipped = undo_moves(records)
    assert len(restored) == 1
    assert skipped == []
    assert source.read_bytes() == b"image"


def test_move_renames_instead_of_overwriting(tmp_path: Path):
    source_dir = tmp_path / "incoming"
    destination = tmp_path / "sorted"
    source_dir.mkdir()
    destination.mkdir()
    source = source_dir / "notes.txt"
    source.write_text("new")
    (destination / "notes.txt").write_text("old")
    records = move_paths([source], destination)
    assert records[0].destination.name == "notes (1).txt"
    assert (destination / "notes.txt").read_text() == "old"


def test_undo_skips_when_original_path_is_occupied(tmp_path: Path):
    source = tmp_path / "source.txt"
    destination = tmp_path / "sorted"
    source.write_text("move me")
    records = move_paths([source], destination)
    source.write_text("replacement")
    restored, skipped = undo_moves(records)
    assert restored == []
    assert skipped == records
    assert records[0].destination.exists()


def test_trash_retries_temporary_windows_file_lock(tmp_path: Path, monkeypatch):
    from quicksortplayer import file_ops

    source = tmp_path / "clip.mp4"
    source.write_bytes(b"video")
    attempts = []

    class LockedFileError(PermissionError):
        winerror = 32

    def temporarily_locked(_path):
        attempts.append(1)
        if len(attempts) < 3:
            raise LockedFileError(13, "file is being used")
        source.unlink()

    monkeypatch.setattr(file_ops, "send2trash", temporarily_locked)
    monkeypatch.setattr(file_ops.time, "sleep", lambda _seconds: None)
    trash_with_lock_retry(source)
    assert len(attempts) == 3
    assert not source.exists()
