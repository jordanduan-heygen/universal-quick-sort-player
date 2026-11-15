from quicksortplayer import dev


def test_frozen_build_disables_reload(monkeypatch):
    captured = {}
    monkeypatch.setattr(dev.sys, "argv", ["Quick Sort Player.exe", "--no-browser"])
    monkeypatch.setattr(dev.sys, "frozen", True, raising=False)
    monkeypatch.setattr(dev, "_quick_sort_is_running", lambda _port: False)
    monkeypatch.setattr(dev, "_available_port", lambda port: port)
    monkeypatch.setattr(dev.uvicorn, "run", lambda app, **options: captured.update({"app": app, **options}))

    assert dev.main() == 0
    assert captured["reload"] is False
    assert captured["host"] == "127.0.0.1"
    assert not isinstance(captured["app"], str)


def test_existing_instance_reopens_without_second_server(monkeypatch):
    opened = []
    monkeypatch.setattr(dev.sys, "argv", ["quick-sort-player"])
    monkeypatch.setattr(dev, "_quick_sort_is_running", lambda _port: True)
    monkeypatch.setattr(dev.webbrowser, "open", opened.append)
    monkeypatch.setattr(dev.uvicorn, "run", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("server started twice")))

    assert dev.main() == 0
    assert opened == ["http://127.0.0.1:8767"]
