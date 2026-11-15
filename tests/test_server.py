from pathlib import Path
import zipfile

from fastapi.testclient import TestClient
from PIL import Image
from pillow_heif import from_pillow
import pymupdf

from quicksortplayer import server
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
    metadata = client.get("/api/metadata", params={"path": str(first)}).json()
    assert metadata["width"] == 32
    assert metadata["height"] == 24


def test_batch_rename_contract(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(server, "REVIEW_FILE", tmp_path / "review.json")
    source = tmp_path / "original.txt"
    source.write_text("hello")
    response = client.post("/api/rename", json={"paths": [str(source)], "pattern": "sorted_{index}_{name}"})
    assert response.status_code == 200
    assert (tmp_path / "sorted_001_original.txt").read_text() == "hello"


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
